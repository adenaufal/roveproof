---
status: accepted
milestone: 4
acceptedAt: 2026-07-18T20:09:39+07:00
backend: codex-cli-chatgpt
modelAuth: chatgpt-subscription
---

# Milestone 4 acceptance

Milestone 4 — subscription-backed, evidence-grounded analysis — is accepted.

## Delivered

- strict, non-interchangeable contracts for model-authored output, trusted real analysis, sanitized attempts, and rehearsal-only fixture analysis;
- exactly three ranked hypotheses covering the three frozen seed failures once each, with citations constrained to a verifier-owned path/assertion-fragment catalog;
- real-baseline admission requiring an anchored, redaction-verified, profile-verified `FAIL_BLOCKED` run and exactly one verifier-owned `FAIL` assertion per frozen seed before Codex preflight;
- a new `@roveproof/model-adapter` package with deterministic prompt/schema bytes, bounded evidence projection, copied/re-hashed inputs, explicit screenshot attachments, JSONL lifecycle parsing, dual-channel output agreement, refusal detection, and post-run tamper/cleanup checks;
- ChatGPT-subscription-only Codex preflight and invocation: API/access-token environment variables are rejected by presence, there is no direct model API dependency or fallback, and exact CLI/auth status is mandatory;
- official-release-integrity pinning for the Codex 0.139.0 npm launcher and Windows x64 runtime, trusted-Node `shell: false` execution, metadata/native PATH-shadow rejection, minimal child environment, canonicalized child PATH, handled pipe errors, bounded output/time, and deadline-bounded process-tree termination;
- immutable, content-hashed analysis-attempt and success envelopes plus one-owner model-analysis lease in the file store;
- explicit `npm run test:model:smoke -- --run-id ... [--expected-index-hash ...]`; no latest-run inference, fixture fallback, dashboard model route, repair call, or M3 state transition was added;
- deterministic serialized Vitest execution on this Windows host while concurrency remains exercised inside dedicated lease tests.

## Accepted real analysis

Accepted baseline:

```text
run-6fae3a3e-74f6-4c00-8626-0438d86b9aea
index  aaa028ad14395de83d4220bf71b3a50159ec69bd0cb1a81ab95aa21c816b3dcc
root   b838c5897f58dca514a57a5639ef2d69bdd940bf13df6d20ec7294adc888a021
```

Persisted analysis:

```text
analysis-ad204718-4ada-4918-909e-57e2b68a175e
thread 019f74ec-b7a7-7560-b2ec-b6e60cc93c06
```

Provenance:

- backend/auth: `codex-cli-chatgpt` / `chatgpt-subscription`;
- CLI: `0.139.0`, official-release-integrity checked;
- terminal: `turn.completed`, exit `0`, retry count `0`;
- duration: `36,293.6436 ms`;
- usage: 30,705 input, 2,432 cached input, 770 output, and 35 reasoning-output tokens;
- model: `null`, because pinned Codex JSONL did not expose an identifier; none was guessed;
- all ten required artifact sizes/hashes, prompt/schema hashes, index/root hashes, exact citation catalog, and final-output hash are persisted;
- raw JSONL, stderr, prompt/evidence copies, output file, environment values, and credentials are not persisted.

The report cites:

1. `ID-MONONYM-REQUIRED-LAST-NAME` — start/failure screenshots, exact failed assertion, and result;
2. `ID-PHONE-PLUS62-NORMALIZATION` — start/failure screenshots and exact failed assertion;
3. `MOBILE-HEAVY-CHECKOUT-BUNDLE` — requests, HAR, metrics, and exact failed assertion.

Sensitive-pattern scans of the accepted report and attempt found no auth-file, API/access-token, bearer-token, or key material. No temporary analysis workspace remained.

## Failure and fixture safety

Offline injected-runner tests prove fail-closed handling for:

- present-even-empty `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN`;
- wrong CLI/package integrity, native or metadata-only PATH shadows, and non-exact ChatGPT login;
- early-closing stdin/pipe failures, timeouts, output limits, signals/process exits, and unexpected tool/protocol events;
- quota, auth loss, unavailable model, transient CLI errors, successful-turn refusal, malformed/schema-invalid/channel-mismatched output, invalid paths/fragments, and copied-input tampering;
- missing, duplicate, or non-`FAIL` frozen seed assertions before any Codex process;
- fixture output parsed or relabeled as real.

A real failure produces only a sanitized `INCONCLUSIVE <code>` path. There is no billing-mode or fixture substitution. Fixture analysis remains `mode: fixture`, `approvalAllowed: false`, and cannot satisfy the real report schema.

## Validation

- focused M4 contracts/adapter/store: **6 files / 42 tests passed**;
- full default suite: **31 files / 209 tests passed**;
- integration suite: **16 files / 83 tests passed**;
- complete store package: **2 files / 18 tests passed in three consecutive runs**;
- root/workspace typecheck, lint, and production build: passed;
- control fixture production E2E: passed ten persisted phases, SSE recovery, refresh restoration, fixture lock, mobile fit, and true terminal `INCONCLUSIVE`;
- subscription preflight: exact ChatGPT login and official-integrity `codex-cli 0.139.0` passed;
- authenticated real `test:model:smoke`: passed and persisted the accepted report above;
- negative no-run-ID and present-empty-access-token probes: exited `1` as designed;
- `npm audit --omit=dev`: 0 vulnerabilities.

One default-suite attempt under parallel file execution exposed existing Windows filesystem/worker timing sensitivity. The store now handles stale-lease disappearance and bounded transient Windows rename conflicts, and Vitest serializes files; the full suite, integration suite, repeated store suites, and control E2E then passed.

## Independent acceptance

Fresh final reviews report **PASS** with no blocker, HIGH, or MEDIUM finding:

- behavior: `F:/temp/roveproof-m4-behavior-final.md`;
- security: `F:/temp/roveproof-m4-security-final.md`.

Earlier review findings—seed/assertion binding, child pipe crash, PATH package spoofing, successful-turn refusal, invented fragments, unbounded killer wait, and stale-lease race—were fixed and regression-tested before final acceptance.

## Source provenance and bounded residual risk

The repository intentionally still has no Git `HEAD`; creating one now would change the source-revision behavior accepted in earlier milestones. The bounded M4 source set is therefore recorded by SHA-256 in [MILESTONE-4-SOURCE-MANIFEST.json](MILESTONE-4-SOURCE-MANIFEST.json). This is content provenance, not a historical diff.

The accepted real analysis is one deterministic observation. Deliberate quota/auth exhaustion was tested offline rather than consumed operationally. `model: null` remains honest until a future pinned protocol exposes an identifier. The official runtime-integrity manifest currently enables the accepted Windows x64 Codex 0.139.0 host; another platform or CLI version must fail closed until independently pinned and smoke-tested.

Docker remains unavailable. That does not affect M4, but candidate code must not execute and Milestones 5–6 cannot be accepted until their disposable author/verifier isolation is available.
