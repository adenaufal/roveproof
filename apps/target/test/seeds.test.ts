import { describe, expect, it, vi } from "vitest";
import { performanceBudget } from "../../../config/demo";
import {
  MONONYM_SEED_ID,
  validateBaselineLegalName,
} from "../src/lib/seeds/identity";
import {
  normalizeBaselineIndonesianPhone,
  PLUS62_PHONE_SEED_ID,
} from "../src/lib/seeds/phone";
import {
  createBaselineRecommendationsPayload,
  HEAVY_RECOMMENDATIONS_SEED_ID,
  RECOMMENDATIONS_ENCODED_BYTES,
} from "../src/lib/seeds/recommendations";

const EXPECTED_SEED_IDS = [
  "ID-MONONYM-REQUIRED-LAST-NAME",
  "ID-PHONE-PLUS62-NORMALIZATION",
  "MOBILE-HEAVY-CHECKOUT-BUNDLE",
] as const;

describe("seeded checkout baseline contract", () => {
  it("exposes exactly the three verifier-owned seed IDs", () => {
    expect([MONONYM_SEED_ID, PLUS62_PHONE_SEED_ID, HEAVY_RECOMMENDATIONS_SEED_ID]).toEqual(EXPECTED_SEED_IDS);
  });

  it("incorrectly rejects the legal mononym Naufal for the intended two-part-name reason", () => {
    expect(validateBaselineLegalName("Naufal")).toEqual({
      valid: false,
      seedId: "ID-MONONYM-REQUIRED-LAST-NAME",
      message: "Masukkan nama depan dan nama belakang.",
    });
    expect(validateBaselineLegalName("Naufal Pratama")).toEqual({ valid: true });
  });

  it("fails valid +62 normalization without mutating or logging the phone value", () => {
    const phone = "+62 812-3456-7890";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(normalizeBaselineIndonesianPhone(phone)).toEqual({
      valid: false,
      seedId: "ID-PHONE-PLUS62-NORMALIZATION",
      message: "Gunakan nomor Indonesia yang diawali 08.",
    });
    expect(phone).toBe("+62 812-3456-7890");
    expect(normalizeBaselineIndonesianPhone("0812-3456-7890")).toEqual({ valid: true, e164: "+6281234567890" });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it("creates a deterministic identity-encoded recommendations body over budget", () => {
    const first = createBaselineRecommendationsPayload();
    const second = createBaselineRecommendationsPayload();

    expect(Buffer.byteLength(first)).toBe(RECOMMENDATIONS_ENCODED_BYTES);
    expect(second).toBe(first);
    expect(RECOMMENDATIONS_ENCODED_BYTES).toBeGreaterThan(performanceBudget.encodedBytes);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: 1,
      synthetic: true,
      seedId: "MOBILE-HEAVY-CHECKOUT-BUNDLE",
    });
  });
});
