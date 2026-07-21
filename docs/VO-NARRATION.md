# Roveproof — voiceover narration (ElevenLabs-ready)

Paste the **Narration** block below into ElevenLabs. It runs about **2:20–2:35** spoken, under the 3-minute cap. English. It covers the three required points: what you built, how Codex is used, and how GPT-5.6 is integrated and what it's doing.

Everything here is true about how the **product** works. The one bracketed line about building *with* Codex is left for you to fill only if it's accurate (see the note at the bottom and the Session-ID discussion).

---

## Narration

> This is Roveproof. It's continuous integration for the users your test suite forgets about.
>
> Most teams test checkout on a fast laptop and a stable connection, with names that fit a first-name and last-name box. A lot of the world doesn't look like that. In Indonesia, plenty of people go by a single name. Phone numbers start with plus six-two. The network drops to something like 3G the moment you leave the mall. The bugs that only those users hit ship straight to production, because nobody's CI ever ran as them.
>
> So here's the same checkout, running the way a low-end phone in Jakarta runs it. A small screen, an Indonesian locale, a slow processor, a throttled connection. And it fails. It rejects a customer who only has one name. It breaks a plus six-two phone number. And it ships a page far too heavy for the network. Eight point two megabytes, nineteen seconds, to a broken checkout. Roveproof records that whole run as a signed, hashed evidence bundle.
>
> Now here's where the model comes in. Roveproof sends that evidence to Codex, running on GPT five point six, through a read-only call with no shell access. GPT five point six reads the actual screenshots, the network log, and the timings, and returns a diagnosis where every claim points back to a specific piece of evidence.
>
> Then the repair, and this is the careful part. GPT five point six writes a failing test first. That test has to fail on the untouched code, for the exact reason we expect, inside a throwaway container, before anything else happens. Only then does a second Codex call write the actual fix. Both come back as plain diffs, and they never run on my machine. They run in a sandbox with no network.
>
> Finally, a separate check that never calls the model at all reapplies that exact fix, verifies its hash, and runs the whole journey again. One point four megabytes, six seconds, a checkout that works. And it still doesn't ship until a human approves that exact diff.
>
> [OPTIONAL — only if true: While building Roveproof, I used Codex to <the real thing, e.g. scaffold the sandbox runner and iterate on the Docker isolation flags>, which is where it saved me the most time.]
>
> That's Roveproof. Codex and GPT five point six aren't bolted on. They're the engine that turns a broken journey into a fix you can actually trust. Built in Indonesia.

---

## ElevenLabs tips
- Write numbers the way you want them read. "GPT five point six", "plus six-two", "eight point two megabytes" are already spelled out above so the TTS doesn't mangle them.
- Voice: a calm, mid-paced narrator (e.g. a "conversational" preset). Stability ~50, Similarity ~75. Don't over-crank stability or it flattens.
- Generate in the paragraph chunks above so you can retime each to the on-screen b-roll.

## Syncing to the b-roll (`demo/roveproof-demo.webm`)
- The footage is ~2:00 and the VO is ~2:20–2:35. Either slow the footage slightly, hold on the before/after ledger a beat longer, or trim a sentence. Don't let total runtime pass 3:00.
- Match paragraphs to shots: intro/problem over the hero + Indonesia-Mobile card, the "8.2 MB / 19 s" line over the red BEFORE row, the Codex/GPT-5.6 paragraphs over the pipeline stages, and the "1.4 MB / 6 s" line over the green AFTER row.
- The FAQ says showing Codex on screen is a strong signal. If you can, drop in a few seconds of an actual `codex exec` run (or the terminal from the operator flow) under the diagnosis/repair paragraphs.

## Note on "built with Codex"
The narration's core is the product's real runtime use of Codex + GPT-5.6. The FAQ also wants you to show where **Codex accelerated your build**. Only say the bracketed line if you genuinely used Codex to build Roveproof, and make it specific (what it scaffolded, what decision it helped with). If the build wasn't done in Codex, don't claim it — talk to the point about the runtime engine instead, and resolve the `/feedback` Session ID question separately.
