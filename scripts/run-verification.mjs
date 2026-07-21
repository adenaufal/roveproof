import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CandidateRecordSchema,
	JOURNEY_ID,
	PROFILE_ID,
	RunOriginSchema,
	SEED_IDS,
	TARGET_ID,
	VerificationReportSchema,
	hashVerificationReport,
} from "../packages/contracts/dist/index.js";
import {
	CandidateNotFoundError,
	FileControlStore,
	resolveArtifactRoot,
} from "../packages/store/dist/index.js";

const repositoryRoot = path.dirname(
	path.dirname(fileURLToPath(import.meta.url)),
);

function parseArgs(argv) {
	const values = new Map();
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!flag?.startsWith("--") || !value || value.startsWith("--"))
			throw new Error(`Unknown or incomplete argument: ${flag ?? ""}`);
		if (values.has(flag)) throw new Error(`${flag} may be supplied only once`);
		values.set(flag, value);
		i += 1;
	}
	if (!values.has("--candidate-id"))
		throw new Error("An explicit --candidate-id is required");
	return {
		candidateId: values.get("--candidate-id"),
		image: values.get("--image") ?? "roveproof-verifier:local",
	};
}

const { candidateId, image } = parseArgs(process.argv.slice(2));
const store = new FileControlStore(resolveArtifactRoot(repositoryRoot));
await store.initialize();
let exportDir = null;

