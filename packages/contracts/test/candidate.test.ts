import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  M5CandidateEnvelopeSchema,
  M5_CANDIDATE_COMMAND_ARGV,
  M5_CANDIDATE_COMMAND_ARGV_DIGEST,
  M5_CANDIDATE_COMMAND_ID,
  M5_INSPECTED_IMAGE,
  M5_MONONYM_ASSERTION_FRAGMENT,
  M5_MONONYM_ASSERTION_ID,
  M5_TEST_COMMAND_ARGV,
  M5_TEST_COMMAND_ARGV_DIGEST,
  M5_TEST_COMMAND_ID,
  SandboxCommandEvidenceSchema,
  TestFailureProofSchema,
} from "../src/index.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const snapshotHash = "a".repeat(64);
const testDiffHash = hash("test-diff");
const sourceDiffHash = hash("source-diff");
const combinedDiffHash = hash("test-diff\nsource-diff");

function evidence(stage: "test-proof" | "combined", commandId: typeof M5_TEST_COMMAND_ID | typeof M5_CANDIDATE_COMMAND_ID, classification: "EXPECTED_FAILURE" | "CANDIDATE_PASS", controlHash: string, exitCode: number) {
  const base = {
    schemaVersion: 1 as const,
    recordVersion: "sandbox-command-v1" as const,
    stage,
    commandId,
    classification,
    argvDigest: commandId === M5_TEST_COMMAND_ID ? M5_TEST_COMMAND_ARGV_DIGEST : M5_CANDIDATE_COMMAND_ARGV_DIGEST,
    image: M5_INSPECTED_IMAGE,
    network: "none" as const,
    readOnlyRoot: true as const,
    pullPolicy: "never" as const,
    capabilitiesDropped: "ALL" as const,
    noNewPrivileges: true as const,
    pidsLimit: 128,
    memoryLimit: "2g",
    cpuLimit: "2",
    timeoutMs: 120_000,
    started: true,
    exitCode,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    resourceLimitExceeded: false,
    setupError: null,
    protocolError: null,
    patchApplyError: null,
    secretDetected: false,
    infrastructureError: null,
    exportViolation: null,
    stdoutSha256: hash("stdout"),
    stderrSha256: hash("stderr"),
    toolingRevision: "9".repeat(64),
    controlHash,
    resultHash: hash(`${stage}-result`),
    durationMs: 1,
    exportedFiles: [],
  };
  return SandboxCommandEvidenceSchema.parse({ ...base, evidenceHash: hash(canonical(base)) });
}

const testControl = "b".repeat(64);
const combinedControl = "c".repeat(64);
const testEvidence = evidence("test-proof", M5_TEST_COMMAND_ID, "EXPECTED_FAILURE", testControl, 1);
const combinedEvidence = evidence("combined", M5_CANDIDATE_COMMAND_ID, "CANDIDATE_PASS", combinedControl, 0);
const proofBase = {
  schemaVersion: 1 as const,
  recordVersion: "test-failure-proof-v1" as const,
  baselineRunId: "run-candidate-contract",
  sourceSnapshotHash: snapshotHash,
  testDiffHash,
  sourceRevision: `sha256:${"d".repeat(64)}`,
  toolingRevision: "9".repeat(64),
  commandId: M5_TEST_COMMAND_ID,
  argvDigest: M5_TEST_COMMAND_ARGV_DIGEST,
  controlHash: testControl,
  sandboxResultHash: testEvidence.resultHash,
  sandboxEvidenceHash: testEvidence.evidenceHash,
  exitCode: 1 as const,
  signal: null,
  classification: "EXPECTED_FAILURE" as const,
  expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME" as const,
  assertionId: M5_MONONYM_ASSERTION_ID,
  assertionFragment: M5_MONONYM_ASSERTION_FRAGMENT,
  observedFailureHash: hash("failure"),
};
const proof = TestFailureProofSchema.parse({ ...proofBase, proofHash: hash(canonical(proofBase)) });

