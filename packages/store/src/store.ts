import { createHash, randomUUID } from "node:crypto";
import {
	access,
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rm,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import {
	AnalysisAttemptRecordSchema,
	AnalysisReportSchema,
	AuthoringAttemptRecordSchema,
	CandidatePolicyEvidenceSchema,
	M5CandidateEnvelopeSchema,
	RepairStatusRecordSchema,
	SandboxCommandEvidenceSchema,
	SandboxControlSchema,
	SandboxResultSchema,
	SourceSnapshotSchema,
	TestFailureProofSchema,
	ControlIdempotencyKeySchema,
	ControlIdempotencyRecordSchema,
	ControlJobRecordSchema,
	ControlJobViewSchema,
	EntityIdSchema,
	FixtureDashboardSnapshotSchema,
	isTerminalRunState,
	JOURNEY_ID,
	LatestJobPointerSchema,
	M5_CANDIDATE_COMMAND_ARGV_DIGEST,
	M5_CANDIDATE_COMMAND_ID,
	M5_TEST_COMMAND_ARGV_DIGEST,
	M5_TEST_COMMAND_ID,
	PROFILE_ID,
	RunEventSchema,
	RunOriginSchema,
	SCHEMA_VERSION,
	SEED_IDS,
	TARGET_ID,
	validateStateTransitionForOrigin,
	validateApprovalForCandidate,
	CandidateRecordSchema,
	ApprovalDecisionSchema,
	VerificationReportSchema,
	type AnalysisAttemptRecord,
	type AnalysisReport,
	type AuthoringAttemptRecord,
	type M5CandidateEnvelope,
	type RepairStatusRecord,
	type SandboxCommandEvidence,
	type SandboxControl,
	type SandboxResult,
	type SourceSnapshot,
	type TestFailureProof,
	type ControlJobRecord,
	type ControlJobView,
	type FixtureDashboardSnapshot,
	type RunEvent,
	type RunState,
	type CandidateRecord,
	type ApprovalDecision,
	type VerificationReport,
} from "@roveproof/contracts";
import { combineAuthoringDiffs, parseUnifiedDiff } from "@roveproof/sandbox";

const JSON_MODE = 0o600;

type RootIdentity = Readonly<{
	canonicalPath: string;
	dev: number | bigint;
	ino: number | bigint;
}>;
const trustedRootIdentities = new Map<string, RootIdentity>();

export class ActiveJobConflictError extends Error {
	readonly jobId: string;

	constructor(jobId: string) {
		super(`Control job ${jobId} is still active`);
		this.name = "ActiveJobConflictError";
		this.jobId = jobId;
	}
}

export class StoreBusyError extends Error {
	constructor(message = "The control store is busy") {
		super(message);
		this.name = "StoreBusyError";
	}
}

export class JobNotFoundError extends Error {
	constructor(jobId: string) {
		super(`Control job not found: ${jobId}`);
		this.name = "JobNotFoundError";
	}
}

export class AnalysisNotFoundError extends Error {
	constructor(analysisId: string) {
		super(`Analysis not found: ${analysisId}`);
		this.name = "AnalysisNotFoundError";
	}
}

export class CandidateNotFoundError extends Error {
	constructor(candidateId: string) {
		super(`Candidate not found: ${candidateId}`);
		this.name = "CandidateNotFoundError";
	}
}

export class TestFailureProofNotFoundError extends Error {
	constructor(proofKey: string) {
		super(`Test-failure proof not found: ${proofKey}`);
		this.name = "TestFailureProofNotFoundError";
	}
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function recordHash(value: unknown): string {
	return sha256(canonical(value));
}

function testFailureProofKey(
	proof: Pick<
		TestFailureProof,
		"baselineRunId" | "sourceSnapshotHash" | "testDiffHash"
	>,
): string {
	return sha256(
		JSON.stringify([
			proof.baselineRunId,
			proof.sourceSnapshotHash,
			proof.testDiffHash,
		]),
	);
}

function assertCandidateDiffPolicy(
	input: Readonly<{
		testBytes: Uint8Array;
		sourceBytes: Uint8Array;
		combinedBytes: Uint8Array;
		testPolicy: ReturnType<typeof CandidatePolicyEvidenceSchema.parse>;
		sourcePolicy: ReturnType<typeof CandidatePolicyEvidenceSchema.parse>;
	}>,
): void {
	const testDiff = parseUnifiedDiff(input.testBytes, {
		operation: "test-only",
	});
	const sourceDiff = parseUnifiedDiff(input.sourceBytes, {
		operation: "source-only",
	});
	const combined = combineAuthoringDiffs(testDiff, sourceDiff);
	if (!Buffer.from(input.combinedBytes).equals(combined.bytes))
		throw new Error("Combined candidate bytes or budget are invalid");
	const matches = (
		policy: ReturnType<typeof CandidatePolicyEvidenceSchema.parse>,
		parsed: typeof testDiff,
	): boolean =>
		policy.accepted &&
		policy.violations.length === 0 &&
		policy.diffHash === parsed.diffHash &&
		policy.filesChanged === parsed.metadata.files.length &&
		policy.linesAdded === parsed.metadata.additions &&
		policy.linesDeleted === parsed.metadata.deletions &&
		policy.changedLines === parsed.metadata.changedLines;
	if (
		!matches(input.testPolicy, testDiff) ||
		!matches(input.sourcePolicy, sourceDiff)
	)
		throw new Error(
			"Candidate policy metadata does not match canonical diff bytes",
		);
}

function assertSandboxRecordBinding(
	input: Readonly<{
		evidence: SandboxCommandEvidence;
		result: SandboxResult;
		stage: "test-proof" | "combined";
		commandId: typeof M5_TEST_COMMAND_ID | typeof M5_CANDIDATE_COMMAND_ID;
		expectedDiffHash: string;
		toolingRevision: string;
	}>,
): void {
	const { evidence, result } = input;
	const expectedArgvDigest =
		input.commandId === M5_TEST_COMMAND_ID
			? M5_TEST_COMMAND_ARGV_DIGEST
			: M5_CANDIDATE_COMMAND_ARGV_DIGEST;
	const expectedClassification =
		input.stage === "test-proof" ? "EXPECTED_FAILURE" : "CANDIDATE_PASS";
	if (
		evidence.stage !== input.stage ||
		evidence.commandId !== input.commandId ||
		evidence.argvDigest !== expectedArgvDigest ||
		evidence.toolingRevision !== input.toolingRevision
	)
		throw new Error(
			"Sandbox evidence stage/command/tooling binding is invalid",
		);
	if (
		result.stage !== input.stage ||
		result.commandId !== input.commandId ||
		result.controlHash !== evidence.controlHash ||
		result.resultHash !== evidence.resultHash ||
		result.appliedDiffHash !== input.expectedDiffHash
	)
		throw new Error(
			"Sandbox result stage/control/applied-diff binding is invalid",
		);
	if (
		evidence.started !== result.started ||
		evidence.exitCode !== result.exitCode ||
		evidence.signal !== result.signal ||
		evidence.timedOut !== result.timedOut ||
		evidence.outputLimitExceeded !== result.outputLimitExceeded ||
		evidence.resourceLimitExceeded !== result.resourceLimitExceeded ||
		evidence.setupError !== result.setupError ||
		evidence.protocolError !== result.protocolError ||
		evidence.patchApplyError !== result.patchApplyError ||
		evidence.secretDetected !== result.secretDetected ||
		evidence.infrastructureError !== result.infrastructureError ||
		evidence.exportViolation !== result.exportViolation ||
		evidence.stdoutSha256 !== result.stdoutSha256 ||
		evidence.stderrSha256 !== result.stderrSha256
	)
		throw new Error("Sandbox evidence/process flags are inconsistent");
	if (
		evidence.classification !== expectedClassification ||
		!result.started ||
		result.signal !== null ||
		result.timedOut ||
		result.outputLimitExceeded ||
		result.resourceLimitExceeded ||
		result.setupError !== null ||
		result.protocolError !== null ||
		result.patchApplyError !== null ||
		result.secretDetected ||
		result.infrastructureError !== null ||
		result.exportViolation !== null
	)
		throw new Error("Sandbox classification prerequisites are inconsistent");
	if (
		input.stage === "test-proof" &&
		(result.exitCode !== 1 ||
			!result.matchedExpectedFailure ||
			result.observedFailureHash === null)
	)
		throw new Error("Expected-failure result flags are inconsistent");
	if (
		input.stage === "combined" &&
		(result.exitCode !== 0 ||
			result.matchedExpectedFailure ||
			result.observedFailureHash !== null)
	)
		throw new Error("Candidate-pass result flags are inconsistent");
}

type LeaseRecord = Readonly<{
	pid: number;
	ownerToken: string;
	createdAt: string;
}>;

function parseLeaseRecord(value: unknown): LeaseRecord {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Control lease record is malformed");
	const record = value as Record<string, unknown>;
	if (
		!Number.isInteger(record.pid) ||
		Number(record.pid) <= 0 ||
		typeof record.ownerToken !== "string" ||
		!/^[0-9a-f-]{36}$/.test(record.ownerToken) ||
		typeof record.createdAt !== "string" ||
		!Number.isFinite(Date.parse(record.createdAt)) ||
		Object.keys(record).sort().join(",") !== "createdAt,ownerToken,pid"
	) {
		throw new Error("Control lease record is malformed");
	}
	return {
		pid: Number(record.pid),
		ownerToken: record.ownerToken,
		createdAt: record.createdAt,
	};
}

function processIsAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return false;
		return true;
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function comparablePath(value: string): string {
	const normalized = path.normalize(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertContained(root: string, candidate: string): void {
	const relative = path.relative(root, path.resolve(candidate));
	if (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	)
		return;
	throw new Error(`Control store path escapes its trusted root: ${candidate}`);
}

async function inspectRootIdentity(
	artifactRoot: string,
): Promise<RootIdentity> {
	const metadata = await lstat(artifactRoot);
	if (!metadata.isDirectory() || metadata.isSymbolicLink())
		throw new Error("Trusted control root must be a real directory");
	return {
		canonicalPath: await realpath(artifactRoot),
		dev: metadata.dev,
		ino: metadata.ino,
	};
}

function sameRootIdentity(left: RootIdentity, right: RootIdentity): boolean {
	return (
		comparablePath(left.canonicalPath) ===
			comparablePath(right.canonicalPath) &&
		left.dev === right.dev &&
		left.ino === right.ino
	);
}

async function pinOrVerifyTrustedRoot(artifactRoot: string): Promise<void> {
	const key = comparablePath(path.resolve(artifactRoot));
	const observed = await inspectRootIdentity(artifactRoot);
	const trusted = trustedRootIdentities.get(key);
	if (trusted && !sameRootIdentity(trusted, observed))
		throw new Error("Control store trusted root identity changed");
	if (!trusted) trustedRootIdentities.set(key, observed);
}

async function verifyTrustedRoot(artifactRoot: string): Promise<RootIdentity> {
	const key = comparablePath(path.resolve(artifactRoot));
	const trusted = trustedRootIdentities.get(key);
	if (!trusted)
		throw new Error("Control store trusted root has not been initialized");
	const observed = await inspectRootIdentity(artifactRoot);
	if (!sameRootIdentity(trusted, observed))
		throw new Error("Control store trusted root identity changed");
	return trusted;
}

async function ensureRealDirectory(directoryInput: string): Promise<void> {
	const directory = path.resolve(directoryInput);
	const parsed = path.parse(directory);
	let current = parsed.root;
	for (const component of directory
		.slice(parsed.root.length)
		.split(path.sep)
		.filter(Boolean)) {
		current = path.join(/* turbopackIgnore: true */ current, component);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		const metadata = await lstat(current);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error(
				`Control store path must not contain links or non-directories: ${current}`,
			);
		}
		const canonical = await realpath(current);
		if (comparablePath(canonical) !== comparablePath(current)) {
			throw new Error(
				`Control store directory resolves outside its canonical path: ${current}`,
			);
		}
	}
}

async function openVerifiedRegularFile(
	filePath: string,
	flags: string,
	artifactRoot: string,
) {
	assertContained(artifactRoot, filePath);
	const trustedRoot = await verifyTrustedRoot(artifactRoot);
	const handle = await open(filePath, flags, JSON_MODE);
	try {
		const handleMetadata = await handle.stat();
		const pathMetadata = await lstat(filePath);
		if (
			!handleMetadata.isFile() ||
			!pathMetadata.isFile() ||
			pathMetadata.isSymbolicLink()
		) {
			throw new Error(
				`Control store files must be regular non-link files: ${filePath}`,
			);
		}
		if (
			handleMetadata.dev !== pathMetadata.dev ||
			handleMetadata.ino !== pathMetadata.ino
		) {
			throw new Error(
				`Control store file changed while it was being opened: ${filePath}`,
			);
		}
		const [observedRoot, canonicalFile] = await Promise.all([
			verifyTrustedRoot(artifactRoot),
			realpath(filePath),
		]);
		if (!sameRootIdentity(trustedRoot, observedRoot))
			throw new Error(
				"Control store trusted root changed while opening a file",
			);
		assertContained(trustedRoot.canonicalPath, canonicalFile);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function writeExclusive(
	filePath: string,
	value: unknown,
	artifactRoot: string,
): Promise<void> {
	await ensureRealDirectory(path.dirname(filePath));
	const temporaryPath = path.join(
		/* turbopackIgnore: true */ path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.publish`,
	);
	const handle = await openVerifiedRegularFile(
		temporaryPath,
		"wx",
		artifactRoot,
	);
	try {
		await handle.writeFile(json(value), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function writeBytesExclusive(
	filePath: string,
	bytes: Uint8Array,
	artifactRoot: string,
): Promise<void> {
	await ensureRealDirectory(path.dirname(filePath));
	const temporaryPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.publish`,
	);
	const handle = await openVerifiedRegularFile(
		temporaryPath,
		"wx",
		artifactRoot,
	);
	try {
		await handle.writeFile(Buffer.from(bytes));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function readBytes(
	filePath: string,
	artifactRoot: string,
): Promise<Buffer> {
	const handle = await openVerifiedRegularFile(filePath, "r", artifactRoot);
	try {
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function replaceAtomic(
	filePath: string,
	value: unknown,
	artifactRoot: string,
): Promise<void> {
	await ensureRealDirectory(path.dirname(filePath));
	const temporaryPath = path.join(
		/* turbopackIgnore: true */ path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.tmp`,
	);
	const handle = await openVerifiedRegularFile(
		temporaryPath,
		"wx",
		artifactRoot,
	);
	try {
		await handle.writeFile(json(value), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		for (let attempt = 0; ; attempt += 1) {
			try {
				await rename(temporaryPath, filePath);
				break;
			} catch (error) {
				const transientWindowsConflict = ["EACCES", "EBUSY", "EPERM"].includes(
					errorCode(error) ?? "",
				);
				if (!transientWindowsConflict || attempt >= 20) throw error;
				await new Promise((resolve) =>
					setTimeout(resolve, Math.min(25 * (attempt + 1), 250)),
				);
			}
		}
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function readUnknown(
	filePath: string,
	artifactRoot: string,
): Promise<unknown> {
	const handle = await openVerifiedRegularFile(filePath, "r", artifactRoot);
	try {
		return JSON.parse(await handle.readFile("utf8")) as unknown;
	} finally {
		await handle.close();
	}
}

async function readEventsFile(
	filePath: string,
	artifactRoot: string,
): Promise<RunEvent[]> {
	let handle: Awaited<ReturnType<typeof openVerifiedRegularFile>>;
	try {
		handle = await openVerifiedRegularFile(filePath, "r", artifactRoot);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	let input: string;
	try {
		input = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	if (!input) return [];
	const lastNewline = input.lastIndexOf("\n");
	if (!input.endsWith("\n") && lastNewline < 0) return [];
	const completeInput = input.endsWith("\n")
		? input.slice(0, -1)
		: input.slice(0, lastNewline);
	if (!completeInput) return [];
	return completeInput
		.split("\n")
		.map((line) => RunEventSchema.parse(JSON.parse(line) as unknown));
}

async function appendEvent(
	filePath: string,
	event: RunEvent,
	artifactRoot: string,
	exclusive = false,
): Promise<void> {
	await ensureRealDirectory(path.dirname(filePath));
	const handle = await openVerifiedRegularFile(
		filePath,
		exclusive ? "wx" : "r+",
		artifactRoot,
	);
	try {
		const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
		if (exclusive) {
			await handle.writeFile(line);
		} else {
			const existing = await handle.readFile();
			const durableLength =
				existing.at(-1) === 0x0a
					? existing.length
					: existing.lastIndexOf(0x0a) + 1;
			if (durableLength < existing.length) {
				await handle.truncate(durableLength);
				await handle.sync();
			}
			let written = 0;
			while (written < line.length) {
				const result = await handle.write(
					line,
					written,
					line.length - written,
					durableLength + written,
				);
				if (result.bytesWritten === 0)
					throw new Error("Control event append made no forward progress");
				written += result.bytesWritten;
			}
			await handle.truncate(durableLength + line.length);
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export type FixtureJobFactoryInput = Readonly<{
	jobId: string;
	runId: string;
	createdAt: string;
}>;

export type CreateFixtureJobOptions = Readonly<{
	idempotencyKey: string;
	snapshot: (input: FixtureJobFactoryInput) => FixtureDashboardSnapshot;
	now?: () => Date;
	jobId?: string;
	runId?: string;
}>;

export type PublishTestFailureProofInput = Readonly<{
	proof: TestFailureProof;
	snapshot: SourceSnapshot;
	testDiffBytes: Uint8Array;
	sandboxControl: SandboxControl;
	sandboxEvidence: SandboxCommandEvidence;
	sandboxResult: SandboxResult;
}>;

export type PublishCandidateInput = Readonly<{
	envelope: M5CandidateEnvelope;
	snapshot: SourceSnapshot;
	testDiffBytes: Uint8Array;
	sourceDiffBytes: Uint8Array;
	combinedDiffBytes: Uint8Array;
	testControl: SandboxControl;
	combinedControl: SandboxControl;
	testEvidence: SandboxCommandEvidence;
	combinedEvidence: SandboxCommandEvidence;
	testResult: SandboxResult;
	combinedResult: SandboxResult;
}>;

export class FileControlStore {
	readonly artifactRoot: string;

	constructor(artifactRootInput: string) {
		this.artifactRoot = path.resolve(
			/* turbopackIgnore: true */ artifactRootInput,
		);
	}

	async initialize(): Promise<void> {
		await ensureRealDirectory(this.artifactRoot);
		await pinOrVerifyTrustedRoot(this.artifactRoot);
		await Promise.all(
			[
				"jobs",
				"events",
				"origins",
				"snapshots",
				"idempotency",
				"leases",
				"analyses",
				"analysis-attempts",
				"authoring-attempts",
				"source-snapshots",
				"sandbox-controls",
				"sandbox-evidence",
				"sandbox-results",
				"repair-status",
				"test-failure-proofs",
				"candidates",
				"candidate-records",
				"verification-reports",
				"approval-decisions",
			].map((directory) =>
				ensureRealDirectory(
					path.join(/* turbopackIgnore: true */ this.artifactRoot, directory),
				),
			),
		);
	}

	async writeAnalysisAttempt(
		attemptInput: AnalysisAttemptRecord,
	): Promise<void> {
		await this.initialize();
		const attempt = AnalysisAttemptRecordSchema.parse(attemptInput);
		const reportPath = this.#analysisPath(attempt.analysisId);
		if (await exists(reportPath))
			throw new Error(
				"Cannot append an analysis attempt after success publication",
			);
		const filePath = this.#analysisAttemptPath(
			attempt.analysisId,
			attempt.attempt,
		);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(attempt),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
	}

	async readAnalysisAttempt(
		analysisIdInput: string,
		attemptNumberInput: number,
	): Promise<AnalysisAttemptRecord> {
		await this.initialize();
		const analysisId = EntityIdSchema.parse(analysisIdInput);
		const attemptNumber =
			attemptNumberInput === 1 || attemptNumberInput === 2
				? attemptNumberInput
				: null;
		if (attemptNumber === null)
			throw new TypeError("Analysis attempt number must be 1 or 2");
		try {
			return this.#readAnalysisAttemptEnvelope(
				await readUnknown(
					this.#analysisAttemptPath(analysisId, attemptNumber),
					this.artifactRoot,
				),
			);
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new AnalysisNotFoundError(analysisId);
			throw error;
		}
	}

	async writeAnalysis(reportInput: AnalysisReport): Promise<void> {
		await this.initialize();
		const report = AnalysisReportSchema.parse(reportInput);
		const successfulAttempt = await this.readAnalysisAttempt(
			report.analysisId,
			report.retryCount + 1,
		);
		this.#assertAttemptMatchesReport(successfulAttempt, report);
		const filePath = this.#analysisPath(report.analysisId);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(report),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
	}

	async readAnalysis(analysisIdInput: string): Promise<AnalysisReport> {
		await this.initialize();
		const analysisId = EntityIdSchema.parse(analysisIdInput);
		try {
			const report = this.#readAnalysisEnvelope(
				await readUnknown(this.#analysisPath(analysisId), this.artifactRoot),
			);
			if (report.analysisId !== analysisId)
				throw new Error("Stored analysis ID does not match its path");
			const attempt = await this.readAnalysisAttempt(
				analysisId,
				report.retryCount + 1,
			);
			this.#assertAttemptMatchesReport(attempt, report);
			return report;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new AnalysisNotFoundError(analysisId);
			throw error;
		}
	}

	async writeSourceSnapshot(snapshotInput: SourceSnapshot): Promise<string> {
		await this.initialize();
		const snapshot = SourceSnapshotSchema.parse(snapshotInput);
		const withoutHash = { ...snapshot } as Record<string, unknown>;
		delete withoutHash.snapshotHash;
		if (recordHash(withoutHash) !== snapshot.snapshotHash)
			throw new Error("Source snapshot hash is invalid");
		const filePath = this.#sourceSnapshotPath(snapshot.snapshotHash);
		try {
			await writeExclusive(
				filePath,
				this.#hashedEnvelope(snapshot),
				this.artifactRoot,
			);
		} catch (error) {
			// Source snapshots are content-addressed and write-once. Re-writing the
			// same immutable hash is idempotent; a collision with different content is
			// cryptographically impossible and is rejected by the read-back comparison.
			if (
				errorCode(error) !== "EEXIST" ||
				canonical(await this.readSourceSnapshot(snapshot.snapshotHash)) !==
					canonical(snapshot)
			)
				throw error;
		}
		await chmod(filePath, 0o400);
		return snapshot.snapshotHash;
	}

	async readSourceSnapshot(snapshotHashInput: string): Promise<SourceSnapshot> {
		await this.initialize();
		if (!/^[a-f0-9]{64}$/.test(snapshotHashInput))
			throw new TypeError("Source snapshot hash must be a SHA-256 digest");
		try {
			const snapshot = this.#readSourceSnapshotEnvelope(
				await readUnknown(
					this.#sourceSnapshotPath(snapshotHashInput),
					this.artifactRoot,
				),
			);
			if (snapshot.snapshotHash !== snapshotHashInput)
				throw new Error("Stored source snapshot path binding is invalid");
			return snapshot;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new Error(`Source snapshot not found: ${snapshotHashInput}`);
			throw error;
		}
	}

	async writeAuthoringAttempt(
		attemptInput: AuthoringAttemptRecord,
	): Promise<void> {
		await this.initialize();
		const attempt = AuthoringAttemptRecordSchema.parse(attemptInput);
		const filePath = this.#authoringAttemptPath(attempt.authoringId);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(attempt),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
	}

	async readAuthoringAttempt(
		authoringIdInput: string,
	): Promise<AuthoringAttemptRecord> {
		await this.initialize();
		const authoringId = EntityIdSchema.parse(authoringIdInput);
		try {
			const input = await readUnknown(
				this.#authoringAttemptPath(authoringId),
				this.artifactRoot,
			);
			return this.#readAuthoringAttemptEnvelope(input, authoringId);
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new Error(`Authoring attempt not found: ${authoringId}`);
			throw error;
		}
	}

	async writeSandboxControl(controlInput: SandboxControl): Promise<string> {
		await this.initialize();
		const control = SandboxControlSchema.parse(controlInput);
		const filePath = this.#sandboxControlPath(control.controlHash);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(control),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
		return control.controlHash;
	}

	async readSandboxControl(controlHashInput: string): Promise<SandboxControl> {
		await this.initialize();
		if (!/^[a-f0-9]{64}$/.test(controlHashInput))
			throw new TypeError("Sandbox control hash must be a SHA-256 digest");
		try {
			const input = (await readUnknown(
				this.#sandboxControlPath(controlHashInput),
				this.artifactRoot,
			)) as { record?: unknown; recordHash?: unknown; schemaVersion?: unknown };
			if (
				input.schemaVersion !== 1 ||
				typeof input.recordHash !== "string" ||
				recordHash(input.record) !== input.recordHash
			)
				throw new Error("Stored sandbox control envelope hash is invalid");
			const control = SandboxControlSchema.parse(input.record);
			if (control.controlHash !== controlHashInput)
				throw new Error("Stored sandbox control path binding is invalid");
			return control;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new Error(`Sandbox control not found: ${controlHashInput}`);
			throw error;
		}
	}

	async writeSandboxEvidence(
		evidenceInput: SandboxCommandEvidence,
	): Promise<string> {
		await this.initialize();
		const evidence = SandboxCommandEvidenceSchema.parse(evidenceInput);
		const filePath = this.#sandboxEvidencePath(evidence.evidenceHash);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(evidence),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
		return evidence.evidenceHash;
	}

	async writeSandboxResult(resultInput: SandboxResult): Promise<string> {
		await this.initialize();
		const result = SandboxResultSchema.parse(resultInput);
		const filePath = this.#sandboxResultPath(result.resultHash);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(result),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
		return result.resultHash;
	}

	async readSandboxResult(resultHashInput: string): Promise<SandboxResult> {
		await this.initialize();
		if (!/^[a-f0-9]{64}$/.test(resultHashInput))
			throw new TypeError("Sandbox result hash must be a SHA-256 digest");
		try {
			const input = (await readUnknown(
				this.#sandboxResultPath(resultHashInput),
				this.artifactRoot,
			)) as { record?: unknown; recordHash?: unknown; schemaVersion?: unknown };
			if (
				input.schemaVersion !== 1 ||
				typeof input.recordHash !== "string" ||
				recordHash(input.record) !== input.recordHash
			)
				throw new Error("Stored sandbox result hash is invalid");
			const result = SandboxResultSchema.parse(input.record);
			if (result.resultHash !== resultHashInput)
				throw new Error("Stored sandbox result path binding is invalid");
			return result;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new Error(`Sandbox result not found: ${resultHashInput}`);
			throw error;
		}
	}

	async readSandboxEvidence(
		evidenceHashInput: string,
	): Promise<SandboxCommandEvidence> {
		await this.initialize();
		if (!/^[a-f0-9]{64}$/.test(evidenceHashInput))
			throw new TypeError("Sandbox evidence hash must be a SHA-256 digest");
		try {
			const input = await readUnknown(
				this.#sandboxEvidencePath(evidenceHashInput),
				this.artifactRoot,
			);
			const envelope = input as Record<string, unknown>;
			if (envelope?.recordHash !== recordHash(envelope.record))
				throw new Error("Stored sandbox evidence envelope hash is invalid");
			const evidence = SandboxCommandEvidenceSchema.parse(envelope.record);
			if (evidence.evidenceHash !== evidenceHashInput)
				throw new Error("Stored sandbox evidence path binding is invalid");
			return evidence;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new Error(`Sandbox evidence not found: ${evidenceHashInput}`);
			throw error;
		}
	}

	async writeRepairStatus(statusInput: RepairStatusRecord): Promise<void> {
		await this.initialize();
		const status = RepairStatusRecordSchema.parse(statusInput);
		if (status.status === "PASS") {
			const candidate = await this.readCandidateEnvelope(status.candidateId);
			if (recordHash(candidate) !== status.candidateEnvelopeHash)
				throw new Error(
					"PASS status does not match the persisted candidate envelope",
				);
		}
		const filePath = this.#repairStatusPath(status.candidateId);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(status),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
	}

	async acquireRepairLease(): Promise<{ release: () => Promise<void> }> {
		await this.initialize();
		return this.#acquireLease("repair");
	}

	async readRepairStatus(
		candidateIdInput: string,
	): Promise<RepairStatusRecord> {
		await this.initialize();
		const candidateId = EntityIdSchema.parse(candidateIdInput);
		try {
			const input = (await readUnknown(
				this.#repairStatusPath(candidateId),
				this.artifactRoot,
			)) as { record?: unknown; recordHash?: unknown; schemaVersion?: unknown };
			if (
				input.schemaVersion !== 1 ||
				typeof input.recordHash !== "string" ||
				recordHash(input.record) !== input.recordHash
			)
				throw new Error("Stored repair status hash is invalid");
			return RepairStatusRecordSchema.parse(input.record);
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new Error(`Repair status not found: ${candidateId}`);
			throw error;
		}
	}

	async readCandidateEnvelope(
		candidateIdInput: string,
		options: Readonly<{ requireTerminalStatus?: boolean }> = {},
	): Promise<M5CandidateEnvelope> {
		await this.initialize();
		const candidateId = EntityIdSchema.parse(candidateIdInput);
		try {
			const input = await readUnknown(
				this.#candidatePath(candidateId),
				this.artifactRoot,
			);
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw new Error("Stored candidate envelope is malformed");
			const envelope = input as Record<string, unknown>;
			if (
				Object.keys(envelope).sort().join(",") !==
					"record,recordHash,schemaVersion" ||
				envelope.schemaVersion !== 1 ||
				typeof envelope.recordHash !== "string"
			) {
				throw new Error("Stored candidate envelope is malformed");
			}
			const candidate = M5CandidateEnvelopeSchema.parse(envelope.record);
			if (
				candidate.candidateId !== candidateId ||
				recordHash(candidate) !== envelope.recordHash
			)
				throw new Error("Stored candidate content hash is invalid");
			const candidateDirectory = this.#candidateDirectory(candidateId);
			const [testBytes, sourceBytes, combinedBytes] = await Promise.all([
				readBytes(
					path.join(
						candidateDirectory,
						candidate.testDiffArtifact.artifactPath,
					),
					this.artifactRoot,
				),
				readBytes(
					path.join(
						candidateDirectory,
						candidate.sourceDiffArtifact.artifactPath,
					),
					this.artifactRoot,
				),
				readBytes(
					path.join(
						candidateDirectory,
						candidate.combinedDiffArtifact.artifactPath,
					),
					this.artifactRoot,
				),
			]);
			if (
				sha256(testBytes) !== candidate.testDiffHash ||
				sha256(sourceBytes) !== candidate.sourceDiffHash ||
				sha256(combinedBytes) !== candidate.combinedDiffHash
			)
				throw new Error("Stored candidate diff artifact hash is invalid");
			const readChild = async (name: string): Promise<unknown> => {
				const child = (await readUnknown(
					path.join(candidateDirectory, name),
					this.artifactRoot,
				)) as {
					record?: unknown;
					recordHash?: unknown;
					schemaVersion?: unknown;
				};
				if (
					child.schemaVersion !== 1 ||
					typeof child.recordHash !== "string" ||
					recordHash(child.record) !== child.recordHash
				)
					throw new Error(`Stored candidate child hash is invalid: ${name}`);
				return child.record;
			};
			const snapshot = SourceSnapshotSchema.parse(
				await readChild("snapshot.json"),
			);
			const proof = TestFailureProofSchema.parse(await readChild("proof.json"));
			const testControl = SandboxControlSchema.parse(
				await readChild("test-control.json"),
			);
			const combinedControl = SandboxControlSchema.parse(
				await readChild("combined-control.json"),
			);
			const testEvidence = SandboxCommandEvidenceSchema.parse(
				await readChild("test-sandbox.json"),
			);
			const combinedEvidence = SandboxCommandEvidenceSchema.parse(
				await readChild("combined-sandbox.json"),
			);
			const testResult = SandboxResultSchema.parse(
				await readChild("test-result.json"),
			);
			const combinedResult = SandboxResultSchema.parse(
				await readChild("combined-result.json"),
			);
			const testPolicy = CandidatePolicyEvidenceSchema.parse(
				await readChild("test-policy.json"),
			);
			const sourcePolicy = CandidatePolicyEvidenceSchema.parse(
				await readChild("source-policy.json"),
			);
			if (
				testPolicy.diffHash !== candidate.testDiffHash ||
				sourcePolicy.diffHash !== candidate.sourceDiffHash ||
				testPolicy.sourceSnapshotHash !== candidate.sourceSnapshotHash ||
				sourcePolicy.sourceSnapshotHash !== candidate.sourceSnapshotHash
			)
				throw new Error("Stored candidate policy binding is invalid");
			assertCandidateDiffPolicy({
				testBytes,
				sourceBytes,
				combinedBytes,
				testPolicy,
				sourcePolicy,
			});
			if (
				snapshot.snapshotHash !== candidate.sourceSnapshotHash ||
				snapshot.baselineRunId !== candidate.baselineRunId ||
				snapshot.analysisId !== candidate.analysisId ||
				snapshot.expectedIndexHash !== candidate.expectedIndexHash ||
				snapshot.expectedRootHash !== candidate.expectedRootHash ||
				snapshot.expectedAnalysisHash !== candidate.expectedAnalysisHash ||
				snapshot.sourceRevision !== candidate.sourceRevision ||
				snapshot.toolingRevision !== candidate.toolingRevision
			)
				throw new Error("Stored candidate snapshot binding is invalid");
			const persistedSnapshot = await this.readSourceSnapshot(
				snapshot.snapshotHash,
			);
			if (canonical(persistedSnapshot) !== canonical(snapshot))
				throw new Error(
					"Stored candidate snapshot does not match immutable snapshot storage",
				);
			if (
				testControl.controlHash !== candidate.testControlHash ||
				testControl.stage !== "test-proof" ||
				testControl.sourceSnapshotHash !== snapshot.snapshotHash ||
				testControl.toolingRevision !== snapshot.toolingRevision ||
				canonical(testControl.snapshotFiles) !== canonical(snapshot.files) ||
				testControl.testDiffHash !== candidate.testDiffHash ||
				!Buffer.from(testControl.testDiffBase64, "base64").equals(testBytes)
			)
				throw new Error("Stored candidate test control binding is invalid");
			if (
				combinedControl.controlHash !== candidate.combinedControlHash ||
				combinedControl.stage !== "combined" ||
				combinedControl.sourceSnapshotHash !== snapshot.snapshotHash ||
				combinedControl.toolingRevision !== snapshot.toolingRevision ||
				canonical(combinedControl.snapshotFiles) !==
					canonical(snapshot.files) ||
				combinedControl.testDiffHash !== candidate.testDiffHash ||
				combinedControl.sourceDiffHash !== candidate.sourceDiffHash ||
				combinedControl.combinedDiffHash !== candidate.combinedDiffHash ||
				!Buffer.from(combinedControl.testDiffBase64, "base64").equals(
					testBytes,
				) ||
				!Buffer.from(combinedControl.sourceDiffBase64!, "base64").equals(
					sourceBytes,
				) ||
				!Buffer.from(combinedControl.combinedDiffBase64!, "base64").equals(
					combinedBytes,
				)
			)
				throw new Error("Stored candidate combined control binding is invalid");
			const [persistedTestControl, persistedCombinedControl] =
				await Promise.all([
					this.readSandboxControl(testControl.controlHash),
					this.readSandboxControl(combinedControl.controlHash),
				]);
			if (
				canonical(persistedTestControl) !== canonical(testControl) ||
				canonical(persistedCombinedControl) !== canonical(combinedControl)
			)
				throw new Error(
					"Stored candidate controls do not match immutable control storage",
				);
			if (
				proof.proofHash !== candidate.testFailureProofHash ||
				proof.controlHash !== testControl.controlHash ||
				proof.toolingRevision !== snapshot.toolingRevision ||
				testEvidence.controlHash !== testControl.controlHash ||
				combinedEvidence.controlHash !== combinedControl.controlHash ||
				canonical(proof) !== canonical(candidate.testFailureProof) ||
				canonical(testPolicy) !== canonical(candidate.testPolicy) ||
				canonical(sourcePolicy) !== canonical(candidate.sourcePolicy) ||
				canonical(testEvidence) !== canonical(candidate.sandbox[0]) ||
				canonical(combinedEvidence) !== canonical(candidate.sandbox[1]) ||
				testEvidence.evidenceHash !== candidate.testSandboxEvidenceHash ||
				combinedEvidence.evidenceHash !==
					candidate.combinedSandboxEvidenceHash ||
				testResult.resultHash !== candidate.testSandboxResultHash ||
				combinedResult.resultHash !== candidate.combinedSandboxResultHash ||
				testEvidence.resultHash !== testResult.resultHash ||
				combinedEvidence.resultHash !== combinedResult.resultHash
			)
				throw new Error("Stored candidate child record binding is invalid");
			assertSandboxRecordBinding({
				evidence: testEvidence,
				result: testResult,
				stage: "test-proof",
				commandId: M5_TEST_COMMAND_ID,
				expectedDiffHash: candidate.testDiffHash,
				toolingRevision: candidate.toolingRevision,
			});
			assertSandboxRecordBinding({
				evidence: combinedEvidence,
				result: combinedResult,
				stage: "combined",
				commandId: M5_CANDIDATE_COMMAND_ID,
				expectedDiffHash: candidate.combinedDiffHash,
				toolingRevision: candidate.toolingRevision,
			});
			if (
				sha256(Buffer.concat([testBytes, Buffer.from("\n"), sourceBytes])) !==
					candidate.combinedDiffHash ||
				combinedBytes.toString("utf8") !==
					Buffer.concat([testBytes, Buffer.from("\n"), sourceBytes]).toString(
						"utf8",
					)
			)
				throw new Error("Stored combined candidate diff is not deterministic");
			if (options.requireTerminalStatus) {
				const status = await this.readRepairStatus(candidateId);
				if (
					status.status !== "PASS" ||
					status.stage !== "sandbox-gating" ||
					status.candidateEnvelopeHash !== recordHash(candidate)
				)
					throw new Error(
						"Candidate does not have a matching terminal PASS status",
					);
			}
			return candidate;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new CandidateNotFoundError(candidateId);
			throw error;
		}
	}

	async publishTestFailureProof(
		input: PublishTestFailureProofInput,
	): Promise<string> {
		await this.initialize();
		const proof = TestFailureProofSchema.parse(input.proof);
		const snapshot = SourceSnapshotSchema.parse(input.snapshot);
		const control = SandboxControlSchema.parse(input.sandboxControl);
		const evidence = SandboxCommandEvidenceSchema.parse(input.sandboxEvidence);
		const diffBytes = Buffer.from(input.testDiffBytes);
		const parsedDiff = parseUnifiedDiff(diffBytes, { operation: "test-only" });
		if (
			parsedDiff.diffHash !== proof.testDiffHash ||
			sha256(diffBytes) !== proof.testDiffHash
		)
			throw new Error(
				"Test-failure proof does not match canonical test diff bytes",
			);
		const persistedSnapshot = await this.readSourceSnapshot(
			snapshot.snapshotHash,
		);
		if (
			canonical(persistedSnapshot) !== canonical(snapshot) ||
			proof.sourceSnapshotHash !== snapshot.snapshotHash ||
			proof.sourceRevision !== snapshot.sourceRevision ||
			proof.toolingRevision !== snapshot.toolingRevision
		)
			throw new Error(
				"Test-failure proof does not match the persisted source snapshot",
			);
		if (
			control.stage !== "test-proof" ||
			control.commandId !== M5_TEST_COMMAND_ID ||
			control.controlHash !== proof.controlHash ||
			control.sourceSnapshotHash !== snapshot.snapshotHash ||
			control.toolingRevision !== snapshot.toolingRevision ||
			canonical(control.snapshotFiles) !== canonical(snapshot.files) ||
			control.testDiffHash !== proof.testDiffHash ||
			!Buffer.from(control.testDiffBase64, "base64").equals(diffBytes)
		)
			throw new Error(
				"Test-failure proof does not match its persisted sandbox control",
			);
		const result = SandboxResultSchema.parse(input.sandboxResult);
		if (
			evidence.evidenceHash !== proof.sandboxEvidenceHash ||
			evidence.resultHash !== proof.sandboxResultHash ||
			result.resultHash !== proof.sandboxResultHash ||
			evidence.controlHash !== proof.controlHash ||
			evidence.classification !== "EXPECTED_FAILURE"
		)
			throw new Error(
				"Test-failure proof does not match sandbox evidence/result",
			);
		assertSandboxRecordBinding({
			evidence,
			result,
			stage: "test-proof",
			commandId: M5_TEST_COMMAND_ID,
			expectedDiffHash: proof.testDiffHash,
			toolingRevision: proof.toolingRevision,
		});
		if (
			result.observedFailureHash !== proof.observedFailureHash ||
			proof.exitCode !== result.exitCode ||
			proof.signal !== result.signal
		)
			throw new Error(
				"Test-failure proof process flags do not match sandbox result",
			);
		try {
			await this.writeSandboxControl(control);
		} catch (error) {
			if (
				errorCode(error) !== "EEXIST" ||
				JSON.stringify(await this.readSandboxControl(control.controlHash)) !==
					JSON.stringify(control)
			)
				throw error;
		}
		try {
			await this.writeSandboxEvidence(evidence);
		} catch (error) {
			if (
				errorCode(error) !== "EEXIST" ||
				JSON.stringify(
					await this.readSandboxEvidence(evidence.evidenceHash),
				) !== JSON.stringify(evidence)
			)
				throw error;
		}
		try {
			await this.writeSandboxResult(result);
		} catch (error) {
			if (
				errorCode(error) !== "EEXIST" ||
				JSON.stringify(await this.readSandboxResult(result.resultHash)) !==
					JSON.stringify(result)
			)
				throw error;
		}
		const key = testFailureProofKey(proof);
		const diffPath = this.#testFailureDiffPath(key);
		try {
			await writeBytesExclusive(diffPath, diffBytes, this.artifactRoot);
		} catch (error) {
			// The test-failure diff is content-addressed by the proof key. Re-writing
			// the same immutable diff is idempotent; a collision is rejected by hash.
			if (
				errorCode(error) !== "EEXIST" ||
				sha256(await readBytes(diffPath, this.artifactRoot)) !==
					proof.testDiffHash
			)
				throw error;
		}
		await chmod(diffPath, 0o400);
		const filePath = this.#testFailureProofPath(key);
		try {
			await writeExclusive(
				filePath,
				this.#hashedEnvelope(proof),
				this.artifactRoot,
			);
		} catch (error) {
			// The proof is content-addressed by its key. Re-writing the same immutable
			// proof is idempotent; a collision with different content is rejected.
			if (
				errorCode(error) !== "EEXIST" ||
				canonical(await this.readTestFailureProof(key)) !== canonical(proof)
			)
				throw error;
		}
		await chmod(filePath, 0o400);
		return key;
	}

	async publishCandidate(input: PublishCandidateInput): Promise<void> {
		await this.initialize();
		const envelope = M5CandidateEnvelopeSchema.parse(input.envelope);
		const snapshot = SourceSnapshotSchema.parse(input.snapshot);
		const persistedSnapshot = await this.readSourceSnapshot(
			snapshot.snapshotHash,
		);
		if (
			canonical(persistedSnapshot) !== canonical(snapshot) ||
			envelope.sourceSnapshotHash !== snapshot.snapshotHash ||
			envelope.toolingRevision !== snapshot.toolingRevision
		)
			throw new Error("Candidate snapshot binding is invalid");
		const testBytes = Buffer.from(input.testDiffBytes);
		const sourceBytes = Buffer.from(input.sourceDiffBytes);
		const combinedBytes = Buffer.from(input.combinedDiffBytes);
		const expectedCombinedBytes = Buffer.concat([
			testBytes,
			Buffer.from("\n"),
			sourceBytes,
		]);
		if (!combinedBytes.equals(expectedCombinedBytes))
			throw new Error(
				"Combined candidate bytes do not equal test bytes, newline, and source bytes",
			);
		if (
			sha256(testBytes) !== envelope.testDiffHash ||
			sha256(sourceBytes) !== envelope.sourceDiffHash ||
			sha256(combinedBytes) !== envelope.combinedDiffHash
		)
			throw new Error("Candidate diff artifact hash mismatch");
		if (
			testBytes.byteLength !== envelope.testDiffArtifact.byteLength ||
			sourceBytes.byteLength !== envelope.sourceDiffArtifact.byteLength ||
			combinedBytes.byteLength !== envelope.combinedDiffArtifact.byteLength
		)
			throw new Error("Candidate diff artifact byte length mismatch");
		assertCandidateDiffPolicy({
			testBytes,
			sourceBytes,
			combinedBytes,
			testPolicy: envelope.testPolicy,
			sourcePolicy: envelope.sourcePolicy,
		});
		const testControl = SandboxControlSchema.parse(input.testControl);
		const combinedControl = SandboxControlSchema.parse(input.combinedControl);
		if (
			testControl.stage !== "test-proof" ||
			testControl.controlHash !== envelope.testControlHash ||
			testControl.sourceSnapshotHash !== snapshot.snapshotHash ||
			testControl.toolingRevision !== snapshot.toolingRevision ||
			canonical(testControl.snapshotFiles) !== canonical(snapshot.files) ||
			testControl.testDiffHash !== envelope.testDiffHash ||
			!Buffer.from(testControl.testDiffBase64, "base64").equals(testBytes)
		)
			throw new Error("Candidate test control binding is invalid");
		if (
			combinedControl.stage !== "combined" ||
			combinedControl.controlHash !== envelope.combinedControlHash ||
			combinedControl.sourceSnapshotHash !== snapshot.snapshotHash ||
			combinedControl.toolingRevision !== snapshot.toolingRevision ||
			canonical(combinedControl.snapshotFiles) !== canonical(snapshot.files) ||
			combinedControl.testDiffHash !== envelope.testDiffHash ||
			combinedControl.sourceDiffHash !== envelope.sourceDiffHash ||
			combinedControl.combinedDiffHash !== envelope.combinedDiffHash ||
			!Buffer.from(combinedControl.testDiffBase64, "base64").equals(
				testBytes,
			) ||
			!Buffer.from(combinedControl.sourceDiffBase64!, "base64").equals(
				sourceBytes,
			) ||
			!Buffer.from(combinedControl.combinedDiffBase64!, "base64").equals(
				combinedBytes,
			)
		)
			throw new Error("Candidate combined control binding is invalid");
		const testEvidence = SandboxCommandEvidenceSchema.parse(input.testEvidence);
		const combinedEvidence = SandboxCommandEvidenceSchema.parse(
			input.combinedEvidence,
		);
		const testResult = SandboxResultSchema.parse(input.testResult);
		const combinedResult = SandboxResultSchema.parse(input.combinedResult);
		if (
			testEvidence.controlHash !== testControl.controlHash ||
			combinedEvidence.controlHash !== combinedControl.controlHash ||
			testEvidence.evidenceHash !== envelope.testSandboxEvidenceHash ||
			combinedEvidence.evidenceHash !== envelope.combinedSandboxEvidenceHash ||
			testResult.resultHash !== envelope.testSandboxResultHash ||
			combinedResult.resultHash !== envelope.combinedSandboxResultHash ||
			testEvidence.resultHash !== testResult.resultHash ||
			combinedEvidence.resultHash !== combinedResult.resultHash
		)
			throw new Error(
				"Candidate sandbox control/evidence/result binding is invalid",
			);
		assertSandboxRecordBinding({
			evidence: testEvidence,
			result: testResult,
			stage: "test-proof",
			commandId: M5_TEST_COMMAND_ID,
			expectedDiffHash: envelope.testDiffHash,
			toolingRevision: envelope.toolingRevision,
		});
		assertSandboxRecordBinding({
			evidence: combinedEvidence,
			result: combinedResult,
			stage: "combined",
			commandId: M5_CANDIDATE_COMMAND_ID,
			expectedDiffHash: envelope.combinedDiffHash,
			toolingRevision: envelope.toolingRevision,
		});
		if (
			testEvidence.classification !== "EXPECTED_FAILURE" ||
			combinedEvidence.classification !== "CANDIDATE_PASS"
		)
			throw new Error(
				"Candidate sandbox classifications are not gate successes",
			);
		const persistedProof = await this.readTestFailureProof({
			baselineRunId: envelope.baselineRunId,
			sourceSnapshotHash: envelope.sourceSnapshotHash,
			testDiffHash: envelope.testDiffHash,
		});
		if (canonical(persistedProof) !== canonical(envelope.testFailureProof))
			throw new Error("Candidate proof does not match immutable proof storage");
		for (const control of [testControl, combinedControl]) {
			try {
				await this.writeSandboxControl(control);
			} catch (error) {
				if (
					errorCode(error) !== "EEXIST" ||
					JSON.stringify(await this.readSandboxControl(control.controlHash)) !==
						JSON.stringify(control)
				)
					throw error;
			}
		}
		const candidateDirectory = this.#candidateDirectory(envelope.candidateId);
		await ensureRealDirectory(candidateDirectory);
		const staging = path.join(candidateDirectory, `.staging-${randomUUID()}`);
		await ensureRealDirectory(staging);
		try {
			await writeBytesExclusive(
				path.join(staging, envelope.testDiffArtifact.artifactPath),
				testBytes,
				this.artifactRoot,
			);
			await writeBytesExclusive(
				path.join(staging, envelope.sourceDiffArtifact.artifactPath),
				sourceBytes,
				this.artifactRoot,
			);
			await writeBytesExclusive(
				path.join(staging, envelope.combinedDiffArtifact.artifactPath),
				combinedBytes,
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "snapshot.json"),
				this.#hashedEnvelope(snapshot),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "test-control.json"),
				this.#hashedEnvelope(testControl),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "combined-control.json"),
				this.#hashedEnvelope(combinedControl),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "test-sandbox.json"),
				this.#hashedEnvelope(testEvidence),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "combined-sandbox.json"),
				this.#hashedEnvelope(combinedEvidence),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "test-result.json"),
				this.#hashedEnvelope(testResult),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "combined-result.json"),
				this.#hashedEnvelope(combinedResult),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "proof.json"),
				this.#hashedEnvelope(envelope.testFailureProof),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "test-policy.json"),
				this.#hashedEnvelope(envelope.testPolicy),
				this.artifactRoot,
			);
			await writeExclusive(
				path.join(staging, "source-policy.json"),
				this.#hashedEnvelope(envelope.sourcePolicy),
				this.artifactRoot,
			);
			// Publish child artifacts first, then the envelope last. A failed child
			// move leaves no envelope and therefore cannot be read as a candidate.
			await rename(
				path.join(staging, "diffs"),
				path.join(candidateDirectory, "diffs"),
			);
			for (const name of [
				"snapshot.json",
				"test-control.json",
				"combined-control.json",
				"test-sandbox.json",
				"combined-sandbox.json",
				"test-result.json",
				"combined-result.json",
				"proof.json",
				"test-policy.json",
				"source-policy.json",
			]) {
				await rename(
					path.join(staging, name),
					path.join(candidateDirectory, name),
				);
			}
			const finalEnvelope = this.#candidatePath(envelope.candidateId);
			await writeExclusive(
				finalEnvelope,
				this.#hashedEnvelope(envelope),
				this.artifactRoot,
			);
			await chmod(finalEnvelope, 0o400);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}

	/** Compatibility name retained only when all immutable artifacts are supplied. */
	async writeTestFailureProof(
		proofInput: TestFailureProof,
		artifacts: Readonly<{
			snapshot: SourceSnapshot;
			testDiffBytes: Uint8Array;
			sandboxControl: SandboxControl;
			sandboxEvidence: SandboxCommandEvidence;
			sandboxResult: SandboxResult;
		}>,
	): Promise<string> {
		return this.publishTestFailureProof({
			proof: proofInput,
			snapshot: artifacts.snapshot,
			testDiffBytes: artifacts.testDiffBytes,
			sandboxControl: artifacts.sandboxControl,
			sandboxEvidence: artifacts.sandboxEvidence,
			sandboxResult: artifacts.sandboxResult,
		});
	}

	async readTestFailureProof(
		lookup:
			| string
			| Pick<
					TestFailureProof,
					"baselineRunId" | "sourceSnapshotHash" | "testDiffHash"
			  >,
	): Promise<TestFailureProof> {
		await this.initialize();
		const key =
			typeof lookup === "string" ? lookup : testFailureProofKey(lookup);
		if (!/^[a-f0-9]{64}$/.test(key))
			throw new TypeError("Test-failure proof key must be a SHA-256 digest");
		try {
			const input = await readUnknown(
				this.#testFailureProofPath(key),
				this.artifactRoot,
			);
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw new Error("Stored test-failure proof envelope is malformed");
			const envelope = input as Record<string, unknown>;
			if (
				Object.keys(envelope).sort().join(",") !==
					"record,recordHash,schemaVersion" ||
				envelope.schemaVersion !== 1 ||
				typeof envelope.recordHash !== "string"
			) {
				throw new Error("Stored test-failure proof envelope is malformed");
			}
			const proof = TestFailureProofSchema.parse(envelope.record);
			if (
				testFailureProofKey(proof) !== key ||
				recordHash(proof) !== envelope.recordHash
			) {
				throw new Error(
					"Stored test-failure proof content hash or key is invalid",
				);
			}
			const diffBytes = await readBytes(
				this.#testFailureDiffPath(key),
				this.artifactRoot,
			);
			const parsedDiff = parseUnifiedDiff(diffBytes, {
				operation: "test-only",
			});
			if (
				sha256(diffBytes) !== proof.testDiffHash ||
				parsedDiff.diffHash !== proof.testDiffHash
			)
				throw new Error("Stored test-failure proof diff hash is invalid");
			const snapshot = await this.readSourceSnapshot(proof.sourceSnapshotHash);
			const control = await this.readSandboxControl(proof.controlHash);
			if (
				control.stage !== "test-proof" ||
				control.sourceSnapshotHash !== snapshot.snapshotHash ||
				control.toolingRevision !== snapshot.toolingRevision ||
				canonical(control.snapshotFiles) !== canonical(snapshot.files) ||
				control.testDiffHash !== proof.testDiffHash ||
				!Buffer.from(control.testDiffBase64, "base64").equals(diffBytes)
			)
				throw new Error("Stored test-failure proof control binding is invalid");
			const evidence = await this.readSandboxEvidence(
				proof.sandboxEvidenceHash,
			);
			const result = await this.readSandboxResult(proof.sandboxResultHash);
			if (
				proof.sourceRevision !== snapshot.sourceRevision ||
				proof.toolingRevision !== snapshot.toolingRevision ||
				evidence.controlHash !== proof.controlHash ||
				evidence.evidenceHash !== proof.sandboxEvidenceHash ||
				evidence.resultHash !== proof.sandboxResultHash ||
				result.resultHash !== proof.sandboxResultHash
			)
				throw new Error(
					"Stored test-failure proof sandbox references are invalid",
				);
			assertSandboxRecordBinding({
				evidence,
				result,
				stage: "test-proof",
				commandId: M5_TEST_COMMAND_ID,
				expectedDiffHash: proof.testDiffHash,
				toolingRevision: proof.toolingRevision,
			});
			if (
				result.observedFailureHash !== proof.observedFailureHash ||
				result.exitCode !== proof.exitCode ||
				result.signal !== proof.signal
			)
				throw new Error("Stored test-failure proof process binding is invalid");
			return proof;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new TestFailureProofNotFoundError(key);
			throw error;
		}
	}

	async readTestFailureProofBundle(
		lookup:
			| string
			| Pick<
					TestFailureProof,
					"baselineRunId" | "sourceSnapshotHash" | "testDiffHash"
			  >,
	): Promise<
		Readonly<{
			proof: TestFailureProof;
			snapshot: SourceSnapshot;
			testDiffBytes: Buffer;
			control: SandboxControl;
			evidence: SandboxCommandEvidence;
			result: SandboxResult;
		}>
	> {
		const proof = await this.readTestFailureProof(lookup);
		const key = testFailureProofKey(proof);
		const [snapshot, testDiffBytes, control, evidence, result] =
			await Promise.all([
				this.readSourceSnapshot(proof.sourceSnapshotHash),
				readBytes(this.#testFailureDiffPath(key), this.artifactRoot),
				this.readSandboxControl(proof.controlHash),
				this.readSandboxEvidence(proof.sandboxEvidenceHash),
				this.readSandboxResult(proof.sandboxResultHash),
			]);
		if (sha256(testDiffBytes) !== proof.testDiffHash)
			throw new Error("Stored test-failure proof bundle diff hash is invalid");
		return { proof, snapshot, testDiffBytes, control, evidence, result };
	}

	async acquireAnalysisLease(): Promise<{ release: () => Promise<void> }> {
		await this.initialize();
		return this.#acquireLease("model-analysis");
	}

	async createFixtureJob(
		options: CreateFixtureJobOptions,
	): Promise<{ view: ControlJobView; created: boolean }> {
		await this.initialize();
		const idempotencyKey = ControlIdempotencyKeySchema.parse(
			options.idempotencyKey,
		);
		const requestHash = sha256(
			JSON.stringify({
				schemaVersion: SCHEMA_VERSION,
				mode: "fixture",
				targetId: TARGET_ID,
				journeyId: JOURNEY_ID,
				profileId: PROFILE_ID,
				seedIds: SEED_IDS,
			}),
		);
		const keyHash = sha256(idempotencyKey);
		const idempotencyPath = this.#idempotencyPath(keyHash);
		const lock = await this.#acquireLease("create");
		try {
			const committed = await this.#readCommittedViews();
			const active = committed.filter((view) => this.#isActive(view));
			if (active.length > 1)
				throw new Error(
					"Control store contains more than one committed active job",
				);
			const authoritativeLatest =
				active[0] ??
				[...committed].sort((left, right) =>
					right.job.createdAt.localeCompare(left.job.createdAt),
				)[0];
			if (authoritativeLatest) {
				await replaceAtomic(
					this.#latestPath(),
					{
						schemaVersion: SCHEMA_VERSION,
						jobId: authoritativeLatest.job.jobId,
						updatedAt: authoritativeLatest.job.updatedAt,
					},
					this.artifactRoot,
				);
			}

			if (await exists(idempotencyPath)) {
				const record = ControlIdempotencyRecordSchema.parse(
					await readUnknown(idempotencyPath, this.artifactRoot),
				);
				const view = committed.find(({ job }) => job.jobId === record.jobId);
				if (
					!view ||
					record.keyHash !== keyHash ||
					record.requestHash !== requestHash ||
					view.job.idempotencyKeyHash !== keyHash ||
					view.job.requestHash !== requestHash
				) {
					throw new Error(
						"Idempotency record does not match a committed control job",
					);
				}
				return { view, created: false };
			}

			const recoverable = committed.find(
				({ job }) => job.idempotencyKeyHash === keyHash,
			);
			if (recoverable) {
				if (recoverable.job.requestHash !== requestHash)
					throw new Error(
						"Idempotency key was reused for a different control request",
					);
				await writeExclusive(
					idempotencyPath,
					{
						schemaVersion: SCHEMA_VERSION,
						keyHash,
						requestHash,
						jobId: recoverable.job.jobId,
						createdAt: recoverable.job.createdAt,
					},
					this.artifactRoot,
				);
				return { view: recoverable, created: false };
			}

			if (active[0]) throw new ActiveJobConflictError(active[0].job.jobId);

			const now = options.now ?? (() => new Date());
			const createdAt = now().toISOString();
			const jobId = EntityIdSchema.parse(
				options.jobId ?? `job-${randomUUID()}`,
			);
			const runId = EntityIdSchema.parse(
				options.runId ?? `run-${randomUUID()}`,
			);
			const origin = RunOriginSchema.parse({
				schemaVersion: SCHEMA_VERSION,
				jobId,
				runId,
				mode: "fixture",
				targetId: TARGET_ID,
				journeyId: JOURNEY_ID,
				profileId: PROFILE_ID,
				seedIds: [...SEED_IDS],
			});
			const initialEvent = RunEventSchema.parse({
				schemaVersion: SCHEMA_VERSION,
				jobId,
				runId,
				mode: "fixture",
				sequence: 1,
				state: "REQUESTED",
				occurredAt: createdAt,
				message: "Fixture rehearsal requested",
			});
			const job = ControlJobRecordSchema.parse({
				schemaVersion: SCHEMA_VERSION,
				fixtureVersion: "golden-control-v1",
				jobId,
				runId,
				mode: "fixture",
				targetId: TARGET_ID,
				journeyId: JOURNEY_ID,
				profileId: PROFILE_ID,
				seedIds: [...SEED_IDS],
				idempotencyKeyHash: keyHash,
				requestHash,
				state: "REQUESTED",
				lastSequence: 1,
				createdAt,
				updatedAt: createdAt,
			});
			const snapshot = FixtureDashboardSnapshotSchema.parse(
				options.snapshot({ jobId, runId, createdAt }),
			);
			if (snapshot.jobId !== jobId || snapshot.runId !== runId)
				throw new Error("Fixture snapshot does not match the created job");

			await writeExclusive(this.#originPath(runId), origin, this.artifactRoot);
			await appendEvent(
				this.#eventsPath(jobId),
				initialEvent,
				this.artifactRoot,
				true,
			);
			await writeExclusive(
				this.#snapshotPath(jobId),
				snapshot,
				this.artifactRoot,
			);
			await writeExclusive(this.#jobPath(jobId), job, this.artifactRoot);
			await writeExclusive(
				idempotencyPath,
				{
					schemaVersion: SCHEMA_VERSION,
					keyHash,
					requestHash,
					jobId,
					createdAt,
				},
				this.artifactRoot,
			);
			await replaceAtomic(
				this.#latestPath(),
				{
					schemaVersion: SCHEMA_VERSION,
					jobId,
					updatedAt: createdAt,
				},
				this.artifactRoot,
			);
			return {
				view: ControlJobViewSchema.parse({
					schemaVersion: SCHEMA_VERSION,
					job,
					snapshot,
					events: [initialEvent],
				}),
				created: true,
			};
		} finally {
			await lock.release();
		}
	}

	async readJob(jobIdInput: string): Promise<ControlJobRecord> {
		await this.initialize();
		const jobId = EntityIdSchema.parse(jobIdInput);
		const stored = await this.#readStoredJob(jobId);
		const events = await this.readEvents(jobId);
		const last = events.at(-1);
		if (!last) throw new Error(`Control job has no event log: ${jobId}`);
		return ControlJobRecordSchema.parse({
			...stored,
			state: last.state,
			lastSequence: last.sequence,
			updatedAt: last.occurredAt,
		});
	}

	async readEvents(jobIdInput: string, afterSequence = 0): Promise<RunEvent[]> {
		await this.initialize();
		const jobId = EntityIdSchema.parse(jobIdInput);
		if (!Number.isInteger(afterSequence) || afterSequence < 0)
			throw new TypeError("afterSequence must be a non-negative integer");
		const storedJob = await this.#readStoredJob(jobId);
		const events = await readEventsFile(
			this.#eventsPath(jobId),
			this.artifactRoot,
		);
		if (events.length === 0) return [];
		const origin = RunOriginSchema.parse(
			await readUnknown(this.#originPath(storedJob.runId), this.artifactRoot),
		);
		if (
			origin.jobId !== storedJob.jobId ||
			origin.runId !== storedJob.runId ||
			origin.mode !== storedJob.mode ||
			origin.targetId !== storedJob.targetId ||
			origin.journeyId !== storedJob.journeyId ||
			origin.profileId !== storedJob.profileId ||
			origin.seedIds.some(
				(seedId, index) => seedId !== storedJob.seedIds[index],
			)
		) {
			throw new Error(
				`Stored control job does not match its immutable origin: ${jobId}`,
			);
		}
		for (const [index, event] of events.entries()) {
			if (
				event.jobId !== jobId ||
				event.jobId !== origin.jobId ||
				event.runId !== origin.runId ||
				event.mode !== origin.mode ||
				event.sequence !== index + 1
			) {
				throw new Error(
					`Control event log provenance or sequence is invalid: ${jobId}`,
				);
			}
			if (index === 0 && event.state !== "REQUESTED")
				throw new Error(`Control event log must begin at REQUESTED: ${jobId}`);
			const previous = events[index - 1];
			if (previous) {
				validateStateTransitionForOrigin(origin, {
					schemaVersion: SCHEMA_VERSION,
					jobId,
					runId: origin.runId,
					mode: origin.mode,
					from: previous.state,
					to: event.state,
				});
				if (Date.parse(event.occurredAt) < Date.parse(previous.occurredAt)) {
					throw new Error(
						`Control event timestamps are not monotonic: ${jobId}`,
					);
				}
			}
		}
		return events.filter(({ sequence }) => sequence > afterSequence);
	}

	async readSnapshot(jobIdInput: string): Promise<FixtureDashboardSnapshot> {
		await this.initialize();
		const jobId = EntityIdSchema.parse(jobIdInput);
		try {
			return FixtureDashboardSnapshotSchema.parse(
				await readUnknown(this.#snapshotPath(jobId), this.artifactRoot),
			);
		} catch (error) {
			if (errorCode(error) === "ENOENT") throw new JobNotFoundError(jobId);
			throw error;
		}
	}

	async updateSnapshot(
		jobIdInput: string,
		snapshotInput: FixtureDashboardSnapshot,
	): Promise<void> {
		const jobId = EntityIdSchema.parse(jobIdInput);
		const job = await this.readJob(jobId);
		const snapshot = FixtureDashboardSnapshotSchema.parse(snapshotInput);
		if (snapshot.jobId !== job.jobId || snapshot.runId !== job.runId) {
			throw new Error(
				"Updated fixture snapshot does not match the stored job provenance",
			);
		}
		await replaceAtomic(this.#snapshotPath(jobId), snapshot, this.artifactRoot);
	}

	async readView(jobIdInput: string): Promise<ControlJobView> {
		await this.initialize();
		const jobId = EntityIdSchema.parse(jobIdInput);
		const snapshot = await this.readSnapshot(jobId);
		const events = await this.readEvents(jobId);
		const stored = await this.#readStoredJob(jobId);
		const last = events.at(-1);
		if (!last) throw new Error(`Control job has no event log: ${jobId}`);
		const job = ControlJobRecordSchema.parse({
			...stored,
			state: last.state,
			lastSequence: last.sequence,
			updatedAt: last.occurredAt,
		});
		return ControlJobViewSchema.parse({
			schemaVersion: SCHEMA_VERSION,
			job,
			snapshot,
			events,
		});
	}

	async readLatestView(): Promise<ControlJobView | null> {
		await this.initialize();
		let pointer: ReturnType<typeof LatestJobPointerSchema.parse>;
		try {
			pointer = LatestJobPointerSchema.parse(
				await readUnknown(this.#latestPath(), this.artifactRoot),
			);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return null;
			throw error;
		}
		return this.readView(pointer.jobId);
	}

	async transition(
		jobIdInput: string,
		to: RunState,
		message: string,
		now: () => Date = () => new Date(),
	): Promise<RunEvent> {
		const jobId = EntityIdSchema.parse(jobIdInput);
		const job = await this.readJob(jobId);
		const origin = RunOriginSchema.parse(
			await readUnknown(this.#originPath(job.runId), this.artifactRoot),
		);
		validateStateTransitionForOrigin(origin, {
			schemaVersion: SCHEMA_VERSION,
			jobId,
			runId: job.runId,
			mode: job.mode,
			from: job.state,
			to,
		});
		const occurredAt = now().toISOString();
		const event = RunEventSchema.parse({
			schemaVersion: SCHEMA_VERSION,
			jobId,
			runId: job.runId,
			mode: job.mode,
			sequence: job.lastSequence + 1,
			state: to,
			occurredAt,
			message,
		});
		await appendEvent(this.#eventsPath(jobId), event, this.artifactRoot);
		await replaceAtomic(
			this.#jobPath(jobId),
			ControlJobRecordSchema.parse({
				...job,
				state: to,
				lastSequence: event.sequence,
				updatedAt: occurredAt,
			}),
			this.artifactRoot,
		);
		return event;
	}

	async acquireWorkerLease(
		jobIdInput: string,
	): Promise<{ release: () => Promise<void> }> {
		await this.initialize();
		EntityIdSchema.parse(jobIdInput);
		return this.#acquireLease("fixture-worker");
	}

	#isActive(view: ControlJobView): boolean {
		return (
			!isTerminalRunState(view.job.state) ||
			view.snapshot.completion.status !== "REHEARSAL_COMPLETE"
		);
	}

	async #readCommittedViews(): Promise<ControlJobView[]> {
		const jobsDirectory = path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"jobs",
		);
		const entries = await readdir(jobsDirectory, { withFileTypes: true });
		const views: ControlJobView[] = [];
		for (const entry of entries) {
			if (
				entry.name.startsWith(".") &&
				(entry.name.endsWith(".tmp") || entry.name.endsWith(".publish"))
			)
				continue;
			if (
				!entry.isFile() ||
				entry.isSymbolicLink() ||
				!entry.name.endsWith(".json")
			) {
				throw new Error(`Unexpected control job store entry: ${entry.name}`);
			}
			const jobId = EntityIdSchema.parse(entry.name.slice(0, -".json".length));
			views.push(await this.readView(jobId));
		}
		return views;
	}

	async #acquireLease(name: string): Promise<{ release: () => Promise<void> }> {
		const leasePath = path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"leases",
			`${name}.lock`,
		);
		await ensureRealDirectory(path.dirname(leasePath));
		const ownerToken = randomUUID();
		let handle: Awaited<ReturnType<typeof openVerifiedRegularFile>> | undefined;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const candidatePath = `${leasePath}.acquire-${ownerToken}`;
			let candidate:
				| Awaited<ReturnType<typeof openVerifiedRegularFile>>
				| undefined;
			try {
				candidate = await openVerifiedRegularFile(
					candidatePath,
					"wx",
					this.artifactRoot,
				);
				await candidate.writeFile(
					json({
						pid: process.pid,
						ownerToken,
						createdAt: new Date().toISOString(),
					}),
					"utf8",
				);
				await candidate.sync();
				await link(candidatePath, leasePath);
				await rm(candidatePath, { force: true }).catch(() => undefined);
				handle = candidate;
				break;
			} catch (error) {
				await candidate?.close().catch(() => undefined);
				await rm(candidatePath, { force: true });
				if (errorCode(error) !== "EEXIST") throw error;
				if (attempt > 0 || !(await this.#quarantineStaleLease(leasePath)))
					throw new StoreBusyError();
			}
		}
		if (!handle) throw new StoreBusyError();
		const leaseIdentity = await handle.stat();
		let released = false;
		return {
			release: async () => {
				if (released) return;
				released = true;
				await handle.close();
				const current = await lstat(leasePath).catch((error: unknown) => {
					if (errorCode(error) === "ENOENT") return null;
					throw error;
				});
				if (!current) return;
				if (
					current.dev !== leaseIdentity.dev ||
					current.ino !== leaseIdentity.ino ||
					current.isSymbolicLink() ||
					!current.isFile()
				) {
					throw new Error(
						"Refusing to release a lease whose owner identity changed",
					);
				}
				const releasedPath = `${leasePath}.released-${ownerToken}`;
				await rename(leasePath, releasedPath);
				const record = parseLeaseRecord(
					await readUnknown(releasedPath, this.artifactRoot),
				);
				if (record.ownerToken !== ownerToken || record.pid !== process.pid) {
					await rename(releasedPath, leasePath).catch(() => undefined);
					throw new Error(
						"Refusing to delete a lease owned by another process",
					);
				}
				await rm(releasedPath, { force: true });
			},
		};
	}

	async #quarantineStaleLease(leasePath: string): Promise<boolean> {
		let stale: LeaseRecord;
		try {
			stale = parseLeaseRecord(await readUnknown(leasePath, this.artifactRoot));
		} catch (error) {
			if (errorCode(error) === "ENOENT") return true;
			throw error;
		}
		if (processIsAlive(stale.pid)) return false;

		const quarantinePath = `${leasePath}.stale-${stale.ownerToken}`;
		try {
			await link(leasePath, quarantinePath);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				if (errorCode(error) === "ENOENT") return true;
				throw error;
			}
		}

		const claimPath = `${quarantinePath}.claim-${randomUUID()}`;
		try {
			await rename(quarantinePath, claimPath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return false;
			throw error;
		}

		try {
			const [claimMetadata, currentMetadata, claimed] = await Promise.all([
				lstat(claimPath),
				lstat(leasePath),
				readUnknown(claimPath, this.artifactRoot).then(parseLeaseRecord),
			]);
			if (
				claimed.ownerToken !== stale.ownerToken ||
				claimed.pid !== stale.pid ||
				claimMetadata.dev !== currentMetadata.dev ||
				claimMetadata.ino !== currentMetadata.ino
			) {
				return false;
			}
			if (processIsAlive(claimed.pid)) return false;
			await unlink(leasePath);
			return true;
		} catch (error) {
			if (errorCode(error) === "ENOENT") return true;
			throw error;
		} finally {
			await rm(claimPath, { force: true });
		}
	}

	async #readStoredJob(jobId: string): Promise<ControlJobRecord> {
		try {
			return ControlJobRecordSchema.parse(
				await readUnknown(this.#jobPath(jobId), this.artifactRoot),
			);
		} catch (error) {
			if (errorCode(error) === "ENOENT") throw new JobNotFoundError(jobId);
			throw error;
		}
	}

	#assertAttemptMatchesReport(
		attempt: AnalysisAttemptRecord,
		report: AnalysisReport,
	): void {
		if (
			attempt.status !== "SUCCESS" ||
			attempt.analysisId !== report.analysisId ||
			attempt.baselineRunId !== report.baselineRunId ||
			attempt.cliVersion !== report.cliVersion ||
			attempt.threadId !== report.threadId ||
			attempt.terminalStatus !== report.terminalStatus ||
			JSON.stringify(attempt.usage) !== JSON.stringify(report.usage) ||
			attempt.startedAt !== report.startedAt ||
			attempt.completedAt !== report.completedAt ||
			attempt.durationMs !== report.durationMs ||
			attempt.exitStatus !== report.exitStatus
		) {
			throw new Error(
				"Successful analysis does not match its committed attempt provenance",
			);
		}
	}

	#hashedEnvelope<T>(
		record: T,
	): Readonly<{ schemaVersion: 1; recordHash: string; record: T }> {
		return { schemaVersion: 1, recordHash: recordHash(record), record };
	}

	#readAnalysisEnvelope(input: unknown): AnalysisReport {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("Stored analysis envelope is malformed");
		const envelope = input as Record<string, unknown>;
		if (
			Object.keys(envelope).sort().join(",") !==
				"record,recordHash,schemaVersion" ||
			envelope.schemaVersion !== 1 ||
			typeof envelope.recordHash !== "string"
		) {
			throw new Error("Stored analysis envelope is malformed");
		}
		const report = AnalysisReportSchema.parse(envelope.record);
		if (recordHash(report) !== envelope.recordHash)
			throw new Error("Stored analysis content hash is invalid");
		return report;
	}

	#readAnalysisAttemptEnvelope(input: unknown): AnalysisAttemptRecord {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("Stored analysis attempt envelope is malformed");
		const envelope = input as Record<string, unknown>;
		if (
			Object.keys(envelope).sort().join(",") !==
				"record,recordHash,schemaVersion" ||
			envelope.schemaVersion !== 1 ||
			typeof envelope.recordHash !== "string"
		) {
			throw new Error("Stored analysis attempt envelope is malformed");
		}
		const attempt = AnalysisAttemptRecordSchema.parse(envelope.record);
		if (recordHash(attempt) !== envelope.recordHash)
			throw new Error("Stored analysis attempt content hash is invalid");
		return attempt;
	}

	#readSourceSnapshotEnvelope(input: unknown): SourceSnapshot {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("Stored source snapshot envelope is malformed");
		const envelope = input as Record<string, unknown>;
		if (
			envelope.schemaVersion !== 1 ||
			typeof envelope.recordHash !== "string" ||
			!Object.prototype.hasOwnProperty.call(envelope, "record")
		)
			throw new Error("Stored source snapshot envelope is malformed");
		const snapshot = SourceSnapshotSchema.parse(envelope.record);
		if (recordHash(snapshot) !== envelope.recordHash)
			throw new Error("Stored source snapshot content hash is invalid");
		const withoutHash = { ...snapshot } as Record<string, unknown>;
		delete withoutHash.snapshotHash;
		if (recordHash(withoutHash) !== snapshot.snapshotHash)
			throw new Error("Stored source snapshot hash is invalid");
		return snapshot;
	}

	#readAuthoringAttemptEnvelope(
		input: unknown,
		authoringId: string,
	): AuthoringAttemptRecord {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("Stored authoring attempt envelope is malformed");
		const envelope = input as Record<string, unknown>;
		const attempt = AuthoringAttemptRecordSchema.parse(envelope.record);
		if (
			attempt.authoringId !== authoringId ||
			recordHash(attempt) !== envelope.recordHash
		)
			throw new Error("Stored authoring attempt binding or hash is invalid");
		return attempt;
	}

	async writeCandidateOrigin(
		originInput: import("@roveproof/contracts").RunOrigin,
	): Promise<void> {
		await this.initialize();
		const origin = RunOriginSchema.parse(originInput);
		const filePath = this.#originPath(origin.runId);
		await writeExclusive(filePath, origin, this.artifactRoot);
		await chmod(filePath, 0o400);
	}

	async writeCandidateRecord(recordInput: CandidateRecord): Promise<void> {
		await this.initialize();
		const record = CandidateRecordSchema.parse(recordInput);
		const filePath = this.#candidateRecordPath(record.candidateId);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(record),
			this.artifactRoot,
		);
	}

	async readCandidateRecord(
		candidateIdInput: string,
	): Promise<CandidateRecord> {
		await this.initialize();
		const candidateId = EntityIdSchema.parse(candidateIdInput);
		try {
			const input = (await readUnknown(
				this.#candidateRecordPath(candidateId),
				this.artifactRoot,
			)) as { record?: unknown; recordHash?: unknown; schemaVersion?: unknown };
			if (
				input.schemaVersion !== 1 ||
				typeof input.recordHash !== "string" ||
				recordHash(input.record) !== input.recordHash
			)
				throw new Error("Stored candidate record hash is invalid");
			const record = CandidateRecordSchema.parse(input.record);
			if (record.candidateId !== candidateId)
				throw new Error("Stored candidate record path binding is invalid");
			return record;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new CandidateNotFoundError(candidateId);
			throw error;
		}
	}

	async transitionCandidateState(
		candidateIdInput: string,
		to: RunState,
	): Promise<CandidateRecord> {
		await this.initialize();
		const candidateId = EntityIdSchema.parse(candidateIdInput);
		const record = await this.readCandidateRecord(candidateId);
		const origin = RunOriginSchema.parse(
			await readUnknown(this.#originPath(record.runId), this.artifactRoot),
		);
		validateStateTransitionForOrigin(origin, {
			schemaVersion: SCHEMA_VERSION,
			jobId: record.jobId,
			runId: record.runId,
			mode: record.mode,
			from: record.state,
			to,
		});
		const next = CandidateRecordSchema.parse({ ...record, state: to });
		await replaceAtomic(
			this.#candidateRecordPath(candidateId),
			this.#hashedEnvelope(next),
			this.artifactRoot,
		);
		return next;
	}

	async writeVerificationReport(
		reportInput: VerificationReport,
	): Promise<void> {
		await this.initialize();
		const report = VerificationReportSchema.parse(reportInput);
		const filePath = this.#verificationReportPath(report.candidateId);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(report),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
	}

	async readVerificationReport(
		candidateIdInput: string,
	): Promise<VerificationReport> {
		await this.initialize();
		const candidateId = EntityIdSchema.parse(candidateIdInput);
		try {
			const input = (await readUnknown(
				this.#verificationReportPath(candidateId),
				this.artifactRoot,
			)) as { record?: unknown; recordHash?: unknown; schemaVersion?: unknown };
			if (
				input.schemaVersion !== 1 ||
				typeof input.recordHash !== "string" ||
				recordHash(input.record) !== input.recordHash
			)
				throw new Error("Stored verification report hash is invalid");
			const report = VerificationReportSchema.parse(input.record);
			if (report.candidateId !== candidateId)
				throw new Error("Stored verification report path binding is invalid");
			return report;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new CandidateNotFoundError(candidateId);
			throw error;
		}
	}

	async writeApprovalDecision(
		originInput: unknown,
		candidateInput: CandidateRecord,
		decisionInput: unknown,
	): Promise<ApprovalDecision> {
		await this.initialize();
		const decision = validateApprovalForCandidate(
			originInput,
			candidateInput,
			decisionInput,
		);
		const filePath = this.#approvalDecisionPath(candidateInput.candidateId);
		await writeExclusive(
			filePath,
			this.#hashedEnvelope(decision),
			this.artifactRoot,
		);
		await chmod(filePath, 0o400);
		return decision;
	}

	async readApprovalDecision(
		candidateIdInput: string,
	): Promise<ApprovalDecision> {
		await this.initialize();
		const candidateId = EntityIdSchema.parse(candidateIdInput);
		try {
			const input = (await readUnknown(
				this.#approvalDecisionPath(candidateId),
				this.artifactRoot,
			)) as { record?: unknown; recordHash?: unknown; schemaVersion?: unknown };
			if (
				input.schemaVersion !== 1 ||
				typeof input.recordHash !== "string" ||
				recordHash(input.record) !== input.recordHash
			)
				throw new Error("Stored approval decision hash is invalid");
			const decision = ApprovalDecisionSchema.parse(input.record);
			if (decision.candidateId !== candidateId)
				throw new Error("Stored approval decision path binding is invalid");
			return decision;
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				throw new CandidateNotFoundError(candidateId);
			throw error;
		}
	}

	#candidateRecordPath(candidateId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"candidate-records",
			candidateId + ".json",
		);
	}

	#verificationReportPath(candidateId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"verification-reports",
			candidateId + ".json",
		);
	}

	#approvalDecisionPath(candidateId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"approval-decisions",
			candidateId + ".json",
		);
	}
	#candidateDirectory(candidateId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"candidates",
			candidateId,
		);
	}

	#sourceSnapshotPath(snapshotHash: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"source-snapshots",
			`${snapshotHash}.json`,
		);
	}

	#authoringAttemptPath(authoringId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"authoring-attempts",
			`${authoringId}.json`,
		);
	}

	#sandboxControlPath(controlHash: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"sandbox-controls",
			`${controlHash}.json`,
		);
	}

	#sandboxEvidencePath(evidenceHash: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"sandbox-evidence",
			`${evidenceHash}.json`,
		);
	}

	#sandboxResultPath(resultHash: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"sandbox-results",
			`${resultHash}.json`,
		);
	}

	#repairStatusPath(candidateId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"repair-status",
			`${candidateId}.json`,
		);
	}

	#testFailureDiffPath(proofKey: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"test-failure-proofs",
			`${proofKey}.diff`,
		);
	}

	#analysisPath(analysisId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"analyses",
			`${analysisId}.json`,
		);
	}

	#analysisAttemptPath(analysisId: string, attempt: 1 | 2): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"analysis-attempts",
			analysisId,
			`${attempt}.json`,
		);
	}

	#candidatePath(candidateId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"candidates",
			candidateId,
			"envelope.json",
		);
	}

	#testFailureProofPath(proofKey: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"test-failure-proofs",
			`${proofKey}.json`,
		);
	}

	#jobPath(jobId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"jobs",
			`${jobId}.json`,
		);
	}

	#eventsPath(jobId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"events",
			`${jobId}.jsonl`,
		);
	}

	#originPath(runId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"origins",
			`${runId}.json`,
		);
	}

	#snapshotPath(jobId: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"snapshots",
			`${jobId}.json`,
		);
	}

	#idempotencyPath(keyHash: string): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"idempotency",
			`${keyHash}.json`,
		);
	}

	#latestPath(): string {
		return path.join(
			/* turbopackIgnore: true */ this.artifactRoot,
			"latest-job.json",
		);
	}
}

export function resolveArtifactRoot(repositoryRootInput: string): string {
	return path.join(
		/* turbopackIgnore: true */ path.resolve(repositoryRootInput),
		"var",
		"roveproof",
	);
}
