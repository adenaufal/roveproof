import { isTerminalRunState, type ControlJobView, type RunState } from "@roveproof/contracts";
import { FileControlStore, StoreBusyError } from "@roveproof/store";
import { createGoldenFixtureSnapshot } from "./fixture.js";

const FIXTURE_ROUTE: ReadonlyArray<Readonly<{ state: RunState; message: string }>> = [
  { state: "REQUESTED", message: "Fixture rehearsal requested" },
  { state: "BASELINE_RUNNING", message: "Applying the Indonesia Mobile fixture profile" },
  { state: "BASELINE_FAILED_EXPECTED", message: "Three expected checkout failures reproduced" },
  { state: "ANALYZING", message: "Loading cited fixture diagnosis" },
  { state: "TEST_AUTHORING", message: "Rehearsing the regression-test phase" },
  { state: "TEST_FAILED_AS_EXPECTED", message: "Fixture regression test failed for the expected reason" },
  { state: "PATCH_AUTHORING", message: "Loading the bounded fixture candidate" },
  { state: "SANDBOX_GATING", message: "Replaying fixture policy and command gates" },
  { state: "VERIFYING_CLEAN", message: "Loading the clean verification fixture" },
  { state: "INCONCLUSIVE", message: "Fixture rehearsal complete; approval remains intentionally unavailable" },
];

export type FixtureWorkerOptions = Readonly<{
  store: FileControlStore;
  jobId: string;
  sleep?: (milliseconds: number) => Promise<void>;
  transitionDelayMs?: number;
}>;

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function completeSnapshot(store: FileControlStore, view: ControlJobView, completedAt: string): Promise<void> {
  if (view.snapshot.completion.status === "REHEARSAL_COMPLETE") return;
  await store.updateSnapshot(view.job.jobId, createGoldenFixtureSnapshot({
    jobId: view.job.jobId,
    runId: view.job.runId,
    createdAt: view.snapshot.createdAt,
    completedAt,
  }));
}

export async function runFixtureJob(options: FixtureWorkerOptions): Promise<ControlJobView> {
  const lease = await options.store.acquireWorkerLease(options.jobId);
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = options.transitionDelayMs ?? 280;

  try {
    let view = await options.store.readView(options.jobId);
    if (isTerminalRunState(view.job.state)) {
      if (view.job.state === "INCONCLUSIVE") await completeSnapshot(options.store, view, view.job.updatedAt);
      return options.store.readView(options.jobId);
    }

    const currentIndex = FIXTURE_ROUTE.findIndex(({ state }) => state === view.job.state);
    if (currentIndex < 0) throw new Error(`Fixture worker cannot resume state ${view.job.state}`);

    for (const step of FIXTURE_ROUTE.slice(currentIndex + 1)) {
      await sleep(delayMs);
      const event = await options.store.transition(options.jobId, step.state, step.message);
      view = await options.store.readView(options.jobId);
      if (step.state === "INCONCLUSIVE") await completeSnapshot(options.store, view, event.occurredAt);
    }

    return options.store.readView(options.jobId);
  } catch (error) {
    const view = await options.store.readView(options.jobId).catch(() => null);
    if (view && !isTerminalRunState(view.job.state)) {
      const terminalEvent = await options.store.transition(
        options.jobId,
        "INCONCLUSIVE",
        "Fixture rehearsal stopped by a control-plane error",
      );
      await completeSnapshot(options.store, await options.store.readView(options.jobId), terminalEvent.occurredAt);
    }
    throw error;
  } finally {
    await lease.release();
  }
}

export function launchFixtureWorker(options: FixtureWorkerOptions): void {
  void (async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await runFixtureJob(options);
        return;
      } catch (error) {
        if (error instanceof StoreBusyError && attempt < 5) {
          await defaultSleep(100);
          continue;
        }
        if (!(error instanceof StoreBusyError)) {
          console.error("Fixture worker failed closed:", error instanceof Error ? error.name : "UnknownError");
        }
        return;
      }
    }
  })();
}

export { FIXTURE_ROUTE };
