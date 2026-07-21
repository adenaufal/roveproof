---
status: accepted
acceptedAt: 2026-07-18T10:27:00+07:00
milestone: 0
---

# Milestone 0 acceptance

Milestone 0 — workspace and contracts — is accepted.

## Delivered

- npm workspace with separate Next.js 16.2.9 control and target apps;
- runtime-validated fixed IDs, profile, seeds, budgets, and schema version;
- complete real/fixture state-transition policy;
- trusted job/run provenance binding for transitions, candidates, and approvals;
- hash-bound human approval with fixture relabeling rejected;
- canonical lowercase, forward-slash-only artifact paths with Windows/POSIX alias rejection;
- ranked evidence-analysis schema that rejects empty or malformed hypotheses;
- fail-closed artifact reset that performs no recursive deletion in Milestone 0;
- pinned PostCSS override resolving the audited transitive advisory;
- demo preflight and generated-file hygiene.

## Validation evidence

- `npm test`: **6 files / 70 tests passed**;
- `npm run typecheck`: passed for root and all workspaces;
- `npm run lint`: passed for all workspaces;
- `npm run demo:reset`: passed on an empty verified real directory;
- `npm run build`: passed for control, target, and contracts;
- `npm run demo:preflight`: required Milestone 0 checks passed;
- `npm audit --omit=dev`: **0 vulnerabilities**.

## Independent review

- Contract/provenance/canonical-path review: **GO**, no blocker or high finding.
- Reset security acceptance: **GO**, no blocker or high finding.

Reviewer artifacts:

- `F:/temp/openai-build-week-bootstrap/m0-acceptance-contracts.md`
- `F:/temp/openai-build-week-bootstrap/m0-reset-security-acceptance.md`

## Known future prerequisites

Docker engine and `OPENAI_API_KEY` were unavailable at Milestone 0 acceptance. This did not affect Milestone 0.

**Superseding model decision after Milestone 3:** API-key access is no longer a prerequisite and is now prohibited. Milestones 4–5 use ChatGPT-subscription authentication through Codex CLI. Docker isolation remains required before candidate execution. See [MODEL-BACKEND-DECISION.md](MODEL-BACKEND-DECISION.md).
