import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWED_CODEX_ENVIRONMENT_KEYS,
  ModelAdapterError,
  buildCodexEnvironment,
  resolveCodexCommand,
  runBoundedProcess,
  runCodexPreflight,
  type BoundedProcessResult,
  type CodexProcessRunner,
} from "../src/index.js";

const command = { executable: "trusted-codex", prefixArgs: [] } as const;
const roots: string[] = [];
const success = (stdout: string): BoundedProcessResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
  durationMs: 1,
  timedOut: false,
  outputLimitExceeded: false,
  spawnErrorCode: null,
  ioErrorCode: null,
  terminationFailed: false,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWindowsNpmCodex(root: string, version = "0.139.0"): Promise<string> {
  const binDirectory = path.join(root, "bin");
  const packageRoot = path.join(binDirectory, "node_modules", "@openai", "codex");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(path.join(binDirectory, "codex.cmd"), "@echo off\n");
  await writeFile(path.join(packageRoot, "bin", "codex.js"), "export {};\n");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex",
    version,
    bin: { codex: "bin/codex.js" },
  }));
  return binDirectory;
}

describe("subscription-only Codex process policy", () => {
  it.each(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"])("rejects %s by presence even when empty", (key) => {
    expect(() => buildCodexEnvironment({ PATH: "safe", [key]: "" })).toThrow(ModelAdapterError);
  });

  it("constructs a minimal allowlist and drops unrelated inherited secrets", () => {
    const environment = buildCodexEnvironment({
      PATH: "safe",
      HOME: "home",
      SECRET_TOKEN: "must-not-pass",
      DATABASE_URL: "must-not-pass",
    });
    expect(environment).toEqual({ PATH: "safe", HOME: "home", NO_COLOR: "1" });
    expect(Object.keys(environment).every((key) => key === "NO_COLOR" || (ALLOWED_CODEX_ENVIRONMENT_KEYS as readonly string[]).includes(key))).toBe(true);
  });

  it("rejects native, wrong-version, and npm-shaped PATH shadows without official release integrity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-codex-resolver-"));
    roots.push(root);
    const npmShapedShadow = await createWindowsNpmCodex(path.join(root, "npm-shadow"));
    await expect(resolveCodexCommand({ PATH: npmShapedShadow }, { platform: "win32", architecture: "x64" }))
      .rejects.toMatchObject({ code: "MODEL_CLI_IDENTITY_INVALID" });

    const nativeShadow = path.join(root, "native-shadow");
    await mkdir(nativeShadow, { recursive: true });
    await writeFile(path.join(nativeShadow, "codex.exe"), "spoof");
    await expect(resolveCodexCommand({ PATH: [nativeShadow, npmShapedShadow].join(path.delimiter) }, { platform: "win32", architecture: "x64" }))
      .rejects.toMatchObject({ code: "MODEL_CLI_IDENTITY_INVALID" });

    const wrongVersion = await createWindowsNpmCodex(path.join(root, "wrong-version"), "0.140.0");
    await expect(resolveCodexCommand({ PATH: wrongVersion }, { platform: "win32", architecture: "x64" }))
      .rejects.toMatchObject({ code: "MODEL_CLI_IDENTITY_INVALID" });
  });

  it("requires the exact pinned version and exact ChatGPT login status", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: CodexProcessRunner = async (request) => {
      mutableCalls.push([...request.args]);
      return request.args[0] === "--version"
        ? success("codex-cli 0.139.0\n")
        : success("Logged in using ChatGPT\n");
    };
    await expect(runCodexPreflight({
      parentEnvironment: { PATH: "safe" },
      command,
      runner,
      cwd: ".",
    })).resolves.toMatchObject({ cliVersion: "0.139.0", authMode: "chatgpt-subscription" });
    expect(calls).toEqual([["--version"], ["login", "status"]]);
  });

  it("handles an early-closing child stdin without crashing the host", async () => {
    await expect(runBoundedProcess({
      command: { executable: process.execPath, prefixArgs: [] },
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      stdin: "x".repeat(256 * 1024),
      timeoutMs: 2_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    })).resolves.toMatchObject({ timedOut: false, outputLimitExceeded: false });
  });

  it("enforces process timeout and stdout limits without a shell", async () => {
    const timeout = await runBoundedProcess({
      command: { executable: process.execPath, prefixArgs: [] },
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 100,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });
    expect(timeout.timedOut).toBe(true);

    const oversized = await runBoundedProcess({
      command: { executable: process.execPath, prefixArgs: [] },
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 2_000,
      maxStdoutBytes: 64,
      maxStderrBytes: 1_024,
    });
    expect(oversized.outputLimitExceeded).toBe(true);
  });

  it.each([
    ["codex-cli 0.140.0\n", "Logged in using ChatGPT\n", "MODEL_CLI_VERSION_UNSUPPORTED"],
    ["codex-cli 0.139.0\n", "Not Logged in using ChatGPT\n", "MODEL_AUTH_NOT_CHATGPT"],
    ["codex-cli 0.139.0\n", "logged in using chatgpt\n", "MODEL_AUTH_NOT_CHATGPT"],
  ])("fails closed for unsupported version or non-exact auth", async (version, auth, code) => {
    const runner: CodexProcessRunner = async (request) => success(request.args[0] === "--version" ? version : auth);
    await expect(runCodexPreflight({ parentEnvironment: { PATH: "safe" }, command, runner, cwd: "." })).rejects.toMatchObject({ code });
  });
});
