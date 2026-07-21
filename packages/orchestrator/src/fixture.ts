import {
  FixtureDashboardSnapshotSchema,
  SCHEMA_VERSION,
  SEED_IDS,
  type FixtureDashboardSnapshot,
} from "@roveproof/contracts";

export const GOLDEN_FIXTURE_VERSION = "golden-control-v1" as const;

export function createGoldenFixtureSnapshot(input: {
  jobId: string;
  runId: string;
  createdAt: string;
  completedAt?: string;
}): FixtureDashboardSnapshot {
  return FixtureDashboardSnapshotSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    fixtureVersion: GOLDEN_FIXTURE_VERSION,
    provenance: "fixture",
    jobId: input.jobId,
    runId: input.runId,
    createdAt: input.createdAt,
    profile: {
      id: "indonesia-mobile-v1",
      label: "Indonesia Mobile",
      viewport: { width: 360, height: 800 },
      deviceScaleFactor: 2,
      locale: "id-ID",
      timeZone: "Asia/Jakarta",
      cpuSlowdown: 4,
      networkLabel: "Flaky 3G",
      latencyMs: 300,
      downloadBitsPerSecond: 3_600_000,
      uploadBitsPerSecond: 750_000,
    },
    baseline: {
      source: "fixture-golden-v1",
      sampleCount: 1,
      runId: "fixture-baseline-v1",
      verdict: "FAIL_BLOCKED",
      outcomeLabel: "Checkout blocked",
      taskCompleted: false,
      transferredBytes: 8_161_170,
      durationMs: 19_203.5371,
      displayMegabytes: "8.2 MB",
      displayDuration: "19 s",
    },
    verification: {
      source: "fixture-golden-v1",
      sampleCount: 1,
      runId: "fixture-verification-v1",
      verdict: "PASS",
      outcomeLabel: "Checkout completed",
      taskCompleted: true,
      transferredBytes: 1_400_000,
      durationMs: 6_000,
      displayMegabytes: "1.4 MB",
      displayDuration: "6 s",
    },
    failures: [
      {
        seedId: SEED_IDS[0],
        title: "Mononym blocked at identity validation",
        summary: "A one-word legal name is rejected by a two-part-name requirement before checkout can create an order.",
        evidenceRefs: ["assertions.json#seed.mononym-required-last-name", "screenshots/failure-or-confirmation.png"],
      },
      {
        seedId: SEED_IDS[1],
        title: "+62 normalization rejected",
        summary: "A valid Indonesian international number is rejected before it can normalize to E.164.",
        evidenceRefs: ["assertions.json#seed.phone-plus62-normalization", "screenshots/failure-or-confirmation.png"],
      },
      {
        seedId: SEED_IDS[2],
        title: "Checkout ships an 8 MB recommendation payload",
        summary: "A non-essential eager response consumes the constrained transfer budget and drives the journey past its duration budget.",
        evidenceRefs: ["requests.jsonl", "network.har", "metrics.json"],
      },
    ],
    completion: input.completedAt
      ? { status: "REHEARSAL_COMPLETE", terminalState: "INCONCLUSIVE", completedAt: input.completedAt }
      : { status: "PENDING", terminalState: null, completedAt: null },
    evidence: [
      {
        id: "evidence-start",
        label: "Checkout at measured start",
        type: "screenshot",
        artifactPath: "screenshots/00-start.png",
        previewPath: "/fixtures/baseline-start.png",
        note: "Synthetic screenshot fixture from the accepted baseline journey.",
      },
      {
        id: "evidence-failure",
        label: "Terminal validation failure",
        type: "screenshot",
        artifactPath: "screenshots/failure-or-confirmation.png",
        previewPath: "/fixtures/baseline-failure.png",
        note: "The two identity failures remain visible together at the terminal oracle.",
      },
      {
        id: "evidence-trace",
        label: "Browser trace",
        type: "trace",
        artifactPath: "trace.zip",
        note: "Fixture ledger entry only; no live trace is served by the dashboard.",
      },
      {
        id: "evidence-har",
        label: "Redacted network HAR",
        type: "har",
        artifactPath: "network.har",
        note: "Fixture ledger entry with response content omitted and sensitive fields redacted.",
      },
      {
        id: "evidence-assertions",
        label: "Verifier assertions",
        type: "assertions",
        artifactPath: "assertions.json",
        note: "Explicit oracle results, including the three stable seed IDs.",
      },
      {
        id: "evidence-requests",
        label: "Encoded transfer ledger",
        type: "requests",
        artifactPath: "requests.jsonl",
        note: "One terminal CDP encoded byte count per target response.",
      },
      {
        id: "evidence-metrics",
        label: "Monotonic journey metrics",
        type: "metrics",
        artifactPath: "metrics.json",
        note: "Single-observation duration, transfer, request, error, and Web Vital fields.",
      },
    ],
    approval: {
      allowed: false,
      reason: "Fixture rehearsals cannot be approved",
    },
  });
}
