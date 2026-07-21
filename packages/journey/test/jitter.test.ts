import { EventEmitter } from "node:events";
import type { CDPSession } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkCollector } from "../src/collectors";
import { DeterministicJitterController } from "../src/jitter";

class FakeSession extends EventEmitter {
  readonly conditions: Array<{ latency: number }> = [];
  #rule = 0;

  async send(method: string, parameters: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (method === "Network.emulateNetworkConditionsByRule") {
      const conditions = parameters.matchedNetworkConditions as Array<{ latency: number }>;
      this.conditions.push({ latency: conditions[0].latency });
      this.#rule += 1;
      return { ruleIds: [`jitter-rule-${this.#rule}`] };
    }
    return {};
  }
}

afterEach(() => vi.useRealTimers());

describe("deterministic network jitter", () => {
  it("applies the degraded window and exact base restoration in order", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    const collector = new NetworkCollector(fake as unknown as CDPSession, "http://127.0.0.1:3101");
    collector.beginBoundary("base-rule");
    const jitter = new DeterministicJitterController(fake as unknown as CDPSession, collector);
    const starting = jitter.start(performance.now());
    await vi.advanceTimersByTimeAsync(0);
    await starting;
    const finishing = jitter.finish();

    await vi.advanceTimersByTimeAsync(250);
    const evidence = await finishing;

    expect(fake.conditions).toEqual([{ latency: 450 }, { latency: 300 }]);
    expect(evidence).toMatchObject({
      schedule: "deterministic-jitter-v1",
      completed: true,
      events: [
        { phase: "degraded", plannedAtMs: 0, ruleId: "jitter-rule-1" },
        { phase: "restored", plannedAtMs: 250, ruleId: "jitter-rule-2" },
      ],
    });
  });

  it("fails closed when a scheduled CDP transition rejects", async () => {
    vi.useFakeTimers();
    const fake = new FakeSession();
    fake.send = vi.fn(async (method: string) => {
      if (method === "Network.emulateNetworkConditionsByRule") throw new Error("CDP unavailable");
      return {};
    });
    const collector = new NetworkCollector(fake as unknown as CDPSession, "http://127.0.0.1:3101");
    collector.beginBoundary("base-rule");
    const jitter = new DeterministicJitterController(fake as unknown as CDPSession, collector);
    const rejection = expect(jitter.start(performance.now())).rejects.toThrow("CDP unavailable");

    await vi.advanceTimersByTimeAsync(0);
    await rejection;
    await jitter.cancel();
  });
});
