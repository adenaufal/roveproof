import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M5_INSPECTED_IMAGE, SandboxResultSchema, SourceSnapshotSchema } from "@roveproof/contracts";
import {
  FIXED_SANDBOX_COMMANDS,
  createSandboxControl,
  parseTestAuthoringDiff,
  runDockerCandidate,
  type DockerProcessRequest,
  type DockerProcessResult,
} from "../src/index.js";

const roots: string[] = [];
const target = "apps/target/test/repair-mononym.test.mjs";
const content = "import assert from \"node:assert/strict\";\n";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const help = ["--pull", "--network", "--read-only", "--init", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--stop-timeout", "--mount", "--tmpfs", "--entrypoint"].join(" ");
const processResult = (overrides: Partial<DockerProcessResult> = {}): DockerProcessResult => ({ stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 1, spawnErrorCode: null, terminationFailed: false, outputLimitExceeded: false, timedOut: false, ...overrides });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-docker-control-"));
  roots.push(root);
  const projectionDirectory = path.join(root, "projection");
  const exportDirectory = path.join(root, "export");
  await mkdir(path.join(projectionDirectory, ...path.dirname(target).split("/")), { recursive: true });
  await mkdir(exportDirectory, { recursive: true });
  await writeFile(path.join(projectionDirectory, ...target.split("/")), content);
  const withoutHash = {
    schemaVersion: 1 as const,
    recordVersion: "source-snapshot-v1" as const,
    sourceRevision: `sha256:${"a".repeat(64)}`,
    projectionRevision: "e".repeat(64),
    toolingRevision: "e".repeat(64),
    toolingFiles: [{ path: target, size: Buffer.byteLength(content), sha256: hash(content) }],
    baselineRunId: "run-docker-control",
    expectedIndexHash: "b".repeat(64),
    expectedRootHash: "c".repeat(64),
    analysisId: "analysis-docker-control",
    expectedAnalysisHash: "d".repeat(64),
    files: [{ path: target, size: Buffer.byteLength(content), sha256: hash(content) }],
  };
  const snapshot = SourceSnapshotSchema.parse({ ...withoutHash, snapshotHash: hash(canonical(withoutHash)) });
  const diff = parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: `--- a/${target}\n+++ b/${target}\n@@ -1,1 +1,4 @@\n import assert from "node:assert/strict";\n+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {\n+  assert.equal(validateBaselineLegalName("Sari").valid, true);\n+});\n` });
  return { root, projectionDirectory, exportDirectory, snapshot, diff };
}

