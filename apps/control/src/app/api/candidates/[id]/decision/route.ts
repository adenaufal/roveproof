import { EntityIdSchema, Sha256Schema } from "@roveproof/contracts";
import { CandidateNotFoundError } from "@roveproof/store";
import { z } from "zod";
import {
  apiErrorResponse,
  ControlApiError,
  noStoreHeaders,
  readBoundedJson,
  requireSameOrigin,
} from "../../../../../lib/control-api";
import { controlStore, readRunOrigin } from "../../../../../lib/control-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SECURITY: this control plane has no authenticated operator identity yet, so the
// recorded approver is a fixed placeholder. Attribution is NOT trustworthy until
// real operator auth is wired in.
// ponytail: constant actor, replace with authenticated identity before trusting it.
const DECISION_ACTOR = "roveproof-control-operator";

const DecisionBodySchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    combinedDiffHash: Sha256Schema,
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    // SECURITY (same-origin): reject any cross-origin / origin-less caller.
    requireSameOrigin(request);
    const candidateId = EntityIdSchema.parse((await params).id);
    // Bounded body read + strict shape validation (no extra keys).
    const body = DecisionBodySchema.parse(await readBoundedJson(request));

    const store = controlStore();

    // The mutable candidate record is the SOLE authority for the current state,
    // mode, and diff hash. A caller-supplied hash is never trusted as authority.
    const record = await store.readCandidateRecord(candidateId);

    // SECURITY (fixture block): fixture-provenance candidates can never be decided.
    if (record.mode !== "real") {
      throw new ControlApiError(403, "FIXTURE_APPROVAL_FORBIDDEN", "Fixture-mode candidates cannot be approved or rejected");
    }
    // SECURITY (state gate): only a fully verified, review-ready candidate is decidable.
    if (record.state !== "READY_FOR_HUMAN_REVIEW") {
      throw new ControlApiError(409, "CANDIDATE_NOT_READY", "The candidate is not ready for human review");
    }

    // Re-verify full candidate integrity + terminal PASS status and read the
    // authoritative combined diff hash. It must agree with the mutable record.
    const envelope = await store.readCandidateEnvelope(candidateId, { requireTerminalStatus: true });
    if (envelope.combinedDiffHash !== record.diffHash) {
      throw new ControlApiError(409, "CANDIDATE_INTEGRITY", "The candidate diff hash is inconsistent between record and envelope");
    }
    const currentHash = envelope.combinedDiffHash;

    // SECURITY (stale hash): the caller's hash must match the store's CURRENT hash.
    // The store value is authority; the caller-supplied hash is only a guard token.
    if (body.combinedDiffHash !== currentHash) {
      throw new ControlApiError(409, "STALE_HASH", "The supplied combined diff hash is stale; reload the candidate");
    }

    const origin = await readRunOrigin(store, record.runId);

    const decidedAt = new Date().toISOString();
    const decisionRecord = {
      schemaVersion: 1,
      candidateId,
      // Bind the store's authoritative hash, never the caller-supplied value.
      diffHash: currentHash,
      decision: body.decision === "approve" ? "APPROVED" : "REJECTED",
      actor: DECISION_ACTOR,
      decidedAt,
    };

    // Authoritative, write-once record. writeApprovalDecision independently re-runs
    // the real-mode + ready-state + candidateId + hash-match validation server-side.
    // SECURITY (export-only): approval ONLY writes this decision record. It never
    // merges, deploys, or executes anything, and writes nothing outside the store's
    // approval-decisions record.
    try {
      await store.writeApprovalDecision(origin, record, decisionRecord);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
        throw new ControlApiError(409, "CANDIDATE_ALREADY_DECIDED", "A decision has already been recorded for this candidate");
      }
      throw error;
    }

    // Reject transitions the candidate to the terminal REJECTED state. Approve
    // intentionally leaves the state at READY_FOR_HUMAN_REVIEW: the decision record
    // is the terminal export, and CandidateRecord has no APPROVED state to move to.
    const state = body.decision === "reject"
      ? (await store.transitionCandidateState(candidateId, "REJECTED")).state
      : record.state;

    return Response.json({ candidateId, decision: body.decision, state, decidedAt }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof CandidateNotFoundError) {
      return Response.json({ error: { code: "CANDIDATE_NOT_FOUND", message: "The candidate was not found" } }, { status: 404, headers: noStoreHeaders() });
    }
    return apiErrorResponse(error);
  }
}
