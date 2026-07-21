import type { CDPSession } from "playwright";
import type { EvidenceManifest } from "@roveproof/contracts";
import { INDONESIA_MOBILE_PROFILE } from "./config.js";
import type { NetworkCollector } from "./collectors.js";
import { applyNetworkCondition } from "./profile.js";

type JitterEvidence = EvidenceManifest["runtime"]["jitter"];
type MutableJitterEvent<Phase extends "degraded" | "restored", PlannedAt extends number> = {
  phase: Phase;
  plannedAtMs: PlannedAt;
  appliedAtMs: number | null;
  ruleId: string | null;
};

type MutableJitterEvents = [
  MutableJitterEvent<"degraded", 0>,
  MutableJitterEvent<"restored", 250>,
];

const MAX_APPLICATION_DRIFT_MS = 100;
const MAX_WINDOW_DRIFT_MS = 100;

export class DeterministicJitterController {
  readonly #session: CDPSession;
  readonly #collector: NetworkCollector;
  readonly #events: MutableJitterEvents;
  readonly #timers: Array<ReturnType<typeof setTimeout>> = [];
  readonly #completions: Array<Promise<void>> = [];
  readonly #resolveCompletions: Array<() => void> = [];
  #chain: Promise<void> = Promise.resolve();
  #boundaryStarted = 0;
  #started = false;
  #canceled = false;

  constructor(session: CDPSession, collector: NetworkCollector) {
    this.#session = session;
    this.#collector = collector;
    this.#events = [
      { phase: "degraded", plannedAtMs: 0, appliedAtMs: null, ruleId: null },
      { phase: "restored", plannedAtMs: 250, appliedAtMs: null, ruleId: null },
    ];
  }

  async start(boundaryStarted: number): Promise<void> {
    if (this.#started) throw new Error("Deterministic jitter schedule has already started");
    this.#started = true;
    this.#boundaryStarted = boundaryStarted;

    INDONESIA_MOBILE_PROFILE.jitter.events.forEach((condition, index) => {
      let resolveCompletion: () => void = () => undefined;
      let rejectCompletion: (error: unknown) => void = () => undefined;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      this.#completions.push(completion);
      this.#resolveCompletions.push(resolveCompletion);
      const delay = Math.max(0, condition.atMs - (performance.now() - boundaryStarted));
      const timer = setTimeout(() => {
        if (this.#canceled) {
          resolveCompletion();
          return;
        }
        this.#chain = this.#chain.then(async () => {
          const applied = await applyNetworkCondition(this.#session, condition);
          const appliedAtMs = performance.now() - this.#boundaryStarted;
          this.#events[index].appliedAtMs = appliedAtMs;
          this.#events[index].ruleId = applied.ruleId;
          this.#collector.addAllowedRule(applied.ruleId);
        });
        this.#chain.then(resolveCompletion, rejectCompletion);
      }, delay);
      this.#timers.push(timer);
    });
    await this.#completions[0];
  }

  async finish(): Promise<JitterEvidence> {
    if (!this.#started) throw new Error("Deterministic jitter schedule was not started");
    await Promise.all(this.#completions);
    await this.#chain;
    const actualWindowMs = (this.#events[1].appliedAtMs ?? Number.NaN) - (this.#events[0].appliedAtMs ?? Number.NaN);
    const plannedWindowMs = this.#events[1].plannedAtMs - this.#events[0].plannedAtMs;
    const completed = this.#events.every((event) =>
      event.appliedAtMs !== null &&
      event.ruleId !== null &&
      Math.abs(event.appliedAtMs - event.plannedAtMs) <= MAX_APPLICATION_DRIFT_MS,
    ) && Math.abs(actualWindowMs - plannedWindowMs) <= MAX_WINDOW_DRIFT_MS;
    if (!completed) throw new Error("Deterministic jitter schedule did not apply within the frozen tolerance");
    return {
      schedule: "deterministic-jitter-v1",
      completed: true,
      events: [
        { ...this.#events[0] },
        { ...this.#events[1] },
      ],
    };
  }

  async cancel(): Promise<JitterEvidence> {
    this.#canceled = true;
    for (const timer of this.#timers) clearTimeout(timer);
    for (const resolveCompletion of this.#resolveCompletions) resolveCompletion();
    await Promise.allSettled(this.#completions);
    await this.#chain.catch(() => undefined);
    return {
      schedule: "deterministic-jitter-v1",
      completed: false,
      events: [
        { ...this.#events[0] },
        { ...this.#events[1] },
      ],
    };
  }
}

export function unavailableJitterEvidence(): JitterEvidence {
  return {
    schedule: "deterministic-jitter-v1",
    completed: false,
    events: [
      { phase: "degraded", plannedAtMs: 0, appliedAtMs: null, ruleId: null },
      { phase: "restored", plannedAtMs: 250, appliedAtMs: null, ruleId: null },
    ],
  };
}
