---
status: approved
approvedAt: 2026-07-18T17:23:47+07:00
milestone: 4
route: standard
writer: single active worktree writer
---

# Milestone 4 context capsule — subscription-backed evidence analysis

## Authorized outcome

Implement the accepted Milestone 4 slice without starting repair:

1. strict real, fixture, model-output, and sanitized-attempt contracts;
2. a typed `codex exec` analyzer using the existing ChatGPT subscription login only;
3. anchored evidence admission, bounded deterministic input projection, citation binding, and immutable analysis persistence;
4. explicit fixture analysis that can never satisfy the real report contract;
5. offline behavior/security tests plus one explicit authenticated real smoke command;
6. no dashboard/model route and no transition beyond analysis.

## Frozen implementation decisions

- Backend/auth literals are `codex-cli-chatgpt` / `chatgpt-subscription`.
- Supported CLI behavior is pinned to `codex-cli 0.139.0`; upgrades require new protocol fixtures and smoke acceptance.
- `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` are forbidden by variable presence, including empty values. No direct HTTP/model SDK or billing fallback is permitted.
- The adapter resolves only an exact global npm `@openai/codex` 0.139.0 entry whose launcher and Windows x64 runtime files match hashes derived from the official GitHub release assets, launches it through the current trusted Node executable with `shell: false`, and rejects metadata-only npm-shaped PATH shadows/native executables. It uses a minimal environment allowlist, canonicalized child PATH, bounded streams/time, handled pipe errors, and deadline-bounded process-tree termination.
- Every inference uses `--ephemeral --json --sandbox read-only --ignore-user-config --ignore-rules --disable shell_tool --output-schema`. Model shell access is disabled, so untrusted evidence cannot instruct Codex to read host text files or credential material. Codex itself remains the trusted authentication client; Roveproof never reads or copies its auth store.
- The process is not described as cwd-only read confinement. The model receives bounded evidence through the prompt plus two explicitly admitted screenshot copies; any unexpected tool event fails the attempt.
- Exactly the ten required, hash-indexed baseline artifacts are copied into a disposable non-repository workspace and re-hashed before and after inference. The prompt embeds bounded textual evidence; screenshots are explicit image inputs; the trace is represented by its admitted hash/size and verifier-owned assertions that cite it.
- The model authors diagnosis fields only. IDs, backend/auth, CLI/thread/usage/timing, prompt/schema/input/output hashes, and retry count are injected by trusted code.
- The 0.139.0 usage contract includes `input_tokens`, `cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens`. The CLI event stream does not expose a model identifier, so persisted `model` is `null` unless a future pinned protocol exposes one.
- MVP admission requires exactly one verifier-owned `FAIL` assertion for each frozen seed before any Codex preflight. Analysis requires those three seed codes once each, contiguous ranked hypotheses, citations matching an exact verifier-owned base-path/assertion-fragment catalog, one regression assertion, bounded uncertainty, and no successful-turn refusal language.
- Real success and fixture analysis are separate strict schemas. Fixture remains rehearsal-only and cannot be persisted or relabeled as real.
- No automatic retry is implemented in M4 (`retryCount: 0`), satisfying the accepted maximum of one while avoiding unproven retry classification.
- The real smoke requires an explicit run ID and an anchored `FAIL_BLOCKED`, profile-verified, fully redacted baseline. It never chooses the latest run or fixture data.
- The existing M3 fixture worker/control API/dashboard remain behaviorally unchanged.

## Canonical files and likely changes

- `packages/contracts/src/index.ts`, `packages/contracts/test/analysis.test.ts`
- new `packages/model-adapter/`
- `packages/store/src/store.ts`, `packages/store/src/index.ts`, focused store tests
- `scripts/demo-preflight.mjs`, new `scripts/run-model-smoke.mjs`
- root `package.json`, `package-lock.json`, `vitest.config.ts`
- active planning/README documentation and final `MILESTONE-4-ACCEPTANCE.md`

## Acceptance evidence ledger

| Criterion | Proof |
|---|---|
| Subscription-only, exact auth/version, no fallback | Offline injected-runner tests; positive/negative preflight; real smoke |
| Anchored redacted evidence only | Evidence admission plus workspace/input-hash tests |
| Schema-valid cited diagnosis | Contract/output/citation tests; real persisted smoke report |
| Complete safe provenance | JSONL parser tests and real smoke read-back |
| Quota/auth/refusal/process fail closed | Fake transcript/process tests; no deliberate quota consumption |
| Fixture cannot masquerade as real | Cross-schema and fixture-adapter tests |
| Immutable persistence | collision/tamper/path tests and persisted smoke read-back |
| No M3 regression | serialized focused suite, default/integration tests, control E2E, typecheck, lint, build |
| Independent acceptance | fresh behavior and security reviews after implementation |

## Stop rules

Stop and ask before adding a direct model API, new external dependency, dashboard model endpoint, candidate execution, repair behavior, unapproved model override, credential copying, or weaker evidence/fixture policy. Docker remains outside M4.
