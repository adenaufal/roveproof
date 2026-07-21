import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthoringAttemptRecordSchema,
  CandidateDiffArtifactSchema,
  CandidatePolicyEvidenceSchema,
  EntityIdSchema,
  M5CandidateEnvelopeSchema,
  M5_CANDIDATE_COMMAND_ID,
  M5_INSPECTED_IMAGE,
  M5_MONONYM_ASSERTION_FRAGMENT,
  M5_MONONYM_ASSERTION_ID,
  M5_TEST_COMMAND_ID,
  RepairStatusRecordSchema,
  SourceSnapshotSchema,
  TestFailureProofSchema,
  Sha256Schema,
} from "../packages/contracts/dist/index.js";
import { admitEvidenceBundle } from "../packages/evidence/dist/index.js";
import {
  DiffPolicyError,
  checkDockerPrerequisites,
  combineAuthoringDiffs,
  computeM5ToolingRevision,
  createSandboxControl,
  createSourceProjection as createProjection,
  removeSourceProjection,
  runDockerCandidate,
  verifyM5ToolingSnapshot,
  parseSourceAuthoringDiff,
  parseTestAuthoringDiff,
} from "../packages/sandbox/dist/index.js";
import {
  authorCandidatePatch,
  authorRegressionTest,
  AuthoringUnavailableError,
  ModelAdapterError,
  runCodexPreflight,
} from "../packages/model-adapter/dist/index.js";
import { FileControlStore, resolveArtifactRoot } from "../packages/store/dist/index.js";
import { classifyRepairLoopError, runRepairLoop } from "../packages/orchestrator/dist/index.js";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nowIso = () => new Date().toISOString();
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hashWithout(value, key) {
  const without = { ...value };
  delete without[key];
  return sha256(canonical(without));
}
function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Unknown or incomplete argument: ${flag ?? ""}`);
    if (values.has(flag)) throw new Error(`${flag} may be supplied only once`);
    values.set(flag, value);
    index += 1;
  }
  const required = ["--baseline-run-id", "--expected-index-hash", "--analysis-id", "--expected-analysis-hash", "--expected-source-revision", "--image"];
  for (const flag of required) if (!values.has(flag)) throw new Error(`An explicit ${flag} is required; implicit/latest/fixture inference is forbidden`);
  const unknown = [...values.keys()].filter((flag) => !required.includes(flag));
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (values.get("--image") !== M5_INSPECTED_IMAGE) throw new Error(`The approved smoke image must be exactly ${M5_INSPECTED_IMAGE}`);
  const sourceRevision = values.get("--expected-source-revision");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(sourceRevision)) throw new Error("An explicit source revision with a supported hash form is required");
  return {
    baselineRunId: EntityIdSchema.parse(values.get("--baseline-run-id")),
    expectedIndexHash: Sha256Schema.parse(values.get("--expected-index-hash")),
    analysisId: EntityIdSchema.parse(values.get("--analysis-id")),
    expectedAnalysisHash: Sha256Schema.parse(values.get("--expected-analysis-hash")),
    expectedSourceRevision: sourceRevision,
    image: values.get("--image"),
  };
}

class SmokeFailure extends Error {
  constructor(outcome, code, message = code) {
    super(message);
    this.name = "SmokeFailure";
    this.outcome = outcome;
    this.code = code;
  }
}
function inconclusive(code, message = code) { throw new SmokeFailure("INCONCLUSIVE", code, message); }
function rejected(code, message = code) { throw new SmokeFailure("REJECTED", code, message); }
function classifyError(error) {
  if (!store) return "REJECTED";
  if (error instanceof SmokeFailure) return error.outcome;
  if (error instanceof DiffPolicyError) return "REJECTED";
  if (error instanceof AuthoringUnavailableError) {
    return ["AUTHORING_POLICY_REJECTED", "AUTHORING_TEST_PROOF_REQUIRED", "AUTHORING_SANDBOX_REJECTED"].includes(error.code) ? "REJECTED" : "INCONCLUSIVE";
  }
  if (error instanceof ModelAdapterError) return "INCONCLUSIVE";
  return classifyRepairLoopError(error);
}
function safeErrorMessage(error) {
  if (!store && error instanceof Error) return error.message;
  if (error instanceof SmokeFailure) return error.code;
  if (error instanceof AuthoringUnavailableError) return error.code;
  if (error instanceof ModelAdapterError) return error.code;
  if (error instanceof DiffPolicyError) return "candidate policy rejected";
  return "repair smoke infrastructure or persistence failure";
}
function policyFor(parsed, snapshot) {
  return CandidatePolicyEvidenceSchema.parse({
    schemaVersion: 1,
    recordVersion: "candidate-policy-v1",
    operation: parsed.operation,
    sourceSnapshotHash: snapshot.snapshotHash,
    diffHash: parsed.diffHash,
    filesChanged: parsed.metadata.files.length,
    linesAdded: parsed.metadata.additions,
    linesDeleted: parsed.metadata.deletions,
    changedLines: parsed.metadata.changedLines,
    accepted: true,
    violations: [],
  });
}
function artifact(operation, artifactPath, bytes) {
  return CandidateDiffArtifactSchema.parse({ operation, artifactPath, byteLength: bytes.byteLength, sha256: sha256(bytes) });
}
function proofFor(snapshot, parsedTest, sandbox) {
  if (!sandbox.result) inconclusive("TEST_RESULT_MISSING");
  const base = {
    schemaVersion: 1,
    recordVersion: "test-failure-proof-v1",
    baselineRunId: snapshot.baselineRunId,
    sourceSnapshotHash: snapshot.snapshotHash,
    testDiffHash: parsedTest.diffHash,
    sourceRevision: snapshot.sourceRevision,
    toolingRevision: snapshot.toolingRevision,
    commandId: M5_TEST_COMMAND_ID,
    argvDigest: sandbox.evidence.argvDigest,
    controlHash: sandbox.evidence.controlHash,
    sandboxResultHash: sandbox.result.resultHash,
    sandboxEvidenceHash: sandbox.evidence.evidenceHash,
    exitCode: 1,
    signal: null,
    classification: "EXPECTED_FAILURE",
    expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME",
    assertionId: M5_MONONYM_ASSERTION_ID,
    assertionFragment: M5_MONONYM_ASSERTION_FRAGMENT,
    observedFailureHash: sandbox.result.observedFailureHash,
  };
  return TestFailureProofSchema.parse({ ...base, proofHash: hashWithout(base, "proofHash") });
}
async function persistAttempt(store, errorOrResult) {
  const attempt = errorOrResult instanceof AuthoringUnavailableError
    ? AuthoringAttemptRecordSchema.parse(errorOrResult.attempts[0])
    : AuthoringAttemptRecordSchema.parse(errorOrResult.attempt);
  await store.writeAuthoringAttempt(attempt);
  return attempt;
}

let options;
let store;
let lease;
let projection;
let temporaryRoot;
let snapshot;
let preflight;
let testAuthoring;
let persistedTestDiff;
let proofBundle;
let sourceAuthoring;
let testPolicy;
let sourcePolicy;
let testControl;
let combinedControl;
let testSandbox;
let combinedSandbox;
let combined;
let publishedEnvelope = null;
const candidateId = `candidate-${randomUUID()}`;
let finalOutcome = "INCONCLUSIVE";
let finalStage = "admission";
let finalMessage = "repair smoke did not complete";
let statusWriteFailed = false;

async function writeFinalStatus() {
  const record = RepairStatusRecordSchema.parse({
    schemaVersion: 1,
    recordVersion: "repair-status-v1",
    candidateId,
    baselineRunId: options?.baselineRunId ?? "run-repair-status",
    stage: finalStage,
    status: finalOutcome,
    candidateEnvelopeHash: finalOutcome === "PASS" && publishedEnvelope ? sha256(canonical(publishedEnvelope)) : null,
    message: finalMessage.slice(0, 512),
    occurredAt: nowIso(),
  });
  if (!store) throw new Error("repair status store was not initialized");
  await store.writeRepairStatus(record);
}

try {
  options = parseArguments(process.argv.slice(2));
  store = new FileControlStore(resolveArtifactRoot(repositoryRoot));
  await store.initialize();
  lease = await store.acquireRepairLease();

  const result = await runRepairLoop({
    baselineRunId: options.baselineRunId,
    classifyError,
    admit: async () => {
      const bundleDirectory = path.join(store.artifactRoot, "runs", options.baselineRunId);
      const bundle = await admitEvidenceBundle(bundleDirectory, { expectedIndexHash: options.expectedIndexHash });
      if (bundle.manifest.runId !== options.baselineRunId || bundle.indexHash !== options.expectedIndexHash || bundle.manifest.sourceRevision !== options.expectedSourceRevision) inconclusive("BASELINE_PROVENANCE_MISMATCH");
      const analysis = await store.readAnalysis(options.analysisId);
      if (!analysis.toolingRevision) inconclusive("TOOLING_REVISION_MISSING");
      const currentToolingRevision = await computeM5ToolingRevision(repositoryRoot);
      if (analysis.toolingRevision !== currentToolingRevision) inconclusive("TOOLING_REVISION_MISMATCH");
      if (analysis.baselineRunId !== options.baselineRunId || analysis.inputIndexHash !== bundle.indexHash || analysis.inputRootHash !== bundle.index.rootHash || analysis.sourceRevision !== options.expectedSourceRevision || sha256(JSON.stringify(analysis)) !== options.expectedAnalysisHash) inconclusive("ANALYSIS_PROVENANCE_MISMATCH");
    },
    snapshot: async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "roveproof-repair-smoke-"));
      const bundleDirectory = path.join(store.artifactRoot, "runs", options.baselineRunId);
      const bundle = await admitEvidenceBundle(bundleDirectory, { expectedIndexHash: options.expectedIndexHash });
      const toolingRevision = await computeM5ToolingRevision(repositoryRoot);
      projection = await createProjection({
        repositoryRoot,
        baselineRunId: options.baselineRunId,
        expectedIndexHash: bundle.indexHash,
        expectedRootHash: bundle.index.rootHash,
        analysisId: options.analysisId,
        expectedAnalysisHash: options.expectedAnalysisHash,
        expectedSourceRevision: options.expectedSourceRevision,
        expectedToolingRevision: toolingRevision,
        temporaryRoot,
      });
      snapshot = SourceSnapshotSchema.parse(projection.snapshot);
      await store.writeSourceSnapshot(snapshot);
      const persisted = await store.readSourceSnapshot(snapshot.snapshotHash);
      if (canonical(persisted) !== canonical(snapshot) || persisted.toolingRevision !== toolingRevision || persisted.sourceRevision !== options.expectedSourceRevision) inconclusive("SOURCE_SNAPSHOT_READBACK_MISMATCH");
      return persisted;
    },
    preflight: async () => {
      await verifyM5ToolingSnapshot(repositoryRoot, snapshot);
      preflight = await runCodexPreflight({ parentEnvironment: process.env, cwd: projection.projectionDirectory });
      const docker = await checkDockerPrerequisites({ cwd: projection.projectionDirectory, image: options.image, parentEnvironment: process.env });
      if (!docker.ok) inconclusive(docker.error ?? "DOCKER_PREFLIGHT_FAILED");
    },
    authorTest: async () => {
      try {
        await verifyM5ToolingSnapshot(repositoryRoot, snapshot);
        testAuthoring = await authorRegressionTest({ authoringId: `author-test-${randomUUID()}`, baselineRunId: options.baselineRunId, snapshot, projectionDirectory: projection.projectionDirectory, temporaryRoot, parentEnvironment: process.env, preflight });
        return testAuthoring;
      } catch (error) {
        if (error instanceof AuthoringUnavailableError) await persistAttempt(store, error);
        throw error;
      }
    },
    persistTestAttempt: async (authoring) => { await persistAttempt(store, authoring); },
    testPolicy: async (authoring) => {
      testPolicy = policyFor(parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: authoring.diff.unifiedDiff }), snapshot);
      return testPolicy;
    },
    runTestSandbox: async (authoring) => {
      await verifyM5ToolingSnapshot(repositoryRoot, snapshot);
      const testExport = await mkdtemp(path.join(temporaryRoot, "test-export-"));
      testControl = createSandboxControl({ stage: "test-proof", snapshot, testDiff: authoring.diff });
      testSandbox = await runDockerCandidate({ image: options.image, projectionDirectory: projection.projectionDirectory, exportDirectory: testExport, temporaryRoot, commandId: M5_TEST_COMMAND_ID, control: testControl, repositoryRoot, parentEnvironment: process.env });
      if (testSandbox.status === "INCONCLUSIVE") inconclusive(testSandbox.evidence.infrastructureError ?? "TEST_SANDBOX_INCONCLUSIVE");
      if (testSandbox.status !== "PASS" || !testSandbox.result || testSandbox.evidence.classification !== "EXPECTED_FAILURE" || testSandbox.result.exitCode !== 1 || testSandbox.result.observedFailureHash === null) rejected("TEST_WRONG_EXPECTED_FAILURE");
      return testSandbox;
    },
    makeProof: async (authoring, sandbox, admittedSnapshot) => proofFor(admittedSnapshot, authoring.diff, sandbox),
    persistProof: async (proof, _authoring, sandbox) => {
      await store.publishTestFailureProof({ proof, snapshot, testDiffBytes: testAuthoring.diff.canonicalBytes, sandboxControl: testControl, sandboxEvidence: sandbox.evidence, sandboxResult: sandbox.result });
    },
    readProof: async (binding) => {
      proofBundle = await store.readTestFailureProofBundle(binding);
      persistedTestDiff = parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: proofBundle.testDiffBytes.toString("utf8") });
      if (persistedTestDiff.diffHash !== binding.testDiffHash) inconclusive("PERSISTED_TEST_DIFF_HASH_MISMATCH");
      return proofBundle.proof;
    },
    authorSource: async (proof, admittedSnapshot) => {
      try {
        await verifyM5ToolingSnapshot(repositoryRoot, admittedSnapshot);
        if (!proofBundle || !persistedTestDiff) inconclusive("PERSISTED_TEST_PROOF_BUNDLE_MISSING");
        sourceAuthoring = await authorCandidatePatch({ authoringId: `author-source-${randomUUID()}`, baselineRunId: options.baselineRunId, testDiffHash: proof.testDiffHash, testDiffContent: proofBundle.testDiffBytes.toString("utf8"), snapshot: admittedSnapshot, projectionDirectory: projection.projectionDirectory, temporaryRoot, parentEnvironment: process.env, preflight, readTestFailureProof: (binding) => store.readTestFailureProof(binding) });
        return sourceAuthoring;
      } catch (error) {
        if (error instanceof AuthoringUnavailableError) await persistAttempt(store, error);
        throw error;
      }
    },
    persistSourceAttempt: async (authoring) => { await persistAttempt(store, authoring); },
    sourcePolicy: async (authoring) => {
      sourcePolicy = policyFor(parseSourceAuthoringDiff({ schemaVersion: 1, operation: "source-only", unifiedDiff: authoring.diff.unifiedDiff }), snapshot);
      return sourcePolicy;
    },
    runCombinedSandbox: async (testAuthoringInput, sourceAuthoringInput) => {
      await verifyM5ToolingSnapshot(repositoryRoot, snapshot);
      const trustedTestDiff = persistedTestDiff ?? testAuthoringInput.diff;
      combined = combineAuthoringDiffs(trustedTestDiff, sourceAuthoringInput.diff);
      const combinedExport = await mkdtemp(path.join(temporaryRoot, "combined-export-"));
      combinedControl = createSandboxControl({ stage: "combined", snapshot, testDiff: trustedTestDiff, sourceDiff: sourceAuthoringInput.diff, combinedDiff: combined });
      combinedSandbox = await runDockerCandidate({ image: options.image, projectionDirectory: projection.projectionDirectory, exportDirectory: combinedExport, temporaryRoot, commandId: M5_CANDIDATE_COMMAND_ID, control: combinedControl, repositoryRoot, parentEnvironment: process.env });
      if (combinedSandbox.status === "INCONCLUSIVE") inconclusive(combinedSandbox.evidence.infrastructureError ?? "COMBINED_SANDBOX_INCONCLUSIVE");
      if (combinedSandbox.status !== "PASS" || !combinedSandbox.result || combinedSandbox.evidence.classification !== "CANDIDATE_PASS" || combinedSandbox.result.exitCode !== 0) rejected("COMBINED_CANDIDATE_FAILED");
      return combinedSandbox;
    },
    publish: async ({ snapshot: admittedSnapshot, testAuthoring: testInput, sourceAuthoring: sourceInput, testPolicy: testPolicyInput, sourcePolicy: sourcePolicyInput, proof, testSandbox: testSandboxInput, combinedSandbox: combinedSandboxInput }) => {
      await verifyM5ToolingSnapshot(repositoryRoot, admittedSnapshot);
      if (!combined) inconclusive("COMBINED_DIFF_MISSING");
      const envelope = M5CandidateEnvelopeSchema.parse({
        schemaVersion: 1,
        recordVersion: "m5-candidate-v1",
        candidateId,
        baselineRunId: options.baselineRunId,
        analysisId: options.analysisId,
        expectedIndexHash: options.expectedIndexHash,
        expectedRootHash: admittedSnapshot.expectedRootHash,
        expectedAnalysisHash: options.expectedAnalysisHash,
        sourceRevision: admittedSnapshot.sourceRevision,
        toolingRevision: admittedSnapshot.toolingRevision,
        sourceSnapshotHash: admittedSnapshot.snapshotHash,
        testDiffHash: (persistedTestDiff ?? testInput.diff).diffHash,
        sourceDiffHash: sourceInput.diff.diffHash,
        combinedDiffHash: combined.hash,
        testDiffArtifact: artifact("test-only", "diffs/test.diff", testInput.diff.canonicalBytes),
        sourceDiffArtifact: artifact("source-only", "diffs/source.diff", sourceInput.diff.canonicalBytes),
        combinedDiffArtifact: artifact("combined", "diffs/combined.diff", combined.bytes),
        testFailureProofHash: proof.proofHash,
        testControlHash: testControl.controlHash,
        combinedControlHash: combinedControl.controlHash,
        testSandboxEvidenceHash: testSandboxInput.evidence.evidenceHash,
        combinedSandboxEvidenceHash: combinedSandboxInput.evidence.evidenceHash,
        testSandboxResultHash: testSandboxInput.result.resultHash,
        combinedSandboxResultHash: combinedSandboxInput.result.resultHash,
        testFailureProof: proof,
        testPolicy: testPolicyInput,
        sourcePolicy: sourcePolicyInput,
        sandbox: [testSandboxInput.evidence, combinedSandboxInput.evidence],
        state: "SANDBOX_GATING",
        outcome: "PASS",
      });
      const trustedTestInput = persistedTestDiff ? { ...testInput, diff: persistedTestDiff } : testInput;
      await store.publishCandidate({ envelope, snapshot: admittedSnapshot, testDiffBytes: trustedTestInput.diff.canonicalBytes, sourceDiffBytes: sourceInput.diff.canonicalBytes, combinedDiffBytes: combined.bytes, testControl, combinedControl, testEvidence: testSandboxInput.evidence, combinedEvidence: combinedSandboxInput.evidence, testResult: testSandboxInput.result, combinedResult: combinedSandboxInput.result });
      publishedEnvelope = await store.readCandidateEnvelope(candidateId);
      return publishedEnvelope;
    },
    cleanup: async () => {
      if (projection) {
        await removeSourceProjection(projection.projectionDirectory);
        projection = null;
      }
      if (temporaryRoot) {
        await rm(temporaryRoot, { recursive: true, force: true });
        temporaryRoot = null;
      }
    },
    onStage: async (stage, outcome, message) => {
      finalStage = stage;
      finalOutcome = outcome;
      finalMessage = message;
    },
  });
  finalOutcome = result.outcome;
  finalStage = result.stage;
  finalMessage = result.outcome === "PASS" ? `SANDBOX_GATING candidate ${candidateId} persisted` : `repair smoke ${result.outcome.toLowerCase()}`;
  publishedEnvelope = result.envelope;
} catch (error) {
  finalOutcome = classifyError(error);
  finalStage = finalStage || "admission";
  finalMessage = safeErrorMessage(error);
} finally {
  try {
    if (projection) {
      await removeSourceProjection(projection.projectionDirectory);
      projection = null;
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = null;
    }
  } catch {
    finalOutcome = "INCONCLUSIVE";
    finalStage = "cleanup";
    finalMessage = "CLEANUP_FAILED";
  }
  try {
    await lease?.release();
  } catch {
    finalOutcome = "INCONCLUSIVE";
    finalStage = "cleanup";
    finalMessage = "LEASE_RELEASE_FAILED";
  }
  try {
    await writeFinalStatus();
  } catch {
    statusWriteFailed = true;
    if (store) {
      finalOutcome = "INCONCLUSIVE";
      finalStage = "cleanup";
      finalMessage = "STATUS_WRITE_FAILED";
    }
  }
  if (finalOutcome === "PASS" && !statusWriteFailed && store) {
    try {
      publishedEnvelope = await store.readCandidateEnvelope(candidateId, { requireTerminalStatus: true });
    } catch {
      statusWriteFailed = true;
      finalOutcome = "INCONCLUSIVE";
      finalStage = "cleanup";
      finalMessage = "CANDIDATE_READBACK_FAILED";
    }
  }
}

if (finalOutcome === "PASS" && !statusWriteFailed && publishedEnvelope) {
  console.log(JSON.stringify({ status: "PASS", candidateId, persisted: `var/roveproof/candidates/${candidateId}/envelope.json`, testDiffHash: publishedEnvelope.testDiffHash, sourceDiffHash: publishedEnvelope.sourceDiffHash, combinedDiffHash: publishedEnvelope.combinedDiffHash }));
} else if (finalOutcome !== "PASS") {
  console.error(`${finalOutcome} ${finalMessage}`);
}
process.exitCode = finalOutcome === "PASS" && !statusWriteFailed ? 0 : 1;
