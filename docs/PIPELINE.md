# Roveproof end-to-end pipeline (M5 → M6 → M7)

A concise flow summary that complements the accepted [ARCHITECTURE](planning/roveproof-mvp-20260718-010659/ARCHITECTURE.md) state machine. The full command sequence with flags is in the [README end-to-end operator flow](../README.md#end-to-end-operator-flow). Every stage is bound to the previous by explicit IDs and hashes; there is no `latest`, fixture, or implicit fallback in the real path.

## Inputs into the repair pipeline (M2 → M4)

- **M2 baseline** (`npm run evidence:baseline`) → immutable hashed evidence bundle + external trust anchor. Produces `runId`, `indexHash`, and `manifest.sourceRevision`.
- **M4 analysis** (`npm run test:model:smoke -- --run-id … --expected-index-hash …`) → one ephemeral read-only `codex exec`, schema-valid and artifact-cited, bound to the anchored baseline. Produces `analysisId`, `analysisHash`, `sourceRevision`.

## M5 — failing-test-first bounded repair

`npm run test:repair:smoke -- --baseline-run-id … --expected-index-hash … --analysis-id … --expected-analysis-hash … --expected-source-revision … --image node@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2`

All six flags mandatory. In order: exact baseline/analysis/source/tooling admission → one read-only test authoring call → strict test diff → Docker test-only run (exit 1, intended mononym failure, immutable baseline oracle still passes) → persisted proof/control/result/evidence/diff read-back → one read-only source authoring call → accepted source + combined policy (≤5 files, ≤250 changed lines) → Docker combined run (exit 0) → workspace cleanup before publication → candidate envelope + matching terminal PASS status.

Output: one persisted candidate under `var/roveproof/candidates/<candidateId>/` with test/source/combined diff hashes. Generated code runs only inside the container (`--network none`, read-only root, dropped capabilities, bounded resources) — never on the host. Auth/quota/Docker/provenance/cleanup uncertainty → `INCONCLUSIVE`; policy or tamper violations → `REJECTED`. Neither is ever promoted to PASS.

## M6 — independent clean verification + hash-bound approval

`node scripts/run-verification.mjs --candidate-id <candidateId> --image roveproof-verifier:local`

Makes no model call. In order: re-read the persisted candidate with matching terminal PASS status → create a second disposable verifier workspace, distinct from the author sandbox → reapply the exact combined diff and re-verify its hash → run verifier-owned tests and the original Indonesia Mobile journey under the same frozen profile/oracle → require one durable synthetic order, no seed failures, and measured budgets (≤2.0 MB, ≤8.0 s; display target ≈ 1.4 MB / 6 s) → write an immutable before/after report → transition only a genuinely verified candidate to `READY_FOR_HUMAN_REVIEW`, else `REJECTED`/`INCONCLUSIVE`.

**Human decision.** Approve or reject the review-ready candidate, bound to the exact `candidateId` and current `combinedDiffHash`. A stale or mismatched hash is rejected; only a real-mode review-ready candidate is eligible. Approval exports the verified diff and rollback handle only — no merge, no deploy. Fixture-mode candidates can never reach approval.

## M7 — competition hardening

Submission-critical only: exact end-to-end docs (this file, README, [SUBMISSION](SUBMISSION.md)); real evidence/candidate/verification/approval surfaced on the control dashboard while fixture labeling stays conspicuous; responsive/accessibility/performance checks on the demo path; repeated clean rehearsals with reset + explicit IDs; a short recorded walkthrough (baseline → cited analysis → safe repair → clean verification → exact-hash approval); final root gates and secret scan. No external publish without explicit user confirmation.

## Invariants across every stage

- Explicit IDs/hashes only; never infer "latest."
- Docker isolation for all generated code; no host credentials; outbound network denied by default.
- Subscription-backed Codex via Sign in with ChatGPT only; API keys rejected; no billing-mode fallback.
- Write-once, cross-bound provenance; missing/contradictory/tampered/uncertain evidence fails closed.
- Verifier owns the profile, seeds, oracle, and budgets; Codex cannot weaken proof.
