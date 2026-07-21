# M5 vertical stories

All stories are proposed, serial, and initially `UNVERIFIED`. One writer works in the active tree. Reviewers inspect each accepted slice from fresh context.

## Story 1 — trusted contracts, snapshot, and diff policy

**Outcome:** malformed, cross-operation, out-of-scope, oversized, secret-bearing, or provenance-mismatched candidates are rejected before any candidate command or Docker process.

**Canonical sources/tests:** `packages/contracts/src/index.ts`; new contract tests beside `packages/contracts/test/*`; recommended `packages/sandbox/src/{diff-policy,snapshot}.ts` and focused tests. Reuse `packages/journey/src/source-revision.ts` and `packages/store/src/store.ts` without silently changing their authority semantics.

**Scope:** strict test-only/source-only schemas, snapshot and proof contracts, canonical unified-diff parser/policy, no-Git regular-file snapshot, hash/cross-record binding, immutable candidate envelope scaffolding.

**Non-goals:** Codex live call, Docker execution, M6 approval/verifier/UI, first Git commit, new external dependency.

**Proof ledger:**

| AC | Proof | Status |
|---|---|---|
| 1.1 schemas are strict and non-interchangeable | Vitest accepts valid fixtures and rejects operation swaps/missing/trailing fields | `UNVERIFIED` |
| 1.2 paths/files/hunks/budgets/assertions/secrets are enforced | adversarial diff corpus | `UNVERIFIED` |
| 1.3 snapshot hashes and provenance are immutable/tamper-detected | snapshot mutation/lockfile/anchor tests | `UNVERIFIED` |

**Stop:** escalate if policy needs a broader path/budget, dependency, or provenance rewrite.

## Story 2 — bounded, ordered Codex authoring

**Outcome:** trusted code can request a test-only diff, and cannot request a source-only diff until an immutable expected-failure proof is supplied.

**Canonical sources/tests:** `packages/model-adapter/src/{process,protocol,workspace,authoring}.ts`; `packages/model-adapter/test/{authoring,process,protocol}.test.ts`; M4 accepted process/auth patterns.

**Scope:** operation-specific prompts/output schemas, bounded source projection, fresh ephemeral read-only invocations, sanitized authoring attempts, exact CLI/auth/input/output provenance, no raw child output, ordering gate.

**Non-goals:** applying/running diffs on host, API fallback, model-selected commands, dashboard/API, M6.

**Proof ledger:**

| AC | Proof | Status |
|---|---|---|
| 2.1 only pinned ChatGPT Codex can be invoked | injected preflight/runner tests; real preflight command | `UNVERIFIED` |
| 2.2 calls are separate and source call is blocked before proof | call-order and gate tests | `UNVERIFIED` |
| 2.3 projection excludes secrets/config/var/node_modules and output is typed | workspace/hash/citation/channel tests | `UNVERIFIED` |

**Stop:** escalate on CLI protocol mismatch, auth/quota failure, or a request to expose credentials.

## Story 3 — disposable Docker failing-test and candidate gate

**Outcome:** test-only diff fails for the intended mononym reason in an untouched snapshot; a bounded combined candidate is then checked only inside Docker, or fails closed when Docker is unavailable.

**Canonical sources/tests:** `packages/sandbox/src/{docker-runner,commands,export}.ts`; Docker-focused tests; `scripts/run-repair-smoke.mjs`; `config/demo.ts`; target tests/oracle as read-only verifier authorities.

**Scope:** pinned-image runner, fixed argv command registry, network/credential/home/resource/process/export controls, descendant termination, test-failure classification, combined candidate policy/sandbox evidence, immutable persistence.

**Non-goals:** clean independent verifier, actual before/after claim, approval/UI, host execution, image downgrade.

**Proof ledger:**

| AC | Proof | Status |
|---|---|---|
| 3.1 Docker command enforces required boundary | automated command construction/negative probes plus `docker inspect` evidence | `UNVERIFIED` |
| 3.2 wrong reason/setup/pass/timeout is rejected | injected and sandbox test fixtures | `UNVERIFIED` |
| 3.3 candidate budget/export/secret policy is enforced | adversarial corpus and bounded export tests | `UNVERIFIED` |
| 3.4 real mononym smoke completes ordering and sandbox gate | explicit IDs/hashes + Docker/Codex run artifact | `UNVERIFIED` |

**Stop:** if Docker engine/image/flags are unavailable, record `UNVERIFIED` and stop; never run candidate on host or substitute fixture success.

## Story 4 — bounded M5 acceptance pass

**Outcome:** M0–M4 behavior remains intact and the M5 evidence ledger is truthful.

**Canonical targets:** all changed package tests; root `npm test`, integration, typecheck, lint, build, `demo:preflight`; final diff and candidate artifacts.

**Scope:** selective reviewer correction pass and full appropriate validation after Stories 1–3.

**Non-goals:** M6/M7, optional polish, unrelated cleanup.

**Proof ledger:**

| AC | Proof | Status |
|---|---|---|
| 4.1 no regression in existing canonical paths | commands with exit codes and changed-entrypoint coverage | `UNVERIFIED` |
| 4.2 independent correctness and evidence reviews pass | two fresh reviewer reports | `UNVERIFIED` |
| 4.3 human acceptance of any operational smoke/remaining risk | user/product decision | `UNVERIFIED` |

## Dependency order and gates

`Story 1 → Story 2 → Story 3 → Story 4`. Story 1 may use read-only inspection of Story 2/3 targets, but writers do not run in parallel. Do not expand from the mononym slice until its policy, failure reason, and Docker evidence are proven.
