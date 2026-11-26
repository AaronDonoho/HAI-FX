# Engine render tests (headless, in a Linux cloud container)

Goal: render real engine output frame-by-frame so effects can be verified in-engine,
not just in the browser preview.

## Godot 4.7 (stable)
- Runs under Xvfb with the Compatibility (OpenGL 3) renderer on software Mesa.
- `capture.gd` saves every frame as RGBA PNG via `RenderingServer.frame_post_draw`;
  `--fixed-fps 30` gives a fixed timestep.
- Transparent background works (`rendering/viewport/transparent_background=true`), so
  alpha is captured directly.
- GPUParticles2D with `use_fixed_seed = true` -> two runs are pixel-identical.
- Shader (canvas_item) + particles: 25 frames at 256x256 in under 1 s.

Run:
    xvfb-run -a -s "-screen 0 1024x768x24" godot --path engine_tests/godot \
      --rendering-driver opengl3 --fixed-fps 30 -- <out_dir>

## Defold 1.14.1
- bob.jar from the GitHub release bundles a Linux engine. Needs Java 25
  (`openjdk-25-jdk-headless`), plus `libglu1-mesa` and `libopenal1` at runtime.
- Hand-written `.particlefx` / `.go` / `.collection` text files build fine.
- Runs under Xvfb with OpenGL. `update_frequency = 30` gives dt = 1/30 exactly.
- `@system: start_record` is not allowed from game scripts. Instead `capture.script`
  grabs the previous frame from the X display with ffmpeg during each update
  (synchronous, so frame N is exact). Takes about 0.7 s/frame, which is fine for now.
- No alpha in the capture: render over black (correct for additive effects), or over
  black and white and difference-matte (only valid when the run is deterministic).
- **Gotcha:** omitted `particle_properties` life color curves default to 0 (black),
  so additive particles render invisible. The exporter must write every curve.
- Particle spawning is not seeded, so runs differ per pixel. Summary metrics
  (energy per frame, 90th percentile radius) agree within about 5% across runs, so
  Defold particle verification should compare metrics, not pixels.

Build + run:
    java25 -jar bob.jar --platform x86_64-linux --variant debug --archive \
      --bundle-output bundle build bundle
    xvfb-run -a -s "-screen 0 256x256x24" bundle/<title>/<title>.x86_64 \
      --config=hai.out=<out_dir> --config=hai.bg=black --config=hai.frames=24
