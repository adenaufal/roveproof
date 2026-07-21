import { describe, expect, it } from "vitest";
import {
  AnalysisAttemptRecordSchema,
  AnalysisModelOutputSchema,
  AnalysisReportSchema,
  EVIDENCE_REQUIRED_ARTIFACTS,
  FixtureAnalysisSchema,
  SEED_IDS,
} from "../src/index.js";

const hypotheses = SEED_IDS.map((code, index) => ({
  rank: index + 1,
  code,
  explanation: `Evidence-grounded explanation ${index + 1}.`,
  artifactRefs: [index === 0 ? "assertions.json#seed.mononym-required-last-name" : index === 1 ? "screenshots/failure-or-confirmation.png" : "metrics.json"],
  falsifier: `A clean rerun disproves hypothesis ${index + 1}.`,
}));

const modelOutput = {
  schemaVersion: 1,
  hypotheses,
  recommendedRegressionAssertion: "Checkout accepts the fixed Indonesian identity and remains within the frozen budget.",
  uncertainty: ["This is one deterministic observation."],
};

const inputArtifacts = [...EVIDENCE_REQUIRED_ARTIFACTS]
  .sort((left, right) => left.localeCompare(right))
  .map((artifactPath, index) => ({ path: artifactPath, size: index + 1, sha256: `${index}`.padStart(64, "a") }));

const report = {
  schemaVersion: 1,
  recordVersion: "real-analysis-v1",
  mode: "real",
  analysisId: "analysis-001",
  baselineRunId: "run-001",
  backend: "codex-cli-chatgpt",
  authMode: "chatgpt-subscription",
  cliVersion: "0.139.0",
  model: null,
  threadId: "123e4567-e89b-42d3-a456-426614174000",
  terminalStatus: "turn.completed",
  usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1 },
  startedAt: "2026-07-18T00:00:00.000Z",
  completedAt: "2026-07-18T00:00:01.000Z",
  durationMs: 1_000,
  exitStatus: 0,
  retryCount: 0,
  promptVersion: "analysis-prompt-v1",
  promptTemplateHash: "b".repeat(64),
  renderedPromptHash: "c".repeat(64),
  outputSchemaVersion: "analysis-output-v1",
  outputSchemaHash: "d".repeat(64),
  inputIndexHash: "e".repeat(64),
  inputRootHash: "f".repeat(64),
  inputArtifacts,
  inputArtifactHashes: inputArtifacts.map(({ sha256 }) => sha256),
  allowedArtifactRefs: [
    ...inputArtifacts.map(({ path: artifactPath }) => artifactPath),
    "assertions.json#seed.mononym-required-last-name",
  ],
  finalOutputHash: "1".repeat(64),
  ...modelOutput,
};

const successAttempt = {
  schemaVersion: 1,
  recordVersion: "analysis-attempt-v1",
  mode: "real",
  analysisId: "analysis-001",
  baselineRunId: "run-001",
  backend: "codex-cli-chatgpt",
  authMode: "chatgpt-subscription",
  attempt: 1,
  stage: "result",
  startedAt: "2026-07-18T00:00:00.000Z",
  completedAt: "2026-07-18T00:00:01.000Z",
  durationMs: 1_000,
  status: "SUCCESS",
  cliVersion: "0.139.0",
  threadId: "123e4567-e89b-42d3-a456-426614174000",
  terminalStatus: "turn.completed",
  usage: report.usage,
  exitStatus: 0,
  signal: null,
  errorCode: null,
  retryable: false,
};

describe("analysis contracts", () => {
  it("accepts one strict real report covering exactly the three frozen failures", () => {
    expect(AnalysisModelOutputSchema.parse(modelOutput)).toEqual(modelOutput);
    expect(AnalysisReportSchema.parse(report)).toEqual(report);
  });

  it.each([
    [{ ...hypotheses[0], rank: 2 }, hypotheses[1], hypotheses[2]],
    [hypotheses[0], { ...hypotheses[1], rank: 1 }, hypotheses[2]],
    [hypotheses[0], hypotheses[1], { ...hypotheses[2], rank: 2 }],
  ])("rejects ranks that are not ordered and contiguous from one", (candidate) => {
    expect(AnalysisModelOutputSchema.safeParse({ ...modelOutput, hypotheses: candidate }).success).toBe(false);
  });

  it("rejects missing or duplicate frozen failure codes", () => {
    const duplicated = hypotheses.map((hypothesis, index) => index === 2 ? { ...hypothesis, code: SEED_IDS[1] } : hypothesis);
    expect(AnalysisModelOutputSchema.safeParse({ ...modelOutput, hypotheses: duplicated }).success).toBe(false);
    expect(AnalysisModelOutputSchema.safeParse({ ...modelOutput, hypotheses: hypotheses.slice(0, 2) }).success).toBe(false);
  });

  it("binds every citation to the exact verifier-owned reference catalog", () => {
    const invalidPath = hypotheses.map((hypothesis, index) => index === 0
      ? { ...hypothesis, artifactRefs: ["not-admitted.json"] }
      : hypothesis);
    const inventedFragment = hypotheses.map((hypothesis, index) => index === 0
      ? { ...hypothesis, artifactRefs: ["assertions.json#definitely-not-real"] }
      : hypothesis);
    expect(AnalysisReportSchema.safeParse({ ...report, hypotheses: invalidPath }).success).toBe(false);
    expect(AnalysisReportSchema.safeParse({ ...report, hypotheses: inventedFragment }).success).toBe(false);
    expect(AnalysisReportSchema.safeParse(report).success).toBe(true);
  });

  it("requires deterministic artifact order and matching hashes", () => {
    expect(AnalysisReportSchema.safeParse({ ...report, inputArtifacts: [...inputArtifacts].reverse() }).success).toBe(false);
    expect(AnalysisReportSchema.safeParse({ ...report, inputArtifactHashes: [...report.inputArtifactHashes].reverse() }).success).toBe(false);
  });

  it("keeps fixture analysis structurally incapable of claiming real provenance", () => {
    const fixture = {
      schemaVersion: 1,
      recordVersion: "fixture-analysis-v1",
      mode: "fixture",
      provenance: "fixture",
      fixtureVersion: "golden-control-v1",
      analysisId: "analysis-fixture-001",
      baselineRunId: "run-fixture-001",
      ...modelOutput,
      approvalAllowed: false,
    };
    expect(FixtureAnalysisSchema.safeParse(fixture).success).toBe(true);
    expect(AnalysisReportSchema.safeParse(fixture).success).toBe(false);
    expect(FixtureAnalysisSchema.safeParse(report).success).toBe(false);
  });

  it("records success and failure attempts without raw child output", () => {
    expect(AnalysisAttemptRecordSchema.safeParse(successAttempt).success).toBe(true);
    expect(AnalysisAttemptRecordSchema.safeParse({
      ...successAttempt,
      status: "FAILURE",
      stage: "preflight",
      cliVersion: null,
      threadId: null,
      terminalStatus: null,
      usage: null,
      exitStatus: 1,
      signal: null,
      errorCode: "MODEL_AUTH_NOT_CHATGPT",
      retryable: false,
    }).success).toBe(true);
    expect(AnalysisAttemptRecordSchema.safeParse({ ...successAttempt, stdout: "secret" }).success).toBe(false);
  });
});
