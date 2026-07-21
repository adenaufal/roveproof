import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const smoke = path.join(repositoryRoot, "scripts", "run-model-smoke.mjs");

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

describe("model smoke CLI", () => {
  it("requires the explicit expected index hash before model admission", async () => {
    const result = await run(["--run-id", "run-model-args"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /expected-index-hash/i);
    assert.equal(result.stdout, "");
  });
});
