// In-container M6 verifier entrypoint. Runs inside the roveproof-verifier image
// (Linux Node + Chromium for Playwright 1.61.1). It receives the candidate control
// on stdin, re-applies the persisted combined diff in-place to the image's
// apps/target, runs the verifier-owned tests, builds and starts the patched
// target, runs the original Indonesia Mobile journey under the frozen profile,
// reads the durable order store, and writes a bounded verification summary (plus
// the full evidence bundle) to /export. No candidate code is applied or executed
// on the host; this script is verifier-owned and trusted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const REPO = "/roveproof";
const TARGET = path.join(REPO, "apps", "target");
const EXPORT = "/export";
const ORDERS = "/work/orders";
const PORT = 3101;
const TARGET_URL = `http://127.0.0.1:${PORT}/checkout`;
const MAX_OUTPUT = 8 * 1024 * 1024;

const sha256 = (v) => createHash("sha256").update(v).digest("hex");

async function readControl() {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk.toString("utf8");
		if (Buffer.byteLength(input, "utf8") > 3 * 1024 * 1024)
			throw new Error("control input exceeds limit");
	}
	const c = JSON.parse(input);
	assert.equal(c?.schemaVersion, 1);
	assert.ok(typeof c.candidateId === "string");
	assert.ok(typeof c.baselineRunId === "string");
	assert.ok(typeof c.verificationRunId === "string");
	assert.ok(typeof c.sourceRevision === "string");
	assert.ok(typeof c.combinedDiffBase64 === "string");
	assert.ok(typeof c.combinedDiffHash === "string");
	assert.equal(
		sha256(Buffer.from(c.combinedDiffBase64, "base64")),
		c.combinedDiffHash,
	);
	return c;
}

function safeRelative(value) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\\") ||
		value.startsWith("/") ||
		/^[A-Za-z]:/.test(value)
	)
		throw new Error("unsafe relative path");
	const parts = value.split("/");
	if (
		parts.some(
			(p) =>
				!p ||
				p === "." ||
				p === ".." ||
				p.endsWith(".") ||
				!/^[a-z0-9][a-z0-9._-]*$/.test(p),
		)
	)
		throw new Error("unsafe relative path");
	return value;
}

