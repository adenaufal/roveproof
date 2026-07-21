# Roveproof — demo video script

Target: **≤ 3 minutes**, public YouTube, 1280×720. English voiceover. The narration below runs about **2:45** at a natural pace (~150 wpm), which leaves room to breathe. It covers the three things the form requires: **what you built, how you used Codex, and how you used GPT-5.6**.

Say it like you're showing a colleague, not reading a brochure. Contractions are fine. If a line feels stiff out loud, change it.

---

## Shot list + voiceover

**[0:00–0:12] — Hook**
SCREEN: `landing/index.html` hero, the BEFORE/AFTER ledger visible.
VO: "Here's a checkout that works fine on my laptop. Watch what happens when I run it the way a cheap phone in Jakarta actually runs it."

**[0:12–0:40] — The failing baseline**
SCREEN: terminal running `npm run evidence:baseline`; the run fails; cut to the dashboard/ledger showing the red BEFORE row (8.2 MB / 19 s).
VO: "Same code. But now it's a 360-pixel screen, an Indonesian locale, a slow CPU, and a throttled 3G connection. It fails. It rejects a customer who only has one name, it breaks a plus-62 phone number, and it ships a bundle way too heavy for the network. Eight-point-two megabytes, nineteen seconds, broken checkout. And that run gets written down as a hashed evidence bundle, not a screenshot I could fake."

**[0:40–1:05] — Codex diagnosis (GPT-5.6)**
SCREEN: `npm run test:model:smoke ...`; show the returned hypotheses, each cited to an artifact.
VO: "Now Codex reads that evidence. One read-only call, no shell, running on GPT-5.6 through my ChatGPT login. Every hypothesis it hands back points at a specific artifact in the bundle and says what would prove it wrong. What it reads is data, never an instruction."

**[1:05–1:35] — Failing-test-first repair**
SCREEN: `npm run test:repair:smoke ...`; highlight the test-only container run failing for the intended reason.
VO: "The repair is the careful part. GPT-5.6 writes a test first, and that test has to fail on the untouched code, for the exact reason we expect, inside a throwaway Docker container. Only then does a second call write the actual fix. Both come back as plain diffs, and they never run on my machine."

**[1:35–1:55] — Sandbox + bounded candidate**
SCREEN: the combined container run passing; candidate saved with its diff hashes.
VO: "Everything generated runs in a container with no network and a read-only root. The whole candidate is capped at five files and two hundred fifty lines. If the combined run passes, one candidate gets saved."

**[1:55–2:25] — Independent verification (the payoff)**
SCREEN: `node scripts/run-verification.mjs ...`; the green AFTER row (1.4 MB / 6 s).
VO: "Then a separate verifier, one that never calls the model at all, reapplies the exact same diff, checks its hash, and runs the original journey again. One real order, no failures, under two megabytes, under eight seconds. One-point-four megabytes, six seconds. That's a measured run, not a number I typed in."

**[2:25–2:45] — Hash-bound approval + close**
SCREEN: the approval view showing `candidateId` + `combinedDiffHash`; approve it. Cut to logo/landing.
VO: "And it still doesn't ship on its own. A human approves the exact candidate and the exact diff hash, or nothing happens. Approval exports the diff. It never merges, never deploys. Roveproof. Test software for the users your CI never represents. Built in Indonesia."

---

## Production notes
- Resolution 1280×720. The repo already has a Playwright demo-recorder pattern in `.agents/skills/ui-demo/SKILL.md` (cursor overlay, subtitles, natural pacing) if you want a clean screen capture.
- Keep the terminal font large and readable. Pre-run the slow steps and cut the waiting; show the result, not the spinner.
- Whenever a real ID/hash prints, let it sit on screen for a beat. That's the whole point of the project.
- Truthfulness: the 1.4 MB / 6 s figure is the measured verification run. Don't call it a field statistic, and don't show the fixture control plane as if it were an approval.
- If you go over 3:00, trim shot [1:35–1:55] first, then tighten the baseline narration.

## The commands you'll show (from README "End-to-end operator flow")
```
npm run demo:preflight
npm run demo:reset
npm run evidence:baseline
npm run test:model:smoke   -- --run-id <id> --expected-index-hash <hash>
npm run test:repair:smoke  -- --baseline-run-id <id> --expected-index-hash <hash> \
  --analysis-id <id> --expected-analysis-hash <hash> --expected-source-revision <rev> \
  --image node@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
node scripts/run-verification.mjs --candidate-id <id> --image roveproof-verifier:local
```
