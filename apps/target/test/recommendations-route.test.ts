import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/recommendations/route";

describe("recommendations Route Handler", () => {
  it("returns the exact deterministic identity-encoded heavy seed response", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Roveproof-Seed-Id")).toBe("MOBILE-HEAVY-CHECKOUT-BUNDLE");
    expect(response.headers.get("Content-Encoding")).toBe("identity");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Length")).toBe("8000000");

    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(8_000_000);
  });
});
