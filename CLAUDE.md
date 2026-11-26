# HAI-FX: working agreement

Aaron and Claude build game effects (explosions, hits, pickups, magic...) for **Defold and Godot**,
in **smooth HD and pixel art**, by iterating in layers. Aaron hand-tunes and judges; Claude
builds, measures, explains and proposes. Every message between us should point at something
specific: a layer, a parameter, a frame, a pixel, a version. No vague hints, no blind tweaking.

## The loop
1. Claude makes or changes an effect and saves it as a new version in the Studio.
2. Aaron opens the Studio, tweaks sliders and colours, pins notes on frames, answers Choices,
   and saves a version.
3. Aaron says so in chat. Claude reads everything (below), restates what it understood,
   makes the next version, replies on each note, and posts Choices where unsure.
4. When a version is approved: export, verify in both engines, commit.

## Where things live
- **Studio** (the shared editor): https://claude.ai/artifact/WjGgnbNxE3E2dxoAgT7C7i
  Source: `studio/index.html`. Published with files `fxcore.js` <- `core/fxcore.js` and
  `<effect>.json` <- `fx/<effect>/effect.json` (the starting point when the database is empty).
  Capabilities: `db`, `assets`, `downloads`. Open a given effect with `#<effect-id>`.
- **Studio database** (read/write with the ArtifactData tool, artifact URL above):
  - `effects/<id>`: current saved version `{effect, version, savedBy, message, savedAt, changes}`
  - `effects/<id>/versions/v0001...`: every saved version (same shape)
  - `effects/<id>/notes/*`: pinned notes `{text, tags, frame, x, y, size, layer, hits, params,
    baseVersion, unsaved, status: open|addressed|dismissed, reply, author}`. `hits` is the exact
    per-layer share of what was drawn at that pixel. `unsaved` lists edits not yet saved when the
    note was written. Answer a note by setting `reply` and `status: "addressed"`.
  - `effects/<id>/proposals/*`: Choices `{title, question, baseVersion, options: [{key, label,
    patch | effect}], status: open|answered, pick: {key, comment}}`. A patch is
    `{"<layerId>.<param>": value, "palette.<slot>": "#hex", "canvas.<key>": v, "seed": n}`.
  - `effects/<id>/refs/*`: reference images `{assetId, name, caption}`; image at `/_blob/<assetId>`
    (read with the Artifact tool's `path` = assetId).
- **Repo mirror**: `fx/<id>/effect.json` holds the latest approved version, committed with the
  version number in the message.
- **Renderer**: `core/fxcore.js`, one file used by the Studio and the tools, so preview and
  exports come from identical code. Pure JS, deterministic per seed.

## Writing a new version (Claude)
Write `effects/<id>/versions/v000N` and `effects/<id>` together in one ArtifactData batch, with
`savedBy: "claude"`, a one-line `message` saying what changed and why, and `changes` from
`FX.diff(prev, next)`. Pin `if_version` on the main doc. Never overwrite a version Aaron saved.

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
