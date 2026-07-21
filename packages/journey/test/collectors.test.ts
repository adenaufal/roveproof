import { EventEmitter } from "node:events";
import type { CDPSession } from "playwright";
import { describe, expect, it } from "vitest";
import { NetworkCollector } from "../src/collectors";

class FakeSession extends EventEmitter {
  async send(): Promise<Record<string, never>> {
    return {};
  }
}

function session(): { emitter: FakeSession; cdp: CDPSession } {
  const emitter = new FakeSession();
  return { emitter, cdp: emitter as unknown as CDPSession };
}

describe("CDP network evidence collector", () => {
  it("counts one loadingFinished encoded length per target response and ignores duplicates/cross-origin traffic", () => {
    const { emitter, cdp } = session();
    const collector = new NetworkCollector(cdp, "http://127.0.0.1:3101");
    collector.beginBoundary("base-rule");

    emitter.emit("Network.requestWillBeSent", {
      requestId: "target-1",
      type: "Fetch",
      request: {
        url: "http://127.0.0.1:3101/api/recommendations",
        method: "GET",
        headers: { Authorization: "Bearer fake-token" },
        hasPostData: false,
      },
    });
    emitter.emit("Network.requestWillBeSentExtraInfo", {
      requestId: "target-1",
      headers: { Accept: "application/json", Cookie: "fake-cookie" },
      appliedNetworkConditionsId: "base-rule",
    });
    emitter.emit("Network.responseReceived", {
      requestId: "target-1",
      response: {
        status: 200,
        mimeType: "application/json",
        headers: { "X-Roveproof-Seed-Id": "MOBILE-HEAVY-CHECKOUT-BUNDLE" },
      },
    });
    emitter.emit("Network.loadingFinished", { requestId: "target-1", encodedDataLength: 8_000_123 });
    emitter.emit("Network.loadingFinished", { requestId: "target-1", encodedDataLength: 8_000_123 });

    emitter.emit("Network.requestWillBeSent", {
      requestId: "external-1",
      type: "Script",
      request: { url: "https://external.test/app.js", method: "GET", headers: {} },
    });
    emitter.emit("Network.loadingFinished", { requestId: "external-1", encodedDataLength: 99_999 });

    expect(collector.transferredBytes).toBe(8_000_123);
    expect(collector.requests).toHaveLength(1);
    expect(collector.requests[0].requestHeaders.cookie).toBe("[REDACTED]");
    expect(JSON.stringify(collector.requests)).not.toContain("fake-token");
    expect(JSON.stringify(collector.requests)).not.toContain("fake-cookie");
    expect(collector.allRequestsMatchedAppliedRules).toBe(true);
  });

  it("retains failed requests without adding bytes", () => {
    const { emitter, cdp } = session();
    const collector = new NetworkCollector(cdp, "http://127.0.0.1:3101");
    collector.beginBoundary("base-rule");
    emitter.emit("Network.requestWillBeSent", {
      requestId: "failed-1",
      type: "Fetch",
      request: { url: "http://127.0.0.1:3101/api/orders", method: "POST", headers: {}, hasPostData: true },
    });
    emitter.emit("Network.loadingFailed", { requestId: "failed-1", errorText: "net::ERR_FAILED" });

    expect(collector.failedRequestCount).toBe(1);
    expect(collector.transferredBytes).toBe(0);
    expect(collector.requests[0]).toMatchObject({ failed: true, encodedBytes: null });
  });

  it("marks redirects as contradictory instead of silently double-counting", () => {
    const { emitter, cdp } = session();
    const collector = new NetworkCollector(cdp, "http://127.0.0.1:3101");
    collector.beginBoundary("base-rule");
    const request = { url: "http://127.0.0.1:3101/checkout", method: "GET", headers: {} };
    emitter.emit("Network.requestWillBeSent", { requestId: "redirect-1", type: "Document", request });
    emitter.emit("Network.requestWillBeSent", {
      requestId: "redirect-1",
      type: "Document",
      request: { ...request, url: "http://127.0.0.1:3101/checkout/" },
      redirectResponse: { status: 308 },
    });
    emitter.emit("Network.loadingFinished", { requestId: "redirect-1", encodedDataLength: 100 });

    expect(collector.redirectObserved).toBe(true);
    expect(collector.requests).toHaveLength(2);
    expect(collector.transferredBytes).toBe(100);
  });
});
