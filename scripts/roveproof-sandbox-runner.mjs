import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const INPUT = "/input";
const WORK = "/work/tree";
const EXPORT = "/export";
const TEST_TARGET = "apps/target/test/repair-mononym.test.mjs";
const BASELINE_ORACLE_TARGET =
	"apps/target/test/repair-mononym-baseline-oracle.test.mjs";
const INVARIANT_TARGET = "apps/target/test/repair-mononym-invariants.test.mjs";
const TEST_COMMAND = [
	"node",
	"--experimental-strip-types",
	"--test",
	TEST_TARGET,
	BASELINE_ORACLE_TARGET,
];
const COMBINED_COMMAND = [
	"node",
	"--experimental-strip-types",
	"--test",
	TEST_TARGET,
	INVARIANT_TARGET,
];
const SEED_ID = "ID-MONONYM-REQUIRED-LAST-NAME";
const ASSERTION_ID = "seed.mononym-required-last-name";
const ASSERTION_FRAGMENT = "required last name";
const MAX_OUTPUT = 8 * 1024 * 1024;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
function resultHash(result) {
	const withoutHash = { ...result };
	delete withoutHash.resultHash;
	return sha256(canonical(withoutHash));
}
function emptyResult(
	controlHash,
	stage = "test-proof",
	commandId = "test-regression",
) {
	return {
		schemaVersion: 1,
		recordVersion: "sandbox-result-v1",
		stage,
		commandId,
		controlHash,
		started: false,
		exitCode: null,
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
		stdoutSha256: sha256(Buffer.alloc(0)),
		stderrSha256: sha256(Buffer.alloc(0)),
		appliedDiffHash: null,
		matchedExpectedFailure: false,
		observedFailureHash: null,
		resultHash: "0".repeat(64),
	};
}
async function emit(result) {
	const withHash = { ...result, resultHash: resultHash(result) };
	await mkdir(EXPORT, { recursive: true, mode: 0o700 });
	const temporary = path.join(EXPORT, `.result-${process.pid}.tmp`);
	await writeFile(temporary, `${JSON.stringify(withHash)}\n`, {
		flag: "w",
		mode: 0o600,
	});
	await rename(temporary, path.join(EXPORT, "result.json"));
}
async function readControl() {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk.toString("utf8");
		if (Buffer.byteLength(input, "utf8") > 3 * 1024 * 1024)
			throw new Error("control input exceeds limit");
	}
	const control = JSON.parse(input);
	assert.equal(control?.schemaVersion, 1);
	assert.equal(control?.recordVersion, "sandbox-control-v1");
	assert.ok(control.stage === "test-proof" || control.stage === "combined");
	assert.ok(
		control.commandId === "test-regression" ||
			control.commandId === "candidate-check",
	);
	const withoutHash = { ...control };
	delete withoutHash.controlHash;
	assert.equal(sha256(canonical(withoutHash)), control.controlHash);
	assert.equal(
		sha256(Buffer.from(control.testDiffBase64, "base64")),
		control.testDiffHash,
	);
	if (control.stage === "test-proof") {
		assert.equal(control.commandId, "test-regression");
		assert.ok(
			control.snapshotFiles.some(
				({ path: filePath }) => filePath === BASELINE_ORACLE_TARGET,
			),
		);
		assert.equal(control.sourceDiffBase64, null);
		assert.equal(control.combinedDiffBase64, null);
	} else {
		assert.equal(control.commandId, "candidate-check");
		assert.ok(
			control.snapshotFiles.some(
				({ path: filePath }) => filePath === INVARIANT_TARGET,
			),
		);
		assert.equal(typeof control.sourceDiffBase64, "string");
		assert.equal(typeof control.combinedDiffBase64, "string");
		assert.equal(
			sha256(Buffer.from(control.sourceDiffBase64, "base64")),
			control.sourceDiffHash,
		);
		assert.equal(
			sha256(Buffer.from(control.combinedDiffBase64, "base64")),
			control.combinedDiffHash,
		);
	}
	assert.equal(typeof control.toolingRevision, "string");
	assert.equal(control.expectedSeedId, SEED_ID);
	assert.equal(control.assertionId, ASSERTION_ID);
	assert.equal(control.assertionFragment, ASSERTION_FRAGMENT);
	return control;
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
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				part.endsWith(".") ||
				part.endsWith(" ") ||
				!/^[a-z0-9][a-z0-9._-]*$/.test(part),
		)
	)
		throw new Error("unsafe relative path");
	return value;
}
async function walk(root, relative = "") {
	const directory = path.join(root, ...(relative ? relative.split("/") : []));
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		safeRelative(child);
		const full = path.join(root, ...child.split("/"));
		if (entry.isSymbolicLink()) throw new Error(`symlink: ${child}`);
		if (entry.isDirectory()) files.push(...(await walk(root, child)));
		else if (entry.isFile()) {
			const metadata = await lstat(full);
			if (metadata.nlink > 1) throw new Error(`hardlink: ${child}`);
			const bytes = await readFile(full);
			files.push({
				path: child,
				size: bytes.byteLength,
				sha256: sha256(bytes),
			});
		} else throw new Error(`special file: ${child}`);
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}
async function copyTree(source, target, relative = "") {
	const sourceDirectory = path.join(
		source,
		...(relative ? relative.split("/") : []),
	);
	const entries = await readdir(sourceDirectory, { withFileTypes: true });
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		safeRelative(child);
		const from = path.join(source, ...child.split("/"));
		const to = path.join(target, ...child.split("/"));
		if (entry.isSymbolicLink()) throw new Error(`symlink: ${child}`);
		if (entry.isDirectory()) {
			await mkdir(to, { recursive: true, mode: 0o700 });
			await copyTree(source, target, child);
		} else if (entry.isFile()) {
			const metadata = await lstat(from);
			if (metadata.nlink > 1) throw new Error(`hardlink: ${child}`);
			await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
			await writeFile(to, await readFile(from), { flag: "wx", mode: 0o600 });
		} else throw new Error(`special file: ${child}`);
	}
}
async function verifyAndCopyInput(control) {
	const actual = await walk(INPUT);
	const expected = [...control.snapshotFiles].sort((left, right) =>
		left.path.localeCompare(right.path),
	);
	assert.deepEqual(actual, expected);
	await rm(WORK, { recursive: true, force: true });
	await mkdir(WORK, { recursive: true, mode: 0o700 });
	await copyTree(INPUT, WORK);
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
			// Recompute the hunk counts from the actual lines; the header counts are
			// advisory. applyDiff uses oldStart plus the lines, so authoritative counts
			// keep the result self-consistent for a model that miscounts its header.
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
async function applyDiff(bytes) {
	const files = parseDiff(bytes);
	for (const file of files) {
		const destination = path.join(WORK, ...file.path.split("/"));
		const metadata = await lstat(destination);
		if (!metadata.isFile() || metadata.isSymbolicLink())
			throw new Error(`patch target is not regular: ${file.path}`);
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
		const temporary = `${destination}.${process.pid}.patch`;
		await writeFile(temporary, output.join("\n"), { flag: "wx", mode: 0o600 });
		await rename(temporary, destination);
	}
}
function commandFor(control) {
	const argv = control.stage === "test-proof" ? TEST_COMMAND : COMBINED_COMMAND;
	assert.equal(argv[0], "node");
	return argv;
}
async function main() {
	let control;
	try {
		control = await readControl();
	} catch (error) {
		const result = emptyResult("0".repeat(64));
		result.protocolError = "CONTROL_INVALID";
		await emit(result);
		return;
	}
	const result = emptyResult(
		control.controlHash,
		control.stage,
		control.commandId,
	);
	try {
		await verifyAndCopyInput(control);
		await applyDiff(Buffer.from(control.testDiffBase64, "base64"));
		if (control.stage === "combined") {
			await applyDiff(Buffer.from(control.sourceDiffBase64, "base64"));
			if (
				sha256(
					Buffer.concat([
						Buffer.from(control.testDiffBase64, "base64"),
						Buffer.from("\n"),
						Buffer.from(control.sourceDiffBase64, "base64"),
					]),
				) !== control.combinedDiffHash
			)
				throw new Error("combined bytes do not match control");
		}
		result.appliedDiffHash =
			control.stage === "test-proof"
				? control.testDiffHash
				: control.combinedDiffHash;
		const command = commandFor(control);
		const child = spawnSync(process.execPath, command.slice(1), {
			cwd: WORK,
			env: {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				HOME: "/home/roveproof",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				NODE_OPTIONS: "",
			},
			encoding: "buffer",
			timeout: 120_000,
			maxBuffer: MAX_OUTPUT,
			windowsHide: true,
		});
		const stdout = Buffer.isBuffer(child.stdout)
			? child.stdout
			: Buffer.from(child.stdout ?? "");
		const stderr = Buffer.isBuffer(child.stderr)
			? child.stderr
			: Buffer.from(child.stderr ?? "");
		const output = Buffer.concat([stdout, stderr]);
		result.started = true;
		result.exitCode = typeof child.status === "number" ? child.status : null;
		result.signal = child.signal ?? null;
		result.timedOut = Boolean(child.error?.code === "ETIMEDOUT");
		result.resourceLimitExceeded = result.exitCode === 137;
		result.outputLimitExceeded =
			Boolean(child.error?.code === "ENOBUFS") ||
			output.byteLength > MAX_OUTPUT;
		result.setupError =
			/ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find package|Unknown file extension|Test runner failed/i.test(
				output.toString("utf8"),
			)
				? "TEST_SETUP_OR_PROTOCOL_FAILURE"
				: null;
		result.stdoutSha256 = sha256(stdout);
		result.stderrSha256 = sha256(stderr);
		result.observedFailureHash = result.exitCode === 1 ? sha256(output) : null;
		const text = output.toString("utf8");
		const generatedName = `${SEED_ID} ${ASSERTION_ID}: ${ASSERTION_FRAGMENT}`;
		const generatedFailed = new RegExp(
			`(?:^|\\n)not ok \\d+ - ${generatedName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:\\n|$)`,
		).test(text);
		const immutableOraclePassed =
			/(?:^|\n)ok \d+ - roveproof\.verifier\.baseline-mononym-defect(?:\n|$)/.test(
				text,
			);
		result.matchedExpectedFailure =
			result.exitCode === 1 && generatedFailed && immutableOraclePassed;
	} catch (error) {
		result.patchApplyError =
			error instanceof Error
				? error.message.slice(0, 256)
				: "PATCH_APPLY_REJECTED";
	}
	await emit(result);
}

await main();
