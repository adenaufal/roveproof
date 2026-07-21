import { spawn } from "node:child_process";
import { appendFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGoldenFixtureSnapshot } from "@roveproof/orchestrator";
import {
  ActiveJobConflictError,
  FileControlStore,
  JobNotFoundError,
  StoreBusyError,
} from "../src/index.js";

const roots: string[] = [];

async function temporaryStore(): Promise<{ root: string; store: FileControlStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-store-"));
  roots.push(root);
  return { root, store: new FileControlStore(root) };
}

async function create(store: FileControlStore, key = "fixture:test-0001") {
  return store.createFixtureJob({
    idempotencyKey: key,
    jobId: "job-store-test",
    runId: "run-store-test",
    now: () => new Date("2026-07-18T01:00:00.000Z"),
    snapshot: createGoldenFixtureSnapshot,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileControlStore", () => {
  it("returns the same immutable job for an idempotency replay", async () => {
    const { root, store } = await temporaryStore();
    const first = await create(store);
    const originPath = path.join(root, "origins", "run-store-test.json");
    const originBefore = await readFile(originPath, "utf8");
    const replay = await create(store);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.view.job.jobId).toBe(first.view.job.jobId);
    expect(replay.view.events).toHaveLength(1);
    expect(await readFile(originPath, "utf8")).toBe(originBefore);
  });

  it("rejects a different request while the single active slot is occupied", async () => {
    const { store } = await temporaryStore();
    await create(store);
    await expect(store.createFixtureJob({
      idempotencyKey: "fixture:test-0002",
      snapshot: createGoldenFixtureSnapshot,
    })).rejects.toBeInstanceOf(ActiveJobConflictError);
  });

  it("persists strictly increasing events and reconciles the job projection", async () => {
    const { store } = await temporaryStore();
    await create(store);
    await store.transition("job-store-test", "BASELINE_RUNNING", "Baseline started", () => new Date("2026-07-18T01:00:01.000Z"));
    await store.transition("job-store-test", "BASELINE_FAILED_EXPECTED", "Expected failure", () => new Date("2026-07-18T01:00:02.000Z"));

    const view = await store.readView("job-store-test");
    expect(view.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(view.job).toMatchObject({ state: "BASELINE_FAILED_EXPECTED", lastSequence: 3 });
  });

  it("fails closed on path traversal and completed malformed JSONL", async () => {
    const { root, store } = await temporaryStore();
    await create(store);
    await expect(store.readJob("../../secrets")).rejects.toThrow();

    await appendFile(path.join(root, "events", "job-store-test.jsonl"), "not-json\n", "utf8");
    await expect(store.readEvents("job-store-test")).rejects.toThrow();
  });

  it("truncates a torn trailing record before the next durable event", async () => {
    const { root, store } = await temporaryStore();
    await create(store);
    await appendFile(path.join(root, "events", "job-store-test.jsonl"), "{\"schemaVersion\":", "utf8");
    await expect(store.readEvents("job-store-test")).resolves.toHaveLength(1);
    await store.transition("job-store-test", "BASELINE_RUNNING", "Recovered after torn tail");
    await expect(store.readEvents("job-store-test")).resolves.toMatchObject([
      { sequence: 1, state: "REQUESTED" },
      { sequence: 2, state: "BASELINE_RUNNING" },
    ]);
  });

  it("rejects impossible, post-terminal, or fixture-approved event history", async () => {
    const { root, store } = await temporaryStore();
    await create(store);
    const [initial] = await store.readEvents("job-store-test");
    const eventPath = path.join(root, "events", "job-store-test.jsonl");
    await writeFile(eventPath, [
      initial,
      { ...initial, sequence: 2, state: "APPROVED", occurredAt: "2026-07-18T01:00:01.000Z" },
      { ...initial, sequence: 3, state: "INCONCLUSIVE", occurredAt: "2026-07-18T01:00:02.000Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    await expect(store.readEvents("job-store-test")).rejects.toThrow();

    const relabeledRunId = "run-relabeled-real";
    await writeFile(path.join(root, "origins", `${relabeledRunId}.json`), JSON.stringify({
      schemaVersion: 1,
      jobId: "job-store-test",
      runId: relabeledRunId,
      mode: "real",
      targetId: "seeded-checkout-v1",
      journeyId: "checkout-v1",
      profileId: "indonesia-mobile-v1",
      seedIds: [
        "ID-MONONYM-REQUIRED-LAST-NAME",
        "ID-PHONE-PLUS62-NORMALIZATION",
        "MOBILE-HEAVY-CHECKOUT-BUNDLE",
      ],
    }) + "\n", "utf8");
    const realRoute = [
      "REQUESTED", "BASELINE_RUNNING", "BASELINE_FAILED_EXPECTED", "ANALYZING", "TEST_AUTHORING",
      "TEST_FAILED_AS_EXPECTED", "PATCH_AUTHORING", "SANDBOX_GATING", "VERIFYING_CLEAN",
      "READY_FOR_HUMAN_REVIEW", "APPROVED",
    ];
    await writeFile(eventPath, realRoute.map((state, index) => JSON.stringify({
      ...initial,
      runId: relabeledRunId,
      mode: "real",
      sequence: index + 1,
      state,
      occurredAt: new Date(Date.parse("2026-07-18T01:00:00.000Z") + index * 1_000).toISOString(),
    })).join("\n") + "\n", "utf8");
    await expect(store.readEvents("job-store-test")).rejects.toThrow(/provenance|origin/i);
  });

  it("repairs interrupted idempotency and latest projections from the committed job", async () => {
    const { root, store } = await temporaryStore();
    const first = await create(store);
    const [mapping] = await readdir(path.join(root, "idempotency"));
    await Promise.all([
      unlink(path.join(root, "idempotency", mapping!)),
      unlink(path.join(root, "latest-job.json")),
    ]);

    const replay = await create(store);
    expect(replay).toMatchObject({ created: false, view: { job: { jobId: first.view.job.jobId } } });
    expect((await store.readLatestView())?.job.jobId).toBe(first.view.job.jobId);
    await expect(store.createFixtureJob({
      idempotencyKey: "fixture:test-0002",
      snapshot: createGoldenFixtureSnapshot,
    })).rejects.toBeInstanceOf(ActiveJobConflictError);
  });

  it("recovers a lease after its owning process is terminated", async () => {
    const { root, store } = await temporaryStore();
    await store.initialize();
    const storeModule = pathToFileURL(path.resolve("packages/store/dist/index.js")).href;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { FileControlStore } from ${JSON.stringify(storeModule)};
      const store = new FileControlStore(${JSON.stringify(root)});
      await store.acquireWorkerLease("job-crash-owner");
      console.log("LEASE_READY");
      setInterval(() => undefined, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    const deadline = Date.now() + 8_000;
    while (!output.includes("LEASE_READY") && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Lease-owner child exited before acquiring its lease");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(output).toContain("LEASE_READY");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    const recovered = await store.acquireWorkerLease("job-crash-owner");
    await recovered.release();
  }, 15_000);

  it("fails closed instead of taking over a lease whose PID is still live", async () => {
    const { root, store } = await temporaryStore();
    await create(store);
    const leasePath = path.join(root, "leases", "fixture-worker.lock");
    await writeFile(leasePath, JSON.stringify({
      pid: process.pid,
      ownerToken: "00000000-0000-4000-8000-000000000000",
      createdAt: "2026-07-18T01:00:00.000Z",
    }) + "\n", "utf8");
    await expect(store.acquireWorkerLease("job-store-test")).rejects.toBeInstanceOf(StoreBusyError);
  });

  it("recovers a dead owner's global worker lease without unlinking live owners", async () => {
    const { root, store } = await temporaryStore();
    await create(store);
    const leasePath = path.join(root, "leases", "fixture-worker.lock");
    const ownerToken = "00000000-0000-4000-8000-000000000000";
    await writeFile(leasePath, JSON.stringify({
      pid: 999_999_999,
      ownerToken,
      createdAt: "2026-07-18T01:00:00.000Z",
    }) + "\n", "utf8");
    await link(leasePath, `${leasePath}.stale-${ownerToken}`);
    const contender = new FileControlStore(root);
    const attempts = await Promise.allSettled([
      store.acquireWorkerLease("job-store-test"),
      contender.acquireWorkerLease("job-other-test"),
    ]);
    const acquired = attempts.filter((attempt): attempt is PromiseFulfilledResult<{ release: () => Promise<void> }> => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StoreBusyError);
    await acquired[0]!.value.release();
  });

  it("rejects linked store ancestors, linked directories, and linked event files", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "roveproof-links-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "roveproof-outside-"));
    roots.push(parent, outside);
    const linkedAncestor = path.join(parent, "linked");
    await symlink(outside, linkedAncestor, process.platform === "win32" ? "junction" : "dir");
    await expect(new FileControlStore(path.join(linkedAncestor, "control")).initialize()).rejects.toThrow(/link|canonical/i);

    const safeRoot = path.join(parent, "safe");
    const safeStore = new FileControlStore(safeRoot);
    await safeStore.initialize();
    await rm(path.join(safeRoot, "events"), { recursive: true });
    await mkdir(path.join(outside, "events-target"));
    await symlink(path.join(outside, "events-target"), path.join(safeRoot, "events"), process.platform === "win32" ? "junction" : "dir");
    await expect(safeStore.initialize()).rejects.toThrow(/link|canonical/i);

    if (process.platform !== "win32") {
      const fileRoot = path.join(parent, "file-safe");
      const fileStore = new FileControlStore(fileRoot);
      await create(fileStore);
      const outsideEvent = path.join(outside, "outside-events.jsonl");
      await writeFile(outsideEvent, "outside-sentinel\n", "utf8");
      const eventPath = path.join(fileRoot, "events", "job-store-test.jsonl");
      await unlink(eventPath);
      await symlink(outsideEvent, eventPath, "file");
      await expect(fileStore.readEvents("job-store-test")).rejects.toThrow(/regular non-link|canonical/i);
      await expect(fileStore.transition("job-store-test", "BASELINE_RUNNING", "must not escape")).rejects.toThrow();
      expect(await readFile(outsideEvent, "utf8")).toBe("outside-sentinel\n");
    }
  });

  it("rejects replacement of a previously pinned artifact root", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "roveproof-root-pin-"));
    roots.push(parent);
    const root = path.join(parent, "control");
    const store = new FileControlStore(root);
    await store.initialize();
    await rename(root, path.join(parent, "original-control"));
    await mkdir(root);
    await expect(store.readLatestView()).rejects.toThrow(/root identity changed/i);
    await expect(new FileControlStore(root).initialize()).rejects.toThrow(/root identity changed/i);
  });

  it("enforces one global worker lease", async () => {
    const { store } = await temporaryStore();
    await create(store);
    const lease = await store.acquireWorkerLease("job-store-test");
    await expect(store.acquireWorkerLease("job-other-test")).rejects.toBeInstanceOf(StoreBusyError);
    await lease.release();
    const secondLease = await store.acquireWorkerLease("job-other-test");
    await secondLease.release();
  });

  it("fails closed when the latest pointer references a missing job", async () => {
    const { root, store } = await temporaryStore();
    await store.initialize();
    await writeFile(path.join(root, "latest-job.json"), JSON.stringify({
      schemaVersion: 1,
      jobId: "job-missing-test",
      updatedAt: "2026-07-18T01:00:00.000Z",
    }), "utf8");
    await expect(store.readLatestView()).rejects.toBeInstanceOf(JobNotFoundError);
  });
});
