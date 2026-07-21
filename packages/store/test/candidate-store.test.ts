import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  M5CandidateEnvelopeSchema,
  M5_CANDIDATE_COMMAND_ARGV_DIGEST,
  M5_INSPECTED_IMAGE,
  M5_TEST_COMMAND_ARGV_DIGEST,
  SandboxCommandEvidenceSchema,
  SandboxResultSchema,
  SourceSnapshotSchema,
} from "@roveproof/contracts";
import { FileControlStore } from "../src/index.js";
import { combineAuthoringDiffs, createSandboxControl, parseSourceAuthoringDiff, parseTestAuthoringDiff } from "@roveproof/sandbox";

const roots: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const testBytes = Buffer.from(`--- a/apps/target/test/repair-mononym.test.mjs
+++ b/apps/target/test/repair-mononym.test.mjs
@@ -1,1 +1,4 @@
 import assert from "node:assert/strict";
+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {
+  assert.equal(validateBaselineLegalName("Sari").valid, true);
+});
`);
const sourceBytes = Buffer.from(`--- a/apps/target/src/lib/seeds/identity.ts
+++ b/apps/target/src/lib/seeds/identity.ts
@@ -1,1 +1,1 @@
-export const value = false;
+export const value = true;
`);
const combinedBytes = Buffer.concat([testBytes, Buffer.from("\n"), sourceBytes]);

