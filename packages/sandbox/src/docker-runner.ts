import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	M5_CANDIDATE_COMMAND_ARGV,
	M5_CANDIDATE_COMMAND_ARGV_DIGEST,
	M5_CANDIDATE_COMMAND_ID,
	M5_INSPECTED_IMAGE,
	M5_TEST_COMMAND_ARGV,
	M5_TEST_COMMAND_ARGV_DIGEST,
	M5_TEST_COMMAND_ID,
	SandboxCommandEvidenceSchema,
	SandboxControlSchema,
	SandboxResultSchema,
	Sha256Schema,
	type SandboxClassification,
	type SandboxCommandEvidence,
	type SandboxControl,
	type SandboxResult,
} from "@roveproof/contracts";
import {
	canonicalDiffPath,
	containsCredentialPattern,
	DiffPolicyError,
} from "./diff-policy.js";
import { classifySandboxObservation } from "./result-classifier.js";

export const DOCKER_IMAGE_PATTERN =
	/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/;
export const DOCKER_NETWORK_POLICY = "none" as const;
export const DOCKER_PULL_POLICY = "never" as const;
export const DOCKER_RESOURCE_LIMITS = Object.freeze({
	pidsLimit: 128,
	memory: "2g",
	cpus: "2",
	stopTimeout: 2,
	timeoutMs: 120_000,
	workTmpfs: "/work:rw,nosuid,nodev,size=512m",
	tempTmpfs: "/tmp:rw,nosuid,nodev,size=128m",
} as const);

export const FIXED_SANDBOX_COMMANDS = Object.freeze({
	[M5_TEST_COMMAND_ID]: Object.freeze({
		argv: M5_TEST_COMMAND_ARGV,
		argvDigest: M5_TEST_COMMAND_ARGV_DIGEST,
		timeoutMs: DOCKER_RESOURCE_LIMITS.timeoutMs,
		stage: "test-proof" as const,
	}),
	[M5_CANDIDATE_COMMAND_ID]: Object.freeze({
		argv: M5_CANDIDATE_COMMAND_ARGV,
		argvDigest: M5_CANDIDATE_COMMAND_ARGV_DIGEST,
		timeoutMs: DOCKER_RESOURCE_LIMITS.timeoutMs,
		stage: "combined" as const,
	}),
} as const);
export type SandboxCommandId = keyof typeof FIXED_SANDBOX_COMMANDS;

export type DockerProcessRequest = Readonly<{
	executable: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	stdin?: string | Uint8Array | null;
}>;

export type DockerProcessResult = Readonly<{
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	durationMs: number;
	spawnErrorCode: string | null;
	terminationFailed: boolean;
	outputLimitExceeded: boolean;
}>;
export type DockerProcessRunner = (
	request: DockerProcessRequest,
) => Promise<DockerProcessResult>;
export type ExportedSandboxFile = Readonly<{
	path: string;
	size: number;
	sha256: string;
}>;

export type DockerRunOptions = Readonly<{
	image: string;
	projectionDirectory: string;
	exportDirectory: string;
	commandId: SandboxCommandId;
	/** Required for an operational M5 candidate; absent only for legacy fixed-command probes. */
	control?: SandboxControl;
	dockerExecutable?: string;
	parentEnvironment?: NodeJS.ProcessEnv;
	temporaryRoot?: string;
	repositoryRoot?: string;
	runner?: DockerProcessRunner;
	timeoutMs?: number;
}>;

export type DockerRunResult = Readonly<{
	status: "PASS" | "REJECTED" | "INCONCLUSIVE";
	evidence: SandboxCommandEvidence;
	result: SandboxResult | null;
	/** Null in the strict control path: the candidate never selects argv. */
	argv: readonly string[] | null;
	exportedFiles: readonly ExportedSandboxFile[];
}>;

