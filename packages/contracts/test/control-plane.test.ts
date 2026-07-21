import { describe, expect, it } from "vitest";
import {
  ControlJobCreateSchema,
  ControlJobRecordSchema,
  isTerminalRunState,
  TERMINAL_RUN_STATES,
} from "../src/index.js";

const fixtureJob = {
  schemaVersion: 1,
  fixtureVersion: "golden-control-v1",
  jobId: "job-contract-test",
  runId: "run-contract-test",
  mode: "fixture",
  targetId: "seeded-checkout-v1",
  journeyId: "checkout-v1",
  profileId: "indonesia-mobile-v1",
  seedIds: [
    "ID-MONONYM-REQUIRED-LAST-NAME",
    "ID-PHONE-PLUS62-NORMALIZATION",
    "MOBILE-HEAVY-CHECKOUT-BUNDLE",
  ],
  idempotencyKeyHash: "a".repeat(64),
  requestHash: "b".repeat(64),
  state: "REQUESTED",
  lastSequence: 1,
  createdAt: "2026-07-18T03:00:00.000Z",
  updatedAt: "2026-07-18T03:00:00.000Z",
} as const;

describe("control-plane contracts", () => {
  it("accepts only a strict fixture create request", () => {
    expect(ControlJobCreateSchema.safeParse({ schemaVersion: 1, mode: "fixture" }).success).toBe(true);
    expect(ControlJobCreateSchema.safeParse({ schemaVersion: 1, mode: "real" }).success).toBe(false);
    expect(ControlJobCreateSchema.safeParse({ schemaVersion: 1, mode: "fixture", targetUrl: "https://example.test" }).success).toBe(false);
  });

  it("prevents fixture job projections from becoming review-ready or approved", () => {
    expect(ControlJobRecordSchema.safeParse(fixtureJob).success).toBe(true);
    expect(ControlJobRecordSchema.safeParse({ ...fixtureJob, state: "READY_FOR_HUMAN_REVIEW" }).success).toBe(false);
    expect(ControlJobRecordSchema.safeParse({ ...fixtureJob, state: "APPROVED" }).success).toBe(false);
  });

  it("exposes the complete terminal-state predicate", () => {
    expect(TERMINAL_RUN_STATES).toEqual(["APPROVED", "REJECTED", "INCONCLUSIVE"]);
    expect(isTerminalRunState("INCONCLUSIVE")).toBe(true);
    expect(isTerminalRunState("VERIFYING_CLEAN")).toBe(false);
  });
});
