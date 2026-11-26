# HAI-FX: working agreement

Aaron and Claude build game effects (explosions, hits, pickups, magic...) for **Defold and Godot**,
in **smooth HD and pixel art**, by iterating in layers. Aaron hand-tunes and judges; Claude
builds, measures, explains and proposes. Every message between us should point at something
specific: a layer, a parameter, a frame, a pixel, a version. No vague hints, no blind tweaking.

## The loop
1. Claude makes or changes an effect and saves it as a new version in the Studio.
2. Aaron opens the Studio, tweaks sliders and colours, pins notes on frames, answers Choices,
   and saves a version.
3. Aaron presses **Send to Claude** in the Studio (or says so in chat). The button posts an
   artifact comment sent to Claude, which wakes the Claude session watching the Studio.
   Claude reads everything (below), restates what it understood, makes the next version,
   replies on each note, posts Choices where unsure, and replies in the comment thread
   (ArtifactComments `reply`, then `resolve`).
4. When a version is approved: export, verify in both engines, commit.

Quick changes don't need a round: the Studio's **Ask Claude** box calls Claude from the page
(`sample` capability, on Aaron's usage), gets three patches, and shows them in Compare. The
ask and the pick are logged as a note with `kind: "ask"` (status addressed) so rounds see them.

If this session is gone, a new session reads this file, runs `bash tools/setup.sh`, and
re-arms the watch with ArtifactComments `watch` on the Studio URL.

## Where things live
- **Studio** (the shared editor): https://claude.ai/artifact/WjGgnbNxE3E2dxoAgT7C7i
  Source: `studio/index.html`. Published with files `fxcore.js` <- `core/fxcore.js` and
  `<effect>.json` <- `fx/<effect>/effect.json` (the starting point when the database is empty).
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
  - `reply` (doc `r0001`…): Claude's round summary `{message, notes: {noteId: text}, resolve: [noteIds]}`.
    Notes are answered and resolved through replies (creation only: no version pins needed).
  (Older per-type collections from the first studio versions are no longer read.)
- **Repo mirror**: `fx/<id>/effect.json` holds the latest approved version, committed with the
  version number in the message.
- **Renderer**: `core/fxcore.js`, one file used by the Studio and the tools, so preview and
  exports come from identical code. Pure JS, deterministic per seed. Layer types: glow, ring,
  sparks (also used for fine debris), smoke, fire (heat-ramp plumes: core/hot/mid/cool/edge).

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
- Mixed blend modes are exported as separate passes (contiguous layers with the same blend),
  drawn in order; additive passes use Add blending. Pixel mode is one palette-locked alpha pass.

## Measurements
`FX.measure(effect)` per frame: brightness (energy), coverage, 90% radius (units, 1 = frame
edge), overdraw, stray pixels (pixel mode). Summary: peak frame, fade frame, max radius, max
coverage, max overdraw. `effect.checks` turn these into pass/fail tests shown in the Studio.
Turn Aaron's notes into checks where they're measurable ("dies too fast" -> fadeFrame >= N).
