# HAI-FX: working agreement

An artist and Claude build game effects (explosions, hits, pickups, magic...) for **Defold and Godot**,
in **smooth HD and pixel art**, by iterating in layers. The artist hand-tunes and judges; Claude
builds, measures, explains and proposes. Every message between us should point at something
specific: a layer, a parameter, a frame, a pixel, a version. No vague hints, no blind tweaking.

## The loop
1. Claude makes or changes an effect and saves it as a new version in the Studio.
2. The artist opens the Studio, tweaks sliders and colours, pins notes on frames, answers Choices,
   and saves a version.
3. The artist presses **Send to Claude** in the Studio (or says so in chat). The button posts an
   artifact comment sent to Claude, which wakes the Claude session watching the Studio.
   Claude reads everything (below), restates what it understood, makes the next version,
   replies on each note, posts Choices where unsure, and replies in the comment thread
   (ArtifactComments `reply`, then `resolve`).
4. When a version is approved: export, verify in both engines, commit.

Quick changes don't need a round: the Studio's **Ask Claude** box calls Claude from the page
(`sample` capability, on the artist's usage), gets three patches, and shows them in Compare. The
ask and the pick are logged as a note with `kind: "ask"` (status addressed) so rounds see them.

If this session is gone, start a new one on the **HAI-FX** cloud environment (its setup script
installs Godot, Defold's bob.jar, Java 25 and the tool dependencies before Claude starts), read this
file, and re-arm the watch with ArtifactComments `watch` on the Studio URL. Outside that environment,
`tools/fx.mjs` installs the engines into `.tools/` by itself the first time it needs them.

Before authoring or changing effects, `node tools/fx.mjs catalog` prints every layer type and
parameter (defaults, ranges, units) in ~6 KB. After changing the renderer or exporter, run
`node tools/check.mjs` (all templates + every GPU layer live in both engines, ~2 min; `--fast` skips
the engines). It catches regressions that single-effect checks miss.

## Where things live
- **Studio** (the shared editor): https://claude.ai/artifact/WjGgnbNxE3E2dxoAgT7C7i
  Source: `studio/index.html`. Published with files `fxcore.js`, `fxgpu.js` (from `core/`) and
  `templates.json` (from `studio/`).
  Capabilities: `db`, `assets`, `downloads`, `comments` (Send to Claude), `sample` (Ask Claude).
  Open a given effect with `#<effect-id>`. Layout is built for the narrow side panel: the
  preview stays pinned while controls scroll.
- **Studio database**: ONE collection per effect, `effects/<id>/items`, one document per item.
  Every item has `kind` and `t` (ISO time, updated on every write). Kinds:
  - `version` (doc `v0001`…): `{version, effect, savedBy, message, savedAt, changes}`. The
    newest is current. Versions are only ever created, never overwritten.
  - `note` (doc `n-…`): pinned note `{text, tags, frame, x, y, size, layer, hits, params,
    baseVersion, unsaved, mode, status: open|addressed|dismissed}`. `hits` is the exact
    per-layer share at that pixel; `unsaved` lists edits not yet saved at the time.
  - `ask` (doc `a-…`): an in-page Ask Claude request and what was picked.
  - `proposal` (doc `p0003-…`): a Choice `{title, question, options: [{key, label, effect, facts}],
    status: open|answered|withdrawn, pick: {key, comment, at}}`.
  - `ref` (doc `ref-…`): reference image `{assetId, caption, thumb}`; `thumb` is a 320 px JPEG
    data URL, so references never need separate reads.
  - `draft` (doc `draft`): the artist's unsaved working copy `{baseVersion, effect, changes}`,
    autosaved ~2 s after each edit; `round.mjs` shows it and plans can start from `"base": "draft"`.
  - `reply` (doc `r0001`…): Claude's round summary `{message, notes: {noteId: text}, resolve: [noteIds]}`.
    Notes are answered and resolved through replies (creation only: no version pins needed).
  (Older per-type collections from the first studio versions are no longer read.)
- **Repo mirror**: `fx/<id>/effect.json` holds the latest approved version, committed with the
  version number in the message.
- **Renderer**: `core/fxcore.js` (CPU layers: glow, ring, sparks/debris, smoke, fire) plus
  `core/fxgpu.js` (GPU layers, WebGL2 GLSL: electric, waveform, water, clouds, gears, sprite
  [tint/flash/dissolve], outline [silhouette or contrast edges], shade [lighting from a sprite],
  age [weathering], normals [normal map from a sprite], ripple and reflect [read everything below; blend `replace`], pathlight
  [path-traced light: 2D scene with soft shadows, emissive pixels and one bounce, or 2.5D relief
  with sun, sky occlusion and a point light]). The same files run
  in the Studio and, through `tools/engine.mjs` (headless Chromium), in every tool.
  Canvas flags `loop` and `tile` make GPU layers loop and tile exactly; `summary.loopJump` and
  `summary.tileSeam` measure it (≈1 is seamless). New layer types: add to `fxgpu.js` TYPES (params +
  `vec4 fx(vec2 uv)` returning premultiplied colour), then `node tools/templates.mjs`.
- **Runtime export**: `core/fxexport.js` (shared by the Studio's "Download for Godot + Defold" and
  `node tools/fx.mjs runtime`). GPU layers become live shaders (Godot `.gdshader` on Sprite2D, Defold
  `.fp` + `.material` on sprites), CPU layers baked sheets, one script drives time for all.
- **Effects and templates**: the Studio lists `effects/<id>` index docs and starts new effects from
  `studio/templates.json` (built from `fx/*/effect.json` and `fx/_sprites/*.png` by
  `node tools/templates.mjs`, which also renders every template with checks into `build/templates.png`).
- **Sprites**: items of kind `source` `{sid, name, data: PNG data URL ≤256 px, cols?, rows?, frames?}`
  in the effect's items; layers reference them by `sid`. A sprite with cols/rows is an animated
  sheet whose cell advances with the effect frame. Repo sprites live in `fx/_sprites/`, sheets
  named `name@<cols>x<rows>[f<frames>].png`. Tools get sprites from the same dump.
- **Exports** (`core/fxexport.js`, Studio download and `fx.mjs runtime`): `godot/`, `defold/` and
  `generic/` (one sheet per blend pass + TexturePacker hash JSON + Aseprite JSON + README with draw
  order and blend modes, for any other engine). `fx.mjs render` also writes a GIF preview.
- **Budgets**: `summary.bakedKB` (uncompressed RGBA of the baked passes) and `summary.shaderCost`
  (rough texture/noise lookups per pixel for live shaders; each GPU type has a `cost(params)`).

## A round in ~6 tool calls
1. **Read everything**: ArtifactData `query`, collection `effects/<id>/items`, `limit` 1000,
   `out_dir` `build/dump`.
2. **Inspect**: `node tools/round.mjs inspect build/dump` prints a digest (what changed since
   Claude's last round, picks, asks, every open note with its layer hits, per-layer metrics,
   reference match) and writes `build/round/inspect.png`: frames, before/after, each layer alone,
   each note on the exact frame the artist saw with its pin, references, curves.
3. **Look**: Read `build/round/inspect.png` (one image).
4. **Run a plan**: `node tools/round.mjs run build/dump - <<'EOF' {plan} EOF`. One plan can
   hold hand-made candidates (patches, added/removed layers) and searches (hundreds of
   variants on worker threads, scored against targets from notes and the reference match),
   render `build/round/run.png`, verify a candidate in both engines, mirror the new version to
   `fx/<id>/effect.json`, and write the database documents. Plan format: top of `tools/round.mjs`.
   Read `run.png`; repeat this step only if the result is wrong.
5. **Write**: one ArtifactData `batch` with the `WRITES` array the run printed (version,
   proposal, reply; all are creations).
6. **Close**: commit and push; if the round came from Send to Claude, reply in the comment
   thread (ArtifactComments) and resolve it.

Notes become `targets` (e.g. "smoke dies too fast" → `{"layer":"smoke","metric":"fadeFrame",
"op":">=","value":20}`); a reference becomes `match`. Without references, targets plus a small
penalty for moving away from the current values keep searches close to what the artist has.

## Proposals (Choices)
- Early: 3-4 options that differ a lot (mood, timing, shape). Later: 4-6 options that differ in
  ONE dimension, so a pick is unambiguous.
- Always include the current state as one option when it's a real contender.
- Read `pick.comment` closely; "none of these" with a reason is the most useful answer.

## Commands
```
node tools/fx.mjs render  fx/explosion/effect.json [--mode pixel] [--out exports/explosion]
node tools/fx.mjs metrics fx/explosion/effect.json
node tools/fx.mjs verify  fx/explosion/effect.json [--mode pixel] [--engines godot,defold]
node tools/fx.mjs runtime fx/water/effect.json [--engines godot,defold] [--verify no]   # live shaders + engine check
node tools/fx.mjs catalog        # every layer type + params, compact
node tools/check.mjs [--fast]     # self-check: templates + all GPU layers live in Godot and Defold
node tools/templates.mjs [--only water,gears]   # rebuild studio/templates.json + one review image of all templates
bash tools/setup.sh        # installs Godot, Defold's bob.jar, Java 25 and libs in a fresh container
```
`render` writes per-blend-pass sprite sheets, atlas JSON, metrics, a review sheet, and
drop-in Godot (`.tres` SpriteFrames + `.tscn` + `.gd`) and Defold (`.tilesource` + `.go`) files.
`verify` runs those files inside real headless Godot and Defold builds and compares every frame
with the preview: `contentError` (mean abs error, 0-255) and `timingSlips`.

## Engine facts we've confirmed (see engine_tests/FINDINGS.md)
- Godot 4.7 Compatibility renderer under Xvfb: pixel-exact vs preview (max error 2/255), no
  timing slips. GPUParticles2D with `use_fixed_seed` is deterministic.
- Defold 1.14.1 (needs Java 25): image content exact (max error 2/255), but its flipbook clock
  drifts by one frame for a few frames at 30 fps (frame shown twice, later one skipped).
- Defold `.particlefx`: omitted life curves default to **0**, so write every curve explicitly.
- Defold particles can't be seeded: compare metrics, not pixels, for runtime particles.
- Live shaders match the preview in both engines (mean error < 1/255) for every GPU layer type.
  Rules that made that true; keep them for new layer types:
  - Hash with integers (`h21` in fxgpu LIB). Float hashes like fract(sin(..)) drift between compilers.
  - Wrap noise cells with `wrapc`, never `mod`: mod at exact multiples differs between drivers.
  - Float literals in vector constructors (`vec2(1.0, 0.0)`) and `mat2(vec2, vec2)`: Godot is strict.
  - Read the layers below only through `texture(b_below, …)` inside `fx()` or a macro used there.
  - Defold: sprite textures have v = 0 at the bottom (export flips), and every material sampler must be
    used by the shader or bindings shift (export keeps `texture_sampler` alive via `fx_frame.w`).
  - Godot: below-reading layers sample a transparent SubViewport holding the layers under them; additive
    shaders write rgb/sqrt(m), alpha sqrt(m) so light accumulates as coverage like the preview.
  - Defold has no screen texture without a custom render script: below-reading layers (and everything
    under them) are baked there.
- Mixed blend modes are exported as separate passes (contiguous layers with the same blend),
  drawn in order; additive passes use Add blending. Pixel mode is one palette-locked alpha pass.

## Measurements
`FX.measure(effect)` per frame: brightness (energy), coverage, 90% radius (units, 1 = frame
edge), overdraw, stray pixels (pixel mode). Summary: peak frame, fade frame, max radius, max
coverage, max overdraw. `effect.checks` turn these into pass/fail tests shown in the Studio.
Turn the artist's notes into checks where they're measurable ("dies too fast" -> fadeFrame >= N).
