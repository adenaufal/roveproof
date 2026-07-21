import { describe, expect, it } from "vitest";
import {
  ArtifactIndexSchema,
  EvidenceManifestSchema,
  EvidenceMetricsSchema,
  EvidenceResultSchema,
  JourneyAssertionsSchema,
  RunVerdictSchema,
  SEED_IDS,
} from "../src/index";

const HASH = "a".repeat(64);
const RUN_ID = "run-evidence-001";

function manifest() {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    kind: "baseline",
    mode: "real",
    targetId: "seeded-checkout-v1",
    journeyId: "checkout-v1",
    profileId: "indonesia-mobile-v1",
    seedIds: [...SEED_IDS],
    sourceRevision: `sha256:${HASH}`,
    candidateDiffHash: null,
    startedAt: "2026-07-18T01:00:00.000Z",
    completedAt: "2026-07-18T01:00:20.000Z",
    runtime: {
      playwrightVersion: "1.61.1",
      browser: "chromium",
      browserVersion: "142.0.0.0",
      userAgent: "synthetic browser",
      observed: {
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 2,
        maxTouchPoints: 1,
        locale: "id-ID",
        languages: ["id-ID"],
        timeZone: "Asia/Jakarta",
        acceptLanguage: "id-ID,id;q=0.9,en;q=0.8",
      },
      touch: { requested: true, pointerEventObserved: true, verified: true },
      cpu: {
        requestedRate: 4,
        commandApplied: true,
        verified: true,
        verificationBasis: "benchmark-ratio",
        baselineProbeMs: 25,
        throttledProbeMs: 100,
        observedRatio: 4,
      },
      network: {
        profile: "flaky-3g-v1",
        latencyMs: 300,
        downloadBytesPerSecond: 450_000,
        uploadBytesPerSecond: 93_750,
        commandApplied: true,
        verified: true,
        verificationBasis: "rule-id-and-transfer-probe",
        probeRuleId: "probe-rule",
        measuredRuleId: "run-rule",
        measuredRuleMatched: true,
        probe: { bodyBytes: 450_000, durationMs: 1_300, expectedDurationMs: 1_300, matchedRule: true },
      },
      jitter: {
        schedule: "deterministic-jitter-v1",
        completed: true,
        events: [
          { phase: "degraded", plannedAtMs: 0, appliedAtMs: 5, ruleId: "jitter-rule" },
          { phase: "restored", plannedAtMs: 250, appliedAtMs: 254, ruleId: "restore-rule" },
        ],
      },
      profileVerified: true,
    },
    redaction: {
      policy: "roveproof-redaction-v1",
      scope: "credentials-secrets-and-unexpected-pii",
      dataClassification: "fixed-synthetic-only",
      verified: true,
    },
    missingArtifacts: [],
    deviations: [],
  };
}

describe("Milestone 2 evidence contracts", () => {
  it("keeps the accepted coarse run verdict contract unchanged", () => {
    expect(RunVerdictSchema.options).toEqual(["PASSED", "FAILED", "INCONCLUSIVE"]);
  });

  it("accepts a fully observed fixed profile and rejects unknown schema majors", () => {
    expect(EvidenceManifestSchema.parse(manifest()).runtime.profileVerified).toBe(true);
    expect(() => EvidenceManifestSchema.parse({ ...manifest(), schemaVersion: 2 })).toThrow();
  });

  it("cannot claim profile verification from command acknowledgements alone", () => {
    const input = manifest();
    input.runtime.cpu.verified = false;
    expect(() => EvidenceManifestSchema.parse(input)).toThrow(/requires verified CPU, network, touch, and jitter constraints/);

    const networkInput = manifest();
    networkInput.runtime.network.measuredRuleMatched = false;
    expect(() => EvidenceManifestSchema.parse(networkInput)).toThrow(/matching transfer probe/);
  });

  it("rejects duplicate missing paths and unsafe artifact-reference fragments", () => {
    const input = manifest();
    input.missingArtifacts = [
      { path: "trace.zip", reason: "missing" },
      { path: "trace.zip", reason: "still missing" },
    ];
    expect(() => EvidenceManifestSchema.parse(input)).toThrow(/unique/);

    expect(() => JourneyAssertionsSchema.parse({
      schemaVersion: 1,
      runId: RUN_ID,
      journeyId: "checkout-v1",
      expectedSeedIds: [...SEED_IDS],
      observedSeedIds: [...SEED_IDS],
      assertions: [{
        id: "seed.mononym",
        status: "FAIL",
        message: "seed reproduced",
        seedId: SEED_IDS[0],
        artifactRefs: ["../outside.json#bad"],
      }],
    })).toThrow(/safe bundle path/);
  });

  it("requires non-passing results to cite a causal failure", () => {
    expect(() => EvidenceResultSchema.parse({
      schemaVersion: 1,
      runId: RUN_ID,
      verdict: "FAIL_BLOCKED",
      firstCausalFailure: null,
      task: { completed: false, durationMs: 19_000, orderId: null, durableOrderCount: 0 },
      performance: {
        transferredBytes: 8_200_000,
        measurement: "sum of one terminal CDP Network.loadingFinished encodedDataLength per target response within monotonic journey boundaries",
        lcpMs: 2_000,
        inpMs: 80,
        cls: 0,
      },
      sampleCount: 1,
    })).toThrow(/causal failure/);
  });

  it("defines an explicit self-excluding, sorted artifact index", () => {
    const base = {
      schemaVersion: 1,
      runId: RUN_ID,
      hashAlgorithm: "sha256",
      indexPolicy: "sha256-tree-v1; artifact-index.json is metadata and is self-excluded",
      rootHash: HASH,
    };
    expect(() => ArtifactIndexSchema.parse({
      ...base,
      entries: [{ path: "artifact-index.json", size: 1, sha256: HASH, mediaType: "application/json" }],
    })).toThrow(/cannot hash itself/);
    expect(() => ArtifactIndexSchema.parse({
      ...base,
      entries: [
        { path: "result.json", size: 1, sha256: HASH, mediaType: "application/json" },
        { path: "manifest.json", size: 1, sha256: HASH, mediaType: "application/json" },
      ],
    })).toThrow(/sorted/);
  });

  it("uses a monotonic timing declaration in metrics", () => {
    expect(EvidenceMetricsSchema.parse({
      schemaVersion: 1,
      runId: RUN_ID,
      boundary: {
        clock: "node:performance.now",
        startedAt: "2026-07-18T01:00:00.000Z",
        completedAt: "2026-07-18T01:00:19.000Z",
        durationMs: 19_000,
      },
      transferredBytes: 8_200_000,
      requestCount: 8,
      failedRequestCount: 0,
      consoleErrorCount: 0,
      pageErrorCount: 0,
      lcpMs: 2_500,
      inpMs: null,
      cls: 0,
    }).boundary.clock).toBe("node:performance.now");
  });
});
