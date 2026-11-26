/*
 * fxcore.js: the single renderer behind HAI-FX.
 *
 * The same file runs in the Studio page (browser) and in tools/fx.mjs (Node),
 * so the preview and the exported sprite sheets come from identical code.
 * Everything is pure arithmetic on Float32 buffers: no canvas API, no GPU,
 * so output is deterministic for a given effect document and seed.
 *
 * Conventions
 *   - Time is in frames at effect.canvas.fps. Physics converts to seconds.
 *   - Distances are in "units": 1 unit = half the canvas width (centre to edge).
 *   - Screen y points down. gravity > 0 pulls down; directionDeg 90 points up.
 *   - Layer buffers are premultiplied RGBA in 0..1 (sRGB, like Godot 2D and Defold).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FXCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- easing
  // Names map 1:1 to Defold go.EASING_* and Godot Tween TRANS_*/EASE_*.
  const c1 = 1.70158, c3 = c1 + 1;
  const EASE = {
    linear: t => t,
    inQuad: t => t * t,
    outQuad: t => 1 - (1 - t) * (1 - t),
    inOutQuad: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    inCubic: t => t * t * t,
    outCubic: t => 1 - Math.pow(1 - t, 3),
    inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    inQuart: t => t * t * t * t,
    outQuart: t => 1 - Math.pow(1 - t, 4),
    inExpo: t => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
    outExpo: t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inSine: t => 1 - Math.cos((t * Math.PI) / 2),
    outSine: t => Math.sin((t * Math.PI) / 2),
    inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
    inBack: t => c3 * t * t * t - c1 * t * t,
    outBack: t => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  };
  const ease = (name, t) => (EASE[name] || EASE.linear)(Math.min(1, Math.max(0, t)));

  // ----------------------------------------------------------------- utils
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    if (e1 === e0) return x < e0 ? 0 : 1;
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [1, 0, 1]; // loud magenta for a bad value
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
  }
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // Deterministic RNG and hashing.
  function strHash(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(ix, iy, s) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s);
    const c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
  }
  function fbm(x, y, s) {
    return (vnoise(x, y, s) * 0.5333 + vnoise(x * 2.03, y * 2.03, s + 17) * 0.2667 + vnoise(x * 4.1, y * 4.1, s + 31) * 0.2);
  }

  // ------------------------------------------------------------ parameters
  // type: frame | num | int | ease | color | angle
  const P = (key, label, type, def, extra) => Object.assign({ key, label, type, def }, extra || {});
  const TIMING = 'Timing', SHAPE = 'Shape', MOTION = 'Motion', LOOK = 'Look', COLOR = 'Color';

  const TYPES = {
    glow: {
      label: 'Glow',
      blurb: 'Radial bloom of light. Good for the core flash.',
      blend: 'add',
      params: [
        P('start', 'Start', 'frame', 0, { min: 0, max: 60, group: TIMING }),
        P('duration', 'Duration', 'frame', 8, { min: 1, max: 60, group: TIMING }),
        P('hold', 'Hold at full', 'frame', 1, { min: 0, max: 30, group: TIMING, help: 'Frames at full brightness before fading.' }),
        P('fadeEase', 'Fade curve', 'ease', 'inQuad', { group: TIMING }),
        P('radiusStart', 'Radius start', 'num', 0.12, { min: 0, max: 1.5, step: 0.01, unit: 'u', group: SHAPE }),
        P('radiusEnd', 'Radius end', 'num', 0.5, { min: 0, max: 1.5, step: 0.01, unit: 'u', group: SHAPE }),
        P('sizeEase', 'Growth curve', 'ease', 'outCubic', { group: SHAPE }),
        P('core', 'Hot core', 'num', 0.2, { min: 0, max: 0.95, step: 0.01, group: LOOK, help: 'Fraction of the radius at full brightness.' }),
        P('falloff', 'Falloff', 'num', 1.6, { min: 0.2, max: 6, step: 0.05, group: LOOK, help: 'Higher = tighter, sharper edge falloff.' }),
        P('intensity', 'Intensity', 'num', 1, { min: 0, max: 3, step: 0.05, group: LOOK }),
        P('colorInner', 'Inner', 'color', 'white', { group: COLOR }),
        P('colorOuter', 'Outer', 'color', 'hot', { group: COLOR }),
      ],
    },
    ring: {
      label: 'Ring',
      blurb: 'Expanding shockwave ring.',
      blend: 'add',
      params: [
        P('start', 'Start', 'frame', 1, { min: 0, max: 60, group: TIMING }),
        P('duration', 'Duration', 'frame', 10, { min: 1, max: 60, group: TIMING }),
        P('fadeEase', 'Fade curve', 'ease', 'inQuad', { group: TIMING }),
        P('radiusStart', 'Radius start', 'num', 0.1, { min: 0, max: 1.5, step: 0.01, unit: 'u', group: SHAPE }),
        P('radiusEnd', 'Radius end', 'num', 0.9, { min: 0, max: 1.5, step: 0.01, unit: 'u', group: SHAPE }),
        P('sizeEase', 'Growth curve', 'ease', 'outExpo', { group: SHAPE }),
        P('thicknessStart', 'Thickness start', 'num', 0.12, { min: 0.005, max: 0.6, step: 0.005, unit: 'u', group: SHAPE }),
        P('thicknessEnd', 'Thickness end', 'num', 0.02, { min: 0.005, max: 0.6, step: 0.005, unit: 'u', group: SHAPE }),
        P('softness', 'Softness', 'num', 0.7, { min: 0, max: 1, step: 0.01, group: LOOK }),
        P('opacity', 'Opacity', 'num', 0.9, { min: 0, max: 2, step: 0.01, group: LOOK }),
        P('breakup', 'Breakup', 'num', 0.35, { min: 0, max: 1, step: 0.01, group: LOOK, help: 'Noise that breaks the ring into uneven arcs.' }),
        P('breakupScale', 'Breakup scale', 'num', 5, { min: 1, max: 20, step: 0.5, group: LOOK }),
        P('color', 'Ring', 'color', 'hot', { group: COLOR }),
        P('colorInner', 'Inner edge', 'color', 'mid', { group: COLOR }),
      ],
    },
    sparks: {
      label: 'Sparks',
      blurb: 'Fast streaking particles with drag and gravity.',
      blend: 'add',
      params: [
        P('start', 'Start', 'frame', 0, { min: 0, max: 60, group: TIMING }),
        P('emitFrames', 'Emit over', 'frame', 2, { min: 0, max: 30, group: TIMING }),
        P('lifeMin', 'Life min', 'frame', 8, { min: 1, max: 60, group: TIMING }),
        P('lifeMax', 'Life max', 'frame', 18, { min: 1, max: 60, group: TIMING }),
        P('fadeEase', 'Fade curve', 'ease', 'inQuad', { group: TIMING }),
        P('count', 'Count', 'int', 40, { min: 1, max: 300, group: SHAPE }),
        P('emitRadius', 'Emit radius', 'num', 0.05, { min: 0, max: 1, step: 0.01, unit: 'u', group: SHAPE }),
        P('directionDeg', 'Direction', 'angle', 90, { min: -180, max: 180, step: 1, unit: '°', group: SHAPE }),
        P('spreadDeg', 'Spread', 'angle', 360, { min: 0, max: 360, step: 1, unit: '°', group: SHAPE }),
        P('speedMin', 'Speed min', 'num', 0.8, { min: 0, max: 6, step: 0.05, unit: 'u/s', group: MOTION }),
        P('speedMax', 'Speed max', 'num', 2.4, { min: 0, max: 6, step: 0.05, unit: 'u/s', group: MOTION }),
        P('drag', 'Drag', 'num', 2.5, { min: 0, max: 12, step: 0.1, group: MOTION }),
        P('gravity', 'Gravity', 'num', 0.8, { min: -4, max: 4, step: 0.05, unit: 'u/s²', group: MOTION }),
        P('size', 'Size', 'num', 0.022, { min: 0.004, max: 0.2, step: 0.002, unit: 'u', group: LOOK }),
        P('shrink', 'Shrink', 'num', 0.5, { min: 0, max: 1, step: 0.01, group: LOOK, help: 'How much particles shrink over their life.' }),
        P('stretch', 'Streak', 'num', 0.05, { min: 0, max: 0.3, step: 0.005, unit: 's', group: LOOK, help: 'Trail length, in seconds of velocity.' }),
        P('softness', 'Softness', 'num', 0.4, { min: 0, max: 1, step: 0.01, group: LOOK }),
        P('intensity', 'Intensity', 'num', 1.2, { min: 0, max: 3, step: 0.05, group: LOOK }),
        P('colorStart', 'Start', 'color', 'white', { group: COLOR }),
        P('colorEnd', 'End', 'color', 'mid', { group: COLOR }),
      ],
    },
    smoke: {
      label: 'Smoke',
      blurb: 'Soft noisy puffs that billow, rise and erode away.',
      blend: 'normal',
      params: [
        P('start', 'Start', 'frame', 2, { min: 0, max: 60, group: TIMING }),
        P('emitFrames', 'Emit over', 'frame', 4, { min: 0, max: 30, group: TIMING }),
        P('lifeMin', 'Life min', 'frame', 14, { min: 1, max: 90, group: TIMING }),
        P('lifeMax', 'Life max', 'frame', 22, { min: 1, max: 90, group: TIMING }),
        P('fadeEase', 'Fade curve', 'ease', 'inQuad', { group: TIMING }),
        P('count', 'Puffs', 'int', 14, { min: 1, max: 80, group: SHAPE }),
        P('emitRadius', 'Emit radius', 'num', 0.15, { min: 0, max: 1, step: 0.01, unit: 'u', group: SHAPE }),
        P('sizeStart', 'Size start', 'num', 0.12, { min: 0.01, max: 1, step: 0.01, unit: 'u', group: SHAPE }),
        P('sizeEnd', 'Size end', 'num', 0.34, { min: 0.01, max: 1.2, step: 0.01, unit: 'u', group: SHAPE }),
        P('speedMin', 'Speed min', 'num', 0.15, { min: 0, max: 3, step: 0.01, unit: 'u/s', group: MOTION }),
        P('speedMax', 'Speed max', 'num', 0.6, { min: 0, max: 3, step: 0.01, unit: 'u/s', group: MOTION }),
        P('drag', 'Drag', 'num', 1.5, { min: 0, max: 10, step: 0.1, group: MOTION }),
        P('rise', 'Rise', 'num', 0.3, { min: -2, max: 2, step: 0.01, unit: 'u/s²', group: MOTION }),
        P('opacity', 'Opacity', 'num', 0.85, { min: 0, max: 1, step: 0.01, group: LOOK }),
        P('erosion', 'Erosion', 'num', 0.55, { min: 0, max: 1, step: 0.01, group: LOOK, help: 'How strongly puffs eat away into wisps as they age.' }),
        P('noiseScale', 'Noise scale', 'num', 3, { min: 0.5, max: 10, step: 0.1, group: LOOK }),
        P('colorLit', 'Fire-lit', 'color', 'deep', { group: COLOR }),
        P('color', 'Smoke', 'color', 'smoke', { group: COLOR }),
        P('litFraction', 'Lit fraction', 'num', 0.3, { min: 0, max: 1, step: 0.01, group: COLOR, help: 'Share of a puff\'s life it stays lit by the fire.' }),
      ],
    },
    fire: {
      label: 'Fire',
      blurb: 'Billowing fire plumes coloured by heat: white-hot centres cooling to red edges.',
      blend: 'normal',
      params: [
        P('start', 'Start', 'frame', 0, { min: 0, max: 60, group: TIMING }),
        P('emitFrames', 'Emit over', 'frame', 3, { min: 0, max: 30, group: TIMING }),
        P('lifeMin', 'Life min', 'frame', 10, { min: 1, max: 90, group: TIMING }),
        P('lifeMax', 'Life max', 'frame', 18, { min: 1, max: 90, group: TIMING }),
        P('fadeEase', 'Fade curve', 'ease', 'inQuad', { group: TIMING }),
        P('count', 'Plumes', 'int', 22, { min: 1, max: 120, group: SHAPE }),
        P('emitRadius', 'Emit radius', 'num', 0.12, { min: 0, max: 1, step: 0.01, unit: 'u', group: SHAPE }),
        P('directionDeg', 'Direction', 'angle', 90, { min: -180, max: 180, step: 1, unit: '°', group: SHAPE }),
        P('spreadDeg', 'Spread', 'angle', 360, { min: 0, max: 360, step: 1, unit: '°', group: SHAPE }),
        P('sizeStart', 'Size start', 'num', 0.14, { min: 0.01, max: 1, step: 0.01, unit: 'u', group: SHAPE }),
        P('sizeEnd', 'Size end', 'num', 0.34, { min: 0.01, max: 1.2, step: 0.01, unit: 'u', group: SHAPE }),
        P('speedMin', 'Speed min', 'num', 0.5, { min: 0, max: 4, step: 0.01, unit: 'u/s', group: MOTION }),
        P('speedMax', 'Speed max', 'num', 1.6, { min: 0, max: 4, step: 0.01, unit: 'u/s', group: MOTION }),
        P('drag', 'Drag', 'num', 3, { min: 0, max: 12, step: 0.1, group: MOTION }),
        P('rise', 'Rise', 'num', 0.2, { min: -2, max: 2, step: 0.01, unit: 'u/s²', group: MOTION }),
        P('intensity', 'Opacity', 'num', 1, { min: 0, max: 1, step: 0.01, group: LOOK }),
        P('heat', 'Heat', 'num', 1.1, { min: 0.2, max: 1.6, step: 0.01, group: LOOK, help: 'Starting temperature. Higher = more white and yellow.' }),
        P('cooling', 'Cooling', 'num', 0.8, { min: 0, max: 1.5, step: 0.01, group: LOOK, help: 'How fast plumes cool toward red over their life.' }),
        P('erosion', 'Erosion', 'num', 0.5, { min: 0, max: 1, step: 0.01, group: LOOK, help: 'How strongly plumes break into tongues and wisps as they age.' }),
        P('noiseScale', 'Noise scale', 'num', 3.5, { min: 0.5, max: 10, step: 0.1, group: LOOK }),
        P('colorCore', 'Core', 'color', 'white', { group: COLOR }),
        P('colorHot', 'Hot', 'color', 'hot', { group: COLOR }),
        P('colorMid', 'Mid', 'color', 'mid', { group: COLOR }),
        P('colorCool', 'Cool', 'color', 'deep', { group: COLOR }),
        P('colorEdge', 'Edge', 'color', 'ember', { group: COLOR }),
      ],
    },
  };

  function paramSpec(type, key) {
    const T = TYPES[type];
    return T && T.params.find(p => p.key === key);
  }

  // Fill in defaults and coerce; never mutates the input.
  function normalizeEffect(input) {
    const e = JSON.parse(JSON.stringify(input || {}));
    e.canvas = Object.assign({ size: 128, pixelSize: 48, fps: 30, frames: 24, mode: 'smooth', dither: true, alphaCut: 0.5 }, e.canvas || {});
    e.palette = Object.assign({}, e.palette || {});
    e.seed = Number.isFinite(e.seed) ? e.seed : 1;
    e.layers = (e.layers || []).filter(l => TYPES[l.type]).map(l => {
      const T = TYPES[l.type];
      const params = {};
      for (const p of T.params) params[p.key] = l.params && l.params[p.key] !== undefined ? l.params[p.key] : p.def;
      return { id: l.id, type: l.type, label: l.label || T.label, blend: l.blend || T.blend, enabled: l.enabled !== false, params };
    });
    e.checks = e.checks || [];
    return e;
  }

  // ------------------------------------------------------------- drawing
  function makeCtx(effect, frame) {
    const pixel = effect.canvas.mode === 'pixel';
    const size = pixel ? effect.canvas.pixelSize : effect.canvas.size;
    return { size, R: size / 2, cx: size / 2, cy: size / 2, fps: effect.canvas.fps, frame, pal: effect.palette };
  }
  const slot = (ctx, name) => hexToRgb(ctx.pal[name] !== undefined ? ctx.pal[name] : name);

  // Composite one premultiplied sample into a layer buffer.
  function put(buf, i, r, g, b, a, additive) {
    if (a <= 0) return;
    if (additive) {
      buf[i] += r * a; buf[i + 1] += g * a; buf[i + 2] += b * a; buf[i + 3] += a;
    } else {
      const k = 1 - Math.min(1, a);
      buf[i] = r * a + buf[i] * k; buf[i + 1] = g * a + buf[i + 1] * k;
      buf[i + 2] = b * a + buf[i + 2] * k; buf[i + 3] = a + buf[i + 3] * k;
    }
  }

  // Capsule (segment with radius) with 1px antialiasing plus optional softness.
  function capsule(buf, ctx, x0, y0, x1, y1, rad, col, alpha, soft, additive) {
    let gain = 1;
    if (rad < 0.5) { gain = (rad * 2) * (rad * 2); rad = 0.5; }
    const S = ctx.size, pad = rad + 1.5;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - pad)), maxX = Math.min(S - 1, Math.ceil(Math.max(x0, x1) + pad));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - pad)), maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1) + pad));
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
    const inner = rad * (1 - soft);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        let t = L2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x0 + dx * t - px, qy = y0 + dy * t - py;
        const d = Math.sqrt(qx * qx + qy * qy);
        if (d > rad + 0.5) continue;
        const cov = 1 - smoothstep(inner - 0.5, rad + 0.5, d);
        // Brighter toward the head of a streak.
        const headBias = L2 > 0 ? 0.35 + 0.65 * t : 1;
        put(buf, (y * S + x) * 4, col[0], col[1], col[2], alpha * cov * gain * headBias, additive);
      }
    }
  }

  // Closed-form motion with linear drag k (1/s) and constant acceleration (ax, ay).
  // Gives position at any time without stepping, so scrubbing is exact.
  function motion(x0, y0, vx, vy, ax, ay, k, t) {
    if (k < 1e-4) {
      return [x0 + vx * t + 0.5 * ax * t * t, y0 + vy * t + 0.5 * ay * t * t, vx + ax * t, vy + ay * t];
    }
    const e = Math.exp(-k * t), w = (1 - e) / k;
    return [
      x0 + vx * w + (ax / k) * (t - w),
      y0 + vy * w + (ay / k) * (t - w),
      vx * e + (ax / k) * (1 - e),
      vy * e + (ay / k) * (1 - e),
    ];
  }

  function spawnList(effect, layer, p, ctx) {
    const rng = mulberry32((effect.seed * 7919) ^ strHash(layer.id));
    const out = [];
    for (let i = 0; i < p.count; i++) {
      const birth = p.start + rng() * p.emitFrames;
      const life = Math.max(1, lerp(Math.min(p.lifeMin, p.lifeMax), Math.max(p.lifeMin, p.lifeMax), rng()));
      const dir = p.directionDeg !== undefined ? p.directionDeg : 90;
      const spread = p.spreadDeg !== undefined ? p.spreadDeg : 360;
      const ang = ((dir + (rng() - 0.5) * spread) * Math.PI) / 180;
      const spd = lerp(p.speedMin, p.speedMax, rng()) * ctx.R;
      const er = Math.sqrt(rng()) * p.emitRadius * ctx.R, ea = rng() * Math.PI * 2;
      out.push({
        birth, life,
        x0: ctx.cx + Math.cos(ea) * er, y0: ctx.cy + Math.sin(ea) * er,
        vx: Math.cos(ang) * spd, vy: -Math.sin(ang) * spd,
        jitter: lerp(0.7, 1.3, rng()), ox: rng() * 97, oy: rng() * 97,
      });
    }
    return out;
  }

  const RENDER = {
    glow(effect, layer, p, ctx, buf) {
      const f = ctx.frame - p.start;
      if (f < 0 || f >= p.duration) return;
      const t = p.duration <= 1 ? 1 : f / (p.duration - 1);
      const rad = Math.max(0.5, lerp(p.radiusStart, p.radiusEnd, ease(p.sizeEase, t)) * ctx.R);
      const fade = f < p.hold ? 1 : 1 - ease(p.fadeEase, (f - p.hold) / Math.max(1, p.duration - p.hold));
      const I = p.intensity * fade;
      if (I <= 0) return;
      const ci = slot(ctx, p.colorInner), co = slot(ctx, p.colorOuter);
      const S = ctx.size;
      const minX = Math.max(0, Math.floor(ctx.cx - rad)), maxX = Math.min(S - 1, Math.ceil(ctx.cx + rad));
      const minY = Math.max(0, Math.floor(ctx.cy - rad)), maxY = Math.min(S - 1, Math.ceil(ctx.cy + rad));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const d = Math.hypot(x + 0.5 - ctx.cx, y + 0.5 - ctx.cy) / rad;
          if (d >= 1) continue;
          const k = d <= p.core ? 0 : (d - p.core) / (1 - p.core);
          const v = Math.pow(1 - k, p.falloff) * I;
          const m = smoothstep(0, 1, k);
          put(buf, (y * S + x) * 4, lerp(ci[0], co[0], m), lerp(ci[1], co[1], m), lerp(ci[2], co[2], m), v, true);
        }
      }
    },

    ring(effect, layer, p, ctx, buf) {
      const f = ctx.frame - p.start;
      if (f < 0 || f >= p.duration) return;
      const t = p.duration <= 1 ? 1 : f / (p.duration - 1);
      const rad = lerp(p.radiusStart, p.radiusEnd, ease(p.sizeEase, t)) * ctx.R;
      const th = Math.max(0.75, lerp(p.thicknessStart, p.thicknessEnd, t) * ctx.R);
      const A = p.opacity * (1 - ease(p.fadeEase, t));
      if (A <= 0) return;
      const col = slot(ctx, p.color), cin = slot(ctx, p.colorInner);
      const seed = strHash(layer.id) & 0xffff;
      const S = ctx.size, ext = rad + th + 1;
      const minX = Math.max(0, Math.floor(ctx.cx - ext)), maxX = Math.min(S - 1, Math.ceil(ctx.cx + ext));
      const minY = Math.max(0, Math.floor(ctx.cy - ext)), maxY = Math.min(S - 1, Math.ceil(ctx.cy + ext));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const ux = x + 0.5 - ctx.cx, uy = y + 0.5 - ctx.cy;
          const d = Math.hypot(ux, uy);
          const dd = Math.abs(d - rad) / th;
          if (dd >= 1) continue;
          let v = 1 - smoothstep(Math.max(0, 1 - p.softness) * 0.999, 1, dd);
          if (p.breakup > 0 && d > 0) {
            // Sample noise on a circle so it wraps seamlessly around the ring.
            const n = fbm((ux / d) * p.breakupScale * 0.5 + 50, (uy / d) * p.breakupScale * 0.5 + 50 + t * 1.5, seed);
            v *= clamp01(lerp(1, (n - 0.25) * 2.2, p.breakup));
          }
          const m = d < rad ? clamp01((rad - d) / th) : 0;
          put(buf, (y * S + x) * 4, lerp(col[0], cin[0], m), lerp(col[1], cin[1], m), lerp(col[2], cin[2], m), v * A, true);
        }
      }
    },

    sparks(effect, layer, p, ctx, buf) {
      const list = spawnList(effect, layer, p, ctx);
      const c0 = slot(ctx, p.colorStart), c1c = slot(ctx, p.colorEnd);
      const g = p.gravity * ctx.R;
      for (const s of list) {
        const age = ctx.frame - s.birth;
        if (age < 0 || age > s.life) continue;
        const lt = age / s.life;
        const [x, y, vx, vy] = motion(s.x0, s.y0, s.vx, s.vy, 0, g, p.drag, age / ctx.fps);
        const alpha = p.intensity * (1 - ease(p.fadeEase, lt));
        if (alpha <= 0) continue;
        const col = [lerp(c0[0], c1c[0], lt), lerp(c0[1], c1c[1], lt), lerp(c0[2], c1c[2], lt)];
        const rad = p.size * ctx.R * s.jitter * (1 - p.shrink * lt);
        capsule(buf, ctx, x - vx * p.stretch, y - vy * p.stretch, x, y, rad, col, alpha, p.softness, layer.blend === 'add');
      }
    },

    smoke(effect, layer, p, ctx, buf) {
      const list = spawnList(effect, layer, Object.assign({ directionDeg: 90, spreadDeg: 360 }, p), ctx);
      const cl = slot(ctx, p.colorLit), cs = slot(ctx, p.color);
      const seed = strHash(layer.id) & 0xffff;
      const S = ctx.size, add = layer.blend === 'add';
      for (const s of list) {
        const age = ctx.frame - s.birth;
        if (age < 0 || age > s.life) continue;
        const lt = age / s.life;
        const [x, y] = motion(s.x0, s.y0, s.vx, s.vy, 0, -p.rise * ctx.R, p.drag, age / ctx.fps);
        const rad = lerp(p.sizeStart, p.sizeEnd, ease('outQuad', lt)) * ctx.R * s.jitter;
        const A = p.opacity * (1 - ease(p.fadeEase, lt)) * Math.min(1, (age + 1) / 2);
        if (A <= 0 || rad < 0.5) continue;
        const lit = p.litFraction > 0 ? 1 - smoothstep(0, p.litFraction, lt) : 0;
        const thr = p.erosion * lt;
        const minX = Math.max(0, Math.floor(x - rad)), maxX = Math.min(S - 1, Math.ceil(x + rad));
        const minY = Math.max(0, Math.floor(y - rad)), maxY = Math.min(S - 1, Math.ceil(y + rad));
        const ns = p.noiseScale / ctx.R;
        for (let py = minY; py <= maxY; py++) {
          for (let px = minX; px <= maxX; px++) {
            const dx = px + 0.5 - x, dy = py + 0.5 - y;
            const d = Math.sqrt(dx * dx + dy * dy) / rad;
            if (d >= 1) continue;
            const shape = 1 - smoothstep(0.3, 1, d);
            const n = fbm(dx * ns + s.ox, dy * ns + s.oy + lt * 0.8, seed);
            const dens = smoothstep(thr, thr + 0.3, shape * (0.25 + 1.25 * n));
            const a = A * dens;
            if (a <= 0.002) continue;
            const m = lit * (1 - d * 0.7);
            put(buf, (py * S + px) * 4, lerp(cs[0], cl[0], m), lerp(cs[1], cl[1], m), lerp(cs[2], cl[2], m), a, add);
          }
        }
      }
    },
  };

  // Temperature ramp: t = 1 core, .75 hot, .5 mid, .28 cool, 0 edge.
  function heatColor(stops, t) {
    const pos = [0, 0.28, 0.5, 0.75, 1];
    if (t >= 1) return stops[4];
    if (t <= 0) return stops[0];
    let i = 0; while (i < 3 && t > pos[i + 1]) i++;
    const k = (t - pos[i]) / (pos[i + 1] - pos[i]), a = stops[i], b = stops[i + 1];
    return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  }
  RENDER.fire = function (effect, layer, p, ctx, buf) {
    const list = spawnList(effect, layer, p, ctx);
    const stops = [p.colorEdge, p.colorCool, p.colorMid, p.colorHot, p.colorCore].map(c => slot(ctx, c));
    const seed = strHash(layer.id) & 0xffff;
    const S = ctx.size, add = layer.blend === 'add';
    for (const s of list) {
      const age = ctx.frame - s.birth;
      if (age < 0 || age > s.life) continue;
      const lt = age / s.life;
      const [x, y] = motion(s.x0, s.y0, s.vx, s.vy, 0, -p.rise * ctx.R, p.drag, age / ctx.fps);
      const rad = lerp(p.sizeStart, p.sizeEnd, ease('outQuad', lt)) * ctx.R * s.jitter;
      const A = p.intensity * (1 - ease(p.fadeEase, lt)) * Math.min(1, (age + 1) / 1.5);
      if (A <= 0 || rad < 0.5) continue;
      const T0 = p.heat * Math.max(0, 1 - p.cooling * lt);
      const thr = p.erosion * lt;
      const minX = Math.max(0, Math.floor(x - rad)), maxX = Math.min(S - 1, Math.ceil(x + rad));
      const minY = Math.max(0, Math.floor(y - rad)), maxY = Math.min(S - 1, Math.ceil(y + rad));
      const ns = p.noiseScale / ctx.R;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const dx = px + 0.5 - x, dy = py + 0.5 - y;
          const d = Math.sqrt(dx * dx + dy * dy) / rad;
          if (d >= 1) continue;
          const shape = 1 - smoothstep(0.25, 1, d);
          const n = fbm(dx * ns + s.ox, dy * ns + s.oy - lt * 1.2, seed);
          const body = shape * (0.25 + 1.25 * n);
          const dens = smoothstep(thr, thr + 0.28, body);
          const a = A * dens;
          if (a <= 0.002) continue;
          const c = heatColor(stops, T0 * Math.pow(Math.min(1.4, body), 1.4));
          put(buf, (py * S + px) * 4, c[0], c[1], c[2], a, add);
        }
      }
    }
  };

  // Render every enabled layer of one frame into its own premultiplied buffer.
  function renderLayers(effectIn, frame, opts) {
    const effect = effectIn.__norm ? effectIn : normalizeEffect(effectIn);
    opts = opts || {};
    const ctx = makeCtx(effect, frame);
    const out = [];
    for (const layer of effect.layers) {
      if (!layer.enabled) continue;
      if (opts.only && !opts.only.includes(layer.id)) continue;
      const buf = new Float32Array(ctx.size * ctx.size * 4);
      RENDER[layer.type](effect, layer, layer.params, ctx, buf);
      for (let i = 3; i < buf.length; i += 4) if (buf[i] > 1) buf[i] = 1;
      out.push({ id: layer.id, blend: layer.blend, buf });
    }
    return { size: ctx.size, layers: out };
  }

  // Flatten layers in order. With bg ([r,g,b]) the result is opaque over that colour;
  // without bg, a premultiplied transparent result (additive light counts toward alpha).
  function flatten(size, layers, bg) {
    const N = size * size, out = new Float32Array(N * 4);
    if (bg) for (let i = 0; i < N; i++) { out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 1; }
    for (const L of layers) {
      const b = L.buf;
      for (let i = 0; i < N * 4; i += 4) {
        if (L.blend === 'add') {
          out[i] += b[i]; out[i + 1] += b[i + 1]; out[i + 2] += b[i + 2];
          if (!bg) out[i + 3] = Math.min(1, out[i + 3] + Math.min(1, Math.max(b[i], b[i + 1], b[i + 2])));
        } else {
          const k = 1 - b[i + 3];
          out[i] = b[i] + out[i] * k; out[i + 1] = b[i + 1] + out[i + 1] * k;
          out[i + 2] = b[i + 2] + out[i + 2] * k; out[i + 3] = b[i + 3] + out[i + 3] * k;
        }
      }
    }
    for (let i = 0; i < out.length; i++) if (out[i] > 1) out[i] = 1;
    return out;
  }

  // ---------------------------------------------------------- pixel mode
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function paletteList(effect) {
    return Object.entries(effect.palette).map(([name, hex]) => ({ name, rgb: hexToRgb(hex) }));
  }
  function nearest(pal, r, g, b) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const c = pal[i].rgb, rm = (r + c[0]) / 2;
      const dr = r - c[0], dg = g - c[1], db = b - c[2];
      const d = (2 + rm) * dr * dr + 4 * dg * dg + (3 - rm) * db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // premultiplied float RGBA -> hard-alpha, palette-locked float RGBA (straight alpha)
  function pixelize(effect, size, prem) {
    const pal = paletteList(effect), out = new Float32Array(prem.length);
    const cut = effect.canvas.alphaCut, dither = effect.canvas.dither;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4, a = prem[i + 3];
        const thr = dither ? lerp(cut - 0.3, cut + 0.3, (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16) : cut;
        if (a < thr || a <= 0.02) continue;
        const r = prem[i] / a, g = prem[i + 1] / a, b = prem[i + 2] / a;
        const c = pal.length ? pal[nearest(pal, Math.min(1, r), Math.min(1, g), Math.min(1, b))].rgb : [r, g, b];
        out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 1;
      }
    }
    return out;
  }

  // ------------------------------------------------------ public render API
  // Final image of one frame as straight-alpha 0..255 RGBA, optionally over a bg colour.
  function renderFrame(effectIn, frame, opts) {
    const effect = normalizeEffect(effectIn); effect.__norm = true;
    opts = opts || {};
    const { size, layers } = renderLayers(effect, frame, opts);
    const bg = opts.bg ? (typeof opts.bg === 'string' ? hexToRgb(opts.bg) : opts.bg) : null;
    let img;
    if (effect.canvas.mode === 'pixel') {
      const px = pixelize(effect, size, flatten(size, layers, null));
      img = new Uint8ClampedArray(px.length);
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        const base = bg ? [bg[0] * (1 - a), bg[1] * (1 - a), bg[2] * (1 - a)] : [0, 0, 0];
        img[i] = (px[i] * a + base[0]) * 255; img[i + 1] = (px[i + 1] * a + base[1]) * 255;
        img[i + 2] = (px[i + 2] * a + base[2]) * 255; img[i + 3] = bg ? 255 : a * 255;
      }
    } else {
      const flat = flatten(size, layers, bg);
      img = toStraight8(flat);
    }
    return { size, data: img, layers };
  }

  function toStraight8(prem) {
    const img = new Uint8ClampedArray(prem.length);
    for (let i = 0; i < prem.length; i += 4) {
      const a = prem[i + 3];
      if (a <= 0) continue;
      img[i] = Math.min(1, prem[i] / a) * 255 + 0.5; img[i + 1] = Math.min(1, prem[i + 1] / a) * 255 + 0.5;
      img[i + 2] = Math.min(1, prem[i + 2] / a) * 255 + 0.5; img[i + 3] = a * 255 + 0.5;
    }
    return img;
  }

  // Export passes: contiguous runs of layers with the same blend mode become one
  // sprite each, drawn in order. Additive passes are RGB on black (alpha 1 where lit),
  // to be drawn with Add blending. Normal passes are straight alpha.
  // Pixel mode flattens to a single palette-locked normal pass.
  function passGroups(effectIn) {
    const effect = effectIn.__norm ? effectIn : normalizeEffect(effectIn);
    const pixel = effect.canvas.mode === 'pixel';
    const groups = [];
    for (const l of effect.layers) {
      if (!l.enabled) continue;
      const blend = pixel ? 'normal' : l.blend;
      const last = groups[groups.length - 1];
      if (last && (pixel || last.blend === blend)) last.layers.push(l.id); else groups.push({ blend, layers: [l.id] });
    }
    return groups.map((g, gi) => Object.assign(g, { name: 'g' + gi + '_' + g.blend }));
  }
  // One frame of every pass, as straight-alpha 8-bit RGBA images.
  function renderPassFrame(effectIn, frame, groups) {
    const effect = effectIn.__norm ? effectIn : Object.assign(normalizeEffect(effectIn), { __norm: true });
    groups = groups || passGroups(effect);
    const pixel = effect.canvas.mode === 'pixel';
    const { size, layers } = renderLayers(effect, frame);
    const images = groups.map(pass => {
      const ls = layers.filter(L => pass.layers.includes(L.id));
      if (pixel) return straight8FromFloat(pixelize(effect, size, flatten(size, ls, null)));
      if (pass.blend === 'add') {
        const flat = flatten(size, ls.map(L => Object.assign({}, L, { blend: 'add' })), [0, 0, 0]);
        const img = new Uint8ClampedArray(flat.length);
        for (let i = 0; i < flat.length; i += 4) {
          img[i] = flat[i] * 255 + 0.5; img[i + 1] = flat[i + 1] * 255 + 0.5; img[i + 2] = flat[i + 2] * 255 + 0.5;
          img[i + 3] = (flat[i] + flat[i + 1] + flat[i + 2]) > 0.004 ? 255 : 0;
        }
        return img;
      }
      return toStraight8(flatten(size, ls, null));
    });
    return { size, images, layers };
  }
  function exportPasses(effectIn) {
    const effect = Object.assign(normalizeEffect(effectIn), { __norm: true });
    const groups = passGroups(effect);
    const passes = groups.map(g => ({ name: g.name, blend: g.blend, layers: g.layers, frames: [] }));
    for (let f = 0; f < effect.canvas.frames; f++) {
      const r = renderPassFrame(effect, f, groups);
      r.images.forEach((img, i) => passes[i].frames.push(img));
    }
    const size = effect.canvas.mode === 'pixel' ? effect.canvas.pixelSize : effect.canvas.size;
    return { size, fps: effect.canvas.fps, frameCount: effect.canvas.frames, passes };
  }
  function straight8FromFloat(px) {
    const img = new Uint8ClampedArray(px.length);
    for (let i = 0; i < px.length; i++) img[i] = px[i] * 255 + 0.5;
    return img;
  }

  // ---------------------------------------------------------- attribution
  // Which layers produced the light/colour at pixel (x, y)? Shares sum to 1.
  function attribute(layers, size, x, y) {
    const i = (Math.floor(y) * size + Math.floor(x)) * 4;
    const hits = layers.map(L => {
      const b = L.buf;
      const w = L.blend === 'add' ? Math.max(b[i], b[i + 1], b[i + 2]) : b[i + 3];
      return { id: L.id, weight: w };
    }).filter(h => h.weight > 0.01);
    const total = hits.reduce((s, h) => s + h.weight, 0) || 1;
    return hits.map(h => ({ id: h.id, share: h.weight / total, weight: Math.min(1, h.weight) })).sort((a, b) => b.share - a.share);
  }

  // -------------------------------------------------------------- metrics
  // Per frame, for the whole effect and for each layer on its own:
  //   energy (brightness, normalised to a 128x128 frame), coverage, 90% radius (units),
  // plus overdraw and stray pixels for the whole effect. Summaries give peak/start/fade frames.
  // opts.keepFrames returns the final RGBA frames (over black) for image matching.
  function seriesSummary(energy, radius, coverage) {
    const F = energy.length, peak = Math.max(0, ...energy);
    let startFrame = -1, fadeFrame = 0;
    for (let f = 0; f < F; f++) {
      if (startFrame < 0 && energy[f] >= 0.02 * peak && peak > 0) startFrame = f;
      if (energy[f] >= 0.05 * peak && peak > 0) fadeFrame = f;
    }
    return {
      peakFrame: peak > 0 ? energy.indexOf(peak) : -1, startFrame, fadeFrame,
      peakEnergy: +peak.toFixed(1), maxRadius: Math.max(0, ...radius), maxCoverage: Math.max(0, ...coverage),
    };
  }
  function r90Of(hist, wsum) {
    let acc = 0;
    for (let b = 0; b < hist.length; b++) { acc += hist[b]; if (acc >= 0.9 * wsum) return (b + 1) / 32; }
    return 0;
  }
  function measure(effectIn, opts) {
    opts = opts || {};
    const effect = normalizeEffect(effectIn); effect.__norm = true;
    const F = effect.canvas.frames;
    const m = { energy: [], coverage: [], radius: [], overdraw: [], orphans: [] };
    const per = {};
    for (const l of effect.layers) if (l.enabled) per[l.id] = { energy: [], coverage: [], radius: [] };
    const frames = [];
    let size = 0;
    for (let f = 0; f < F; f++) {
      const r = renderFrame(effect, f, { bg: [0, 0, 0] });
      size = r.size;
      if (opts.keepFrames) frames.push(r.data);
      const N = size * size, cx = size / 2, R = size / 2, norm = 16384 / N;
      const distBin = p => { const x = (p % size) + 0.5 - cx, y = Math.floor(p / size) + 0.5 - cx; return Math.min(63, Math.floor((Math.hypot(x, y) / R) * 32)); };
      let layerHits = 0, union = 0;
      const any = new Uint8Array(N);
      for (const L of r.layers) {
        const b = L.buf, hist = new Float32Array(64);
        let e = 0, cov = 0, ws = 0;
        for (let p = 0; p < N; p++) {
          const i = p * 4;
          const w = L.blend === 'add' ? Math.max(b[i], b[i + 1], b[i + 2]) : b[i + 3];
          if (w > 0.02) { layerHits++; cov++; if (!any[p]) { any[p] = 1; union++; } }
          const lv = lum(Math.min(1, b[i]), Math.min(1, b[i + 1]), Math.min(1, b[i + 2]));
          e += lv;
          if (lv > 0.01) { hist[distBin(p)] += lv; ws += lv; }
        }
        const P = per[L.id];
        if (P) { P.energy.push(+(e * norm).toFixed(2)); P.coverage.push(+(cov / N).toFixed(4)); P.radius.push(+r90Of(hist, ws).toFixed(3)); }
      }
      let energy = 0, covered = 0, wsum = 0;
      const hist = new Float32Array(64);
      for (let p = 0; p < N; p++) {
        const i = p * 4, L = lum(r.data[i] / 255, r.data[i + 1] / 255, r.data[i + 2] / 255);
        energy += L;
        if (L > 0.02) { covered++; hist[distBin(p)] += L; wsum += L; }
      }
      let orphans = 0;
      if (effect.canvas.mode === 'pixel') {
        const A = p => r.data[p * 4] + r.data[p * 4 + 1] + r.data[p * 4 + 2] > 0;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const p = y * size + x;
          if (!A(p)) continue;
          const nb = (x > 0 && A(p - 1)) || (x < size - 1 && A(p + 1)) || (y > 0 && A(p - size)) || (y < size - 1 && A(p + size));
          if (!nb) orphans++;
        }
      }
      m.energy.push(+(energy * norm).toFixed(2));
      m.coverage.push(+(covered / N).toFixed(4));
      m.radius.push(+r90Of(hist, wsum).toFixed(3));
      m.overdraw.push(+(union ? layerHits / union : 0).toFixed(2));
      m.orphans.push(orphans);
    }
    const summary = Object.assign(seriesSummary(m.energy, m.radius, m.coverage), {
      maxOverdraw: Math.max(...m.overdraw),
      orphanPixels: m.orphans.reduce((a, b) => a + b, 0),
      layers: {},
    });
    for (const [id, P] of Object.entries(per)) summary.layers[id] = seriesSummary(P.energy, P.radius, P.coverage);
    const out = { perFrame: m, perLayer: per, summary, checks: evaluateChecks(effect, summary) };
    if (opts.keepFrames) { out.frames = frames; out.size = size; }
    return out;
  }
  // A check is {metric, op, value, layer?}. Without layer it reads the whole-effect summary.
  function metricValue(summary, c) {
    if (c.layer) return summary.layers && summary.layers[c.layer] ? summary.layers[c.layer][c.metric] : undefined;
    return summary[c.metric];
  }
  function evaluateChecks(effect, summary) {
    const ops = { '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '>': (a, b) => a > b, '==': (a, b) => a === b };
    return (effect.checks || []).map(c => {
      const v = metricValue(summary, c);
      const pass = v !== undefined && ops[c.op] ? ops[c.op](v, c.value) : null;
      return Object.assign({}, c, { actual: v, pass });
    });
  }

  // ------------------------------------------------------- image matching
  // Framing- and resolution-independent descriptors of a bright subject on a dark
  // background (a reference photo, or an effect frame rendered over black). The subject is
  // re-sampled so its 90% radius is 40 px before shape statistics are taken.
  function describeImage(rgba, w, h) {
    const L = new Float32Array(w * h);
    let sx = 0, sy = 0, sw = 0, lit = 0;
    for (let p = 0; p < w * h; p++) {
      const v = lum(rgba[p * 4] / 255, rgba[p * 4 + 1] / 255, rgba[p * 4 + 2] / 255);
      L[p] = v;
      if (v > 0.1) { lit++; sx += (p % w) * v; sy += Math.floor(p / w) * v; sw += v; }
    }
    if (lit < 30) return null;
    const cx = sx / sw, cy = sy / sw;
    const ds = [];
    for (let p = 0; p < w * h; p++) if (L[p] > 0.1) ds.push(Math.hypot((p % w) - cx, Math.floor(p / w) - cy));
    ds.sort((a, b) => a - b);
    const r90 = Math.max(2, ds[Math.floor(ds.length * 0.9)]);
    // resample to a 128x128 grid where r90 = 40 px (box filter over the source footprint)
    const G = 128, sc = r90 / 40, g = new Float32Array(G * G), rgb = new Float32Array(G * G * 3);
    const fp = Math.max(1, Math.round(sc));
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const ox = cx + (x - G / 2 + 0.5) * sc, oy = cy + (y - G / 2 + 0.5) * sc;
      let acc = 0, r = 0, gg = 0, b = 0, n = 0;
      for (let j = 0; j < fp; j++) for (let i = 0; i < fp; i++) {
        const px = Math.floor(ox + (i - (fp - 1) / 2)), py = Math.floor(oy + (j - (fp - 1) / 2));
        if (px < 0 || py < 0 || px >= w || py >= h) { n++; continue; }
        const q = py * w + px; acc += L[q]; r += rgba[q * 4]; gg += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; n++;
      }
      const k = y * G + x; g[k] = acc / n; rgb[k * 3] = r / n / 255; rgb[k * 3 + 1] = gg / n / 255; rgb[k * 3 + 2] = b / n / 255;
    }
    const bands = [0, 0, 0, 0, 0], ramp = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const radial = new Array(12).fill(0), radialN = new Array(12).fill(0);
    const ang = new Array(36).fill(null).map(() => []);
    let litG = 0, edge = 0, sparse = 0, outer = 0;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const k = y * G + x, v = g[k], dx = x + 0.5 - G / 2, dy = y + 0.5 - G / 2, d = Math.hypot(dx, dy) / 40;
      const rb = Math.min(11, Math.floor(d * 8)); radial[rb] += v; radialN[rb]++;
      if (v <= 0.1) continue;
      litG++;
      const bi = Math.min(4, Math.floor(((v - 0.1) / 0.9) * 5));
      bands[bi]++; ramp[bi][0] += rgb[k * 3]; ramp[bi][1] += rgb[k * 3 + 1]; ramp[bi][2] += rgb[k * 3 + 2];
      ang[Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 36) % 36].push(d);
      let nb = 0, nb4 = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        if (!i && !j) continue;
        const xx = x + i, yy = y + j;
        const on = xx >= 0 && yy >= 0 && xx < G && yy < G && g[yy * G + xx] > 0.1;
        if (on) { nb++; if (!i || !j) nb4++; }
      }
      if (nb4 < 4) edge++;
      if (nb <= 2) sparse++;
      if (d > 1.15) outer++;
    }
    for (let i = 0; i < 5; i++) { const n = bands[i] || 1; ramp[i] = ramp[i].map(c => +(c / n).toFixed(3)); bands[i] = +(bands[i] / litG).toFixed(4); }
    const lobeR = ang.map(a => { if (!a.length) return 0; a.sort((p, q) => p - q); return a[Math.floor(a.length * 0.9)]; });
    const meanR = lobeR.reduce((a, b) => a + b, 0) / 36;
    const lobes = Math.sqrt(lobeR.reduce((a, b) => a + (b - meanR) * (b - meanR), 0) / 36) / (meanR || 1);
    return {
      bands, ramp, radial: radial.map((v, i) => +(radialN[i] ? v / radialN[i] : 0).toFixed(4)),
      fill: +(litG / (Math.PI * 40 * 40)).toFixed(4), lobes: +lobes.toFixed(4),
      rough: +(edge / Math.sqrt(litG)).toFixed(4), speckle: +(sparse / litG).toFixed(4), outer: +(outer / litG).toFixed(4),
    };
  }
  // Similarity per aspect, each 0..1 (1 = same). Weights default to equal.
  function compareDescriptors(a, b, weights) {
    if (!a || !b) return null;
    const sim = (d, k) => Math.exp(-d / k);
    const l1 = (x, y) => x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0);
    const rampD = a.ramp.reduce((s, c, i) => s + l1(c, b.ramp[i]) * (a.bands[i] + b.bands[i]) / 2, 0);
    const aspects = {
      colour: sim(l1(a.bands, b.bands) + rampD * 2, 1.0),
      volume: sim(Math.abs(a.fill - b.fill) * 2 + l1(a.radial, b.radial) / 3, 0.8),
      shape: sim(Math.abs(a.lobes - b.lobes) * 3 + Math.abs(a.rough - b.rough) / 4, 0.6),
      debris: sim(Math.abs(a.speckle - b.speckle) * 6 + Math.abs(a.outer - b.outer) * 3, 0.3),
    };
    const W = Object.assign({ colour: 1, volume: 1, shape: 1, debris: 1 }, weights || {});
    let s = 0, n = 0;
    for (const k of Object.keys(aspects)) { aspects[k] = +aspects[k].toFixed(3); s += aspects[k] * W[k]; n += W[k]; }
    return Object.assign(aspects, { overall: +(s / n).toFixed(3) });
  }

  // --------------------------------------------------------- diff + patch
  // Human-readable list of what changed between two effect documents.
  function diff(aIn, bIn) {
    const a = normalizeEffect(aIn), b = normalizeEffect(bIn), out = [];
    const cmp = (path, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ path, from: x, to: y }); };
    for (const k of new Set([...Object.keys(a.canvas), ...Object.keys(b.canvas)])) cmp('canvas.' + k, a.canvas[k], b.canvas[k]);
    for (const k of new Set([...Object.keys(a.palette), ...Object.keys(b.palette)])) cmp('palette.' + k, a.palette[k], b.palette[k]);
    cmp('seed', a.seed, b.seed);
    const ids = new Set([...a.layers.map(l => l.id), ...b.layers.map(l => l.id)]);
    for (const id of ids) {
      const la = a.layers.find(l => l.id === id), lb = b.layers.find(l => l.id === id);
      if (!la) { out.push({ path: id, from: null, to: 'added (' + lb.type + ')' }); continue; }
      if (!lb) { out.push({ path: id, from: la.type, to: 'removed' }); continue; }
      cmp(id + '.enabled', la.enabled, lb.enabled);
      cmp(id + '.blend', la.blend, lb.blend);
      cmp(id + '.label', la.label, lb.label);
      for (const k of Object.keys(lb.params)) cmp(id + '.' + k, la.params[k], lb.params[k]);
    }
    const order = l => l.layers.map(x => x.id).join(',');
    if (order(a) !== order(b) && a.layers.length === b.layers.length) out.push({ path: 'layer order', from: order(a), to: order(b) });
    return out;
  }
  // Apply {"ring.radiusEnd": 0.8, "palette.hot": "#ffcc00", "canvas.frames": 30, "seed": 4}
  function applyPatch(effectIn, patch) {
    const e = normalizeEffect(effectIn);
    for (const [path, val] of Object.entries(patch || {})) {
      const [head, key] = path.split('.');
      if (head === 'palette') e.palette[key] = val;
      else if (head === 'canvas') e.canvas[key] = val;
      else if (head === 'seed') e.seed = val;
      else {
        const l = e.layers.find(x => x.id === head);
        if (!l) continue;
        if (key === 'enabled' || key === 'blend' || key === 'label') l[key] = val; else l.params[key] = val;
      }
    }
    return e;
  }

  return {
    EASE, TYPES, ease, paramSpec, normalizeEffect, renderLayers, renderFrame, flatten, exportPasses, passGroups, renderPassFrame,
    attribute, measure, evaluateChecks, metricValue, describeImage, compareDescriptors, diff, applyPatch, hexToRgb, rgbToHex, lum,
  };
});
