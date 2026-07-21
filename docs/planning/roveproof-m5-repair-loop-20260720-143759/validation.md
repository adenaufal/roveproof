# M5 validation contract and evidence ledger

This file defines proof, not a completion claim. All M5 criteria start `UNVERIFIED`; `blocked`, `not-run`, source inspection, and model confidence are not verification.

## Required command families

### Focused offline gates (after implementation)

```text
npx vitest run packages/contracts/test/candidate.test.ts
npx vitest run packages/model-adapter/test/authoring.test.ts packages/model-adapter/test/process.test.ts packages/model-adapter/test/protocol.test.ts
npx vitest run packages/sandbox/test/diff-policy.test.ts packages/sandbox/test/snapshot.test.ts packages/sandbox/test/docker-runner.test.ts
npx vitest run packages/journey/test/source-revision.test.ts packages/store/test/analysis-store.test.ts
```

Exact filenames may be adjusted only to match canonical package layout; no test target may be silently omitted.

### Root regression gates

```text
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run demo:preflight
```

Each command is recorded with exit code, duration, and relevant artifact/output digest. A passing pre-change command does not verify a changed M5 criterion.

### Explicit real smoke

The command must reject implicit/latest/fixture inference and require all bindings:

```text
npm run test:repair:smoke -- \
  --baseline-run-id <run-id> \
  --expected-index-hash <sha256> \
  --analysis-id <analysis-id> \
  --expected-analysis-hash <sha256> \
  --expected-source-revision <sha256:...> \
  --image <registry/image@sha256:...>
```

The smoke must first read and validate the immutable run anchor, analysis envelope, and source snapshot; it must never use the historical M4 IDs unless their source/provenance bindings match the newly approved baseline. If Docker/auth/provenance is unavailable, no candidate command starts and the outcome is persisted/reported as `UNVERIFIED`/`INCONCLUSIVE`.

## Evidence ledger

| AC | Required proof | Evidence location / command | Status |
|---|---|---|---|
| AC-M5-1 | Strict non-interchangeable test/source contracts; trusted metadata; no raw output/credentials | `packages/contracts/test/candidate.test.ts`; authoring attempt tests; sanitized records under `var/roveproof/candidates/` | `IMPLEMENTED; UNVERIFIED full operational proof` |
| AC-M5-2 | Two separate read-only calls; source call requires immutable expected-failure proof | `packages/model-adapter/test/authoring.test.ts`; ordered smoke command evidence | `IMPLEMENTED offline gate; UNVERIFIED full smoke` |
| AC-M5-3 | Diff/path/file/line/secret/assertion/command policy rejects adversarial candidates | `packages/sandbox/test/diff-policy.test.ts`; policy evidence record | `IMPLEMENTED offline gate; UNVERIFIED full smoke` |
| AC-M5-4 | No-Git source snapshot binds exact current baseline/evidence/analysis and rejects tamper | `packages/sandbox/test/snapshot.test.ts`; snapshot manifest + anchor/read-back | `IMPLEMENTED offline gate; UNVERIFIED fresh operational anchor` |
| AC-M5-5 | Docker isolation and bounded export/resource/process controls are enforced | `packages/sandbox/test/docker-runner.test.ts`; Docker command/inspect evidence | `IMPLEMENTED preflight/command gate; UNVERIFIED real engine smoke` |
| AC-M5-6 | Test-only diff fails for intended seed, then source-only diff is admitted/run only after proof | explicit `test:repair:smoke` artifact with test-failure proof and source-call ordering | `IMPLEMENTED offline gate; real smoke remains UNVERIFIED` |
| AC-M5-7 | Existing M0–M4 paths remain covered and pass their applicable gates | root command ledger + fresh correctness/evidence reviews | `UNVERIFIED` |

## Pre-M5 evidence (not M5 verification)

