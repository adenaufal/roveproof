import type { BrowserContext, Route, WebSocketRoute } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { installEgressGuard } from "../src/runner";

describe("fixed-target browser egress guard", () => {
  it("allows only target-origin HTTP and WebSocket connections and records blocked attempts", async () => {
    let httpHandler: ((route: Route) => Promise<void>) | undefined;
    let websocketHandler: ((websocket: WebSocketRoute) => void) | undefined;
    const context = {
      route: vi.fn(async (_pattern, handler) => { httpHandler = handler; }),
      routeWebSocket: vi.fn(async (_pattern, handler) => { websocketHandler = handler; }),
    } as unknown as BrowserContext;
    const guard = await installEgressGuard(context, "http://127.0.0.1:3101");

    const targetContinue = vi.fn();
    const targetAbort = vi.fn();
    await httpHandler?.({
      request: () => ({ url: () => "http://127.0.0.1:3101/api/recommendations" }),
      continue: targetContinue,
      abort: targetAbort,
    } as unknown as Route);
    expect(targetContinue).toHaveBeenCalledOnce();
    expect(targetAbort).not.toHaveBeenCalled();

    const externalAbort = vi.fn();
    await httpHandler?.({
      request: () => ({ url: () => "https://external.test/collect?token=fake-secret" }),
      continue: vi.fn(),
      abort: externalAbort,
    } as unknown as Route);
    expect(externalAbort).toHaveBeenCalledWith("blockedbyclient");

    const targetConnect = vi.fn();
    websocketHandler?.({
      url: () => "ws://127.0.0.1:3101/socket",
      connectToServer: targetConnect,
      close: vi.fn(),
    } as unknown as WebSocketRoute);
    expect(targetConnect).toHaveBeenCalledOnce();

    const externalClose = vi.fn();
    websocketHandler?.({
      url: () => "ws://127.0.0.1:4100/exfiltrate",
      connectToServer: vi.fn(),
      close: externalClose,
    } as unknown as WebSocketRoute);
    expect(externalClose).toHaveBeenCalledWith({
      code: 1008,
      reason: "Roveproof blocks non-target WebSocket egress",
    });
    expect(guard.violations).toEqual([
      "https://external.test/collect?token=%5BREDACTED%5D",
      "ws://127.0.0.1:4100/exfiltrate",
    ]);
  });
});