const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
	"OPENAI_API_KEY",
	"CODEX_API_KEY",
	"CODEX_ACCESS_TOKEN",
]);
const MAX_EXPORT_FILES = 8;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const REQUIRED_DOCKER_FLAGS = [
	"--pull",
	"--network",
	"--read-only",
	"--init",
	"--cap-drop",
	"--security-opt",
	"--pids-limit",
	"--memory",
	"--cpus",
	"--stop-timeout",
	"--mount",
	"--tmpfs",
	"--entrypoint",
] as const;

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
function parseImage(image: string): { repository: string; digest: string } {
	if (!DOCKER_IMAGE_PATTERN.test(image))
		throw new DiffPolicyError(
			"Docker image must be pinned by an immutable sha256 digest",
		);
	const at = image.lastIndexOf("@sha256:");
	const digest = image.slice(at + 8);
	Sha256Schema.parse(digest);
	return { repository: image.slice(0, at), digest };
}
async function assertDirectory(
	directoryInput: string,
	label: string,
	create = false,
): Promise<string> {
	const directory = path.resolve(directoryInput);
	if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
	const metadata = await lstat(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink())
		throw new DiffPolicyError(`${label} must be a real directory`);
	return realpath(directory);
}
function isContained(parent: string, child: string, strict = false): boolean {
	const relative = path.relative(parent, child);
	if (relative === "") return !strict;
	return (
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	);
}
function disjoint(left: string, right: string): boolean {
	return !isContained(left, right) && !isContained(right, left);
}
async function assertTemporaryRoot(rootInput: string): Promise<string> {
	const root = await assertDirectory(rootInput, "Docker temporary root");
	const system = await assertDirectory(os.tmpdir(), "System temporary root");
	if (!isContained(system, root, true))
		throw new DiffPolicyError(
			"Docker temporary root must be a trusted child of system temporary storage",
		);
	return root;
}
async function assertSandboxDirectories(
	options: DockerRunOptions,
): Promise<{
	temporaryRoot: string;
	projectionDirectory: string;
	exportDirectory: string;
}> {
	if (!options.temporaryRoot)
		throw new DiffPolicyError("Docker temporary root is required");
	const temporaryRoot = await assertTemporaryRoot(options.temporaryRoot);
	const projectionDirectory = await assertDirectory(
		options.projectionDirectory,
		"Docker projection",
	);
	const exportDirectory = await assertDirectory(
		options.exportDirectory,
		"Docker export",
		true,
	);
	if (
		!isContained(temporaryRoot, projectionDirectory, true) ||
		!isContained(temporaryRoot, exportDirectory, true)
	)
		throw new DiffPolicyError(
			"Docker mounts must be contained by the trusted temporary root",
		);
	if (!disjoint(projectionDirectory, exportDirectory))
		throw new DiffPolicyError("Docker projection and export must be disjoint");
	if (options.repositoryRoot) {
		const repositoryRoot = await assertDirectory(
			options.repositoryRoot,
			"Docker repository root",
		);
		if (
			!disjoint(repositoryRoot, projectionDirectory) ||
			!disjoint(repositoryRoot, exportDirectory)
		)
			throw new DiffPolicyError(
				"Docker mounts cannot be inside the repository root",
			);
	}
	return { temporaryRoot, projectionDirectory, exportDirectory };
}
async function assertSymlinkFreeTree(
	directory: string,
	label: string,
): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isSymbolicLink())
			throw new DiffPolicyError(`${label} contains a symbolic link`);
		if (entry.isDirectory()) await assertSymlinkFreeTree(entryPath, label);
		else {
			if (!entry.isFile())
				throw new DiffPolicyError(`${label} contains a special file`);
			const metadata = await lstat(entryPath);
			if (metadata.nlink > 1)
				throw new DiffPolicyError(`${label} contains a hard link`);
		}
	}
}
function assertNoSecretEnvironment(environment: NodeJS.ProcessEnv): void {
	for (const key of FORBIDDEN_ENVIRONMENT_KEYS)
		if (Object.prototype.hasOwnProperty.call(environment, key))
			throw new DiffPolicyError(
				`candidate environment contains forbidden ${key}`,
			);
}
function dockerEnvironment(
	parent: NodeJS.ProcessEnv,
	dockerExecutable: string,
): NodeJS.ProcessEnv {
	const inheritedPath = parent.PATH ?? parent.Path ?? parent.path ?? "";
	const cliDirectory = path.isAbsolute(dockerExecutable)
		? path.dirname(dockerExecutable)
		: null;
	const platform =
		process.platform === "win32"
			? [
					"C:\\Program Files\\Docker\\Docker\\resources\\bin",
					"C:\\ProgramData\\DockerDesktop\\version-bin",
				]
			: ["/usr/local/bin", "/usr/bin", "/bin"];
	return {
		PATH: [
			...new Set([
				...(cliDirectory ? [cliDirectory] : []),
				...platform,
				...inheritedPath.split(path.delimiter).filter(Boolean),
			]),
		].join(path.delimiter),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		SystemRoot: parent.SystemRoot,
		WINDIR: parent.WINDIR,
	};
}

