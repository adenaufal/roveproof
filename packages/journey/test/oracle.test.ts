import { describe, expect, it } from "vitest";
import { SEED_IDS } from "@roveproof/contracts";
import type { RequestEvidence } from "../src/collectors";
import {
	evaluateBaselineOracle,
	evaluateVerificationOracle,
	type CheckoutObservation,
} from "../src/oracle";

const observation: CheckoutObservation = {
	recommendationReady: true,
	recommendationSeedHeader: SEED_IDS[2],
	mononymSeedVisible: true,
	phoneSeedVisible: true,
	keyboardOrderValid: true,
	touchSubmissionCompleted: true,
	accessibleStructure: true,
	noHorizontalOverflow: true,
	addressValuesPreserved: true,
	idrTotalVisible: true,
	confirmationVisible: false,
	vitals: { lcpMs: 2_100, inpMs: 64, cls: 0 },
};

function request(overrides: Partial<RequestEvidence> = {}): RequestEvidence {
	return {
		requestKey: "request-1:0",
		requestId: "request-1",
		url: "http://127.0.0.1:3101/api/recommendations",
		method: "GET",
		resourceType: "Fetch",
		startedAtMs: 500,
		requestHeaders: {},
		requestBody: { present: false, redacted: true },
		response: {
			status: 200,
			mimeType: "application/json",
			headers: { "x-roveproof-seed-id": SEED_IDS[2] },
			fromDiskCache: false,
			fromServiceWorker: false,
		},
		finishedAtMs: 18_000,
		encodedBytes: 8_000_000,
		failed: false,
		failureText: null,
		networkRuleId: "base-rule",
		...overrides,
	};
}

describe("verifier-owned checkout baseline oracle", () => {
	it("reports exactly three seeds with deterministic mononym-first precedence", () => {
		const evaluated = evaluateBaselineOracle({
			runId: "run-oracle-001",
			observation,
			requests: [request()],
			durationMs: 19_100,
			transferredBytes: 8_240_000,
			failedRequestCount: 0,
			consoleErrorCount: 0,
			pageErrorCount: 0,
		});

		expect(evaluated.result.verdict).toBe("FAIL_BLOCKED");
		expect(evaluated.result.firstCausalFailure?.code).toBe(SEED_IDS[0]);
		expect(evaluated.result.performance.transferredBytes).toBe(8_240_000);
		expect(evaluated.result.task).toMatchObject({
			completed: false,
			orderId: null,
			durableOrderCount: 0,
		});
		expect(evaluated.assertions.observedSeedIds).toEqual(SEED_IDS);
		expect(
			evaluated.assertions.assertions
				.filter(({ seedId }) => seedId)
				.map(({ seedId }) => seedId),
		).toEqual(SEED_IDS);
	});

	it("becomes inconclusive instead of inventing a pass when a seed is missing", () => {
		const evaluated = evaluateBaselineOracle({
			runId: "run-oracle-002",
			observation: { ...observation, phoneSeedVisible: false },
			requests: [request()],
			durationMs: 19_100,
			transferredBytes: 8_240_000,
			failedRequestCount: 0,
			consoleErrorCount: 0,
			pageErrorCount: 0,
		});

		expect(evaluated.result.verdict).toBe("INCONCLUSIVE");
		expect(evaluated.assertions.observedSeedIds).toEqual([
			SEED_IDS[0],
			SEED_IDS[2],
		]);
	});

	it("becomes inconclusive on contradictory runtime or order evidence", () => {
		const orderRequest = request({
			requestKey: "order-1:0",
			requestId: "order-1",
			url: "http://127.0.0.1:3101/api/orders",
			method: "POST",
			encodedBytes: 300,
		});
		const evaluated = evaluateBaselineOracle({
			runId: "run-oracle-003",
			observation,
			requests: [request(), orderRequest],
			durationMs: 19_100,
			transferredBytes: 8_240_300,
			failedRequestCount: 0,
			consoleErrorCount: 0,
			pageErrorCount: 0,
		});

		expect(evaluated.result.verdict).toBe("INCONCLUSIVE");
		expect(
			evaluated.assertions.assertions.find(
				({ id }) => id === "baseline.no-order-created",
			)?.status,
		).toBe("FAIL");
	});
});

