// Browser-backed renderer for the tools: headless Chromium pages running core/fxcore.js and
// core/fxgpu.js, so CPU and GPU layers render exactly as they do in the Studio.
//
//   const E = await openEngine({ pages: 4 });
//   await E.setSources({ crate: 'data:image/png;base64,...' });
//   const m = await E.call('measure', effect, { keepFrames: true });     // typed arrays come back as Uint8Array/Float32Array
//   const url = await E.frameURL(effect, 5, { bg: '#000' });              // PNG data URL of one frame
//   const results = await E.map('evaluate', effects, ctx);               // spread over all pages
//   await E.close();
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELPER = `
window.__src = {};
window.__setSources = async (map) => {
  for (const [id, v] of Object.entries(map || {})) {
    const url = typeof v === 'string' ? v : (v.url || v.data);
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height);
    const grid = typeof v === 'object' && v.cols ? { cols: v.cols, rows: v.rows || 1, frames: v.frames || v.cols * (v.rows || 1) } : null;
    window.__src[id] = { data: d.data, w: d.width, h: d.height, pixel: Math.max(d.width / ((grid && grid.cols) || 1), d.height / ((grid && grid.rows) || 1)) <= 128, grid };
  }
  return Object.keys(window.__src);
};
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const enc = v => {
  if (v instanceof Uint8ClampedArray || v instanceof Uint8Array) return { __u8: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (v instanceof Float32Array) return { __f32: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = enc(v[k]); return o; }
  return v;
};
const withSources = args => {
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !Array.isArray(last) && !last.layers) { if (!last.sources) last.sources = window.__src; }
  else args.push({ sources: window.__src });
  return args;
};
window.__call = (name, args) => enc(FXCore[name](...withSources(args)));
window.__frameURL = (effect, f, opts) => {
  const r = FXCore.renderFrame(effect, f, Object.assign({ sources: window.__src }, opts || {}));
  const c = document.createElement('canvas'); c.width = c.height = r.size;
  c.getContext('2d').putImageData(new ImageData(r.data, r.size, r.size), 0, 0);
  return c.toDataURL('image/png');
};
window.__gpu = () => FXGPU.available();
`;

function dec(v) {
  if (v && typeof v === 'object') {
    if (v.__u8 !== undefined) return new Uint8Array(Buffer.from(v.__u8, 'base64'));
    if (v.__f32 !== undefined) { const b = Buffer.from(v.__f32, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }
    if (Array.isArray(v)) return v.map(dec);
    const o = {}; for (const k in v) o[k] = dec(v[k]); return o;
  }
  return v;
}

export async function openEngine({ pages = 1 } = {}) {
  const pw = require('playwright');
  const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const core = fs.readFileSync(path.join(ROOT, 'core/fxcore.js'), 'utf8');
  const gpu = fs.readFileSync(path.join(ROOT, 'core/fxgpu.js'), 'utf8');
  const ps = [];
  for (let i = 0; i < pages; i++) {
    const p = await browser.newPage();
    await p.setContent('<!doctype html><meta charset="utf-8"><body></body>');
    await p.addScriptTag({ content: core });
    await p.addScriptTag({ content: gpu });
    await p.addScriptTag({ content: HELPER });
    ps.push(p);
  }
  const gpuOK = await ps[0].evaluate(() => window.__gpu());
  let rr = 0;
  const E = {
    gpu: gpuOK, pages: ps, browser,
    async setSources(map) { await Promise.all(ps.map(p => p.evaluate(m => window.__setSources(m), map))); },
    async call(name, ...args) { const p = ps[rr++ % ps.length]; return dec(await p.evaluate(([n, a]) => window.__call(n, a), [name, args])); },
    async frameURL(effect, f, opts) { const p = ps[rr++ % ps.length]; return p.evaluate(([e, fr, o]) => window.__frameURL(e, fr, o), [effect, f, opts || {}]); },
    // run fn over many effects, spreading across pages; extra args are passed to every call
    async map(name, effects, ...rest) {
      const out = new Array(effects.length);
      let next = 0;
      await Promise.all(ps.map(async p => {
        while (next < effects.length) {
          const i = next++;
          out[i] = dec(await p.evaluate(([n, a]) => window.__call(n, a), [name, [effects[i], ...JSON.parse(JSON.stringify(rest))]]));
        }
      }));
      return out;
    },
    async close() { await browser.close(); },
  };
  return E;
}

// Sprite sources stored beside an effect file: fx/<id>/sources/<name>.png -> {name: dataURL}
// plus the shared library in fx/_sprites/<name>.png. Animated sheets: <name>@<cols>x<rows>[f<frames>].png
export function sourcesInDir(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(.+?)(?:@(\d+)x(\d+)(?:f(\d+))?)?\.png$/i.exec(f);
    if (!m) continue;
    const url = 'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');
    out[m[1]] = m[2] ? { url, cols: +m[2], rows: +m[3], frames: m[4] ? +m[4] : +m[2] * +m[3] } : url;
  }
  return out;
}
export function sourcesBeside(effectFile) {
  return Object.assign(sourcesInDir(path.join(ROOT, 'fx', '_sprites')), sourcesInDir(path.join(path.dirname(effectFile), 'sources')));
}
export const sourceFileName = (id, v) => (typeof v === 'object' && v.cols ? `${id}@${v.cols}x${v.rows || 1}f${v.frames || v.cols * (v.rows || 1)}.png` : `${id}.png`);
export const sourceUrl = v => (typeof v === 'string' ? v : v.url || v.data);
