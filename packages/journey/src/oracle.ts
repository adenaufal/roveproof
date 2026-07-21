import type { Page } from "playwright";
import {
	JOURNEY_ID,
	SCHEMA_VERSION,
	SEED_IDS,
	type EvidenceResult,
	type JourneyAssertions,
} from "@roveproof/contracts";
import type { RequestEvidence } from "./collectors.js";
import { FIXED_RUN_CONFIG, SYNTHETIC_SHOPPER } from "./config.js";

const RECOMMENDATIONS_SEED_ID = "MOBILE-HEAVY-CHECKOUT-BUNDLE" as const;
const RECOMMENDATIONS_MINIMUM_BYTES = 8_000_000;

export type WebVitalsObservation = Readonly<{
	lcpMs: number | null;
	inpMs: number | null;
	cls: number | null;
}>;

export type CheckoutObservation = Readonly<{
	recommendationReady: boolean;
	recommendationSeedHeader: string | null;
	mononymSeedVisible: boolean;
	phoneSeedVisible: boolean;
	keyboardOrderValid: boolean;
	touchSubmissionCompleted: boolean;
	accessibleStructure: boolean;
	noHorizontalOverflow: boolean;
	addressValuesPreserved: boolean;
	idrTotalVisible: boolean;
	confirmationVisible: boolean;
	vitals: WebVitalsObservation;
}>;

export type BaselineOracleInput = Readonly<{
	runId: string;
	observation: CheckoutObservation;
	requests: readonly RequestEvidence[];
	durationMs: number;
	transferredBytes: number;
	failedRequestCount: number;
	consoleErrorCount: number;
	pageErrorCount: number;
}>;

function finiteMetric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

