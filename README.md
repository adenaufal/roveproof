# Roveproof

**Real-world journey CI. Prove every journey in the real world.**

Roveproof runs a critical user journey under constrained device, network, and locale conditions; grounds a subscription-backed Codex diagnosis in browser evidence; requests a failing-test-first bounded repair as typed diffs; and independently reruns the journey before a human can approve the exact diff.

Built in Indonesia to test software for the realities of the world.

## Build Week MVP

- One seeded checkout target
- One Indonesia Mobile profile
- Three deterministic failures
- One verified Codex repair loop
- One before/after dashboard

Golden demo:

```text
BEFORE  checkout failed     8.2 MB   19 s
AFTER   checkout succeeded  1.4 MB    6 s
```

The final product claim must come from measured single-run observations under identical, recorded constraints—not model predictions or hard-coded substitutes. Milestone 3 intentionally uses a conspicuously labeled golden fixture to demonstrate the control plane; its expected-after value is not approvable evidence.

## Status

Bootstrap, planning, and Milestones 0–4 are independently accepted. Milestone 3 provides the fixture control plane and polished proof ledger; Milestone 4 adds subscription-authenticated, schema-valid, cited Codex analysis with immutable safe provenance. Milestone 5 (failing-test-first bounded repair) and Milestone 6 (independent clean verification and hash-bound approval) are implemented and driven by the [end-to-end operator flow](#end-to-end-operator-flow) below; their final operational proof is produced per-run by the operator, not asserted here. The real constrained baseline remains the anchored **8.2 MB / 19 s** observation.

- [PRD](docs/planning/roveproof-mvp-20260718-010659/PRD.md)
- [Architecture](docs/planning/roveproof-mvp-20260718-010659/ARCHITECTURE.md)
- [Implementation plan](docs/planning/roveproof-mvp-20260718-010659/IMPLEMENTATION.md)
- [Battle plan](docs/planning/roveproof-mvp-20260718-010659/BATTLE-PLAN.md)
- [Validation contract](docs/planning/roveproof-mvp-20260718-010659/VALIDATION.md)
- [Milestone 2 acceptance](docs/planning/roveproof-mvp-20260718-010659/MILESTONE-2-ACCEPTANCE.md)
- [Milestone 3 acceptance](docs/planning/roveproof-mvp-20260718-010659/MILESTONE-3-ACCEPTANCE.md)
- [Milestone 4 acceptance](docs/planning/roveproof-mvp-20260718-010659/MILESTONE-4-ACCEPTANCE.md)
- [Skill security audit](docs/security/SKILL-AUDIT-REPORT.md)

## End-to-end operator flow

The full pipeline runs locally from a clean tree. Each step prints explicit IDs and hashes that the next step consumes verbatim — there is no `latest`, fixture, or implicit fallback anywhere in the real path. Capture every printed value and pass it forward exactly.

### 0. Model access (Sign in with ChatGPT only)

```bash
codex login
codex login status   # must report: Logged in using ChatGPT
```

Roveproof drives the local Codex CLI through the ChatGPT subscription session. It does not use OpenAI Platform API billing and rejects `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` even when empty. See [Model access policy](#model-access-policy).

### 1. Install and preflight

```bash
npm install
npm run browser:install
npm run demo:preflight
```

`demo:preflight` checks the toolchain, Docker, Codex login, and the absence of the forbidden credential variables.

### 2. Reset generated state

```bash
npm run demo:reset
```

Clears generated artifacts under `var/roveproof` so the run starts from an explicit, non-inferred state. Never infer "latest"; every later step takes explicit IDs.

### 3. Constrained baseline (M2)

```bash
npm run evidence:baseline
```

Builds and starts the synthetic target, runs the pinned Chromium Indonesia Mobile profile, and writes the immutable bundle under `var/roveproof/runs/<runId>` plus its trust anchor under `var/roveproof/anchors/<runId>.json`. Capture the printed **runId** and **index hash**; read that run's `manifest.json` for its `sourceRevision`. (`npm run test:e2e` is an alias for this step.)

The baseline is a measured single-run observation under identical recorded constraints — the anchored **8.2 MB / 19 s** failing checkout. Model predictions and fixture figures are never substituted for it.

### 4. Subscription-backed analysis (M4)

```bash
npm run test:model:smoke -- \
  --run-id <baseline-run-id> \
  --expected-index-hash <baseline-index-hash>
```

One ephemeral, read-only, shell-disabled `codex exec` call with schema-validated, artifact-cited output, bound to the exact anchored baseline. Capture the printed **analysisId**, **analysisHash**, and **sourceRevision**. Do not edit any tooling-manifest file after this point — any such edit invalidates the analysis tooling revision and forces a fresh analysis.

### 5. Failing-test-first bounded repair (M5)

```bash
npm run test:repair:smoke -- \
  --baseline-run-id <baseline-run-id> \
  --expected-index-hash <baseline-index-hash> \
  --analysis-id <analysis-id> \
  --expected-analysis-hash <analysis-hash> \
  --expected-source-revision <manifest-source-revision> \
  --image node@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
```

All six flags are mandatory; no implicit, `latest`, or fixture inference is allowed. The one bounded attempt runs two separate read-only Codex authoring calls (test first, then source), a Docker test-only run that must fail for the intended mononym reason while the immutable baseline oracle passes, then a Docker combined run that must pass. Generated code executes only inside the isolated container (`--network none`, read-only root, dropped capabilities, bounded resources) and never on the host. On success it publishes one candidate and prints its **candidateId** plus the test/source/combined diff hashes. Auth, quota, Docker, provenance, or cleanup uncertainty persists as `INCONCLUSIVE`; policy or tamper violations as `REJECTED` — neither is ever promoted to PASS.

### 6. Independent clean verification (M6)

```bash
node scripts/run-verification.mjs \
  --candidate-id <candidate-id> \
  --image roveproof-verifier:local
```

Re-reads the persisted candidate (matching terminal PASS status, **no model call**), reapplies the exact combined diff and re-verifies its hash inside a fresh disposable `--network none` verifier workspace distinct from the author sandbox, and reruns the original Indonesia Mobile journey under the same frozen profile/oracle. It requires exactly one durable synthetic order, no seed failures, and measured budgets (≤2.0 MB encoded transfer, ≤8.0 s duration). It writes an immutable before/after verification report and transitions only a genuinely verified candidate to `READY_FOR_HUMAN_REVIEW`; anything else stays `REJECTED` or `INCONCLUSIVE`. The **1.4 MB / 6 s** golden figure is the labeled fixture/display target — only the measured verification run is approvable evidence.

### 7. Hash-bound human decision

A human then approves or rejects the review-ready candidate. The decision binds to the exact `candidateId` and the candidate's current `combinedDiffHash`; a stale or mismatched hash is rejected, and only a real-mode candidate in `READY_FOR_HUMAN_REVIEW` is eligible. Approval exports the verified diff and rollback handle only — it never merges or deploys. Fixture-mode candidates can never reach this step.

## Run the control plane

```bash
npm run build:packages
npm run dev -w @roveproof/control
```

Open <http://127.0.0.1:3000>. The loopback-only dashboard replays the checked-in golden fixture through ten persisted phases and terminates as `INCONCLUSIVE`. Fixture provenance is visible throughout and the control API exposes no approval route.

Run its production-mode browser check with:

```bash
npm run test:control:e2e
```

## Model access policy

Milestones 4–5 use the local Codex CLI authenticated with **Sign in with ChatGPT**. Roveproof does not use OpenAI Platform API billing, rejects `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` even when empty, and never changes billing/auth mode.

```bash
codex login
codex login status   # must report: Logged in using ChatGPT
npm run demo:preflight
```

Milestone 4 analysis uses a non-interactive, ephemeral, read-only, shell-disabled `codex exec` call with schema-validated output. Codex credentials are never copied into evidence, candidate workspaces, commands, or sandboxes. Run an explicit real smoke against an anchored baseline—there is no latest/fixture fallback:

```bash
npm run test:model:smoke -- \
  --run-id run-6fae3a3e-74f6-4c00-8626-0438d86b9aea \
  --expected-index-hash aaa028ad14395de83d4220bf71b3a50159ec69bd0cb1a81ab95aa21c816b3dcc
```

See [the accepted model-backend decision](docs/planning/roveproof-mvp-20260718-010659/MODEL-BACKEND-DECISION.md).

### How Codex and GPT-5.6 are used

The model behind every Roveproof session is **GPT-5.6**, reached through the local **Codex CLI** signed in with ChatGPT (no API key, no billing fallback). GPT-5.6 is called exactly three times per repair, each call ephemeral, read-only, and with the shell disabled:

1. **Diagnosis (M4)** — reads the immutable evidence bundle and returns schema-validated hypotheses, each cited to a specific artifact with a falsifier. Captured pages and repo text are treated as data, never instructions.
2. **Failing-test authoring (M5)** — writes a narrow regression test that must fail on the untouched baseline for the intended reason, proven inside a disposable container before any source changes.
3. **Bounded source authoring (M5)** — only after that failure is proven, a second call writes one bounded source patch. Both authoring calls emit typed unified diffs that run only inside the Docker sandbox.

Roveproof deliberately does not pass `--model` and records `model: null` rather than asserting an identifier the CLI's JSONL never emits (see [ARCHITECTURE](docs/planning/roveproof-mvp-20260718-010659/ARCHITECTURE.md)); the session's model is GPT-5.6. Codex credentials are never read, copied, logged, persisted, or mounted into evidence, candidate workspaces, commands, or sandboxes.

## Safety

Generated code is a candidate, not a trusted fix. Real repair mode requires disposable sandbox execution, no host credentials, outbound network denied by default, strict diff/command limits, a separate clean verifier, and explicit hash-bound human approval.

Provenance-aware contract validators must receive their `RunOrigin` argument from the immutable provenance store. Never reconstruct that trusted argument from caller-supplied transition or candidate fields.