async function killProcessTree(pid: number | undefined): Promise<boolean> {
	if (!pid) return false;
	try {
		if (process.platform === "win32") {
			const killer = spawn(
				path.join(
					process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
					"System32",
					"taskkill.exe",
				),
				["/pid", String(pid), "/T", "/F"],
				{ shell: false, windowsHide: true, stdio: "ignore" },
			);
			return await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					killer.kill("SIGKILL");
					resolve(true);
				}, 5_000);
				timer.unref();
				killer.once("error", () => {
					clearTimeout(timer);
					resolve(true);
				});
				killer.once("close", (code, signal) => {
					clearTimeout(timer);
					resolve(code !== 0 || signal !== null);
				});
			});
		}
		process.kill(-pid, "SIGKILL");
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export const runDockerProcess: DockerProcessRunner = async (request) => {
	const startedAt = performance.now();
	let timedOut = false;
	let spawnErrorCode: string | null = null;
	let outputLimitExceeded = false;
	let terminationRequested = false;
	let terminationPromise: Promise<boolean> | null = null;
	let stdoutBytes = 0;
	let stderrBytes = 0;
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const child = spawn(request.executable, [...request.args], {
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
		terminationPromise = killProcessTree(child.pid);
	};
	child.stdout.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
		if (stdoutBytes > 8 * 1024 * 1024) {
			outputLimitExceeded = true;
			terminate();
		} else stdout.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes > 1024 * 1024) {
			outputLimitExceeded = true;
			terminate();
		} else stderr.push(chunk);
	});
	child.once("error", (error: NodeJS.ErrnoException) => {
		spawnErrorCode = error.code ?? "UNKNOWN";
	});
	if (request.stdin !== undefined && request.stdin !== null)
		child.stdin.end(Buffer.from(request.stdin));
	else child.stdin.end();
	const timeout = setTimeout(() => {
		timedOut = true;
		terminate();
	}, request.timeoutMs);
	timeout.unref();
	const result = await new Promise<{
		exitCode: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) =>
		child.once("close", (exitCode, signal) => resolve({ exitCode, signal })),
	);
	clearTimeout(timeout);
	const terminationFailed = terminationPromise
		? await terminationPromise
		: false;
	return {
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8"),
		...result,
		timedOut,
		durationMs: Math.max(0, performance.now() - startedAt),
		spawnErrorCode,
		terminationFailed,
		outputLimitExceeded,
	};
};

