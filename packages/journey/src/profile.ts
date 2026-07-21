import { performance } from "node:perf_hooks";
import type { Browser, BrowserContextOptions, CDPSession, Page } from "playwright";
import type { EvidenceManifest } from "@roveproof/contracts";
import {
  bytesPerSecond,
  INDONESIA_MOBILE_PROFILE,
  type NetworkCondition,
} from "./config.js";

const NETWORK_PROBE_BYTES = 450_000;
const CPU_RATIO_MINIMUM = 2;
const CPU_RATIO_MAXIMUM = 16;

type Runtime = EvidenceManifest["runtime"];
export type RuntimeObservation = Runtime["observed"];
export type CpuVerification = Runtime["cpu"];
export type NetworkVerification = Runtime["network"];

export type ProfilePreflight = Readonly<{
  observed: RuntimeObservation;
  userAgent: string | null;
  cpu: CpuVerification;
  network: Omit<NetworkVerification, "measuredRuleId" | "measuredRuleMatched">;
  verified: boolean;
  deviations: readonly string[];
}>;

export type AppliedNetworkRule = Readonly<{ ruleId: string }>;

type NetworkRequestEvent = {
  requestId: string;
  request: { url: string; headers: Record<string, unknown> };
};
type NetworkExtraInfoEvent = {
  requestId: string;
  headers: Record<string, unknown>;
  appliedNetworkConditionsId?: string;
};

export function browserContextOptions(): BrowserContextOptions {
  const profile = INDONESIA_MOBILE_PROFILE;
  return {
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    colorScheme: "light",
    extraHTTPHeaders: { "Accept-Language": profile.acceptLanguage },
    serviceWorkers: "block",
  };
}

function networkParameters(condition: NetworkCondition) {
  return {
    offline: false,
    latency: condition.latencyMs,
    downloadThroughput: bytesPerSecond(condition.downloadBitsPerSecond),
    uploadThroughput: bytesPerSecond(condition.uploadBitsPerSecond),
    connectionType: "cellular3g",
  } as const;
}

export async function enableNetworkCollection(session: CDPSession): Promise<void> {
  await session.send("Network.enable", { maxPostDataSize: 0 });
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Network.setBypassServiceWorker", { bypass: true });
}

export async function applyNetworkCondition(
  session: CDPSession,
  condition: NetworkCondition,
): Promise<AppliedNetworkRule> {
  const parameters = networkParameters(condition);
  const response = await session.send("Network.emulateNetworkConditionsByRule", {
    offline: false,
    matchedNetworkConditions: [{ urlPattern: "", ...parameters }],
  }) as { ruleIds?: unknown };
  await session.send("Network.overrideNetworkState", parameters);
  const ruleId = Array.isArray(response.ruleIds) && typeof response.ruleIds[0] === "string"
    ? response.ruleIds[0]
    : null;
  if (!ruleId) throw new Error("Chromium did not return a network emulation rule ID");
  return { ruleId };
}

async function applyBrowserLanguage(session: CDPSession, page: Page): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const browserLanguages = INDONESIA_MOBILE_PROFILE.acceptLanguage
    .split(",")
    .map((preference) => preference.split(";", 1)[0])
    .join(",");
  await session.send("Network.setUserAgentOverride", {
    userAgent,
    acceptLanguage: browserLanguages,
  });
}

export async function applyMeasuredProfile(session: CDPSession, page: Page): Promise<AppliedNetworkRule> {
  await enableNetworkCollection(session);
  await applyBrowserLanguage(session, page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: INDONESIA_MOBILE_PROFILE.cpuSlowdownMultiplier });
  return applyNetworkCondition(session, INDONESIA_MOBILE_PROFILE.network);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function cpuWorkload(page: Page, iterations: number): Promise<number> {
  const started = performance.now();
  const checksum = await page.evaluate((count) => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10000px;top:0;height:1px;contain:layout style;";
    document.body.append(probe);
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      probe.textContent = `${index}-${Math.imul(index + 1, 2_654_435_761)}`;
      probe.style.width = `${(index % 317) + 1}px`;
      total += probe.getBoundingClientRect().width;
    }
    probe.remove();
    return total;
  }, iterations);
  if (!Number.isFinite(checksum) || checksum <= 0) throw new Error("CPU probe checksum is invalid");
  return performance.now() - started;
}

