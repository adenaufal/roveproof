# M5 architecture delta

> This is a delta to the accepted architecture, not a replacement. It remains `proposed` until `product-brief.md` is explicitly approved.

## 1. Authority and baseline

The current tree has no Git `HEAD`. `computeTargetSourceRevision()` currently yields `sha256:b1a9bc6400df6d705f2ca934444e2450fbabed5e829b10506b2599bcea596e13`; the accepted M2 run records `sha256:06ac07051704ad813c6706cc47c3bd89bc0de2d8a1d37b9ed3ed7934df9585c4`. The hash includes `package-lock.json`, and no M2 archive exists. Therefore the implementation must not claim the current tree is the accepted baseline.

Recommended boundary: finish M5 tooling and its dependency lock state first, then run an explicit fresh real baseline and (if the user approves model spend) fresh analysis. Store/read back those records and bind the snapshot to their exact IDs, index/root hashes, analysis record hash, and final source revision. The old accepted IDs remain historical evidence only. If the user supplies an archive, the fresh re-anchor can be replaced by an audited archive admission.

## 2. Components and ownership

### `packages/contracts`
Add strict, separate schemas/types (names may follow existing conventions):

- `TestAuthoringDiffSchema` with `operation: "test-only"`;
- `SourceAuthoringDiffSchema` with `operation: "source-only"`;
- shared canonical diff metadata, but no union that permits cross-operation parsing;
- `AuthoringAttemptRecordSchema` (sanitized CLI/thread/usage/timing/status/error only);
- `SourceSnapshotSchema` (source revision, baseline/evidence/analysis bindings, ordered file hashes);
- `TestFailureProofSchema` (snapshot/candidate hashes, exact command ID/argv digest, exit/result classification, expected seed/assertion binding);
- `CandidatePolicyEvidenceSchema` and `SandboxCommandEvidenceSchema`;
- an M5 candidate envelope schema separate from the existing M6-oriented `CandidateRecordSchema`.

Trusted code injects IDs, hashes, CLI/auth provenance, timestamps, and command evidence. Model output cannot choose them.

### `packages/model-adapter`
Reuse `buildCodexEnvironment()`, `runCodexPreflight()`, bounded process handling, JSONL parser patterns, and workspace cleanup. Add an authoring module/workspace projection with two operation-specific entry points:

1. `authorRegressionTest()` — prepares a bounded test/source projection and accepts only `test-only` output.
2. `authorCandidatePatch()` — requires a persisted valid `TestFailureProof` and accepts only `source-only` output.

Each call is a new `codex exec --ephemeral --json --sandbox read-only --ignore-user-config --ignore-rules --disable shell_tool` invocation (plus only flags proven by the pinned CLI). No `resume`, shared mutable workspace, model-provided path, model-selected command, raw JSONL, or credentials are persisted. The source call is unreachable until trusted code validates the proof.

### `packages/sandbox` (recommended)
Internal package, no external dependency. Owns source projection/snapshot, strict unified-diff parser/policy/apply, fixed command registry, Docker runner, export admission, timeout/descendant cleanup, and sanitized evidence. It must not own the journey oracle or model credentials.

### `packages/store`
Extend the existing trusted-root atomic store with immutable candidate records and one repair lease if needed. Do not add M6 decision routes. Candidate publication is write-once; read validates schema, path, envelope hash, and cross-record bindings.

### `scripts/run-repair-smoke.mjs`
Require explicit `--baseline-run-id`, `--expected-index-hash`, `--analysis-id`, `--expected-analysis-hash`, and `--expected-source-revision`; reject omitted/latest/fixture inference. Exit nonzero for invalid input or infrastructure/auth failure, while the persisted/run-level status remains `UNVERIFIED`/`INCONCLUSIVE` rather than a pass. Add a root `test:repair:smoke` script only after the command contract is implemented.

## 3. Source projection and diff policy

The trusted snapshot is an ordered, regular-file-only manifest. It contains only files required to run the admitted candidate test and its allowlisted command, plus package metadata/lockfile needed by the pinned preparation image. It excludes `.git`, `.pi-subagents`, `.env*`, `node_modules`, `var`, home directories, Codex config/auth, and arbitrary repository files. Every path is canonical forward-slash relative, each file has size/SHA-256, and the source revision is recomputed before and after projection.

