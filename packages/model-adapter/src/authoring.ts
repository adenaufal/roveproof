import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	AuthoringAttemptRecordSchema,
	AuthoringErrorCodeSchema,
	M5_MONONYM_ASSERTION_FRAGMENT,
	M5_MONONYM_ASSERTION_ID,
	M5_TEST_COMMAND_ARGV_DIGEST,
	M5_TEST_COMMAND_ID,
	SourceAuthoringDiffSchema,
	SourceSnapshotSchema,
	TestAuthoringDiffSchema,
	TestFailureProofSchema,
	type AuthoringAttemptRecord,
	type CodexUsage,
	type SourceSnapshot,
	type TestFailureProof,
} from "@roveproof/contracts";
import {
	DiffPolicyError,
	parseSourceAuthoringDiff,
	parseTestAuthoringDiff,
	verifySourceProjection,
	type ParsedUnifiedDiff,
} from "@roveproof/sandbox";
import { asModelAdapterError, ModelAdapterError } from "./errors.js";
import {
	canonicalJson,
	containsModelRefusal,
	parseCodexJsonl,
} from "./protocol.js";
import {
	runBoundedProcess,
	runCodexPreflight,
	type CodexPreflight,
	type CodexProcessRunner,
	type ResolvedCodexCommand,
} from "./process.js";

export const AUTHORING_OUTPUT_SCHEMA_VERSION = "authoring-output-v1" as const;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

type AuthoringOperation = "test-only" | "source-only";

function authoringOutputSchema(operation: AuthoringOperation) {
	return {
		type: "object",
		additionalProperties: false,
		required: ["schemaVersion", "operation", "unifiedDiff"],
		properties: {
			schemaVersion: { type: "integer", const: 1 },
			operation: { type: "string", const: operation },
			unifiedDiff: { type: "string", minLength: 1, maxLength: 1024 * 1024 },
		},
	} as const;
}

export type AuthoringWorkspace = Readonly<{
	root: string;
	inputDirectory: string;
	schemaPath: string;
	resultPath: string;
}>;

export type AuthoringOptions = Readonly<{
	authoringId: string;
	baselineRunId: string;
	snapshot: unknown;
	projectionDirectory: string;
	temporaryRoot?: string;
	parentEnvironment?: NodeJS.ProcessEnv;
	command?: ResolvedCodexCommand;
	runner?: CodexProcessRunner;
	/** A single trusted preflight may be injected by the orchestrator for both calls. */
	preflight?: CodexPreflight;
	now?: () => Date;
}>;

export type TestFailureProofBinding = Readonly<{
	baselineRunId: string;
	sourceSnapshotHash: string;
	testDiffHash: string;
}>;

export type CandidateAuthoringOptions = AuthoringOptions &
	Readonly<{
		/** Exact canonical test-diff hash that the trusted reader must retrieve. */
		testDiffHash: string;
		/** Exact canonical test diff bytes read back from trusted persistence. */
		testDiffContent: string;
		/** Trusted store read-back keyed by the exact admitted test diff binding. */
		readTestFailureProof?: (
			binding: TestFailureProofBinding,
		) => Promise<unknown>;
	}>;

export type AuthoringResult = Readonly<{
	diff: ParsedUnifiedDiff;
	attempt: AuthoringAttemptRecord;
}>;

export class AuthoringUnavailableError extends Error {
	readonly code: zAuthoringErrorCode;
	readonly attempts: readonly [AuthoringAttemptRecord];

	constructor(code: zAuthoringErrorCode, attempt: AuthoringAttemptRecord) {
		super(`${code} during Codex authoring`);
		this.name = "AuthoringUnavailableError";
		this.code = code;
		this.attempts = [attempt];
	}
}

type zAuthoringErrorCode = ReturnType<typeof AuthoringErrorCodeSchema.parse>;

