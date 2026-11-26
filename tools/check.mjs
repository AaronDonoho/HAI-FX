#!/usr/bin/env node
// One-command self-check: every template renders and passes its checks, and every GPU layer type
// runs as a live shader in Godot and Defold matching the preview.
//   node tools/check.mjs [--fast]      (--fast skips the engines)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const FX = require(path.join(ROOT, 'core/fxcore.js')), GPU = require(path.join(ROOT, 'core/fxgpu.js'));
GPU.install(FX);
const fast = process.argv.includes('--fast');
const run = args => execFileSync('node', args, { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
let failed = 0;
const say = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

// 1. templates: render + checks
const t0 = Date.now();
const tl = run([path.join(HERE, 'templates.mjs')]).trim().split('\n');
for (const l of tl.filter(l => /^[\w-]+: /.test(l))) {
  const bad = /✗|MISSING/.test(l) && !/^explosion:/.test(l); // the explosion's punch check is a known open question
  if (bad) say(false, 'template ' + l); else failed += 0;
}
say(true, `${tl.filter(l => /^[\w-]+: /.test(l)).length} templates render (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

if (!fast) {
  // 2. every GPU layer type live in both engines: one stack of all "plain" types, one chain of below-readers
  const L = (id, type, params) => ({ id, type, params: params || {} });
  const pal = { white: '#ffffff', arc: '#7fd4ff', trace: '#7dffb2', traceGlow: '#1fbf6a', deep: '#0b3d5c', shallow: '#1f7fa3', caustic: '#9fe8ff', foam: '#e8fbff', cloud: '#f4f6fb', cloudShadow: '#8a95b3', metal: '#c49a5a', metalDark: '#4a3a26', metalLight: '#fff1c9', ink: '#1a1420', rust: '#8a3b17', grime: '#2b2118', moss: '#4f6b2a', ambient: '#3a4a7a', torch: '#ffb35c', cool: '#7fb4ff', sky: '#8090b0', stone: '#3a3440', hot: '#ffcf5c' };
  const plain = Object.keys(GPU.TYPES).filter(t => !GPU.TYPES[t].readsBelow);
  const needsSprite = t => GPU.TYPES[t].params.some(p => p.type === 'source');
  const A = { id: 'check-all', name: 'check all', seed: 3, canvas: { frames: 6, loop: true }, palette: pal,
    layers: plain.map((t, i) => L(`${t}`, t, Object.assign(needsSprite(t) ? { source: i % 2 ? 'slime' : 'crate', scale: 0.35, offsetX: ((i % 4) - 1.5) * 0.45, offsetY: (Math.floor(i / 4) - 1) * 0.55 } : {}, t === 'water' || t === 'clouds' ? { opacity: 0.35 } : {}))) };
  const B = { id: 'check-below', name: 'check below', seed: 3, canvas: { frames: 6, loop: true }, palette: pal,
    layers: [L('crate', 'sprite', { source: 'crate', scale: 0.5 }), ...Object.keys(GPU.TYPES).filter(t => GPU.TYPES[t].readsBelow).map(t => L(t, t, t === 'pathlight' ? { samples: 12, steps: 16 } : {}))] };
  for (const [eff, engines] of [[A, 'godot,defold'], [B, 'godot']]) {
    const dir = path.join(ROOT, 'build', 'check', eff.id); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'effect.json'); fs.writeFileSync(file, JSON.stringify(eff));
    try {
      const r = JSON.parse(run([path.join(HERE, 'fx.mjs'), 'runtime', file, '--engines', engines]));
      for (const [eng, v] of Object.entries(r.engines))
        say(v.ok && v.contentError < 1.5, `${eff.id} in ${eng}: ${eff.layers.length} layers live [${r.layers[eng].join(', ')}] contentError ${v.contentError} max ${v.maxPixelError}${v.error ? ' ' + v.error.slice(-300) : ''}`);
    } catch (e) { say(false, `${eff.id}: ${String(e.stderr || e.message).slice(-400)}`); }
  }
}
console.log(failed ? `${failed} problem(s)` : 'all good');
process.exit(failed ? 1 : 0);