function processSuccessful(result: DockerProcessResult): boolean {
	return (
		result.exitCode === 0 &&
		result.signal === null &&
		!result.timedOut &&
		!result.terminationFailed &&
		!result.outputLimitExceeded &&
		result.spawnErrorCode === null
	);
}
function preflightError(result: DockerProcessResult): string | null {
	if (result.terminationFailed) return "DOCKER_WATCHDOG_TERMINATION_FAILED";
	if (result.timedOut || result.outputLimitExceeded) return null;
	if (result.spawnErrorCode !== null) return "DOCKER_CLI_SPAWN_FAILED";
	if (
		result.exitCode === 125 ||
		result.exitCode === 126 ||
		result.exitCode === 127
	)
		return `DOCKER_RUN_INFRASTRUCTURE_EXIT_${result.exitCode}`;
	return null;
}
function requiredFlagsAvailable(help: string, strict: boolean): boolean {
	const required = strict
		? REQUIRED_DOCKER_FLAGS
		: REQUIRED_DOCKER_FLAGS.filter((flag) => flag !== "--entrypoint");
	return required.every((flag) => help.includes(flag));
}
function fixedDockerArgs(
	image: string,
	projectionDirectory: string,
	exportDirectory: string,
): string[] {
	return [
		"run",
		"--rm",
		"--interactive",
		"--pull=never",
		"--network",
		"none",
		"--read-only",
		"--init",
		"--cap-drop",
		"ALL",
		"--security-opt=no-new-privileges",
		"--pids-limit",
		String(DOCKER_RESOURCE_LIMITS.pidsLimit),
		"--memory",
		DOCKER_RESOURCE_LIMITS.memory,
		"--cpus",
		DOCKER_RESOURCE_LIMITS.cpus,
		"--stop-timeout",
		String(DOCKER_RESOURCE_LIMITS.stopTimeout),
		"--mount",
		`type=bind,src=${projectionDirectory},dst=/input,readonly`,
		"--mount",
		`type=bind,src=${exportDirectory},dst=/export`,
		"--tmpfs",
		DOCKER_RESOURCE_LIMITS.workTmpfs,
		"--tmpfs",
		DOCKER_RESOURCE_LIMITS.tempTmpfs,
		"--tmpfs",
		"/home/roveproof:rw,nosuid,nodev,size=32m",
		"--env",
		"HOME=/home/roveproof",
		"--env",
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"--env",
		"LANG=C.UTF-8",
		"--env",
		"LC_ALL=C.UTF-8",
		"--env",
		"NODE_OPTIONS=",
		"--workdir",
		"/work",
		"--entrypoint",
		"node",
		image,
		`/input/${"scripts/roveproof-sandbox-runner.mjs"}`,
	];
}
async function admitExport(
	exportDirectory: string,
	strict: boolean,
): Promise<ExportedSandboxFile[]> {
	const files: ExportedSandboxFile[] = [];
	let total = 0;
	async function visit(
		directory: string,
		relativeDirectory: string,
	): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			const relative = relativeDirectory
				? `${relativeDirectory}/${entry.name}`
				: entry.name;
			const safe = canonicalDiffPath(relative);
			const absolute = path.join(exportDirectory, ...safe.split("/"));
			if (entry.isSymbolicLink())
				throw new DiffPolicyError("sandbox export contains a symbolic link");
			if (entry.isDirectory()) await visit(absolute, safe);
			else {
				if (!entry.isFile())
					throw new DiffPolicyError("sandbox export contains a special file");
				if (files.length >= MAX_EXPORT_FILES)
					throw new DiffPolicyError("sandbox export file budget exceeded");
				const metadata = await lstat(absolute);
				if (metadata.nlink > 1 || metadata.size > MAX_EXPORT_BYTES)
					throw new DiffPolicyError("sandbox export file exceeds policy");
				total += metadata.size;
				if (total > MAX_EXPORT_BYTES)
					throw new DiffPolicyError("sandbox export byte budget exceeded");
				const bytes = await readFile(absolute);
				if (containsCredentialPattern(bytes.toString("utf8")))
					throw new DiffPolicyError(
						"sandbox export contains a credential pattern",
					);
				files.push({ path: safe, size: metadata.size, sha256: sha256(bytes) });
			}
		}
	}
	await visit(exportDirectory, "");
	if (strict && (files.length !== 1 || files[0]?.path !== "result.json"))
		throw new DiffPolicyError(
			"sandbox export must contain exactly result.json",
		);
	return files;
}
function evidenceHash(input: Record<string, unknown>): string {
	return sha256(canonical(input));
}
function makeEvidence(
	input: Readonly<{
		commandId: SandboxCommandId;
		stage: "test-proof" | "combined";
		image: string;
		timeoutMs: number;
		result: SandboxResult | null;
		classification: SandboxClassification;
		controlHash: string;
		toolingRevision: string;
		exportedFiles: readonly ExportedSandboxFile[];
		infrastructureError: string | null;
		exportViolation?: string | null;
		durationMs: number;
	}>,
): SandboxCommandEvidence {
	const result = input.result;
	const base: Record<string, unknown> = {
		schemaVersion: 1,
		recordVersion: "sandbox-command-v1",
		stage: input.stage,
		commandId: input.commandId,
		classification: input.classification,
		argvDigest: FIXED_SANDBOX_COMMANDS[input.commandId].argvDigest,
		image: input.image,
		network: "none",
		readOnlyRoot: true,
		pullPolicy: "never",
		capabilitiesDropped: "ALL",
		noNewPrivileges: true,
		pidsLimit: DOCKER_RESOURCE_LIMITS.pidsLimit,
		memoryLimit: DOCKER_RESOURCE_LIMITS.memory,
		cpuLimit: DOCKER_RESOURCE_LIMITS.cpus,
		timeoutMs: input.timeoutMs,
		started: result?.started ?? false,
		exitCode: result?.exitCode ?? null,
		signal: result?.signal ?? null,
		timedOut: result?.timedOut ?? false,
		outputLimitExceeded: result?.outputLimitExceeded ?? false,
		resourceLimitExceeded: result?.resourceLimitExceeded ?? false,
		setupError: result?.setupError ?? null,
		protocolError: result?.protocolError ?? null,
		patchApplyError: result?.patchApplyError ?? null,
		secretDetected: result?.secretDetected ?? false,
		infrastructureError:
			input.infrastructureError ?? result?.infrastructureError ?? null,
		exportViolation: input.exportViolation ?? result?.exportViolation ?? null,
		stdoutSha256: result?.stdoutSha256 ?? sha256(""),
		stderrSha256: result?.stderrSha256 ?? sha256(""),
		toolingRevision: input.toolingRevision,
		controlHash: input.controlHash,
		resultHash: result?.resultHash ?? sha256(""),
		evidenceHash: "0".repeat(64),
		durationMs: input.durationMs,
		exportedFiles: input.exportedFiles,
	};
	base.evidenceHash = evidenceHash({ ...base, evidenceHash: undefined });
	delete base.evidenceHash;
	const withoutHash = { ...base };
	const parsed = SandboxCommandEvidenceSchema.parse({
		...withoutHash,
		evidenceHash: evidenceHash(withoutHash),
	});
	return parsed;
}
function emptyResultEvidence(
	commandId: SandboxCommandId,
	stage: "test-proof" | "combined",
	image: string,
	timeoutMs: number,
	controlHash: string,
	error: string,
	classification: SandboxClassification = "INFRASTRUCTURE_UNAVAILABLE",
	toolingRevision = "0".repeat(64),
): SandboxCommandEvidence {
	return makeEvidence({
		commandId,
		stage,
		image: DOCKER_IMAGE_PATTERN.test(image) ? image : M5_INSPECTED_IMAGE,
		timeoutMs,
		result: null,
		classification,
		controlHash,
		toolingRevision,
		exportedFiles: [],
		infrastructureError:
			classification === "INFRASTRUCTURE_UNAVAILABLE" ? error : null,
		durationMs: 0,
	});
}

