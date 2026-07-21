import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  ANALYSIS_OUTPUT_VERSION,
  ANALYSIS_PROMPT_VERSION,
  AnalysisAttemptRecordSchema,
  AnalysisModelOutputSchema,
  AnalysisReportSchema,
  CODEX_CLI_VERSION,
  EntityIdSchema,
  MODEL_AUTH_MODE,
  MODEL_BACKEND,
  REAL_ANALYSIS_VERSION,
  Sha256Schema,
  type AnalysisAttemptRecord,
  type AnalysisReport,
} from "@roveproof/contracts";
import { admitEvidenceBundle, type AdmittedEvidenceBundle } from "@roveproof/evidence";
import { asModelAdapterError, ModelAdapterError } from "./errors.js";
import { analysisOutputSchemaBytes, sha256 } from "./output-schema.js";
import { ANALYSIS_PROMPT_TEMPLATE_HASH, renderAnalysisPrompt } from "./prompt.js";
import {
  classifyCodexFailure,
  canonicalJson,
  containsModelRefusal,
  parseCodexJsonl,
} from "./protocol.js";
import {
  runBoundedProcess,
  runCodexPreflight,
  type CodexProcessRunner,
  type ResolvedCodexCommand,
} from "./process.js";
import {
  assertAnalysisWorkspaceUnchanged,
  assertEligibleAnalysisBaseline,
  createAnalysisWorkspace,
  removeAnalysisWorkspace,
  writeAnalysisControlFile,
  type AnalysisWorkspace,
} from "./workspace.js";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

export type AnalyzeEvidenceResult = Readonly<{
  report: AnalysisReport;
  attempts: readonly [AnalysisAttemptRecord];
}>;

export class AnalysisUnavailableError extends ModelAdapterError {
  readonly attempts: readonly [AnalysisAttemptRecord];

  constructor(error: ModelAdapterError, attempt: AnalysisAttemptRecord) {
    super(error.code, error.stage, { retryable: error.retryable, provenance: error.provenance });
    this.name = "AnalysisUnavailableError";
    this.attempts = [attempt];
  }
}

type EvidenceAdmission = (
  directory: string,
  options?: Readonly<{ expectedIndexHash?: string }>,
) => Promise<AdmittedEvidenceBundle>;

export type AnalyzeEvidenceOptions = Readonly<{
  analysisId: string;
  baselineRunId: string;
  bundleDirectory: string;
  expectedIndexHash?: string;
  /** M5 fresh analyses bind the complete trusted projection/tooling tree. */
  toolingRevision?: string;
  temporaryRoot?: string;
  parentEnvironment?: NodeJS.ProcessEnv;
  command?: ResolvedCodexCommand;
  runner?: CodexProcessRunner;
  now?: () => Date;
  admit?: EvidenceAdmission;
}>;

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function inputHashList(workspace: AnalysisWorkspace): string[] {
  return workspace.inputArtifacts.map(({ sha256: artifactHash }) => artifactHash);
}

function assertCitations(output: ReturnType<typeof AnalysisModelOutputSchema.parse>, allowedReferences: ReadonlySet<string>): void {
  for (const hypothesis of output.hypotheses) {
    for (const reference of hypothesis.artifactRefs) {
      if (!allowedReferences.has(reference)) throw new ModelAdapterError("MODEL_CITATION_INVALID", "result");
    }
  }
}

