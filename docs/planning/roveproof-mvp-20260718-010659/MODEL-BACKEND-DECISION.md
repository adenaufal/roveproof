---
status: accepted
acceptedAt: 2026-07-18
scope: milestones 4-7
---

# Model backend decision — ChatGPT subscription through Codex CLI

## Decision

Roveproof will not use OpenAI Platform API billing. Milestones 4 and 5 must use the locally installed Codex CLI authenticated with **Sign in with ChatGPT** and the operator's existing ChatGPT subscription.

This is a hard product constraint:

- no `OPENAI_API_KEY`, `CODEX_API_KEY`, or `CODEX_ACCESS_TOKEN`;
- no direct Responses API or other metered model API calls;
- no silent fallback from ChatGPT-managed Codex access to API-key billing;
- no requirement for an exact API-only model identifier;
- subscription/auth/quota failure becomes `INCONCLUSIVE` in real mode, while fixture mode remains explicit rehearsal data.

ChatGPT subscriptions and API billing are separate. Codex CLI officially supports ChatGPT sign-in for subscription access, non-interactive `codex exec`, JSONL events, and JSON Schema-constrained final output:

- <https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform>
- <https://developers.openai.com/codex/auth>
- <https://developers.openai.com/codex/noninteractive>

## Trusted invocation boundary

The model adapter is a trusted local host process. It invokes the installed `codex` binary and reuses Codex's existing ChatGPT-managed login. Roveproof must never read, copy, print, persist, mount, or pass `~/.codex/auth.json` (or credential-store contents) to a model input, candidate workspace, command, sandbox, artifact bundle, or log.

Every Codex child process receives a minimal allowlisted environment with `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` absent. Preflight fails if any variable is present—even empty—or if the successful, trimmed `codex login status` output is not exactly `Logged in using ChatGPT`. The M4 Windows x64 launcher and runtime must also match the pinned SHA-256 manifest derived from the official `rust-v0.139.0` GitHub release assets; metadata-only PATH shadows are rejected.

Untrusted repository content and browser evidence remain data, never instructions. Model calls run only against a bounded admitted input workspace.

## Milestone 4 — analysis invocation

The analyzer will use a non-interactive, ephemeral, read-only Codex invocation with a versioned JSON Schema, equivalent to:

```text
codex exec --ephemeral --json --sandbox read-only --ignore-user-config --ignore-rules --disable shell_tool --output-schema <schema> -o <result> <versioned prompt>
```

The adapter must ignore user configuration and user/project execution-policy rules, disable the model-visible shell tool, run from an isolated workspace containing no project Codex configuration, and may add only reviewed reproducibility flags supported by the pinned CLI. It may not broaden filesystem permissions. Only admitted redacted evidence and versioned trusted control data enter the temporary analysis workspace. `read-only` is not claimed to provide cwd-only host read confinement; disabling shell access and rejecting every unexpected tool event are separate mandatory controls.

Persisted provenance must include:

- backend ID `codex-cli-chatgpt` and authentication mode `chatgpt-subscription`;
- Codex CLI version and configured/observed model identifier when exposed;
- thread ID and terminal turn status from JSONL;
- all four 0.139.0 usage fields (`input`, `cached input`, `output`, and `reasoning output` tokens), duration, exit status, and bounded retry count;
- prompt version, output-schema hash, and every input artifact hash;
- refusal, quota, authentication, malformed-output, and process-error classification.

Credential/access-token values and auth material are never provenance; aggregate usage counts are.

## Milestone 5 — patch-author invocation

Regression-test and source-patch authoring are separate read-only Codex calls that return typed unified diffs. Codex does not directly apply or execute its proposed diff on the host. Roveproof validates the output contract first, then applies and executes it only inside the disposable author sandbox with no home mount, model credentials, inherited secrets, or outbound network.

The source-patch request is allowed only after the isolated baseline proves the test-only diff fails for the intended reason. One repair attempt remains the MVP limit.

## Milestone 6 and demo implications

The independent verifier and approval flow require no model call. They consume only the persisted, policy-admitted exact diff and rerun verifier-owned proof in a fresh workspace.

A new demo operator must authenticate Codex interactively with ChatGPT before preflight. Subscription limits are an honest external prerequisite: exhaustion blocks real analysis/authoring and never switches billing modes.

## Current verified prerequisite

On the accepted development machine:

```text
codex-cli 0.139.0
Logged in using ChatGPT
```

Milestone 4 will pin the supported CLI/version behavior and add an authenticated smoke test without exposing credentials.
