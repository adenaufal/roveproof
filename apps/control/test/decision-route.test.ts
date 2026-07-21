import { describe, expect, it, vi } from "vitest";

// The store is mocked at the control-server boundary so the security-critical
// decision route can be exercised without materializing a full crypto-bound M5
// candidate. `hooks.store` is swapped per test; `readRunOrigin` is inert because
// the mocked writeApprovalDecision does not consume the origin.
const hooks = vi.hoisted(() => ({ store: null as unknown as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock("../src/lib/control-server.js", () => ({
  controlStore: () => hooks.store,
  readRunOrigin: vi.fn(async () => ({})),
}));

const { POST } = await import("../src/app/api/candidates/[id]/decision/route.js");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CANDIDATE_ID = "cand-review-01";

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    candidateId: CANDIDATE_ID,
    jobId: "job-verification",
    runId: "run-verify-01",
    baselineRunId: "run-base-01",
    mode: "real",
    diffHash: HASH_A,
    state: "READY_FOR_HUMAN_REVIEW",
    ...overrides,
  };
}

function makeStore(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    readCandidateRecord: vi.fn(async () => baseRecord()),
    readCandidateEnvelope: vi.fn(async () => ({ combinedDiffHash: HASH_A })),
    writeApprovalDecision: vi.fn(async () => ({})),
    transitionCandidateState: vi.fn(async () => ({ state: "REJECTED" })),
    ...overrides,
  };
}

function decisionRequest(id: string, body: unknown, origin: string | null = "http://localhost:3000") {
  return new Request(`http://localhost:3000/api/candidates/${id}/decision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code ?? "";
}

describe.sequential("candidate decision route", () => {
  it("rejects a cross-origin / origin-less caller", async () => {
    hooks.store = makeStore();
    const response = await POST(decisionRequest(CANDIDATE_ID, { decision: "approve", combinedDiffHash: HASH_A }, null), params(CANDIDATE_ID));
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("ORIGIN_REJECTED");
    expect(hooks.store.writeApprovalDecision).not.toHaveBeenCalled();
  });

  it("rejects a stale combined diff hash with 409 STALE_HASH", async () => {
    hooks.store = makeStore();
    const response = await POST(decisionRequest(CANDIDATE_ID, { decision: "approve", combinedDiffHash: HASH_B }), params(CANDIDATE_ID));
    expect(response.status).toBe(409);
    expect(await code(response)).toBe("STALE_HASH");
    expect(hooks.store.writeApprovalDecision).not.toHaveBeenCalled();
  });

  it("forbids deciding a fixture-mode candidate with 403", async () => {
    hooks.store = makeStore({ readCandidateRecord: vi.fn(async () => baseRecord({ mode: "fixture" })) });
    const response = await POST(decisionRequest(CANDIDATE_ID, { decision: "approve", combinedDiffHash: HASH_A }), params(CANDIDATE_ID));
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("FIXTURE_APPROVAL_FORBIDDEN");
    expect(hooks.store.writeApprovalDecision).not.toHaveBeenCalled();
  });

  it("rejects a candidate that is not ready for human review with 409", async () => {
    hooks.store = makeStore({ readCandidateRecord: vi.fn(async () => baseRecord({ state: "VERIFYING_CLEAN" })) });
    const response = await POST(decisionRequest(CANDIDATE_ID, { decision: "approve", combinedDiffHash: HASH_A }), params(CANDIDATE_ID));
    expect(response.status).toBe(409);
    expect(await code(response)).toBe("CANDIDATE_NOT_READY");
    expect(hooks.store.writeApprovalDecision).not.toHaveBeenCalled();
  });

  it("writes an APPROVED decision bound to the store's current hash and does not transition state", async () => {
    const writeApprovalDecision = vi.fn(async () => ({}));
    hooks.store = makeStore({ writeApprovalDecision });
    const response = await POST(decisionRequest(CANDIDATE_ID, { decision: "approve", combinedDiffHash: HASH_A }), params(CANDIDATE_ID));
    expect(response.status).toBe(200);
    expect(writeApprovalDecision).toHaveBeenCalledOnce();
    const [, recordArg, decisionArg] = writeApprovalDecision.mock.calls[0] as unknown as [unknown, { candidateId: string }, { decision: string; diffHash: string; actor: string }];
    expect(recordArg.candidateId).toBe(CANDIDATE_ID);
    expect(decisionArg.decision).toBe("APPROVED");
    expect(decisionArg.diffHash).toBe(HASH_A);
    expect(decisionArg.actor.length).toBeGreaterThan(0);
    // Approve is export-only: it must not transition candidate state.
    expect(hooks.store.transitionCandidateState).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ decision: "approve", state: "READY_FOR_HUMAN_REVIEW" });
  });

  it("records a REJECTED decision and transitions the candidate to REJECTED", async () => {
    const writeApprovalDecision = vi.fn(async () => ({}));
    const transitionCandidateState = vi.fn(async () => ({ state: "REJECTED" }));
    hooks.store = makeStore({ writeApprovalDecision, transitionCandidateState });
    const response = await POST(decisionRequest(CANDIDATE_ID, { decision: "reject", combinedDiffHash: HASH_A }), params(CANDIDATE_ID));
    expect(response.status).toBe(200);
    const [, , decisionArg] = writeApprovalDecision.mock.calls[0] as unknown as [unknown, unknown, { decision: string }];
    expect(decisionArg.decision).toBe("REJECTED");
    expect(transitionCandidateState).toHaveBeenCalledWith(CANDIDATE_ID, "REJECTED");
    expect(await response.json()).toMatchObject({ decision: "reject", state: "REJECTED" });
  });
});