function parseDiff(bytes) {
	const text = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
	const lines = text.split("\n");
	const files = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (!line || line.startsWith("diff --git ") || line.startsWith("index ")) {
			index += 1;
			continue;
		}
		if (!line.startsWith("--- ")) throw new Error("diff header missing");
		const oldPath = safeRelative(line.slice(6).replace(/^a\//, ""));
		index += 1;
		if (!lines[index]?.startsWith("+++ "))
			throw new Error("diff new header missing");
		const newPath = safeRelative(lines[index].slice(6).replace(/^b\//, ""));
		if (oldPath !== newPath) throw new Error("cross-path diff");
		index += 1;
		const hunks = [];
		while (
			index < lines.length &&
			!lines[index].startsWith("--- ") &&
			!lines[index].startsWith("diff --git ")
		) {
			if (lines[index] === "") {
				index += 1;
				continue;
			}
			const header =
				/^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/.exec(
					lines[index],
				);
			if (!header) throw new Error("hunk header missing");
			const hunk = {
				oldStart: Number(header[1]),
				oldCount: Number(header[2] ?? 1),
				newStart: Number(header[3]),
				newCount: Number(header[4] ?? 1),
				lines: [],
			};
			index += 1;
			let oldConsumed = 0;
			let newConsumed = 0;
			while (
				index < lines.length &&
				!lines[index].startsWith("@@") &&
				!lines[index].startsWith("--- ") &&
				!lines[index].startsWith("diff --git ")
			) {
				const patch = lines[index];
				if (patch === "") break;
				if (!/^[ +\\-]/.test(patch) || patch.startsWith("\\ No newline"))
					throw new Error("invalid hunk line");
				hunk.lines.push(patch);
				if (!patch.startsWith("+")) oldConsumed += 1;
				if (!patch.startsWith("-")) newConsumed += 1;
				index += 1;
			}
			hunk.oldCount = oldConsumed;
			hunk.newCount = newConsumed;
			hunks.push(hunk);
		}
		if (hunks.length === 0) throw new Error("diff contains no hunks");
		files.push({ path: oldPath, hunks });
	}
	if (files.length === 0) throw new Error("empty diff");
	return files;
}

async function applyDiff(bytes, root) {
	const files = parseDiff(bytes);
	for (const file of files) {
		const destination = path.join(root, ...file.path.split("/"));
		const original = (await readFile(destination)).toString("utf8");
		const lines = original.split("\n");
		const output = [];
		let cursor = 0;
		for (const hunk of file.hunks) {
			const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
			if (start < cursor || start > lines.length)
				throw new Error(`hunk start outside file: ${file.path}`);
			output.push(...lines.slice(cursor, start));
			let source = start;
			for (const patch of hunk.lines) {
				const marker = patch[0];
				const content = patch.slice(1);
				if (marker === "+") output.push(content);
				else if (marker === " " || marker === "-") {
					if (lines[source] !== content)
						throw new Error(`hunk context mismatch: ${file.path}`);
					if (marker === " ") output.push(lines[source]);
					source += 1;
				}
			}
			cursor = source;
		}
		output.push(...lines.slice(cursor));
		await writeFile(destination, output.join("\n"));
	}
}

function runSync(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, {
		encoding: "buffer",
		maxBuffer: MAX_OUTPUT,
		windowsHide: true,
		...opts,
	});
	return r;
}

async function readOrderStore() {
	const dir = path.join(ORDERS, "synthetic-orders");
	try {
		const ents = await readdir(dir);
		const orders = [];
		for (const e of ents) {
			try {
				orders.push(JSON.parse(await readFile(path.join(dir, e), "utf8")));
			} catch {}
		}
		// The journey runner's orderIdProvider contract returns the single durable orderId
		// string (or null). A clean verification requires exactly one persisted order.
		return orders.length === 1 ? (orders[0].orderId ?? null) : null;
	} catch {
		return null;
	}
}

async function main() {
	await mkdir(EXPORT, { recursive: true, mode: 0o700 });
	await mkdir(ORDERS, { recursive: true, mode: 0o700 });
	const summary = {
		schemaVersion: 1,
		candidateId: null,
		unitVerdict: "INCONCLUSIVE",
		journeyVerdict: "INCONCLUSIVE",
		transferredBytes: 0,
		durationMs: 0,
		orderId: null,
		durableOrderCount: 0,
		budgetPassed: false,
		verificationRunId: null,
		evidenceDir: null,
		error: null,
	};
	let server = null;
	try {
		const control = await readControl();
		summary.candidateId = control.candidateId;
		summary.verificationRunId = control.verificationRunId;

		// 1. Re-apply the persisted combined diff in-place to the image target.
		await applyDiff(Buffer.from(control.combinedDiffBase64, "base64"), REPO);

		// 2. Run the verifier-owned tests (regression + invariants) against the patched target.
		const test = runSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--test",
				"apps/target/test/repair-mononym.test.mjs",
				"apps/target/test/repair-mononym-invariants.test.mjs",
			],
			{ cwd: REPO },
		);
		summary.unitVerdict = test.status === 0 ? "PASS" : "FAIL";

		// 3. Build the patched target in-container.
		const nextBin = path.join(
			REPO,
			"node_modules",
			"next",
			"dist",
			"bin",
			"next",
		);
		const build = runSync(process.execPath, [nextBin, "build"], {
			cwd: TARGET,
			env: { ...process.env, ROVEPROOF_DATA_DIR: ORDERS },
			timeout: 180_000,
		});
		if (build.status !== 0)
			throw new Error(`next build failed (exit ${build.status})`);

		// 4. Start the patched target on loopback.
		server = spawn(
			process.execPath,
			[nextBin, "start", "--port", String(PORT)],
			{
				cwd: TARGET,
				env: { ...process.env, ROVEPROOF_DATA_DIR: ORDERS },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		const serverLogs = [];
		for (const s of [server.stdout, server.stderr])
			s?.on("data", (c) => {
				serverLogs.push(String(c));
				if (serverLogs.length > 80) serverLogs.shift();
			});
		const ready = await new Promise((resolve) => {
			const deadline = Date.now() + 60_000;
			const tick = async () => {
				if (server.exitCode !== null) return resolve(false);
				if (Date.now() > deadline) return resolve(false);
				try {
					const res = await fetch(`http://127.0.0.1:${PORT}/api/runner-probe`, {
						signal: AbortSignal.timeout(2_000),
					});
					if (res.ok) {
						await res.body?.cancel();
						return resolve(true);
					}
				} catch {}
				setTimeout(tick, 250);
			};
			tick();
		});
		if (!ready) throw new Error("patched target did not become ready");

		// 5. Run the original Indonesia Mobile journey under the frozen profile (verification mode).
		const { runBaseline } = await import(
			path.join(REPO, "packages", "journey", "dist", "runner.js")
		);
		const { computeTargetSourceRevision } = await import(
			path.join(REPO, "packages", "journey", "dist", "source-revision.js")
		);
		const sourceRevision = await computeTargetSourceRevision(REPO);
		const run = await runBaseline({
			artifactRoot: EXPORT,
			targetUrl: TARGET_URL,
			sourceRevision,
			runId: control.verificationRunId,
			headless: true,
			kind: "verification",
			candidateDiffHash: control.combinedDiffHash,
			orderIdProvider: readOrderStore,
		});
		const result = run.bundle.result;
		const manifest = run.bundle.manifest;
		summary.journeyVerdict = result.verdict;
		summary.transferredBytes = result.performance.transferredBytes;
		summary.durationMs = result.task.durationMs;
		summary.orderId = result.task.orderId;
		summary.durableOrderCount = result.task.durableOrderCount;
		summary.budgetPassed =
			result.performance.transferredBytes <= 2_000_000 &&
			result.task.durationMs <= 8_000;
		summary.evidenceDir = `runs/${control.verificationRunId}`;
		summary.profileVerified = manifest.runtime.profileVerified;
		void manifest;
	} catch (error) {
		summary.error = (
			error instanceof Error ? error.message : String(error)
		).slice(0, 400);
	} finally {
		if (server && server.exitCode === null) {
			try {
				server.kill("SIGTERM");
				await new Promise((r) => setTimeout(r, 1_000));
				if (server.exitCode === null) server.kill("SIGKILL");
			} catch {}
		}
		const tmp = path.join(EXPORT, `.summary-${process.pid}.tmp`);
		await writeFile(tmp, `${JSON.stringify(summary)}\n`, {
			flag: "w",
			mode: 0o600,
		});
		const { rename } = await import("node:fs/promises");
		await rename(tmp, path.join(EXPORT, "verification-summary.json"));
	}
}

await main();
