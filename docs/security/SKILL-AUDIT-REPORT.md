# Skill security audit

**Project:** OpenAI Build Week 2026 (working product name: Roveproof)  
**Audit date:** 2026-07-18 WIB  
**Policy:** maximum 6 external skills + 2 custom skills; audit every installed copy; reject genuine HIGH/CRITICAL findings.

## Result

| Skill | Source | Scanner | Manual verdict | Decision |
|---|---|---:|---|---|
| `better-ui` | `jakubkrehel/skills` | LOW | SAFE | Retain |
| `core-web-vitals` | `addyosmani/web-quality-skills` | CRITICAL | SAFE — false positive | Retain |
| `interface-design` | `Dammyjay93/interface-design` | LOW | SAFE | Retain |
| `product-name` | `phuryn/pm-skills` | LOW | SAFE | Retain |
| `ui-demo` | `affaan-m/everything-claude-code` | CRITICAL | REVIEW NEEDED | Retain with recording controls |
| `vercel-react-best-practices` | `vercel-labs/agent-skills` | CRITICAL | SAFE — false positives | Retain |
| `world-readiness-qa` | project custom | MEDIUM | REVIEW NEEDED | Retain; project-scoped |
| `verified-codex-patch-loop` | project custom | CRITICAL | REVIEW NEEDED — false-positive critical | Retain; sandbox-only |

No genuine HIGH or CRITICAL behavior was found. The six external versions and computed hashes are pinned in `skills-lock.json`. Custom skills contain no executable scripts.

## Important finding review

### `core-web-vitals`

The scanner flags `fetch('/api/hero-text')` in `SKILL.md:66`. It is an inert fenced example of a same-origin client-rendering anti-pattern, has no body or credential source, and is not executed by the skill. Inventory: two Markdown files; no script, binary, symlink, environment access, or process execution.

**Classification:** false positive; SAFE.

### `vercel-react-best-practices`

Ten scanner hits are duplicate Markdown examples in `AGENTS.md` and `rules/`. They fetch local static assets through `new URL(..., import.meta.url)` or demonstrate same-origin `fetch('/api/users')`. The installed skill contains 76 text files and no executable, package lifecycle hook, binary, symlink, environment access, or covert destination.

**Classification:** false positives; SAFE.

### `ui-demo`

The scanner interprets `process.env.QA_BASE_URL` in `SKILL.md:361` as `.env` credential theft. The example reads one named base URL and falls back to localhost; it does not open a `.env` file or enumerate/transmit environment values. The skill is one Markdown file.

The capability itself can browse an authenticated target, inspect visible DOM, and write a screen recording. Use only with an allowlisted local/demo origin, synthetic data, a least-privilege account, and review of the generated Playwright script before execution. Never record secrets or real PII.

**Classification:** credential finding is false; operational capability requires review.

### `world-readiness-qa`

The scanner flags the phrase “Do not secretly change…” as covert action. In context it prohibits changing deterministic seeds between scored runs. `bash` and `mcp` access are declared because the skill must run browser tooling and inspect evidence; they remain governed by project authorization. It contains Markdown only.

**Classification:** wording false positive; powerful tools are justified but scoped.

### `verified-codex-patch-loop`

The scanner flags a line that prohibits mounting home directories, SSH agents, cloud config, browser profiles, or `.env` files. This is a safety control, not an instruction to read credentials. `bash`, `edit`, and `write` are intentionally declared because the capability creates a candidate regression test and diff.

Use only inside a disposable workspace with empty/allowlisted environment, outbound network denied by default, command and resource limits, diff policy, independent verification, and human approval. Never point this skill at production or the host workspace as its execution sandbox.

**Classification:** critical finding false positive; capability remains REVIEW NEEDED by design.

## Residual controls

1. Keep external skill hashes pinned; rerun the audit after any update.
2. Do not activate more than three skills in one phase.
3. Treat skill examples as guidance, not automatically trusted commands.
4. Keep browser recording and run evidence synthetic and secret-free.
5. Enforce sandbox boundaries in code; prompts alone are not security controls.
6. Review every generated candidate diff and require independent rerun plus human approval.

## Evidence

- Raw scanner logs: `docs/security/skill-audits/*.txt`
- Independent manual reviews:
  - `F:/temp/openai-build-week-bootstrap/security-audit-a.md`
  - `F:/temp/openai-build-week-bootstrap/security-audit-b.md`
- Version pins: `skills-lock.json`
