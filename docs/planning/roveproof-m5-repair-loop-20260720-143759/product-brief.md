---
status: approved
route: standard
primary: true
created_at: 2026-07-20T14:37:59+07:00
approved_at: 2026-07-20T14:40:00+07:00
milestone: 5
---

# Roveproof Milestone 5 — repair loop (Adaptive v0.4)

## Status and approval gate

Plan ini adalah delta BMAD Lite terhadap artifact milestone yang sudah diterima. User menyetujui default aman dan keputusan material pada 2026-07-20T14:40:00+07:00; satu fresh delivery worker boleh menjadi writer. Tidak ada perubahan source M5 sebelum approval ini.

Baseline canonical yang sudah diterima tetap diperlakukan sebagai **historical evidence**. Current tree tidak boleh disebut sebagai tree baseline yang sama.

## Approval record

User selected **Setujui default + izinkan launch Docker Desktop**. This authorizes the approved M5 scope, fresh current-tree re-anchor, one mononym slice, internal sandbox package without external dependencies, and launching Docker Desktop for the required gate. It does not authorize M6, host execution, API billing, scope expansion, or weakening proof controls.

## Goal

Membangun satu vertical slice Milestone 5 yang dapat dipercaya: Codex CLI berbasis subscription mengembalikan diff regression-test **test-only**, diff itu dibuktikan gagal pada baseline untouched karena seed yang diharapkan, lalu—hanya setelah proof immutable—Codex mengembalikan satu diff **source-only**. Semua apply dan eksekusi kandidat berlangsung hanya di disposable Docker Linux sandbox dengan policy, resource, network, credential, dan export boundary yang ditegakkan oleh kode.

Slice ini berhenti pada hasil sandbox (`SANDBOX_GATING`). Milestone 6 tidak dimulai.

## Context Capsule

### Canonical sources / authority

1. User-approved decisions dan plan ini.
2. `docs/planning/roveproof-mvp-20260718-010659/{PRD.md,ARCHITECTURE.md,IMPLEMENTATION.md,VALIDATION.md,BATTLE-PLAN.md,MODEL-BACKEND-DECISION.md,MILESTONE-4-ACCEPTANCE.md,MILESTONE-4-CONTEXT.md}`.
3. `packages/contracts/src/index.ts` dan tests kontrak M0–M4.
4. M4 trusted process/workspace patterns: `packages/model-adapter/src/{process.ts,protocol.ts,workspace.ts,analyzer.ts,index.ts}` dan tests-nya.
5. Target/oracle/provenance: `packages/journey/src/{source-revision.ts,oracle.ts,runner.ts}`, `apps/target/src/app/checkout/*`, `apps/target/src/lib/seeds/*`, `apps/target/test/*`, `config/demo.ts`.
6. Persistence patterns: `packages/store/src/store.ts` dan tests.
7. Accepted real evidence (historical, not current-tree authority): run `run-6fae3a3e-74f6-4c00-8626-0438d86b9aea`, index `aaa028ad14395de83d4220bf71b3a50159ec69bd0cb1a81ab95aa21c816b3dcc`, root `b838c5897f58dca514a57a5639ef2d69bdd940bf13df6d20ec7294adc888a021`, analysis `analysis-ad204718-4ada-4918-909e-57e2b68a175e`.
8. Official runtime behavior only: Docker run/network/bind-mount/resource docs and Codex non-interactive/auth docs cited in `architecture.md`.

### Scope

- Strict, non-interchangeable contracts for test-only/source-only authoring, attempts, source snapshot, test-failure proof, policy evidence, sandbox command evidence, and candidate envelope.
- Bounded source/test projection with no `.git`, `.env`, `node_modules`, `var`, home, auth, or credentials.
- Two independent ephemeral read-only Codex CLI calls using the existing `0.139.0` ChatGPT-subscription process boundary; no API billing/fallback.
- Canonical unified-diff parsing, hashing, path/file/line/assertion policy, and safe application without requiring a Git `HEAD`.
- One disposable Docker author sandbox with `--network none`, read-only root, explicit writable tmpfs/export, no home/auth/socket/secret inheritance, dropped capabilities, no-new-privileges, resource/process/time limits, descendant termination, and bounded symlink-free export.
- Immutable candidate evidence under `var/roveproof/candidates/<candidateId>/`.
- One real candidate vertical slice, defaulting to the deterministic mononym seed; broaden only after the first slice is proven.
- Focused malicious-candidate tests and an explicit, hash-bound repair smoke command that fails closed when Docker/provenance/auth is unavailable.

### Non-goals

Milestone 6 clean verifier, before/after metrics, approval route/UI, dashboard/API integration, auto-merge/deploy, arbitrary repositories, extra journeys/profiles/browsers, real customer/payment data, dependency or lockfile changes, CI/infrastructure changes inside the candidate diff, weakening verifier/oracle/profile/budget/seed controls, global BMAD policy, official BMAD maintenance, and any host execution of generated code.

### Constraints and already-approved decisions

