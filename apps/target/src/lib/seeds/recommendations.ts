export const HEAVY_RECOMMENDATIONS_SEED_ID = "MOBILE-HEAVY-CHECKOUT-BUNDLE" as const;
export const RECOMMENDATIONS_ENCODED_BYTES = 8_000_000 as const;
export const RECOMMENDATIONS_ROUTE = "/api/recommendations" as const;

const PAYLOAD_PREFIX = JSON.stringify({
  schemaVersion: 1,
  synthetic: true,
  seedId: HEAVY_RECOMMENDATIONS_SEED_ID,
  items: [
    { id: "tenun-senja-001", name: "Selendang Tenun Senja", price: 279_000, currency: "IDR" },
    { id: "kopi-priangan-001", name: "Kopi Priangan", price: 89_000, currency: "IDR" },
  ],
}).slice(0, -1) + ',"padding":"';
const PAYLOAD_SUFFIX = '"}';
const DETERMINISTIC_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

/** Intentional baseline seed: a non-essential recommendation response exceeds the transfer budget. */
export function createBaselineRecommendationsPayload(): string {
  const paddingLength = RECOMMENDATIONS_ENCODED_BYTES - PAYLOAD_PREFIX.length - PAYLOAD_SUFFIX.length;
  const fullRepeats = Math.ceil(paddingLength / DETERMINISTIC_ALPHABET.length);
  const padding = DETERMINISTIC_ALPHABET.repeat(fullRepeats).slice(0, paddingLength);
  return `${PAYLOAD_PREFIX}${padding}${PAYLOAD_SUFFIX}`;
}
