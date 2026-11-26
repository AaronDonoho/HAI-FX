#!/usr/bin/env node
// HAI-FX command line.
//
//   node tools/fx.mjs render  fx/explosion/effect.json [--mode pixel|smooth] [--out build/explosion]
//   node tools/fx.mjs verify  fx/explosion/effect.json [--engines godot,defold]
//   node tools/fx.mjs metrics fx/explosion/effect.json
//
// render: sprite sheets per blend pass, atlas JSON, metrics, a contact sheet for review,
//         and ready-to-drop Godot (.tres/.tscn) and Defold (.tilesource/.go) files.
// verify: renders the exported files inside real Godot and Defold builds (headless,
//         virtual display), captures every frame, and compares against the preview.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { openEngine, sourcesBeside, sourcesInDir } from './engine.mjs';
import { exportRuntime } from './runtime.mjs';

const { PNG } = pngjs;
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = require(path.join(ROOT, 'core/fxcore.js'));
require(path.join(ROOT, 'core/fxgpu.js')).install(FX);

// Engines live in <repo>/.tools (installed by tools/setup.sh, which runs automatically if they are missing).
const pick = (...c) => c.find(p => p && fs.existsSync(p)) || c[0];
const TOOLS = {
  godot: pick(process.env.GODOT, path.join(ROOT, '.tools/godot'), '/home/user/tools/godot'),
  bob: pick(process.env.BOB, path.join(ROOT, '.tools/bob.jar'), '/home/user/tools/bob.jar'),
  java: process.env.JAVA25 || '/usr/lib/jvm/java-25-openjdk-amd64/bin/java',
};
function ensureEngines() {
  if (fs.existsSync(TOOLS.godot) && fs.existsSync(TOOLS.bob) && fs.existsSync(TOOLS.java)) return;
  execSync(`bash ${path.join(ROOT, 'tools/setup.sh')}`, { stdio: 'inherit' });
  TOOLS.godot = path.join(ROOT, '.tools/godot'); TOOLS.bob = path.join(ROOT, '.tools/bob.jar');
}

// ------------------------------------------------------------------ helpers
function args() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1], i++;
  return { cmd, file, opts };
}
function loadEffect(file, opts) {
  const e = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (opts.mode) e.canvas = Object.assign({}, e.canvas, { mode: opts.mode });
  return e;
}
function writePng(file, w, h, rgba) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba.buffer ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba);
  fs.writeFileSync(file, PNG.sync.write(png));
}
function readPng(file) {
  const p = PNG.sync.read(fs.readFileSync(file));
  return { w: p.width, h: p.height, data: p.data };
}
function sheetLayout(n) {
  const cols = Math.min(n, 8);
  return { cols, rows: Math.ceil(n / cols) };
}
function packSheet(frames, size) {
  const { cols, rows } = sheetLayout(frames.length);
  const W = cols * size, H = rows * size, out = new Uint8Array(W * H * 4);
  frames.forEach((img, f) => {
    const ox = (f % cols) * size, oy = Math.floor(f / cols) * size;
    for (let y = 0; y < size; y++) out.set(img.subarray(y * size * 4, (y + 1) * size * 4), ((oy + y) * W + ox) * 4);
  });
  return { W, H, cols, rows, data: out };
}
const sh = (cmd, o = {}) => String(execSync(cmd, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }, o)) || '');