async function verifyCpu(session: CDPSession, page: Page): Promise<CpuVerification> {
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cpuWorkload(page, 50);

  let iterations = 100;
  let baselineProbeMs = await cpuWorkload(page, iterations);
  while (baselineProbeMs < 25 && iterations < 51_200) {
    iterations *= 2;
    baselineProbeMs = await cpuWorkload(page, iterations);
  }
  const baselineSamples = [baselineProbeMs, await cpuWorkload(page, iterations), await cpuWorkload(page, iterations)];
  baselineProbeMs = median(baselineSamples);

  await session.send("Emulation.setCPUThrottlingRate", { rate: INDONESIA_MOBILE_PROFILE.cpuSlowdownMultiplier });
  const throttledProbeMs = median([
    await cpuWorkload(page, iterations),
    await cpuWorkload(page, iterations),
    await cpuWorkload(page, iterations),
  ]);
  const observedRatio = throttledProbeMs / baselineProbeMs;
  const verified = observedRatio >= CPU_RATIO_MINIMUM && observedRatio <= CPU_RATIO_MAXIMUM;

  return {
    requestedRate: 4,
    commandApplied: true,
    verified,
    verificationBasis: "benchmark-ratio",
    baselineProbeMs,
    throttledProbeMs,
    observedRatio,
  };
}

function headerValue(headers: Record<string, unknown>, name: string): string | null {
  const entry = Object.entries(headers).find(([headerName]) => headerName.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : null;
}

async function verifyNetwork(
  session: CDPSession,
  page: Page,
  targetOrigin: string,
): Promise<{ network: ProfilePreflight["network"]; acceptLanguage: string | null }> {
  const requestUrls = new Map<string, string>();
  const extraInfo = new Map<string, NetworkExtraInfoEvent>();
  session.on("Network.requestWillBeSent", (event: NetworkRequestEvent) => {
    requestUrls.set(event.requestId, event.request.url);
  });
  session.on("Network.requestWillBeSentExtraInfo", (event: NetworkExtraInfoEvent) => {
    extraInfo.set(event.requestId, event);
  });

  const { ruleId } = await applyNetworkCondition(session, INDONESIA_MOBILE_PROFILE.network);
  const probeUrl = new URL(`/api/runner-probe?run=${crypto.randomUUID()}`, targetOrigin).toString();
  const started = performance.now();
  const response = await page.goto(probeUrl, { waitUntil: "load", timeout: 15_000 });
  const durationMs = performance.now() - started;
  if (!response) throw new Error("Network verification probe returned no response");
  const bodyBytes = (await response.body()).byteLength;

  const requestId = [...requestUrls.entries()].find(([, url]) => url === probeUrl)?.[0];
  const info = requestId ? extraInfo.get(requestId) : undefined;
  const matchedRule = info?.appliedNetworkConditionsId === ruleId;
  const acceptLanguage = info ? headerValue(info.headers, "accept-language") : null;
  const expectedDurationMs = INDONESIA_MOBILE_PROFILE.network.latencyMs
    + (NETWORK_PROBE_BYTES / bytesPerSecond(INDONESIA_MOBILE_PROFILE.network.downloadBitsPerSecond)) * 1_000;
  const durationCompatible = durationMs >= expectedDurationMs * 0.65 && durationMs <= expectedDurationMs * 2.5;
  const verified = bodyBytes === NETWORK_PROBE_BYTES && matchedRule && durationCompatible;

  return {
    network: {
      profile: "flaky-3g-v1",
      latencyMs: 300,
      downloadBytesPerSecond: 450_000,
      uploadBytesPerSecond: 93_750,
      commandApplied: true,
      verified,
      verificationBasis: "rule-id-and-transfer-probe",
      probeRuleId: ruleId,
      probe: { bodyBytes: NETWORK_PROBE_BYTES, durationMs, expectedDurationMs, matchedRule },
    },
    acceptLanguage,
  };
}

export async function readRuntimeObservation(page: Page, acceptLanguage: string | null): Promise<{
  observed: RuntimeObservation;
  userAgent: string;
}> {
  const observation = await page.evaluate(() => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    deviceScaleFactor: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    locale: navigator.language,
    languages: [...navigator.languages],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: navigator.userAgent,
  }));
  return {
    observed: {
      viewport: observation.viewport,
      deviceScaleFactor: observation.deviceScaleFactor,
      maxTouchPoints: observation.maxTouchPoints,
      locale: observation.locale,
      languages: observation.languages,
      timeZone: observation.timeZone,
      acceptLanguage,
    },
    userAgent: observation.userAgent,
  };
}

