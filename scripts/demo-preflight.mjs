import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { ModelAdapterError, runCodexPreflight } from "@roveproof/model-adapter";

const require = createRequire(import.meta.url);

const requiredPaths = [
  "apps/control/package.json",
  "apps/target/package.json",
  "packages/contracts/package.json",
  "packages/evidence/package.json",
  "packages/model-adapter/package.json",
  "packages/journey/package.json",
  "packages/orchestrator/package.json",
  "packages/store/package.json",
  "apps/control/public/fixtures/baseline-start.png",
  "apps/control/public/fixtures/baseline-failure.png",
  "config/demo.ts",
  "config/profiles/indonesia-mobile-v1.json",
  "docs/planning/roveproof-mvp-20260718-010659/MODEL-BACKEND-DECISION.md",
  "docs/planning/roveproof-mvp-20260718-010659/MILESTONE-4-CONTEXT.md",
];

let failed = false;
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 9)) {
  console.error(`FAIL Node ${process.versions.node}; Next.js 16 requires Node >=20.9.0.`);
  failed = true;
} else {
  console.log(`PASS Node ${process.versions.node}`);
}

for (const file of requiredPaths) {
  try {
    await access(file);
    console.log(`PASS ${file}`);
  } catch {
    console.error(`FAIL missing ${file}`);
    failed = true;
  }
}

try {
  const packageVersion = require("playwright/package.json").version;
  if (packageVersion !== "1.61.1") throw new Error(`expected 1.61.1, found ${packageVersion}`);
  const { chromium } = await import("playwright");
  await access(chromium.executablePath());
  console.log(`PASS Playwright ${packageVersion} pinned Chromium is installed.`);
} catch (error) {
  console.error(`FAIL pinned Playwright Chromium unavailable: ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
}

try {
  const codex = await runCodexPreflight();
  console.log("PASS model API key and access-token environment variables are absent.");
  console.log(`PASS codex-cli ${codex.cliVersion}`);
  console.log("PASS Codex CLI is authenticated through ChatGPT subscription.");
} catch (error) {
  const code = error instanceof ModelAdapterError ? error.code : "MODEL_CLI_NOT_FOUND";
  console.error(`FAIL subscription-backed Codex preflight: ${code}.`);
  failed = true;
}

const docker = spawnSync("docker", ["info"], { encoding: "utf8", shell: process.platform === "win32" });
if (docker.status === 0) {
  console.log("PASS Docker engine is available for a future isolated repair sandbox.");
} else {
  console.warn("WARN Docker engine is unavailable; future real repair execution must remain disabled.");
}

console.log("INFO Milestones 2–4 prerequisites and subscription-backed Codex access checked; Docker isolation remains a future repair-loop gate.");
if (failed) process.exitCode = 1;
