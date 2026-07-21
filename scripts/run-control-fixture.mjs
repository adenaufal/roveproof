import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const controlRepositoryRoot = await mkdtemp(path.join(os.tmpdir(), "roveproof-control-e2e-"));
const port = Number(process.env.ROVEPROOF_CONTROL_PORT ?? 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("ROVEPROOF_CONTROL_PORT must be an unprivileged TCP port");
const origin = `http://127.0.0.1:${port}`;
const nextBin = require.resolve("next/dist/bin/next");
const output = [];

const server = spawn(process.execPath, [nextBin, "start", "apps/control", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: repositoryRoot,
  env: { ...process.env, ROVEPROOF_REPOSITORY_ROOT: controlRepositoryRoot },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
for (const stream of [server.stdout, server.stderr]) {
  stream?.on("data", (chunk) => {
    output.push(String(chunk));
    if (output.length > 40) output.shift();
  });
}

async function waitForControl() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Control app exited during startup.\n${output.join("")}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // Retry only during the bounded startup window.
    }
    await delay(250);
  }
  throw new Error(`Control app did not become ready.\n${output.join("")}`);
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

let browser;
try {
  await waitForControl();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto(origin, { waitUntil: "networkidle" });
  await assert.doesNotReject(() => page.getByText("Fixture rehearsal · not approvable", { exact: false }).waitFor());
  assert.equal(await page.locator(".failureLedger > li").count(), 3);
  assert.equal(await page.locator(".countBadge").innerText(), "03 FIXTURE SEEDS");
  assert.match(await page.locator(".measureBefore").innerText(), /Reference fixture · not a live measurement/i);
  assert.equal(await page.getByText("Fixture ledger entry only; no live trace is served by the dashboard.", { exact: true }).isVisible(), true);
  assert.equal(await page.getByText("8.2 MB", { exact: true }).count(), 1);
  assert.equal(await page.getByText("19 s", { exact: true }).count(), 1);
  assert.equal(await page.getByText("1.4 MB", { exact: true }).count(), 1);
  assert.equal(await page.getByText("6 s", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /approval unavailable/i }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: /approve/i }).count(), 0);

  await page.getByRole("button", { name: /run fixture rehearsal/i }).click();
  await page.getByText("Presentation: REHEARSAL_COMPLETE", { exact: false }).waitFor({ timeout: 12_000 });
  assert.equal(await page.locator('.journeyStep[data-status="complete"]').count(), 10);
  assert.equal(await page.locator(".runConsoleTop strong").innerText(), "Rehearsal complete");
  assert.equal(await page.locator(".countBadge").innerText(), "03 / 03 REPRODUCED");
  assert.match(await page.locator(".stateTruth").innerText(), /INCONCLUSIVE/);

  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator('.journeyStep[data-status="complete"]').count(), 10);
  assert.equal(await page.locator(".runConsoleTop strong").innerText(), "Rehearsal complete");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.equal(browserErrors.length, 0, browserErrors.join("\n"));

  const degradedPage = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  await degradedPage.route("**/api/jobs/*/events*", (route) => route.abort());
  await degradedPage.goto(origin, { waitUntil: "networkidle" });
  await degradedPage.getByRole("button", { name: /run fixture again/i }).click();
  await degradedPage.getByRole("button", { name: /refresh persisted status/i }).waitFor({ timeout: 8_000 });
  await delay(3_500);
  await degradedPage.getByRole("button", { name: /refresh persisted status/i }).click().catch(() => undefined);
  await degradedPage.getByText("Presentation: REHEARSAL_COMPLETE", { exact: false }).waitFor({ timeout: 8_000 });
  await degradedPage.close();
  console.log("Control fixture E2E: truth-state labels, 10 persisted phases, SSE recovery, fixture lock, refresh restore, and mobile fit verified");
} finally {
  await browser?.close();
  await stopServer();
  await rm(controlRepositoryRoot, { recursive: true, force: true });
}
