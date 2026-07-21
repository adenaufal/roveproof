import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { CODEX_CLI_VERSION, MODEL_AUTH_MODE } from "@roveproof/contracts";
import { ModelAdapterError } from "./errors.js";

export const FORBIDDEN_MODEL_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
] as const;

export const ALLOWED_CODEX_ENVIRONMENT_KEYS = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME",
  "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM",
] as const;

export type ResolvedCodexCommand = Readonly<{
  executable: string;
  prefixArgs: readonly string[];
}>;

type IntegrityEntry = Readonly<{ path: string; sha256: string }>;

// Derived from the GitHub rust-v0.139.0 release assets after verifying:
// codex-npm-0.139.0.tgz sha256:52ff8eab5eaefd248dadd608c734089015619357e9fab1356c5b751e97a78079
// codex-npm-win32-x64-0.139.0.tgz sha256:99698e69d6acf91c75703669fdfd00d54f4b249beabc7d32a03404e8c2c3b2c7
// https://github.com/openai/codex/releases/tag/rust-v0.139.0
const CODEX_RUNTIME_INTEGRITY: Readonly<Record<string, readonly IntegrityEntry[]>> = Object.freeze({
  "win32-x64": Object.freeze([
    { path: "bin/codex.js", sha256: "d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406" },
    { path: "package.json", sha256: "c6e68915c8c7c2c5169ccb6d326789850a9a540875cbc3b04dc3df4d775e7412" },
    { path: "node_modules/@openai/codex-win32-x64/package.json", sha256: "050bbd92ca8843b971eae74dc9b52d0034d5b70440b855dea7364792a3784179" },
    { path: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe", sha256: "77a84f8078400467ade4301d827b8bcea2d29b6838c9cd162bf3573b7ef97e10" },
    { path: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-package.json", sha256: "c40f68912a7011ef9dd6e29b801994883ad09cd7ab79772a39d9771c1ab49978" },
    { path: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-path/rg.exe", sha256: "decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408" },
    { path: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-resources/codex-command-runner.exe", sha256: "16efe4854dfb31f584430ce2c0d25c1c42d5fd5298b6d8cda827141638928a3f" },
    { path: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-resources/codex-windows-sandbox-setup.exe", sha256: "d6349976daeaec8539857ba777b807f8565c09512811b4fe0678c1545213b1b1" },
  ]),
});

export type BoundedProcessRequest = Readonly<{
  command: ResolvedCodexCommand;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}>;

export type BoundedProcessResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnErrorCode: string | null;
  ioErrorCode: string | null;
  terminationFailed: boolean;
}>;

export type CodexProcessRunner = (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;

function hasOwnEnvironmentKey(environment: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(environment, key);
}

export function buildCodexEnvironment(parentEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const forbidden = FORBIDDEN_MODEL_ENVIRONMENT_KEYS.filter((key) => hasOwnEnvironmentKey(parentEnvironment, key));
  if (forbidden.length > 0) throw new ModelAdapterError("MODEL_ENV_FORBIDDEN", "preflight");
  const environment = Object.fromEntries(
    ALLOWED_CODEX_ENVIRONMENT_KEYS.flatMap((key) => parentEnvironment[key] === undefined ? [] : [[key, parentEnvironment[key]]]),
  );
  environment.NO_COLOR = "1";
  return environment;
}

function hardenCodexSearchPath(environment: NodeJS.ProcessEnv, command: ResolvedCodexCommand): NodeJS.ProcessEnv {
  const directories = new Set<string>([path.dirname(path.resolve(command.executable))]);
  for (const prefixArgument of command.prefixArgs) {
    if (path.isAbsolute(prefixArgument)) directories.add(path.dirname(prefixArgument));
  }
  if (process.platform === "win32") {
    const systemRoot = environment.SystemRoot ?? environment.WINDIR;
    if (systemRoot) directories.add(path.join(systemRoot, "System32"));
  } else {
    directories.add("/usr/bin");
    directories.add("/bin");
  }
  return { ...environment, PATH: [...directories].join(path.delimiter) };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function regularFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertCodexRuntimeIntegrity(packageRoot: string, platform: NodeJS.Platform, architecture: string): Promise<void> {
  const manifest = CODEX_RUNTIME_INTEGRITY[`${platform}-${architecture}`];
  if (!manifest) throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
  for (const entry of manifest) {
    const filePath = path.join(packageRoot, ...entry.path.split("/"));
    if (!await regularFile(filePath) || await sha256File(filePath) !== entry.sha256) {
      throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
    }
    const canonicalFile = await realpath(filePath);
    const relative = path.relative(packageRoot, canonicalFile);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
    }
  }
}

async function validateCanonicalCodexPackage(nodeEntryInput: string, platform: NodeJS.Platform, architecture: string): Promise<string> {
  const nodeEntry = await realpath(nodeEntryInput).catch(() => {
    throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
  });
  const packageRoot = path.dirname(path.dirname(nodeEntry));
  const packageJsonPath = path.join(packageRoot, "package.json");
  const [entryMetadata, rootMetadata, packageMetadata] = await Promise.all([
    lstat(nodeEntry),
    lstat(packageRoot),
    lstat(packageJsonPath),
  ]).catch(() => {
    throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
  });
  if (!entryMetadata.isFile() || entryMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
    !packageMetadata.isFile() || packageMetadata.isSymbolicLink() || path.basename(nodeEntry) !== "codex.js" || path.basename(path.dirname(nodeEntry)) !== "bin") {
    throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
  }
  let packageRecord: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid package metadata");
    packageRecord = parsed as Record<string, unknown>;
  } catch {
    throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
  }
  const bin = packageRecord.bin;
  if (
    packageRecord.name !== "@openai/codex" ||
    packageRecord.version !== CODEX_CLI_VERSION ||
    !bin || typeof bin !== "object" || Array.isArray(bin) ||
    (bin as Record<string, unknown>).codex !== "bin/codex.js"
  ) {
    throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
  }
  await assertCodexRuntimeIntegrity(packageRoot, platform, architecture);
  return nodeEntry;
}

export async function resolveCodexCommand(
  parentEnvironment: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ platform?: NodeJS.Platform; architecture?: string; nodeExecutable?: string }> = {},
): Promise<ResolvedCodexCommand> {
  const searchPath = parentEnvironment.PATH ?? parentEnvironment.Path ?? parentEnvironment.path;
  if (!searchPath) throw new ModelAdapterError("MODEL_CLI_NOT_FOUND", "preflight");
  const directories = searchPath.split(path.delimiter).filter(Boolean);
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  for (const directory of directories) {
    if (platform === "win32") {
      const markerPaths = ["codex", "codex.cmd", "codex.exe", "codex.bat", "codex.ps1"].map((name) => path.join(directory, name));
      const markerPresence = await Promise.all(markerPaths.map(pathExists));
      if (!markerPresence.some(Boolean)) continue;
      const shimPath = path.join(directory, "codex.cmd");
      const nodeEntryPath = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (!await regularFile(shimPath) || !await regularFile(nodeEntryPath) || await pathExists(path.join(directory, "codex.exe"))) {
        throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
      }
      return { executable: nodeExecutable, prefixArgs: [await validateCanonicalCodexPackage(nodeEntryPath, platform, architecture)] };
    }

    const shimPath = path.join(directory, "codex");
    if (!await pathExists(shimPath)) continue;
    const nodeEntryPath = await realpath(shimPath).catch(() => {
      throw new ModelAdapterError("MODEL_CLI_IDENTITY_INVALID", "preflight");
    });
    return { executable: nodeExecutable, prefixArgs: [await validateCanonicalCodexPackage(nodeEntryPath, platform, architecture)] };
  }

  throw new ModelAdapterError("MODEL_CLI_NOT_FOUND", "preflight");
}

async function terminateProcessTree(childPid: number | undefined): Promise<boolean> {
  if (!childPid) return false;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (failed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(failed);
      };
      const killer = spawn(taskkill, ["/pid", String(childPid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      const deadline = setTimeout(() => {
        killer.kill("SIGKILL");
        finish(true);
      }, 5_000);
      deadline.unref();
      killer.once("error", () => finish(true));
      killer.once("close", () => finish(false));
    });
  }
  try {
    process.kill(-childPid, "SIGKILL");
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export const runBoundedProcess: CodexProcessRunner = async (request) => {
  const startedAt = performance.now();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;
  let outputLimitExceeded = false;
  let spawnErrorCode: string | null = null;
  let ioErrorCode: string | null = null;
  let terminationRequested = false;
  let terminationPromise: Promise<boolean> | null = null;

  const child = spawn(request.command.executable, [...request.command.prefixArgs, ...request.args], {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const terminate = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    child.kill("SIGKILL");
    terminationPromise = terminateProcessTree(child.pid).catch(() => true);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > request.maxStdoutBytes) {
      outputLimitExceeded = true;
      terminate();
      return;
    }
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > request.maxStderrBytes) {
      outputLimitExceeded = true;
      terminate();
      return;
    }
    stderrChunks.push(chunk);
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    spawnErrorCode = error.code ?? "UNKNOWN";
  });
  const onIoError = (error: NodeJS.ErrnoException): void => {
    ioErrorCode ??= error.code ?? "UNKNOWN";
    terminate();
  };
  child.stdin.on("error", onIoError);
  child.stdout.on("error", onIoError);
  child.stderr.on("error", onIoError);

  try {
    if (request.stdin !== undefined) child.stdin.end(request.stdin, "utf8");
    else child.stdin.end();
  } catch (error) {
    onIoError(error as NodeJS.ErrnoException);
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);
  timeout.unref();

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  });
  clearTimeout(timeout);
  const terminationFailed = terminationPromise ? await terminationPromise : false;

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
    signal,
    durationMs: Math.max(0, performance.now() - startedAt),
    timedOut,
    outputLimitExceeded,
    spawnErrorCode,
    ioErrorCode,
    terminationFailed,
  };
};

