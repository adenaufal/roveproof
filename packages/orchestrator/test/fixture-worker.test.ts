import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureDashboardSnapshotSchema } from "@roveproof/contracts";
import { FileControlStore, StoreBusyError } from "@roveproof/store";
import {
  createGoldenFixtureSnapshot,
  FIXTURE_ROUTE,
  runFixtureJob,
} from "../src/index.js";

const roots: string[] = [];

async function fixtureJob() {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-worker-"));
  roots.push(root);
  const store = new FileControlStore(root);
  const created = await store.createFixtureJob({
    idempotencyKey: "fixture:worker-0001",
    jobId: "job-worker-test",
    runId: "run-worker-test",
    now: () => new Date("2026-07-18T02:00:00.000Z"),
    snapshot: createGoldenFixtureSnapshot,
  });
  return { store, jobId: created.view.job.jobId };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("golden fixture worker", () => {
  it("schema-locks golden values to fixture provenance and disabled approval", () => {
    const snapshot = createGoldenFixtureSnapshot({
      jobId: "job-schema-test",
      runId: "run-schema-test",
      createdAt: "2026-07-18T02:00:00.000Z",
    });
    expect(FixtureDashboardSnapshotSchema.safeParse({ ...snapshot, approval: { ...snapshot.approval, allowed: true } }).success).toBe(false);
    expect(FixtureDashboardSnapshotSchema.safeParse({ ...snapshot, baseline: { ...snapshot.baseline, source: "measured-real" } }).success).toBe(false);
    expect(FixtureDashboardSnapshotSchema.safeParse({
      ...snapshot,
      evidence: [{ ...snapshot.evidence[0], previewPath: "/fixtures/../../outside" }],
    }).success).toBe(false);
    expect(snapshot.failures).toHaveLength(3);
  });

  it("runs the accepted fixture route and completes as INCONCLUSIVE", async () => {
    const { store, jobId } = await fixtureJob();
    const result = await runFixtureJob({ store, jobId, sleep: async () => undefined, transitionDelayMs: 0 });

    expect(result.events.map(({ state }) => state)).toEqual(FIXTURE_ROUTE.map(({ state }) => state));
    expect(result.events.map(({ state }) => state)).not.toContain("READY_FOR_HUMAN_REVIEW");
    expect(result.events.map(({ state }) => state)).not.toContain("APPROVED");
    expect(result.job.state).toBe("INCONCLUSIVE");
    expect(result.snapshot.completion).toMatchObject({
      status: "REHEARSAL_COMPLETE",
      terminalState: "INCONCLUSIVE",
    });
    expect(result.snapshot.approval.allowed).toBe(false);
    expect(result.snapshot.failures.map(({ seedId }) => seedId)).toEqual([
      "ID-MONONYM-REQUIRED-LAST-NAME",
      "ID-PHONE-PLUS62-NORMALIZATION",
      "MOBILE-HEAVY-CHECKOUT-BUNDLE",
    ]);
    expect(result.snapshot.baseline).toMatchObject({ displayMegabytes: "8.2 MB", displayDuration: "19 s", source: "fixture-golden-v1" });
    expect(result.snapshot.verification).toMatchObject({ displayMegabytes: "1.4 MB", displayDuration: "6 s", source: "fixture-golden-v1" });
  });

  it("releases the single active slot only after terminal fixture completion is persisted", async () => {
    const { store, jobId } = await fixtureJob();
    await runFixtureJob({ store, jobId, sleep: async () => undefined, transitionDelayMs: 0 });
    const next = await store.createFixtureJob({
      idempotencyKey: "fixture:worker-0002",
      jobId: "job-worker-next",
      runId: "run-worker-next",
      snapshot: createGoldenFixtureSnapshot,
    });
    expect(next.created).toBe(true);
    expect(next.view.job.state).toBe("REQUESTED");
  });

  it("is idempotent when asked to resume a completed fixture", async () => {
    const { store, jobId } = await fixtureJob();
    const first = await runFixtureJob({ store, jobId, sleep: async () => undefined, transitionDelayMs: 0 });
    const replay = await runFixtureJob({ store, jobId, sleep: async () => undefined, transitionDelayMs: 0 });
    expect(replay.events).toEqual(first.events);
  });

  it("rejects a concurrent second worker with the global lease", async () => {
    const { store, jobId } = await fixtureJob();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let firstSleep = true;
    const first = runFixtureJob({
      store,
      jobId,
      transitionDelayMs: 0,
      sleep: async () => {
        if (!firstSleep) return;
        firstSleep = false;
        signalEntered();
        await gate;
      },
    });
    await entered;
    await expect(runFixtureJob({ store, jobId, sleep: async () => undefined, transitionDelayMs: 0 })).rejects.toBeInstanceOf(StoreBusyError);
    releaseFirst();
    await first;
  });

  it("fails closed to INCONCLUSIVE when a fixture phase throws", async () => {
    const { store, jobId } = await fixtureJob();
    await expect(runFixtureJob({
      store,
      jobId,
      sleep: async () => { throw new Error("injected fixture failure"); },
      transitionDelayMs: 0,
    })).rejects.toThrow(/injected fixture failure/);

    const view = await store.readView(jobId);
    expect(view.job.state).toBe("INCONCLUSIVE");
    expect(view.snapshot.completion.status).toBe("REHEARSAL_COMPLETE");
    expect(view.events.at(-1)?.message).toMatch(/control-plane error/);
  });
});