- Focused pre-change suite: exit 0, 14 files / 94 tests.
- `npm run demo:preflight`: exit 0; Codex version/auth and pinned browser passed.
- Docker `info`: exit 1 because Docker Desktop Linux engine was not running; therefore AC-M5-5/6 remain `UNVERIFIED`.
- Current source revision differs from accepted historical baseline; provenance AC remains `UNVERIFIED` until a fresh approved anchor or authoritative archive is admitted.

## Final post-recovery validation (lead independent run; not M5 acceptance)

After the bounded reviewer fixes, the lead independently recorded these offline and preflight results:

- `npm ci --ignore-scripts --dry-run` (dependency-graph preflight, not installation): `0/14s`.
- Focused M5 suite: 10 files / 58 tests; `0/13s`.
- `npm test`: 37 files / 243 tests; `0/51s`.
- `npm run test:integration`: 21 files / 114 tests; `0/43s`.
- `npm run typecheck`: `0/31s`.
- `npm run lint`: `0/66s`.
- `npm run build`: `0/40s`.
- `npm run demo:preflight`: `0/11s`.
- Docker prerequisite: `{ok:true,error:null}` (exit `0`).

Lead-reported validation ledger digest: `02d4f33519a7814d0a2d75a9e4dc7e22ed89ac82c2d53c571ed7e0a110380355`. The command logs and their SHA-256 manifest were kept outside the repository at `F:\\temp\\roveproof-m5-final-validation-20260720-164356\\` (manifest digest `bfabe2bdd9c307a35bbf762a72d4355b8bd16333064185b9addca1af9e2812d6`); this ledger records aggregate results rather than embedding those logs.

These results verify regression, offline, and preflight behavior only. They do not verify AC-M5-5, AC-M5-6, or full M5. The pre-M5 Docker note above is historical; the current post-recovery prerequisite result was `{ok:true,error:null}` and does not substitute for a real candidate smoke. The operational repair path and durable publication are implemented; real model/Docker smoke and candidate read-back remain UNVERIFIED.

This bounded post-review fix pass is recorded as implementation/offline proof only; no fresh baseline, real Codex call, Docker candidate, or generated candidate smoke was run by this worker.

After the final shared credential-scanner correction, a second lead run passed: focused security tests (4 files / 36 tests, `0/4s`), `npm test` (37 files / 249 tests, `0/48s`), `npm run test:integration` (21 files / 119 tests, `0/42s`), typecheck (`0/24s`), lint (`0/19s`), build (`0/27s`), and Docker prerequisite (`0`, `{ok:true,error:null}`). Its lead-reported ledger digest is `3112e5772ae52bdbe28b23eb52a205398ff39e07c763b0fcf6e3ee2e5073e423`; external log directory: `F:\\temp\\roveproof-m5-security-fix-validation-20260720-170041\\`.

A final credential-matrix follow-up passed 4 files / 41 tests (`0`, output digest `ab724d5e164c84c40f8423a74fa66953c06f12c29efb476082dfadd6da32b26a`) and workspace lint (`0`, output digest `0230fad27825a4e66ef1437627abb2af923ed26d2303f918fd3265656c688c1d`). No Codex or candidate code was executed.

## Stop and escalation rules

- Do not run candidate code if `docker info` fails, image digest is unpinned/unavailable, or required isolation flag cannot be confirmed.
- Do not call source author if test-only proof is missing, passes, times out, fails setup, or reports the wrong seed/assertion.
- Do not continue after a policy violation, secret/export leak, provenance mismatch, or sandbox/verifier disagreement.
- Do not widen the patch budget, allowed paths, command registry, dependency set, or seed/profile/journey scope without explicit user approval.
- Do not call a fixture rehearsal or model output `VERIFIED` real evidence.

## Completion language for this milestone

- `Implemented`: code exists; one or more required proofs remain absent.
- `Verified`: all defined technical M5 gates for the approved slice pass; operational smoke must be listed explicitly.
- `Accepted`: user has accepted the approved slice and any declared residual risk.
- `Release-ready`: not claimable from M5 alone; requires later M6/M7 gates.
