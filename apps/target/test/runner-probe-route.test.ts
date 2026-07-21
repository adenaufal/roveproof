import { describe, expect, it } from "vitest";
import { GET, RUNNER_PROBE_BYTES } from "../src/app/api/runner-probe/route";

describe("runner network verification probe", () => {
  it("returns one deterministic identity-encoded body with no seed ID", async () => {
    const first = GET();
    const second = GET();

    expect(first.headers.get("Content-Length")).toBe(String(RUNNER_PROBE_BYTES));
    expect(first.headers.get("Content-Encoding")).toBe("identity");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("X-Roveproof-Seed-Id")).toBeNull();
    expect(Buffer.from(await first.arrayBuffer()).byteLength).toBe(RUNNER_PROBE_BYTES);
    expect(await second.text()).toBe("r".repeat(RUNNER_PROBE_BYTES));
  });
});
