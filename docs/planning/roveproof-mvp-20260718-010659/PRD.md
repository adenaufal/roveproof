---
product: Roveproof
status: approved
approvedAt: 2026-07-18T01:06:59+07:00
amendedAt: 2026-07-18
modelBackend: ChatGPT subscription through Codex CLI; metered model APIs prohibited
approvalBasis: User explicitly said to start immediately after approving the constrained concept and skill stack.
track: OpenAI Build Week 2026 — Developer Tools
---

# Roveproof MVP PRD

## One-line promise

**CI for the users your team never tests:** reproduce a critical journey under real-world constraints, generate a bounded repair, and prove it works before a human approves it.

## Problem

Teams commonly validate checkout on fast devices, reliable networks, English-centric identity formats, and familiar address systems. Failures affecting users with low-end devices, constrained networks, mononyms, `+62` phone numbers, Indonesian addresses, IDR, and local date/time semantics remain invisible until production.

## Target user and job

**Primary:** frontend/full-stack engineer responsible for checkout reliability.  
**JTBD:** When a critical journey fails for an underserved user profile, help me reproduce it, understand evidence, generate a constrained fix, and independently verify the result before I approve anything.

**Secondary:** engineering lead or reviewer inspecting evidence and the candidate diff. The represented Indonesian shopper is not an MVP operator.

## Fixed scope

The MVP contains exactly:

- one seeded checkout target;
- one `checkout-v1` journey;
- one `indonesia-mobile-v1` profile;
- three deterministic failures;
- one baseline run;
- one structured evidence analysis through subscription-authenticated Codex CLI;
- one sandboxed Codex failing-test-first candidate through the same subscription backend;
- one clean independent verification run;
- one human approve/reject decision;
- one before/after dashboard.

## Golden demo

1. Start `checkout-v1` under Indonesia Mobile.
2. Baseline reproduces:
   - `ID-MONONYM-REQUIRED-LAST-NAME`;
   - `ID-PHONE-PLUS62-NORMALIZATION`;
   - `MOBILE-HEAVY-CHECKOUT-BUNDLE`.
3. Dashboard shows a measured single observation: **checkout failed · 8.2 MB · 19 s**.
4. Subscription-authenticated Codex returns schema-valid cited hypotheses from screenshots, trace/HAR, console, request, and assertion evidence.
5. A separate read-only Codex authoring call returns a narrow regression-test diff that fails against the untouched baseline for the expected reason when applied inside the disposable sandbox.
6. A second read-only Codex authoring call returns one bounded source-patch diff; Roveproof validates and applies it only inside the disposable sandbox.
7. A fresh verifier reapplies the exact diff hash and reruns the original profile/oracle.
8. Dashboard shows: **checkout succeeded · 1.4 MB · 6 s**.
9. The patch remains pending until a human approves the exact candidate ID and diff hash.

## Functional requirements

1. Execute only the fixed target, journey, profile, and seed set.
2. Capture immutable screenshots, trace, HAR/network events, console/page errors, assertions, duration, and encoded transfer bytes.
3. Ground every model diagnosis in artifact references and expose uncertainty.
4. Prove the generated regression test fails on baseline before requesting a source patch.
5. Enforce the default patch budget: ≤5 source/test files and ≤250 changed lines; no dependencies, lockfiles, CI, infrastructure, migrations, secrets, generated outputs, or verifier changes.
6. Run candidate code in a disposable environment with no host credentials and outbound network denied by default.
7. Verify from a new clean workspace using verifier-owned profile, seeds, oracle, and budgets.
8. Preserve failed and successful evidence separately.
9. Show the candidate diff, policy results, test results, before/after measurements, and rollback handle.
10. Bind human approval to candidate ID plus diff hash.

## Non-functional requirements

