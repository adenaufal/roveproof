# Roveproof — OpenAI Build Week (Devpost) submission answer sheet

Copy-paste-ready answers, organized to match the **actual Devpost form steps**. The Project Story below is written to read as human prose (anti-slop pass applied), but read it once and make it yours before you paste. `[TODO]` = you supply.

> **⚠ Two hard requirements from the form:**
> 1. The repo README **and** the demo-video voiceover must explain **how Codex AND GPT-5.6 were used** (README section is in place; see step 3 story + step 4 repo field).
> 2. Video demo link is **required** (≤3 min, public YouTube).

---

## Step 2 — Project overview

### Project name  *(max 60 chars)*
```
Roveproof
```

### Elevator pitch  *(short tagline, max 200 chars)*
Recommended:
```
Roveproof runs one checkout the way a low-end Indonesian phone would, catches the bugs your CI never sees, and proves the AI's fix in a sandbox before you approve the exact diff.
```
Shorter alternatives:
- ≤120: `CI for the users your test matrix ignores: reproduce the failure on a real Indonesian mobile, then prove the AI fix before approval.`
- ≤60: `Real-world journey CI. Prove the fix, don't just claim it.`

### Thumbnail  *(image, JPG/PNG/GIF, 5 MB, 3:2 ratio)*
`[TODO: export a 3:2 image]` — easiest: screenshot the hero/ledger of `landing/index.html`, or use the thumbnail-generation prompt in `docs/THUMBNAIL-PROMPT.md`.

---

## Step 3 — Project details (public project page)

### About the project  *(Markdown "Project Story" — read it, tweak a line or two so it's yours, then paste)*

```markdown
## Inspiration
Most test suites run on a fast laptop, a stable connection, and a form that assumes everyone has a first name and a last name. Plenty of people don't. In Indonesia a lot of us go by a single name, phone numbers start with +62, prices are in rupiah with no cents, and the network drops to something like 3G the moment you walk out of the mall. Those users are real, and the bugs that only they hit ship to production because nobody's CI ever ran as them. I wanted a test that fails the way a cheap Jakarta phone actually fails, and I wanted the AI-written fix to earn its way in instead of getting trusted because it looked plausible.

## What it does
Roveproof runs one checkout the way a low-end Indonesian phone would run it, then walks that failure all the way to an approved fix without ever trusting generated code on faith.

It replays the journey under a pinned profile: a 360x800 screen, id-ID locale, an Asia/Jakarta clock, a CPU slowed 4x, and a throttled 3G schedule, all pointed at a synthetic store. The first run is supposed to fail. Three defects are seeded in on purpose. The store rejects a single-name customer for having no last name, it mangles a +62 phone number, and it ships a checkout bundle way too heavy for the connection. That run gets written down as an immutable, hashed evidence bundle, meaning the screenshots, the trace, the HAR, the timings, and the real bytes that crossed the wire. The headline is blunt: 8.2 MB and 19 seconds to a broken checkout.

Then Codex reads the evidence. One read-only call, no shell. Every hypothesis it returns has to point at a specific artifact in the bundle and say what would prove it wrong. What it reads is data, never an instruction.

The repair is the part I was most careful about. Codex writes a test first, and that test has to fail on the untouched code for the exact reason we expect, proven inside a throwaway Docker container, before a single line of source changes. Only then does a second call write the source patch. Both come back as plain unified diffs, and Roveproof never runs them on my machine. They go into a container with no network and a read-only root. If the combined run passes, one candidate gets saved.

The last step is a separate verifier that never calls the model at all. It reapplies the exact same diff, checks its hash against what was approved for review, and runs the original journey again under the same profile. Land one real order, no seeded failures, under 2 MB and under 8 seconds, and the candidate is allowed to become review-ready. A human still has to approve the exact candidate id and diff hash, or nothing happens. The clean run reads 1.4 MB and 6 seconds.

## How I used Codex and GPT-5.6
Roveproof talks to Codex through the local Codex CLI, signed in with ChatGPT instead of an API key, and the model behind those sessions is GPT-5.6. There's no API-billing path and no fallback. If the login isn't a ChatGPT one, or an OPENAI_API_KEY is set at all (even empty), it refuses to run.

GPT-5.6 gets called three times in a repair, never more, and every call is ephemeral, read-only, with the shell turned off. The first reads the evidence bundle and hands back diagnoses tied to specific artifacts, each with a falsifier. The second writes the failing test. The third writes the source patch, but only after that test has already failed in a container for the right reason. Codex's credentials never touch the evidence, the sandbox, the logs, or any command line. I built Roveproof itself with a mix of Claude Code and Codex, but the shipping product only ever calls Codex and GPT-5.6.

## How I built it
TypeScript across an npm workspace, split into small packages so the trust boundaries are actual module boundaries. The dashboard is Next.js 16 and React 19, loopback only. The journey runner is Playwright driving a pinned Chromium with the Indonesia Mobile profile baked in. Contracts are Zod schemas that every evidence, analysis, candidate, and verification envelope has to satisfy before anything downstream will read it. The sandbox is Docker on a pinned node@sha256 image with the network off, root read-only, capabilities dropped, and hard caps on memory, CPU, time, and output. Storage is write-once and cross-linked by hash, so any number the demo shows can be read back and checked on its own.

## Challenges I ran into
Calling a model is easy. Trusting what it hands back is the whole problem. My first instinct was to apply the diff and run the tests, which is exactly the thing you can't do, because now generated code is running on your machine with your credentials sitting in the environment. So the design kept getting more paranoid. Everything generated runs in a container that can't reach the network. The candidate is capped at five files and 250 changed lines. A second verifier re-proves the fix without asking the model anything, and even a green verifier only makes a candidate eligible for a human. It doesn't approve it. Keeping all of that fail-closed, where a tampered or timed-out or just confusing run stays inconclusive instead of quietly passing, took more code than the happy path did.

## What I learned
The fix isn't trustworthy because the model is smart. It's trustworthy because I re-ran the real journey, under the real constraints, watched it pass, and bound the approval to that one diff. Move the proof out of the prompt and into a container you control, and an AI patch turns into something a person can actually sign.

## What's next
Right now it's one journey, one profile, three defects. I want more profiles (other devices, worse networks, other locales), more journeys than a single checkout, and more kinds of seeded defect. Further out, a gated path from "approved" to a real merge, without giving up the exact-hash approval that makes the whole thing safe.
```

