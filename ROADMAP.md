# HAI-FX roadmap

## What exists today
- **CPU layers** (pure JS, deterministic): glow, ring, sparks/debris, smoke, fire (with connected mass).
- **Modes**: smooth HD and palette-locked pixel art.
- **Output**: flipbook sprite sheets per blend pass, drop-in Godot and Defold files, verified frame by
  frame inside real headless Godot 4.7 and Defold 1.14.1 builds.
- **Collaboration**: Studio (sliders, palettes, pinned notes, Choices, Ask Claude, Send to Claude,
  drafts, references), rounds in ~6 tool calls, per-layer metrics, reference matching, parallel search.
- **Confirmed available**: WebGL2 in headless Chromium (software GPU; a 64-octave noise shader renders
  20 frames at 256 px in 90 ms), Godot canvas_item shaders and Defold materials compile headlessly.

## What the new effects need
| Effect family | Needs | Best delivered as |
|---|---|---|
| Electricity, lightning, arcs | branching bolt generator, glow, flicker timing | flipbook or runtime shader |
| Interlocked rotating gears, chains, belts, clocks | exact geometry and kinematics: tooth profiles, mesh ratios, phase so teeth interlock, loop length = full repeat period | seamless loop flipbook; shaded by lighting |
| Water surfaces, lava, energy fields | animated noise fields, flow, caustics, tiling in space and time | tileable loop or runtime shader |
| Ripples, shockwave distortion, heat haze | displacement of whatever is behind | runtime shader (needs the scene), or baked on a given sprite |
| Reflections | mirrored, rippled, faded copy of a sprite or scene | runtime shader, or baked from an input sprite |
| Clouds, fog, smoke banks | volumetric noise, self-shadowing, wind drift | tileable loop or runtime shader |
| Lighting and shading by path tracing | height/normal maps from sprites; 2D global illumination (soft shadows, bounce light, colour bleeding from emissive layers) | baked into sprites or lightmaps (offline, GPU) |
| Borders along areas of contrast | edge detection on an input sprite, then stroke, glow or ink lines | baked, or runtime outline shader |
| Waveforms | audio-style, sine stacks, heartbeat/ECG, oscilloscope traces with glow and trails | flipbook or runtime shader |
| Aged materials | weathering driven by edges and exposure: rust, grime in crevices, chips, cracks, moss, fading | baked onto input sprites or tileable materials |

Other common sprite tasks the same pieces should cover:
- **Status and feedback:** hit flash, damage tint, dissolve and teleport, freeze, burn and poison overlays, shields with rim light.
- **Motion:** trails and smears, impact frames, dust puffs, footstep splashes, recoil.
- **Ambient:** rain, snow, leaves, grass and foliage sway, flags and cloth, god rays, lens flares, fireflies.
- **Pickups and UI:** coin spins, sparkle glints, shine sweeps, bar fills, magic circles and portals.
- **Sprite processing:** drop shadows, normal-map generation, palette swaps and cycling, decals (scorch marks, blood), fracture.
- **Pixel art:** rotation, scaling and clean-up of hand-made sprites.

## Architecture changes
1. **GPU layer track.** Layers written once in a portable GLSL subset, run as WebGL2 in the Studio and the
   tools, and compiled to Godot `.gdshader` and Defold `.fp` + `.material` for runtime use. The existing
   engine harness verifies them like flipbooks. Unlocks water, ripples, clouds, glows, outlines and lighting.
2. **Input sprites and image operations.** The artist's own sprites and tiles become sources. Layers can
   read other layers (outline *of* a sprite, reflection *of* the stack, light *using* normals from a
   height map), so the layer stack becomes a small graph.
3. **Output kinds** per effect: one-shot flipbook, seamless loop, tileable texture, processed static
   sprite, runtime shader with exposed parameters, normal/height maps. Each kind gets automatic checks
   (loop seam error, tile seam error, gear interference, palette adherence).
4. **Mechanisms.** Exact 2D kinematics (gears, chains, linkages) with loop-period solving, shaded by the
   lighting track.
5. **Light transport.** Progressive GPU path tracing in 2D (emitters and occluders) and on height fields,
   baked to sprites or lightmaps. Runs offline; quality is set by sample count.

The Studio, rounds, metrics, matching and search carry over unchanged: new layer types bring their own
parameters, metrics and checks.

## Status
- Done: GPU layer track (WebGL2, shared by Studio and tools), sprite inputs, layers that read the
  composite below, seamless loop/tile flags with seam metrics, multi-effect Studio with templates, and
  first generators: electricity, waveform, water, clouds, gears, sprite status effects, outline,
  lighting from sprites, weathering, ripple, reflection. Baked sprite-sheet export works for all of them.
- Done: runtime shader export (Godot `.gdshader`, Defold `.fp`/`.material`) with frame-by-frame engine
  verification for every GPU layer type; path-traced lighting (2D scene and 2.5D relief); engine-ready
  download from the Studio.
- Done: HAI-FX cloud environment with engines preinstalled; `check.mjs` self-check; `catalog`;
  animated sprite sheets as inputs; normal-map layer; generic export (TexturePacker/Aseprite JSON);
  GIF and WebM previews; bake-size and shader-cost budgets; side-by-side version comparison.
- Done: Area on every layer, gradient, circle wrap, custom shader layers written by in-page Claude,
  palette cycling (sprite colours, frozen layers below, generated patterns; one still + ramp at runtime).
- Next candidates: Defold render-target support so below-reading layers run live there too; normal-map
  and light-map export for engine lighting; more mechanisms (chains, belts, linkages).

## Proposed order
1. GPU layer track + runtime shader export, proven end to end on one effect in both engines.
2. Input sprites + image operations: outline on contrast, normal maps and lighting, reflections, aging.
3. Loops and tiling with seam checks: water, clouds, materials.
4. Gears and other mechanisms.
5. Path-traced lighting bake.
6. The long tail of generators (electricity, waveforms, weather, trails, magic), each added as a layer
   type on top of the above.