// ------------------------------------------------------------------- render
let E = null;
async function render(effect, outDir) {
  const e = FX.normalizeEffect(effect);
  const id = e.id || 'effect';
  fs.mkdirSync(outDir, { recursive: true });
  const ex = await E.call('exportPasses', e);
  const S = ex.size, pixel = e.canvas.mode === 'pixel';
  const atlas = { meta: { effect: id, size: S, fps: ex.fps, frames: ex.frameCount, mode: e.canvas.mode, generator: 'hai-fx' }, passes: [] };

  for (const pass of ex.passes) {
    const sheet = packSheet(pass.frames, S);
    const file = `${id}_${pass.name}.png`;
    writePng(path.join(outDir, file), sheet.W, sheet.H, sheet.data);
    atlas.passes.push({
      name: pass.name, blend: pass.blend, layers: pass.layers, image: file, columns: sheet.cols, rows: sheet.rows,
      frames: pass.frames.map((_, f) => ({ x: (f % sheet.cols) * S, y: Math.floor(f / sheet.cols) * S, w: S, h: S, duration: 1 / ex.fps })),
    });
  }
  fs.writeFileSync(path.join(outDir, `${id}.atlas.json`), JSON.stringify(atlas, null, 2));

  // Review sheet: every frame over the studio's dark background, with frame numbers in the filename order.
  const prev = [];
  for (let f = 0; f < e.canvas.frames; f++) prev.push((await E.call('renderFrame', e, f, { bg: '#14121a' })).data);
  const ps = packSheet(prev, S);
  writePng(path.join(outDir, `${id}_review.png`), ps.W, ps.H, ps.data);

  // shareable GIF preview over the Studio background
  try {
    const gdir = path.join(outDir, '_gif'); fs.rmSync(gdir, { recursive: true, force: true }); fs.mkdirSync(gdir, { recursive: true });
    prev.forEach((img, f) => writePng(path.join(gdir, `f_${String(f).padStart(3, '0')}.png`), S, S, img));
    sh(`ffmpeg -loglevel error -y -framerate ${e.canvas.fps} -i ${gdir}/f_%03d.png -vf "scale=${S * 2}:${S * 2}:flags=neighbor,split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" ${e.canvas.loop ? '-loop 0' : '-loop -1'} ${path.join(outDir, `${id}_preview.gif`)}`);
    fs.rmSync(gdir, { recursive: true, force: true });
  } catch (err) { /* ffmpeg missing: skip the GIF */ }
  const metrics = await E.call('measure', e);
  fs.writeFileSync(path.join(outDir, `${id}.metrics.json`), JSON.stringify(metrics, null, 2));

  exportGodot(e, atlas, outDir, pixel);
  exportDefold(e, atlas, outDir, pixel);
  return { atlas, metrics };
}

// ------------------------------------------------------------- Godot export
function exportGodot(e, atlas, outDir, pixel, resDir) {
  const id = e.id || 'effect';
  resDir = resDir || `res://fx/${id}`;
  const dir = path.join(outDir, 'godot');
  fs.mkdirSync(dir, { recursive: true });
  const nodes = [];
  atlas.passes.forEach((pass, pi) => {
    fs.copyFileSync(path.join(outDir, pass.image), path.join(dir, pass.image));
    const subs = pass.frames.map((fr, f) =>
      `[sub_resource type="AtlasTexture" id="f${f}"]\natlas = ExtResource("1")\nregion = Rect2(${fr.x}, ${fr.y}, ${fr.w}, ${fr.h})\n`).join('\n');
    const frames = pass.frames.map((_, f) => `{\n"duration": 1.0,\n"texture": SubResource("f${f}")\n}`).join(', ');
    const tres = `[gd_resource type="SpriteFrames" load_steps=${pass.frames.length + 2} format=3]

[ext_resource type="Texture2D" path="${resDir}/${pass.image}" id="1"]

${subs}
[resource]
animations = [{
"frames": [${frames}],
"loop": false,
"name": &"default",
"speed": ${atlas.meta.fps}.0
}]
`;
    const tresName = `${id}_${pass.name}.tres`;
    fs.writeFileSync(path.join(dir, tresName), tres);
    nodes.push({ pi, pass, tresName });
  });
  const ext = nodes.map((n, i) => `[ext_resource type="SpriteFrames" path="${resDir}/${n.tresName}" id="${i + 2}"]`).join('\n');
  const mats = nodes.filter(n => n.pass.blend === 'add').map(n => `[sub_resource type="CanvasItemMaterial" id="add${n.pi}"]\nblend_mode = 1\n`).join('\n');
  const body = nodes.map((n, i) => `[node name="${n.pass.name}" type="AnimatedSprite2D" parent="."]
${n.pass.blend === 'add' ? `material = SubResource("add${n.pi}")\n` : ''}${pixel ? 'texture_filter = 1\n' : ''}sprite_frames = ExtResource("${i + 2}")
autoplay = "default"
`).join('\n');
  const script = `extends Node2D
## ${e.name || id}: generated by HAI-FX. Call play() to restart every pass in sync.
signal finished

func play() -> void:
\tfor c in get_children():
\t\tif c is AnimatedSprite2D:
\t\t\tc.stop()
\t\t\tc.frame = 0
\t\t\tc.play(&"default")

func _ready() -> void:
\tvar first := get_child(0) as AnimatedSprite2D
\tif first:
\t\tfirst.animation_finished.connect(func(): finished.emit())
`;
  fs.writeFileSync(path.join(dir, `${id}.gd`), script);
  const tscn = `[gd_scene load_steps=${nodes.length + 2 + (mats ? nodes.filter(n => n.pass.blend === 'add').length : 0)} format=3]

[ext_resource type="Script" path="${resDir}/${id}.gd" id="1"]
${ext}

${mats}
[node name="${(e.name || id).replace(/[^A-Za-z0-9_]/g, '')}" type="Node2D"]
script = ExtResource("1")

${body}`;
  fs.writeFileSync(path.join(dir, `${id}.tscn`), tscn);
}

