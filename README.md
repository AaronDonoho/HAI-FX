# HAI-FX

Layered game effects for Godot and Defold, built collaboratively between a human and Claude.

- `core/fxcore.js`: deterministic effect renderer (glow, ring, sparks, smoke; smooth or pixel art)
- `studio/`: the Studio, a shared web editor with sliders, palettes, pinned notes,
  side-by-side variant picks and version history
- `fx/<effect>/effect.json`: effect documents (the source of truth for each effect)
- `tools/fx.mjs`: render sprite sheets, write Godot/Defold files, measure, and verify inside
  real headless engine builds
- `engine_tests/`: the original headless-engine experiments and findings

See `CLAUDE.md` for the working agreement and data layout.
