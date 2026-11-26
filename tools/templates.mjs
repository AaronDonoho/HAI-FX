#!/usr/bin/env node
// Builds studio/templates.json from fx/*/effect.json (+ the sprites they use) and renders every
// template into ONE review image with metrics and seam checks: build/templates.png.
//   node tools/templates.mjs [--only water,gears]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openEngine, sourcesBeside } from './engine.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = require(path.join(ROOT, 'core/fxcore.js'));
const only = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);

const ids = fs.readdirSync(path.join(ROOT, 'fx')).filter(d => !d.startsWith('_') && fs.existsSync(path.join(ROOT, 'fx', d, 'effect.json')));
const templates = [];
for (const id of ids) {
  const file = path.join(ROOT, 'fx', id, 'effect.json');
  const effect = JSON.parse(fs.readFileSync(file, 'utf8'));
  const all = sourcesBeside(file);
  const used = new Set();
  for (const l of effect.layers || []) for (const v of Object.values(l.params || {})) if (typeof v === 'string' && all[v]) used.add(v);
  templates.push({ id, name: effect.name || id, effect, sources: Object.fromEntries([...used].map(k => [k, all[k]])) });
}
fs.writeFileSync(path.join(ROOT, 'studio', 'templates.json'), JSON.stringify(templates));

const E = await openEngine({ pages: 1 });
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let html = '', lines = [];
for (const t of templates) {
  if (only.length && !only.includes(t.id)) continue;
  await E.setSources(t.sources);
  const e = FX.normalizeEffect(t.effect), F = e.canvas.frames, t0 = Date.now();
  const m = await E.call('measure', t.effect);
  const frames = [...new Set(Array.from({ length: 8 }, (_, i) => Math.round((i * (F - 1)) / 7)))];
  const imgs = [];
  for (const f of frames) imgs.push(`<figure><img src="${await E.frameURL(t.effect, f, { bg: '#14121a' })}"><figcaption>f${f}</figcaption></figure>`);
  const s = m.summary, checks = m.checks.map(c => `${c.pass ? '✓' : '✗'} ${c.id}(${c.actual})`).join(' ');
  const miss = (await E.call('renderLayers', t.effect, 0)).missing;
  const line = `${t.id}: ${e.layers.map(l => l.type).join('+')} · peak f${s.peakFrame} fade f${s.fadeFrame}${s.loopJump !== undefined ? ' loopJump ' + s.loopJump : ''}${s.tileSeam !== undefined ? ' tileSeam ' + s.tileSeam : ''} ${checks}${miss.length ? ' MISSING ' + miss.join(',') : ''} (${Date.now() - t0} ms)`;
  lines.push(line);
  html += `<div class="row"><div class="lbl"><b>${esc(t.name)}</b><div class="m">${esc(line.split(': ')[1])}</div></div><div class="strip">${imgs.join('')}</div></div>`;
}
const p = await E.browser.newPage({ viewport: { width: 1400, height: 800 } });
await p.setContent(`<!doctype html><style>body{margin:0;padding:14px;background:#111015;color:#ece9f3;font:13px system-ui;width:1370px}.row{display:flex;gap:12px;margin-bottom:10px}.lbl{width:250px;flex:none}.m{font:11px monospace;color:#bbb;white-space:pre-wrap}.strip{display:flex;gap:4px}figure{margin:0}img{width:128px;height:128px;image-rendering:pixelated;border:1px solid #2d2b37}figcaption{font:10px monospace;color:#888}</style>${html}`);
await p.screenshot({ path: path.join(ROOT, 'build', 'templates.png'), fullPage: true });
await E.close();
console.log(lines.join('\n') + `\nGPU ${E.gpu ? 'yes' : 'NO'} · ${templates.length} templates → studio/templates.json · review build/templates.png`);