export type DockerPrerequisiteResult = Readonly<{
	ok: boolean;
	error: string | null;
}>;
export async function checkDockerPrerequisites(
	options: Readonly<{
		cwd: string;
		image?: string;
		dockerExecutable?: string;
		parentEnvironment?: NodeJS.ProcessEnv;
		runner?: DockerProcessRunner;
	}>,
): Promise<DockerPrerequisiteResult> {
	try {
		const cwd = await assertDirectory(options.cwd, "Docker working directory");
		const parent = options.parentEnvironment ?? process.env;
		assertNoSecretEnvironment(parent);
		const executable = options.dockerExecutable ?? "docker";
		const environment = dockerEnvironment(parent, executable);
		const runner = options.runner ?? runDockerProcess;
		const info = await runner({
			executable,
			args: ["info", "--format", "{{.ServerVersion}}"],
			cwd,
			env: environment,
			timeoutMs: 10_000,
		});
		if (!processSuccessful(info))
			return { ok: false, error: "DOCKER_ENGINE_UNAVAILABLE" };
		const help = await runner({
			executable,
			args: ["run", "--help"],
			cwd,
			env: environment,
			timeoutMs: 10_000,
		});
		if (
			!processSuccessful(help) ||
			!requiredFlagsAvailable(help.stdout + help.stderr, Boolean(options.image))
		)
			return { ok: false, error: "DOCKER_REQUIRED_FLAG_UNAVAILABLE" };
		if (options.image) {
			const image = parseImage(options.image);
			const inspect = await runner({
				executable,
				args: [
					"image",
					"inspect",
					"--format",
					"{{json .RepoDigests}}",
					options.image,
				],
				cwd,
				env: environment,
				timeoutMs: 10_000,
			});
			if (
				!processSuccessful(inspect) ||
				!(inspect.stdout + inspect.stderr).includes(
					`${image.repository}@sha256:${image.digest}`,
				)
			)
				return { ok: false, error: "DOCKER_IMAGE_DIGEST_UNAVAILABLE" };
		}
		return { ok: true, error: null };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof DiffPolicyError
					? "DOCKER_INPUT_POLICY_REJECTED"
					: "DOCKER_PREFLIGHT_FAILED",
		};
	}
}