export async function executeCheckoutJourney(options: {
	page: Page;
	checkoutUrl: string;
	startScreenshotPath: string;
}): Promise<CheckoutObservation> {
	const { page } = options;
	await page.addInitScript(() => {
		const target = window as Window & {
			__roveproofVitals?: {
				lcpMs: number | null;
				inpMs: number | null;
				cls: number;
			};
		};
		target.__roveproofVitals = { lcpMs: null, inpMs: null, cls: 0 };
		try {
			new PerformanceObserver((list) => {
				const entries = list.getEntries();
				const last = entries.at(-1);
				if (last && target.__roveproofVitals)
					target.__roveproofVitals.lcpMs = last.startTime;
			}).observe({ type: "largest-contentful-paint", buffered: true });
		} catch {
			// The metric remains null and is reported honestly.
		}
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries() as Array<
					PerformanceEntry & { hadRecentInput?: boolean; value?: number }
				>) {
					if (
						!entry.hadRecentInput &&
						typeof entry.value === "number" &&
						target.__roveproofVitals
					) {
						target.__roveproofVitals.cls += entry.value;
					}
				}
			}).observe({ type: "layout-shift", buffered: true });
		} catch {
			// The metric remains at its initialized value.
		}
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries() as Array<
					PerformanceEntry & { duration: number; interactionId?: number }
				>) {
					if ((entry.interactionId ?? 0) > 0 && target.__roveproofVitals) {
						target.__roveproofVitals.inpMs = Math.max(
							target.__roveproofVitals.inpMs ?? 0,
							entry.duration,
						);
					}
				}
			}).observe({
				type: "event",
				buffered: true,
				durationThreshold: 16,
			} as PerformanceObserverInit & { durationThreshold: number });
		} catch {
			// INP remains null when Event Timing is unavailable.
		}
	});

	const recommendationResponse = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/recommendations",
		{ timeout: 45_000 },
	);
	await page.goto(options.checkoutUrl, {
		waitUntil: "domcontentloaded",
		timeout: 45_000,
	});
	await page
		.getByRole("heading", { name: "Ke mana pesanan ini dikirim?" })
		.waitFor({ state: "visible" });
	await page.screenshot({ path: options.startScreenshotPath, fullPage: true });

	const fullName = page.getByLabel("Nama lengkap");
	await fullName.focus();
	await page.keyboard.press("Tab");
	const keyboardOrderValid = await page.evaluate(
		() => (document.activeElement as HTMLElement | null)?.id === "phone",
	);

	await fullName.fill(SYNTHETIC_SHOPPER.fullName);
	await page.getByLabel("Nomor ponsel").fill(SYNTHETIC_SHOPPER.phoneDisplay);
	await page.getByLabel("Alamat lengkap").fill(SYNTHETIC_SHOPPER.addressLine1);
	await page.getByLabel("Kecamatan").fill(SYNTHETIC_SHOPPER.district);
	await page.getByLabel("Kota / Kabupaten").fill(SYNTHETIC_SHOPPER.cityRegency);
	await page.getByLabel("Provinsi").fill(SYNTHETIC_SHOPPER.province);
	await page.getByLabel("Kode pos").fill(SYNTHETIC_SHOPPER.postalCode);

	const accessibleStructure =
		(await page.getByRole("main").count()) === 1 &&
		(await page.getByRole("heading", { name: "Penerima" }).count()) === 1 &&
		(await page
			.getByRole("button", { name: /Buat pesanan simulasi/ })
			.count()) === 1;
	const addressValuesPreserved = await page.evaluate((expected) => {
		const value = (id: string) =>
			(document.getElementById(id) as HTMLInputElement | null)?.value;
		return (
			value("addressLine1") === expected.addressLine1 &&
			value("district") === expected.district &&
			value("cityRegency") === expected.cityRegency &&
			value("province") === expected.province &&
			value("postalCode") === expected.postalCode
		);
	}, SYNTHETIC_SHOPPER);
	const idrTotalVisible = await page
		.getByText(/Rp\s*637\.000/, { exact: false })
		.last()
		.isVisible();

	const submitButton = page.getByRole("button", {
		name: /Buat pesanan simulasi/,
	});
	await submitButton.evaluate((element) => {
		element.addEventListener(
			"pointerdown",
			(event) => {
				(
					window as Window & { __roveproofPointerType?: string }
				).__roveproofPointerType = (event as PointerEvent).pointerType;
			},
			{ once: true },
		);
	});
	// Recommendations must render ready before the shopper can complete checkout. On a repaired
	// target the eager response resolves quickly and the on-page banner appears within budget; a
	// still-heavy seed keeps it from appearing in time. This is observed BEFORE submit because a
	// successful order replaces the checkout page (form + recommendation aside) with the confirmation
	// view, after which the banner no longer exists in the DOM.
	const response = await recommendationResponse;
	await page
		.getByText("Inspirasi produk siap", { exact: true })
		.waitFor({ state: "visible", timeout: 45_000 });
	const recommendationReady = response.ok();
	const recommendationSeedHeader =
		response.headers()["x-roveproof-seed-id"] ?? null;

	await submitButton.tap();
	const touchSubmissionCompleted = await page.evaluate(
		() =>
			(window as Window & { __roveproofPointerType?: string })
				.__roveproofPointerType === "touch",
	);
	// A fully repaired submit navigates to the confirmation view, which paints just after the order
	// response settles at the end of the throttled boundary. Wait for that terminal text explicitly
	// rather than sampling visibility (an instantaneous check raced ahead of the paint). A still-broken
	// submit never reaches confirmation; the seed/order/budget assertions below record that failure.
	const confirmationVisible = await page
		.getByText("Pesanan simulasi diterima", { exact: true })
		.waitFor({ state: "visible", timeout: 20_000 })
		.then(() => true)
		.catch(() => false);
	const mononymSeedVisible = await page
		.getByText(SEED_IDS[0], { exact: true })
		.isVisible()
		.catch(() => false);
	const phoneSeedVisible = await page
		.getByText(SEED_IDS[1], { exact: true })
		.isVisible()
		.catch(() => false);
	const noHorizontalOverflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth <=
			document.documentElement.clientWidth,
	);

	const vitalsInput = await page.evaluate(() => {
		const target = window as Window & {
			__roveproofVitals?: {
				lcpMs: number | null;
				inpMs: number | null;
				cls: number;
			};
		};
		return target.__roveproofVitals ?? { lcpMs: null, inpMs: null, cls: 0 };
	});

	return {
		recommendationReady,
		recommendationSeedHeader,
		mononymSeedVisible,
		phoneSeedVisible,
		keyboardOrderValid,
		touchSubmissionCompleted,
		accessibleStructure,
		noHorizontalOverflow,
		addressValuesPreserved,
		idrTotalVisible,
		confirmationVisible,
		vitals: {
			lcpMs: finiteMetric(vitalsInput.lcpMs),
			inpMs: finiteMetric(vitalsInput.inpMs),
			cls: finiteMetric(vitalsInput.cls),
		},
	};
}