// ------------------------------------------------------------ Defold export
function exportDefold(e, atlas, outDir, pixel, projDir) {
  const id = e.id || 'effect';
  projDir = projDir || `/fx/${id}`;
  const dir = path.join(outDir, 'defold');
  fs.mkdirSync(dir, { recursive: true });
  const comps = [];
  atlas.passes.forEach((pass, pi) => {
    fs.copyFileSync(path.join(outDir, pass.image), path.join(dir, pass.image));
    const anim = `${id}_${pass.name}`;
    fs.writeFileSync(path.join(dir, `${anim}.tilesource`), `image: "${projDir}/${pass.image}"
tile_width: ${atlas.meta.size}
tile_height: ${atlas.meta.size}
tile_margin: 0
tile_spacing: 0
collision: ""
material_tag: "tile"
collision_groups: "default"
animations {
  id: "${anim}"
  start_tile: 1
  end_tile: ${pass.frames.length}
  playback: PLAYBACK_ONCE_FORWARD
  fps: ${atlas.meta.fps}
  flip_horizontal: 0
  flip_vertical: 0
}
extrude_borders: 0
inner_padding: 0
`);
    const data = [
      `default_animation: "${anim}"`,
      `material: "/builtins/materials/sprite.material"`,
      `blend_mode: ${pass.blend === 'add' ? 'BLEND_MODE_ADD' : 'BLEND_MODE_ALPHA'}`,
      `textures {`, `  sampler: "texture_sampler"`, `  texture: "${projDir}/${anim}.tilesource"`, `}`, ``,
    ].join('\n');
    comps.push(`embedded_components {
  id: "${pass.name}"
  type: "sprite"
  data: ${JSON.stringify(data)}
  position { x: 0.0 y: 0.0 z: ${(pi * 0.001).toFixed(3)} }
}
`);
  });
  fs.writeFileSync(path.join(dir, `${id}.go`), comps.join(''));
  fs.writeFileSync(path.join(dir, `README.txt`), `Copy this folder to ${projDir}/ in your Defold project and add ${id}.go to a collection.
Each pass is a sprite; additive passes use BLEND_MODE_ADD. Restart with sprite.play_flipbook()
on every pass (same frame) to replay in sync.${pixel ? '\nPixel mode: set graphics.default_texture_min_filter / mag_filter to nearest in game.project.' : ''}
`);
}

