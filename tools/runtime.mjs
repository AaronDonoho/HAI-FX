// Node wrapper around core/fxexport.js: writes the Godot and Defold runtime exports to disk.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = require(path.join(ROOT, 'core/fxcore.js'));
const GPU = require(path.join(ROOT, 'core/fxgpu.js'));
const X = require(path.join(ROOT, 'core/fxexport.js'));
GPU.install(FX); // register GPU layer types (their WebGL renderer is unused here)

export const godotShader = (e, l, s) => X.godotShader(e, l, s || {}, { FX, GPU });

export async function exportRuntime(E, effect, outDir, sourcesDataUrls) {
  const sources = {};
  for (const [sid, url] of Object.entries(sourcesDataUrls || {})) {
    const bytes = Buffer.from(url.split(',')[1], 'base64'), p = PNG.sync.read(bytes);
    sources[sid] = { w: p.width, h: p.height, pixel: Math.max(p.width, p.height) <= 128, png: bytes };
  }
  const { files, summary } = await X.exportRuntime(effect, {
    FX, GPU, sources,
    bake: sub => E.call('exportPasses', sub), // the engine page already holds the decoded sprites
    png: async (w, h, rgba) => { const p = new PNG({ width: w, height: h }); p.data = Buffer.from(rgba.buffer ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba); return PNG.sync.write(p); },
  });
  for (const sub of ['godot', 'defold']) fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), data);
  }
  return summary;
}