- Backend/auth are `codex-cli-chatgpt` / `chatgpt-subscription`; exact CLI `0.139.0` and trimmed login status `Logged in using ChatGPT`.
- Presence of `OPENAI_API_KEY`, `CODEX_API_KEY`, or `CODEX_ACCESS_TOKEN` (including empty values) fails closed. No direct model API or billing fallback.
- Codex authors diffs only; trusted code applies/runs them only in the sandbox.
- Candidate budget remains at most 5 changed files and 250 added+deleted lines, one repair attempt.
- Fixed target/journey/profile/seeds/oracle/budgets remain server/verifier-owned.
- One active writer; reviewers are fresh and read-only. Do not edit `_bmad/` (absent), official BMAD files, `.gitignore`, or global policy.
- Docker unavailability is an honest gate: no candidate code runs; real M5 proof stays `UNVERIFIED`.

### Material decisions requiring user approval

The lead recommends the first option in each item, but will not silently decide:

1. **Provenance:** (recommended) after M5 contracts/tooling and lockfile are final, create a fresh deterministic current-tree baseline and fresh analysis, then bind repair to their new IDs/hashes; alternative is to provide an authoritative archived M2 snapshot to preserve `06ac...`. A narrow hash that silently removes `package-lock.json` is not acceptable.
2. **Breadth:** (recommended) prove one mononym vertical slice first; alternative is all three seeds in the first candidate. The latter increases model/sandbox/demo risk and is not needed to prove ordering/security.
3. **Package boundary:** (recommended) add internal `@roveproof/sandbox` with Node built-ins and Docker CLI only; alternative is placing it in existing `model-adapter`/`store` packages.
4. **Sandbox image:** approve a Linux image strategy with immutable digest and `--pull=never`; exact digest/resource values are recorded only after Docker is available and the image is inspected. Unsupported isolation flags fail closed, never downgrade.
5. **Existing intentional baseline tests:** recommended default is to keep verifier-owned seed/oracle tests immutable and use a separate candidate-focused proof target; any source patch that changes expected behavior tests must be explicitly classified as a coverage-preserving update, never assertion weakening.
6. **Operational prerequisite:** authorize the lead to start Docker Desktop if needed, or start it before execution. No real candidate execution occurs until `docker info` succeeds.

### Acceptance criteria → required proof

| ID | Criterion | Required proof | Initial status |
|---|---|---|---|
| AC-M5-1 | Strict test/source contracts and trusted provenance; no raw output/credentials | Automated schema, cross-schema, provenance, and redaction tests | `UNVERIFIED` |
| AC-M5-2 | Separate read-only subscription calls; source call impossible before expected isolated failure | Injected runner ordering tests plus explicit real smoke | `UNVERIFIED` |
| AC-M5-3 | Malicious/path/budget/assertion/command candidates rejected before sandbox | Adversarial automated corpus | `UNVERIFIED` |
| AC-M5-4 | No-Git snapshot is hash-bound to the explicitly admitted baseline/evidence/analysis and tamper-detected | Snapshot/hash/admission/tamper tests plus fresh anchored evidence | `UNVERIFIED` |
| AC-M5-5 | Candidate commands run only in disposable Docker with no credentials/home/network and bounded resources/export | Docker integration probes and inspected command evidence | `UNVERIFIED` |
| AC-M5-6 | Test-only diff fails for the intended frozen reason, then one bounded source diff passes sandbox gates | Explicit operational smoke tied to exact IDs/hashes | `UNVERIFIED` |
| AC-M5-7 | M0–M4 behavior remains intact outside the admitted candidate slice | Focused tests, full test/integration/typecheck/lint/build/preflight | `UNVERIFIED` |

## Validation baseline already observed (pre-M5)

- `npm install --ignore-scripts --prefer-offline` restored missing workspace links; `package-lock.json` SHA-256 remained unchanged.
- Focused pre-change run: 14 test files / 94 tests passed (exit 0).
- `npm run demo:preflight` passed (exit 0); Node 22.23.0, Playwright 1.61.1, Codex 0.139.0 and ChatGPT login passed.
- Docker CLI 29.4.3 is installed, but Docker Desktop Linux engine is unavailable; this is not M5 proof.
- Current `computeTargetSourceRevision`: `sha256:b1a9bc6400df6d705f2ca934444e2450fbabed5e829b10506b2599bcea596e13`; accepted M2 run records `sha256:06ac07051704ad813c6706cc47c3bd89bc0de2d8a1d37b9ed3ed7934df9585c4`. The mismatch is unresolved and must remain visible.

## Stop rules

Pause for the lead/user rather than guessing if implementation requires: a provenance redefinition or first Git commit; a second journey/profile; a new external dependency; a different isolation technology or weaker Docker flags; a new model/auth/billing mode; broader allowlists/budgets; changes to verifier/oracle/profile/seeds/intentional baseline tests that weaken proof; credentials/home mounts; M6/UI/API/approval behavior; or any candidate execution outside Docker. If Docker or required evidence is missing, record `UNVERIFIED` and do not substitute fixture/model claims.

See `architecture.md`, `stories.md`, and `validation.md` for the executable delta and slice gates.
