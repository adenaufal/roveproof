---
status: approved
approvedAt: 2026-07-18T01:06:59+07:00
amendedAt: 2026-07-18
modelBackend: subscription-backed Codex CLI; API-key billing prohibited
executionRule: one writer at a time; fresh independent review after each vertical milestone
---

# Implementation plan

## Milestone 0 — workspace and contracts

**Deliver:** npm-workspace monorepo, lint/typecheck/test/build scripts, shared runtime schemas, fixed config IDs, state machine, file/artifact path policy, `.env.example`, demo preflight.

**Done when:** invalid IDs/paths/states fail tests and both web apps build.

## Milestone 1 — seeded checkout baseline

**Deliver:** separate synthetic checkout app, idempotent order endpoint, Indonesia fixture data, three deterministic seed symptoms, verifier-owned journey assertions.

**Done when:** desktop manual checkout is possible, but constrained baseline reports the exact three seed IDs and no real payment/data is used.

## Milestone 2 — constrained runner and evidence

**Deliver:** pinned Playwright/Chromium, CDP CPU/network profile, deterministic jitter schedule, trace/HAR/screenshot/console/request/metric collectors, redaction, hashing, immutable run bundle.

**Done when:** baseline produces a schema-valid evidence bundle and physically plausible 8.2 MB / ~19 s observation under frozen settings.

## Milestone 3 — control plane and dashboard

**Deliver:** file store, one-job worker/state machine, job and SSE APIs, fixture adapter, dashboard showing profile, phase timeline, evidence, failures, and before/after slots.

**Done when:** golden fixture mode completes end-to-end, is visibly labeled, and cannot be approved.

## Milestone 4 — subscription-backed evidence analysis

**Deliver:** typed `codex exec` analyzer adapter authenticated through the operator's ChatGPT subscription; versioned structured-output schema; bounded redacted artifact workspace; cited hypotheses; CLI/thread/usage/prompt/schema/input-hash provenance; explicit auth/quota/refusal/process/error handling; fixture adapter. Extend analysis contracts for `codex-cli-chatgpt` provenance without persisting credentials.

**Done when:** an authenticated ChatGPT-login smoke test produces schema-valid cited analysis from admitted evidence using an ephemeral read-only, shell-disabled Codex invocation; `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` are absent and rejected; invalid, quota-blocked, or fixture output cannot masquerade as real analysis; there is no API-billing fallback.

## Milestone 5 — subscription-backed failing-test-first Codex loop

**Deliver:** test-only and source-only diff contracts; two read-only Codex CLI authoring operations returning typed unified diffs; disposable author sandbox; diff/secret/path/line/file policy; allowlisted commands; malicious candidate tests. The trusted CLI may access ChatGPT-managed auth, but candidate commands and sandboxes receive no auth file, home mount, model credential, inherited secret, or model network access.

**Done when:** the generated regression-test diff is contract-valid, is applied only in isolation, and demonstrably fails against untouched baseline for the intended reason; only then may one bounded source patch be requested; the patch passes sandbox gates; forbidden candidates are rejected; no generated code executes on the host and no API key is used.

## Milestone 6 — independent verifier and approval

**Deliver:** second clean workspace, exact diff hash reapplication, original journey rerun, before/after report, hash-bound approve/reject, diff export/rollback handle. This milestone consumes the admitted persisted diff and makes no model call.

**Done when:** verified checkout records one order and approximately 1.4 MB / 6 s under identical settings; approval cannot target a stale hash; verifier success is independent of Codex availability or claims.

## Milestone 7 — competition hardening

**Deliver:** design-system freeze, responsive/accessibility checks, Core Web Vitals pass on the control UI, three clean demo rehearsals, recorded walkthrough, README, architecture diagram, submission copy, and documented ChatGPT/Codex login setup.

**Done when:** a new machine/operator with an eligible ChatGPT subscription can sign in through Codex CLI, run preflight, reset, baseline, analyze, repair, verify, approve, and record without API credit or hidden manual state.

## Parallel-safe boundaries

After contracts freeze:

- Target UI can proceed in parallel with dashboard visual exploration.
- Runner/evidence can proceed in parallel with fixture dashboard.
- Model adapter can proceed in parallel with sandbox policy tests.
- Documentation/video scripting can proceed after selectors and phase labels freeze.

Never use parallel writers on shared contracts, profile/oracle files, state machine, artifact store, candidate export policy, or the same worktree.

## Review loop

For each milestone:

1. sole writer implements;
2. run focused validation;
3. two fresh read-only reviewers inspect correctness/security and tests/demo integrity;
4. parent accepts only evidence-backed fixes;
5. sole fix writer applies accepted changes;
6. rerun validation and record residual risks.
