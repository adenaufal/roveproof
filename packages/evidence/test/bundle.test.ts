import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import { SEED_IDS, type EvidenceManifest, type EvidenceMetrics, type EvidenceResult, type JourneyAssertions } from "@roveproof/contracts";
import { admitEvidenceBundle, EvidenceBundleWriter, type EvidenceRecords } from "../src/bundle";

const HASH = "b".repeat(64);

async function writeTrace(filePath: string, content = "fixed synthetic trace"): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(content), "trace.trace");
  const destination = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  const completed = new Promise<void>((resolve, reject) => {
    destination.on("close", resolve);
    destination.on("error", reject);
    zip.outputStream.on("error", reject);
  });
  zip.outputStream.pipe(destination);
  zip.end();
  await completed;
}

function records(runId: string): EvidenceRecords {
  const manifest: EvidenceManifest = {
    schemaVersion: 1,
    runId,
    kind: "baseline",
    mode: "real",
    targetId: "seeded-checkout-v1",
    journeyId: "checkout-v1",
    profileId: "indonesia-mobile-v1",
    seedIds: [...SEED_IDS],
    sourceRevision: `sha256:${HASH}`,
    candidateDiffHash: null,
    startedAt: "2026-07-18T01:00:00.000Z",
    completedAt: "2026-07-18T01:00:19.000Z",
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
        measuredRuleId: "measured-rule",
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
  const result: EvidenceResult = {
    schemaVersion: 1,
    runId,
    verdict: "FAIL_BLOCKED",
    firstCausalFailure: {
      code: SEED_IDS[0],
      message: "The legal mononym was rejected.",
      artifactRefs: ["assertions.json#seed.mononym"],
    },
    task: { completed: false, durationMs: 19_000, orderId: null, durableOrderCount: 0 },
    performance: {
      transferredBytes: 8_200_000,
      measurement: "sum of one terminal CDP Network.loadingFinished encodedDataLength per target response within monotonic journey boundaries",
      lcpMs: 2_000,
      inpMs: 80,
      cls: 0,
    },
    sampleCount: 1,
  };
  const assertions: JourneyAssertions = {
    schemaVersion: 1,
    runId,
    journeyId: "checkout-v1",
    expectedSeedIds: [...SEED_IDS],
    observedSeedIds: [...SEED_IDS],
    assertions: [{
      id: "seed.mononym",
      status: "FAIL",
      message: "The seed reproduced.",
      seedId: SEED_IDS[0],
      artifactRefs: ["screenshots/failure-or-confirmation.png"],
    }],
  };
  const metrics: EvidenceMetrics = {
    schemaVersion: 1,
    runId,
    boundary: {
      clock: "node:performance.now",
      startedAt: "2026-07-18T01:00:00.000Z",
      completedAt: "2026-07-18T01:00:19.000Z",
      durationMs: 19_000,
    },
    transferredBytes: 8_200_000,
    requestCount: 1,
    failedRequestCount: 0,
    consoleErrorCount: 0,
    pageErrorCount: 0,
    lcpMs: 2_000,
    inpMs: 80,
    cls: 0,
  };
  return { manifest, result, assertions, metrics };
}

async function preparePayload(writer: EvidenceBundleWriter, traceContent?: string): Promise<void> {
  await writeFile(await writer.artifactPath("screenshots/00-start.png"), Buffer.from("png-start"), { flag: "wx" });
  await writeFile(await writer.artifactPath("screenshots/failure-or-confirmation.png"), Buffer.from("png-terminal"), { flag: "wx" });
  await writeTrace(await writer.artifactPath("trace.zip"), traceContent);
  await writer.writeJson("network.har", { log: { version: "1.2", entries: [] } });
  await writer.writeJsonLines("console.jsonl", []);
  await writer.writeJsonLines("requests.jsonl", [{ failed: false, encodedBytes: 8_200_000 }]);
}

describe("immutable evidence bundle publication", () => {
  it("indexes every payload artifact, publishes once, and verifies reader-side hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-evidence-"));
    const runId = "run-bundle-001";
    const writer = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(writer);

    const published = await writer.finalize(records(runId));
    expect(published.index.entries.map(({ path: artifactPath }) => artifactPath)).not.toContain("artifact-index.json");
    expect(published.index.entries.map(({ path: artifactPath }) => artifactPath)).toContain("trace.zip");
    expect(published.indexHash).toMatch(/^[a-f0-9]{64}$/);
    expect(published.anchor).toMatchObject({ runId, indexHash: published.indexHash, rootHash: published.index.rootHash });
    expect((await admitEvidenceBundle(published.directory)).index.rootHash).toBe(published.index.rootHash);
    await expect(stat(writer.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects internally contradictory measurement authorities before publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-evidence-measurement-"));
    const runId = "run-bundle-005";
    const writer = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(writer);
    const consistent = records(runId);
    const inconsistent = { ...consistent, metrics: { ...consistent.metrics, transferredBytes: 8_199_999 } };
    await expect(writer.finalize(inconsistent)).rejects.toThrow(/transferred byte measurements disagree/);
  });

  it("detects post-publication tampering through size and hash admission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-evidence-tamper-"));
    const runId = "run-bundle-002";
    const writer = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(writer);
    const published = await writer.finalize(records(runId));
    const resultPath = path.join(published.directory, "result.json");
    await chmod(resultPath, 0o600);
    await appendFile(resultPath, "tampered");
    await expect(admitEvidenceBundle(published.directory)).rejects.toThrow(/size mismatch|hash mismatch/);
  });

  it("rejects coordinated payload-plus-index rewriting against the external anchor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-evidence-anchor-"));
    const runId = "run-bundle-007";
    const writer = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(writer);
    const published = await writer.finalize(records(runId));
    const resultPath = path.join(published.directory, "result.json");
    const indexPath = path.join(published.directory, "artifact-index.json");
    await Promise.all([chmod(resultPath, 0o600), chmod(indexPath, 0o600)]);
    const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
    result.firstCausalFailure = {
      ...(result.firstCausalFailure as Record<string, unknown>),
      message: "Coordinated rewrite that remains schema-valid.",
    };
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      rootHash: string;
      entries: Array<{ path: string; size: number; sha256: string }>;
    };
    const resultBytes = await readFile(resultPath);
    const resultEntry = index.entries.find(({ path: artifactPath }) => artifactPath === "result.json");
    if (!resultEntry) throw new Error("Test index has no result entry");
    resultEntry.size = resultBytes.byteLength;
    resultEntry.sha256 = createHash("sha256").update(resultBytes).digest("hex");
    index.rootHash = createHash("sha256").update(
      index.entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(""),
    ).digest("hex");
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

    await expect(admitEvidenceBundle(published.directory)).rejects.toThrow(/anchor does not match/);
  });

  it("never overwrites an existing run publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-evidence-collision-"));
    const runId = "run-bundle-003";
    const first = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(first);
    await first.finalize(records(runId));

    const second = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(second);
    await expect(second.finalize(records(runId))).rejects.toThrow(/already exists/);
    expect(JSON.parse(await readFile(path.join(first.finalDirectory, "result.json"), "utf8"))).toMatchObject({ runId });
  });

  it("fails closed when an extracted trace entry contains unexpected personal data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-evidence-pii-"));
    const runId = "run-bundle-006";
    const writer = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(writer, "email=naufal@example.test phone=+62 899-1111-2222");
    await expect(writer.finalize(records(runId))).rejects.toThrow(/unexpected email address|unexpected Indonesian phone number/);
    await expect(stat(writer.finalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when an extracted trace entry contains a fake bearer token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-evidence-trace-"));
    const runId = "run-bundle-004";
    const writer = await EvidenceBundleWriter.create(root, runId);
    await preparePayload(writer, "Authorization: Bearer fake-trace-token-123");
    await expect(writer.finalize(records(runId))).rejects.toThrow(/trace\.zip:trace\.trace contains possible bearer token/);
    await expect(stat(writer.finalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