- **Deterministic:** fixed data, seeds, network schedule, browser version, and journey boundaries.
- **Auditable:** every claim references runner/model/sandbox evidence.
- **Secure by enforcement:** prompts are not the sandbox boundary.
- **Private:** synthetic identity/order data only; redact auth headers, cookies, tokens, signed URLs, and sensitive bodies.
- **Fail-closed:** missing evidence, model refusal, invalid schema, unavailable constraints, or verifier disagreement becomes `INCONCLUSIVE`.
- **Honest metrics:** before/after are single observations under identical settings, never represented as field statistics.
- **Demo-repeatable:** a clean reset reproduces the narrative without silently substituting fixture output.
- **Subscription-only model access:** real analysis/authoring uses ChatGPT-managed Codex CLI authentication; API keys, direct model APIs, and billing-mode fallback are rejected.

## Success criteria

| ID | Criterion | Proof |
|---|---|---|
| AC1 | Baseline runs with viewport `360×800`, touch/mobile, `id-ID`, `Asia/Jakarta`, 4× CPU slowdown, and the frozen constrained-3G schedule. | Automated manifest assertion |
| AC2 | Baseline surfaces exactly the three seed IDs and fails checkout. | Automated journey assertions |
| AC3 | Displayed 8.2 MB / 19 s comes from recorded encoded bytes and monotonic journey timing, with documented rounding. | Automated + artifact review |
| AC4 | Analysis cites artifacts for every hypothesis and records Codex CLI version, ChatGPT-subscription auth mode, thread/model/usage provenance, input hashes, and uncertainty without credential material. | Schema + manual review |
| AC5 | Generated regression test fails on untouched baseline for the expected seed reason. | Automated |
| AC6 | Candidate stays inside file/line/command policy. | Automated policy gate |
| AC7 | Fresh verifier recomputes and applies the exact diff hash. | Automated |
| AC8 | Verification completes the checkout, creates exactly one durable synthetic order, and records 1.4 MB / 6 s under the identical profile. | Automated |
| AC9 | Dashboard never substitutes model predictions for runner measurements and visibly labels fixture mode. | E2E + manual review |
| AC10 | Candidate remains pending until explicit hash-bound approval. | Automated route/state test |
| AC11 | Full evidence-to-decision audit trail remains inspectable. | Operational rehearsal |
| AC12 | Three clean rehearsals reproduce the same pass/fail story; numeric values remain within frozen display tolerances. | Demo rehearsal |

## Non-goals

No second journey/profile/country/browser, arbitrary customer repository, production traffic, real payment, auto-merge/deploy, profile generation, multiple repair candidates, broad accessibility/SEO/security audit, multi-user tenancy, or claim of global coverage.

## Risks

- Codex subscription/auth/quota availability: preflight and fail honestly; fixture mode is rehearsal-only and there is no API-billing fallback.
- Unsafe patch: strict sandbox and diff policy; verifier owns oracle.
- Canned-demo perception: expose raw artifacts, failing test output, unified diff, and clean rerun provenance.
- Benchmark inconsistency: freeze boundaries and a physically plausible network profile.
- Docker unavailable: do not execute generated code on the host; block real repair mode.
- Scope creep: the fixed IDs are server-owned and not editable from the dashboard.

## Frozen decisions

- Working name: **Roveproof**.
- Before/after are measured single observations.
- Approval exports the verified diff; it does not deploy.
- Default budgets: **≤2.0 MB encoded transfer and ≤8.0 s task duration**.
- Target and control applications are separate.
- Scored browser is pinned Chromium only.
- Model access is `codex-cli-chatgpt` through Sign in with ChatGPT; `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, direct model APIs, and API-billing fallback are prohibited.
- Exact API-only model identity is not a product requirement; Roveproof records the subscription-accessible configured/observed model when Codex exposes it.

## Open implementation checks

- Pin and smoke-test the installed subscription-authenticated Codex CLI behavior, model availability, JSONL events, and `--output-schema` contract.
- Start and validate Docker Desktop/rootless container execution.
- Freeze the deterministic jitter schedule and numeric display tolerances after the first real baseline.
- Confirm final trademark/domain availability before public launch.

The accepted model-backend constraints are detailed in [MODEL-BACKEND-DECISION.md](MODEL-BACKEND-DECISION.md).