function result(stage: "test-proof" | "combined", commandId: "test-regression" | "candidate-check", controlHash: string, exitCode: number) {
  const base = { schemaVersion: 1 as const, recordVersion: "sandbox-result-v1" as const, stage, commandId, controlHash, started: true, exitCode, signal: null, timedOut: false, outputLimitExceeded: false, resourceLimitExceeded: false, setupError: null, protocolError: null, patchApplyError: null, exportViolation: null, secretDetected: false, infrastructureError: null, stdoutSha256: hash("stdout"), stderrSha256: hash("stderr"), appliedDiffHash: hash(stage === "test-proof" ? testBytes : combinedBytes), matchedExpectedFailure: stage === "test-proof", observedFailureHash: stage === "test-proof" ? hash("failure") : null };
  return SandboxResultSchema.parse({ ...base, resultHash: hash(canonical(base)) });
}
function evidence(stage: "test-proof" | "combined", commandId: "test-regression" | "candidate-check", controlHash: string, sandboxResult: ReturnType<typeof result>) {
  const base = { schemaVersion: 1 as const, recordVersion: "sandbox-command-v1" as const, stage, commandId, classification: stage === "test-proof" ? "EXPECTED_FAILURE" as const : "CANDIDATE_PASS" as const, argvDigest: commandId === "test-regression" ? M5_TEST_COMMAND_ARGV_DIGEST : M5_CANDIDATE_COMMAND_ARGV_DIGEST, image: M5_INSPECTED_IMAGE, network: "none" as const, readOnlyRoot: true as const, pullPolicy: "never" as const, capabilitiesDropped: "ALL" as const, noNewPrivileges: true as const, pidsLimit: 128, memoryLimit: "2g", cpuLimit: "2", timeoutMs: 120_000, started: true, exitCode: sandboxResult.exitCode, signal: null, timedOut: false, outputLimitExceeded: false, resourceLimitExceeded: false, setupError: null, protocolError: null, patchApplyError: null, secretDetected: false, infrastructureError: null, exportViolation: null, stdoutSha256: sandboxResult.stdoutSha256, stderrSha256: sandboxResult.stderrSha256, toolingRevision: "e".repeat(64), controlHash, resultHash: sandboxResult.resultHash, durationMs: 1, exportedFiles: [] };
  return SandboxCommandEvidenceSchema.parse({ ...base, evidenceHash: hash(canonical(base)) });
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("write-once candidate artifacts", () => {
  it("publishes and reads back actual diff/result/evidence bytes with cross-bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-candidate-store-"));
    roots.push(root);
    const store = new FileControlStore(root);
    const snapshotBase = { schemaVersion: 1 as const, recordVersion: "source-snapshot-v1" as const, sourceRevision: `sha256:${"a".repeat(64)}`, projectionRevision: "e".repeat(64), toolingRevision: "e".repeat(64), toolingFiles: [{ path: "apps/target/test/repair-mononym.test.mjs", size: 1, sha256: "e".repeat(64) }], baselineRunId: "run-candidate-store", expectedIndexHash: "b".repeat(64), expectedRootHash: "c".repeat(64), analysisId: "analysis-candidate-store", expectedAnalysisHash: "d".repeat(64), files: [{ path: "apps/target/test/repair-mononym.test.mjs", size: 1, sha256: "e".repeat(64) }] };
    const snapshot = SourceSnapshotSchema.parse({ ...snapshotBase, snapshotHash: hash(canonical(snapshotBase)) });
    await store.writeSourceSnapshot(snapshot);
    const testDiff = parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: testBytes.toString("utf8") });
    const sourceDiff = parseSourceAuthoringDiff({ schemaVersion: 1, operation: "source-only", unifiedDiff: sourceBytes.toString("utf8") });
    const combined = combineAuthoringDiffs(testDiff, sourceDiff);
    const testControl = createSandboxControl({ stage: "test-proof", snapshot, testDiff });
    const combinedControl = createSandboxControl({ stage: "combined", snapshot, testDiff, sourceDiff, combinedDiff: combined });
    const testResult = result("test-proof", "test-regression", testControl.controlHash, 1);
    const combinedResult = result("combined", "candidate-check", combinedControl.controlHash, 0);
    const testEvidence = evidence("test-proof", "test-regression", testResult.controlHash, testResult);
    const combinedEvidence = evidence("combined", "candidate-check", combinedResult.controlHash, combinedResult);
    const proofBase = { schemaVersion: 1 as const, recordVersion: "test-failure-proof-v1" as const, baselineRunId: snapshot.baselineRunId, sourceSnapshotHash: snapshot.snapshotHash, testDiffHash: hash(testBytes), sourceRevision: snapshot.sourceRevision, toolingRevision: snapshot.toolingRevision, commandId: "test-regression" as const, argvDigest: M5_TEST_COMMAND_ARGV_DIGEST, controlHash: testResult.controlHash, sandboxResultHash: testResult.resultHash, sandboxEvidenceHash: testEvidence.evidenceHash, exitCode: 1 as const, signal: null, classification: "EXPECTED_FAILURE" as const, expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME" as const, assertionId: "seed.mononym-required-last-name" as const, assertionFragment: "required last name" as const, observedFailureHash: hash("failure") };
    const proof = { ...proofBase, proofHash: hash(canonical(proofBase)) };
    await store.publishTestFailureProof({ proof, snapshot, testDiffBytes: testBytes, sandboxControl: testControl, sandboxEvidence: testEvidence, sandboxResult: testResult });
    const policy = (operation: "test-only" | "source-only", diffHash: string) => ({ schemaVersion: 1 as const, recordVersion: "candidate-policy-v1" as const, operation, sourceSnapshotHash: snapshot.snapshotHash, diffHash, filesChanged: 1, linesAdded: operation === "test-only" ? 3 : 1, linesDeleted: operation === "test-only" ? 0 : 1, changedLines: operation === "test-only" ? 3 : 2, accepted: true, violations: [] });
    const envelope = M5CandidateEnvelopeSchema.parse({ schemaVersion: 1, recordVersion: "m5-candidate-v1", candidateId: "candidate-store-001", baselineRunId: snapshot.baselineRunId, analysisId: snapshot.analysisId, expectedIndexHash: snapshot.expectedIndexHash, expectedRootHash: snapshot.expectedRootHash, expectedAnalysisHash: snapshot.expectedAnalysisHash, sourceRevision: snapshot.sourceRevision, toolingRevision: snapshot.toolingRevision, sourceSnapshotHash: snapshot.snapshotHash, testDiffHash: hash(testBytes), sourceDiffHash: hash(sourceBytes), combinedDiffHash: hash(combinedBytes), testDiffArtifact: { operation: "test-only", artifactPath: "diffs/test.diff", byteLength: testBytes.byteLength, sha256: hash(testBytes) }, sourceDiffArtifact: { operation: "source-only", artifactPath: "diffs/source.diff", byteLength: sourceBytes.byteLength, sha256: hash(sourceBytes) }, combinedDiffArtifact: { operation: "combined", artifactPath: "diffs/combined.diff", byteLength: combinedBytes.byteLength, sha256: hash(combinedBytes) }, testFailureProofHash: proof.proofHash, testControlHash: testControl.controlHash, combinedControlHash: combinedControl.controlHash, testSandboxEvidenceHash: testEvidence.evidenceHash, combinedSandboxEvidenceHash: combinedEvidence.evidenceHash, testSandboxResultHash: testResult.resultHash, combinedSandboxResultHash: combinedResult.resultHash, testFailureProof: proof, testPolicy: policy("test-only", hash(testBytes)), sourcePolicy: policy("source-only", hash(sourceBytes)), sandbox: [testEvidence, combinedEvidence], state: "SANDBOX_GATING", outcome: "PASS" });
    await store.publishCandidate({ envelope, snapshot, testDiffBytes: testBytes, sourceDiffBytes: sourceBytes, combinedDiffBytes: combinedBytes, testControl, combinedControl, testEvidence, combinedEvidence, testResult, combinedResult });
    await expect(store.readCandidateEnvelope(envelope.candidateId)).resolves.toEqual(envelope);
    await expect(store.publishCandidate({ envelope, snapshot, testDiffBytes: Buffer.from("tampered"), sourceDiffBytes: sourceBytes, combinedDiffBytes: combinedBytes, testControl, combinedControl, testEvidence, combinedEvidence, testResult, combinedResult })).rejects.toThrow(/hash mismatch|combined candidate bytes/i);
  });
});
