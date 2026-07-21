import { randomUUID } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright";
import {
	EVIDENCE_REQUIRED_ARTIFACTS,
	JOURNEY_ID,
	SCHEMA_VERSION,
	SEED_IDS,
	type EvidenceManifest,
	type EvidenceMetrics,
	type EvidenceResult,
	type JourneyAssertions,
} from "@roveproof/contracts";
import {
	DATA_CLASSIFICATION,
	EvidenceBundleWriter,
	redactText,
	redactUrl,
	REDACTION_POLICY,
	REDACTION_SCOPE,
	sanitizeHar,
	type AdmittedEvidenceBundle,
} from "@roveproof/evidence";
import { BrowserLogCollector, NetworkCollector } from "./collectors.js";
import { FIXED_RUN_CONFIG, PLAYWRIGHT_VERSION } from "./config.js";
import {
	DeterministicJitterController,
	unavailableJitterEvidence,
} from "./jitter.js";
import {
	evaluateBaselineOracle,
	evaluateVerificationOracle,
	executeCheckoutJourney,
	type CheckoutObservation,
} from "./oracle.js";
import {
	applyMeasuredProfile,
	browserContextOptions,
	profileDeviations,
	readRuntimeObservation,
	unavailableProfilePreflight,
	verifyBrowserProfile,
} from "./profile.js";

export type BaselineRunOptions = Readonly<{
	artifactRoot: string;
	targetUrl: string;
	sourceRevision: string;
	runId?: string;
	headless?: boolean;
	/** Evidence run kind; "verification" binds the candidate diff hash and uses the clean-success oracle. */
	kind?: "baseline" | "verification";
	/** The candidate combined diff hash bound to a verification evidence manifest (null for baseline). */
	candidateDiffHash?: string | null;
	/** Optional provider for the durable orderId created during a verification journey. */
	orderIdProvider?: () => Promise<string | null>;
}>;

export type BaselineRunOutput = Readonly<{
	runId: string;
	bundle: AdmittedEvidenceBundle;
}>;

class InconclusiveRunError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "InconclusiveRunError";
		this.code = code;
	}
}

function fixedTargetUrl(input: string): URL {
	const url = new URL(input);
	const loopback =
		url.hostname === "127.0.0.1" ||
		url.hostname === "localhost" ||
		url.hostname === "[::1]";
	if (
		url.protocol !== "http:" ||
		!loopback ||
		url.pathname !== "/checkout" ||
		url.search ||
		url.hash ||
		url.username ||
		url.password
	) {
		throw new Error(
			"The Milestone 2 runner accepts only the fixed loopback /checkout target",
		);
	}
	return url;
}

