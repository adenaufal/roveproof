import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVIDENCE_REQUIRED_ARTIFACTS, SEED_IDS } from "@roveproof/contracts";
import { FileControlStore, StoreBusyError } from "../src/index.js";

const roots: string[] = [];
const inputArtifacts = [...EVIDENCE_REQUIRED_ARTIFACTS]
  .sort((left, right) => left.localeCompare(right))
  .map((artifactPath, index) => ({ path: artifactPath, size: index + 1, sha256: `${index}`.padStart(64, "a") }));
const hypotheses = SEED_IDS.map((code, index) => ({
  rank: index + 1,
  code,
  explanation: `Explanation ${index + 1}`,
  artifactRefs: [index === 0 ? "assertions.json" : index === 1 ? "screenshots/failure-or-confirmation.png" : "metrics.json"],
  falsifier: `Falsifier ${index + 1}`,
}));
const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1 };
const attempt = {
  schemaVersion: 1 as const,
  recordVersion: "analysis-attempt-v1" as const,
  mode: "real" as const,
  analysisId: "analysis-store-001",
  baselineRunId: "run-store-001",
  backend: "codex-cli-chatgpt" as const,
  authMode: "chatgpt-subscription" as const,
  attempt: 1 as const,
  stage: "result" as const,
  startedAt: "2026-07-18T00:00:00.000Z",
  completedAt: "2026-07-18T00:00:01.000Z",
  durationMs: 1_000,
  status: "SUCCESS" as const,
  cliVersion: "0.139.0" as const,
  threadId: "123e4567-e89b-42d3-a456-426614174000",
  terminalStatus: "turn.completed" as const,
  usage,
  exitStatus: 0 as const,
  signal: null,
  errorCode: null,
  retryable: false as const,
};
const report = {
  schemaVersion: 1 as const,
  recordVersion: "real-analysis-v1" as const,
  mode: "real" as const,
  analysisId: attempt.analysisId,
  baselineRunId: attempt.baselineRunId,
  backend: "codex-cli-chatgpt" as const,
  authMode: "chatgpt-subscription" as const,
  cliVersion: "0.139.0" as const,
  model: null,
  threadId: attempt.threadId,
  terminalStatus: "turn.completed" as const,
  usage,
  startedAt: attempt.startedAt,
  completedAt: attempt.completedAt,
  durationMs: attempt.durationMs,
  exitStatus: 0 as const,
  retryCount: 0 as const,
  promptVersion: "analysis-prompt-v1" as const,
  promptTemplateHash: "b".repeat(64),
  renderedPromptHash: "c".repeat(64),
  outputSchemaVersion: "analysis-output-v1" as const,
  outputSchemaHash: "d".repeat(64),
  inputIndexHash: "e".repeat(64),
  inputRootHash: "f".repeat(64),
  inputArtifacts,
  inputArtifactHashes: inputArtifacts.map(({ sha256 }) => sha256),
  allowedArtifactRefs: inputArtifacts.map(({ path: artifactPath }) => artifactPath),
  finalOutputHash: "1".repeat(64),
  hypotheses,
  recommendedRegressionAssertion: "The fixed checkout completes once within budget.",
  uncertainty: ["One observation."],
};

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-analysis-store-"));
  roots.push(root);
  const store = new FileControlStore(root);
  await store.initialize();
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("analysis store", () => {
  it("publishes a success only after a matching immutable attempt", async () => {
    const { store } = await setup();
    await store.writeAnalysisAttempt(attempt);
    await store.writeAnalysis(report);
    await expect(store.readAnalysisAttempt(attempt.analysisId, 1)).resolves.toEqual(attempt);
    await expect(store.readAnalysis(report.analysisId)).resolves.toEqual(report);
    await expect(store.writeAnalysis(report)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(store.writeAnalysisAttempt(attempt)).rejects.toThrow("after success publication");
  });

  it("rejects publication without a matching successful attempt", async () => {
    const { store } = await setup();
    await expect(store.writeAnalysis(report)).rejects.toThrow("Analysis not found");

    const failedAttempt = {
      ...attempt,
      status: "FAILURE" as const,
      stage: "preflight" as const,
      cliVersion: null,
      threadId: null,
      terminalStatus: null,
      usage: null,
      exitStatus: 1,
      errorCode: "MODEL_AUTH_NOT_CHATGPT" as const,
      retryable: false,
    };
    await store.writeAnalysisAttempt(failedAttempt);
    await expect(store.writeAnalysis(report)).rejects.toThrow("Successful analysis does not match");
  });

  it("detects a valid-looking report modified without its committed content hash", async () => {
    const { root, store } = await setup();
    await store.writeAnalysisAttempt(attempt);
    await store.writeAnalysis(report);
    const filePath = path.join(root, "analyses", `${report.analysisId}.json`);
    await chmod(filePath, 0o600);
    const envelope = JSON.parse(await readFile(filePath, "utf8")) as { record: { uncertainty: string[] } };
    envelope.record.uncertainty = ["tampered but schema-valid"];
    await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
    await expect(store.readAnalysis(report.analysisId)).rejects.toThrow("content hash is invalid");
  });

  it("permits only one host model-analysis lease owner", async () => {
    const { store } = await setup();
    const first = await store.acquireAnalysisLease();
    await expect(store.acquireAnalysisLease()).rejects.toBeInstanceOf(StoreBusyError);
    await first.release();
    const next = await store.acquireAnalysisLease();
    await next.release();
  });
});
