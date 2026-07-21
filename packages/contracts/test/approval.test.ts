import { describe, expect, it } from "vitest";
import {
  CandidateRecordSchema,
  RunOriginSchema,
  validateApprovalForCandidate,
  validateCandidateForOrigin,
} from "../src/index.js";

const currentHash = "a".repeat(64);
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
const realOrigin = RunOriginSchema.parse({ ...originFields, mode: "real" });
const candidate = {
  schemaVersion: 1, candidateId: "candidate-001", jobId: "job-001", runId: "run-001",
  baselineRunId: "run-001", mode: "real", diffHash: currentHash,
  state: "READY_FOR_HUMAN_REVIEW",
} as const;
const decision = {
  schemaVersion: 1, candidateId: "candidate-001", diffHash: currentHash,
  decision: "APPROVED", actor: "local-reviewer", decidedAt: "2026-07-18T01:06:59+07:00",
} as const;

describe("hash-bound approvals", () => {
  it("accepts a review-ready real candidate with matching trusted provenance and hash", () => {
    expect(validateCandidateForOrigin(realOrigin, candidate)).toEqual(candidate);
    expect(validateApprovalForCandidate(realOrigin, candidate, decision)).toMatchObject({ decision: "APPROVED" });
  });

  it.each(["SANDBOX_GATING", "VERIFYING_CLEAN", "REJECTED"] as const)(
    "rejects a real candidate in the not-ready state %s",
    (state) => {
      expect(() => validateApprovalForCandidate(realOrigin, { ...candidate, state }, decision)).toThrow(/not ready for human review/);
    },
  );

  it("rejects stale or mismatched hashes", () => {
    expect(() => validateApprovalForCandidate(
      realOrigin, candidate, { ...decision, diffHash: "b".repeat(64) },
    )).toThrow(/stale or mismatched/);
  });

  it("rejects a mismatched candidate ID", () => {
    expect(() => validateApprovalForCandidate(
      realOrigin, candidate, { ...decision, candidateId: "candidate-002" },
    )).toThrow(/does not match/);
  });

  it("requires job, run, and mode provenance on candidate records", () => {
    const candidateWithoutOrigin = {
      schemaVersion: candidate.schemaVersion,
      candidateId: candidate.candidateId,
      baselineRunId: candidate.baselineRunId,
      diffHash: candidate.diffHash,
      state: candidate.state,
    };
    expect(CandidateRecordSchema.safeParse(candidateWithoutOrigin).success).toBe(false);
    expect(CandidateRecordSchema.safeParse({ ...candidate, mode: "fixture" }).success).toBe(false);
  });

  it("prevents a fixture origin from passing approval after its candidate is maliciously relabeled real", () => {
    const fixtureOrigin = RunOriginSchema.parse({ ...originFields, mode: "fixture" });
    const relabeledCandidate = { ...candidate, mode: "real" } as const;
    expect(CandidateRecordSchema.safeParse(relabeledCandidate).success).toBe(true);
    expect(() => validateApprovalForCandidate(fixtureOrigin, relabeledCandidate, decision)).toThrow(/mode does not match/);
  });

  it("prevents honestly labeled fixture candidates from passing approval validation", () => {
    const fixtureOrigin = RunOriginSchema.parse({ ...originFields, mode: "fixture" });
    expect(() => validateApprovalForCandidate(
      fixtureOrigin,
      { ...candidate, mode: "fixture", state: "VERIFYING_CLEAN" },
      decision,
    )).toThrow(/Fixture-origin candidates cannot pass approval validation/);
  });

  it.each([
    ["jobId", "job-002", /job ID does not match/],
    ["runId", "run-002", /run ID does not match/],
    ["mode", "fixture", /mode does not match/],
  ] as const)("rejects a candidate with mismatched %s provenance", (field, value, message) => {
    const mismatchedCandidate = {
      ...candidate,
      state: field === "mode" ? "VERIFYING_CLEAN" : candidate.state,
      [field]: value,
    };
    expect(() => validateCandidateForOrigin(realOrigin, mismatchedCandidate)).toThrow(message);
  });
});
