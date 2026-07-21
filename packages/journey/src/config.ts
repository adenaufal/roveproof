import { createRequire } from "node:module";
import { JOURNEY_ID, PROFILE_ID, SEED_IDS, TARGET_ID } from "@roveproof/contracts";

const require = createRequire(import.meta.url);

export type NetworkCondition = Readonly<{
  latencyMs: number;
  downloadBitsPerSecond: number;
  uploadBitsPerSecond: number;
}>;

export type IndonesiaMobileProfile = Readonly<{
  id: typeof PROFILE_ID;
  browser: "chromium";
  viewport: Readonly<{ width: 360; height: 800 }>;
  deviceScaleFactor: 2;
  isMobile: true;
  hasTouch: true;
  locale: "id-ID";
  timezoneId: "Asia/Jakarta";
  acceptLanguage: "id-ID,id;q=0.9,en;q=0.8";
  cpuSlowdownMultiplier: 4;
  network: Readonly<NetworkCondition & { profile: "flaky-3g-v1"; offline: false }>;
  jitter: Readonly<{
    schedule: "deterministic-jitter-v1";
    events: readonly [
      Readonly<NetworkCondition & { phase: "degraded"; atMs: 0 }>,
      Readonly<NetworkCondition & { phase: "restored"; atMs: 250 }>,
    ];
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`Invalid Indonesia Mobile profile ${label}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function loadProfile(): IndonesiaMobileProfile {
  const input = require("../../../config/profiles/indonesia-mobile-v1.json") as unknown;
  if (!isRecord(input) || !isRecord(input.viewport) || !isRecord(input.network) || !isRecord(input.jitter)) {
    throw new Error("Invalid Indonesia Mobile profile structure");
  }
  const events = input.jitter.events;
  if (!Array.isArray(events) || events.length !== 2 || !events.every(isRecord)) {
    throw new Error("Invalid Indonesia Mobile jitter schedule");
  }

  requireExact(input.id, PROFILE_ID, "id");
  requireExact(input.browser, "chromium", "browser");
  requireExact(input.viewport.width, 360, "viewport width");
  requireExact(input.viewport.height, 800, "viewport height");
  requireExact(input.deviceScaleFactor, 2, "device scale factor");
  requireExact(input.isMobile, true, "mobile setting");
  requireExact(input.hasTouch, true, "touch setting");
  requireExact(input.locale, "id-ID", "locale");
  requireExact(input.timezoneId, "Asia/Jakarta", "time zone");
  requireExact(input.acceptLanguage, "id-ID,id;q=0.9,en;q=0.8", "Accept-Language");
  requireExact(input.cpuSlowdownMultiplier, 4, "CPU multiplier");
  requireExact(input.network.profile, "flaky-3g-v1", "network id");
  requireExact(input.network.offline, false, "offline setting");
  requireExact(input.network.latencyMs, 300, "network latency");
  requireExact(input.network.downloadBitsPerSecond, 3_600_000, "download throughput");
  requireExact(input.network.uploadBitsPerSecond, 750_000, "upload throughput");
  requireExact(input.jitter.schedule, "deterministic-jitter-v1", "jitter id");
  requireExact(events[0].phase, "degraded", "first jitter phase");
  requireExact(events[0].atMs, 0, "first jitter offset");
  requireExact(events[0].latencyMs, 450, "jitter latency");
  requireExact(events[0].downloadBitsPerSecond, 2_400_000, "jitter download throughput");
  requireExact(events[0].uploadBitsPerSecond, 500_000, "jitter upload throughput");
  requireExact(events[1].phase, "restored", "second jitter phase");
  requireExact(events[1].atMs, 250, "second jitter offset");
  requireExact(events[1].latencyMs, 300, "restored latency");
  requireExact(events[1].downloadBitsPerSecond, 3_600_000, "restored download throughput");
  requireExact(events[1].uploadBitsPerSecond, 750_000, "restored upload throughput");

  return deepFreeze(input) as IndonesiaMobileProfile;
}

export const INDONESIA_MOBILE_PROFILE = loadProfile();
export const FIXED_RUN_CONFIG = Object.freeze({
  targetId: TARGET_ID,
  journeyId: JOURNEY_ID,
  profileId: PROFILE_ID,
  seedIds: SEED_IDS,
  performanceBudget: Object.freeze({ encodedBytes: 2_000_000, durationMs: 8_000 }),
});

export const BASELINE_OBSERVATION_TOLERANCE = Object.freeze({
  transferredBytes: Object.freeze({ minimum: 8_150_000, maximum: 8_249_999 }),
  durationMs: Object.freeze({ minimum: 18_500, maximum: 19_499 }),
});

export const SYNTHETIC_SHOPPER = Object.freeze({
  fullName: "Naufal",
  phoneDisplay: "+62 812-3456-7890",
  phoneE164: "+6281234567890",
  addressLine1: "Jl. Asia Afrika No. 8",
  district: "Sumur Bandung",
  cityRegency: "Kota Bandung",
  province: "Jawa Barat",
  postalCode: "40111",
});

export const PLAYWRIGHT_VERSION = (require("playwright/package.json") as { version: string }).version;

export function bytesPerSecond(bitsPerSecond: number): number {
  if (!Number.isInteger(bitsPerSecond) || bitsPerSecond <= 0 || bitsPerSecond % 8 !== 0) {
    throw new Error("Profile throughput must convert to an integer byte rate");
  }
  return bitsPerSecond / 8;
}
