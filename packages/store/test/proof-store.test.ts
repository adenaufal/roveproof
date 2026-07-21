import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	M5_INSPECTED_IMAGE,
	M5_MONONYM_ASSERTION_FRAGMENT,
	M5_MONONYM_ASSERTION_ID,
	M5_TEST_COMMAND_ARGV_DIGEST,
	M5_TEST_COMMAND_ID,
	SandboxCommandEvidenceSchema,
	SandboxResultSchema,
	SourceSnapshotSchema,
	TestFailureProofSchema,
} from "@roveproof/contracts";
import {
	createSandboxControl,
	parseTestAuthoringDiff,
} from "@roveproof/sandbox";
import { FileControlStore } from "../src/index.js";

const roots: string[] = [];
const target = "apps/target/test/repair-mononym.test.mjs";
const baseContent = 'import assert from "node:assert/strict";\nvoid assert;\n';
const testDiffText = `--- a/${target}\n+++ b/${target}\n@@ -1,2 +1,5 @@\n import assert from "node:assert/strict";\n+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {\n+  assert.equal(validateBaselineLegalName("Sari").valid, true);\n+});\n void assert;\n`;
const alternateDiffText = `--- a/${target}\n+++ b/${target}\n@@ -2,1 +2,4 @@\n void assert;\n+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {\n+  assert.equal(validateBaselineLegalName("Sari").valid, true);\n+});\n`;
const hash = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
	Array.isArray(value)
		? `[${value.map(canonical).join(",")}]`
		: value !== null && typeof value === "object"
			? `{${Object.keys(value as object)
					.sort()
					.map(
						(key) =>
							`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
					)
					.join(",")}}`
			: JSON.stringify(value);

function snapshotFor(): ReturnType<typeof SourceSnapshotSchema.parse> {
	const file = {
		path: target,
		size: Buffer.byteLength(baseContent),
		sha256: hash(baseContent),
	};
	const base = {
		schemaVersion: 1 as const,
		recordVersion: "source-snapshot-v1" as const,
		sourceRevision: `sha256:${"e".repeat(64)}`,
		projectionRevision: "d".repeat(64),
		toolingRevision: "e".repeat(64),
		toolingFiles: [file],
		baselineRunId: "run-proof-store",
		expectedIndexHash: "b".repeat(64),
		expectedRootHash: "c".repeat(64),
		analysisId: "analysis-proof-store",
		expectedAnalysisHash: "a".repeat(64),
		files: [file],
	};
	return SourceSnapshotSchema.parse({
		...base,
		snapshotHash: hash(canonical(base)),
	});
}

function records(
	snapshot: ReturnType<typeof snapshotFor>,
	diffText = testDiffText,
) {
	const parsed = parseTestAuthoringDiff({
		schemaVersion: 1,
		operation: "test-only",
		unifiedDiff: diffText,
	});
	const control = createSandboxControl({
		stage: "test-proof",
		snapshot,
		testDiff: parsed,
	});
	const resultBase = {
		schemaVersion: 1 as const,
		recordVersion: "sandbox-result-v1" as const,
		stage: "test-proof" as const,
		commandId: M5_TEST_COMMAND_ID,
		controlHash: control.controlHash,
		started: true,
		exitCode: 1,
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
		stdoutSha256: hash("stdout"),
		stderrSha256: hash("stderr"),
		appliedDiffHash: parsed.diffHash,
		matchedExpectedFailure: true,
		observedFailureHash: hash("failure"),
	};
	const result = SandboxResultSchema.parse({
		...resultBase,
		resultHash: hash(canonical(resultBase)),
	});
	const evidenceBase = {
		schemaVersion: 1 as const,
		recordVersion: "sandbox-command-v1" as const,
		stage: "test-proof" as const,
		commandId: M5_TEST_COMMAND_ID,
		classification: "EXPECTED_FAILURE" as const,
		argvDigest: M5_TEST_COMMAND_ARGV_DIGEST,
		image: M5_INSPECTED_IMAGE,
		network: "none" as const,
		readOnlyRoot: true as const,
		pullPolicy: "never" as const,
		capabilitiesDropped: "ALL" as const,
		noNewPrivileges: true as const,
		pidsLimit: 128,
		memoryLimit: "2g",
		cpuLimit: "2",
		timeoutMs: 120_000,
		started: true,
		exitCode: 1,
		signal: null,
		timedOut: false,
		outputLimitExceeded: false,
		resourceLimitExceeded: false,
		setupError: null,
		protocolError: null,
		patchApplyError: null,
		secretDetected: false,
		infrastructureError: null,
		exportViolation: null,
		stdoutSha256: result.stdoutSha256,
		stderrSha256: result.stderrSha256,
		toolingRevision: snapshot.toolingRevision,
		controlHash: control.controlHash,
		resultHash: result.resultHash,
		durationMs: 1,
		exportedFiles: [],
	};
	const evidence = SandboxCommandEvidenceSchema.parse({
		...evidenceBase,
		evidenceHash: hash(canonical(evidenceBase)),
	});
	const proofBase = {
		schemaVersion: 1 as const,
		recordVersion: "test-failure-proof-v1" as const,
		baselineRunId: snapshot.baselineRunId,
		sourceSnapshotHash: snapshot.snapshotHash,
		testDiffHash: parsed.diffHash,
		sourceRevision: snapshot.sourceRevision,
		toolingRevision: snapshot.toolingRevision,
		commandId: M5_TEST_COMMAND_ID,
		argvDigest: M5_TEST_COMMAND_ARGV_DIGEST,
		controlHash: control.controlHash,
		sandboxResultHash: result.resultHash,
		sandboxEvidenceHash: evidence.evidenceHash,
		exitCode: 1 as const,
		signal: null,
		classification: "EXPECTED_FAILURE" as const,
		expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME" as const,
		assertionId: M5_MONONYM_ASSERTION_ID,
		assertionFragment: M5_MONONYM_ASSERTION_FRAGMENT,
		observedFailureHash: result.observedFailureHash!,
	};
	const proof = TestFailureProofSchema.parse({
		...proofBase,
		proofHash: hash(canonical(proofBase)),
	});
	return { parsed, control, result, evidence, proof };
}

function publishInput(
	snapshot: ReturnType<typeof snapshotFor>,
	value = records(snapshot),
) {
	return {
		proof: value.proof,
		snapshot,
		testDiffBytes: value.parsed.canonicalBytes,
		sandboxControl: value.control,
		sandboxEvidence: value.evidence,
		sandboxResult: value.result,
	};
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("immutable test-failure proof store", () => {
	it("round-trips once, rejects collisions, and detects tampering", async () => {
		const root = await mkdtemp(
			path.join(os.tmpdir(), "roveproof-proof-store-"),
		);
		roots.push(root);
		const store = new FileControlStore(root);
		const snapshot = snapshotFor();
		await store.writeSourceSnapshot(snapshot);
		const value = records(snapshot);
		const key = await store.publishTestFailureProof(
			publishInput(snapshot, value),
		);
		await expect(store.readTestFailureProof(key)).resolves.toEqual(value.proof);
		// Re-publishing the same immutable proof is idempotent (content-addressed write-once).
		const reKey = await store.publishTestFailureProof(
			publishInput(snapshot, value),
		);
		expect(reKey).toBe(key);
		await expect(store.readTestFailureProof(key)).resolves.toEqual(value.proof);

		const diffPath = path.join(root, "test-failure-proofs", `${key}.diff`);
		await chmod(diffPath, 0o600);
		await writeFile(diffPath, "tampered", "utf8");
		await expect(store.readTestFailureProof(key)).rejects.toThrow(
			/diff hash|invalid|unified diff/i,
		);
		await writeFile(diffPath, value.parsed.canonicalBytes);
		await chmod(diffPath, 0o400);

		const filePath = path.join(root, "test-failure-proofs", `${key}.json`);
		await chmod(filePath, 0o600);
		const envelope = JSON.parse(await readFile(filePath, "utf8")) as {
			record: { observedFailureHash: string };
		};
		envelope.record.observedFailureHash = "f".repeat(64);
		await writeFile(filePath, `${JSON.stringify(envelope)}\n`, "utf8");
		await expect(store.readTestFailureProof(key)).rejects.toThrow(
			/hash|invalid/i,
		);
	});

	it("uses distinct immutable keys for distinct diff bindings", async () => {
		const root = await mkdtemp(
			path.join(os.tmpdir(), "roveproof-proof-collision-"),
		);
		roots.push(root);
		const store = new FileControlStore(root);
		const snapshot = snapshotFor();
		await store.writeSourceSnapshot(snapshot);
		const firstValue = records(snapshot);
		const first = await store.publishTestFailureProof(
			publishInput(snapshot, firstValue),
		);
		const secondValue = records(snapshot, alternateDiffText);
		const second = await store.publishTestFailureProof(
			publishInput(snapshot, secondValue),
		);
		expect(second).not.toBe(first);
	});
});