// ------------------------------------------------------------------- verify
function verifyGodot(e, outDir, work) {
  ensureEngines();
  const id = e.id || 'effect', S = e.canvas.mode === 'pixel' ? e.canvas.pixelSize : e.canvas.size;
  const V = Math.max(S, 128); // Godot enforces a minimum window size; render larger and crop the centre.
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'fx', id), { recursive: true });
  for (const f of fs.readdirSync(path.join(outDir, 'godot'))) fs.copyFileSync(path.join(outDir, 'godot', f), path.join(work, 'fx', id, f));
  fs.writeFileSync(path.join(work, 'project.godot'), `config_version=5

[application]
config/name="hai_fx_verify"
run/main_scene="res://main.tscn"

[display]
window/size/viewport_width=${V}
window/size/viewport_height=${V}

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
environment/defaults/default_clear_color=Color(0, 0, 0, 1)
`);
  fs.writeFileSync(path.join(work, 'capture.gd'), `extends Node
var i := 0
var frames := ${e.canvas.frames + 3}
func _ready():
\tRenderingServer.frame_post_draw.connect(_grab)
func _grab():
\tvar out := OS.get_cmdline_user_args()[0]
\tDirAccess.make_dir_recursive_absolute(out)
\tget_viewport().get_texture().get_image().save_png("%s/f_%03d.png" % [out, i])
\ti += 1
\tif i >= frames:
\t\tget_tree().quit()
`);
  fs.writeFileSync(path.join(work, 'main.tscn'), `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://capture.gd" id="1"]
[ext_resource type="PackedScene" path="res://fx/${id}/${id}.tscn" id="2"]

[node name="Main" type="Node2D"]

[node name="Capture" type="Node" parent="."]
script = ExtResource("1")

[node name="FX" parent="." instance=ExtResource("2")]
position = Vector2(${V / 2}, ${V / 2})
`);
  const cap = path.join(work, 'frames');
  sh(`timeout 120 ${TOOLS.godot} --headless --path ${work} --import`, { stdio: 'ignore' });
  sh(`timeout 120 xvfb-run -a -s "-screen 0 1024x768x24" ${TOOLS.godot} --path ${work} --rendering-driver opengl3 --fixed-fps ${e.canvas.fps} -- ${cap}`);
  cropCaptures(cap, S);
  return cap;
}

function verifyDefold(e, outDir, work) {
  ensureEngines();
  const id = e.id || 'effect', S = e.canvas.mode === 'pixel' ? e.canvas.pixelSize : e.canvas.size;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'fx', id), { recursive: true });
  fs.mkdirSync(path.join(work, 'main'), { recursive: true });
  for (const f of fs.readdirSync(path.join(outDir, 'defold'))) fs.copyFileSync(path.join(outDir, 'defold', f), path.join(work, 'fx', id, f));
  const pixel = e.canvas.mode === 'pixel';
  fs.writeFileSync(path.join(work, 'game.project'), `[project]
title = hai_fx_verify

[bootstrap]
main_collection = /main/main.collectionc

[display]
width = ${S}
height = ${S}
high_dpi = 0
vsync = 0
update_frequency = ${e.canvas.fps}

[input]
game_binding = /builtins/input/all.input_bindingc
${pixel ? `
[graphics]
default_texture_min_filter = nearest
default_texture_mag_filter = nearest
` : ''}`);
  fs.writeFileSync(path.join(work, 'main', 'capture.script'), `local FRAMES = ${e.canvas.frames + 3}
function init(self)
\tself.n = 0
\tself.out = sys.get_config_string("hai.out", "/tmp/defold_frames")
\tmsg.post("@render:", "clear_color", { color = vmath.vector4(0, 0, 0, 1) })
\tos.execute("mkdir -p " .. self.out)
end
function update(self, dt)
\tself.n = self.n + 1
\tif self.n >= 2 then
\t\tlocal f = string.format("%s/f_%03d.png", self.out, self.n - 2)
\t\tos.execute("ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -video_size ${S}x${S} -i " .. os.getenv("DISPLAY") .. " -frames:v 1 " .. f)
\tend
\tif self.n > FRAMES then msg.post("@system:", "exit", { code = 0 }) end
end
`);
  fs.writeFileSync(path.join(work, 'main', 'main.collection'), `name: "main"
scale_along_z: 0
instances {
  id: "fx"
  prototype: "/fx/${id}/${id}.go"
  position { x: ${S / 2}.0 y: ${S / 2}.0 z: 0.0 }
}
embedded_instances {
  id: "capture"
  data: "components {\\n  id: \\"script\\"\\n  component: \\"/main/capture.script\\"\\n}\\n"
}
`);
  sh(`cd ${work} && ${TOOLS.java} -jar ${TOOLS.bob} --platform x86_64-linux --variant debug --archive --bundle-output bundle build bundle`);
  const cap = path.join(work, 'frames');
  sh(`cd ${work}/bundle/hai_fx_verify && timeout 300 xvfb-run -a -s "-screen 0 ${S}x${S}x24" ./hai_fx_verify.x86_64 --config=hai.out=${cap}`);
  return cap;
}

