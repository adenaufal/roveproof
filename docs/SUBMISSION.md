# Roveproof — OpenAI Build Week submission

**Real-world journey CI: reproduce a critical journey under real-world device, network, and locale constraints, generate a bounded repair, and independently prove it works before a human approves the exact diff.**

Track: Developer Tools. Built in Indonesia.

## The problem

Teams validate checkout on fast devices, reliable networks, English-centric identity formats, and familiar address systems. The failures that hit low-end devices, constrained mobile networks, mononyms, `+62` phone numbers, Indonesian addresses, IDR, and Jakarta date/time semantics stay invisible until production. Roveproof is CI for exactly those users — the ones a team's normal test matrix never represents.

The Build Week MVP reproduces one seeded checkout under one `indonesia-mobile-v1` profile (viewport 360×800, `id-ID`, `Asia/Jakarta`, 4× CPU slowdown, constrained-3G network schedule) with three deterministic seeded defects: a required-last-name mononym rejection, a `+62` phone normalization bug, and an oversized mobile checkout bundle.

## What it does

An evidence-to-decision pipeline, each stage bound to the previous by explicit IDs and hashes — no `latest`, fixture, or implicit fallback in the real path:

1. **Constrained journey CI.** Runs the pinned Chromium Indonesia Mobile profile against the synthetic target and writes an immutable, hashed evidence bundle (screenshots, trace, HAR, console, requests, assertions, timing, encoded bytes) under an external trust anchor. The baseline is a measured single-run observation — the anchored **8.2 MB / 19 s** failing checkout.
2. **Subscription-backed Codex diagnosis.** One ephemeral, read-only, shell-disabled `codex exec` call returns schema-validated hypotheses, each cited to specific evidence artifacts, plus falsifiers and stated uncertainty. Captured pages and repository text are untrusted data, never instructions.
3. **Failing-test-first bounded repair.** A separate read-only Codex call authors a narrow regression test that must fail on the untouched baseline for the intended reason (proven in a disposable container). Only then does a second read-only call author one bounded source patch. Both are typed unified diffs — Roveproof applies and runs them only inside an isolated sandbox.
4. **Independent hash-bound verified approval.** A fresh verifier workspace — distinct from the author sandbox, making no model call — reapplies the exact combined diff, re-verifies its hash, and reruns the original verifier-owned journey/profile/oracle. It requires one durable synthetic order, no seed failures, and measured budgets (≤2.0 MB, ≤8.0 s) before a candidate becomes review-ready. A human then approves or rejects the exact `candidateId` + `combinedDiffHash`.

## Safety model

Generated code is a candidate, not a trusted fix. Enforcement — not prompts — is the boundary.

- **Docker isolation.** All generated code runs only inside a pinned-image container with `--network none`, read-only root, dropped capabilities, no-new-privileges, and bounded PID/memory/CPU/time/output. Generated code is never applied or executed on the host.
- **No host credentials.** Sandbox and verifier receive no host secrets, home, or auth mounts; outbound network is denied by default.
- **ChatGPT-login-only, no API billing.** Model access is the local Codex CLI through Sign in with ChatGPT. `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` are rejected even when empty; there is no direct model API and no billing-mode fallback. Codex credentials are never read, copied, logged, persisted, or mounted.
- **One bounded candidate.** A single repair attempt, capped at ≤5 changed files and ≤250 added+deleted lines, with no dependencies, lockfiles, CI, infrastructure, migrations, secrets, generated outputs, or verifier/profile/oracle weakening.
- **Write-once provenance.** Snapshots, attempts, controls, results, evidence, proof bytes, diffs, the candidate envelope, and terminal status are persisted immutably and cross-bound by hash, so every claim reads back independently.
- **Fail-closed.** Missing, contradictory, tampered, timed-out, or uncertain evidence stays `INCONCLUSIVE` or `REJECTED` — never PASS.
- **Human approval bound to the exact candidate.** Approval requires the exact `candidateId` and the candidate's current `combinedDiffHash`; a stale or mismatched hash is rejected, only a real-mode review-ready candidate is eligible, and approval exports the verified diff and rollback handle only — it never merges or deploys. Fixture-mode candidates can never be approved.

## Demo storyline

1. Start `checkout-v1` under the Indonesia Mobile profile.
2. Baseline reproduces all three seeded failures: **checkout failed · 8.2 MB · 19 s** (measured single run under recorded constraints).
3. Subscription-authenticated Codex returns schema-valid, artifact-cited hypotheses from the evidence bundle.
4. A read-only authoring call produces a regression test that fails on the untouched baseline for the expected reason, inside the disposable sandbox.
5. A second read-only call produces one bounded source patch; Roveproof validates and applies it only inside the sandbox, then a combined container run passes.
6. A fresh verifier reapplies the exact diff hash and reruns the original profile/oracle: **checkout succeeded · 1.4 MB · 6 s** (the golden figure is the labeled fixture/display target; the approvable value is the measured verification run).
7. The candidate remains pending until a human approves the exact candidate ID and diff hash.

## Truthfulness

Before/after numbers are single observations under identical recorded settings, never field statistics. The fixture control plane is conspicuously labeled and terminates as `INCONCLUSIVE` — it can never reach approval. Milestones 0–4 are independently accepted; Milestones 5–6 are implemented and driven by the documented operator flow, with final operational proof produced per-run rather than asserted in this document.

See [README](../README.md) for the exact end-to-end commands, [PIPELINE](PIPELINE.md) for the M5→M6→M7 flow, and [ARCHITECTURE](planning/roveproof-mvp-20260718-010659/ARCHITECTURE.md) for the accepted design.
