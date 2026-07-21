# Roveproof thumbnail — image-generation prompt

Target: Devpost thumbnail, **3:2 ratio** (e.g. 1200×800), JPG/PNG, ≤5 MB. Brand is an editorial "field ledger": forest green, warm off-white paper, mono type, hairline rules. No glossy SaaS gradients, no fake neon.

## Primary prompt (paste into your image generator)

```
Editorial tech key-art, 3:2 landscape. A minimalist "audit ledger" aesthetic on a warm off-white paper background (#f8f7f2) with faint hairline grid rules. Centered: a two-row ledger card. Top row tinted muted brick-red (#f4dfd8) labeled "BEFORE — checkout failed" with large monospace figures "8.2 MB / 19 s". Bottom row tinted deep-teal-green (#dcece7) labeled "AFTER — checkout succeeded" with monospace figures "1.4 MB / 6 s". A small dark forest-green square logo tile (#10231e) with a monospace letter "R" sits top-left, wordmark "Roveproof" beside it in a clean humanist sans. Tiny uppercase tracked caption "REAL-WORLD JOURNEY CI · BUILT IN INDONESIA". Calm, precise, lots of negative space, flat vector, soft paper texture, subtle long shadow under the card. Muted forest-green and evidence-paper palette only. High legibility.
```

## Style / settings
- Aspect ratio **3:2**. Midjourney: add `--ar 3:2 --style raw --v 6`. DALL·E / others: request "1200x800, 3:2".
- Palette to enforce: `#10231e` forest, `#f8f7f2` paper, `#ebe9e1` canvas, `#aa4d38` failure-red, `#167665` verified-green, `#7f5412` amber accent.
- Typeface feel: humanist sans for the wordmark, monospace for the numbers.

## Negative prompt (avoid)
```
neon, glow, purple/blue gradient, glassmorphism, 3D render, robot, brain, circuit-board cliché, stock "AI" imagery, cluttered UI screenshots, lens flare, watermark, distorted or gibberish text, more than 6 words of body text
```

## Notes
- Generators often garble small text. If the numbers or wordmark come out wrong, generate the card **without** text and overlay "Roveproof", the labels, and "8.2 MB / 19 s → 1.4 MB / 6 s" yourself (Figma/Canva) using the palette above.
- Fastest alternative: screenshot the hero + BEFORE/AFTER ledger from `landing/index.html` and crop to 3:2. That already matches the brand exactly.
