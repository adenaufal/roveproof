import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M5_TEST_COMMAND_ARGV_DIGEST, M5_TEST_COMMAND_ID, SourceSnapshotSchema, TestFailureProofSchema } from "@roveproof/contracts";
import {
  authorCandidatePatch,
  authorRegressionTest,
  type BoundedProcessRequest,
  type BoundedProcessResult,
} from "../src/index.js";

const roots: string[] = [];
const command = { executable: "trusted-codex", prefixArgs: [] } as const;
const testPath = "apps/target/test/repair-mononym.test.mjs";
const sourcePath = "apps/target/src/lib/seeds/identity.ts";
const sourceContent = "export const value = false;\n";
const testContent = "import assert from \"node:assert/strict\";\n";
const sourceRevision = createHash("sha256").update(`${sourcePath}\0${sourceContent}\0`).digest("hex");
const toolingRevision = createHash("sha256").update(`${sourcePath}\0${sourceContent}\0${testPath}\0${testContent}\0`).digest("hex");
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const snapshotWithoutHash = {
  schemaVersion: 1 as const,
  recordVersion: "source-snapshot-v1",
  sourceRevision: `sha256:${sourceRevision}`,
  projectionRevision: toolingRevision,
  toolingRevision,
  toolingFiles: [
    { path: sourcePath, size: Buffer.byteLength(sourceContent), sha256: createHash("sha256").update(sourceContent).digest("hex") },
    { path: testPath, size: Buffer.byteLength(testContent), sha256: createHash("sha256").update(testContent).digest("hex") },
  ],
  baselineRunId: "run-authoring",
  expectedIndexHash: "a".repeat(64),
  expectedRootHash: "b".repeat(64),
  analysisId: "analysis-authoring",
  expectedAnalysisHash: "c".repeat(64),
  files: [
    { path: sourcePath, size: Buffer.byteLength(sourceContent), sha256: createHash("sha256").update(sourceContent).digest("hex") },
    { path: testPath, size: Buffer.byteLength(testContent), sha256: createHash("sha256").update(testContent).digest("hex") },
  ],
};
const snapshot = SourceSnapshotSchema.parse({
  ...snapshotWithoutHash,
  snapshotHash: createHash("sha256").update(canonicalJson(snapshotWithoutHash)).digest("hex"),
});

function result(overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    outputLimitExceeded: false,
    spawnErrorCode: null,
    ioErrorCode: null,
    terminationFailed: false,
    ...overrides,
  };
}

function proofFor(overrides: Record<string, unknown> = {}) {
  const base = {
    schemaVersion: 1 as const,
    recordVersion: "test-failure-proof-v1" as const,
    baselineRunId: "run-authoring",
    sourceSnapshotHash: snapshot.snapshotHash,
    testDiffHash: createHash("sha256").update(diff("test-only")).digest("hex"),
    sourceRevision: snapshot.sourceRevision,
    toolingRevision: snapshot.toolingRevision,
    commandId: M5_TEST_COMMAND_ID,
    argvDigest: M5_TEST_COMMAND_ARGV_DIGEST,
    controlHash: "1".repeat(64),
    sandboxResultHash: "2".repeat(64),
    sandboxEvidenceHash: "3".repeat(64),
    exitCode: 1 as const,
    signal: null,
    classification: "EXPECTED_FAILURE" as const,
    expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME" as const,
    assertionId: "seed.mononym-required-last-name" as const,
    assertionFragment: "required last name" as const,
    observedFailureHash: "4".repeat(64),
    ...overrides,
  };
  const canonical = canonicalJson(base);
  return TestFailureProofSchema.parse({ ...base, proofHash: createHash("sha256").update(canonical).digest("hex") });
}

function diff(operation: "test-only" | "source-only"): string {
  const filePath = operation === "test-only" ? testPath : sourcePath;
  const original = operation === "test-only" ? 'import assert from "node:assert/strict";' : "export const value = false;";
  if (operation === "test-only") {
    return `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,4 @@\n ${original}\n+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {\n+  assert.equal(validateBaselineLegalName("Sari").valid, true);\n+});\n`;
  }
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,2 @@\n ${original}\n+export const value = true;\n`;
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-authoring-test-"));
  roots.push(root);
  for (const file of snapshot.files) {
    const absolute = path.join(root, "projection", ...file.path.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.path === sourcePath ? sourceContent : testContent);
  }
  return root;
}

function runnerFor(output: unknown, calls: BoundedProcessRequest[]) {
  return async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    calls.push(request);
    if (request.args[0] === "--version") return result({ stdout: "codex-cli 0.139.0\n" });
    if (request.args[0] === "login") return result({ stdout: "Logged in using ChatGPT\n" });
    const index = request.args.indexOf("--output-last-message");
    await writeFile(request.args[index + 1]!, JSON.stringify(output));
    const jsonl = [
      { type: "thread.started", thread_id: "123e4567-e89b-42d3-a456-426614174000" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "message", type: "agent_message", text: JSON.stringify(output) } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    return result({ stdout: jsonl });
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded M5 Codex authoring", () => {
  it("authors a test-only diff and records sanitized provenance", async () => {
    const root = await setup();
    const calls: BoundedProcessRequest[] = [];
    const output = { schemaVersion: 1, operation: "test-only", unifiedDiff: diff("test-only") };
    const resultValue = await authorRegressionTest({
      authoringId: "author-test",
      baselineRunId: "run-authoring",
      snapshot,
      projectionDirectory: path.join(root, "projection"),
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe" },
      command,
      runner: runnerFor(output, calls),
    });
    expect(resultValue.diff.operation).toBe("test-only");
    expect(resultValue.attempt).toMatchObject({ status: "SUCCESS", operation: "test-only", diffHash: resultValue.diff.diffHash });
    expect(calls.filter(({ args }) => args[0] === "exec")).toHaveLength(1);
    expect(calls.at(-1)?.args).toEqual(expect.arrayContaining(["--ephemeral", "--sandbox", "read-only", "--disable", "shell_tool"]));
  });

  it("makes the source author unreachable until a valid expected-failure proof exists", async () => {
    const root = await setup();
    let calls = 0;
    await expect(authorCandidatePatch({
      authoringId: "author-source",
      baselineRunId: "run-authoring",
      snapshot,
      projectionDirectory: path.join(root, "projection"),
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe" },
      command,
      testDiffHash: "f".repeat(64),
      testDiffContent: diff("test-only"),
      runner: async () => { calls += 1; return result(); },
      readTestFailureProof: async () => proofFor({ sourceSnapshotHash: "e".repeat(64) }),
    })).rejects.toMatchObject({ code: "AUTHORING_TEST_PROOF_REQUIRED" });
    expect(calls).toBe(0);
  });

  it("accepts source-only authoring only with an immutable proof bound to the snapshot", async () => {
    const root = await setup();
    const proof = proofFor();
    const calls: BoundedProcessRequest[] = [];
    const output = { schemaVersion: 1, operation: "source-only", unifiedDiff: diff("source-only") };
    const resultValue = await authorCandidatePatch({
      authoringId: "author-source",
      baselineRunId: "run-authoring",
      snapshot,
      projectionDirectory: path.join(root, "projection"),
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe" },
      command,
      testDiffHash: proof.testDiffHash,
      testDiffContent: diff("test-only"),
      runner: runnerFor(output, calls),
      readTestFailureProof: async () => proof,
    });
    expect(resultValue.diff.operation).toBe("source-only");
    expect(calls.filter(({ args }) => args[0] === "exec")).toHaveLength(1);
  });
});
