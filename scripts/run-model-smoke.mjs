import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EntityIdSchema, Sha256Schema } from "@roveproof/contracts";
import { computeM5ToolingRevision } from "@roveproof/sandbox";
import { AnalysisUnavailableError, analyzeEvidence } from "@roveproof/model-adapter";
import { FileControlStore, resolveArtifactRoot } from "@roveproof/store";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArguments(argv) {
  let runId;
  let expectedIndexHash;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === "--run-id" || flag === "--expected-index-hash") && value && !value.startsWith("--")) {
      if (flag === "--run-id" && runId !== undefined) throw new Error("--run-id may be supplied only once");
      if (flag === "--expected-index-hash" && expectedIndexHash !== undefined) throw new Error("--expected-index-hash may be supplied only once");
      if (flag === "--run-id") runId = value;
      else expectedIndexHash = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!runId) throw new Error("An explicit --run-id is required; latest and fixture fallbacks are forbidden");
  if (expectedIndexHash === undefined) throw new Error("An explicit --expected-index-hash is required; implicit index inference is forbidden");
  return {
    runId: EntityIdSchema.parse(runId),
    expectedIndexHash: Sha256Schema.parse(expectedIndexHash),
  };
}

let exitCode = 0;
let lease;
let analysisId;
try {
  const options = parseArguments(process.argv.slice(2));
  analysisId = EntityIdSchema.parse(`analysis-${randomUUID()}`);
  const artifactRoot = resolveArtifactRoot(repositoryRoot);
  const store = new FileControlStore(artifactRoot);
  const toolingRevision = await computeM5ToolingRevision(repositoryRoot);
  Sha256Schema.parse(toolingRevision);
  lease = await store.acquireAnalysisLease();
  const result = await analyzeEvidence({
    analysisId,
    baselineRunId: options.runId,
    bundleDirectory: path.join(artifactRoot, "runs", options.runId),
    expectedIndexHash: options.expectedIndexHash,
    toolingRevision,
  });
  for (const attempt of result.attempts) await store.writeAnalysisAttempt(attempt);
  await store.writeAnalysis(result.report);
  const persisted = await store.readAnalysis(analysisId);
  const analysisHash = createHash("sha256").update(JSON.stringify(persisted)).digest("hex");
  console.log(JSON.stringify({
    status: "ANALYSIS_COMPLETE",
    analysisHash,
    mode: persisted.mode,
    fixture: false,
    analysisId: persisted.analysisId,
    baselineRunId: persisted.baselineRunId,
    backend: persisted.backend,
    authMode: persisted.authMode,
    cliVersion: persisted.cliVersion,
    model: persisted.model,
    threadId: persisted.threadId,
    usage: persisted.usage,
    durationMs: persisted.durationMs,
    retryCount: persisted.retryCount,
    inputIndexHash: persisted.inputIndexHash,
    inputRootHash: persisted.inputRootHash,
    sourceRevision: persisted.sourceRevision ?? null,
    toolingRevision: persisted.toolingRevision ?? null,
    hypotheses: persisted.hypotheses.map(({ rank, code, artifactRefs }) => ({ rank, code, artifactRefs })),
    persistedAt: `var/roveproof/analyses/${persisted.analysisId}.json`,
  }, null, 2));
} catch (error) {
  exitCode = 1;
  if (error instanceof AnalysisUnavailableError && analysisId) {
    try {
      const store = new FileControlStore(resolveArtifactRoot(repositoryRoot));
      for (const attempt of error.attempts) await store.writeAnalysisAttempt(attempt);
      console.error(`INCONCLUSIVE ${error.code} analysisId=${analysisId}`);
    } catch {
      console.error(`INCONCLUSIVE MODEL_PERSISTENCE_FAILED analysisId=${analysisId}`);
    }
  } else if (!analysisId) {
    console.error(`INCONCLUSIVE ${error instanceof Error ? error.message : "MODEL_EVIDENCE_REJECTED"}`);
  } else {
    console.error(`INCONCLUSIVE MODEL_PERSISTENCE_FAILED analysisId=${analysisId}`);
  }
} finally {
  if (lease) {
    try {
      await lease.release();
    } catch {
      exitCode = 1;
      console.error("INCONCLUSIVE MODEL_PERSISTENCE_FAILED lease-release");
    }
  }
}
process.exitCode = exitCode;