export async function observeRuntime(page: Page, acceptLanguage: string | null): Promise<{
  observed: RuntimeObservation;
  userAgent: string;
}> {
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>profile probe</title>');
  return readRuntimeObservation(page, acceptLanguage);
}

export function profileDeviations(observed: RuntimeObservation, touchEventObserved = false): string[] {
  const profile = INDONESIA_MOBILE_PROFILE;
  const deviations: string[] = [];
  if (observed.viewport.width !== profile.viewport.width || observed.viewport.height !== profile.viewport.height) {
    deviations.push(`Observed viewport ${observed.viewport.width}x${observed.viewport.height} does not match 360x800`);
  }
  if (observed.deviceScaleFactor !== profile.deviceScaleFactor) deviations.push("Observed device scale factor does not match 2");
  if ((observed.maxTouchPoints ?? 0) < 1 && !touchEventObserved) deviations.push("Touch input was not observable");
  if (observed.locale !== profile.locale) deviations.push(`Observed locale ${observed.locale ?? "unavailable"} does not match id-ID`);
  if (!observed.languages.includes("id-ID")) deviations.push("Observed browser languages do not include id-ID");
  if (observed.timeZone !== profile.timezoneId) deviations.push(`Observed time zone ${observed.timeZone ?? "unavailable"} does not match Asia/Jakarta`);
  if (observed.acceptLanguage !== profile.acceptLanguage) {
    deviations.push(`Outgoing Accept-Language ${observed.acceptLanguage ?? "unavailable"} does not match the frozen profile`);
  }
  return deviations;
}

export function unavailableProfilePreflight(reason: string): ProfilePreflight {
  return {
    observed: {
      viewport: { width: null, height: null },
      deviceScaleFactor: null,
      maxTouchPoints: null,
      locale: null,
      languages: [],
      timeZone: null,
      acceptLanguage: null,
    },
    userAgent: null,
    cpu: {
      requestedRate: 4,
      commandApplied: false,
      verified: false,
      verificationBasis: "unavailable",
      baselineProbeMs: null,
      throttledProbeMs: null,
      observedRatio: null,
    },
    network: {
      profile: "flaky-3g-v1",
      latencyMs: 300,
      downloadBytesPerSecond: 450_000,
      uploadBytesPerSecond: 93_750,
      commandApplied: false,
      verified: false,
      verificationBasis: "unavailable",
      probeRuleId: null,
      probe: null,
    },
    verified: false,
    deviations: [reason],
  };
}

export async function verifyBrowserProfile(browser: Browser, targetOrigin: string): Promise<ProfilePreflight> {
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  try {
    context = await browser.newContext(browserContextOptions());
    const page = await context.newPage();
    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body></body>');
    const session = await context.newCDPSession(page);
    await enableNetworkCollection(session);
    await applyBrowserLanguage(session, page);
    const cpu = await verifyCpu(session, page);
    const { network, acceptLanguage } = await verifyNetwork(session, page, targetOrigin);
    const { observed, userAgent } = await observeRuntime(page, acceptLanguage);
    const deviations = profileDeviations(observed);
    if (!cpu.verified) deviations.push(`CPU probe ratio ${cpu.observedRatio?.toFixed(2) ?? "unavailable"} did not verify 4x throttling`);
    if (!network.verified) deviations.push("Network rule/transfer probe did not verify the frozen profile");
    return {
      observed,
      userAgent,
      cpu,
      network,
      verified: deviations.length === 0,
      deviations,
    };
  } finally {
    await context?.close();
  }
}