function recommendationRequest(
	requests: readonly RequestEvidence[],
): RequestEvidence | undefined {
	return requests.find((request) => {
		try {
			return new URL(request.url).pathname === "/api/recommendations";
		} catch {
			return false;
		}
	});
}

export function evaluateBaselineOracle(input: BaselineOracleInput): {
	result: EvidenceResult;
	assertions: JourneyAssertions;
} {
	const recommendation = recommendationRequest(input.requests);
	const heavySeedObserved =
		input.observation.recommendationReady &&
		input.observation.recommendationSeedHeader === RECOMMENDATIONS_SEED_ID &&
		(recommendation?.encodedBytes ?? 0) >= RECOMMENDATIONS_MINIMUM_BYTES;
	const observedSeedIds = [
		input.observation.mononymSeedVisible ? SEED_IDS[0] : null,
		input.observation.phoneSeedVisible ? SEED_IDS[1] : null,
		heavySeedObserved ? SEED_IDS[2] : null,
	].filter((seedId): seedId is (typeof SEED_IDS)[number] => seedId !== null);
	const allSeedsObserved = observedSeedIds.length === SEED_IDS.length;
	const noRuntimeErrors =
		input.failedRequestCount === 0 &&
		input.consoleErrorCount === 0 &&
		input.pageErrorCount === 0;
	const orderRequests = input.requests.filter((request) => {
		try {
			return (
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/orders"
			);
		} catch {
			return false;
		}
	});
	const supportingOraclePassed =
		noRuntimeErrors &&
		input.observation.keyboardOrderValid &&
		input.observation.touchSubmissionCompleted &&
		input.observation.accessibleStructure &&
		input.observation.noHorizontalOverflow &&
		input.observation.addressValuesPreserved &&
		input.observation.idrTotalVisible &&
		!input.observation.confirmationVisible &&
		orderRequests.length === 0;

	const assertions: JourneyAssertions = {
		schemaVersion: SCHEMA_VERSION,
		runId: input.runId,
		journeyId: JOURNEY_ID,
		expectedSeedIds: [...SEED_IDS],
		observedSeedIds,
		assertions: [
			{
				id: "seed.mononym-required-last-name",
				status: input.observation.mononymSeedVisible ? "FAIL" : "PASS",
				message: input.observation.mononymSeedVisible
					? "The legal mononym Naufal was rejected by a two-part-name requirement."
					: "The mononym seed did not reproduce.",
				seedId: SEED_IDS[0],
				artifactRefs: [
					"screenshots/failure-or-confirmation.png",
					"requests.jsonl",
				],
			},
			{
				id: "seed.phone-plus62-normalization",
				status: input.observation.phoneSeedVisible ? "FAIL" : "PASS",
				message: input.observation.phoneSeedVisible
					? "The valid +62 number was rejected before normalization."
					: "The +62 normalization seed did not reproduce.",
				seedId: SEED_IDS[1],
				artifactRefs: ["screenshots/failure-or-confirmation.png"],
			},
			{
				id: "seed.mobile-heavy-checkout-bundle",
				status: heavySeedObserved ? "FAIL" : "PASS",
				message: heavySeedObserved
					? `The eager recommendations response transferred ${recommendation?.encodedBytes ?? 0} encoded bytes and the journey exceeded its fixed budget.`
					: "The heavy recommendations seed did not reproduce with its expected response evidence.",
				seedId: SEED_IDS[2],
				artifactRefs: ["requests.jsonl", "network.har", "metrics.json"],
			},
			{
				id: "locale.indonesia-address-preserved",
				status: input.observation.addressValuesPreserved ? "PASS" : "FAIL",
				message: input.observation.addressValuesPreserved
					? "Indonesian address fields preserved the fixed values."
					: "One or more Indonesian address values changed.",
				artifactRefs: ["screenshots/00-start.png"],
			},
			{
				id: "locale.idr-total-visible",
				status: input.observation.idrTotalVisible ? "PASS" : "FAIL",
				message: input.observation.idrTotalVisible
					? "The fixed integer total remained visibly formatted as IDR."
					: "The IDR total was not visible or was numerically incorrect.",
				artifactRefs: ["screenshots/00-start.png"],
			},
			{
				id: "mobile.keyboard-focus-order",
				status: input.observation.keyboardOrderValid ? "PASS" : "FAIL",
				message: input.observation.keyboardOrderValid
					? "Keyboard focus moved from name to phone in document order."
					: "Keyboard focus order was not preserved.",
				artifactRefs: ["trace.zip"],
			},
			{
				id: "mobile.touch-submit",
				status: input.observation.touchSubmissionCompleted ? "PASS" : "FAIL",
				message: input.observation.touchSubmissionCompleted
					? "The submit action accepted a real touch tap."
					: "Touch submission was unavailable.",
				artifactRefs: ["trace.zip"],
			},
			{
				id: "mobile.no-horizontal-overflow",
				status: input.observation.noHorizontalOverflow ? "PASS" : "FAIL",
				message: input.observation.noHorizontalOverflow
					? "The 360px viewport had no horizontal document overflow."
					: "The 360px viewport overflowed horizontally.",
				artifactRefs: ["screenshots/failure-or-confirmation.png"],
			},
			{
				id: "accessibility.checkout-structure",
				status: input.observation.accessibleStructure ? "PASS" : "FAIL",
				message: input.observation.accessibleStructure
					? "Main, headings, labels, alert, and submit control were exposed by accessible roles."
					: "Required accessible checkout structure was missing.",
				artifactRefs: ["trace.zip", "screenshots/failure-or-confirmation.png"],
			},
			{
				id: "runtime.no-unexpected-errors",
				status: noRuntimeErrors ? "PASS" : "FAIL",
				message: noRuntimeErrors
					? "No failed required request, console error, or page exception was observed."
					: "The journey emitted a failed request, console error, or page exception.",
				artifactRefs: ["console.jsonl", "requests.jsonl"],
			},
			{
				id: "baseline.no-order-created",
				status:
					orderRequests.length === 0 && !input.observation.confirmationVisible
						? "PASS"
						: "FAIL",
				message:
					orderRequests.length === 0 && !input.observation.confirmationVisible
						? "Blocked baseline submission created no order."
						: "The blocked baseline unexpectedly attempted or displayed an order.",
				artifactRefs: [
					"requests.jsonl",
					"screenshots/failure-or-confirmation.png",
				],
			},
			{
				id: "terminal.order-confirmation",
				status: "NOT_EVALUATED",
				message:
					"Order confirmation is not evaluated after the expected baseline block.",
				artifactRefs: [],
			},
		],
	};

	const baselineProven = allSeedsObserved && supportingOraclePassed;
	const verdict = baselineProven ? "FAIL_BLOCKED" : "INCONCLUSIVE";
	const firstCausalFailure = baselineProven
		? {
				code: SEED_IDS[0],
				message:
					"Checkout is first classified as blocked because the verifier-owned mononym assertion failed.",
				artifactRefs: [
					"assertions.json#seed.mononym-required-last-name",
					"screenshots/failure-or-confirmation.png",
				],
			}
		: {
				code: "BASELINE_SEEDS_NOT_REPRODUCED",
				message: allSeedsObserved
					? "The three seeds reproduced, but supporting journey or evidence assertions were contradictory."
					: "The fixed baseline did not reproduce all three required seed IDs.",
				artifactRefs: ["assertions.json", "requests.jsonl"],
			};

	const result: EvidenceResult = {
		schemaVersion: SCHEMA_VERSION,
		runId: input.runId,
		verdict,
		firstCausalFailure,
		task: {
			completed: false,
			durationMs: input.durationMs,
			orderId: null,
			durableOrderCount: 0,
		},
		performance: {
			transferredBytes: input.transferredBytes,
			measurement:
				"sum of one terminal CDP Network.loadingFinished encodedDataLength per target response within monotonic journey boundaries",
			lcpMs: input.observation.vitals.lcpMs,
			inpMs: input.observation.vitals.inpMs,
			cls: input.observation.vitals.cls,
		},
		sampleCount: 1,
	};

	if (
		allSeedsObserved &&
		input.transferredBytes <= FIXED_RUN_CONFIG.performanceBudget.encodedBytes &&
		input.durationMs <= FIXED_RUN_CONFIG.performanceBudget.durationMs
	) {
		throw new Error(
			"Heavy seed reproduced without exceeding either frozen performance budget",
		);
	}

	return { result, assertions };
}