describe("verifier-owned checkout verification oracle", () => {
	const cleanObservation: CheckoutObservation = {
		recommendationReady: true,
		recommendationSeedHeader: SEED_IDS[2],
		mononymSeedVisible: false,
		phoneSeedVisible: false,
		keyboardOrderValid: true,
		touchSubmissionCompleted: true,
		accessibleStructure: true,
		noHorizontalOverflow: true,
		addressValuesPreserved: true,
		idrTotalVisible: true,
		confirmationVisible: true,
		vitals: { lcpMs: 1_400, inpMs: 64, cls: 0 },
	};
	const smallRec = request({ encodedBytes: 1_400_000 });
	const orderRequest = request({
		requestKey: "order-1:0",
		requestId: "order-1",
		url: "http://127.0.0.1:3101/api/orders",
		method: "POST",
		encodedBytes: 300,
		response: {
			status: 201,
			mimeType: "application/json",
			headers: {},
			fromDiskCache: false,
			fromServiceWorker: false,
		},
	});

	it("passes when no seed fails, exactly one order is created, and budgets are met", () => {
		const evaluated = evaluateVerificationOracle(
			{
				runId: "run-verify-001",
				observation: cleanObservation,
				requests: [smallRec, orderRequest],
				durationMs: 6_000,
				transferredBytes: 1_450_000,
				failedRequestCount: 0,
				consoleErrorCount: 0,
				pageErrorCount: 0,
			},
			"RVP-ABCDEF1234",
		);
		expect(evaluated.result.verdict).toBe("PASS");
		expect(evaluated.result.firstCausalFailure).toBeNull();
		expect(evaluated.result.task).toMatchObject({
			completed: true,
			orderId: "RVP-ABCDEF1234",
			durableOrderCount: 1,
		});
		expect(evaluated.assertions.observedSeedIds).toEqual([]);
	});

	it("fails when a seed still reproduces", () => {
		const evaluated = evaluateVerificationOracle(
			{
				runId: "run-verify-002",
				observation: { ...cleanObservation, mononymSeedVisible: true },
				requests: [smallRec, orderRequest],
				durationMs: 6_000,
				transferredBytes: 1_450_000,
				failedRequestCount: 0,
				consoleErrorCount: 0,
				pageErrorCount: 0,
			},
			"RVP-ABCDEF1234",
		);
		expect(evaluated.result.verdict).toBe("INCONCLUSIVE");
		expect(evaluated.result.firstCausalFailure?.code).toBe(SEED_IDS[0]);
	});

	it("fails when the transfer budget is exceeded", () => {
		const evaluated = evaluateVerificationOracle(
			{
				runId: "run-verify-003",
				observation: cleanObservation,
				requests: [smallRec, orderRequest],
				durationMs: 6_000,
				transferredBytes: 2_500_000,
				failedRequestCount: 0,
				consoleErrorCount: 0,
				pageErrorCount: 0,
			},
			null,
		);
		expect(evaluated.result.verdict).toBe("INCONCLUSIVE");
		expect(evaluated.result.firstCausalFailure?.code).toBe(
			"VERIFICATION_BUDGET_EXCEEDED",
		);
	});

	it("fails when no durable order id is available", () => {
		const evaluated = evaluateVerificationOracle(
			{
				runId: "run-verify-004",
				observation: cleanObservation,
				requests: [smallRec, orderRequest],
				durationMs: 6_000,
				transferredBytes: 1_450_000,
				failedRequestCount: 0,
				consoleErrorCount: 0,
				pageErrorCount: 0,
			},
			null,
		);
		expect(evaluated.result.verdict).toBe("INCONCLUSIVE");
	});
});
