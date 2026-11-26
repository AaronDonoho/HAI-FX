#!/usr/bin/env node
// HAI-FX rounds: few tool calls, each doing a lot.
//
//   node tools/round.mjs inspect <dump> [--effect explosion]
//   node tools/round.mjs run     <dump> <plan.json | -> [--effect explosion]     (plan on stdin with -)
//
// <dump> is an ArtifactData out_dir holding <dump>/effects/<id>/items/<docId>.json: the whole
// effect (versions, notes, asks, proposals, refs with thumbnails, replies) from ONE query.
//
// inspect: prints a compact digest of everything new since Claude's last round and writes ONE
//          review image (build/round/inspect.png): current frames, before/after, each layer
//          alone, every open note on its exact frame with its pin, references and match scores.
// run:     executes a plan (below), writes ONE review image (build/round/run.png), prints a
//          table, and writes the database documents for one ArtifactData batch.
//
// Plan (all keys optional except candidates):
// {
//   "base": "current" | <version number>,
//   "frames": [1,3,5,8,11,14,18,22],                     // frames shown in the review
//   "targets": [{"metric":"fadeFrame","layer":"smoke","op":">=","value":20,"weight":1}],
//   "match": {"refs": "all" | ["<refItemId>"], "weight": 1, "aspects": {"colour":1,"volume":1,"shape":1,"debris":1}},
//   "candidates": [
//     {"key":"A","label":"Current"},
//     {"key":"B","label":"…","patch":{"fire.heat":1.4,"palette.hot":"#ffd040"}},
//     {"key":"C","label":"…","from":"B","addLayers":[{"id":"jets","type":"sparks","params":{}}],"removeLayers":["ring"]},
//     {"key":"D","label":"…","search":{"from":"B","vary":{"fire.heat":[1.1,1.6]},"samples":160}}
//   ],
//   "sweep": {"from":"B","vary":{…},"samples":200,"keep":3,"label":"Search"},   // adds `keep` diverse candidates
//   "verify": "B",                                          // render in real Godot + Defold
//   "write": {
//     "version":  {"from":"B","message":"…"},               // new version (repo mirror updated too)
//     "proposal": {"title":"…","question":"…","options":["A","B","D"]},
//     "reply":    {"message":"round summary","notes":{"<noteId>":"reply"},"resolve":["<noteId>"]}
//   }
// }
// Targets read whole-effect or per-layer summaries: peakFrame, startFrame, fadeFrame, peakEnergy,
// maxRadius, maxCoverage (+ maxOverdraw, orphanPixels for the whole effect). Ops: >= <= ==.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FX = require(path.join(ROOT, 'core/fxcore.js'));
const OUT = path.join(ROOT, 'build', 'round');

// ---------------------------------------------------------------- scoring
const SCALE = { peakFrame: 3, startFrame: 3, fadeFrame: 3, peakEnergy: 400, maxRadius: 0.12, maxCoverage: 0.06, maxOverdraw: 0.8, orphanPixels: 40 };
function violation(t, v) {
  if (v === undefined || v === null) return 1;
  const s = SCALE[t.metric] || 1;
  if (t.op === '>=' || t.op === '>') return Math.max(0, t.value - v) / s;
  if (t.op === '<=' || t.op === '<') return Math.max(0, v - t.value) / s;
  return Math.abs(v - t.value) / s;
}
function lowres(effect) {
  const e = FX.normalizeEffect(effect);
  if (e.canvas.mode !== 'pixel') e.canvas.size = 64;
  return e;
}
// Measure an effect against targets and reference descriptors.
function evaluate(effect, ctx) {
  const e = ctx.lowres ? lowres(effect) : effect;
  const m = FX.measure(e, { keepFrames: ctx.refDescs.length > 0 });
  let viol = 0;
  const targets = ctx.targets.map(t => {
    const v = FX.metricValue(m.summary, t), d = violation(t, v);
    viol += (t.weight === undefined ? 1 : t.weight) * d;
    return { label: (t.layer ? t.layer + '.' : '') + t.metric + t.op + t.value, actual: v, ok: d === 0 };
  });
  let match = null;
  if (ctx.refDescs.length) {
    m.frames.forEach((fr, f) => {
      const d = FX.describeImage(fr, m.size, m.size);
      if (!d) return;
      const cs = ctx.refDescs.map(rd => FX.compareDescriptors(d, rd, ctx.aspects));
      const avg = {};
      for (const k of Object.keys(cs[0])) avg[k] = +(cs.reduce((s, c) => s + c[k], 0) / cs.length).toFixed(3);
      if (!match || avg.overall > match.overall) match = Object.assign(avg, { frame: f });
    });
  }
  const score = viol + (match ? ctx.matchWeight * (1 - match.overall) * 4 : 0);
  return { summary: m.summary, targets, viol: +viol.toFixed(3), match, score: +score.toFixed(4) };
}