export type CodexPreflight = Readonly<{
  command: ResolvedCodexCommand;
  environment: NodeJS.ProcessEnv;
  cliVersion: typeof CODEX_CLI_VERSION;
  authMode: typeof MODEL_AUTH_MODE;
}>;

function processSucceeded(result: BoundedProcessResult): boolean {
  return !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed && result.spawnErrorCode === null &&
    result.ioErrorCode === null && result.signal === null && result.exitCode === 0;
}

function combinedOutput(result: BoundedProcessResult): string {
  return `${result.stdout}${result.stderr}`.trim();
}

export async function runCodexPreflight(options: Readonly<{
  parentEnvironment?: NodeJS.ProcessEnv;
  command?: ResolvedCodexCommand;
  runner?: CodexProcessRunner;
  cwd?: string;
}> = {}): Promise<CodexPreflight> {
  const parentEnvironment = options.parentEnvironment ?? process.env;
  const command = options.command ?? await resolveCodexCommand(parentEnvironment);
  const environment = hardenCodexSearchPath(buildCodexEnvironment(parentEnvironment), command);
  const runner = options.runner ?? runBoundedProcess;
  const cwd = options.cwd ?? process.cwd();
  const common = { command, cwd, env: environment, timeoutMs: 10_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 } as const;

  const version = await runner({ ...common, args: ["--version"] });
  if (!processSucceeded(version)) {
    if (version.terminationFailed) throw new ModelAdapterError("MODEL_PROCESS_TERMINATION_FAILED", "preflight");
    if (version.timedOut) throw new ModelAdapterError("MODEL_TIMEOUT", "preflight");
    if (version.outputLimitExceeded) throw new ModelAdapterError("MODEL_OUTPUT_LIMIT", "preflight");
    if (version.spawnErrorCode) throw new ModelAdapterError("MODEL_SPAWN_FAILED", "preflight", { retryable: version.spawnErrorCode === "EAGAIN" });
    if (version.ioErrorCode) throw new ModelAdapterError("MODEL_PROCESS_EXIT", "preflight");
    throw new ModelAdapterError("MODEL_CLI_VERSION_UNSUPPORTED", "preflight");
  }
  const exactVersionOutput = `codex-cli ${CODEX_CLI_VERSION}`;
  if (combinedOutput(version) !== exactVersionOutput) {
    throw new ModelAdapterError("MODEL_CLI_VERSION_UNSUPPORTED", "preflight");
  }

  const auth = await runner({ ...common, args: ["login", "status"] });
  if (!processSucceeded(auth)) {
    if (auth.terminationFailed) throw new ModelAdapterError("MODEL_PROCESS_TERMINATION_FAILED", "preflight", { provenance: { cliVersion: CODEX_CLI_VERSION } });
    if (auth.timedOut) throw new ModelAdapterError("MODEL_TIMEOUT", "preflight", { provenance: { cliVersion: CODEX_CLI_VERSION } });
    if (auth.outputLimitExceeded) throw new ModelAdapterError("MODEL_OUTPUT_LIMIT", "preflight", { provenance: { cliVersion: CODEX_CLI_VERSION } });
    if (auth.spawnErrorCode) {
      throw new ModelAdapterError("MODEL_SPAWN_FAILED", "preflight", {
        retryable: auth.spawnErrorCode === "EAGAIN",
        provenance: { cliVersion: CODEX_CLI_VERSION },
      });
    }
    if (auth.ioErrorCode) throw new ModelAdapterError("MODEL_PROCESS_EXIT", "preflight", { provenance: { cliVersion: CODEX_CLI_VERSION } });
    throw new ModelAdapterError("MODEL_AUTH_NOT_CHATGPT", "preflight", { provenance: { cliVersion: CODEX_CLI_VERSION } });
  }
  if (combinedOutput(auth) !== "Logged in using ChatGPT") {
    throw new ModelAdapterError("MODEL_AUTH_NOT_CHATGPT", "preflight", { provenance: { cliVersion: CODEX_CLI_VERSION } });
  }

  return { command, environment, cliVersion: CODEX_CLI_VERSION, authMode: MODEL_AUTH_MODE };
}
