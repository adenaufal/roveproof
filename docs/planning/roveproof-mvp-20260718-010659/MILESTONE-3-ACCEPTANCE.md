---
status: accepted
milestone: 3
---

# Milestone 3 acceptance

Milestone 3 — file-backed fixture control plane and proof-ledger dashboard — is accepted.

## Delivered

- strict fixture-only control contracts for jobs, snapshots, idempotency, provenance-bound events, and terminal rehearsal projection;
- file-backed committed jobs, immutable origins, snapshots, idempotency records, latest projection, and JSONL event authority under `var/roveproof/`;
- atomic publication, torn-tail repair, committed-job reconciliation, canonical-root/file containment, and crash-safe one-owner leases;
- one resumable fixture worker following the accepted ten-state route and ending `VERIFYING_CLEAN → INCONCLUSIVE`;
- same-origin, loopback-default, body-bounded `POST /api/jobs` plus persisted job/latest reads and cursor-resumable SSE;
- golden fixture adapter with the exact Indonesia Mobile profile, three stable failures, 8.2 MB / 19 s reference, and explicitly expected 1.4 MB / 6 s output;
- polished responsive proof-ledger dashboard with truthful pre-run/reproduced states, journey spine, profile passport, evidence ledger, persistent provenance caveats, before/expected-after slots, and SSE recovery;
- conspicuous fixture labeling throughout and no approval/decision API route; fixture completion remains state-machine `INCONCLUSIVE` and cannot become review-ready or approved.

## Recovery and safety evidence

Focused regressions prove that:

- every persisted event is anchored through the stored fixture job to its immutable origin before API/SSE publication;
- impossible, post-terminal, and relabeled-real `APPROVED` histories fail closed;
- an incomplete JSONL tail is truncated to the last durable newline before the next append;
- missing latest/idempotency projections are reconstructed from the atomic committed-job record without admitting a second active job;
- killed owners resume, live-PID owners are never taken over, interrupted quarantine is adoptable, and simultaneous contenders yield exactly one lease owner;
- linked ancestors/directories/files and replacement of a pinned artifact root are rejected;
- active persisted jobs resume through job/latest/SSE reads after process interruption.

## Fixture result

The production-mode control E2E completed and restored all ten persisted phases:

```text
REQUESTED
→ BASELINE_RUNNING
→ BASELINE_FAILED_EXPECTED
→ ANALYZING
→ TEST_AUTHORING
→ TEST_FAILED_AS_EXPECTED
→ PATCH_AUTHORING
→ SANDBOX_GATING
→ VERIFYING_CLEAN
→ INCONCLUSIVE
```

Presentation metadata: `REHEARSAL_COMPLETE`.

Approval: unavailable by contract, UI, transition policy, and route inventory.

## Validation

- `npm test`: **26 files / 173 tests passed**;
- `npm run test:integration`: **11 files / 50 tests passed**;
- `npm run test:control:e2e`: passed production build, truth-state labels, ten persisted phases, three failures, SSE interruption recovery, refresh restoration, fixture lock, and 390 px fit;
- `npm run test:e2e`: passed real constrained baseline regression as `FAIL_BLOCKED`, **8.2 MB / 19 s**, profile verified (`run-00c259a8-151a-4669-9a52-12c0384106b6`);
- full typecheck, lint, workspace build, and demo preflight: passed;
- `npm audit` and `npm audit --omit=dev`: **0 vulnerabilities**.

Two earlier real-baseline attempts made while three independent review workers saturated the host correctly failed closed as `INCONCLUSIVE` when frozen CDP rule/jitter timing could not be verified. No tolerance was widened; the final isolated rerun passed.

## Independent acceptance

Fresh final reviews report **PASS**, with no blocker or HIGH finding:

- behavior/architecture: `F:/temp/roveproof-m3-behavior-acceptance-v2.md`;
- security: `F:/temp/roveproof-m3-security-acceptance-v2.md`;
- product UI/UX and accessibility: `F:/temp/roveproof-m3-ui-acceptance.md`.

## Bounded residual risk

This is a single-host, loopback-default, local-first control plane, not a distributed scheduler or authenticated multi-user service. A PID reused by another live process can conservatively keep a stale lease busy; this fails closed rather than permitting two writers. Fixture records currently have no automated retention quota, which is acceptable only while mutation remains local. The expected-after fixture value is rehearsal data, not measured or approvable proof. Real model, sandbox, repair, and verifier execution remain Milestones 4–6 and stay disabled without their prerequisites.