// ------------------------------------------------------------ worker pool
if (!isMainThread) {
  const ctx = workerData;
  parentPort.on('message', ({ id, effect }) => {
    try { parentPort.postMessage({ id, r: evaluate(effect, ctx) }); }
    catch (e) { parentPort.postMessage({ id, error: String(e && e.stack || e) }); }
  });
}
function pool(ctx, n) {
  const workers = Array.from({ length: n }, () => new Worker(fileURLToPath(import.meta.url), { workerData: ctx }));
  let next = 0;
  const waiting = new Map();
  for (const w of workers) w.on('message', m => { const cb = waiting.get(m.id); waiting.delete(m.id); cb(m); });
  return {
    run(effects) {
      return Promise.all(effects.map((effect, i) => new Promise((res, rej) => {
        const id = next++;
        waiting.set(id, m => (m.error ? rej(new Error(m.error)) : res(m.r)));
        workers[i % workers.length].postMessage({ id, effect });
      })));
    },
    close() { workers.forEach(w => w.terminate()); },
  };
}

// --------------------------------------------------------------- loading
function args() {
  const a = process.argv.slice(2), opts = {}, pos = [];
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) opts[a[i].slice(2)] = a[++i]; else pos.push(a[i]);
  return { cmd: pos[0], dump: pos[1], planArg: pos[2], opts };
}
const tOf = it => it.t || it.savedAt || it.createdAt || '';
const byClaude = it => it.author === 'claude' || it.savedBy === 'claude';
function loadState(dump, eid) {
  const dir = path.join(dump, 'effects', eid, 'items');
  if (!fs.existsSync(dir)) throw new Error(`No items at ${dir}. Dump with ArtifactData query collection "effects/${eid}/items" out_dir ${dump}`);
  const items = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => Object.assign(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), { id: f.slice(0, -5) }));
  const of = k => items.filter(i => i.kind === k);
  const versions = of('version').sort((a, b) => a.version - b.version);
  const current = versions[versions.length - 1];
  const lastClaudeT = items.filter(byClaude).map(tOf).sort().pop() || '';
  const isNew = it => tOf(it) > lastClaudeT && !byClaude(it);
  const replies = of('reply').sort((a, b) => tOf(a).localeCompare(tOf(b)));
  const replied = {}, resolved = new Set();
  for (const r of replies) { Object.assign(replied, r.notes || {}); (r.resolve || []).forEach(id => resolved.add(id)); }
  return {
    eid, items, versions, current,
    lastClaudeVersion: [...versions].reverse().find(byClaude),
    notes: of('note').sort((a, b) => tOf(a).localeCompare(tOf(b))),
    asks: of('ask'), proposals: of('proposal'), refs: of('ref'), replies, replied, resolved, isNew, lastClaudeT,
  };
}
function versionEffect(st, n) { const v = st.versions.find(x => x.version === n); return v ? v.effect : null; }
// What the artist was looking at when they wrote a note: its base version plus unsaved edits.
function noteEffect(st, note) {
  let e = versionEffect(st, note.baseVersion) || st.current.effect;
  const patch = {};
  for (const c of note.unsaved || []) if (/^[\w-]+\.[\w-]+$/.test(c.path) && c.to !== 'removed') patch[c.path] = c.to;
  e = FX.applyPatch(e, patch);
  if (note.mode) e.canvas.mode = note.mode;
  return e;
}
function loadRefs(st) {
  const dir = path.join(OUT, 'refs');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [];
  for (const r of st.refs) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(r.thumb || '');
    if (!m) continue;
    const src = path.join(dir, `${r.id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(src, Buffer.from(m[2], 'base64'));
    jobs.push([src, path.join(dir, `${r.id}.png`)]);
  }
  if (jobs.length) {
    execFileSync('python3', ['-I', '-c', 'import sys,json\nfrom PIL import Image\nfor a,b in json.loads(sys.argv[1]): Image.open(a).convert("RGBA").save(b)', JSON.stringify(jobs)]);
  }
  return st.refs.filter(r => fs.existsSync(path.join(dir, `${r.id}.png`))).map(r => {
    const file = path.join(dir, `${r.id}.png`), p = PNG.sync.read(fs.readFileSync(file));
    return { id: r.id, caption: r.caption || r.name || 'reference', file, desc: FX.describeImage(p.data, p.width, p.height) };
  });
}

// ---------------------------------------------------------- images + html
function pngData(rgba, w, h) { const p = new PNG({ width: w, height: h }); p.data = Buffer.from(rgba.buffer ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba); return 'data:image/png;base64,' + PNG.sync.write(p).toString('base64'); }
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function frameImg(effect, f, opts = {}) {
  const r = FX.renderFrame(effect, f, { bg: opts.bg || '#000000', only: opts.only });
  return { src: pngData(r.data, r.size, r.size), size: r.size };
}
function strip(effect, frames, opts = {}) {
  const px = opts.px || 128;
  return `<div class="strip">${frames.map(f => { const im = frameImg(effect, f, opts); return `<figure><img src="${im.src}" style="width:${px}px;height:${px}px"><figcaption>f${f}</figcaption></figure>`; }).join('')}</div>`;
}
function sparkSvg(series, w = 300, h = 70) {
  const colors = ['#ffcf5c', '#57d1c0', '#ef6a5a', '#c9a6ff', '#6fd08c', '#f2b84b', '#8ab4ff'];
  const mx = Math.max(1e-6, ...series.flatMap(s => s.vals));
  const lines = series.map((s, i) => {
    const n = s.vals.length;
    const pts = s.vals.map((v, j) => `${((j / Math.max(1, n - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - (v / mx) * (h - 8)).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="1.6"/>`;
  }).join('');
  const legend = series.map((s, i) => `<span style="color:${colors[i % colors.length]}">■ ${esc(s.name)}</span>`).join(' ');
  return `<div><svg width="${w}" height="${h}" style="background:#16151b">${lines}</svg><div class="legend">${legend}</div></div>`;
}
const CSS = `body{margin:0;background:#111015;color:#ece9f3;font:13px/1.4 "IBM Plex Sans",system-ui,sans-serif;padding:16px;width:1460px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:18px 0 6px;color:#9c98ab;text-transform:uppercase;letter-spacing:.08em}
.strip{display:flex;gap:4px}.strip figure{margin:0}.strip img{image-rendering:pixelated;display:block;border:1px solid #2d2b37}
figcaption{font:11px monospace;color:#9c98ab}.row{display:flex;gap:14px;align-items:flex-start;margin:6px 0 10px}
.lbl{width:230px;flex:none}.k{font:600 16px monospace;color:#57d1c0}.m{font:11px monospace;color:#c9c5d6;white-space:pre-wrap}
.ok{color:#6fd08c}.bad{color:#ef6a5a}.note{display:flex;gap:10px;background:#1b1a22;border:1px solid #2d2b37;border-radius:6px;padding:8px;width:440px}
.notes{display:flex;flex-wrap:wrap;gap:10px}.pinwrap{position:relative;flex:none}.pinwrap img{display:block;image-rendering:pixelated}
.pin{position:absolute;width:16px;height:16px;border:2px solid #fff;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 1px #000}
.refs{display:flex;gap:10px}.refs img{height:150px;border:1px solid #2d2b37}.legend{font:11px monospace;margin-top:2px}.small{color:#9c98ab;font-size:12px}`;
function shoot(html, file) {
  const pw = require('playwright');
  return (async () => {
    const b = await pw.chromium.launch();
    const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${html}</body>`);
    await p.screenshot({ path: file, fullPage: true });
    await b.close();
  })();
}
const fmtMatch = m => (m ? `match ${m.overall} @f${m.frame} (col ${m.colour} vol ${m.volume} shape ${m.shape} deb ${m.debris})` : '');
const fmtSum = s => `peak f${s.peakFrame} start f${s.startFrame} fade f${s.fadeFrame} r${s.maxRadius} cov ${Math.round(s.maxCoverage * 100)}%`;
function framesFor(e, plan) {
  if (plan && plan.frames) return plan.frames;
  const F = FX.normalizeEffect(e).canvas.frames;
  return [...new Set(Array.from({ length: 8 }, (_, i) => Math.round((i * (F - 1)) / 7)))];
}

// ---------------------------------------------------------------- inspect
async function inspect(st, refs) {
  const cur = st.current, e = cur.effect, frames = framesFor(e);
  const lines = [];
  const who = v => (v.savedBy === 'claude' ? 'Claude' : 'artist');
  lines.push(`EFFECT ${st.eid}: current v${cur.version} by ${who(cur)} (${cur.savedAt}) "${cur.message || ''}"`);
  const lc = st.lastClaudeVersion;
  if (lc && lc.version !== cur.version) {
    const d = FX.diff(lc.effect, e);
    lines.push(`CHANGED since Claude's v${lc.version} (${d.length}): ` + d.slice(0, 40).map(c => `${c.path} ${JSON.stringify(c.from)}→${JSON.stringify(c.to)}`).join('; '));
  }
  const newV = st.versions.filter(st.isNew);
  if (newV.length) lines.push(`NEW VERSIONS: ` + newV.map(v => `v${v.version} "${v.message || ''}"`).join(', '));
  for (const p of st.proposals.filter(p => p.status === 'answered' && p.pick && p.pick.at > st.lastClaudeT)) {
    const o = (p.options || []).find(o => o.key === p.pick.key);
    lines.push(`PICK ${p.id} "${p.title}": ${p.pick.key || 'none'}${o ? ' (' + o.label + ')' : ''}${p.pick.comment ? ' — "' + p.pick.comment + '"' : ''}`);
  }
  for (const p of st.proposals.filter(p => p.status === 'open')) lines.push(`OPEN CHOICE ${p.id} "${p.title}" (${(p.options || []).length} options)`);
  for (const a of st.asks.filter(st.isNew)) lines.push(`ASK "${a.text}" → picked ${a.picked || 'none'} (${a.pickedLabel || ''}) patch ${JSON.stringify(a.patch || {})}${a.comment ? ' — "' + a.comment + '"' : ''}`);
  const open = st.notes.filter(n => n.status === 'open' && !st.resolved.has(n.id));
  for (const n of open) {
    lines.push(`NOTE ${n.id} f${n.frame} (${n.x},${n.y})/${n.size} on v${n.baseVersion}${(n.unsaved || []).length ? '+' + n.unsaved.length + ' edits' : ''} layer=${n.layer} hits=${(n.hits || []).map(h => h.id + ':' + Math.round(h.share * 100) + '%').join(',')} tags=[${(n.tags || []).join(', ')}] "${n.text || ''}"${st.replied[n.id] ? ' (replied before)' : ''}`);
  }
  const ev = evaluate(e, { targets: [], refDescs: refs.map(r => r.desc).filter(Boolean), aspects: null, matchWeight: 1 });
  lines.push(`METRICS ${fmtSum(ev.summary)}`);
  for (const [id, s] of Object.entries(ev.summary.layers)) lines.push(`  ${id}: ${fmtSum(s)}`);
  const checks = FX.evaluateChecks(FX.normalizeEffect(e), ev.summary);
  if (checks.length) lines.push('CHECKS ' + checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.id}(${c.actual})`).join(' '));
  for (const r of refs) {
    lines.push(`REF ${r.id} "${r.caption}" desc bands=${JSON.stringify(r.desc && r.desc.bands)} fill=${r.desc && r.desc.fill} lobes=${r.desc && r.desc.lobes} rough=${r.desc && r.desc.rough}`);
  }
  if (ev.match) lines.push(`CURRENT vs refs: ${fmtMatch(ev.match)}`);

  // review image
  const m = FX.measure(e);
  let html = `<h1>${esc(st.eid)} · v${cur.version} by ${esc(who(cur))}</h1><div class="small">${esc(cur.message || '')}</div>`;
  html += `<h2>Current v${cur.version}</h2>${strip(e, frames)}`;
  if (lc && lc.version !== cur.version) html += `<h2>Before: Claude's v${lc.version}</h2>${strip(lc.effect, frames)}`;
  html += `<h2>Each layer alone</h2>`;
  for (const l of FX.normalizeEffect(e).layers.filter(l => l.enabled)) {
    html += `<div class="row"><div class="lbl"><b>${esc(l.label)}</b> <span class="small">${l.type} · ${l.blend}</span><div class="m">${esc(fmtSum(ev.summary.layers[l.id] || {}))}</div></div>${strip(e, frames, { only: [l.id], px: 96 })}</div>`;
  }
  if (open.length) {
    html += `<h2>Open notes (exact frame the artist saw)</h2><div class="notes">`;
    for (const n of open) {
      const ne = noteEffect(st, n), im = frameImg(ne, n.frame), px = 192, sc = px / im.size;
      html += `<div class="note"><div class="pinwrap"><img src="${im.src}" style="width:${px}px;height:${px}px"><div class="pin" style="left:${n.x * sc}px;top:${n.y * sc}px"></div></div><div><div class="k" style="font-size:12px">${esc(n.id)} · f${n.frame}</div><div class="m">${esc((n.hits || []).map(h => h.id + ' ' + Math.round(h.share * 100) + '%').join(' · '))}</div><div>${esc((n.tags || []).join(', '))}</div><div>${esc(n.text || '')}</div></div></div>`;
    }
    html += `</div>`;
  }
  if (refs.length) {
    html += `<h2>References</h2><div class="refs">${refs.map(r => `<figure style="margin:0"><img src="${pngData(PNG.sync.read(fs.readFileSync(r.file)).data, PNG.sync.read(fs.readFileSync(r.file)).width, PNG.sync.read(fs.readFileSync(r.file)).height)}"><figcaption>${esc(r.caption)}</figcaption></figure>`).join('')}
      ${ev.match ? `<figure style="margin:0"><img src="${frameImg(e, ev.match.frame).src}" style="height:150px"><figcaption>current best match f${ev.match.frame}: ${esc(fmtMatch(ev.match))}</figcaption></figure>` : ''}</div>`;
  }
  html += `<h2>Brightness per frame</h2><div class="row">${sparkSvg([{ name: 'all', vals: m.perFrame.energy }, ...Object.entries(m.perLayer).map(([id, p]) => ({ name: id, vals: p.energy }))], 700, 90)}${sparkSvg([{ name: 'radius all', vals: m.perFrame.radius }, ...Object.entries(m.perLayer).map(([id, p]) => ({ name: id, vals: p.radius }))], 700, 90)}</div>`;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'inspect.png');
  await shoot(html, file);
  lines.push(`REVIEW ${file}`);
  console.log(lines.join('\n'));
}

// -------------------------------------------------------------------- run
function buildFrom(st, plan, built, spec) {
  let e;
  const from = spec.from || 'base';
  if (from === 'base') e = plan.__base;
  else if (built[from]) e = built[from].effect;
  else throw new Error(`candidate ${spec.key}: unknown from "${from}"`);
  e = FX.normalizeEffect(e);
  if (spec.removeLayers) e.layers = e.layers.filter(l => !spec.removeLayers.includes(l.id));
  for (const l of spec.addLayers || []) {
    const nl = FX.normalizeEffect({ palette: e.palette, layers: [l] }).layers[0];
    if (!nl) throw new Error(`candidate ${spec.key}: bad layer ${JSON.stringify(l).slice(0, 80)}`);
    const at = l.below ? e.layers.findIndex(x => x.id === l.below) : -1;
    if (at >= 0) e.layers.splice(at, 0, nl); else e.layers.push(nl);
  }
  if (spec.palette) Object.assign(e.palette, spec.palette);
  e = FX.applyPatch(e, spec.patch || {});
  delete e.__norm;
  return e;
}
function specOf(e, key) { const [id, p] = key.split('.'); const l = FX.normalizeEffect(e).layers.find(x => x.id === id); return l && FX.paramSpec(l.type, p); }
function sampleVary(base, vary, rnd, around, radius) {
  const patch = {};
  for (const [k, [lo, hi]] of Object.entries(vary)) {
    let v = around ? around[k] + (rnd() * 2 - 1) * radius * (hi - lo) : lo + rnd() * (hi - lo);
    v = Math.min(hi, Math.max(lo, v));
    const sp = specOf(base, k);
    if (sp && sp.type !== 'num') v = Math.round(v); else v = +v.toFixed(4);
    patch[k] = v;
  }
  return patch;
}
function patchDist(a, b, vary) { let s = 0; const ks = Object.keys(vary); for (const k of ks) s += Math.abs(a[k] - b[k]) / ((vary[k][1] - vary[k][0]) || 1); return s / ks.length; }
async function search(base, sp, P, rnd, keep) {
  const N = sp.samples || 120;
  const startPatch = {};
  for (const k of Object.keys(sp.vary)) { const [id, p] = k.split('.'); const l = FX.normalizeEffect(base).layers.find(x => x.id === id); startPatch[k] = l ? l.params[p] : sp.vary[k][0]; }
  const change = pt => 0.6 * patchDist(pt, startPatch, sp.vary);
  let pop = [startPatch, ...Array.from({ length: N - 1 }, () => sampleVary(base, sp.vary, rnd))];
  let res = await P.run(pop.map(pt => FX.applyPatch(base, pt)));
  let scored = pop.map((pt, i) => ({ pt, r: res[i], s: res[i].score + change(pt) })).sort((a, b) => a.s - b.s);
  // refine around the best few
  const elite = scored.slice(0, 6), local = [];
  for (const el of elite) for (let i = 0; i < Math.max(4, Math.round(N / 12)); i++) local.push(sampleVary(base, sp.vary, rnd, el.pt, 0.08));
  res = await P.run(local.map(pt => FX.applyPatch(base, pt)));
  scored = scored.concat(local.map((pt, i) => ({ pt, r: res[i], s: res[i].score + change(pt) }))).sort((a, b) => a.s - b.s);
  // diverse picks: greedy, each at least 0.15 apart in normalised parameter space
  const out = [];
  for (const c of scored) { if (out.length >= keep) break; if (out.every(o => patchDist(o.pt, c.pt, sp.vary) > 0.15)) out.push(c); }
  return { picks: out, evaluated: scored.length };
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function run(st, refs, plan) {
  const t0 = Date.now();
  // base: "current" | version number | "<proposalId>/<optionKey>"
  if (typeof plan.base === 'string' && plan.base.includes('/')) {
    const [pid, key] = plan.base.split('/'), pr = st.proposals.find(p => p.id === pid), o = pr && (pr.options || []).find(o => o.key === key);
    plan.__base = o ? (o.effect || FX.applyPatch(versionEffect(st, pr.baseVersion) || st.current.effect, o.patch || {})) : null;
  } else plan.__base = plan.base && plan.base !== 'current' ? versionEffect(st, +plan.base) : st.current.effect;
  if (!plan.__base) throw new Error('base version not found');
  const want = plan.match && plan.match.refs ? (plan.match.refs === 'all' ? refs : refs.filter(r => plan.match.refs.includes(r.id))) : [];
  const ctx = { targets: plan.targets || [], refDescs: want.map(r => r.desc).filter(Boolean), aspects: plan.match && plan.match.aspects, matchWeight: plan.match ? (plan.match.weight === undefined ? 1 : plan.match.weight) : 0 };
  const P = pool(Object.assign({ lowres: true }, ctx), Math.max(1, Math.min(8, os.cpus().length)));
  const rnd = rng(1234);
  const built = {}, order = [], notes = [];
  try {
    for (const c of plan.candidates || []) {
      if (c.search) {
        const base = buildFrom(st, plan, built, Object.assign({}, c, { from: c.search.from || c.from }));
        const { picks, evaluated } = await search(base, c.search, P, rnd, 1);
        built[c.key] = { key: c.key, label: c.label, effect: FX.applyPatch(base, picks[0].pt), searched: picks[0].pt };
        notes.push(`${c.key}: searched ${evaluated} variants → ${JSON.stringify(picks[0].pt)}`);
      } else built[c.key] = { key: c.key, label: c.label || c.key, effect: buildFrom(st, plan, built, c) };
      order.push(c.key);
    }
    if (plan.sweep) {
      const base = buildFrom(st, plan, built, { key: 'sweep', from: plan.sweep.from || 'base' });
      const { picks, evaluated } = await search(base, plan.sweep, P, rnd, plan.sweep.keep || 3);
      const keys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(k => !built[k]);
      picks.forEach((pk, i) => {
        const key = keys[i];
        built[key] = { key, label: `${plan.sweep.label || 'Search'} #${i + 1}`, effect: FX.applyPatch(base, pk.pt), searched: pk.pt };
        order.push(key);
      });
      notes.push(`sweep: ${evaluated} variants evaluated, kept ${picks.length}`);
    }
  } finally { P.close(); }
  // full-resolution evaluation of every candidate
  const fullCtx = Object.assign({ lowres: false }, ctx);
  for (const k of order) built[k].eval = evaluate(built[k].effect, fullCtx);

  const table = [];
  const baseN = FX.normalizeEffect(plan.__base);
  for (const k of order) {
    const c = built[k], ev = c.eval;
    const d = FX.diff(baseN, c.effect);
    c.changes = d;
    table.push(`${k} ${c.label}\n   ${fmtSum(ev.summary)}${ev.targets.length ? ` | targets ${ev.targets.filter(t => t.ok).length}/${ev.targets.length}: ` + ev.targets.map(t => `${t.ok ? '✓' : '✗'}${t.label}(${t.actual})`).join(' ') : ''}${ev.match ? ' | ' + fmtMatch(ev.match) : ''}\n   changes(${d.length}): ${d.slice(0, 12).map(x => `${x.path}=${JSON.stringify(x.to)}`).join(' ')}`);
  }

  // review image
  const frames = framesFor(plan.__base, plan);
  let html = `<h1>${esc(plan.title || 'Round')} · base ${plan.base && plan.base !== 'current' ? (String(plan.base).includes('/') ? plan.base : 'v' + plan.base) : 'v' + st.current.version}</h1><div class="small">${esc(notes.join(' · '))}</div>`;
  if (want.length) html += `<h2>Reference</h2><div class="refs">${want.map(r => { const p = PNG.sync.read(fs.readFileSync(r.file)); return `<figure style="margin:0"><img src="${pngData(p.data, p.width, p.height)}"><figcaption>${esc(r.caption)}</figcaption></figure>`; }).join('')}</div>`;
  html += `<h2>Candidates</h2>`;
  for (const k of order) {
    const c = built[k], ev = c.eval;
    html += `<div class="row"><div class="lbl"><span class="k">${k}</span> ${esc(c.label)}<div class="m">${esc(fmtSum(ev.summary))}\n${ev.targets.map(t => (t.ok ? '✓ ' : '✗ ') + t.label + ' (' + t.actual + ')').join('\n')}${ev.match ? '\n' + esc(fmtMatch(ev.match)) : ''}</div></div>${strip(c.effect, frames, { px: 140 })}</div>`;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'run.png');
  await shoot(html, file);

  // engines
  let verify = null;
  if (plan.verify && built[plan.verify]) {
    const tmp = path.join(OUT, `verify_${plan.verify}.json`);
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, built[plan.verify].effect, { id: st.eid + '_' + plan.verify.toLowerCase() })));
    try {
      const r = JSON.parse(execFileSync('node', [path.join(HERE, 'fx.mjs'), 'verify', tmp], { maxBuffer: 1 << 26 }).toString());
      verify = Object.entries(r.engines).map(([k, v]) => `${k}: ${v.ok ? `contentError ${v.contentError} maxPx ${v.maxPixelError} slips ${(v.timingSlips || []).length}` : 'FAILED ' + (v.error || '').slice(0, 200)}`).join(' | ');
    } catch (e) { verify = 'verify failed: ' + String(e.message).slice(0, 300); }
  }

  // database writes
  const writes = [], now = new Date().toISOString(), W = plan.write || {};
  const outDir = path.join(OUT, 'writes');
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const put = (id, data) => { const f = path.join(outDir, id + '.json'); fs.writeFileSync(f, JSON.stringify(data)); writes.push({ op: 'set', collection: `effects/${st.eid}/items`, doc_id: id, file_path: f }); };
  const clean = e => { const c = JSON.parse(JSON.stringify(e)); delete c.__norm; c.id = st.eid; return c; };
  if (W.version) {
    const c = built[W.version.from]; if (!c) throw new Error('write.version.from unknown');
    const n = st.current.version + 1;
    put('v' + String(n).padStart(4, '0'), { kind: 'version', version: n, effect: clean(c.effect), savedBy: 'claude', author: 'claude', message: W.version.message || '', savedAt: now, t: now, changes: FX.diff(st.current.effect, c.effect).slice(0, 200) });
    if (W.version.mirror !== false) fs.writeFileSync(path.join(ROOT, 'fx', st.eid, 'effect.json'), JSON.stringify(Object.assign({ name: c.effect.name || st.eid }, clean(c.effect)), null, 2) + '\n');
  }
  if (W.proposal) {
    const n = st.proposals.length + 1;
    const keys = W.proposal.options || order;
    const slug = String(W.proposal.title || 'choice').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/-$/, '');
    put('p' + String(n).padStart(4, '0') + '-' + slug, {
      kind: 'proposal', title: W.proposal.title, question: W.proposal.question || '', author: 'claude', status: 'open',
      baseVersion: W.version ? st.current.version + 1 : st.current.version, createdAt: now, t: now,
      options: keys.map(k => ({ key: k, label: built[k].label, effect: clean(built[k].effect), facts: fmtSum(built[k].eval.summary) + (built[k].eval.match ? ' · ' + fmtMatch(built[k].eval.match) : '') })),
    });
  }
  if (W.reply) {
    const n = st.replies.length + 1;
    put('r' + String(n).padStart(4, '0'), { kind: 'reply', author: 'claude', message: W.reply.message || '', notes: W.reply.notes || {}, resolve: W.reply.resolve || Object.keys(W.reply.notes || {}), createdAt: now, t: now });
  }
  console.log(table.join('\n'));
  if (verify) console.log('ENGINES ' + verify);
  console.log(`REVIEW ${file}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (writes.length) console.log('WRITES ' + JSON.stringify(writes));
}

// ------------------------------------------------------------------ main
if (isMainThread) {
  const { cmd, dump, planArg, opts } = args();
  const eid = opts.effect || 'explosion';
  if (!['inspect', 'run'].includes(cmd) || !dump) {
    console.log('usage: round.mjs inspect <dump> | run <dump> <plan.json|-> [--effect id]');
    process.exit(1);
  }
  (async () => {
    const st = loadState(dump, eid);
    const refs = loadRefs(st);
    if (cmd === 'inspect') await inspect(st, refs);
    else {
      const plan = JSON.parse(planArg === '-' || !planArg ? fs.readFileSync(0, 'utf8') : fs.readFileSync(planArg, 'utf8'));
      await run(st, refs, plan);
    }
  })().catch(e => { console.error('ERROR ' + (e.stack || e)); process.exit(1); });
}
