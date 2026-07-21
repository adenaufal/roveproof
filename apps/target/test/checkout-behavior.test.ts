import { describe, expect, it, vi } from "vitest";
import {
  GENERIC_ORDER_ERROR,
  loadEagerCheckoutRecommendations,
  mapOrderApiError,
  SYNTHETIC_CHECKOUT_VALUES,
  validateCheckoutValues,
} from "../src/app/checkout/checkout-behavior";

const EXPECTED_SEED_IDS = [
  "ID-MONONYM-REQUIRED-LAST-NAME",
  "ID-PHONE-PLUS62-NORMALIZATION",
  "MOBILE-HEAVY-CHECKOUT-BUNDLE",
] as const;

describe("CheckoutForm behavior boundaries", () => {
  it("wires the fixed shopper defaults to exactly the three baseline symptoms", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(37), {
      headers: { "X-Roveproof-Seed-Id": "MOBILE-HEAVY-CHECKOUT-BUNDLE" },
    }));

    const errors = validateCheckoutValues(SYNTHETIC_CHECKOUT_VALUES);
    const recommendations = await loadEagerCheckoutRecommendations(fetcher);
    const seedIds = [
      errors.fullName?.seedId,
      errors.phone?.seedId,
      recommendations.seedId,
    ].filter((seedId): seedId is string => Boolean(seedId));

    expect(Object.keys(errors).sort()).toEqual(["fullName", "phone"]);
    expect(errors.fullName).toEqual({
      message: "Masukkan nama depan dan nama belakang.",
      seedId: "ID-MONONYM-REQUIRED-LAST-NAME",
    });
    expect(errors.phone).toEqual({
      message: "Gunakan nomor Indonesia yang diawali 08.",
      seedId: "ID-PHONE-PLUS62-NORMALIZATION",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/recommendations", { cache: "no-store" });
    expect(recommendations.decodedBytes).toBe(37);
    expect(seedIds).toEqual(EXPECTED_SEED_IDS);
  });

  it("fails closed when the eager response no longer carries the heavy seed identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    await expect(loadEagerCheckoutRecommendations(fetcher)).rejects.toThrow("Recommendations seed unavailable");
  });

  it("preserves only allowlisted API errors and hides unexpected client/proxy details", () => {
    expect(mapOrderApiError("Keranjang sintetis tidak valid.")).toBe("Keranjang sintetis tidak valid.");
    expect(mapOrderApiError("Unexpected token < in JSON at position 0")).toBe(GENERIC_ORDER_ERROR);
    expect(mapOrderApiError(new TypeError("fetch failed for internal-host.test"))).toBe(GENERIC_ORDER_ERROR);
  });
});
