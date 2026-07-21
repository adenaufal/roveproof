import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const artifactRoot = path.join(repositoryRoot, "var", "roveproof");
const runtimeRoot = path.join(artifactRoot, "runtime");
await mkdir(runtimeRoot, { recursive: true });
const targetDataDirectory = await mkdtemp(path.join(runtimeRoot, "baseline-"));
const port = Number(process.env.ROVEPROOF_TARGET_PORT ?? 3101);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("ROVEPROOF_TARGET_PORT must be an unprivileged TCP port");
const targetOrigin = `http://127.0.0.1:${port}`;
const targetUrl = `${targetOrigin}/checkout`;
const nextBin = require.resolve("next/dist/bin/next");
const output = [];

const server = spawn(process.execPath, [nextBin, "start", "apps/target", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: repositoryRoot,
  env: { ...process.env, ROVEPROOF_DATA_DIR: targetDataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
for (const stream of [server.stdout, server.stderr]) {
  stream?.on("data", (chunk) => {
    output.push(String(chunk));
    if (output.length > 40) output.shift();
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Target exited during startup.\n${output.join("")}`);
    try {
      const response = await fetch(`${targetOrigin}/api/runner-probe`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // Retry only during the bounded startup window.
    }
    await delay(250);
  }
  throw new Error(`Target did not become ready.\n${output.join("")}`);
}

async function stopServer() {
  if (server.exitCode !== null || server.killed) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => server.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (exited) return;
  if (process.platform === "win32" && server.pid) {
    spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    server.kill("SIGKILL");
  }
}

let exitCode = 0;
try {
  await waitForTarget();
  const [{ runBaseline }, { computeTargetSourceRevision }, { BASELINE_OBSERVATION_TOLERANCE }] = await Promise.all([
    import("../packages/journey/dist/runner.js"),
    import("../packages/journey/dist/source-revision.js"),
    import("../packages/journey/dist/config.js"),
  ]);
  const sourceRevision = await computeTargetSourceRevision(repositoryRoot);
  const runId = `run-${randomUUID()}`;
  const run = await runBaseline({ artifactRoot, targetUrl, sourceRevision, runId, headless: true });
  const { result, manifest, assertions } = run.bundle;
  const bytesInRange =
    result.performance.transferredBytes >= BASELINE_OBSERVATION_TOLERANCE.transferredBytes.minimum &&
    result.performance.transferredBytes <= BASELINE_OBSERVATION_TOLERANCE.transferredBytes.maximum;
  const durationInRange =
    result.task.durationMs >= BASELINE_OBSERVATION_TOLERANCE.durationMs.minimum &&
    result.task.durationMs <= BASELINE_OBSERVATION_TOLERANCE.durationMs.maximum;
  if (result.verdict !== "FAIL_BLOCKED") throw new Error(`Expected FAIL_BLOCKED baseline, received ${result.verdict}`);
  if (!manifest.runtime.profileVerified) throw new Error("Baseline profile was not independently verified");
  if (manifest.missingArtifacts.length > 0) throw new Error("Baseline evidence bundle is incomplete");
  if (assertions.observedSeedIds.length !== 3) throw new Error("Baseline did not reproduce exactly three seed IDs");
  if (!bytesInRange || !durationInRange) {
    throw new Error(`Baseline observation outside frozen tolerance: ${result.performance.transferredBytes} bytes / ${result.task.durationMs} ms`);
  }
  console.log(`Evidence run: ${runId}`);
  console.log(`Bundle: ${run.bundle.directory}`);
  console.log(`Anchor: ${path.join(artifactRoot, "anchors", `${runId}.json`)} (${run.bundle.indexHash})`);
  console.log(`Verdict: ${result.verdict}`);
  console.log(`Observed: ${(result.performance.transferredBytes / 1_000_000).toFixed(1)} MB / ${Math.round(result.task.durationMs / 1_000)} s (single run; rounded to 0.1 MB and nearest second)`);
  console.log(`Profile: ${manifest.runtime.profileVerified ? "verified" : "unverified"}`);
  if (result.verdict === "INCONCLUSIVE") exitCode = 2;
} finally {
  await stopServer();
  await rm(targetDataDirectory, { recursive: true, force: true });
}
process.exitCode = exitCode;