async function readStructuredResult(resultPath: string): Promise<{ bytes: Buffer; parsed: unknown }> {
  let metadata;
  try {
    metadata = await lstat(resultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ModelAdapterError("MODEL_RESULT_MISSING", "result");
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RESULT_BYTES) {
    throw new ModelAdapterError(metadata.size > MAX_RESULT_BYTES ? "MODEL_OUTPUT_LIMIT" : "MODEL_RESULT_MISSING", "result");
  }
  const bytes = await readFile(resultPath);
  try {
    return { bytes, parsed: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    throw new ModelAdapterError("MODEL_RESULT_INVALID_JSON", "result");
  }
}

function makeFailureAttempt(input: Readonly<{
  analysisId: string;
  baselineRunId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: ModelAdapterError;
}>): AnalysisAttemptRecord {
  const provenance = input.error.provenance;
  return AnalysisAttemptRecordSchema.parse({
    schemaVersion: 1,
    recordVersion: "analysis-attempt-v1",
    mode: "real",
    analysisId: input.analysisId,
    baselineRunId: input.baselineRunId,
    backend: MODEL_BACKEND,
    authMode: MODEL_AUTH_MODE,
    attempt: 1,
    stage: input.error.stage,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    status: "FAILURE",
    cliVersion: provenance.cliVersion ?? null,
    threadId: provenance.threadId ?? null,
    terminalStatus: provenance.terminalStatus ?? null,
    usage: provenance.usage ?? null,
    exitStatus: provenance.exitStatus ?? null,
    signal: provenance.signal ?? null,
    errorCode: input.error.code,
    retryable: input.error.retryable,
  });
}

export async function analyzeEvidence(options: AnalyzeEvidenceOptions): Promise<AnalyzeEvidenceResult> {
  const analysisId = EntityIdSchema.parse(options.analysisId);
  const baselineRunId = EntityIdSchema.parse(options.baselineRunId);
  const toolingRevision = options.toolingRevision === undefined ? undefined : Sha256Schema.parse(options.toolingRevision);
  const now = options.now ?? (() => new Date());
  const runner = options.runner ?? runBoundedProcess;
  const startedAt = isoNow(now);
  const startedMonotonic = performance.now();
  let workspace: AnalysisWorkspace | null = null;
  let cliVersion: string | null = null;

  try {
    let bundle: AdmittedEvidenceBundle;
    try {
      bundle = await (options.admit ?? admitEvidenceBundle)(options.bundleDirectory, {
        expectedIndexHash: options.expectedIndexHash,
      });
    } catch (error) {
      throw asModelAdapterError(error, "MODEL_EVIDENCE_REJECTED", "admission");
    }
    if (bundle.manifest.runId !== baselineRunId) throw new ModelAdapterError("MODEL_EVIDENCE_REJECTED", "admission");
    assertEligibleAnalysisBaseline(bundle);

    const preflight = await runCodexPreflight({
      parentEnvironment: options.parentEnvironment,
      command: options.command,
      runner,
      cwd: bundle.directory,
    });
    cliVersion = preflight.cliVersion;

    workspace = await createAnalysisWorkspace(bundle, { temporaryRoot: options.temporaryRoot });
    const schemaBytes = analysisOutputSchemaBytes();
    await writeAnalysisControlFile(workspace.schemaPath, schemaBytes);
    const prompt = renderAnalysisPrompt(workspace.dossier);
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new ModelAdapterError("MODEL_INPUT_LIMIT", "workspace");

    const imageArguments = workspace.imagePaths.flatMap((imagePath) => ["--image", imagePath]);
    const invocation = await runner({
      command: preflight.command,
      args: [
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox", "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable", "shell_tool",
        "--skip-git-repo-check",
        "--color", "never",
        ...imageArguments,
        "--output-schema", workspace.schemaPath,
        "--output-last-message", workspace.resultPath,
        "--cd", workspace.evidenceDirectory,
        "-",
      ],
      cwd: workspace.evidenceDirectory,
      env: preflight.environment,
      stdin: prompt,
      timeoutMs: 180_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    });

    const baseProvenance = {
      cliVersion: CODEX_CLI_VERSION,
      exitStatus: invocation.exitCode,
      signal: invocation.signal,
    } as const;
    if (invocation.terminationFailed) throw new ModelAdapterError("MODEL_PROCESS_TERMINATION_FAILED", "invocation", { provenance: baseProvenance });
    if (invocation.timedOut) throw new ModelAdapterError("MODEL_TIMEOUT", "invocation", { provenance: baseProvenance });
    if (invocation.outputLimitExceeded) throw new ModelAdapterError("MODEL_OUTPUT_LIMIT", "invocation", { provenance: baseProvenance });
    if (invocation.spawnErrorCode) {
      throw new ModelAdapterError("MODEL_SPAWN_FAILED", "invocation", {
        retryable: invocation.spawnErrorCode === "EAGAIN",
        provenance: baseProvenance,
      });
    }
    if (invocation.ioErrorCode) throw new ModelAdapterError("MODEL_PROCESS_EXIT", "invocation", { provenance: baseProvenance });
    if (invocation.signal) throw new ModelAdapterError("MODEL_PROCESS_SIGNAL", "invocation", { provenance: baseProvenance });
    if (invocation.exitCode !== 0) {
      const code = classifyCodexFailure(invocation.stdout, invocation.stderr);
      throw new ModelAdapterError(code === "MODEL_TURN_FAILED" ? "MODEL_PROCESS_EXIT" : code, "invocation", {
        retryable: code === "MODEL_CLI_TRANSIENT",
        provenance: baseProvenance,
      });
    }

    const protocol = parseCodexJsonl(invocation.stdout);
    const protocolProvenance = {
      ...baseProvenance,
      threadId: protocol.threadId,
      terminalStatus: protocol.terminalStatus,
      usage: protocol.usage,
    } as const;
    let structured;
    try {
      structured = await readStructuredResult(workspace.resultPath);
    } catch (error) {
      const normalized = asModelAdapterError(error, "MODEL_RESULT_MISSING", "result");
      throw new ModelAdapterError(normalized.code, normalized.stage, {
        retryable: normalized.retryable,
        provenance: { ...protocolProvenance, ...normalized.provenance },
      });
    }
    let modelOutput;
    try {
      modelOutput = AnalysisModelOutputSchema.parse(structured.parsed);
    } catch {
      throw new ModelAdapterError("MODEL_RESULT_SCHEMA_INVALID", "result", { provenance: protocolProvenance });
    }
    let messageOutput: unknown;
    try {
      messageOutput = JSON.parse(protocol.finalMessage) as unknown;
    } catch {
      throw new ModelAdapterError("MODEL_RESULT_CHANNEL_MISMATCH", "result", { provenance: protocolProvenance });
    }
    if (canonicalJson(messageOutput) !== canonicalJson(structured.parsed)) {
      throw new ModelAdapterError("MODEL_RESULT_CHANNEL_MISMATCH", "result", { provenance: protocolProvenance });
    }
    if (containsModelRefusal(modelOutput)) {
      throw new ModelAdapterError("MODEL_REFUSAL", "result", { provenance: protocolProvenance });
    }
    try {
      assertCitations(modelOutput, new Set(workspace.dossier.allowedArtifactRefs));
      await assertAnalysisWorkspaceUnchanged(workspace);
    } catch (error) {
      const normalized = asModelAdapterError(error, "MODEL_WORKSPACE_TAMPERED", "cleanup");
      throw new ModelAdapterError(normalized.code, normalized.stage, {
        retryable: normalized.retryable,
        provenance: { ...protocolProvenance, ...normalized.provenance },
      });
    }
    const { schemaVersion: modelSchemaVersion, ...diagnosis } = modelOutput;

    const completedAt = isoNow(now);
    const durationMs = Math.max(0, performance.now() - startedMonotonic);
    let report: AnalysisReport;
    try {
      report = AnalysisReportSchema.parse({
        schemaVersion: modelSchemaVersion,
        recordVersion: REAL_ANALYSIS_VERSION,
        mode: "real",
        analysisId,
        baselineRunId,
        backend: MODEL_BACKEND,
        authMode: MODEL_AUTH_MODE,
        cliVersion: CODEX_CLI_VERSION,
        model: null,
        threadId: protocol.threadId,
        terminalStatus: protocol.terminalStatus,
        usage: protocol.usage,
        startedAt,
        completedAt,
        durationMs,
        exitStatus: 0,
        retryCount: 0,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        promptTemplateHash: ANALYSIS_PROMPT_TEMPLATE_HASH,
        renderedPromptHash: sha256(prompt),
        outputSchemaVersion: ANALYSIS_OUTPUT_VERSION,
        outputSchemaHash: sha256(schemaBytes),
        inputIndexHash: bundle.indexHash,
        inputRootHash: bundle.index.rootHash,
        sourceRevision: bundle.manifest.sourceRevision,
        ...(toolingRevision === undefined ? {} : { toolingRevision }),
        inputArtifacts: workspace.inputArtifacts,
        inputArtifactHashes: inputHashList(workspace),
        allowedArtifactRefs: workspace.dossier.allowedArtifactRefs,
        finalOutputHash: createHash("sha256").update(structured.bytes).digest("hex"),
        ...diagnosis,
      });
    } catch (error) {
      const normalized = asModelAdapterError(error, "MODEL_RESULT_SCHEMA_INVALID", "result");
      throw new ModelAdapterError(normalized.code, normalized.stage, {
        retryable: normalized.retryable,
        provenance: { ...protocolProvenance, ...normalized.provenance },
      });
    }

    await removeAnalysisWorkspace(workspace);
    workspace = null;
    const attempt = AnalysisAttemptRecordSchema.parse({
      schemaVersion: 1,
      recordVersion: "analysis-attempt-v1",
      mode: "real",
      analysisId,
      baselineRunId,
      backend: MODEL_BACKEND,
      authMode: MODEL_AUTH_MODE,
      attempt: 1,
      stage: "result",
      startedAt,
      completedAt,
      durationMs,
      status: "SUCCESS",
      cliVersion: CODEX_CLI_VERSION,
      threadId: protocol.threadId,
      terminalStatus: protocol.terminalStatus,
      usage: protocol.usage,
      exitStatus: 0,
      signal: null,
      errorCode: null,
      retryable: false,
    });
    return { report, attempts: [attempt] };
  } catch (caught) {
    let error = asModelAdapterError(caught, "MODEL_CLI_TRANSIENT", "invocation");
    if (workspace) {
      try {
        await removeAnalysisWorkspace(workspace);
      } catch (cleanupError) {
        error = asModelAdapterError(cleanupError, "MODEL_WORKSPACE_CLEANUP_FAILED", "cleanup");
      }
    }
    if (cliVersion && error.provenance.cliVersion === undefined) {
      error = new ModelAdapterError(error.code, error.stage, {
        retryable: error.retryable,
        provenance: { ...error.provenance, cliVersion },
      });
    }
    const completedAt = isoNow(now);
    const attempt = makeFailureAttempt({
      analysisId,
      baselineRunId,
      startedAt,
      completedAt,
      durationMs: Math.max(0, performance.now() - startedMonotonic),
      error,
    });
    throw new AnalysisUnavailableError(error, attempt);
  }
}
