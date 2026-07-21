---
status: approved
approvedAt: 2026-07-18T01:06:59+07:00
amendedAt: 2026-07-18
modelBackend: subscription-backed Codex CLI; API-key auth prohibited
---

# Validation contract

Implementation is not complete until all required gates below produce inspectable evidence.

## Gate 1 — contracts and deterministic target

- Runtime schemas reject invalid IDs, unknown schema major versions, and arbitrary paths/commands.
- Baseline target exposes exactly three seed IDs.
- Mononym and `+62` tests fail for their intended baseline reasons.
- Heavy payload has a deterministic encoded-byte contribution.
- Order endpoint is synthetic and idempotent.

## Gate 2 — profile and evidence

- Manifest records actual Chromium, Playwright, viewport, locale, timezone, CPU, and network settings.
- Runner stops as `INCONCLUSIVE` when CDP constraints cannot be applied/verified.
- Required screenshots, trace, HAR, assertions, console, requests, and metrics are indexed and hashed; default admission requires the external run anchor.
- Fake bearer token, cookie, signed URL, sensitive body, and unexpected textual PII fixtures are absent after redaction; binary evidence is fixed-synthetic-only.
- Non-target HTTP(S) and WebSocket egress is blocked, recorded, and makes the run inconclusive.
- Duration uses a monotonic clock; transfer uses encoded response bytes inside identical boundaries, and admission cross-checks duplicated metrics against request records.

## Gate 2A — fixture control plane

- File-backed jobs, immutable origins, snapshots, idempotency records, and contiguous event logs validate on every read; every event transition is replayed against immutable provenance before projection.
- Torn event tails recover at the durable newline, interrupted job publication repairs derived latest/idempotency records, and dead-owner leases resume without allowing two live owners.
- Canonical-root and regular-file checks reject linked ancestors, store directories, and event files.
- A global filesystem lease permits one fixture worker; the accepted route ends at `INCONCLUSIVE` with `REHEARSAL_COMPLETE` projection metadata.
- Job creation is fixture-only, same-origin, body-bounded, and idempotent; a second active key conflicts.
- SSE replays persisted sequence IDs, resumes from a cursor, and closes on a terminal event.
- Dashboard visibly labels fixture provenance, renders exactly three failures and both fixture slots, restores after refresh, fits a 390 px viewport, and exposes no approval action or endpoint.

## Gate 2B — subscription-backed analysis

- `codex --version` succeeds and successful trimmed `codex login status` output equals exactly `Logged in using ChatGPT`.
- Preflight and the adapter reject present—even empty—`OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN`; every Codex child receives a minimal environment allowlist and canonicalized executable path; no direct model API client or billing-mode fallback exists.
- The trusted adapter never reads, copies, logs, persists, or mounts Codex auth files/credential-store contents.
- Only an exact-version global npm Codex package whose launcher/runtime hashes match the pinned official release-integrity manifest may resolve, and it is launched through trusted Node; metadata-only PATH shadows, native replacements, wrong package contents, pipe errors, and unbounded tree termination fail closed.
- Analysis requires exactly one verifier-owned failed assertion for each frozen seed, then runs with `--ignore-user-config`, `--ignore-rules`, and `--disable shell_tool` in an ephemeral read-only admitted-evidence workspace containing no project Codex configuration. Only the versioned prompt/schema and redacted, hash-admitted artifacts enter. Any unexpected tool event or successful-turn refusal is rejected, and no cwd-only read-confinement claim is made.
- Persisted real analysis records backend/auth mode, CLI version, thread/turn/model/usage/latency/exit provenance, prompt/schema versions and hashes, input hashes, and the exact allowed path/assertion-fragment citation catalog without credential values.
- Invalid schema, refusal, auth loss, quota exhaustion, unavailable subscription model, or CLI error fails closed; fixture output remains explicitly fixture.

## Gate 3 — failing-test-first candidate

- Regression-test and source-patch authoring are separate ephemeral read-only Codex CLI calls returning typed unified diffs; Codex does not apply or execute them on the host.
- Generated regression test is applied alone to untouched baseline inside the disposable author sandbox.
- It fails for the expected seed reason, not setup/timing noise.
- Candidate changes ≤5 files and ≤250 lines.
- Forbidden paths/types and assertion weakening are rejected.
- Candidate sandbox has no inherited secrets, home/auth mount, model credentials, or outbound network and enforces time/resource/process limits.
- Subscription auth is available only to the trusted CLI parent; candidate commands receive an allowlisted environment with API-key variables removed.

## Gate 4 — independent proof

- Author workspace is destroyed before verification.
- Verifier checks out baseline anew and recomputes the applied diff hash.
- Original verifier-owned profile, seeds, oracle, and budgets are unchanged.
- Checkout succeeds once, with exactly one durable synthetic order.
- Displayed real-mode before/after values are runner measurements and `sampleCount` is 1; labeled fixture expectations are excluded from this proof claim.
- Sandbox/verifier disagreement becomes `INCONCLUSIVE`.

## Gate 5 — human and demo

- Approval route requires candidate ID and exact current diff hash.
- Fixture mode cannot become review-ready or approved.
- Three clean rehearsals reproduce the story without selector failures.
- Demo video follows Discover → Rehearse → Record and contains no secrets or real PII.
- Final build, typecheck, lint, unit/integration tests, and Playwright golden flow pass.

## Required command families

Exact commands will be finalized with package scaffolding, but CI must expose:

```text
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:e2e
npm run test:control:e2e
npm run test:model:smoke    # added in Milestone 4; explicit subscription-gated check
npm run build
npm run demo:preflight
npm run demo:reset
```

The real model smoke test is subscription-gated, local, and separate from default CI. It must require ChatGPT-authenticated Codex CLI, fail honestly on auth/quota/model unavailability, and refuse API-key authentication or fallback.

## Stop rules

Stop for user input rather than inventing a decision if implementation requires a second profile/journey, dependency or schema expansion, public authentication, real customer/payment data, auto-deploy, or a patch beyond the approved budget.