The parser must reject UTF-8-invalid or over-limit input, absolute/drive/UNC/backslash/traversal paths, duplicate/case-alias paths, symlink/hardlink/special files, binary/mode/rename/delete patches, malformed or overlapping hunks, and untrusted command text. Test-only paths are limited to the explicit candidate test allowlist; source-only paths are limited to approved application files. Seed definitions, profile/config/oracle/runner/verifier, package manifests/lockfiles, CI/Docker/infrastructure, generated output, secrets, and existing proof controls are denied by default. Combined file/line budgets are enforced after canonicalization: max 5 files and max 250 additions+deletions.

The policy also scans text for secret/key/bearer patterns and rejects `.skip`, `.only`, timeout inflation, removed assertions, weakened budgets, swallowed errors, and test changes that turn a required failure into an unproved pass. Candidate diff hash is computed over canonical unified-diff bytes by trusted code.

Because intentional baseline tests assert the seeded defects, the first implementation must make their role explicit. Default policy leaves verifier-owned seed/oracle tests immutable and runs a separate candidate-focused proof target; any change to an existing expectation requires a parent-approved, coverage-preserving rationale and must never be treated as assertion weakening.

## 4. Docker boundary

Candidate execution is a host-controlled `docker run`, never a shell string and never a model command. The image is prepared outside candidate execution, pinned by immutable digest, and invoked with `--pull=never`; the exact digest and resource values are recorded after the actual engine is available. A safe proposed envelope is:

```text
docker run --rm --pull=never --network none --read-only --init \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=128 --memory=2g --cpus=2 --stop-timeout=2 \
  --mount type=bind,src=<projection>,dst=/input,readonly \
  --mount type=bind,src=<bounded-export>,dst=/export \
  --tmpfs /work:rw,nosuid,nodev,size=512m \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  <image>@sha256:<digest> <fixed-entrypoint> <fixed-argv>
```

The runner rejects `--privileged`, host/network/PID/device/socket/home/auth mounts, published ports, `CODEX_HOME`, inherited API keys, package installation, and arbitrary argv. Candidate processes get a synthetic minimal environment. A host watchdog bounds wall time and kills the full process tree; exit, signal, timeout, resource, network, and export violations fail closed. Export is copied/read-admitted only from a bounded directory; links, paths outside root, excess size/count, and raw secrets are rejected. If the engine or a required flag is unavailable, no candidate starts.

Docker's `none` network is treated as loopback-only, so the command evidence must record that policy rather than claiming a stronger physical guarantee. Read-only root and explicit writable tmpfs/export mounts are separately inspected. The image-preparation path is trusted setup, not a candidate-time network permission.

Official references for runtime semantics: `https://docs.docker.com/reference/cli/docker/container/run/`, `https://docs.docker.com/engine/network/drivers/none/`, `https://docs.docker.com/engine/storage/bind-mounts/`, `https://docs.docker.com/engine/containers/resource_constraints/`, `https://developers.openai.com/codex/noninteractive`, and `https://developers.openai.com/codex/auth`.

## 5. Control flow

1. Admit explicit baseline/evidence/analysis IDs and read immutable records from trusted store.
2. Verify current source revision and create immutable projection/snapshot.
3. Acquire the single repair lease; preflight Codex without exposing auth material.
4. Call test author once; parse/validate `test-only` diff and persist sanitized attempt.
5. Apply only the test diff in a fresh Docker author workspace; run one fixed test command. Require a failing assertion bound to the expected seed, with no setup/timing/protocol noise. Persist `TestFailureProof`.
6. Only after step 5 succeeds, call source author once; parse/validate `source-only` diff.
7. Apply combined test+source diff in a fresh disposable Docker workspace; run policy, targeted tests, relevant checks, typecheck/lint/build only from the fixed command registry. Persist every bounded result.
8. End M5 at `SANDBOX_GATING` with `PASS`/`REJECTED`/`INCONCLUSIVE` evidence. Destroy workspaces. Do not enter M6 verification or approval.

## 6. Rollback and failure handling

No candidate is applied to the active worktree. Rollback is workspace deletion and candidate record retention. On any policy/provenance/sandbox failure, persist sanitized evidence, release the lease, destroy temporary directories, and stop the one attempt. Never ask Codex for a compensating patch. A future M6 verifier consumes an admitted diff; it is outside this change.

## 7. Decisions still requiring approval

- fresh current-tree baseline+analysis versus an authoritative historical snapshot;
- one mononym slice versus all three seeds;
- new internal sandbox package versus existing-package placement;
- pinned image/resource defaults and authorization to start Docker Desktop;
- treatment of existing intentional baseline tests when a legitimate source fix changes their expected behavior.