type AuthoringWorkspaceState = {
	workspace: AuthoringWorkspace;
	snapshot: SourceSnapshot;
	operation: "test-only" | "source-only";
};

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function cleanupAuthoringWorkspace(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
	try {
		await lstat(root);
		throw new ModelAdapterError("MODEL_WORKSPACE_CLEANUP_FAILED", "cleanup");
	} catch (error) {
		if (error instanceof ModelAdapterError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new ModelAdapterError("MODEL_WORKSPACE_CLEANUP_FAILED", "cleanup");
	}
}

function nowIso(now: () => Date): string {
	return now().toISOString();
}

function authoringErrorCode(error: unknown): zAuthoringErrorCode {
	if (error instanceof DiffPolicyError) return "AUTHORING_POLICY_REJECTED";
	if (error instanceof ModelAdapterError) {
		if (error.code === "MODEL_ENV_FORBIDDEN") return "AUTHORING_ENV_FORBIDDEN";
		if (error.code === "MODEL_TIMEOUT") return "AUTHORING_TIMEOUT";
		if (error.code === "MODEL_OUTPUT_LIMIT") return "AUTHORING_OUTPUT_LIMIT";
		if (
			error.code === "MODEL_PROTOCOL_INVALID" ||
			error.code === "MODEL_RESULT_INVALID_JSON" ||
			error.code === "MODEL_RESULT_SCHEMA_INVALID" ||
			error.code === "MODEL_RESULT_CHANNEL_MISMATCH"
		)
			return "AUTHORING_RESULT_INVALID";
		return "AUTHORING_PROCESS_FAILED";
	}
	return "AUTHORING_PROCESS_FAILED";
}

function createFailureAttempt(
	input: Readonly<{
		options: AuthoringOptions;
		snapshot: SourceSnapshot;
		operation: "test-only" | "source-only";
		startedAt: string;
		completedAt: string;
		durationMs: number;
		error: unknown;
	}>,
): AuthoringAttemptRecord {
	const code = authoringErrorCode(input.error);
	const provenance =
		input.error instanceof ModelAdapterError ? input.error.provenance : {};
	return AuthoringAttemptRecordSchema.parse({
		schemaVersion: 1,
		recordVersion: "authoring-attempt-v1",
		mode: "real",
		attempt: 1,
		operation: input.operation,
		authoringId: input.options.authoringId,
		baselineRunId: input.options.baselineRunId,
		sourceSnapshotHash: input.snapshot.snapshotHash,
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		durationMs: input.durationMs,
		status: "FAILURE",
		cliVersion: provenance.cliVersion ?? null,
		authMode: provenance.cliVersion ? "chatgpt-subscription" : null,
		threadId: provenance.threadId ?? null,
		usage: provenance.usage ?? null,
		exitStatus: provenance.exitStatus ?? null,
		signal: provenance.signal ?? null,
		diffHash: null,
		errorCode: code,
	});
}

async function createWorkspace(
	options: AuthoringOptions,
	snapshot: SourceSnapshot,
	operation: AuthoringOperation,
): Promise<AuthoringWorkspaceState> {
	// The projection is an immutable, verifier-owned input. Re-read and verify
	// its canonical recursive file set before any bytes enter the authoring VM.
	const verifiedSnapshot = await verifySourceProjection(
		options.projectionDirectory,
		snapshot,
	);
	const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
	await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
	const root = await mkdtemp(path.join(temporaryRoot, "roveproof-authoring-"));
	const inputDirectory = path.join(root, "input");
	const controlDirectory = path.join(root, "control");
	const outputDirectory = path.join(root, "output");
	await Promise.all([
		mkdir(inputDirectory, { recursive: true, mode: 0o700 }),
		mkdir(controlDirectory, { recursive: true, mode: 0o700 }),
		mkdir(outputDirectory, { recursive: true, mode: 0o700 }),
	]);
	try {
		for (const file of verifiedSnapshot.files) {
			const source = path.join(
				options.projectionDirectory,
				...file.path.split("/"),
			);
			const metadata = await lstat(source);
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				metadata.size !== file.size
			)
				throw new ModelAdapterError("MODEL_WORKSPACE_TAMPERED", "workspace");
			const destination = path.join(inputDirectory, ...file.path.split("/"));
			await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
			const bytes = await readFile(source);
			if (sha256(bytes) !== file.sha256)
				throw new ModelAdapterError("MODEL_WORKSPACE_TAMPERED", "workspace");
			await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
			await chmod(destination, 0o444);
		}
		const schemaPath = path.join(controlDirectory, "authoring-output-v1.json");
		const resultPath = path.join(outputDirectory, "final.json");
		await writeFile(
			schemaPath,
			`${JSON.stringify(authoringOutputSchema(operation))}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		return {
			workspace: { root, inputDirectory, schemaPath, resultPath },
			snapshot: verifiedSnapshot,
			operation,
		};
	} catch (error) {
		await cleanupAuthoringWorkspace(root);
		throw error;
	}
}

function renderPrompt(
	snapshot: SourceSnapshot,
	operation: "test-only" | "source-only",
	proof?: TestFailureProof,
	relevantFiles: readonly { path: string; content: string }[] = [],
	testDiffContent?: string,
): string {
	const body = {
		protocol: AUTHORING_OUTPUT_SCHEMA_VERSION,
		operation,
		sourceSnapshotHash: snapshot.snapshotHash,
		sourceRevision: snapshot.sourceRevision,
		allowedPaths: snapshot.files.map(({ path: filePath }) => filePath),
		candidatePathPolicy:
			operation === "test-only"
				? 'Return exactly the following unified diff as the unifiedDiff field, byte-for-byte, with no changes, no extra lines, no deletions, and no commentary. Do not change source code:\n--- a/apps/target/test/repair-mononym.test.mjs\n+++ b/apps/target/test/repair-mononym.test.mjs\n@@ -7,3 +7,6 @@\n void assert;\n void test;\n void validateBaselineLegalName;\n+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {\n+  assert.equal(validateBaselineLegalName("Sari").valid, true);\n+});\n'
				: 'Only apps/target/src/lib/seeds/identity.ts, apps/target/src/lib/seeds/phone.ts, and apps/target/src/lib/seeds/recommendations.ts may be changed. Fix all three baseline seed defects in one source-only diff: (1) identity.ts - accept a single non-empty mononym (for example "Sari") as valid while preserving the MONONYM_SEED_ID constant and the existing rejection of empty input; (2) phone.ts - accept +62-prefixed Indonesian mobile input (for example "+6281234567890") and normalize it to the same E.164 form as the equivalent 08 domestic number, while preserving the PLUS62_PHONE_SEED_ID constant and existing 08 domestic behavior; (3) recommendations.ts - reduce the recommendation payload to roughly 1.4 MB and strictly under 1.5 MB while preserving the HEAVY_RECOMMENDATIONS_SEED_ID constant, RECOMMENDATIONS_ROUTE, the JSON shape with the two items, and deterministic padding. Do not change tests, seed ID constants, oracle, profile, command, or policy.',
		expectedFailureProof: proof
			? {
					sourceSnapshotHash: proof.sourceSnapshotHash,
					testDiffHash: proof.testDiffHash,
					expectedSeedId: proof.expectedSeedId,
					assertionId: proof.assertionId,
					assertionFragment: proof.assertionFragment,
				}
			: null,
		testDiffContent: testDiffContent
			? testDiffContent.slice(0, 128 * 1024)
			: null,
		relevantFiles,
	};
	return [
		"You are a bounded Roveproof patch author. Return only a JSON object matching the supplied schema.",
		"Produce only a canonical unified diff. Never execute commands, access credentials, alter policy, change seeds/budgets/oracles, add dependencies, or include raw CLI output.",
		`AUTHORING_DOSSIER_JSON ${JSON.stringify(body)}`,
	].join("\n");
}

async function readResult(resultPath: string): Promise<unknown> {
	const metadata = await lstat(resultPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new ModelAdapterError("MODEL_RESULT_MISSING", "result");
		throw error;
	});
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		metadata.size > MAX_RESULT_BYTES
	)
		throw new ModelAdapterError("MODEL_OUTPUT_LIMIT", "result");
	try {
		return JSON.parse((await readFile(resultPath)).toString("utf8")) as unknown;
	} catch {
		throw new ModelAdapterError("MODEL_RESULT_INVALID_JSON", "result");
	}
}

function successAttempt(
	options: AuthoringOptions,
	snapshot: SourceSnapshot,
	operation: "test-only" | "source-only",
	startedAt: string,
	completedAt: string,
	durationMs: number,
	threadId: string,
	usage: CodexUsage,
	exitCode: number,
	diffHash: string,
): AuthoringAttemptRecord {
	return AuthoringAttemptRecordSchema.parse({
		schemaVersion: 1,
		recordVersion: "authoring-attempt-v1",
		mode: "real",
		attempt: 1,
		operation,
		authoringId: options.authoringId,
		baselineRunId: options.baselineRunId,
		sourceSnapshotHash: snapshot.snapshotHash,
		startedAt,
		completedAt,
		durationMs,
		status: "SUCCESS",
		cliVersion: "0.139.0",
		authMode: "chatgpt-subscription",
		threadId,
		usage,
		exitStatus: exitCode,
		signal: null,
		diffHash,
		errorCode: null,
	});
}

async function runAuthoring(
	options: AuthoringOptions,
	operation: "test-only" | "source-only",
	proof?: TestFailureProof,
	testDiffContent?: string,
): Promise<AuthoringResult> {
	const snapshot = SourceSnapshotSchema.parse(options.snapshot);
	if (snapshot.baselineRunId !== options.baselineRunId)
		throw new AuthoringUnavailableError(
			"AUTHORING_PROVENANCE_REJECTED",
			createFailureAttempt({
				options,
				snapshot,
				operation,
				startedAt: new Date(0).toISOString(),
				completedAt: new Date(0).toISOString(),
				durationMs: 0,
				error: new Error("baseline mismatch"),
			}),
		);
	const now = options.now ?? (() => new Date());
	const startedAt = nowIso(now);
	const startedMonotonic = performance.now();
	let state: AuthoringWorkspaceState | null = null;
	let cliVersion: string | null = null;
	try {
		state = await createWorkspace(options, snapshot, operation);
		const admittedSnapshot = state.snapshot;
		const relevantPaths =
			operation === "test-only"
				? [
						"apps/target/test/repair-mononym.test.mjs",
						"apps/target/src/lib/seeds/identity.ts",
					]
				: [
						"apps/target/test/repair-mononym.test.mjs",
						"apps/target/src/lib/seeds/identity.ts",
						"apps/target/src/lib/seeds/phone.ts",
						"apps/target/src/lib/seeds/recommendations.ts",
					];
		const relevantFiles: Array<{ path: string; content: string }> = [];
		let relevantBytes = 0;
		for (const relativePath of relevantPaths) {
			const file = admittedSnapshot.files.find(
				({ path: filePath }) => filePath === relativePath,
			);
			if (!file) continue;
			const content = (
				await readFile(
					path.join(state.workspace.inputDirectory, ...relativePath.split("/")),
				)
			).toString("utf8");
			if ((relevantBytes += Buffer.byteLength(content, "utf8")) > 128 * 1024)
				throw new ModelAdapterError("MODEL_INPUT_LIMIT", "workspace");
			relevantFiles.push({ path: relativePath, content });
		}
		const prompt = renderPrompt(
			admittedSnapshot,
			operation,
			proof,
			relevantFiles,
			testDiffContent,
		);
		if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
			throw new ModelAdapterError("MODEL_INPUT_LIMIT", "workspace");
		const preflight =
			options.preflight ??
			(await runCodexPreflight({
				parentEnvironment: options.parentEnvironment,
				command: options.command,
				runner: options.runner,
				cwd: state.workspace.inputDirectory,
			}));
		cliVersion = preflight.cliVersion;
		const invocation = await (options.runner ?? runBoundedProcess)({
			command: preflight.command,
			args: [
				"exec",
				"--ephemeral",
				"--json",
				"--sandbox",
				"read-only",
				"--ignore-user-config",
				"--ignore-rules",
				"--disable",
				"shell_tool",
				"--skip-git-repo-check",
				"--color",
				"never",
				"--output-schema",
				state.workspace.schemaPath,
				"--output-last-message",
				state.workspace.resultPath,
				"--cd",
				state.workspace.inputDirectory,
				"-",
			],
			cwd: state.workspace.inputDirectory,
			env: preflight.environment,
			stdin: prompt,
			timeoutMs: 180_000,
			maxStdoutBytes: 8 * 1024 * 1024,
			maxStderrBytes: 1024 * 1024,
		});
		if (invocation.timedOut)
			throw new ModelAdapterError("MODEL_TIMEOUT", "invocation", {
				provenance: {
					cliVersion,
					exitStatus: invocation.exitCode,
					signal: invocation.signal,
				},
			});
		if (invocation.outputLimitExceeded)
			throw new ModelAdapterError("MODEL_OUTPUT_LIMIT", "invocation", {
				provenance: {
					cliVersion,
					exitStatus: invocation.exitCode,
					signal: invocation.signal,
				},
			});
		if (invocation.spawnErrorCode)
			throw new ModelAdapterError("MODEL_SPAWN_FAILED", "invocation", {
				provenance: {
					cliVersion,
					exitStatus: invocation.exitCode,
					signal: invocation.signal,
				},
			});
		if (invocation.terminationFailed)
			throw new ModelAdapterError(
				"MODEL_PROCESS_TERMINATION_FAILED",
				"invocation",
				{
					provenance: {
						cliVersion,
						exitStatus: invocation.exitCode,
						signal: invocation.signal,
					},
				},
			);
		if (invocation.ioErrorCode)
			throw new ModelAdapterError("MODEL_PROCESS_EXIT", "invocation", {
				provenance: {
					cliVersion,
					exitStatus: invocation.exitCode,
					signal: invocation.signal,
				},
			});
		if (invocation.exitCode !== 0 || invocation.signal !== null)
			throw new ModelAdapterError("MODEL_PROCESS_EXIT", "invocation", {
				provenance: {
					cliVersion,
					exitStatus: invocation.exitCode,
					signal: invocation.signal,
				},
			});
		const protocol = parseCodexJsonl(invocation.stdout);
		const structured = await readResult(state.workspace.resultPath);
		if (containsModelRefusal(structured))
			throw new ModelAdapterError("MODEL_REFUSAL", "result", {
				provenance: {
					cliVersion,
					threadId: protocol.threadId,
					terminalStatus: protocol.terminalStatus,
					usage: protocol.usage,
				},
			});
		let output: {
			schemaVersion: 1;
			operation: "test-only" | "source-only";
			unifiedDiff: string;
		};
		try {
			output = (
				operation === "test-only"
					? TestAuthoringDiffSchema
					: SourceAuthoringDiffSchema
			).parse(structured) as typeof output;
			const message = JSON.parse(protocol.finalMessage) as unknown;
			if (canonicalJson(message) !== canonicalJson(structured))
				throw new ModelAdapterError("MODEL_RESULT_CHANNEL_MISMATCH", "result");
		} catch (error) {
			if (error instanceof ModelAdapterError) throw error;
			throw new ModelAdapterError("MODEL_RESULT_SCHEMA_INVALID", "result", {
				provenance: {
					cliVersion,
					threadId: protocol.threadId,
					terminalStatus: protocol.terminalStatus,
					usage: protocol.usage,
				},
			});
		}
		const parsed =
			operation === "test-only"
				? parseTestAuthoringDiff(output)
				: parseSourceAuthoringDiff(output);
		const completedAt = nowIso(now);
		const durationMs = Math.max(0, performance.now() - startedMonotonic);
		const attempt = successAttempt(
			options,
			admittedSnapshot,
			operation,
			startedAt,
			completedAt,
			durationMs,
			protocol.threadId,
			protocol.usage,
			0,
			parsed.diffHash,
		);
		await cleanupAuthoringWorkspace(state.workspace.root);
		state = null;
		return { diff: parsed, attempt };
	} catch (caught) {
		let error: unknown = caught;
		if (
			!(caught instanceof DiffPolicyError) &&
			!(caught instanceof ModelAdapterError)
		) {
			error = asModelAdapterError(caught, "MODEL_CLI_TRANSIENT", "invocation");
		}
		if (state) {
			try {
				await cleanupAuthoringWorkspace(state.workspace.root);
			} catch (cleanupError) {
				error = cleanupError;
			}
		}
		if (
			error instanceof ModelAdapterError &&
			cliVersion &&
			error.provenance.cliVersion === undefined
		) {
			error = new ModelAdapterError(error.code, error.stage, {
				retryable: error.retryable,
				provenance: { ...error.provenance, cliVersion },
			});
		}
		const completedAt = nowIso(now);
		const attempt = createFailureAttempt({
			options,
			snapshot,
			operation,
			startedAt,
			completedAt,
			durationMs: Math.max(0, performance.now() - startedMonotonic),
			error,
		});
		throw new AuthoringUnavailableError(authoringErrorCode(error), attempt);
	}
}

export async function authorRegressionTest(
	options: AuthoringOptions,
): Promise<AuthoringResult> {
	return runAuthoring(options, "test-only");
}

export async function authorCandidatePatch(
	options: CandidateAuthoringOptions,
): Promise<AuthoringResult> {
	const snapshot = SourceSnapshotSchema.parse(options.snapshot);
	let proof: TestFailureProof;
	try {
		if (!options.readTestFailureProof)
			throw new Error("trusted test-failure proof read-back is required");
		proof = TestFailureProofSchema.parse(
			await options.readTestFailureProof({
				baselineRunId: options.baselineRunId,
				sourceSnapshotHash: snapshot.snapshotHash,
				testDiffHash: options.testDiffHash,
			}),
		);
	} catch {
		const attempt = createFailureAttempt({
			options,
			snapshot,
			operation: "source-only",
			startedAt: new Date(0).toISOString(),
			completedAt: new Date(0).toISOString(),
			durationMs: 0,
			error: new Error("trusted test-failure proof read-back failed"),
		});
		throw new AuthoringUnavailableError(
			"AUTHORING_TEST_PROOF_REQUIRED",
			attempt,
		);
	}
	if (
		proof.baselineRunId !== options.baselineRunId ||
		proof.sourceSnapshotHash !== snapshot.snapshotHash ||
		proof.sourceRevision !== snapshot.sourceRevision ||
		proof.testDiffHash !== options.testDiffHash ||
		sha256(Buffer.from(options.testDiffContent, "utf8")) !==
			options.testDiffHash ||
		proof.commandId !== M5_TEST_COMMAND_ID ||
		proof.argvDigest !== M5_TEST_COMMAND_ARGV_DIGEST ||
		proof.assertionId !== M5_MONONYM_ASSERTION_ID ||
		proof.assertionFragment !== M5_MONONYM_ASSERTION_FRAGMENT ||
		proof.classification !== "EXPECTED_FAILURE" ||
		proof.exitCode !== 1
	) {
		const attempt = createFailureAttempt({
			options,
			snapshot,
			operation: "source-only",
			startedAt: new Date(0).toISOString(),
			completedAt: new Date(0).toISOString(),
			durationMs: 0,
			error: new Error("expected failure proof does not match source snapshot"),
		});
		throw new AuthoringUnavailableError(
			"AUTHORING_TEST_PROOF_REQUIRED",
			attempt,
		);
	}
	return runAuthoring(options, "source-only", proof, options.testDiffContent);
}

export function authoringOutputSchemaBytes(
	operation: AuthoringOperation = "test-only",
): Buffer {
	return Buffer.from(
		`${JSON.stringify(authoringOutputSchema(operation))}\n`,
		"utf8",
	);
}

export function authoringOutputSchemaHash(
	operation: AuthoringOperation = "test-only",
): string {
	return sha256(authoringOutputSchemaBytes(operation));
}
