---
status: accepted
milestone: 2
---

# Milestone 2 acceptance

Milestone 2 — constrained runner and immutable evidence — is accepted.

## Delivered

- exact-pinned Playwright `1.61.1` with its managed Chromium;
- fixed Indonesia Mobile context plus requested/applied/observed CPU, network, locale, timezone, language, viewport, and physical touch verification;
- versioned deterministic 0–250 ms jitter window with bounded event/window drift;
- verifier-owned checkout actions and oracle with deterministic mononym-first precedence;
- one-authority CDP encoded-transfer accounting and monotonic task timing;
- trace, redacted HAR, screenshots, console, request, assertion, result, manifest, and metrics collectors;
- textual credential/unexpected-PII admission under an explicit fixed-synthetic-only policy;
- fail-closed non-target HTTP(S)/WebSocket egress guard;
- schema validation, cross-record measurement checks, SHA-256 artifact index, atomic no-overwrite publication, and exclusive external run anchor;
- partial `INCONCLUSIVE` bundles when browser/profile/artifact proof is unavailable.

## Measured baseline

Final accepted run: `run-6fae3a3e-74f6-4c00-8626-0438d86b9aea`.

- verdict: `FAIL_BLOCKED`;
- exactly three observed seed IDs;
- transfer: **8,161,170 encoded bytes** → **8.2 MB**;
- task duration: **19,203.5371 ms** → **19 s**;
- rounding: decimal MB to one decimal; duration to nearest second;
- profile verified: yes;
- order count: zero;
- missing artifacts/deviations: none;
- indexed payload artifacts: 10;
- index hash: `aaa028ad14395de83d4220bf71b3a50159ec69bd0cb1a81ab95aa21c816b3dcc`;
- root hash: `b838c5897f58dca514a57a5639ef2d69bdd940bf13df6d20ec7294adc888a021`.

## Validation

- `npm test`: **22 files / 143 tests passed**;
- `npm run test:integration`: **8 files / 23 tests passed**;
- `npm run test:e2e`: passed and produced the accepted real-browser bundle;
- typecheck, lint, full workspace build, demo preflight: passed;
- explicit anchored admission with the expected index hash: passed;
- `npm audit` and `npm audit --omit=dev`: **0 vulnerabilities**.

Independent re-review:

- behavior/evidence integrity: **GO**, no blocker/high/medium finding;
- security/evidence admission: **GO**, no blocker/high/medium finding.

Reviewer artifacts:

- `F:/temp/roveproof-m2-behavior-acceptance.md`;
- `F:/temp/roveproof-m2-security-acceptance.md`.

## Bounded residual risk

Binary screenshots and image entries are not content-scanned. They are accepted only under the enforced fixed-synthetic-data MVP scope; real customer data remains prohibited. Docker and OpenAI credentials remain future Milestone 4–6 prerequisites and do not affect this runner/evidence acceptance.