function resultFile(control: Record<string, unknown>, expected: boolean) {
  const base = {
    schemaVersion: 1 as const,
    recordVersion: "sandbox-result-v1" as const,
    stage: control.stage,
    commandId: control.commandId,
    controlHash: control.controlHash,
    started: true,
    exitCode: control.stage === "test-proof" ? 1 : 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    resourceLimitExceeded: false,
    setupError: null,
    protocolError: null,
    patchApplyError: null,
    exportViolation: null,
    secretDetected: false,
    infrastructureError: null,
    stdoutSha256: hash(expected ? "expected output" : "pass output"),
    stderrSha256: hash(""),
    appliedDiffHash: control.stage === "test-proof" ? control.testDiffHash : control.combinedDiffHash,
    matchedExpectedFailure: expected,
    observedFailureHash: expected ? hash("failure") : null,
  };
  return SandboxResultSchema.parse({ ...base, resultHash: hash(canonical(base)) });
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("M5 Docker control boundary", () => {
  it("fails closed before Docker for an unpinned or wrong approved image", async () => {
    const { root, projectionDirectory, exportDirectory } = await fixture();
    let calls = 0;
    const outcome = await runDockerCandidate({ image: "node:22", projectionDirectory, exportDirectory, temporaryRoot: root, commandId: "test-regression", control: {} as never, parentEnvironment: { PATH: "safe" }, runner: async () => { calls += 1; return processResult(); } });
    expect(outcome.status).toBe("REJECTED");
    expect(calls).toBe(0);
  });

  it("passes only a fixed control and classifies the expected test failure without model argv", async () => {
    const { root, projectionDirectory, exportDirectory, snapshot, diff } = await fixture();
    const control = createSandboxControl({ stage: "test-proof", snapshot, testDiff: diff });
    const calls: DockerProcessRequest[] = [];
    const outcome = await runDockerCandidate({ image: M5_INSPECTED_IMAGE, projectionDirectory, exportDirectory, temporaryRoot: root, commandId: "test-regression", control, parentEnvironment: { PATH: "safe", HOME: "host-home", CODEX_HOME: "host-codex" }, runner: async (request) => {
      calls.push(request);
      if (request.args[0] === "run" && request.args[1] === "--help") return processResult({ stdout: help });
      if (request.args[0] === "image") return processResult({ stdout: M5_INSPECTED_IMAGE });
      if (request.args[0] === "run") {
        const result = resultFile(control, true);
        await writeFile(path.join(exportDirectory, "result.json"), `${JSON.stringify(result)}\n`);
      }
      return processResult();
    } });
    expect(outcome.status).toBe("PASS");
    expect(outcome.evidence.classification).toBe("EXPECTED_FAILURE");
    expect(outcome.evidence.started).toBe(true);
    expect(calls.at(-1)?.env.HOME).toBeUndefined();
    expect(calls.at(-1)?.env.CODEX_HOME).toBeUndefined();
    const run = calls.at(-1)!;
    expect(run.stdin).toContain(control.controlHash);
    expect(run.args).toContain("--entrypoint");
    expect(run.args).not.toContain("apps/target/test/repair-mononym.test.mjs");
    expect(run.args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--pull=never", "--cap-drop", "ALL"]));
  });

  it("rejects a wrong expected-failure outcome without treating it as infrastructure", async () => {
    const { root, projectionDirectory, exportDirectory, snapshot, diff } = await fixture();
    const control = createSandboxControl({ stage: "test-proof", snapshot, testDiff: diff });
    const outcome = await runDockerCandidate({ image: M5_INSPECTED_IMAGE, projectionDirectory, exportDirectory, temporaryRoot: root, commandId: "test-regression", control, parentEnvironment: { PATH: "safe" }, runner: async (request) => {
      if (request.args[0] === "run" && request.args[1] === "--help") return processResult({ stdout: help });
      if (request.args[0] === "image") return processResult({ stdout: M5_INSPECTED_IMAGE });
      if (request.args[0] === "run") {
        const withoutHash = { ...resultFile(control, true), exitCode: 0, matchedExpectedFailure: false, observedFailureHash: null };
        delete withoutHash.resultHash;
        await writeFile(path.join(exportDirectory, "result.json"), `${JSON.stringify({ ...withoutHash, resultHash: hash(canonical(withoutHash)) })}\n`);
      }
      return processResult();
    } });
    expect(outcome.status).toBe("REJECTED");
    expect(outcome.evidence.classification).toBe("TEST_DID_NOT_FAIL");
  });

  it("rejects an exported result whose applied diff is not the controlled test diff", async () => {
    const { root, projectionDirectory, exportDirectory, snapshot, diff } = await fixture();
    const control = createSandboxControl({ stage: "test-proof", snapshot, testDiff: diff });
    const outcome = await runDockerCandidate({ image: M5_INSPECTED_IMAGE, projectionDirectory, exportDirectory, temporaryRoot: root, commandId: "test-regression", control, parentEnvironment: { PATH: "safe" }, runner: async (request) => {
      if (request.args[0] === "run" && request.args[1] === "--help") return processResult({ stdout: help });
      if (request.args[0] === "image") return processResult({ stdout: M5_INSPECTED_IMAGE });
      if (request.args[0] === "run") {
        const withoutHash = { ...resultFile(control, true), appliedDiffHash: hash("wrong-diff") };
        delete withoutHash.resultHash;
        await writeFile(path.join(exportDirectory, "result.json"), `${JSON.stringify({ ...withoutHash, resultHash: hash(canonical(withoutHash)) })}\n`);
      }
      return processResult();
    } });
    expect(outcome.status).toBe("INCONCLUSIVE");
  });

  it("does not start the candidate when image digest inspection is unavailable", async () => {
    const { root, projectionDirectory, exportDirectory, snapshot, diff } = await fixture();
    const control = createSandboxControl({ stage: "test-proof", snapshot, testDiff: diff });
    const calls: DockerProcessRequest[] = [];
    const outcome = await runDockerCandidate({ image: M5_INSPECTED_IMAGE, projectionDirectory, exportDirectory, temporaryRoot: root, commandId: "test-regression", control, parentEnvironment: { PATH: "safe" }, runner: async (request) => { calls.push(request); return request.args[0] === "run" && request.args[1] === "--help" ? processResult({ stdout: help }) : request.args[0] === "info" ? processResult() : processResult({ exitCode: 1 }); } });
    expect(outcome.status).toBe("INCONCLUSIVE");
    expect(calls.map(({ args }) => args[0])).toEqual(["info", "run", "image"]);
    expect(calls.every(({ args }) => !args.includes(FIXED_SANDBOX_COMMANDS["test-regression"].argv[0]))).toBe(true);
  });
});
