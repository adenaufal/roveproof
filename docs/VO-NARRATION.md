# Roveproof — voiceover narration (matched to `demo/roveproof-demo.webm`)

The existing video is **58.8 seconds**. This narration is timed to fit it and mapped to what's on screen. About 140 words, reads in ~54s at a natural pace, so it lands inside the video with a little air. Paste the plain block at the bottom into ElevenLabs; the timestamps are just to line up with the footage.

## Narration with on-screen cues

**[0:00–0:06] hero + BEFORE/AFTER ledger**
This is Roveproof. Continuous integration for the users your test matrix forgets. On a real Indonesian mobile, checkout fails. Eight point two megabytes, nineteen seconds.

**[0:07–0:11] Indonesia Mobile profile card**
A customer with one name, rejected. A plus six-two phone number, broken. A page too heavy for 3G.

**[0:12–0:21] the four pipeline stages**
Roveproof records that failure as hashed evidence. Then Codex, running on GPT five point six, reads it, writes a failing test first, and only then one bounded fix, all inside a sandbox with no network.

**[0:22–0:31] safety grid + footer**
Generated code never runs on my machine. Nothing ships until a human approves the exact diff hash.

**[0:31–0:59] dashboard proof-ledger pan**
This is the proof ledger. Every phase persisted and bound by hash. The fixture run stays clearly labeled and can never reach approval. And the payoff, measured not typed: one point four megabytes, six seconds, a checkout that finally works. Built in Indonesia.

## Plain block for ElevenLabs

> This is Roveproof. Continuous integration for the users your test matrix forgets. On a real Indonesian mobile, checkout fails. Eight point two megabytes, nineteen seconds. A customer with one name, rejected. A plus six-two phone number, broken. A page too heavy for 3G. Roveproof records that failure as hashed evidence. Then Codex, running on GPT five point six, reads it, writes a failing test first, and only then one bounded fix, all inside a sandbox with no network. Generated code never runs on my machine. Nothing ships until a human approves the exact diff hash. This is the proof ledger. Every phase persisted and bound by hash. The fixture run stays clearly labeled and can never reach approval. And the payoff, measured not typed: one point four megabytes, six seconds, a checkout that finally works. Built in Indonesia.

## Tips
- Video is 58.8s; the plain block reads ~54s. If TTS comes out long, nudge ElevenLabs speed slightly, or trim the pause before "Generated code never runs".
- The dashboard pan (0:31–0:59) is slow; the last two sentences are paced to fill it.
- Numbers are pre-spelled ("GPT five point six", "plus six-two", "eight point two megabytes") so the TTS reads them right.
- Honest heads-up: this VO covers how Codex/GPT-5.6 run inside the product (what's on screen). The FAQ also wants a word on how Codex helped **build** it. If you do a second take, add one line: "Codex also pinned the model to GPT-5.6 and fixed a Windows lease race in the build" — both are real commits in the repo.