export async function runDockerCandidate(
	options: DockerRunOptions,
): Promise<DockerRunResult> {
	const command = FIXED_SANDBOX_COMMANDS[options.commandId];
	const timeoutMs = options.timeoutMs ?? command.timeoutMs;
	const strict = options.control !== undefined;
	let control: SandboxControl | null = null;
	if (strict) {
		try {
			control = SandboxControlSchema.parse(options.control);
		} catch {
			return {
				status: "REJECTED",
				evidence: emptyResultEvidence(
					options.commandId,
					command.stage,
					options.image,
					timeoutMs,
					sha256(""),
					"CONTROL_INVALID",
					"CONTROL_INVALID",
				),
				result: null,
				argv: null,
				exportedFiles: [],
			};
		}
		if (
			control.commandId !== options.commandId ||
			control.stage !== command.stage
		)
			return {
				status: "REJECTED",
				evidence: emptyResultEvidence(
					options.commandId,
					command.stage,
					options.image,
					timeoutMs,
					control.controlHash,
					"CONTROL_INVALID",
					"CONTROL_INVALID",
				),
				result: null,
				argv: null,
				exportedFiles: [],
			};
	}
	const controlHash = control?.controlHash ?? sha256("");
	try {
		parseImage(options.image);
	} catch {
		return {
			status: "INCONCLUSIVE",
			evidence: emptyResultEvidence(
				options.commandId,
				command.stage,
				options.image,
				timeoutMs,
				controlHash,
				"DOCKER_IMAGE_UNPINNED",
			),
			result: null,
			argv: null,
			exportedFiles: [],
		};
	}
	if (strict && options.image !== M5_INSPECTED_IMAGE)
		return {
			status: "INCONCLUSIVE",
			evidence: emptyResultEvidence(
				options.commandId,
				command.stage,
				options.image,
				timeoutMs,
				controlHash,
				"DOCKER_IMAGE_DIGEST_MISMATCH",
			),
			result: null,
			argv: null,
			exportedFiles: [],
		};
	try {
		const directories = await assertSandboxDirectories(options);
		if (
			[
				directories.projectionDirectory,
				directories.exportDirectory,
				directories.temporaryRoot,
			].some((directory) => /[\r\n,]/.test(directory))
		)
			throw new DiffPolicyError(
				"Docker mount path contains an unsafe delimiter",
			);
		await assertSymlinkFreeTree(
			directories.projectionDirectory,
			"Docker projection",
		);
		await assertSymlinkFreeTree(directories.exportDirectory, "Docker export");
		const parent = options.parentEnvironment ?? process.env;
		assertNoSecretEnvironment(parent);
		const executable = options.dockerExecutable ?? "docker";
		const environment = dockerEnvironment(parent, executable);
		const runner = options.runner ?? runDockerProcess;
		const info = await runner({
			executable,
			args: ["info", "--format", "{{.ServerVersion}}"],
			cwd: directories.projectionDirectory,
			env: environment,
			timeoutMs: 10_000,
		});
		if (!processSuccessful(info))
			return {
				status: "INCONCLUSIVE",
				evidence: emptyResultEvidence(
					options.commandId,
					command.stage,
					options.image,
					timeoutMs,
					controlHash,
					"DOCKER_ENGINE_UNAVAILABLE",
				),
				result: null,
				argv: null,
				exportedFiles: [],
			};
		const help = await runner({
			executable,
			args: ["run", "--help"],
			cwd: directories.projectionDirectory,
			env: environment,
			timeoutMs: 10_000,
		});
		if (
			!processSuccessful(help) ||
			!requiredFlagsAvailable(help.stdout + help.stderr, strict)
		)
			return {
				status: "INCONCLUSIVE",
				evidence: emptyResultEvidence(
					options.commandId,
					command.stage,
					options.image,
					timeoutMs,
					controlHash,
					"DOCKER_REQUIRED_FLAG_UNAVAILABLE",
				),
				result: null,
				argv: null,
				exportedFiles: [],
			};
		if (strict) {
			const inspect = await runner({
				executable,
				args: [
					"image",
					"inspect",
					"--format",
					"{{json .RepoDigests}}",
					options.image,
				],
				cwd: directories.projectionDirectory,
				env: environment,
				timeoutMs: 10_000,
			});
			if (
				!processSuccessful(inspect) ||
				!(inspect.stdout + inspect.stderr).includes(options.image)
			)
				return {
					status: "INCONCLUSIVE",
					evidence: emptyResultEvidence(
						options.commandId,
						command.stage,
						options.image,
						timeoutMs,
						controlHash,
						"DOCKER_IMAGE_DIGEST_UNAVAILABLE",
					),
					result: null,
					argv: null,
					exportedFiles: [],
				};
		}
		const args = fixedDockerArgs(
			options.image,
			directories.projectionDirectory,
			directories.exportDirectory,
		);
		const processResult = await runner({
			executable,
			args,
			cwd: directories.projectionDirectory,
			env: environment,
			timeoutMs,
			stdin: strict ? JSON.stringify(control) : null,
		});
		const infra = preflightError(processResult);
		if (infra !== null)
			return {
				status: "INCONCLUSIVE",
				evidence: emptyResultEvidence(
					options.commandId,
					command.stage,
					options.image,
					timeoutMs,
					controlHash,
					infra,
				),
				result: null,
				argv: null,
				exportedFiles: [],
			};
		let exportedFiles: ExportedSandboxFile[] = [];
		let exportError: string | null = null;
		let result: SandboxResult | null = null;
		try {
			exportedFiles = await admitExport(directories.exportDirectory, strict);
			if (strict) {
				const resultFile = path.join(
					directories.exportDirectory,
					"result.json",
				);
				result = SandboxResultSchema.parse(
					JSON.parse((await readFile(resultFile)).toString("utf8")) as unknown,
				);
				if (
					result.controlHash !== controlHash ||
					result.stage !== command.stage ||
					result.commandId !== options.commandId
				)
					throw new DiffPolicyError("sandbox result control binding mismatch");
			}
		} catch (error) {
			exportError =
				error instanceof Error
					? error.message.slice(0, 256)
					: "EXPORT_POLICY_REJECTED";
		}
		if (strict && result && control) {
			const expectedAppliedDiffHash =
				control.stage === "test-proof"
					? control.testDiffHash
					: control.combinedDiffHash;
			if (
				result.controlHash !== control.controlHash ||
				result.stage !== command.stage ||
				result.commandId !== options.commandId ||
				result.appliedDiffHash !== expectedAppliedDiffHash ||
				result.started !== true
			) {
				throw new DiffPolicyError(
					"sandbox result control, stage, start, or applied-diff binding mismatch",
				);
			}
			const observedClassification = classifySandboxObservation({
				stage: result.stage,
				started: result.started,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				outputLimitExceeded: result.outputLimitExceeded,
				resourceLimitExceeded: result.resourceLimitExceeded,
				setupError: result.setupError,
				protocolError: result.protocolError,
				patchApplyError: result.patchApplyError,
				exportViolation: result.exportViolation,
				secretDetected: result.secretDetected,
				infrastructureError: result.infrastructureError,
				matchedExpectedFailure: result.matchedExpectedFailure,
			});
			if (
				(observedClassification === "EXPECTED_FAILURE" &&
					(result.exitCode !== 1 ||
						!result.matchedExpectedFailure ||
						result.observedFailureHash === null)) ||
				(observedClassification === "CANDIDATE_PASS" &&
					(result.exitCode !== 0 ||
						result.matchedExpectedFailure ||
						result.observedFailureHash !== null))
			) {
				throw new DiffPolicyError(
					`sandbox result process/classification prerequisites are inconsistent: ${observedClassification}`,
				);
			}
		}
		const observedResult =
			strict && result
				? result
				: (() => {
						const base = {
							schemaVersion: 1 as const,
							recordVersion: "sandbox-result-v1" as const,
							stage: command.stage,
							commandId: options.commandId,
							controlHash,
							started: true,
							exitCode: processResult.exitCode,
							signal: processResult.signal,
							timedOut: processResult.timedOut,
							outputLimitExceeded: processResult.outputLimitExceeded,
							resourceLimitExceeded: processResult.exitCode === 137,
							setupError: null,
							protocolError:
								strict &&
								result === null &&
								exportError !== null &&
								!exportError.startsWith("sandbox export must contain")
									? exportError
									: null,
							patchApplyError: null,
							exportViolation:
								strict && exportError?.startsWith("sandbox export must contain")
									? exportError
									: null,
							secretDetected: false,
							infrastructureError: null,
							stdoutSha256: sha256(processResult.stdout),
							stderrSha256: sha256(processResult.stderr),
							appliedDiffHash: null,
							matchedExpectedFailure: false,
							observedFailureHash: null,
						};
						return SandboxResultSchema.parse({
							...base,
							resultHash: sha256(canonical(base)),
						});
					})();
		const classification = classifySandboxObservation({
			stage: observedResult.stage,
			started: observedResult.started,
			exitCode: observedResult.exitCode,
			signal: observedResult.signal,
			timedOut: observedResult.timedOut,
			outputLimitExceeded: observedResult.outputLimitExceeded,
			resourceLimitExceeded: observedResult.resourceLimitExceeded,
			setupError: observedResult.setupError,
			protocolError: observedResult.protocolError,
			patchApplyError: observedResult.patchApplyError,
			exportViolation: exportError ?? observedResult.exportViolation,
			secretDetected: observedResult.secretDetected,
			infrastructureError: observedResult.infrastructureError,
			matchedExpectedFailure: observedResult.matchedExpectedFailure,
		});
		const evidence = makeEvidence({
			commandId: options.commandId,
			stage: command.stage,
			image: options.image,
			timeoutMs,
			result: observedResult,
			classification,
			controlHash,
			toolingRevision: control?.toolingRevision ?? "0".repeat(64),
			exportedFiles,
			infrastructureError: null,
			exportViolation: observedResult.exportViolation,
			durationMs: processResult.durationMs,
		});
		const status = strict
			? [
					"INFRASTRUCTURE_UNAVAILABLE",
					"PROTOCOL_FAILURE",
					"TEST_TIMEOUT",
					"TEST_RESOURCE_LIMIT",
					"TEST_OUTPUT_LIMIT",
					"CANDIDATE_TIMEOUT",
					"CANDIDATE_RESOURCE_LIMIT",
					"CANDIDATE_OUTPUT_LIMIT",
				].includes(classification)
				? "INCONCLUSIVE"
				: classification === "EXPECTED_FAILURE" ||
						classification === "CANDIDATE_PASS"
					? "PASS"
					: "REJECTED"
			: classification === "CANDIDATE_PASS" &&
					exportError === null &&
					!processResult.timedOut &&
					!processResult.outputLimitExceeded &&
					!processResult.terminationFailed
				? "PASS"
				: "REJECTED";
		return {
			status,
			evidence,
			result: strict ? result : observedResult,
			argv: strict ? null : command.argv,
			exportedFiles,
		};
	} catch (error) {
		const code =
			error instanceof DiffPolicyError
				? "DOCKER_INPUT_POLICY_REJECTED"
				: "DOCKER_PREFLIGHT_FAILED";
		return {
			status: "INCONCLUSIVE",
			evidence: emptyResultEvidence(
				options.commandId,
				command.stage,
				options.image,
				timeoutMs,
				controlHash,
				code,
			),
			result: null,
			argv: null,
			exportedFiles: [],
		};
	}
}

export async function clearSandboxExport(
	exportDirectory: string,
): Promise<void> {
	const directory = await assertDirectory(exportDirectory, "Docker export");
	const entries = await readdir(directory);
	await Promise.all(
		entries.map((entry) =>
			rm(path.join(directory, entry), { recursive: true, force: true }),
		),
	);
	await chmod(directory, 0o700);
}