function policy(operation: "test-only" | "source-only", diffHash: string) {
  return { schemaVersion: 1 as const, recordVersion: "candidate-policy-v1" as const, operation, sourceSnapshotHash: snapshotHash, diffHash, filesChanged: 1, linesAdded: 1, linesDeleted: 0, changedLines: 1, accepted: true, violations: [] };
}
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    recordVersion: "m5-candidate-v1" as const,
    candidateId: "candidate-contract-001",
    baselineRunId: proof.baselineRunId,
    analysisId: "analysis-candidate-contract",
    expectedIndexHash: "e".repeat(64),
    expectedRootHash: "f".repeat(64),
    expectedAnalysisHash: "1".repeat(64),
    sourceRevision: proof.sourceRevision,
    toolingRevision: "9".repeat(64),
    sourceSnapshotHash: snapshotHash,
    testDiffHash,
    sourceDiffHash,
    combinedDiffHash,
    testDiffArtifact: { operation: "test-only" as const, artifactPath: "diffs/test.diff", byteLength: 9, sha256: testDiffHash },
    sourceDiffArtifact: { operation: "source-only" as const, artifactPath: "diffs/source.diff", byteLength: 11, sha256: sourceDiffHash },
    combinedDiffArtifact: { operation: "combined" as const, artifactPath: "diffs/combined.diff", byteLength: 21, sha256: combinedDiffHash },
    testFailureProofHash: proof.proofHash,
    testControlHash: testControl,
    combinedControlHash: combinedControl,
    testSandboxEvidenceHash: testEvidence.evidenceHash,
    combinedSandboxEvidenceHash: combinedEvidence.evidenceHash,
    testSandboxResultHash: testEvidence.resultHash,
    combinedSandboxResultHash: combinedEvidence.resultHash,
    testFailureProof: proof,
    testPolicy: policy("test-only", testDiffHash),
    sourcePolicy: policy("source-only", sourceDiffHash),
    sandbox: [testEvidence, combinedEvidence],
    state: "SANDBOX_GATING" as const,
    outcome: "PASS" as const,
    ...overrides,
  };
}

describe("M5 candidate contract", () => {
  it("binds distinct fixed argv digests and keeps the verifier invariant in the combined command", () => {
    expect(hash(JSON.stringify(M5_TEST_COMMAND_ARGV))).toBe(M5_TEST_COMMAND_ARGV_DIGEST);
    expect(hash(JSON.stringify(M5_CANDIDATE_COMMAND_ARGV))).toBe(M5_CANDIDATE_COMMAND_ARGV_DIGEST);
    expect(M5_CANDIDATE_COMMAND_ARGV).toContain("apps/target/test/repair-mononym-invariants.test.mjs");
    expect(M5_CANDIDATE_COMMAND_ARGV).not.toEqual(M5_TEST_COMMAND_ARGV);
  });

  it("requires accepted policies, the combined budget, artifact bindings, proof read-back and both sandbox stages for PASS", () => {
    expect(M5CandidateEnvelopeSchema.parse(candidate()).outcome).toBe("PASS");
    expect(() => M5CandidateEnvelopeSchema.parse(candidate({ sourceDiffHash: "2".repeat(64) }))).toThrow();
    expect(() => M5CandidateEnvelopeSchema.parse(candidate({ combinedSandboxEvidenceHash: "3".repeat(64) }))).toThrow();
    expect(() => M5CandidateEnvelopeSchema.parse(candidate({ testPolicy: { ...policy("test-only", testDiffHash), accepted: false, violations: ["rejected"] } }))).toThrow(/accepted policy/i);
    expect(() => M5CandidateEnvelopeSchema.parse(candidate({
      testPolicy: { ...policy("test-only", testDiffHash), filesChanged: 3, linesAdded: 200, changedLines: 200 },
      sourcePolicy: { ...policy("source-only", sourceDiffHash), filesChanged: 3, linesAdded: 51, changedLines: 51 },
    }))).toThrow(/combined candidate/i);
  });

  it("rejects command/evidence cross-binding and unsuccessful combined stages", () => {
    expect(() => SandboxCommandEvidenceSchema.parse({ ...combinedEvidence, argvDigest: M5_TEST_COMMAND_ARGV_DIGEST, evidenceHash: hash(canonical({ ...combinedEvidence, argvDigest: M5_TEST_COMMAND_ARGV_DIGEST, evidenceHash: undefined })) })).toThrow();
    expect(() => M5CandidateEnvelopeSchema.parse(candidate({ sandbox: [testEvidence, { ...combinedEvidence, exitCode: 1, classification: "CANDIDATE_TEST_FAILURE" }] }))).toThrow();
  });
});
