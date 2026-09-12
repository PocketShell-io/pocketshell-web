# Generating site imagery (Codex imagegen)

Repeatable process for producing brand-consistent images (blog covers, landing art).

## Process

1. **Write a self-contained brief** to `.tmp/<task>-brief.md`. Include: the style spec below, exact output paths and dimensions, one paragraph per image (composition + mood), and an explicit constraint that codex produces raster images only — no edits to other files, no git commands.
2. **Launch codex** in the background:

   ```bash
   timeout 55m codex exec \
     -c model=gpt-5.6-luna -c model_reasoning_effort=max \
     -C /home/alexey/git/pocketshell-web \
     --sandbox workspace-write \
     -o .tmp/<task>-final.md \
     "Read .tmp/<task>-brief.md and execute it."
   ```

   The `-c model=gpt-5.6-luna -c model_reasoning_effort=max` flags are mandatory for image work. Eight images took ~10 minutes.

3. **How it generates:** codex follows the skill at `~/.agents/skills/.system/imagegen/SKILL.md` and uses its built-in `image_gen` tool. No `OPENAI_API_KEY` is set, so never use the skill's `scripts/image_gen.py` CLI fallback. Raw outputs land under `~/.codex/generated_images/<session>/`; the brief tells codex to copy finals into `public/images/...`.
4. **Validate and convert:** check each image (subject, palette, no garbled text, exact dimensions), then convert copies for in-page use (see Format below). Reference image for the look: `public/images/og-cover.png`.

## Style spec (paste into every brief)

- Palette: near-black `#0d1117` background, green `#3fb950` accent, off-white `#e6edf3` text, dark-gray `#30363d` borders. Dark theme only.
- Look: flat-to-soft-3D modern illustration, crisp geometry, generous negative space; terminal-window motifs (three window dots, `$` prompts, cursors), monospace type, rounded dark cards. The 2026-09 set came out as soft-3D renders on the dark background despite "flat" in the prompt and looked right — matching `og-cover.png`'s depth is the goal, not flatness per se.
- No photos of real people; no real-world logos or trademarks; devices are generic laptop/tablet/phone silhouettes.
- Text policy: the only allowed text is the wordmark `pocketshell.io` bottom-right, monospace, rendered verbatim. Per-asset exceptions must be spelled out in the brief. Terminal screens show abstract dimmed glyph shapes, not readable code — models garble anything else.
- Sizes: blog covers 1200×630 at `public/images/blog/<slug>.png` (og 1.91:1); landing art 1536×1024 in `public/images/`. One series: same palette and style, distinct compositions.

## Format: WebP in-page, PNG for og:image

- Convert a copy for in-page display: `convert img.png -quality 85 img.webp`. Flat dark art compresses ~98% (a 545 KB cover → 9 KB; the 1.25 MB landing image → 19 KB); q85 and q80 produce the same size here.
- Keep `og:image` / `twitter:image` pointing at the PNG: crawlers are the only fetchers of those, PNG has the broadest compatibility, and their size never affects page load.
- Eyeball dark gradients for banding after conversion.

## QA: spotting "AI-generated" tells (check before shipping)

The set-wide tell is **soft airbrushed shading**: the hand-made `og-cover.png` is 97% perfectly-flat pixels with 938 unique colors, while every generated image is 62–77% smooth-gradient pixels with 7k–37k colors. That glossiness is what reads as "AI-generated". Judge each image full-size, and all covers together in one grid — style drift against the series is itself a tell. Visual tells, in order of importance:

1. **Glossy stock-3D materials** — plasticky/metallic surfaces, specular sparkle highlights, bloom glows, studio lighting. The brand look is matte.
2. **Melting detail work** — key teeth, ports, keyboard rows, or hinges that blob into nonsense; quasi-lettering that almost spells words.
3. **Confetti filler** — random dots, floating rounded squares, or constellation scribbles scattered to fill space instead of intentional composition.
4. **Broken geometry** — traffic-light dots unequal or not red/amber/green, window frames out of square, wobbly dashed lines, elements floating unanchored or colliding.
5. **Mixed perspective in one scene** — a straight-on terminal window next to a 3/4-view server rack.

### Repeatable gate: pixel metrics + OCR

Eyes rank offenders; two scripted checks make the pass repeatable:

- **Metrics** — `/usr/bin/python3 scripts/ai-tells-metrics.py` (from the repo root; prints one table row per cover against the `og-cover.png` reference). Reject an image when: flat-pixel share < 35%, unique colors > 10k, top-8 palette share < 90%, or specular-glint clusters appear with no matching text block — glints without text mean a metallic stock-render look.
- **Airbrush index** — smooth-gradient share far above the reference's 0.3% is the whole-set tell; use it to rank offenders, not to auto-reject (the model renders soft shading by default).
- **OCR** — `tesseract` at 2× scale, `--psm 11`. Only the approved `pocketshell.io` wordmark (plus `~/.ssh/config` on its cover) may appear, letter-perfect; misspelled or stray words = regenerate. Loose shape-blobs misread as glyphs are expected, not a tell.
- **Motif check** still needs eyes: traffic lights red/amber/green, no glow halos.

Accept an image only when it passes metrics, OCR, and the visual checklist above.

## Replacing weak images

Regenerate only the offenders — never the whole set:

1. Write a one-asset fix brief to `.tmp/<slug>-brief.md`: the original asset paragraph from the generation brief plus hard bans — **no gradients, no 3D/metallic/glossy, no soft shadows, no blur/bokeh, no glow bloom; solid fills only; traffic lights red/amber/green; match `public/images/og-cover.png` flatness**.
2. Launch codex with the same command as in Process, pointing at the fix brief. One targeted change per retry.
3. Gate on the metrics + OCR + motif checks above before accepting; then `convert <path>.png -quality 85 <path>.webp` and `npm run build`.
4. Longer term: true-flat output needs these flatness bans in every brief, or post-processing (posterize toward the og-cover palette).

### 2026-09 verdicts (pixel-metrics + OCR against og-cover.png)

- **Replace:** `ssh-authorized-keys-hardening` — extreme outlier on every axis: 36,697 colors (2–5× the set), most smooth shading, 152 specular-glint clusters with no text to justify them, lowest palette concentration — reads as glossy 3D stock art.
- **Review next:** `ssh-ai-agents-remote-machines` — most airbrushed of the remainder (20,295 colors, 77% smooth).
- **Keep:** the rest. `ssh-config-file` (6,776 colors, 97.4% top-8 share) and `landing-agents` are cleanest; the landing wordmark OCRs letter-perfect, and all seven covers pass the no-garble OCR check.

## Wiring (how images reach the page)

- Blog covers: `cover:` frontmatter on the post points at the **webp**; `scripts/build-blog.mjs` swaps `.webp` → `.png` for `og:image`/`twitter:image` and uses the webp as-is for the card covers on the index, the keep-reading cards, and the post-page hero.
- Landing art: `<img class="final-cta-visual">` in `src/views/LandingView.vue`, pointing at the webp.
- Current assets (2026-09): masters `public/images/blog/<slug>.png` + webp siblings, and `public/images/landing-agents.png` + webp sibling.
