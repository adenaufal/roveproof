import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const smoke = path.join(repositoryRoot, "scripts", "run-repair-smoke.mjs");

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [smoke, ...args], { cwd: repositoryRoot, env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

describe("repair smoke CLI", () => {
  it("requires every explicit binding and never infers latest", async () => {
  const result = await run([]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /explicit --baseline-run-id/i);
  assert.equal(result.stdout, "");
  });

  it("rejects unknown flags before any admission or Docker call", async () => {
  const result = await run(["--baseline-run-id", "run-invalid", "--unexpected", "value"]);
  assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown argument|explicit --expected-index-hash/i);
  });
});