// Crop every capture to the centred S x S region the effect occupies.
function cropCaptures(dir, S) {
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.png'))) {
    const im = readPng(path.join(dir, f));
    if (im.w === S && im.h === S) continue;
    const ox = Math.floor((im.w - S) / 2), oy = Math.floor((im.h - S) / 2), out = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) out.set(im.data.subarray(((oy + y) * im.w + ox) * 4, ((oy + y) * im.w + ox + S) * 4), y * S * 4);
    writePng(path.join(dir, f), S, S, out);
  }
}

// Compare captured engine frames with the preview over black.
// Two separate questions: does each frame LOOK right (content error against the preview
// frame it shows), and is the right frame shown at the right time (timing slips)?
async function compare(e, capDir) {
  const F = e.canvas.frames;
  const ref = [];
  for (let f = 0; f < F; f++) ref.push((await E.call('renderFrame', e, f, { bg: [0, 0, 0] })).data);
  const caps = fs.readdirSync(capDir).filter(f => f.endsWith('.png')).sort().map(f => readPng(path.join(capDir, f)));
  const err = (a, b) => {
    let s = 0, mx = 0;
    for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); s += d; if (d > mx) mx = d; }
    return { mae: s / (a.length * 0.75), max: mx };
  };
  // Global start offset: the engine may show frame 0 one update early or late.
  let offset = 0, bestMean = Infinity;
  for (let off = -2; off <= 2; off++) {
    let s = 0, n = 0;
    for (let f = 0; f < F; f++) if (caps[f + off]) { s += err(ref[f], caps[f + off].data).mae; n++; }
    if (n >= F - 2 && s / n < bestMean) { bestMean = s / n; offset = off; }
  }
  const rows = [], slips = [];
  for (let f = 0; f < F; f++) {
    const c = caps[f + offset];
    if (!c) continue;
    let shown = f, best = err(ref[f], c.data);
    for (let g = Math.max(0, f - 2); g <= Math.min(F - 1, f + 2); g++) {
      if (g === f) continue;
      const r = err(ref[g], c.data);
      if (r.mae < best.mae * 0.5 && r.mae < 1) { best = r; shown = g; }
    }
    if (shown !== f) slips.push({ time: f, shows: shown });
    rows.push({ frame: f, shows: shown, mae: +best.mae.toFixed(2), max: best.max });
  }
  const mean = rows.reduce((s, r) => s + r.mae, 0) / rows.length;
  return { offset, mean, rows, slips };
}

