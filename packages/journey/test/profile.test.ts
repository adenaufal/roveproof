import type { CDPSession } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { BASELINE_OBSERVATION_TOLERANCE, INDONESIA_MOBILE_PROFILE, bytesPerSecond } from "../src/config";
import { applyNetworkCondition, profileDeviations, type RuntimeObservation } from "../src/profile";

const observed: RuntimeObservation = {
  viewport: { width: 360, height: 800 },
  deviceScaleFactor: 2,
  maxTouchPoints: 1,
  locale: "id-ID",
  languages: ["id-ID"],
  timeZone: "Asia/Jakarta",
  acceptLanguage: "id-ID,id;q=0.9,en;q=0.8",
};

describe("Indonesia Mobile constrained profile", () => {
  it("loads the exact versioned base profile and deterministic jitter schedule", () => {
    expect(INDONESIA_MOBILE_PROFILE).toMatchObject({
      id: "indonesia-mobile-v1",
      viewport: { width: 360, height: 800 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: "id-ID",
      timezoneId: "Asia/Jakarta",
      cpuSlowdownMultiplier: 4,
      network: {
        profile: "flaky-3g-v1",
        latencyMs: 300,
        downloadBitsPerSecond: 3_600_000,
        uploadBitsPerSecond: 750_000,
      },
      jitter: {
        schedule: "deterministic-jitter-v1",
        events: [
          { phase: "degraded", atMs: 0 },
          { phase: "restored", atMs: 250 },
        ],
      },
    });
    expect(bytesPerSecond(3_600_000)).toBe(450_000);
    expect(bytesPerSecond(750_000)).toBe(93_750);
    expect(BASELINE_OBSERVATION_TOLERANCE).toEqual({
      transferredBytes: { minimum: 8_150_000, maximum: 8_249_999 },
      durationMs: { minimum: 18_500, maximum: 19_499 },
    });
  });

  it("reports every observable profile mismatch instead of weakening the claim", () => {
    expect(profileDeviations(observed)).toEqual([]);
    expect(profileDeviations({
      ...observed,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      maxTouchPoints: 0,
      locale: "en-US",
      languages: ["en-US"],
      timeZone: "UTC",
      acceptLanguage: "en-US",
    })).toHaveLength(7);
  });

  it("applies a rule-addressable network profile in bytes per second", async () => {
    const send = vi.fn(async (method: string) => method === "Network.emulateNetworkConditionsByRule"
      ? { ruleIds: ["network-rule-1"] }
      : {});
    const session = { send } as unknown as CDPSession;
    await expect(applyNetworkCondition(session, INDONESIA_MOBILE_PROFILE.network)).resolves.toEqual({ ruleId: "network-rule-1" });
    expect(send).toHaveBeenNthCalledWith(1, "Network.emulateNetworkConditionsByRule", {
      offline: false,
      matchedNetworkConditions: [{
        urlPattern: "",
        offline: false,
        latency: 300,
        downloadThroughput: 450_000,
        uploadThroughput: 93_750,
        connectionType: "cellular3g",
      }],
    });
    expect(send).toHaveBeenNthCalledWith(2, "Network.overrideNetworkState", {
      offline: false,
      latency: 300,
      downloadThroughput: 450_000,
      uploadThroughput: 93_750,
      connectionType: "cellular3g",
    });
  });

  it("fails closed when Chromium does not return an applied rule ID", async () => {
    const session = { send: vi.fn(async () => ({})) } as unknown as CDPSession;
    await expect(applyNetworkCondition(session, INDONESIA_MOBILE_PROFILE.network)).rejects.toThrow(/rule ID/);
  });
});
