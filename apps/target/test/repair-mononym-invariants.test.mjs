// Immutable verifier-owned combined-stage invariants. Candidate diffs cannot
// alter this target because it is never returned by the model authoring path.
// These invariants are the M5 clean-success oracle: after the candidate fixes
// all three seed defects, every assertion below must pass in the combined run.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MONONYM_SEED_ID,
	validateBaselineLegalName,
} from "../src/lib/seeds/identity.ts";
import {
	PLUS62_PHONE_SEED_ID,
	normalizeBaselineIndonesianPhone,
} from "../src/lib/seeds/phone.ts";
import {
	HEAVY_RECOMMENDATIONS_SEED_ID,
	createBaselineRecommendationsPayload,
} from "../src/lib/seeds/recommendations.ts";

test("verifier preserves empty-input mononym failure", () => {
	assert.deepEqual(validateBaselineLegalName(""), {
		valid: false,
		seedId: "ID-MONONYM-REQUIRED-LAST-NAME",
		message: "Masukkan nama depan dan nama belakang.",
	});
});

test("verifier accepts a single non-empty mononym after repair", () => {
	assert.deepEqual(validateBaselineLegalName("Sari"), { valid: true });
});

test("verifier preserves normal multi-part names", () => {
	assert.deepEqual(validateBaselineLegalName("Sari Dewi"), { valid: true });
});

test("verifier preserves the exact mononym seed constant", () => {
	assert.equal(MONONYM_SEED_ID, "ID-MONONYM-REQUIRED-LAST-NAME");
});

test("verifier normalizes +62 Indonesian mobile input after repair", () => {
	assert.deepEqual(normalizeBaselineIndonesianPhone("+6281234567890"), {
		valid: true,
		e164: "+6281234567890",
	});
});

test("verifier preserves 08 domestic normalization to the same E.164 form", () => {
	assert.deepEqual(normalizeBaselineIndonesianPhone("081234567890"), {
		valid: true,
		e164: "+6281234567890",
	});
});

test("verifier preserves invalid phone rejection", () => {
	const result = normalizeBaselineIndonesianPhone("abc");
	assert.equal(result.valid, false);
	assert.equal(result.seedId, "ID-PHONE-PLUS62-NORMALIZATION");
});

test("verifier preserves the exact phone seed constant", () => {
	assert.equal(PLUS62_PHONE_SEED_ID, "ID-PHONE-PLUS62-NORMALIZATION");
});

test("verifier reduces the recommendation payload under the transfer budget after repair", () => {
	const payload = createBaselineRecommendationsPayload();
	assert.ok(
		payload.length < 1_500_000,
		`recommendations payload too large: ${payload.length}`,
	);
	assert.ok(
		payload.length > 100_000,
		`recommendations payload too small: ${payload.length}`,
	);
	const parsed = JSON.parse(payload);
	assert.equal(parsed.schemaVersion, 1);
	assert.equal(parsed.synthetic, true);
	assert.equal(parsed.seedId, "MOBILE-HEAVY-CHECKOUT-BUNDLE");
	assert.equal(Array.isArray(parsed.items), true);
	assert.equal(parsed.items.length, 2);
});

test("verifier preserves the exact recommendations seed constant", () => {
	assert.equal(HEAVY_RECOMMENDATIONS_SEED_ID, "MOBILE-HEAVY-CHECKOUT-BUNDLE");
});
