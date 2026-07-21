import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RunOriginSchema, isTerminalRunState, type ControlJobView, type RunOrigin } from "@roveproof/contracts";
import { createGoldenFixtureSnapshot, launchFixtureWorker } from "@roveproof/orchestrator";
import { CandidateNotFoundError, FileControlStore, resolveArtifactRoot } from "@roveproof/store";

export function repositoryRoot(): string {
  const configured = process.env.ROVEPROOF_REPOSITORY_ROOT;
  if (configured) return path.resolve(/* turbopackIgnore: true */ configured);
  const workingDirectory = path.resolve(/* turbopackIgnore: true */ process.cwd());
  const launchedFromControlWorkspace = path.basename(workingDirectory) === "control" && path.basename(path.dirname(workingDirectory)) === "apps";
  return launchedFromControlWorkspace ? path.resolve(workingDirectory, "..", "..") : workingDirectory;
}

export function controlStore(): FileControlStore {
  return new FileControlStore(resolveArtifactRoot(repositoryRoot()));
}

export function resumeFixtureWorker(store: FileControlStore, view: ControlJobView): void {
  if (!isTerminalRunState(view.job.state)) launchFixtureWorker({ store, jobId: view.job.jobId });
}

export function fixturePreview() {
  return createGoldenFixtureSnapshot({
    jobId: "job-fixture-preview",
    runId: "run-fixture-preview",
    createdAt: "2026-07-18T00:00:00.000Z",
  });
}

/**
 * Reads the immutable RunOrigin for a candidate's run directly from the store's
 * origins directory. The store exposes no public origin reader, yet
 * writeApprovalDecision requires the real origin (never a caller-reconstructed
 * one) to cross-bind jobId/runId/mode against the candidate. The value is
 * re-validated by RunOriginSchema here and again inside writeApprovalDecision.
 */
export async function readRunOrigin(store: FileControlStore, runId: string): Promise<RunOrigin> {
  const originPath = path.join(/* turbopackIgnore: true */ store.artifactRoot, "origins", `${runId}.json`);
  const raw = await readFile(/* turbopackIgnore: true */ originPath, "utf8");
  return RunOriginSchema.parse(JSON.parse(raw));
}

export type ReviewCandidateVerification = Readonly<{
  journeyVerdict: string;
  transferredBytes: number;
  durationMs: number;
  orderId: string | null;
  budgetPassed: boolean;
  budgetEncodedBytes: number;
  budgetDurationMs: number;
}>;

export type ReviewCandidate = Readonly<{
  candidateId: string;
  combinedDiffHash: string;
  verification: ReviewCandidateVerification | null;
  /** Verified combined unified diff text, or null when it cannot be read/re-hashed. */
  combinedDiff: string | null;
}>;

/**
 * Finds the first real, review-ready candidate for the human-review dashboard and
 * loads its authoritative combined diff hash + verification summary. Fixture-mode
 * or non-ready candidates never surface here, so the UI can never offer them for
 * approval.
 *
 * ponytail: O(n) full re-verification scan of candidate-records; the single-operator
 * local store keeps n tiny. Add a review pointer/index if candidate volume grows.
 */
export async function readReviewCandidate(store: FileControlStore): Promise<ReviewCandidate | null> {
  let entries: string[];
  try {
    entries = await readdir(path.join(/* turbopackIgnore: true */ store.artifactRoot, "candidate-records"));
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const candidateId = entry.slice(0, -".json".length);
    try {
      const record = await store.readCandidateRecord(candidateId);
      if (record.mode !== "real" || record.state !== "READY_FOR_HUMAN_REVIEW") continue;
      // Approve leaves the state at READY_FOR_HUMAN_REVIEW, so an already-decided
      // candidate must drop off the review surface (never re-offer it for approval).
      try {
        await store.readApprovalDecision(candidateId);
        continue; // a decision already exists
      } catch (error) {
        if (!(error instanceof CandidateNotFoundError)) continue; // corrupt/other -> hide
      }
      // Full integrity re-check + terminal PASS status; combinedDiffHash is the authority.
      const envelope = await store.readCandidateEnvelope(candidateId, { requireTerminalStatus: true });
      if (envelope.combinedDiffHash !== record.diffHash) continue;
      let verification: ReviewCandidateVerification | null = null;
      try {
        const report = await store.readVerificationReport(candidateId);
        verification = {
          journeyVerdict: report.journeyVerdict,
          transferredBytes: report.transferredBytes,
          durationMs: report.durationMs,
          orderId: report.orderId,
          budgetPassed: report.budgetPassed,
          budgetEncodedBytes: report.budgetEncodedBytes,
          budgetDurationMs: report.budgetDurationMs,
        };
      } catch {
        verification = null;
      }
      // Load the combined diff for display. readCandidateEnvelope already hash-verified
      // this artifact; we re-hash the raw bytes here so the shown diff can never drift
      // from the exact hash the operator approves against (mismatch → hide, never show).
      // ponytail: unguarded re-read of the already-verified artifact; the re-hash gate is
      // the real guard, single-operator local store keeps traversal risk nil.
      let combinedDiff: string | null = null;
      try {
        const raw = await readFile(
          path.join(store.artifactRoot, "candidates", candidateId, envelope.combinedDiffArtifact.artifactPath),
        );
        if (createHash("sha256").update(raw).digest("hex") === envelope.combinedDiffHash) {
          combinedDiff = raw.toString("utf8");
        }
      } catch {
        combinedDiff = null;
      }
      return { candidateId, combinedDiffHash: envelope.combinedDiffHash, verification, combinedDiff };
    } catch {
      // Skip malformed/partial candidates; they must never surface as approvable.
    }
  }
  return null;
}
