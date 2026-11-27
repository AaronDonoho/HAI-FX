/*
 * fxgpu.js: GPU layer types for HAI-FX (WebGL2). Load after fxcore.js; it registers itself.
 *
 * Each type is a GLSL ES 3.0 function `vec4 fx(vec2 uv)` returning PREMULTIPLIED rgba for the
 * pixel at uv (0..1, y down). The same source runs in the Studio (real GPU), in the tools
 * (headless Chromium, software GPU) and is the basis for runtime shader export.
 *
 * Built-ins available to every type:
 *   uniforms  u_time (s), u_frame, u_frames, u_phase (frame/frames, for loops), u_fps, u_size (px),
 *             u_seed, u_loop (0/1), u_tile (0/1), b_below (premultiplied composite of layers below),
 *             one uniform per parameter: u_<key> (float, vec3 for colours), s_<key> + u_<key>_size
 *             for sprite sources.
 *   helpers   P(uv) -> centred units (1 = half the frame), h21, vnoise/fbm (periodic when tiling),
 *             ridge, worley, ease(id, t), sdSeg, rot2, PER(cells), loopT(), src()/srcUV().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FXGPU = factory();
  if (root.FXCore && root.FXGPU) root.FXGPU.install(root.FXCore);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EASES = ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic', 'inQuart', 'outQuart', 'inExpo', 'outExpo', 'inSine', 'outSine', 'inOutSine', 'inBack', 'outBack'];

  const LIB = `
#define PI 3.14159265359
// Integer hash: bit-exact on every GPU and shader compiler (float hashes drift between engines).
// Inputs are quantised to 1/64, so integer lattice points and fixed seeds hash identically everywhere.
float h21(vec2 p) {
  ivec2 c = ivec2(floor(p * 64.0 + 0.5));
  uint h = uint(c.x) * 2654435761u + uint(c.y) * 2246822519u;
  h ^= h >> 15u; h *= 739982445u; h ^= h >> 12u; h *= 695872825u; h ^= h >> 15u;
  return float(h >> 8u) * (1.0 / 16777216.0);
}
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n + 17.17)); }
// Wrap an integer cell index into [0, per). The +0.5 keeps it exact on every GPU: mod() at exact
// multiples returns 0 on some drivers and per on others, which breaks tiling and engine matching.
vec2 wrapc(vec2 i, vec2 per) { return i - per * floor((i + 0.5) / per); }
// periodic value noise: per = period in cells (large = effectively none)
float vnoise(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float s = u_seed * 0.6180339;
  float a = h21(wrapc(i, per) + s), b = h21(wrapc(i + vec2(1.0, 0.0), per) + s);
  float c = h21(wrapc(i + vec2(0.0, 1.0), per) + s), d = h21(wrapc(i + vec2(1.0, 1.0), per) + s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, vec2 per, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * vnoise(p, per); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }
  return s / n;
}
float ridge(vec2 p, vec2 per, int oct) { return 1.0 - abs(fbm(p, per, oct) * 2.0 - 1.0); }
float worley(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p); float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)); vec2 o = h22(wrapc(i + g, per) + u_seed);
    d = min(d, length(g + o - f));
  }
  return d;
}
vec2 PER(float cells) { return u_tile > 0.5 ? vec2(cells) : vec2(4096.0); }
vec2 P(vec2 uv) { return uv * 2.0 - 1.0; }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(vec2(c, s), vec2(-s, c)); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float ease(float id, float t) {
  t = clamp(t, 0.0, 1.0); int k = int(id + 0.5);
  if (k == 1) return t * t; if (k == 2) return 1.0 - (1.0 - t) * (1.0 - t);
  if (k == 3) return t < 0.5 ? 2.0 * t * t : 1.0 - pow(-2.0 * t + 2.0, 2.0) / 2.0;
  if (k == 4) return t * t * t; if (k == 5) return 1.0 - pow(1.0 - t, 3.0);
  if (k == 6) return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
  if (k == 7) return t * t * t * t; if (k == 8) return 1.0 - pow(1.0 - t, 4.0);
  if (k == 9) return t <= 0.0 ? 0.0 : pow(2.0, 10.0 * t - 10.0); if (k == 10) return t >= 1.0 ? 1.0 : 1.0 - pow(2.0, -10.0 * t);
  if (k == 11) return 1.0 - cos(t * PI / 2.0); if (k == 12) return sin(t * PI / 2.0); if (k == 13) return -(cos(PI * t) - 1.0) / 2.0;
  if (k == 14) return 2.70158 * t * t * t - 1.70158 * t * t;
  if (k == 15) return 1.0 + 2.70158 * pow(t - 1.0, 3.0) + 1.70158 * pow(t - 1.0, 2.0);
  return t;
}
// time that wraps exactly once per loop when looping (0..1), seconds otherwise
float loopT() { return u_loop > 0.5 ? u_phase : u_time; }
float lumi(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

  // A sprite source is fitted inside the frame, centred, then scaled/offset/rotated by the layer.
  const SRC = (name, premulInShader, flipV) => `
vec2 srcUV_${name}(vec2 uv, float scale, vec2 off, float rotDeg) {
  vec2 sz = max(u_${name}_size, vec2(1.0));
  vec2 fit = sz / max(sz.x, sz.y);
  vec2 q = rot2(-rotDeg * PI / 180.0) * (uv - 0.5 - off * 0.5) / (max(scale, 1e-3) * fit);
  return q + 0.5;
}
vec4 src_${name}(vec2 st) {
  if (st.x < 0.0 || st.y < 0.0 || st.x > 1.0 || st.y > 1.0) return vec4(0.0);
  vec3 g = max(u_${name}_grid.xyz, vec3(1.0));
  float idx = floor(u_frame + 0.5); idx = idx - g.z * floor((idx + 0.5) / g.z);
  st = (vec2(idx - g.x * floor((idx + 0.5) / g.x), floor((idx + 0.5) / g.x)) + clamp(st, 0.001, 0.999)) / g.xy;
  vec4 c = texture(s_${name}, ${flipV ? 'vec2(st.x, 1.0 - st.y)' : 'st'});
  return ${premulInShader ? 'vec4(c.rgb * c.a, c.a)' : 'c'};
}
`;

  const P = (key, label, type, def, extra) => Object.assign({ key, label, type, def }, extra || {});
  const T = 'Timing', SH = 'Shape', MO = 'Motion', LK = 'Look', CO = 'Color', SR = 'Sprite';
  const SPRITE = [P('source', 'Sprite', 'source', '', { group: SR }), P('scale', 'Scale', 'num', 0.8, { min: 0.1, max: 2, step: 0.01, group: SR }),
    P('offsetX', 'Offset X', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SR }), P('offsetY', 'Offset Y', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SR }),
    P('rotation', 'Rotation', 'angle', 0, { min: -180, max: 180, step: 1, unit: '°', group: SR })];
  const SAMPLE = `srcUV_source(uv, u_scale, vec2(u_offsetX, u_offsetY), u_rotation)`;

  const TYPES = {
    electric: {
      label: 'Electricity', blend: 'add',
      cost: p => 6 * (1 + (p.branches || 0)) * 2,
      params: [
        P('start', 'Start', 'frame', 0, { min: 0, max: 120, group: T }), P('duration', 'Duration', 'frame', 24, { min: 1, max: 240, group: T }),
        P('hold', 'Reshape every', 'frame', 2, { min: 1, max: 30, group: T }), P('fadeEase', 'Fade curve', 'ease', 'inQuad', { group: T }),
        P('ax', 'From X', 'num', -0.85, { min: -1.2, max: 1.2, step: 0.01, unit: 'u', group: SH }), P('ay', 'From Y', 'num', 0, { min: -1.2, max: 1.2, step: 0.01, unit: 'u', group: SH }),
        P('bx', 'To X', 'num', 0.85, { min: -1.2, max: 1.2, step: 0.01, unit: 'u', group: SH }), P('by', 'To Y', 'num', 0, { min: -1.2, max: 1.2, step: 0.01, unit: 'u', group: SH }),
        P('jag', 'Jaggedness', 'num', 0.22, { min: 0, max: 0.8, step: 0.01, unit: 'u', group: SH }), P('freq', 'Kinks', 'num', 9, { min: 1, max: 30, step: 0.5, group: SH }),
        P('branches', 'Branches', 'int', 3, { min: 0, max: 6, group: SH }), P('branchLen', 'Branch length', 'num', 0.35, { min: 0.05, max: 1, step: 0.01, group: SH }),
        P('thick', 'Core width', 'num', 0.012, { min: 0.002, max: 0.08, step: 0.001, unit: 'u', group: LK }), P('glow', 'Glow radius', 'num', 0.06, { min: 0.005, max: 0.4, step: 0.005, unit: 'u', group: LK }),
        P('glowAmt', 'Glow', 'num', 0.9, { min: 0, max: 3, step: 0.05, group: LK }), P('flicker', 'Flicker', 'num', 0.35, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorCore', 'Core', 'color', 'white', { group: CO }), P('colorGlow', 'Glow', 'color', 'arc', { group: CO }),
      ],
      glsl: `
float bolt(vec2 p, vec2 a, vec2 b, float amp, float freq, float seed, out float s) {
  vec2 ab = b - a; float L = max(length(ab), 1e-4); vec2 d = ab / L, n = vec2(-d.y, d.x);
  s = clamp(dot(p - a, d) / L, 0.0, 1.0);
  float off = (fbm(vec2(s * freq, seed), vec2(4096.0), 5) - 0.5) * 2.0 * amp * sin(PI * s);
  return length(p - (a + d * s * L + n * off));
}
vec2 boltPoint(vec2 a, vec2 b, float s, float amp, float freq, float seed) {
  vec2 ab = b - a; float L = max(length(ab), 1e-4); vec2 d = ab / L, n = vec2(-d.y, d.x);
  return a + d * s * L + n * (fbm(vec2(s * freq, seed), vec2(4096.0), 5) - 0.5) * 2.0 * amp * sin(PI * s);
}
vec4 fx(vec2 uv) {
  float f = u_frame - u_start;
  if (u_loop < 0.5 && (f < 0.0 || f >= u_duration)) return vec4(0.0);
  float stepN = floor((u_loop > 0.5 ? u_phase * u_frames : f) / max(1.0, u_hold));
  float seed = stepN * 17.13 + 3.1;
  vec2 p = P(uv), a = vec2(u_ax, u_ay), b = vec2(u_bx, u_by);
  float s; float d = bolt(p, a, b, u_jag, u_freq, seed, s);
  float ang = atan(b.y - a.y, b.x - a.x);
  for (int i = 0; i < 6; i++) {
    if (float(i) >= u_branches) break;
    float fi = float(i);
    float si = 0.15 + 0.7 * h21(vec2(seed, fi + 1.0));
    vec2 base = boltPoint(a, b, si, u_jag, u_freq, seed);
    float ba = ang + (h21(vec2(fi, seed + 3.0)) - 0.5) * 2.2;
    vec2 e = base + u_branchLen * length(b - a) * (0.4 + 0.6 * h21(vec2(seed + 7.0, fi))) * vec2(cos(ba), sin(ba));
    float sb; float db = bolt(p, base, e, u_jag * 0.5, u_freq * 0.8, seed + fi * 5.0, sb);
    d = min(d, db + u_thick * 0.6 * sb);
  }
  float px = 2.0 / u_size;
  float core = 1.0 - smoothstep(u_thick, u_thick + px * 1.5, d);
  float glow = exp(-d / max(1e-3, u_glow)) * u_glowAmt;
  float fl = 1.0 - u_flicker * h21(vec2(stepN, 9.1));
  float env = u_loop > 0.5 ? 1.0 : 1.0 - ease(u_fadeEase, f / u_duration);
  vec3 col = u_colorCore * core + u_colorGlow * glow * (1.0 - core);
  return vec4(col, max(core, glow)) * fl * env;
}`,
    },

    waveform: {
      label: 'Waveform', blend: 'add',
      cost: p => 8 * (1 + (p.trail || 0)) + ((p.mode || 0) == 2 ? 24 : 0),
      params: [
        P('mode', 'Shape', 'choice', 0, { options: ['Harmonics', 'Heartbeat', 'Signal noise', 'Square', 'Sawtooth', 'Elastic pulse (slinky)', 'Plucked string'], group: SH }),
        P('damping', 'Damping', 'num', 3, { min: 0, max: 12, step: 0.1, help: 'Elastic and plucked shapes: how fast the motion dies away behind the pulse.', group: SH }),
        P('stiffness', 'Stiffness', 'num', 6, { min: 0.5, max: 20, step: 0.1, help: 'Elastic shape: ripples per unit of line trailing the pulse.', group: SH }),
        P('amp', 'Amplitude', 'num', 0.35, { min: 0, max: 1, step: 0.01, unit: 'u', group: SH }), P('freq', 'Cycles across', 'num', 2, { min: 0.25, max: 12, step: 0.25, group: SH }),
        P('harmonics', 'Harmonics', 'int', 3, { min: 1, max: 6, group: SH }), P('y', 'Baseline', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }),
        P('speed', 'Scroll', 'num', 1, { min: -6, max: 6, step: 0.25, help: 'Cycles per loop (whole numbers loop seamlessly) or per second.', group: MO }),
        P('thick', 'Line width', 'num', 0.012, { min: 0.002, max: 0.08, step: 0.001, unit: 'u', group: LK }), P('glow', 'Glow radius', 'num', 0.05, { min: 0.005, max: 0.3, step: 0.005, unit: 'u', group: LK }),
        P('glowAmt', 'Glow', 'num', 0.8, { min: 0, max: 3, step: 0.05, group: LK }), P('trail', 'Echoes', 'int', 3, { min: 0, max: 8, group: LK }),
        P('trailGap', 'Echo spacing', 'num', 0.04, { min: 0.005, max: 0.3, step: 0.005, group: LK }), P('grid', 'Grid', 'num', 0.15, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorLine', 'Line', 'color', 'trace', { group: CO }), P('colorGlow', 'Glow', 'color', 'traceGlow', { group: CO }),
      ],
      glsl: `
float wave(float x, float t) {
  float y = 0.0; int m = int(u_mode + 0.5); float ph = x * u_freq - t * u_speed;
  if (m == 0) { float n = 0.0; for (int i = 0; i < 6; i++) { if (float(i) >= u_harmonics) break; float k = float(i + 1); y += sin(2.0 * PI * ph * k + k * 1.7) / k; n += 1.0 / k; } y /= n; }
  else if (m == 1) { float q = fract(ph); y = exp(-pow((q - 0.5) * 30.0, 2.0)) - 0.35 * exp(-pow((q - 0.55) * 32.0, 2.0)) + 0.2 * exp(-pow((q - 0.75) * 10.0, 2.0)) - 0.08; }
  else if (m == 2) { y = (fbm(vec2(ph * 6.0, 3.3), vec2(u_freq * 6.0, 4096.0), 4) - 0.5) * 2.4; }
  else if (m == 3) { y = sin(2.0 * PI * ph) >= 0.0 ? 1.0 : -1.0; }
  else if (m == 4) { y = fract(ph) * 2.0 - 1.0; }
  else if (m == 5) {
    // a pulse travelling along a springy line: the line ahead is tugged slightly, the line behind rings and settles
    float s = fract(t * u_speed) * 1.6 - 0.3, d = s - x;
    y = d > 0.0 ? exp(-u_damping * d) * sin(2.0 * PI * u_stiffness * d + 1.2) * smoothstep(0.0, 0.06, d) / 0.93 : -0.18 * exp(d * 22.0);
  } else {
    // plucked string: a standing wave re-plucked each cycle, decaying
    float n = max(1.0, floor(u_freq + 0.5)), q = fract(t * u_speed);
    y = sin(PI * x * n) * cos(2.0 * PI * q * n * 3.0) * exp(-u_damping * q);
  }
  return u_y + y * u_amp;
}
float trace(vec2 p, float x, float t) {
  float e = 0.002, yc = wave(x, t);
  float slope = (wave(x + e, t) - wave(x - e, t)) / (4.0 * e);
  return abs(p.y - yc) / sqrt(1.0 + slope * slope);
}
vec4 fx(vec2 uv) {
  vec2 p = P(uv); float t = loopT(); float px = 2.0 / u_size;
  float d = trace(p, uv.x, t);
  float core = 1.0 - smoothstep(u_thick, u_thick + 1.5 * px, d);
  float glow = exp(-d / u_glow) * u_glowAmt;
  float echo = 0.0;
  for (int j = 1; j <= 8; j++) { if (float(j) > u_trail) break; float dj = trace(p, uv.x, t - float(j) * u_trailGap); echo += (1.0 - smoothstep(u_thick, u_thick + 2.0 * px, dj)) * pow(0.55, float(j)); }
  vec2 g = abs(fract(uv * 8.0 + 0.5) - 0.5) * u_size / 8.0;
  float grid = (1.0 - smoothstep(0.0, 1.0, min(g.x, g.y))) * u_grid * 0.35;
  vec3 col = u_colorLine * (core + echo * 0.6) + u_colorGlow * (glow + grid) * (1.0 - core);
  return vec4(col, clamp(max(core, glow + grid + echo * 0.6), 0.0, 1.0));
}`,
    },

    water: {
      label: 'Water', blend: 'normal',
      cost: p => 3 * (5 + 4) * 4 + 12,
      params: [
        P('scale', 'Wave scale', 'num', 4, { min: 1, max: 16, step: 1, help: 'Noise cells across the frame (whole numbers tile).', group: SH }),
        P('flow', 'Flow', 'num', 1, { min: 0, max: 4, step: 1, help: 'Whole tiles moved per loop.', group: MO }),
        P('waves', 'Wave strength', 'num', 0.6, { min: 0, max: 1.5, step: 0.01, group: SH }), P('caustics', 'Caustics', 'num', 0.5, { min: 0, max: 2, step: 0.01, group: LK }),
        P('specular', 'Specular', 'num', 0.6, { min: 0, max: 2, step: 0.01, group: LK }), P('foam', 'Foam', 'num', 0.15, { min: 0, max: 1, step: 0.01, group: LK }),
        P('lightAngle', 'Light angle', 'angle', -45, { min: -180, max: 180, step: 1, unit: '°', group: LK }), P('opacity', 'Opacity', 'num', 1, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorDeep', 'Deep', 'color', 'deep', { group: CO }), P('colorShallow', 'Shallow', 'color', 'shallow', { group: CO }),
        P('colorLight', 'Caustic', 'color', 'caustic', { group: CO }), P('colorFoam', 'Foam', 'color', 'foam', { group: CO }),
      ],
      glsl: `
float H(vec2 q, vec2 per, float sh) {
  return 0.6 * fbm(q + vec2(sh, 0.0), per, 5) + 0.4 * fbm(q * 2.0 + vec2(0.0, -sh * 2.0), per * 2.0, 4);
}
vec4 fx(vec2 uv) {
  float cells = max(1.0, floor(u_scale + 0.5)); vec2 per = PER(cells); vec2 q = uv * cells;
  float sh = u_loop > 0.5 ? floor(u_flow + 0.5) * cells * u_phase : u_time * u_flow * 0.25 * cells;
  float h = H(q, per, sh), e = 0.02;
  vec2 grad = vec2(H(q + vec2(e, 0.0), per, sh) - h, H(q + vec2(0.0, e), per, sh) - h) / e;
  vec3 n = normalize(vec3(-grad * u_waves * 0.25, 1.0));
  float la = u_lightAngle * PI / 180.0; vec3 L = normalize(vec3(cos(la), sin(la), 1.2));
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * u_specular;
  float caus = pow(ridge(q * 1.5 + vec2(sh * 1.5, sh * 0.0), per * 1.5, 3), 6.0) * u_caustics;
  vec3 col = mix(u_colorDeep, u_colorShallow, smoothstep(0.25, 0.8, h));
  col += u_colorLight * caus + vec3(spec);
  float fm = smoothstep(1.0 - u_foam * 0.5, 1.0 - u_foam * 0.5 + 0.08, h + u_foam * 0.3);
  col = mix(col, u_colorFoam, fm * step(0.001, u_foam));
  return vec4(min(col, vec3(1.0)), 1.0) * u_opacity;
}`,
    },

    clouds: {
      label: 'Clouds', blend: 'normal',
      cost: p => 2 * (p.detail || 5) * 4,
      params: [
        P('scale', 'Scale', 'num', 3, { min: 1, max: 12, step: 1, help: 'Cells across the frame (whole numbers tile).', group: SH }),
        P('coverage', 'Coverage', 'num', 0.5, { min: 0, max: 1, step: 0.01, group: SH }), P('softness', 'Softness', 'num', 0.25, { min: 0.01, max: 1, step: 0.01, group: SH }),
        P('detail', 'Detail', 'int', 5, { min: 1, max: 8, group: SH }),
        P('wind', 'Wind', 'num', 1, { min: -4, max: 4, step: 1, help: 'Whole tiles moved per loop.', group: MO }),
        P('lightAngle', 'Light angle', 'angle', -60, { min: -180, max: 180, step: 1, unit: '°', group: LK }), P('shadow', 'Self-shadow', 'num', 0.7, { min: 0, max: 2, step: 0.01, group: LK }),
        P('opacity', 'Opacity', 'num', 1, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorLight', 'Lit', 'color', 'cloud', { group: CO }), P('colorShadow', 'Shadow', 'color', 'cloudShadow', { group: CO }),
      ],
      glsl: `
float D(vec2 q, vec2 per) { return fbm(q, per, int(u_detail + 0.5)); }
vec4 fx(vec2 uv) {
  float cells = max(1.0, floor(u_scale + 0.5)); vec2 per = PER(cells);
  float sh = u_loop > 0.5 ? floor(u_wind + 0.5) * cells * u_phase : u_time * u_wind * 0.2 * cells;
  vec2 q = uv * cells + vec2(sh, 0.0);
  float d = D(q, per);
  float lo = 1.0 - u_coverage;
  float a = smoothstep(lo - u_softness * 0.5, lo + u_softness * 0.5, d);
  float la = u_lightAngle * PI / 180.0;
  float dl = D(q + vec2(cos(la), sin(la)) * 0.12, per);
  float lit = clamp(0.65 + (dl - d) * u_shadow * 6.0 + (d - lo) * 0.6, 0.0, 1.0);
  vec3 col = mix(u_colorShadow, u_colorLight, lit);
  return vec4(col * a, a) * u_opacity;
}`,
    },

    gears: {
      label: 'Gears', blend: 'normal',
      cost: p => 7 * ((p.teethC || 0) >= 6 ? 3 : 2) + 12,
      params: [
        P('teethA', 'Teeth A', 'int', 16, { min: 6, max: 60, group: SH }), P('teethB', 'Teeth B', 'int', 10, { min: 6, max: 60, group: SH }),
        P('teethC', 'Teeth C', 'int', 0, { min: 0, max: 60, help: '0 = no third gear.', group: SH }),
        P('module', 'Tooth size', 'num', 0.065, { min: 0.02, max: 0.2, step: 0.001, unit: 'u', group: SH }),
        P('angleB', 'B position', 'angle', 0, { min: -180, max: 180, step: 1, unit: '°', group: SH }), P('angleC', 'C position', 'angle', -70, { min: -180, max: 180, step: 1, unit: '°', group: SH }),
        P('x', 'Centre X', 'num', -0.3, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }), P('y', 'Centre Y', 'num', 0.05, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }),
        P('hole', 'Hub hole', 'num', 0.18, { min: 0, max: 0.6, step: 0.01, group: SH }), P('spokes', 'Spokes', 'int', 5, { min: 0, max: 8, group: SH }),
        P('speed', 'Turn', 'num', 1, { min: -8, max: 8, step: 1, help: 'Looping: multiples of the smallest turn that brings every gear back. Otherwise teeth per second.', group: MO }),
        P('bevel', 'Bevel', 'num', 0.03, { min: 0.002, max: 0.1, step: 0.001, unit: 'u', group: LK }), P('lightAngle', 'Light angle', 'angle', -135, { min: -180, max: 180, step: 1, unit: '°', group: LK }),
        P('shine', 'Shine', 'num', 0.6, { min: 0, max: 2, step: 0.01, group: LK }), P('shadow', 'Drop shadow', 'num', 0.5, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorMetal', 'Metal', 'color', 'metal', { group: CO }), P('colorDark', 'Dark', 'color', 'metalDark', { group: CO }), P('colorEdge', 'Edge light', 'color', 'metalLight', { group: CO }),
      ],
      glsl: `
float gear(vec2 p, float N, float m, float rot) {
  float rp = m * N * 0.5, ro = rp + m, rr = rp - 1.25 * m;
  float r = length(p), a = atan(p.y, p.x) - rot;
  float tt = fract(a * N / (2.0 * PI) + 0.5) - 0.5;
  float prof = smoothstep(0.34, 0.18, abs(tt));
  float d = r - mix(rr, ro, prof);
  float hole = u_hole * rr; d = max(d, hole - r);
  if (u_spokes > 0.5) {
    float w0 = hole + m * 0.9, w1 = rr - m * 1.1;
    float sa = fract(a * u_spokes / (2.0 * PI)) - 0.5;
    float win = max(max(w0 - r, r - w1), m * 0.8 - abs(sa) * 2.0 * PI * r / u_spokes);
    if (w1 > w0) d = max(d, -win);
  }
  return d;
}
// meshing: Y turns opposite to X; when a tooth of X points at Y, a gap of Y faces it
float meshRot(float th, float NX, float NY, float phi) { return phi + PI - PI / NY - (NX / NY) * (th - phi); }
int gcdI(int a, int b) { for (int i = 0; i < 64; i++) { if (b == 0) break; int t = a - (a / b) * b; a = b; b = t; } return max(a, 1); }
// teeth gear i must turn before its spokes repeat; every gear turns the same number of teeth
int closeTeeth(float N) { int n = int(N + 0.5), s = int(u_spokes + 0.5); return s > 0 ? n / gcdI(n, s) : 1; }
int lcmI(int a, int b) { return a / gcdI(a, b) * b; }
float scene(vec2 p) {
  float m = u_module, NA = floor(u_teethA + 0.5), NB = floor(u_teethB + 0.5), NC = floor(u_teethC + 0.5);
  int k0 = lcmI(closeTeeth(NA), closeTeeth(NB)); if (NC >= 6.0) k0 = lcmI(k0, closeTeeth(NC));
  float k = u_loop > 0.5 ? floor(u_speed + 0.5) * float(k0) * u_phase : u_time * u_speed;
  float thA = k * 2.0 * PI / NA;
  vec2 cA = vec2(u_x, u_y);
  float phiB = u_angleB * PI / 180.0; vec2 cB = cA + (NA + NB) * m * 0.5 * vec2(cos(phiB), sin(phiB));
  float thB = meshRot(thA, NA, NB, phiB);
  float d = min(gear(p - cA, NA, m, thA), gear(p - cB, NB, m, thB));
  if (NC >= 6.0) {
    float phiC = u_angleC * PI / 180.0; vec2 cC = cB + (NB + NC) * m * 0.5 * vec2(cos(phiC), sin(phiC));
    d = min(d, gear(p - cC, NC, m, meshRot(thB, NB, NC, phiC)));
  }
  return d;
}
vec4 fx(vec2 uv) {
  vec2 p = P(uv); float px = 2.0 / u_size;
  float d = scene(p);
  float la = u_lightAngle * PI / 180.0; vec2 Ld = vec2(cos(la), sin(la));
  float ds = scene(p + Ld * u_bevel * 1.5);
  float sh = (1.0 - smoothstep(0.0, px * 3.0, ds)) * u_shadow * (1.0 - smoothstep(-px, px, -d));
  float cov = 1.0 - smoothstep(-px * 0.5, px * 0.5, d);
  if (cov <= 0.0 && sh <= 0.0) return vec4(0.0);
  float e = px;
  vec2 g = vec2(scene(p + vec2(e, 0.0)) - scene(p - vec2(e, 0.0)), scene(p + vec2(0.0, e)) - scene(p - vec2(0.0, e))) / (2.0 * e);
  float rim = 1.0 - smoothstep(0.0, u_bevel, -d);
  vec3 n = normalize(vec3(-g * rim * 1.4, 1.0));
  vec3 L = normalize(vec3(-Ld, 1.0));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 16.0) * u_shine;
  vec3 col = mix(u_colorDark, u_colorMetal, 0.35 + 0.65 * diff) + u_colorEdge * spec;
  col *= 0.92 + 0.08 * fbm(p * 18.0, vec2(4096.0), 3);
  vec4 gearC = vec4(col * cov, cov);
  return gearC + vec4(0.0, 0.0, 0.0, sh * 0.6) * (1.0 - cov);
}`,
    },

    sprite: {
      label: 'Sprite', blend: 'normal',
      cost: p => 2 + ((p.dissolveTo || 0) + (p.dissolveFrom || 0) > 0 ? 16 : 0),
      params: SPRITE.concat([
        P('start', 'Start', 'frame', 0, { min: 0, max: 240, group: T }), P('duration', 'Duration', 'frame', 24, { min: 1, max: 240, group: T }),
        P('tint', 'Tint', 'num', 0, { min: 0, max: 1, step: 0.01, group: LK }), P('colorTint', 'Tint colour', 'color', 'white', { group: LK }),
        P('flash', 'Flash', 'num', 0, { min: 0, max: 1, step: 0.01, group: LK }), P('flashes', 'Flash pulses', 'int', 0, { min: 0, max: 8, help: '0 = steady.', group: LK }),
        P('colorFlash', 'Flash colour', 'color', 'white', { group: LK }),
        P('dissolveFrom', 'Dissolve from', 'num', 0, { min: 0, max: 1, step: 0.01, group: LK }), P('dissolveTo', 'Dissolve to', 'num', 0, { min: 0, max: 1, step: 0.01, group: LK }),
        P('dissolveEase', 'Dissolve curve', 'ease', 'inOutQuad', { group: LK }), P('edge', 'Burn edge', 'num', 0.08, { min: 0, max: 0.3, step: 0.005, group: LK }),
        P('noiseScale', 'Noise scale', 'num', 6, { min: 1, max: 30, step: 0.5, group: LK }), P('colorEdge', 'Edge colour', 'color', 'arc', { group: LK }),
      ]),
      glsl: `
vec4 fx(vec2 uv) {
  float f = u_frame - u_start;
  if (u_loop < 0.5 && (f < 0.0 || f >= u_duration)) return vec4(0.0);
  float t = u_loop > 0.5 ? u_phase : clamp(f / max(1.0, u_duration - 1.0), 0.0, 1.0);
  vec4 c = src_source(${SAMPLE});
  if (c.a <= 0.0) return vec4(0.0);
  vec3 rgb = c.rgb / c.a;
  rgb = mix(rgb, rgb * u_colorTint, u_tint);
  float fl = u_flashes > 0.5 ? (0.5 + 0.5 * cos(2.0 * PI * t * u_flashes)) : 1.0;
  rgb = mix(rgb, u_colorFlash, u_flash * fl);
  float dv = mix(u_dissolveFrom, u_dissolveTo, ease(u_dissolveEase, t));
  float a = c.a;
  if (dv > 0.0) {
    float n = smoothstep(0.22, 0.78, fbm(${SAMPLE} * u_noiseScale, vec2(4096.0), 4));
    float th = dv * (1.0 + u_edge);
    a *= step(th, n + u_edge * 0.0);
    float rim = 1.0 - smoothstep(0.0, u_edge, n - th);
    rgb = mix(rgb, u_colorEdge, rim * step(th, n));
  }
  return vec4(rgb * a, a);
}`,
    },

    outline: {
      label: 'Outline', blend: 'normal',
      cost: p => ((p.mode || 0) == 2 ? 12 * 6 + 8 : 48),
      params: SPRITE.concat([
        P('mode', 'Edges of', 'choice', 0, { options: ['Silhouette (outside)', 'Silhouette (inside)', 'Areas of contrast'], group: SH }),
        P('width', 'Width', 'num', 2, { min: 0.5, max: 12, step: 0.5, unit: 'px', group: SH }), P('threshold', 'Contrast threshold', 'num', 0.25, { min: 0.01, max: 1, step: 0.01, group: SH }),
        P('softness', 'Softness', 'num', 0.3, { min: 0, max: 1, step: 0.01, group: LK }), P('glow', 'Glow', 'num', 0, { min: 0, max: 2, step: 0.01, group: LK }),
        P('pulse', 'Pulse', 'num', 0, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorLine', 'Colour', 'color', 'ink', { group: CO }),
      ],
      ),
      glsl: `
float A(vec2 st) { return src_source(st).a; }
float Lc(vec2 st) { vec4 c = src_source(st); return lumi(c.rgb) + c.a * 0.5; }
vec4 fx(vec2 uv) {
  vec2 st = ${SAMPLE};
  vec2 texel = 1.0 / max(u_source_size, vec2(1.0));
  float pxS = 1.0 / (u_size * max(u_scale, 1e-3) * (max(u_source_size.x, u_source_size.y) / max(u_source_size.x, u_source_size.y)));
  vec2 stepv = vec2(1.0 / u_size) / max(u_scale, 1e-3);
  int m = int(u_mode + 0.5);
  float e = 0.0;
  if (m == 2) {
    vec2 o = stepv;
    float gx = Lc(st + vec2(o.x, 0.0)) - Lc(st - vec2(o.x, 0.0)) + 0.5 * (Lc(st + o) - Lc(st - o) + Lc(st + vec2(o.x, -o.y)) - Lc(st + vec2(-o.x, o.y)));
    float gy = Lc(st + vec2(0.0, o.y)) - Lc(st - vec2(0.0, o.y)) + 0.5 * (Lc(st + o) - Lc(st - o) - Lc(st + vec2(o.x, -o.y)) + Lc(st + vec2(-o.x, o.y)));
    float g = length(vec2(gx, gy));
    float best = g;
    for (int i = 0; i < 12; i++) { float an = float(i) * PI / 6.0; vec2 dd = vec2(cos(an), sin(an)) * stepv * u_width;
      vec2 s2 = st + dd;
      float gx2 = Lc(s2 + vec2(o.x, 0.0)) - Lc(s2 - vec2(o.x, 0.0)); float gy2 = Lc(s2 + vec2(0.0, o.y)) - Lc(s2 - vec2(0.0, o.y));
      best = max(best, length(vec2(gx2, gy2)) * 0.85); }
    e = smoothstep(u_threshold, u_threshold + 0.05 + u_softness * 0.5, best);
  } else {
    float a0 = A(st), mx = 0.0, mn = 1.0;
    for (int r = 1; r <= 3; r++) for (int i = 0; i < 16; i++) {
      float an = float(i) * PI / 8.0; vec2 dd = vec2(cos(an), sin(an)) * stepv * u_width * float(r) / 3.0;
      float ai = A(st + dd); mx = max(mx, ai); mn = min(mn, ai);
    }
    e = m == 0 ? mx * (1.0 - a0) : a0 * (1.0 - mn);
    e = smoothstep(0.0, 1.0 - u_softness * 0.8, e);
  }
  float pl = 1.0 - u_pulse * (0.5 + 0.5 * cos(2.0 * PI * loopT()));
  float a = clamp(e * pl * (1.0 + u_glow), 0.0, 1.0);
  return vec4(u_colorLine * a, a);
}`,
    },

    shade: {
      label: 'Lighting', blend: 'normal',
      cost: p => 5 * 25 + 5,
      params: SPRITE.concat([
        P('lightAngle', 'Light angle', 'angle', -135, { min: -180, max: 180, step: 1, unit: '°', group: LK }), P('elevation', 'Light height', 'num', 0.5, { min: 0.05, max: 1, step: 0.01, group: LK }),
        P('depth', 'Surface depth', 'num', 1.5, { min: 0, max: 6, step: 0.05, group: LK }), P('roundness', 'Roundness', 'num', 3, { min: 0.5, max: 16, step: 0.5, unit: 'px', group: LK }),
        P('detail', 'Detail relief', 'num', 0.5, { min: 0, max: 2, step: 0.01, help: 'How much colour brightness reads as surface bumps.', group: LK }),
        P('ambient', 'Ambient', 'num', 0.45, { min: 0, max: 1, step: 0.01, group: LK }), P('intensity', 'Light', 'num', 0.9, { min: 0, max: 2, step: 0.01, group: LK }),
        P('specular', 'Specular', 'num', 0.25, { min: 0, max: 2, step: 0.01, group: LK }), P('rim', 'Rim light', 'num', 0.3, { min: 0, max: 2, step: 0.01, group: LK }),
        P('orbit', 'Orbit light', 'num', 0, { min: -4, max: 4, step: 1, help: 'Turns of the light per loop.', group: MO }),
        P('colorLight', 'Light colour', 'color', 'white', { group: CO }), P('colorAmbient', 'Ambient colour', 'color', 'ambient', { group: CO }),
      ]),
      glsl: `
float HT(vec2 st, vec2 o) {
  float a = 0.0, w = 0.0;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) { float k = exp(-float(i * i + j * j) * 0.35); a += src_source(st + vec2(float(i), float(j)) * o * u_roundness * 0.5).a * k; w += k; }
  vec4 c = src_source(st);
  return a / w + (c.a > 0.0 ? lumi(c.rgb / c.a) : 0.0) * u_detail * 0.25;
}
vec4 fx(vec2 uv) {
  vec2 st = ${SAMPLE};
  vec4 c = src_source(st);
  if (c.a <= 0.0) return vec4(0.0);
  vec2 o = vec2(1.0 / u_size) / max(u_scale, 1e-3);
  float hx = HT(st + vec2(o.x, 0.0), o) - HT(st - vec2(o.x, 0.0), o), hy = HT(st + vec2(0.0, o.y), o) - HT(st - vec2(0.0, o.y), o);
  vec3 n = normalize(vec3(-hx * u_depth * 4.0, -hy * u_depth * 4.0, 1.0));
  float la = u_lightAngle * PI / 180.0 + 2.0 * PI * u_orbit * (u_loop > 0.5 ? u_phase : u_time * 0.1);
  vec3 L = normalize(vec3(cos(la) * (1.0 - u_elevation), sin(la) * (1.0 - u_elevation), u_elevation + 0.05));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 20.0) * u_specular;
  float rim = pow(1.0 - n.z, 2.0) * u_rim * max(dot(normalize(n.xy + 1e-5), normalize(L.xy + 1e-5)), 0.0);
  vec3 base = c.rgb / c.a;
  vec3 col = base * (u_colorAmbient * u_ambient + u_colorLight * diff * u_intensity) + u_colorLight * (spec + rim);
  return vec4(min(col, vec3(1.0)) * c.a, c.a);
}`,
    },

    age: {
      label: 'Weathering', blend: 'normal',
      cost: p => 13 + 3 * 4 * 4 + 2 * 36,
      params: SPRITE.concat([
        P('rust', 'Rust', 'num', 0.4, { min: 0, max: 1, step: 0.01, group: LK }), P('grime', 'Grime', 'num', 0.5, { min: 0, max: 1, step: 0.01, group: LK }),
        P('chips', 'Chipped edges', 'num', 0.3, { min: 0, max: 1, step: 0.01, group: LK }), P('cracks', 'Cracks', 'num', 0.2, { min: 0, max: 1, step: 0.01, group: LK }),
        P('fade', 'Sun fade', 'num', 0.2, { min: 0, max: 1, step: 0.01, group: LK }), P('moss', 'Moss', 'num', 0, { min: 0, max: 1, step: 0.01, group: LK }),
        P('noiseScale', 'Wear scale', 'num', 8, { min: 2, max: 40, step: 0.5, group: SH }), P('exposure', 'Edge exposure', 'num', 3, { min: 0.5, max: 12, step: 0.5, unit: 'px', group: SH }),
        P('age', 'Age over time', 'num', 0, { min: 0, max: 1, step: 0.01, help: 'Animate from new to fully aged across the frames.', group: T }),
        P('colorRust', 'Rust', 'color', 'rust', { group: CO }), P('colorGrime', 'Grime', 'color', 'grime', { group: CO }), P('colorMoss', 'Moss', 'color', 'moss', { group: CO }),
      ]),
      glsl: `
vec4 fx(vec2 uv) {
  vec2 st = ${SAMPLE};
  vec4 c = src_source(st);
  if (c.a <= 0.0) return vec4(0.0);
  vec2 o = vec2(1.0 / u_size) / max(u_scale, 1e-3);
  float mn = 1.0, lsum = 0.0;
  for (int i = 0; i < 12; i++) { float an = float(i) * PI / 6.0; vec2 d = vec2(cos(an), sin(an)) * o * u_exposure; vec4 s = src_source(st + d); mn = min(mn, s.a); lsum += s.a > 0.0 ? lumi(s.rgb / s.a) : 0.0; }
  float exposed = 1.0 - mn;
  vec3 base = c.rgb / c.a; float lu = lumi(base);
  float crevice = clamp(lsum / 12.0 - lu, 0.0, 1.0) * 3.0;
  float grow = u_age > 0.0 ? mix(1.0 - u_age, 1.0, u_loop > 0.5 ? u_phase : clamp(u_frame / max(1.0, u_frames - 1.0), 0.0, 1.0)) : 1.0;
  vec2 q = st * u_noiseScale; vec2 per = vec2(4096.0);
  float n1 = fbm(q, per, 5), n2 = fbm(q * 2.3 + 7.0, per, 4);
  float rustM = smoothstep(1.0 - u_rust * grow, 1.0 - u_rust * grow + 0.15, n1 * 0.75 + exposed * 0.35 + 0.1);
  vec3 col = mix(base, u_colorRust * (0.75 + 0.5 * n2), rustM * 0.9);
  col *= 1.0 - u_grime * grow * clamp(crevice + (1.0 - n2) * 0.25, 0.0, 1.0) * 0.8;
  col = mix(col, u_colorGrime, u_grime * grow * smoothstep(0.55, 0.9, n2) * 0.35);
  float mossM = smoothstep(1.0 - u_moss * grow, 1.0 - u_moss * grow + 0.2, (1.0 - n1) * 0.6 + crevice * 0.5 + (st.y) * 0.3);
  col = mix(col, u_colorMoss * (0.8 + 0.4 * n2), mossM * 0.85);
  float w = worley(q * 0.6, per); float w2 = worley(q * 0.6 + 0.37, per);
  float crack = (1.0 - smoothstep(0.0, 0.06, abs(w - w2))) * step(1.0 - u_cracks * grow, n2 + 0.3);
  col *= 1.0 - crack * 0.6;
  col = mix(col, vec3(lumi(col)) * 1.1 + 0.08, u_fade * grow * 0.7);
  float a = c.a * (1.0 - step(1.0 - u_chips * grow * exposed, fbm(q * 1.7 + 3.0, per, 3)) * step(0.01, u_chips));
  return vec4(clamp(col, 0.0, 1.0) * a, a);
}`,
    },

    normals: {
      label: 'Normal map', blend: 'normal',
      params: SPRITE.concat([
        P('depth', 'Surface depth', 'num', 1.5, { min: 0, max: 6, step: 0.05, group: LK }), P('roundness', 'Roundness', 'num', 3, { min: 0.5, max: 16, step: 0.5, unit: 'px', group: LK }),
        P('detail', 'Detail relief', 'num', 0.5, { min: 0, max: 2, step: 0.01, help: 'How much colour brightness reads as surface bumps.', group: LK }),
        P('flipY', 'Green channel', 'choice', 0, { options: ['Y up (OpenGL, Godot)', 'Y down (DirectX)'], group: LK }),
      ]),
      cost: p => 55,
      glsl: `
float HT(vec2 st, vec2 o) {
  float a = 0.0, w = 0.0;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) { float k = exp(-float(i * i + j * j) * 0.35); a += src_source(st + vec2(float(i), float(j)) * o * u_roundness * 0.5).a * k; w += k; }
  vec4 c = src_source(st);
  return a / w + (c.a > 0.0 ? lumi(c.rgb / c.a) : 0.0) * u_detail * 0.25;
}
vec4 fx(vec2 uv) {
  vec2 st = ${SAMPLE};
  vec4 c = src_source(st);
  if (c.a <= 0.0) return vec4(0.0);
  vec2 o = vec2(1.0 / u_size) / max(u_scale, 1e-3);
  float hx = HT(st + vec2(o.x, 0.0), o) - HT(st - vec2(o.x, 0.0), o), hy = HT(st + vec2(0.0, o.y), o) - HT(st - vec2(0.0, o.y), o);
  vec3 n = normalize(vec3(-hx * u_depth * 4.0, (u_flipY > 0.5 ? -1.0 : 1.0) * hy * u_depth * 4.0, 1.0));
  return vec4((n * 0.5 + 0.5) * c.a, c.a);
}`,
    },

    bubbles: {
      label: 'Bubbles', blend: 'normal',
      cost: p => (p.count || 24) * 3,
      params: [
        P('count', 'Bubbles', 'int', 24, { min: 1, max: 64, group: SH }),
        P('sizeMin', 'Size min', 'num', 0.018, { min: 0.004, max: 0.2, step: 0.002, unit: 'u', group: SH }), P('sizeMax', 'Size max', 'num', 0.05, { min: 0.004, max: 0.3, step: 0.002, unit: 'u', group: SH }),
        P('x', 'Centre X', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }), P('width', 'Spread', 'num', 1.5, { min: 0, max: 2.4, step: 0.01, unit: 'u', group: SH }),
        P('bottom', 'Start Y', 'num', 1.05, { min: -1.2, max: 1.2, step: 0.01, unit: 'u', group: SH }), P('surface', 'Pop Y', 'num', -0.75, { min: -1.2, max: 1.2, step: 0.01, unit: 'u', group: SH }),
        P('speed', 'Rise', 'num', 1, { min: 0, max: 6, step: 0.25, help: 'Looping: trips per loop (whole numbers loop seamlessly). Otherwise trips per second.', group: MO }),
        P('wobble', 'Wobble', 'num', 0.03, { min: 0, max: 0.2, step: 0.005, unit: 'u', group: MO }), P('wobbleFreq', 'Wobbles per trip', 'num', 3, { min: 0, max: 12, step: 0.5, group: MO }),
        P('pop', 'Pop length', 'num', 0.1, { min: 0, max: 0.4, step: 0.01, help: 'Share of each trip spent bursting at the top.', group: MO }),
        P('rim', 'Rim', 'num', 0.25, { min: 0.02, max: 0.8, step: 0.01, group: LK }), P('body', 'Body opacity', 'num', 0.15, { min: 0, max: 1, step: 0.01, group: LK }),
        P('highlight', 'Highlight', 'num', 0.8, { min: 0, max: 2, step: 0.01, group: LK }), P('opacity', 'Opacity', 'num', 0.9, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorRim', 'Rim', 'color', 'foam', { group: CO }), P('colorBody', 'Body', 'color', 'shallow', { group: CO }), P('colorHighlight', 'Highlight', 'color', 'white', { group: CO }),
      ],
      glsl: `
vec4 fx(vec2 uv) {
  vec2 p = P(uv); vec4 acc = vec4(0.0); float px = 2.0 / u_size;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= u_count) break;
    float fi = float(i), sz = h21(vec2(fi, 1.0));
    float r = mix(u_sizeMin, u_sizeMax, sz);
    float trips = u_loop > 0.5 ? max(1.0, floor(u_speed + 0.5)) * u_phase : u_time * u_speed * (0.75 + 0.5 * sz);
    float life = fract(h21(vec2(fi, 2.0)) + trips);
    vec2 c = vec2(u_x + (h21(vec2(fi, 3.0)) - 0.5) * u_width + sin(life * 2.0 * PI * u_wobbleFreq + fi * 1.7) * u_wobble, mix(u_bottom, u_surface, life));
    float popT = u_pop > 0.0 ? clamp((life - (1.0 - u_pop)) / u_pop, 0.0, 1.0) : 0.0;
    float rr = r * (1.0 + popT * 0.9), aa = px / rr;
    vec2 q = (p - c) / rr; float d = length(q);
    if (d > 1.0 + aa) continue;
    float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    float rim = smoothstep(1.0 - u_rim - aa, 1.0 - u_rim * 0.3, d) * inside;
    float hl = (1.0 - smoothstep(0.0, 0.32, length(q - vec2(-0.38, -0.38)))) * u_highlight * inside * (1.0 - popT);
    float fade = (1.0 - popT) * smoothstep(0.0, 0.06, life);
    float a = clamp(u_body * inside * (1.0 - popT) + rim + hl, 0.0, 1.0) * u_opacity * fade;
    vec3 col = mix(u_colorBody, u_colorRim, clamp(rim * 1.5, 0.0, 1.0)) + u_colorHighlight * hl;
    acc = vec4(min(col, vec3(1.0)) * a, a) + acc * (1.0 - a);
  }
  return acc;
}`,
    },

    gradient: {
      label: 'Gradient', blend: 'normal',
      cost: p => 0,
      params: [
        P('mode', 'Shape', 'choice', 0, { options: ['Linear', 'Radial'], group: SH }),
        P('angle', 'Direction', 'num', 90, { min: -180, max: 180, step: 1, unit: '°', help: 'Linear: from the start colour towards the end colour; 90 = top to bottom.', group: SH }),
        P('cx', 'Centre X', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }), P('cy', 'Centre Y', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }),
        P('radius', 'Radius', 'num', 1.2, { min: 0.05, max: 2, step: 0.01, unit: 'u', group: SH }),
        P('from', 'Start at', 'num', 0, { min: 0, max: 1, step: 0.01, group: SH }), P('to', 'End at', 'num', 1, { min: 0, max: 1, step: 0.01, group: SH }),
        P('mid', 'Middle at', 'num', 0.5, { min: 0.01, max: 0.99, step: 0.01, group: SH }), P('midAmount', 'Middle colour', 'num', 0, { min: 0, max: 1, step: 0.01, group: LK }),
        P('alphaStart', 'Start opacity', 'num', 1, { min: 0, max: 1, step: 0.01, group: LK }), P('alphaEnd', 'End opacity', 'num', 1, { min: 0, max: 1, step: 0.01, group: LK }),
        P('colorStart', 'Start', 'color', 'sky', { group: CO }), P('colorMid', 'Middle', 'color', 'white', { group: CO }), P('colorEnd', 'End', 'color', 'white', { group: CO }),
      ],
      glsl: `
vec4 fx(vec2 uv) {
  vec2 p = P(uv); float s;
  if (u_mode < 0.5) { float a = u_angle * PI / 180.0; s = dot(p, vec2(cos(a), sin(a))) * 0.5 + 0.5; }
  else s = length(p - vec2(u_cx, u_cy)) / max(0.05, u_radius);
  s = clamp((s - u_from) / max(0.001, u_to - u_from), 0.0, 1.0);
  vec3 c3 = s < u_mid ? mix(u_colorStart, u_colorMid, s / u_mid) : mix(u_colorMid, u_colorEnd, (s - u_mid) / (1.0 - u_mid));
  vec3 c = mix(mix(u_colorStart, u_colorEnd, s), c3, u_midAmount);
  float a = mix(u_alphaStart, u_alphaEnd, s);
  return vec4(c * a, a);
}`,
    },
    ripple: {
      label: 'Ripple', blend: 'replace', readsBelow: true,
      cost: p => 2,
      params: [
        P('start', 'Start', 'frame', 0, { min: 0, max: 120, group: T }), P('duration', 'Duration', 'frame', 24, { min: 1, max: 240, group: T }),
        P('cx', 'Centre X', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }), P('cy', 'Centre Y', 'num', 0, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }),
        P('reach', 'Reach', 'num', 1.2, { min: 0.1, max: 2, step: 0.01, unit: 'u', group: SH }), P('wavelength', 'Wavelength', 'num', 0.12, { min: 0.02, max: 0.5, step: 0.005, unit: 'u', group: SH }),
        P('rings', 'Ring width', 'num', 0.35, { min: 0.05, max: 1.5, step: 0.01, unit: 'u', group: SH }), P('strength', 'Distortion', 'num', 3, { min: 0, max: 16, step: 0.25, unit: 'px', group: LK }),
        P('highlight', 'Highlight', 'num', 0.25, { min: 0, max: 1, step: 0.01, group: LK }), P('sizeEase', 'Spread curve', 'ease', 'outQuad', { group: MO }),
        P('tilt', 'Perspective', 'num', 1, { min: 0.1, max: 1, step: 0.01, help: '1 = seen from above; lower squashes the rings for a surface seen at an angle.', group: SH }),
        P('colorLight', 'Highlight', 'color', 'white', { group: CO }),
      ],
      glsl: `
vec4 fx(vec2 uv) {
  float f = u_frame - u_start;
  vec4 base = texture(b_below, uv);
  if (u_loop < 0.5 && (f < 0.0 || f >= u_duration)) return base;
  float t = u_loop > 0.5 ? u_phase : f / max(1.0, u_duration);
  vec2 p = P(uv) - vec2(u_cx, u_cy); p.y /= max(0.1, u_tilt); float r = length(p);
  float front = ease(u_sizeEase, t) * u_reach;
  float env = exp(-pow((r - front) / max(0.01, u_rings * 0.5), 2.0)) * (1.0 - t);
  float w = sin(2.0 * PI * (r - front) / u_wavelength);
  vec2 dir = r > 1e-4 ? p / r : vec2(0.0);
  vec2 duv = dir * w * env * u_strength / u_size;
  vec4 c = texture(b_below, uv - duv);
  float hl = max(w, 0.0) * env * u_highlight;
  return c + vec4(u_colorLight * hl * c.a, 0.0);
}`,
    },

    reflect: {
      label: 'Reflection', blend: 'replace', readsBelow: true,
      cost: p => 6,
      params: [
        P('horizon', 'Surface Y', 'num', 0.35, { min: -1, max: 1, step: 0.01, unit: 'u', group: SH }), P('fade', 'Fade length', 'num', 0.6, { min: 0.05, max: 2, step: 0.01, unit: 'u', group: SH }),
        P('opacity', 'Opacity', 'num', 0.55, { min: 0, max: 1, step: 0.01, group: LK }), P('wobble', 'Wobble', 'num', 2, { min: 0, max: 12, step: 0.25, unit: 'px', group: LK }),
        P('wobbleFreq', 'Wobble size', 'num', 18, { min: 2, max: 60, step: 0.5, group: LK }), P('speed', 'Wobble speed', 'num', 1, { min: -6, max: 6, step: 1, group: MO }),
        P('blur', 'Blur', 'num', 1, { min: 0, max: 6, step: 0.25, unit: 'px', group: LK }), P('tint', 'Tint', 'num', 0.35, { min: 0, max: 1, step: 0.01, group: LK }),
        P('onto', 'Onto surfaces', 'num', 0, { min: 0, max: 1, step: 0.01, help: '0 = fills only empty space below the surface; 1 = also lies over opaque layers there (water).', group: LK }),
        P('colorTint', 'Tint colour', 'color', 'shallow', { group: CO }),
      ],
      glsl: `
vec4 fx(vec2 uv) {
  vec4 base = texture(b_below, uv);
  float hy = (u_horizon + 1.0) * 0.5;
  if (uv.y <= hy) return base;
  float dy = uv.y - hy;
  float t = loopT();
  float wob = sin(uv.y * u_wobbleFreq * 6.0 - 2.0 * PI * t * u_speed) + 0.5 * sin(uv.y * u_wobbleFreq * 11.0 + 2.0 * PI * t * u_speed);
  vec2 m = vec2(uv.x + wob * u_wobble / u_size * (0.4 + dy * 3.0), hy - dy);
  vec4 r = vec4(0.0); float wsum = 0.0;
  for (int i = -2; i <= 2; i++) { float k = exp(-float(i * i) * 0.5); r += texture(b_below, m + vec2(float(i) * u_blur / u_size, 0.0)) * k; wsum += k; }
  r /= wsum;
  r.rgb = mix(r.rgb, u_colorTint * r.a, u_tint);
  float fa = (1.0 - smoothstep(0.0, u_fade * 0.5, dy)) * u_opacity;
  return base * (1.0 - fa * u_onto * r.a) + r * fa * (u_onto + (1.0 - u_onto) * (1.0 - base.a));
}`,
    },
    pathlight: {
      label: 'Path-traced light', blend: 'replace', readsBelow: true,
      cost: p => ((p.mode || 0) > 0.5 ? 5 : 1) * ((p.samples || 48) * (p.steps || 40) + 2 * Math.max(1, (p.samples || 48) / 6) * (p.steps || 40)),
      params: [
        P('mode', 'Mode', 'choice', 0, { options: ['Scene (2D)', 'Relief (2.5D)'], group: SH }),
        P('samples', 'Rays per pixel', 'int', 48, { min: 4, max: 256, help: 'More rays = smoother light and shadows, slower render.', group: SH }),
        P('steps', 'Steps per ray', 'int', 40, { min: 8, max: 128, group: SH }),
        P('reach', 'Ray reach', 'num', 1.2, { min: 0.1, max: 3, step: 0.01, unit: 'u', group: SH }),
        P('occlude', 'Solid above alpha', 'num', 0.5, { min: 0.05, max: 1, step: 0.01, group: SH }),
        P('emitThreshold', 'Emits above brightness', 'num', 0.75, { min: 0, max: 1.01, step: 0.01, help: 'Pixels below this layer brighter than this act as lights.', group: LK }),
        P('emit', 'Emitted light', 'num', 2, { min: 0, max: 8, step: 0.05, group: LK }),
        P('bounce', 'Bounce light', 'num', 0.5, { min: 0, max: 2, step: 0.01, group: LK }),
        P('ambient', 'Ambient', 'num', 0.12, { min: 0, max: 1, step: 0.01, group: LK }),
        P('backdrop', 'Backdrop', 'num', 1, { min: 0, max: 1, step: 0.01, help: 'A surface behind everything that receives light and shadow (wall in 2D, ground in relief).', group: LK }),
        P('l1x', 'Light 1 X', 'num', -0.55, { min: -1.5, max: 1.5, step: 0.01, unit: 'u', group: 'Light 1' }), P('l1y', 'Light 1 Y', 'num', -0.45, { min: -1.5, max: 1.5, step: 0.01, unit: 'u', group: 'Light 1' }),
        P('l1r', 'Light 1 size', 'num', 0.08, { min: 0.005, max: 0.5, step: 0.005, unit: 'u', group: 'Light 1' }), P('l1i', 'Light 1 power', 'num', 1.4, { min: 0, max: 6, step: 0.05, group: 'Light 1' }),
        P('l1h', 'Light 1 height', 'num', 0.5, { min: 0, max: 2, step: 0.01, unit: 'u', help: 'Relief mode only.', group: 'Light 1' }),
        P('orbit', 'Light 1 orbit', 'num', 0, { min: -4, max: 4, step: 1, help: 'Turns around the centre per loop.', group: 'Light 1' }),
        P('flicker', 'Light 1 flicker', 'num', 0, { min: 0, max: 1, step: 0.01, group: 'Light 1' }),
        P('colorL1', 'Light 1 colour', 'color', 'torch', { group: 'Light 1' }),
        P('l2x', 'Light 2 X', 'num', 0.7, { min: -1.5, max: 1.5, step: 0.01, unit: 'u', group: 'Light 2' }), P('l2y', 'Light 2 Y', 'num', 0.5, { min: -1.5, max: 1.5, step: 0.01, unit: 'u', group: 'Light 2' }),
        P('l2r', 'Light 2 size', 'num', 0.12, { min: 0.005, max: 0.5, step: 0.005, unit: 'u', group: 'Light 2' }), P('l2i', 'Light 2 power', 'num', 0, { min: 0, max: 6, step: 0.05, group: 'Light 2' }),
        P('colorL2', 'Light 2 colour', 'color', 'cool', { group: 'Light 2' }),
        P('depth', 'Relief depth', 'num', 0.25, { min: 0.01, max: 1, step: 0.01, unit: 'u', group: 'Relief' }), P('soft', 'Relief rounding', 'num', 3, { min: 0, max: 12, step: 0.5, unit: 'px', group: 'Relief' }),
        P('sunAngle', 'Sun direction', 'angle', -135, { min: -180, max: 180, step: 1, unit: '°', group: 'Relief' }), P('sunElev', 'Sun height', 'num', 0.35, { min: 0.05, max: 1, step: 0.01, group: 'Relief' }),
        P('sunSize', 'Sun size', 'num', 0.08, { min: 0, max: 0.6, step: 0.01, help: 'Bigger = softer shadows.', group: 'Relief' }), P('sun', 'Sun power', 'num', 1.1, { min: 0, max: 4, step: 0.05, group: 'Relief' }),
        P('colorAmbient', 'Ambient / sky', 'color', 'sky', { group: CO }), P('colorSun', 'Sun', 'color', 'white', { group: CO }), P('colorBackdrop', 'Backdrop', 'color', 'stone', { group: CO }),
      ],
      glsl: `
// Every read of the layers below goes through BELOW() inside fx(), so runtime export can redirect it.
#define BELOW(q) texture(b_below, q)
#define INSIDE(q) (q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0)
float rnd(vec2 px, float i) { return h21(px * 7.0 + vec2(i * 13.0 + 0.5, i * 29.0 + 3.0)); }
vec2 light1() {
  float a = 2.0 * PI * u_orbit * (u_loop > 0.5 ? u_phase : u_time * 0.1);
  return rot2(a) * vec2(u_l1x, u_l1y);
}
float falloff(float d, float r) { return 1.0 / (1.0 + pow(d / max(r * 4.0, 0.05), 2.0)); }
vec4 fx(vec2 uv) {
  vec2 px = floor(uv * u_size);
  vec4 base = BELOW(uv);
  bool solid = base.a > u_occlude;
  vec3 alb = base.a > 0.0 ? base.rgb / base.a : u_colorBackdrop;
  vec2 p = P(uv);
  int ns = int(u_samples + 0.5), nt = int(u_steps + 0.5);
  float fl = 1.0 - u_flicker * h21(vec2(floor(u_frame / 2.0), 5.0));
  vec2 L1 = light1(), L2 = vec2(u_l2x, u_l2y);
  vec3 direct = vec3(0.0), ind = vec3(0.0);
  float sky = 1.0;
  if (u_mode < 0.5) {
    // ---- 2D scene: soft shadows from the lights, light from bright pixels, one bounce
    for (int k = 0; k < 2; k++) {
      vec2 Lc = k == 0 ? L1 : L2; float Lr = k == 0 ? u_l1r : u_l2r;
      float Li = (k == 0 ? u_l1i * fl : u_l2i);
      if (Li <= 0.0) continue;
      int nl = max(1, ns / 6); float vis = 0.0;
      for (int s = 0; s < 64; s++) {
        if (s >= nl) break;
        float ra = rnd(px, float(s) + 100.0 * float(k + 1)) * 2.0 * PI, rr = sqrt(rnd(px, float(s) + 300.0)) * Lr;
        vec2 tgt = (Lc + vec2(cos(ra), sin(ra)) * rr + 1.0) * 0.5;
        bool outside = !solid; float v = 1.0;
        for (int j = 1; j <= 128; j++) {
          if (j > nt) break;
          vec2 q = mix(uv, tgt, float(j) / float(nt));
          if (BELOW(q).a > u_occlude) { if (outside) { v = 0.0; break; } } else outside = true;
        }
        vis += v;
      }
      direct += (k == 0 ? u_colorL1 : u_colorL2) * Li * falloff(length(p - Lc), Lr) * vis / float(nl);
    }
    for (int i = 0; i < 256; i++) {
      if (i >= ns) break;
      float a = (float(i) + rnd(px, float(i))) / float(ns) * 2.0 * PI;
      vec2 dir = vec2(cos(a), sin(a)) * u_reach * 0.5;
      bool outside = !solid;
      for (int j = 1; j <= 128; j++) {
        if (j > nt) break;
        vec2 q = uv + dir * (float(j) / float(nt));
        if (!INSIDE(q)) break;
        vec4 c = BELOW(q);
        if (c.a <= 0.02) { outside = true; continue; }
        vec3 ca = c.rgb / c.a;
        if (lumi(ca) * c.a >= u_emitThreshold * 0.9) { if (outside || !solid) { ind += ca * c.a * u_emit; break; } }
        if (c.a > u_occlude) {
          if (!outside) continue;
          vec2 qp = q * 2.0 - 1.0;
          vec3 lq = u_colorL1 * u_l1i * fl * falloff(length(qp - L1), u_l1r) + u_colorL2 * u_l2i * falloff(length(qp - L2), u_l2r);
          ind += ca * lq * u_bounce;
          break;
        }
        outside = true;
      }
    }
    ind /= float(ns);
  } else {
    // ---- relief: sprites become height fields; sun with soft shadows, sky occlusion, point light
    #define HGT(q) (u_depth * (0.2 * step(u_occlude, BELOW(q).a) + 0.8 * (BELOW(q + vec2(o.x, 0.0)).a + BELOW(q - vec2(o.x, 0.0)).a + BELOW(q + vec2(0.0, o.y)).a + BELOW(q - vec2(0.0, o.y)).a) * 0.25))
    vec2 o = vec2(max(u_soft, 0.5) / u_size);
    float h0 = HGT(uv);
    vec2 grad = vec2(HGT(uv + vec2(1.0 / u_size, 0.0)) - HGT(uv - vec2(1.0 / u_size, 0.0)), HGT(uv + vec2(0.0, 1.0 / u_size)) - HGT(uv - vec2(0.0, 1.0 / u_size))) * u_size * 0.25;
    vec3 n = normalize(vec3(-grad, 1.0));
    float az = u_sunAngle * PI / 180.0, el = u_sunElev * PI * 0.5;
    int nl = max(1, ns / 4); float vis = 0.0;
    for (int s = 0; s < 64; s++) {
      if (s >= nl) break;
      float ja = az + (rnd(px, float(s) + 50.0) - 0.5) * u_sunSize * 2.0, je = el + (rnd(px, float(s) + 70.0) - 0.5) * u_sunSize;
      vec3 d = vec3(cos(ja) * cos(je), sin(ja) * cos(je), sin(je));
      float v = 1.0;
      for (int j = 1; j <= 128; j++) {
        if (j > nt) break;
        float t = float(j) / float(nt) * u_reach;
        vec2 q = uv + d.xy * t * 0.5; float z = h0 + d.z * t + 0.002;
        if (!INSIDE(q)) break;
        if (HGT(q) > z) { v = 0.0; break; }
      }
      vis += v;
    }
    vis /= float(nl);
    float sunDot = max(dot(n, vec3(cos(az) * cos(el), sin(az) * cos(el), sin(el))), 0.0);
    direct = u_colorSun * u_sun * sunDot * vis;
    vec3 lp = vec3(L1, u_l1h); vec3 ld = lp - vec3(p, h0); float ll = length(ld);
    if (u_l1i > 0.0) {
      float v = 1.0;
      for (int j = 1; j <= 128; j++) {
        if (j > nt) break;
        vec3 q3 = vec3(p, h0) + ld * (float(j) / float(nt));
        vec2 q = (q3.xy + 1.0) * 0.5;
        if (!INSIDE(q)) break;
        if (HGT(q) > q3.z + 0.002) { v = 0.0; break; }
      }
      direct += u_colorL1 * u_l1i * fl * falloff(ll, u_l1r) * max(dot(n, ld / max(ll, 1e-4)), 0.0) * v;
    }
    float occl = 0.0;
    for (int i = 0; i < 256; i++) {
      if (i >= ns) break;
      float a = (float(i) + rnd(px, float(i))) / float(ns) * 2.0 * PI, e2 = asin(sqrt(rnd(px, float(i) + 500.0)));
      vec3 d = vec3(cos(a) * cos(e2), sin(a) * cos(e2), sin(e2));
      for (int j = 1; j <= 128; j++) {
        if (j > nt / 2) break;
        float t = float(j) / float(nt) * u_reach;
        vec2 q = uv + d.xy * t * 0.5; float z = h0 + d.z * t + 0.002;
        if (!INSIDE(q)) break;
        if (HGT(q) > z) { occl += 1.0; break; }
      }
    }
    sky = 1.0 - occl / float(ns);
  }
  vec3 light = u_colorAmbient * u_ambient * sky + direct + ind;
  vec3 selfEmit = lumi(alb) * base.a >= u_emitThreshold ? alb * (u_emit * 0.35 + 0.65) : vec3(0.0);
  vec3 lit = max(selfEmit, alb * light);
  vec3 back = u_colorBackdrop * light * u_backdrop;
  return vec4(lit * base.a + back * (1.0 - base.a), base.a + u_backdrop * (1.0 - base.a));
}`,
    },
  };

  // ------------------------------------------------------------ WebGL2 runtime
  let gl = null, canvas = null, floatOK = false, vbo = null;
  const programs = {}, textures = {};
  function ctx3(size) {
    if (!gl) {
      canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : document.createElement('canvas');
      gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL2 is not available');
      floatOK = !!gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('OES_texture_float_linear');
      vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    }
    return gl;
  }
  function uniformDecls(def) {
    const out = [];
    for (const p of def.params) {
      if (p.type === 'color') out.push(`uniform vec3 u_${p.key};`);
      else if (p.type === 'source') out.push(`uniform sampler2D s_${p.key};`, `uniform vec2 u_${p.key}_size;`, `uniform vec4 u_${p.key}_grid;`);
      else out.push(`uniform float u_${p.key};`);
    }
    return out.join('\n');
  }
  function fragmentSource(name) {
    const def = TYPES[name];
    const srcs = def.params.filter(p => p.type === 'source').map(p => SRC(p.key)).join('\n');
    return `#version 300 es
precision highp float;
uniform float u_time, u_frame, u_frames, u_phase, u_fps, u_size, u_seed, u_loop, u_tile;
uniform sampler2D b_below;
${uniformDecls(def)}
out vec4 o_color;
${LIB}
${srcs}
${def.glsl}
void main() {
  vec2 uv = vec2(gl_FragCoord.x, u_size - gl_FragCoord.y) / u_size;
  o_color = fx(uv);
}`;
  }
  function program(name) {
    if (programs[name]) return programs[name];
    const g = gl;
    const sh = (type, src) => {
      const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(`${name} shader: ${g.getShaderInfoLog(s)}`);
      return s;
    };
    const pr = g.createProgram();
    g.attachShader(pr, sh(g.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }'));
    g.attachShader(pr, sh(g.FRAGMENT_SHADER, fragmentSource(name)));
    g.bindAttribLocation(pr, 0, 'p');
    g.linkProgram(pr);
    if (!g.getProgramParameter(pr, g.LINK_STATUS)) throw new Error(`${name} link: ${g.getProgramInfoLog(pr)}`);
    const u = {}; const n = g.getProgramParameter(pr, g.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = g.getActiveUniform(pr, i); u[info.name] = g.getUniformLocation(pr, info.name); }
    return (programs[name] = { pr, u });
  }
  function texFromRGBA(key, data, w, h, isFloat) {
    const g = gl;
    let t = textures[key];
    if (!t) { t = textures[key] = { tex: g.createTexture() }; }
    g.bindTexture(g.TEXTURE_2D, t.tex);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (isFloat) g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, w, h, 0, g.RGBA, g.FLOAT, data);
    else g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, data);
    const filt = isFloat && !g.getExtension('OES_texture_float_linear') ? g.NEAREST : g.LINEAR;
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, filt); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, filt);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    return t.tex;
  }
  // sources: {id: {data: Uint8ClampedArray (straight RGBA), w, h, pixel?: bool}} -> premultiplied texture, cached by id+size
  const srcCache = {};
  function sourceTexture(src, id) {
    if (!src) return null;
    const key = 'src:' + id + ':' + src.w + 'x' + src.h;
    if (!srcCache[key]) {
      const pm = new Uint8Array(src.data.length);
      for (let i = 0; i < pm.length; i += 4) { const a = src.data[i + 3] / 255; pm[i] = src.data[i] * a; pm[i + 1] = src.data[i + 1] * a; pm[i + 2] = src.data[i + 2] * a; pm[i + 3] = src.data[i + 3]; }
      texFromRGBA(key, pm, src.w, src.h, false);
      srcCache[key] = textures[key].tex;
      const g = gl; g.bindTexture(g.TEXTURE_2D, srcCache[key]);
      if (src.pixel) { g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST); }
    }
    return srcCache[key];
  }
  const fbos = {};
  function target(size) {
    const k = size + (floatOK ? 'f' : 'b');
    if (fbos[k]) return fbos[k];
    const g = gl, tex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, tex);
    if (floatOK) g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, size, size, 0, g.RGBA, g.FLOAT, null);
    else g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, size, size, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    const fb = g.createFramebuffer(); g.bindFramebuffer(g.FRAMEBUFFER, fb);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
    return (fbos[k] = { fb, tex, read: floatOK ? new Float32Array(size * size * 4) : new Uint8Array(size * size * 4) });
  }

  // Render one GPU layer for one frame into buf (premultiplied Float32, y down).
  function render(effect, layer, p, ctx, buf) {
    const def = TYPES[layer.type], g = ctx3(ctx.size);
    const { pr, u } = program(layer.type);
    const S = ctx.size, tg = target(S);
    g.bindFramebuffer(g.FRAMEBUFFER, tg.fb); g.viewport(0, 0, S, S);
    g.disable(g.BLEND); g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT);
    g.useProgram(pr);
    g.bindBuffer(g.ARRAY_BUFFER, vbo); g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    const F = effect.canvas.frames, set1 = (n, v) => { if (u[n]) g.uniform1f(u[n], v); };
    set1('u_time', ctx.frame / ctx.fps); set1('u_frame', ctx.frame); set1('u_frames', F); set1('u_phase', ctx.frame / F);
    set1('u_fps', ctx.fps); set1('u_size', S); set1('u_seed', (effect.seed * 0.137) % 97); set1('u_loop', effect.canvas.loop ? 1 : 0); set1('u_tile', effect.canvas.tile ? 1 : 0);
    let unit = 0;
    const bindTex = (name, tex) => { if (!u[name]) return; g.activeTexture(g.TEXTURE0 + unit); g.bindTexture(g.TEXTURE_2D, tex); g.uniform1i(u[name], unit); unit++; };
    if (u.b_below) {
      const below = ctx.below || new Float32Array(S * S * 4);
      // flip rows so texture v follows the y-down convention used by uv
      // quantised to 8 bits like an engine's offscreen render target, so threshold tests agree everywhere
      const fl = new Float32Array(below.length);
      for (let i = 0; i < below.length; i++) fl[i] = Math.round(Math.min(1, below[i]) * 255) / 255;
      bindTex('b_below', texFromRGBA('below' + S, fl, S, S, true));
    }
    for (const sp of def.params) {
      const v = p[sp.key];
      if (sp.type === 'color') { const c = ctx.color(v); if (u['u_' + sp.key]) g.uniform3f(u['u_' + sp.key], c[0], c[1], c[2]); }
      else if (sp.type === 'source') {
        const src = ctx.sources && ctx.sources[v];
        const tex = sourceTexture(src, v) || texFromRGBA('empty', new Uint8Array(4), 1, 1, false);
        bindTex('s_' + sp.key, tex);
        const gr = (src && src.grid) || { cols: 1, rows: 1, frames: 1 };
        if (u['u_' + sp.key + '_size']) g.uniform2f(u['u_' + sp.key + '_size'], src ? src.w / gr.cols : 1, src ? src.h / gr.rows : 1);
        if (u['u_' + sp.key + '_grid']) g.uniform4f(u['u_' + sp.key + '_grid'], gr.cols, gr.rows, gr.frames, 0);
      } else if (sp.type === 'ease') set1('u_' + sp.key, Math.max(0, EASES.indexOf(v)));
      else set1('u_' + sp.key, +v || 0);
    }
    g.drawArrays(g.TRIANGLES, 0, 3);
    if (floatOK) g.readPixels(0, 0, S, S, g.RGBA, g.FLOAT, tg.read);
    else g.readPixels(0, 0, S, S, g.RGBA, g.UNSIGNED_BYTE, tg.read);
    const sc = floatOK ? 1 : 1 / 255, row = S * 4;
    for (let y = 0; y < S; y++) {
      const srcRow = (S - 1 - y) * row, dst = y * row;
      for (let i = 0; i < row; i++) buf[dst + i] = Math.max(0, tg.read[srcRow + i] * sc);
    }
  }

  // Every layer can be confined to a rectangle; fxcore applies it for the preview and bakes, the
  // exporters append AREA to live shaders (same formula as fxcore's applyArea).
  const AREA_P = [['areaTop', 'Top', -1], ['areaBottom', 'Bottom', 1], ['areaLeft', 'Left', -1], ['areaRight', 'Right', 1]]
    .map(([k, l, d]) => P(k, l, 'num', d, { min: -1, max: 1, step: 0.01, unit: 'u', group: 'Area', common: true }))
    .concat([P('areaSoft', 'Edge softness', 'num', 0, { min: 0, max: 0.5, step: 0.01, unit: 'u', group: 'Area', common: true })]);
  for (const d of Object.values(TYPES)) if (!d.params.some(p => p.key === 'areaTop')) d.params = d.params.concat(AREA_P);
  const AREA = `
float areaMask(vec2 uv) {
  if (u_areaTop <= -1.0 && u_areaBottom >= 1.0 && u_areaLeft <= -1.0 && u_areaRight >= 1.0) return 1.0;
  vec2 p = P(uv); float s = max(u_areaSoft, 1.0 / u_size);
  return smoothstep(u_areaTop - s, u_areaTop + s, p.y) * (1.0 - smoothstep(u_areaBottom - s, u_areaBottom + s, p.y))
    * smoothstep(u_areaLeft - s, u_areaLeft + s, p.x) * (1.0 - smoothstep(u_areaRight - s, u_areaRight + s, p.x));
}`;
  function install(FX) {
    if (FX.__gpuInstalled) return;
    for (const [name, def] of Object.entries(TYPES)) FX.registerType(name, Object.assign({ engine: 'gpu' }, def), (effect, layer, p, ctx, buf) => render(effect, layer, p, ctx, buf));
    FX.__gpuInstalled = true;
  }
  function available() { try { ctx3(8); return true; } catch (e) { return false; } }
  return { TYPES, LIB, SRC, EASES, AREA, install, available, fragmentSource, render };
});