### Built with  *(tags, up to 25)*
```
typescript, node.js, next.js, react, playwright, chromium, docker, zod, vitest, npm-workspaces, openai, codex, codex-cli, gpt-5.6, chatgpt
```

### "Try it out" links
```
GitHub repo:  https://github.com/adenaufal/roveproof
Landing page: https://roveproof.pages.dev
```

### Image gallery  *(up to 15, 3:2)*
`[TODO: add screenshots]` — suggested: landing hero/ledger, the before/after dashboard, an evidence/proof-ledger view, a pipeline diagram. Grab from the control UI (`npm run dev -w @roveproof/control` → http://127.0.0.1:3000) and `landing/index.html`.

### Video demo link  *(REQUIRED — YouTube/Vimeo, ≤3 min, public)*
```
[TODO: paste YouTube URL]
```
Voiceover must cover: what you built, how you used Codex, and how you used GPT-5.6. Storyline: start checkout-v1 under Indonesia Mobile, baseline fails (8.2 MB, 19 s), Codex diagnosis cited to evidence, failing-test-first repair in the sandbox, independent verifier passes (1.4 MB, 6 s), hash-bound human approval. (Ask me for the `docs/VIDEO-SCRIPT.md` when you're ready to record.)

---

## Step 4 — Additional info (for judges)

### Submitter Type
```
Individual
```
Submitter: **Ade Naufal Ammar** (@adenaufal).

### Country of Residence
```
[TODO: confirm — likely Indonesia] (check the official rules for eligible countries)
```

### Which category
```
Developer Tools
```

### URL to your public or private code repo  *(REQUIRED — README must highlight how Codex & GPT-5.6 were used)*
```
https://github.com/adenaufal/roveproof
```
Private repo → share access with `testing@devpost.com` **and** `build-week-event@openai.com`. The README's setup + "How Codex and GPT-5.6 are used" sections are already in place.

### Link for judges to check/test + instructions  *(private; put credentials here if any)*
```
Roveproof runs locally from a clean tree — no hosted login required; judges use their own "Sign in with ChatGPT" Codex session, so there are no credentials to share.
Full step-by-step operator flow (login, preflight, reset, baseline, analyze, repair, verify, approve) is in README.md under "End-to-end operator flow".
```

### /feedback Session ID (where the majority of the project was worked on)
```
no-active-thread-019f851e-7144-75c0-bbcb-8c794e3adf5c
```
Note: the `no-active-thread-` prefix suggests `/feedback` was run with no active Codex thread open. If a different Codex session holds the bulk of the work, grab that one's ID instead.

### If your project is a plugin or dev tool — installation, supported platforms, testing
```
Roveproof is a developer tool (local CLI + loopback dashboard).

Prerequisites: Node.js >=20.9.0, Docker Desktop running, Codex CLI logged in via "Sign in with ChatGPT"
  (OPENAI_API_KEY / CODEX_API_KEY / CODEX_ACCESS_TOKEN must be ABSENT — they are rejected even when empty).
Platforms: verified on Windows 11 + desktop-linux Docker; Node 22 / npm 10.9 / Docker 29 / Playwright 1.61.

Install & verify:
  npm install
  npm run browser:install
  npm run demo:preflight        # checks toolchain, Docker, Codex login, forbidden-credential absence

Run the pipeline (each step prints IDs/hashes the next consumes verbatim):
  npm run demo:reset
  npm run evidence:baseline                                   # -> runId, index hash
  npm run test:model:smoke -- --run-id <id> --expected-index-hash <hash>   # -> analysisId, analysisHash, sourceRevision
  npm run test:repair:smoke -- --baseline-run-id <id> --expected-index-hash <hash> \
    --analysis-id <id> --expected-analysis-hash <hash> --expected-source-revision <rev> \
    --image node@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2   # -> candidateId + diff hashes
  node scripts/run-verification.mjs --candidate-id <id> --image roveproof-verifier:local

Dashboard (fixture control plane, loopback only):
  npm run build:packages && npm run dev -w @roveproof/control   # http://127.0.0.1:3000
```

### Upload a File  *(optional, ≤35 MB)*
`[optional — e.g. a zip of architecture diagram + screenshots; skip if links suffice]`

---

## Step 5 — Submit checklist (from the form)
- [ ] Demo video < 3 min, public on YouTube, link correct in the form
- [ ] Voiceover explains what you built, how you used **Codex**, and how you used **GPT-5.6**
- [ ] `/feedback` Codex Session ID entered
- [ ] Private repo shared with `testing@devpost.com` + `build-week-event@openai.com` (or repo is public)
- [ ] README has setup instructions and explains how Codex & GPT-5.6 were used
- [ ] Dev-tool installation + testing path included (step 4 above)
- [ ] Category selected (Developer Tools)
- [ ] Not saved as a draft — actually submitted

---

## Model note (GPT-5.6)
You confirmed the Codex session ran **GPT-5.6**, so the story and README say so directly. One thing to know if a judge reads the code closely: Roveproof intentionally does **not** pass `--model` (`analyzer.ts`, `authoring.ts`), and records `model: null` rather than asserting an identifier the CLI's JSONL never emitted (`ARCHITECTURE.md`). That's a deliberate "don't guess" design choice, not an omission — the running session's model is GPT-5.6. If you want the code to pin it explicitly, that's a small change plus a re-run of the smoke to re-prove; ask and I'll do it.

## Truthfulness guardrails (keep in every field)
Before/after numbers are single observations under identical recorded settings, not field statistics. The AFTER figure (1.4 MB / 6 s) is a labeled display target; only a genuinely measured, independently re-verified run is approvable. The fixture control plane is labeled and always ends INCONCLUSIVE — it can never reach approval.
