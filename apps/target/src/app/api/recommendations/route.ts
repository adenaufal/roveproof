import {
  createBaselineRecommendationsPayload,
  HEAVY_RECOMMENDATIONS_SEED_ID,
  RECOMMENDATIONS_ENCODED_BYTES,
} from "@/lib/seeds/recommendations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const payload = createBaselineRecommendationsPayload();

  return new Response(payload, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Encoding": "identity",
      "Content-Length": String(RECOMMENDATIONS_ENCODED_BYTES),
      "Content-Type": "application/json; charset=utf-8",
      "X-Roveproof-Seed-Id": HEAVY_RECOMMENDATIONS_SEED_ID,
    },
  });
}
