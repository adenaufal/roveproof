import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	FileControlStore,
	resolveArtifactRoot,
} from "../packages/store/dist/index.js";

const repositoryRoot = path.dirname(
	path.dirname(fileURLToPath(import.meta.url)),
);
const candidateId = "candidate-2444cfb0-6b29-4fc7-97dd-480fbdfe1af2";
const store = new FileControlStore(resolveArtifactRoot(repositoryRoot));
await store.initialize();
const env = await store.readCandidateEnvelope(candidateId, {
	requireTerminalStatus: true,
});
const combinedBytes = await readFile(
	path.join(
		store.artifactRoot,
		"candidates",
		candidateId,
		env.combinedDiffArtifact.artifactPath,
	),
);
const control = {
	schemaVersion: 1,
	candidateId,
	baselineRunId: env.baselineRunId,
	verificationRunId: "run-verify-debug-001",
	sourceRevision: env.sourceRevision,
	combinedDiffBase64: combinedBytes.toString("base64"),
	combinedDiffHash: env.combinedDiffHash,
};

const exportDir = await mkdtemp(path.join(os.tmpdir(), "roveproof-vdebug-"));
const args = [
	"run",
	"--rm",
	"--interactive",
	"--network",
	"none",
	"--cap-drop",
	"ALL",
	"--security-opt=no-new-privileges",
	"--pids-limit",
	"256",
	"--memory",
	"4g",
	"--cpus",
	"2",
	"--stop-timeout",
	"30",
	"--mount",
	`type=bind,src=${path.join(repositoryRoot, "packages", "contracts", "dist")},dst=/roveproof/packages/contracts/dist,readonly`,
	"--mount",
	`type=bind,src=${path.join(repositoryRoot, "packages", "evidence", "dist")},dst=/roveproof/packages/evidence/dist,readonly`,
	"--mount",
	`type=bind,src=${path.join(repositoryRoot, "packages", "journey", "dist")},dst=/roveproof/packages/journey/dist,readonly`,
	"--mount",
	`type=bind,src=${path.join(repositoryRoot, "scripts", "roveproof-verifier-runner.mjs")},dst=/roveproof/scripts/roveproof-verifier-runner.mjs,readonly`,
	"--mount",
	`type=bind,src=${exportDir},dst=/export`,
	"--tmpfs",
	"/work:rw,nosuid,nodev,size=256m",
	"--env",
	"HOME=/tmp",
	"--env",
	"PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
	"--entrypoint",
	"node",
	"roveproof-verifier:local",
	"/roveproof/scripts/roveproof-verifier-runner.mjs",
];
console.log("running verifier image...");
const r = spawnSync("docker", args, {
	encoding: "utf8",
	shell: process.platform === "win32",
	input: JSON.stringify(control),
	timeout: 600_000,
	maxBuffer: 16 * 1024 * 1024,
});
console.log("DOCKER_EXIT=" + r.status);
console.log(
	"STDOUT(" +
		(r.stdout?.length ?? 0) +
		")=\n" +
		(r.stdout || "").slice(0, 1500),
);
console.log(
	"STDERR(" +
		(r.stderr?.length ?? 0) +
		")=\n" +
		(r.stderr || "").slice(0, 2500),
);
console.log("--- export dir ---");
try {
	for (const e of await readdir(exportDir)) {
		const p = path.join(exportDir, e);
		const st = await stat(p);
		console.log(e + " " + (st.isDirectory() ? "DIR" : st.size + "B"));
		if (e === "verification-summary.json")
			console.log("SUMMARY=" + (await readFile(p, "utf8")).slice(0, 800));
	}
} catch (e) {
	console.log("export read err: " + e.message);
}
await rm(exportDir, { recursive: true, force: true }).catch(() => {});