try {
	// 1. Re-read the persisted M5 candidate with a matching terminal PASS status.
	const env = await store.readCandidateEnvelope(candidateId, {
		requireTerminalStatus: true,
	});
	const candidateDir = path.join(store.artifactRoot, "candidates", candidateId);
	const combinedBytes = await readFile(
		path.join(candidateDir, env.combinedDiffArtifact.artifactPath),
	);

	// 2. Create — or resume — the M6 candidate record + immutable origin. The write-once record
	//    can already exist in VERIFYING_CLEAN if a previous container run was interrupted; a re-run
	//    then completes the milestone instead of conflicting on the exclusive write.
	let record = null;
	try {
		record = await store.readCandidateRecord(candidateId);
	} catch (error) {
		if (!(error instanceof CandidateNotFoundError)) throw error;
	}
	let verificationRunId;
	if (record) {
		verificationRunId = record.runId;
		if (record.state === "SANDBOX_GATING") {
			await store.transitionCandidateState(
				candidateId,
				"VERIFYING_CLEAN",
				"resuming independent verification",
				() => new Date(),
			);
		} else if (record.state !== "VERIFYING_CLEAN") {
			throw new Error(
				`candidate ${candidateId} is in ${record.state}; verification expects SANDBOX_GATING or VERIFYING_CLEAN`,
			);
		}
	} else {
		verificationRunId = `run-verify-${randomUUID()}`;
		const origin = RunOriginSchema.parse({
			schemaVersion: 1,
			jobId: "job-verification",
			runId: verificationRunId,
			mode: "real",
			targetId: TARGET_ID,
			journeyId: JOURNEY_ID,
			profileId: PROFILE_ID,
			seedIds: [...SEED_IDS],
		});
		await store.writeCandidateOrigin(origin);
		await store.writeCandidateRecord(
			CandidateRecordSchema.parse({
				schemaVersion: 1,
				candidateId,
				jobId: origin.jobId,
				runId: origin.runId,
				baselineRunId: env.baselineRunId,
				mode: "real",
				diffHash: env.combinedDiffHash,
				state: "SANDBOX_GATING",
			}),
		);
		// 3. Independent in-container verification. Candidate code is applied and
		//    executed only inside the container (--network none); host dist + runner
		//    are mounted read-only (pure JS, no native binaries).
		await store.transitionCandidateState(
			candidateId,
			"VERIFYING_CLEAN",
			"independent verifier workspace started",
			() => new Date(),
		);
	}
	exportDir = await mkdtemp(path.join(os.tmpdir(), "roveproof-verify-export-"));
	const control = {
		schemaVersion: 1,
		candidateId,
		baselineRunId: env.baselineRunId,
		verificationRunId,
		sourceRevision: env.sourceRevision,
		combinedDiffBase64: combinedBytes.toString("base64"),
		combinedDiffHash: env.combinedDiffHash,
	};
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
		image,
		"/roveproof/scripts/roveproof-verifier-runner.mjs",
	];
	const docker = spawnSync("docker", args, {
		encoding: "utf8",
		shell: process.platform === "win32",
		input: JSON.stringify(control),
		timeout: 600_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (docker.status !== 0)
		throw new Error(
			`verifier container exited ${docker.status}: ${(docker.stderr || "").slice(0, 500)}`,
		);
	const summary = JSON.parse(
		await readFile(path.join(exportDir, "verification-summary.json"), "utf8"),
	);
	if (summary.error) throw new Error(`verifier error: ${summary.error}`);

	// 4. Build the immutable verification report (before/after, budgets, verdict).
	const beforeEvidenceRef = `runs/${env.baselineRunId}/manifest.json`;
	const afterEvidenceRef = summary.evidenceDir
		? `${summary.evidenceDir}/manifest.json`
		: null;
	const journeyPass =
		summary.journeyVerdict === "PASS" && summary.unitVerdict === "PASS";
	const reportInput = {
		schemaVersion: 1,
		recordVersion: "verification-report-v1",
		candidateId,
		baselineRunId: env.baselineRunId,
		combinedDiffHash: env.combinedDiffHash,
		sourceSnapshotHash: env.sourceSnapshotHash,
		verifierWorkspaceHash: env.sourceSnapshotHash,
		unitVerdict: summary.unitVerdict === "PASS" ? "PASS" : "INCONCLUSIVE",
		journeyVerdict: summary.journeyVerdict,
		verificationRunId: summary.verificationRunId,
		transferredBytes: summary.transferredBytes,
		durationMs: summary.durationMs,
		orderId: summary.orderId,
		durableOrderCount: summary.durableOrderCount,
		budgetEncodedBytes: 2_000_000,
		budgetDurationMs: 8_000,
		budgetPassed: Boolean(summary.budgetPassed),
		beforeEvidenceRef,
		afterEvidenceRef,
		createdAt: new Date().toISOString(),
	};
	const report = VerificationReportSchema.parse({
		...reportInput,
		reportHash: hashVerificationReport(reportInput),
	});
	await store.writeVerificationReport(report);

	// 5. Transition only a fully verified candidate to review-ready.
	if (journeyPass && report.journeyVerdict === "PASS") {
		await store.transitionCandidateState(
			candidateId,
			"READY_FOR_HUMAN_REVIEW",
			"independent verification passed: one order, budgets met, no seed failure",
			() => new Date(),
		);
		console.log(
			JSON.stringify(
				{
					status: "READY_FOR_HUMAN_REVIEW",
					candidateId,
					verificationRunId,
					unitVerdict: report.unitVerdict,
					journeyVerdict: report.journeyVerdict,
					transferredBytes: report.transferredBytes,
					durationMs: report.durationMs,
					orderId: report.orderId,
					budgetPassed: report.budgetPassed,
					report: `var/roveproof/verification-reports/${candidateId}.json`,
				},
				null,
				2,
			),
		);
	} else {
		await store.transitionCandidateState(
			candidateId,
			"REJECTED",
			"independent verification did not pass",
			() => new Date(),
		);
		console.log(
			JSON.stringify(
				{
					status: "REJECTED",
					candidateId,
					unitVerdict: report.unitVerdict,
					journeyVerdict: report.journeyVerdict,
					transferredBytes: report.transferredBytes,
					durationMs: report.durationMs,
					orderId: report.orderId,
					budgetPassed: report.budgetPassed,
				},
				null,
				2,
			),
		);
	}
} catch (error) {
	console.error(
		`INCONCLUSIVE ${error instanceof Error ? error.message : String(error)}`,
	);
	try {
		await store.transitionCandidateState(
			candidateId,
			"INCONCLUSIVE",
			`verification inconclusive: ${error instanceof Error ? error.message : "unknown"}`,
			() => new Date(),
		);
	} catch {}
} finally {
	if (exportDir)
		await rm(exportDir, { recursive: true, force: true }).catch(() => {});
}
