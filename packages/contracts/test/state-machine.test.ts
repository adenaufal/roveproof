import { describe, expect, it } from "vitest";
import {
  RUN_STATES,
  RunOriginSchema,
  StateTransitionSchema,
  validateStateTransitionForOrigin,
  type ExecutionMode,
  type RunState,
} from "../src/index.js";

const expectedRealTransitions: Record<RunState, readonly RunState[]> = {
  REQUESTED: ["BASELINE_RUNNING", "INCONCLUSIVE"],
  BASELINE_RUNNING: ["BASELINE_FAILED_EXPECTED", "INCONCLUSIVE"],
  BASELINE_FAILED_EXPECTED: ["ANALYZING", "INCONCLUSIVE"],
  ANALYZING: ["TEST_AUTHORING", "INCONCLUSIVE"],
  TEST_AUTHORING: ["TEST_FAILED_AS_EXPECTED", "INCONCLUSIVE"],
  TEST_FAILED_AS_EXPECTED: ["PATCH_AUTHORING", "INCONCLUSIVE"],
  PATCH_AUTHORING: ["SANDBOX_GATING", "INCONCLUSIVE"],
  SANDBOX_GATING: ["VERIFYING_CLEAN", "REJECTED", "INCONCLUSIVE"],
  VERIFYING_CLEAN: ["READY_FOR_HUMAN_REVIEW", "INCONCLUSIVE"],
  READY_FOR_HUMAN_REVIEW: ["APPROVED", "REJECTED", "INCONCLUSIVE"],
  APPROVED: [],
  REJECTED: [],
  INCONCLUSIVE: [],
};

const originFields = {
  schemaVersion: 1,
  jobId: "job-001",
  runId: "run-001",
  targetId: "seeded-checkout-v1",
  journeyId: "checkout-v1",
  profileId: "indonesia-mobile-v1",
  seedIds: [
    "ID-MONONYM-REQUIRED-LAST-NAME",
    "ID-PHONE-PLUS62-NORMALIZATION",
    "MOBILE-HEAVY-CHECKOUT-BUNDLE",
  ],
} as const;

function expectedTransition(from: RunState, to: RunState, mode: ExecutionMode): boolean {
  if (mode === "fixture" && (to === "READY_FOR_HUMAN_REVIEW" || to === "APPROVED")) return false;
  return expectedRealTransitions[from].includes(to);
}

describe("run state machine", () => {
  it.each(["real", "fixture"] as const)("implements the complete %s transition matrix", (mode) => {
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        const expected = expectedTransition(from, to, mode);
        const transition = { schemaVersion: 1, jobId: "job-001", runId: "run-001", mode, from, to };
        expect(StateTransitionSchema.safeParse(transition).success, `${mode}: ${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("runtime-validates and freezes originating job/run provenance", () => {
    const origin = RunOriginSchema.parse({ ...originFields, mode: "real" });
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.seedIds)).toBe(true);
    expect(RunOriginSchema.safeParse({ ...originFields, mode: "real", targetId: "another-target" }).success).toBe(false);
  });

  it("accepts a real transition whose provenance matches its trusted origin", () => {
    const origin = RunOriginSchema.parse({ ...originFields, mode: "real" });
    const transition = {
      schemaVersion: 1, jobId: origin.jobId, runId: origin.runId, mode: "real",
      from: "VERIFYING_CLEAN", to: "READY_FOR_HUMAN_REVIEW",
    } as const;
    expect(validateStateTransitionForOrigin(origin, transition)).toEqual(transition);
  });

  it("rejects a fixture-origin review transition maliciously relabeled real", () => {
    const fixtureOrigin = RunOriginSchema.parse({ ...originFields, mode: "fixture" });
    const relabeledTransition = {
      schemaVersion: 1, jobId: fixtureOrigin.jobId, runId: fixtureOrigin.runId, mode: "real",
      from: "VERIFYING_CLEAN", to: "READY_FOR_HUMAN_REVIEW",
    } as const;
    expect(StateTransitionSchema.safeParse(relabeledTransition).success).toBe(true);
    expect(() => validateStateTransitionForOrigin(fixtureOrigin, relabeledTransition)).toThrow(/mode does not match/);
  });

  it.each([
    ["jobId", "job-002", /job ID does not match/],
    ["runId", "run-002", /run ID does not match/],
    ["mode", "fixture", /mode does not match/],
  ] as const)("rejects a transition with mismatched %s provenance", (field, value, message) => {
    const origin = RunOriginSchema.parse({ ...originFields, mode: "real" });
    const transition = {
      schemaVersion: 1, jobId: origin.jobId, runId: origin.runId, mode: "real",
      from: "REQUESTED", to: "BASELINE_RUNNING", [field]: value,
    };
    expect(() => validateStateTransitionForOrigin(origin, transition)).toThrow(message);
  });

  it("requires job, run, and mode provenance on transitions", () => {
    expect(StateTransitionSchema.safeParse({ schemaVersion: 1, from: "REQUESTED", to: "BASELINE_RUNNING" }).success).toBe(false);
  });
});