function safeDiagnostic(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactText(message)
		.replace(/[a-zA-Z]:\\[^\r\n"']+/g, "[LOCAL_PATH]")
		.replace(/\/(?:home|Users)\/[^\s"']+/g, "[LOCAL_PATH]")
		.slice(0, 600);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function sanitizeHarFile(harPath: string): Promise<void> {
	const input = JSON.parse(await readFile(harPath, "utf8")) as unknown;
	const sanitized = sanitizeHar(input);
	await writeFile(harPath, `${JSON.stringify(sanitized)}\n`, {
		encoding: "utf8",
		flag: "w",
		mode: 0o600,
	});
}

function unavailableObservation(): CheckoutObservation {
	return {
		recommendationReady: false,
		recommendationSeedHeader: null,
		mononymSeedVisible: false,
		phoneSeedVisible: false,
		keyboardOrderValid: false,
		touchSubmissionCompleted: false,
		accessibleStructure: false,
		noHorizontalOverflow: false,
		addressValuesPreserved: false,
		idrTotalVisible: false,
		confirmationVisible: false,
		vitals: { lcpMs: null, inpMs: null, cls: null },
	};
}

function inconclusiveRecords(options: {
	runId: string;
	code: string;
	message: string;
	durationMs: number;
	transferredBytes: number;
	observation: CheckoutObservation;
}): { result: EvidenceResult; assertions: JourneyAssertions } {
	return {
		result: {
			schemaVersion: SCHEMA_VERSION,
			runId: options.runId,
			verdict: "INCONCLUSIVE",
			firstCausalFailure: {
				code: options.code,
				message: options.message,
				artifactRefs: ["manifest.json", "console.jsonl", "requests.jsonl"],
			},
			task: {
				completed: false,
				durationMs: options.durationMs,
				orderId: null,
				durableOrderCount: 0,
			},
			performance: {
				transferredBytes: options.transferredBytes,
				measurement:
					"sum of one terminal CDP Network.loadingFinished encodedDataLength per target response within monotonic journey boundaries",
				lcpMs: options.observation.vitals.lcpMs,
				inpMs: options.observation.vitals.inpMs,
				cls: options.observation.vitals.cls,
			},
			sampleCount: 1,
		},
		assertions: {
			schemaVersion: SCHEMA_VERSION,
			runId: options.runId,
			journeyId: JOURNEY_ID,
			expectedSeedIds: [...SEED_IDS],
			observedSeedIds: [],
			assertions: [
				{
					id: "runner.evidence-inconclusive",
					status: "FAIL",
					message: options.message,
					artifactRefs: ["manifest.json", "console.jsonl", "requests.jsonl"],
				},
			],
		},
	};
}

export type EgressGuard = Readonly<{ violations: string[] }>;

function websocketBelongsToTarget(websocketUrl: URL, target: URL): boolean {
	const expectedProtocol = target.protocol === "https:" ? "wss:" : "ws:";
	return (
		websocketUrl.protocol === expectedProtocol &&
		websocketUrl.host === target.host
	);
}

export async function installEgressGuard(
	context: BrowserContext,
	targetOrigin: string,
): Promise<EgressGuard> {
	const target = new URL(targetOrigin);
	const violations: string[] = [];
	const recordViolation = (url: string) => {
		const redacted = redactUrl(url);
		if (!violations.includes(redacted)) violations.push(redacted);
	};

	await context.route("**/*", async (route) => {
		const requestUrl = new URL(route.request().url());
		if (
			(requestUrl.protocol === "http:" || requestUrl.protocol === "https:") &&
			requestUrl.origin !== target.origin
		) {
			recordViolation(requestUrl.toString());
			await route.abort("blockedbyclient");
			return;
		}
		await route.continue();
	});
	await context.routeWebSocket(/.*/, (websocket) => {
		const websocketUrl = new URL(websocket.url());
		if (websocketBelongsToTarget(websocketUrl, target)) {
			websocket.connectToServer();
			return;
		}
		recordViolation(websocketUrl.toString());
		websocket.close({
			code: 1008,
			reason: "Roveproof blocks non-target WebSocket egress",
		});
	});

	return { violations };
}

export async function runBaseline(
	options: BaselineRunOptions,
): Promise<BaselineRunOutput> {
	const target = fixedTargetUrl(options.targetUrl);
	const targetOrigin = target.origin;
	const runId = options.runId ?? `run-${randomUUID()}`;
	const writer = await EvidenceBundleWriter.create(options.artifactRoot, runId);
	const startedAt = new Date().toISOString();

	const startScreenshotPath = await writer.artifactPath(
		"screenshots/00-start.png",
	);
	const terminalScreenshotPath = await writer.artifactPath(
		"screenshots/failure-or-confirmation.png",
	);
	const tracePath = await writer.artifactPath("trace.zip");
	const harPath = await writer.artifactPath("network.har");

	let browser: Browser | undefined;
	let context: BrowserContext | undefined;
	let page: Page | undefined;
	let profile = unavailableProfilePreflight(
		"Browser profile verification did not run",
	);
	let browserVersion: string | null = null;
	let measuredRuleId: string | null = null;
	let measuredRuleMatched = false;
	let measuredObserved = profile.observed;
	let measuredUserAgent: string | null = null;
	let jitter = unavailableJitterEvidence();
	let jitterController: DeterministicJitterController | undefined;
	let traceStarted = false;
	let boundaryStartedAt = startedAt;
	let boundaryCompletedAt = startedAt;
	let boundaryStarted = 0;
	let durationMs = 0;
	let boundaryActive = false;
	let observation = unavailableObservation();
	let networkCollector: NetworkCollector | undefined;
	let egressGuard: EgressGuard | undefined;
	const logs = new BrowserLogCollector();
	let runError: unknown;
	let resultAndAssertions:
		| ReturnType<typeof inconclusiveRecords>
		| ReturnType<typeof evaluateBaselineOracle>
		| ReturnType<typeof evaluateVerificationOracle>
		| undefined;
	const deviations: string[] = [];

	const recordError = (error: unknown) => {
		if (runError === undefined) runError = error;
		const message = safeDiagnostic(error);
		if (message && !deviations.includes(message)) deviations.push(message);
	};

	try {
		browser = await chromium.launch({ headless: options.headless ?? true });
		browserVersion = browser.version();
		try {
			profile = await verifyBrowserProfile(browser, targetOrigin);
		} catch (error) {
			profile = unavailableProfilePreflight(
				`Profile verification failed: ${safeDiagnostic(error)}`,
			);
		}
		measuredObserved = profile.observed;
		measuredUserAgent = profile.userAgent;
		deviations.push(...profile.deviations);
		if (!profile.verified) {
			throw new InconclusiveRunError(
				"PROFILE_CONSTRAINTS_UNVERIFIED",
				"Chromium CPU, network, or mobile profile constraints could not be verified.",
			);
		}

		context = await browser.newContext({
			...browserContextOptions(),
			recordHar: { path: harPath, content: "omit", mode: "full" },
		});
		egressGuard = await installEgressGuard(context, targetOrigin);
		page = await context.newPage();
		const session = await context.newCDPSession(page);
		networkCollector = new NetworkCollector(session, targetOrigin);
		logs.attach(page);
		const applied = await applyMeasuredProfile(session, page);
		measuredRuleId = applied.ruleId;

		await context.tracing.start({
			screenshots: true,
			snapshots: true,
			sources: false,
		});
		traceStarted = true;
		networkCollector.beginBoundary(measuredRuleId);
		logs.beginBoundary();
		boundaryStarted = performance.now();
		boundaryStartedAt = new Date().toISOString();
		boundaryActive = true;
		jitterController = new DeterministicJitterController(
			session,
			networkCollector,
		);
		await jitterController.start(boundaryStarted);

		observation = await executeCheckoutJourney({
			page,
			checkoutUrl: target.toString(),
			startScreenshotPath,
		});
		if (egressGuard.violations.length > 0) {
			deviations.push(
				...egressGuard.violations.map(
					(url) => `Blocked non-target browser egress: ${url}`,
				),
			);
			throw new InconclusiveRunError(
				"NON_TARGET_EGRESS_BLOCKED",
				"The target attempted a browser connection outside its fixed origin.",
			);
		}
		jitter = await jitterController.finish();
		if (!(await networkCollector.waitForIdle(2_000))) {
			throw new InconclusiveRunError(
				"NETWORK_REQUESTS_IN_FLIGHT",
				"Target requests remained in flight after the terminal oracle.",
			);
		}
		durationMs = performance.now() - boundaryStarted;
		boundaryCompletedAt = new Date().toISOString();
		networkCollector.stopBoundary();
		logs.stopBoundary();
		boundaryActive = false;
		await page.screenshot({ path: terminalScreenshotPath, fullPage: true });

		const measured = await readRuntimeObservation(
			page,
			networkCollector.acceptLanguage,
		);
		measuredObserved = measured.observed;
		measuredUserAgent = measured.userAgent;
		const measuredDeviations = profileDeviations(
			measuredObserved,
			observation.touchSubmissionCompleted,
		);
		measuredRuleMatched = networkCollector.allRequestsMatchedAppliedRules;
		if (!measuredRuleMatched)
			measuredDeviations.push(
				"One or more measured target responses did not carry an applied network rule ID",
			);
		if (networkCollector.redirectObserved)
			measuredDeviations.push(
				"A redirect occurred inside the fixed measurement boundary",
			);
		if (networkCollector.servedFromCache)
			measuredDeviations.push("A measured response was served from cache");
		deviations.push(...measuredDeviations);
		if (measuredDeviations.length > 0) {
			throw new InconclusiveRunError(
				"MEASURED_PROFILE_MISMATCH",
				"Measured browser or network evidence did not match the frozen profile.",
			);
		}

		const oracleInput = {
			runId,
			observation,
			requests: networkCollector.requests,
			durationMs,
			transferredBytes: networkCollector.transferredBytes,
			failedRequestCount: networkCollector.failedRequestCount,
			consoleErrorCount: logs.consoleErrorCount,
			pageErrorCount: logs.pageErrorCount,
		};
		if (options.kind === "verification") {
			const orderId = options.orderIdProvider
				? ((await options.orderIdProvider()) ?? null)
				: null;
			resultAndAssertions = evaluateVerificationOracle(oracleInput, orderId);
		} else {
			resultAndAssertions = evaluateBaselineOracle(oracleInput);
		}
	} catch (error) {
		recordError(error);
	} finally {
		if (boundaryActive) {
			durationMs =
				boundaryStarted > 0 ? performance.now() - boundaryStarted : 0;
			boundaryCompletedAt = new Date().toISOString();
			networkCollector?.stopBoundary();
			logs.stopBoundary();
			boundaryActive = false;
		}
		if (jitterController && !jitter.completed) {
			try {
				jitter = await jitterController.cancel();
			} catch (error) {
				recordError(error);
			}
		}
		if (traceStarted && context) {
			try {
				await context.tracing.stop({ path: tracePath });
			} catch (error) {
				recordError(error);
				await rm(tracePath, { force: true });
			}
		}
		if (context) {
			try {
				await context.close();
			} catch (error) {
				recordError(error);
			}
		}
		if (await fileExists(harPath)) {
			try {
				await sanitizeHarFile(harPath);
			} catch (error) {
				recordError(error);
				await rm(harPath, { force: true });
			}
		}
		if (browser) {
			try {
				await browser.close();
			} catch (error) {
				recordError(error);
			}
		}
	}

	if (egressGuard && egressGuard.violations.length > 0) {
		for (const url of egressGuard.violations) {
			const deviation = `Blocked non-target browser egress: ${url}`;
			if (!deviations.includes(deviation)) deviations.push(deviation);
		}
		if (runError === undefined) {
			runError = new InconclusiveRunError(
				"NON_TARGET_EGRESS_BLOCKED",
				"The target attempted a browser connection outside its fixed origin.",
			);
		}
	}

	const requestEvidence = networkCollector?.requests ?? [];
	await writer.writeJsonLines("console.jsonl", logs.messages);
	await writer.writeJsonLines("requests.jsonl", requestEvidence);

	if (runError !== undefined || !resultAndAssertions) {
		const code =
			runError instanceof InconclusiveRunError
				? runError.code
				: "RUNNER_INCONCLUSIVE";
		const diagnostic =
			runError instanceof InconclusiveRunError
				? runError.message
				: "The browser run or evidence collection did not complete reliably.";
		resultAndAssertions = inconclusiveRecords({
			runId,
			code,
			message: diagnostic,
			durationMs,
			transferredBytes: networkCollector?.transferredBytes ?? 0,
			observation,
		});
	}

	const metrics: EvidenceMetrics = {
		schemaVersion: SCHEMA_VERSION,
		runId,
		boundary: {
			clock: "node:performance.now",
			startedAt: boundaryStartedAt,
			completedAt: boundaryCompletedAt,
			durationMs,
		},
		transferredBytes: networkCollector?.transferredBytes ?? 0,
		requestCount: requestEvidence.length,
		failedRequestCount: networkCollector?.failedRequestCount ?? 0,
		consoleErrorCount: logs.consoleErrorCount,
		pageErrorCount: logs.pageErrorCount,
		lcpMs: observation.vitals.lcpMs,
		inpMs: observation.vitals.inpMs,
		cls: observation.vitals.cls,
	};

	const plannedMetadata = new Set([
		"manifest.json",
		"result.json",
		"assertions.json",
		"metrics.json",
	]);
	const missingArtifacts: EvidenceManifest["missingArtifacts"] = [];
	for (const artifactPath of EVIDENCE_REQUIRED_ARTIFACTS) {
		const present =
			plannedMetadata.has(artifactPath) ||
			(await fileExists(
				path.join(writer.stagingDirectory, ...artifactPath.split("/")),
			));
		if (!present)
			missingArtifacts.push({
				path: artifactPath,
				reason:
					"Artifact was unavailable because the run became inconclusive before collection completed.",
			});
	}

	const profileVerified =
		runError === undefined &&
		profile.verified &&
		measuredRuleMatched &&
		jitter.completed &&
		profileDeviations(measuredObserved, observation.touchSubmissionCompleted)
			.length === 0;
	const manifest: EvidenceManifest = {
		schemaVersion: SCHEMA_VERSION,
		runId,
		kind: options.kind ?? "baseline",
		mode: "real",
		targetId: FIXED_RUN_CONFIG.targetId,
		journeyId: FIXED_RUN_CONFIG.journeyId,
		profileId: FIXED_RUN_CONFIG.profileId,
		seedIds: [...FIXED_RUN_CONFIG.seedIds],
		sourceRevision: options.sourceRevision,
		candidateDiffHash: options.candidateDiffHash ?? null,
		startedAt,
		completedAt: new Date().toISOString(),
		runtime: {
			playwrightVersion: PLAYWRIGHT_VERSION,
			browser: "chromium",
			browserVersion,
			userAgent: measuredUserAgent ?? profile.userAgent,
			observed: measuredObserved,
			touch: {
				requested: true,
				pointerEventObserved: observation.touchSubmissionCompleted,
				verified:
					(measuredObserved.maxTouchPoints ?? 0) > 0 ||
					observation.touchSubmissionCompleted,
			},
			cpu: profile.cpu,
			network: {
				...profile.network,
				measuredRuleId,
				measuredRuleMatched,
				verified: profile.network.verified && measuredRuleMatched,
			},
			jitter,
			profileVerified,
		},
		redaction: {
			policy: REDACTION_POLICY,
			scope: REDACTION_SCOPE,
			dataClassification: DATA_CLASSIFICATION,
			verified: true,
		},
		missingArtifacts,
		deviations: [...new Set(deviations)],
	};

	if (
		missingArtifacts.length > 0 &&
		resultAndAssertions.result.verdict !== "INCONCLUSIVE"
	) {
		resultAndAssertions = inconclusiveRecords({
			runId,
			code: "REQUIRED_ARTIFACT_MISSING",
			message:
				"One or more required evidence artifacts could not be collected.",
			durationMs,
			transferredBytes: metrics.transferredBytes,
			observation,
		});
	}

	const bundle = await writer.finalize({
		manifest,
		result: resultAndAssertions.result,
		assertions: resultAndAssertions.assertions,
		metrics,
	});
	return { runId, bundle };
}