/**
 * Clean-success oracle for M6 verification: the candidate-patched target must
 * complete exactly one durable synthetic order under the frozen Indonesia Mobile
 * profile, with no seed failure and measured transfer/time within the frozen
 * budget. The orderId is supplied by the verifier (read from the durable order
 * store after the journey) so the PASS result is bound to a real persisted order.
 */
export function evaluateVerificationOracle(
	input: BaselineOracleInput,
	orderId: string | null,
): { result: EvidenceResult; assertions: JourneyAssertions } {
	const recommendation = recommendationRequest(input.requests);
	const heavySeedObserved =
		input.observation.recommendationReady &&
		input.observation.recommendationSeedHeader === RECOMMENDATIONS_SEED_ID &&
		(recommendation?.encodedBytes ?? 0) >= RECOMMENDATIONS_MINIMUM_BYTES;
	const observedSeedIds = [
		input.observation.mononymSeedVisible ? SEED_IDS[0] : null,
		input.observation.phoneSeedVisible ? SEED_IDS[1] : null,
		heavySeedObserved ? SEED_IDS[2] : null,
	].filter((seedId): seedId is (typeof SEED_IDS)[number] => seedId !== null);
	const noRuntimeErrors =
		input.failedRequestCount === 0 &&
		input.consoleErrorCount === 0 &&
		input.pageErrorCount === 0;
	const orderRequests = input.requests.filter((request) => {
		try {
			return (
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/orders"
			);
		} catch {
			return false;
		}
	});
	const budgetPassed =
		input.transferredBytes <= FIXED_RUN_CONFIG.performanceBudget.encodedBytes &&
		input.durationMs <= FIXED_RUN_CONFIG.performanceBudget.durationMs;
	const supportingOraclePassed =
		noRuntimeErrors &&
		input.observation.keyboardOrderValid &&
		input.observation.touchSubmissionCompleted &&
		input.observation.accessibleStructure &&
		input.observation.noHorizontalOverflow &&
		input.observation.addressValuesPreserved &&
		input.observation.idrTotalVisible &&
		input.observation.confirmationVisible &&
		orderRequests.length === 1;
	const noSeedFailures = observedSeedIds.length === 0;
	const verdict =
		noSeedFailures && supportingOraclePassed && budgetPassed && orderId !== null
			? "PASS"
			: "INCONCLUSIVE";
	const firstCausalFailure =
		verdict === "PASS"
			? null
			: {
					code:
						observedSeedIds[0] ??
						(orderRequests.length !== 1
							? "VERIFICATION_ORDER_COUNT"
							: !budgetPassed
								? "VERIFICATION_BUDGET_EXCEEDED"
								: "VERIFICATION_SUPPORTING_ORACLE"),
					message:
						observedSeedIds.length > 0
							? `The patched target still reproduced a seed failure: ${observedSeedIds.join(", ")}`
							: orderRequests.length !== 1
								? `The patched journey created ${orderRequests.length} orders instead of exactly one`
								: !budgetPassed
									? `The patched journey exceeded the frozen budget: ${input.transferredBytes} bytes / ${Math.round(input.durationMs)} ms`
									: "A supporting verification assertion did not pass",
					artifactRefs: ["assertions.json", "requests.jsonl", "metrics.json"],
				};

	const assertions: JourneyAssertions = {
		schemaVersion: SCHEMA_VERSION,
		runId: input.runId,
		journeyId: JOURNEY_ID,
		expectedSeedIds: [...SEED_IDS],
		observedSeedIds,
		assertions: [
			{
				id: "seed.mononym-required-last-name",
				status: input.observation.mononymSeedVisible ? "FAIL" : "PASS",
				message: input.observation.mononymSeedVisible
					? "The patched target still rejected the mononym."
					: "The patched target accepted the mononym.",
				seedId: SEED_IDS[0],
				artifactRefs: [
					"screenshots/failure-or-confirmation.png",
					"requests.jsonl",
				],
			},
			{
				id: "seed.phone-plus62-normalization",
				status: input.observation.phoneSeedVisible ? "FAIL" : "PASS",
				message: input.observation.phoneSeedVisible
					? "The patched target still rejected the +62 number."
					: "The patched target accepted the +62 number.",
				seedId: SEED_IDS[1],
				artifactRefs: ["screenshots/failure-or-confirmation.png"],
			},
			{
				id: "seed.mobile-heavy-checkout-bundle",
				status: heavySeedObserved ? "FAIL" : "PASS",
				message: heavySeedObserved
					? `The patched recommendations response still transferred ${recommendation?.encodedBytes ?? 0} encoded bytes.`
					: "The patched recommendations response is under the frozen budget.",
				seedId: SEED_IDS[2],
				artifactRefs: ["requests.jsonl", "network.har", "metrics.json"],
			},
			{
				id: "locale.indonesia-address-preserved",
				status: input.observation.addressValuesPreserved ? "PASS" : "FAIL",
				message: input.observation.addressValuesPreserved
					? "Indonesian address fields preserved the fixed values."
					: "One or more Indonesian address values changed.",
				artifactRefs: ["screenshots/00-start.png"],
			},
			{
				id: "locale.idr-total-visible",
				status: input.observation.idrTotalVisible ? "PASS" : "FAIL",
				message: input.observation.idrTotalVisible
					? "The fixed integer total remained visibly formatted as IDR."
					: "The IDR total was not visible or was numerically incorrect.",
				artifactRefs: ["screenshots/00-start.png"],
			},
			{
				id: "mobile.keyboard-focus-order",
				status: input.observation.keyboardOrderValid ? "PASS" : "FAIL",
				message: input.observation.keyboardOrderValid
					? "Keyboard focus moved from name to phone in document order."
					: "Keyboard focus order was not preserved.",
				artifactRefs: ["trace.zip"],
			},
			{
				id: "mobile.touch-submit",
				status: input.observation.touchSubmissionCompleted ? "PASS" : "FAIL",
				message: input.observation.touchSubmissionCompleted
					? "The submit action accepted a real touch tap."
					: "Touch submission was unavailable.",
				artifactRefs: ["trace.zip"],
			},
			{
				id: "mobile.no-horizontal-overflow",
				status: input.observation.noHorizontalOverflow ? "PASS" : "FAIL",
				message: input.observation.noHorizontalOverflow
					? "The 360px viewport had no horizontal document overflow."
					: "The 360px viewport overflowed horizontally.",
				artifactRefs: ["screenshots/failure-or-confirmation.png"],
			},
			{
				id: "accessibility.checkout-structure",
				status: input.observation.accessibleStructure ? "PASS" : "FAIL",
				message: input.observation.accessibleStructure
					? "Main, headings, labels, alert, and submit control were exposed by accessible roles."
					: "Required accessible checkout structure was missing.",
				artifactRefs: ["trace.zip", "screenshots/failure-or-confirmation.png"],
			},
			{
				id: "runtime.no-unexpected-errors",
				status: noRuntimeErrors ? "PASS" : "FAIL",
				message: noRuntimeErrors
					? "No failed required request, console error, or page exception was observed."
					: "The journey emitted a failed request, console error, or page exception.",
				artifactRefs: ["console.jsonl", "requests.jsonl"],
			},
			{
				id: "verification.exactly-one-order",
				status:
					orderRequests.length === 1 && input.observation.confirmationVisible
						? "PASS"
						: "FAIL",
				message:
					orderRequests.length === 1 && input.observation.confirmationVisible
						? "The patched journey created exactly one durable synthetic order."
						: `The patched journey created ${orderRequests.length} orders with confirmation ${input.observation.confirmationVisible ? "visible" : "not visible"}.`,
				artifactRefs: [
					"requests.jsonl",
					"screenshots/failure-or-confirmation.png",
				],
			},
			{
				id: "verification.transfer-budget",
				status:
					input.transferredBytes <=
					FIXED_RUN_CONFIG.performanceBudget.encodedBytes
						? "PASS"
						: "FAIL",
				message: `The patched journey transferred ${input.transferredBytes} encoded bytes (budget ${FIXED_RUN_CONFIG.performanceBudget.encodedBytes}).`,
				artifactRefs: ["metrics.json", "network.har"],
			},
			{
				id: "verification.duration-budget",
				status:
					input.durationMs <= FIXED_RUN_CONFIG.performanceBudget.durationMs
						? "PASS"
						: "FAIL",
				message: `The patched journey completed in ${Math.round(input.durationMs)} ms (budget ${FIXED_RUN_CONFIG.performanceBudget.durationMs}).`,
				artifactRefs: ["metrics.json"],
			},
			{
				id: "terminal.order-confirmation",
				status: verdict === "PASS" ? "PASS" : "NOT_EVALUATED",
				message:
					verdict === "PASS"
						? `Order confirmation ${orderId} was created and displayed.`
						: "Order confirmation was not evaluated because the journey did not fully pass.",
				artifactRefs: [
					"screenshots/failure-or-confirmation.png",
					"requests.jsonl",
				],
			},
		],
	};

	const result: EvidenceResult = {
		schemaVersion: SCHEMA_VERSION,
		runId: input.runId,
		verdict,
		firstCausalFailure,
		task: {
			completed: verdict === "PASS",
			durationMs: input.durationMs,
			orderId: verdict === "PASS" ? orderId : null,
			durableOrderCount: verdict === "PASS" ? 1 : 0,
		},
		performance: {
			transferredBytes: input.transferredBytes,
			measurement:
				"sum of one terminal CDP Network.loadingFinished encodedDataLength per target response within monotonic journey boundaries",
			lcpMs: input.observation.vitals.lcpMs,
			inpMs: input.observation.vitals.inpMs,
			cls: input.observation.vitals.cls,
		},
		sampleCount: 1,
	};

	return { result, assertions };
}