async function verify(effect, opts) {
  const e = FX.normalizeEffect(effect);
  const id = e.id || 'effect';
  const outDir = path.join(ROOT, 'build', id + (e.canvas.mode === 'pixel' ? '_pixel' : ''));
  await render(effect, outDir);
  const engines = (opts.engines || 'godot,defold').split(',');
  const report = { effect: id, mode: e.canvas.mode, engines: {} };
  for (const eng of engines) {
    const work = path.join(ROOT, 'build', 'verify', `${eng}_${id}_${e.canvas.mode}`);
    const t0 = Date.now();
    try {
      const cap = eng === 'godot' ? verifyGodot(e, outDir, work) : verifyDefold(e, outDir, work);
      const cmp = await compare(e, cap);
      report.engines[eng] = {
        ok: !!cmp, seconds: +((Date.now() - t0) / 1000).toFixed(1), frameOffset: cmp && cmp.offset, timingSlips: cmp && cmp.slips, maxPixelError: cmp && Math.max(...cmp.rows.map(r => r.max)),
        contentError: cmp && +cmp.mean.toFixed(2),
        captures: cap,
      };
    } catch (err) {
      report.engines[eng] = { ok: false, error: String(err.stderr || err.message).slice(-1500) };
    }
  }
  fs.writeFileSync(path.join(outDir, `${id}.verify.json`), JSON.stringify(report, null, 2));
  return report;
}

// --------------------------------------------------------------------- main
const { cmd, file, opts } = args();
if (cmd === 'catalog') { console.log(FX.catalog()); process.exit(0); }
if (!cmd || !file) {
  console.log('usage: fx.mjs render|verify|metrics <effect.json> [--mode pixel|smooth] [--out dir] [--engines godot,defold]');
  process.exit(1);
}
const effect = loadEffect(file, opts);
(async () => {
  E = await openEngine({ pages: 1 });
  const srcs = sourcesBeside(file);
  if (opts.sources) Object.assign(srcs, sourcesInDir(opts.sources));
  await E.setSources(srcs);
  if (cmd === 'render') {
    const e = FX.normalizeEffect(effect);
    const out = opts.out || path.join(ROOT, 'build', (e.id || 'effect') + (e.canvas.mode === 'pixel' ? '_pixel' : ''));
    const t0 = Date.now();
    const { atlas, metrics } = await render(effect, out);
    console.log(JSON.stringify({ out, ms: Date.now() - t0, passes: atlas.passes.map(p => p.image), summary: metrics.summary, checks: metrics.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.label} (${c.actual})`) }, null, 2));
  } else if (cmd === 'catalog') {
    console.log(FX.catalog());
  } else if (cmd === 'metrics') {
    console.log(JSON.stringify(await E.call('measure', effect), null, 2));
  } else if (cmd === 'verify') {
    console.log(JSON.stringify(await verify(effect, opts), null, 2));
  } else if (cmd === 'runtime') {
    // live shaders + baked passes for both engines, then rendered inside each engine and compared
    const e = FX.normalizeEffect(effect), id = e.id || 'effect';
    const out = opts.out || path.join(ROOT, 'build', id + '_runtime');
    E.__sources = srcs;
    const layers = await exportRuntime(E, effect, out, srcs);
    const report = { effect: id, layers, out, engines: {} };
    if (opts.verify !== 'no') for (const eng of (opts.engines || 'godot,defold').split(',')) {
      const work = path.join(ROOT, 'build', 'verify', `${eng}_${id}_runtime`), t0 = Date.now();
      try {
        const cap = eng === 'godot' ? verifyGodot(e, out, work) : verifyDefold(e, out, work);
        const cmp = await compare(e, cap);
        report.engines[eng] = { ok: !!cmp, seconds: +((Date.now() - t0) / 1000).toFixed(1), frameOffset: cmp && cmp.offset, contentError: cmp && +cmp.mean.toFixed(2), maxPixelError: cmp && Math.max(...cmp.rows.map(r => r.max)), timingSlips: cmp && cmp.slips.length, worst: cmp && cmp.rows.reduce((a, b) => (b.mae > a.mae ? b : a)) };
      } catch (err) { report.engines[eng] = { ok: false, error: String(err.stderr || err.message).slice(-2500) }; }
    }
    console.log(JSON.stringify(report, null, 2));
  }
  await E.close();
})().catch(async e => { console.error(e.stack || e); if (E) await E.close(); process.exit(1); });
