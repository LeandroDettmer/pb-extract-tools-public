#!/usr/bin/env node
// Procedural HD blood sprite sheets -> out/weapons/fx/tex/hd/tex_blood_{1,2}.png (see README.md).
// Deterministic: every texture has its own fixed seed, a re-run writes the same pixels.
//   node tools/bloodtex/gen.mjs [--out <dir>] [--size 512]
// Shapes are signed distance fields (px, negative inside) unioned with a smooth min, rendered at 2x the
// output size and box-filtered down in premultiplied space. Colour comes from the distance to the edge:
// dense dark core, mid-tone body, a thin darker rim (drying ring), low-frequency brightness variation.
// Texture axes: image right = +X, image top = +Y (three.js flipY). Spray of 'dir' splats goes to +X,
// drips of 'drip' splats run to -Y (image bottom).
'use strict';
import { assetPath } from '../lib/paths.mjs';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// sharp is not a dependency of this repo: SHARP_FROM = a package.json whose node_modules resolve it.
if (!process.env.SHARP_FROM) { console.error('pbx: bloodtex needs sharp: set SHARP_FROM to a package.json that resolves it'); process.exit(2); }
const sharp = createRequire(process.env.SHARP_FROM)('sharp');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT_DIR = resolve(process.cwd(), opt('--out', assetPath('weapons', 'fx', 'tex', 'hd')));
const OUT = Number(opt('--size', 512));
const SS = 2;
const N = OUT * SS;
/** all lengths below are authored for a 1024 px render and scaled by this */
const U = N / 1024;
const MARGIN = 14 * U;

// sRGB palette: thin film, dense core, dried rim, fine mist
const C_THIN = [132, 16, 22];
const C_THICK = [84, 8, 12];
const C_RIM = [58, 5, 8];
const C_MIST = [118, 14, 20];

// ---------------------------------------------------------------- random / noise
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const r = mulberry32(seed);
  const rng = {
    f: r,
    range: (a, b) => a + (b - a) * r(),
    int: (a, b) => a + Math.floor((b - a + 1) * r()),
    gauss: () => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
    exp: () => -Math.log(1 - r() * 0.999999),
  };
  return rng;
}
/** 2D gradient noise, ~[-1,1] */
function makeNoise(seed) {
  const r = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = new Float32Array(256), gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const a = r() * Math.PI * 2; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function n2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const g = (h, dx, dy) => gx[h] * dx + gy[h] * dy;
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1], ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    const u = fade(xf), v = fade(yf);
    const x1 = g(aa, xf, yf) + u * (g(ba, xf - 1, yf) - g(aa, xf, yf));
    const x2 = g(ab, xf, yf - 1) + u * (g(bb, xf - 1, yf - 1) - g(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 1.41;
  }
  function fbm(x, y, oct = 4) {
    let s = 0, a = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * n2(x * f, y * f); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }
  return { n2, fbm };
}

// ---------------------------------------------------------------- SDF canvas
const smin = (a, b, k) => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
function makeCanvas(seed) {
  const nz = makeNoise(seed ^ 0x9e3779b9);
  const main = new Float32Array(N * N).fill(1e6);
  const mist = new Float32Array(N * N).fill(1e6);
  // domain warp (organic wobble of every outline) + fine edge roughness
  const wx = new Float32Array(N * N), wy = new Float32Array(N * N), rough = new Float32Array(N * N);
  const WA = 5 * U, WL = 70 * U;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    wx[i] = WA * nz.fbm(x / WL, y / WL, 3);
    wy[i] = WA * nz.fbm(x / WL + 31.7, y / WL - 12.3, 3);
    rough[i] = 1.1 * U * nz.fbm(x / (7 * U) + 5.1, y / (7 * U) + 9.4, 2);
  }
  /** unions fn (sd in px at a warped point) into buf over the bbox [x0,x1]x[y0,y1] */
  function draw(buf, x0, y0, x1, y1, fn, k = 0, warp = 1) {
    const pad = k + 8 * U;
    const ax = Math.max(0, Math.floor(x0 - pad)), ay = Math.max(0, Math.floor(y0 - pad));
    const bx = Math.min(N - 1, Math.ceil(x1 + pad)), by = Math.min(N - 1, Math.ceil(y1 + pad));
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      const i = y * N + x;
      const s = fn(x + 0.5 + wx[i] * warp, y + 0.5 + wy[i] * warp);
      buf[i] = smin(buf[i], s, k);
    }
  }
  return { nz, main, mist, rough, draw };
}

// ---------------------------------------------------------------- primitives (sd, px)
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
function ellipse(cx, cy, rx, ry, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), m = Math.min(rx, ry);
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
    return (Math.hypot(u, v) - 1) * m;
  };
}
/** capsule a->b with radius ra at a, rb at b */
function taper(ax, ay, bx, by, ra, rb) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1e-6;
  return (x, y) => {
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2));
    return Math.hypot(x - ax - ex * t, y - ay - ey * t) - (ra + (rb - ra) * t);
  };
}
/** blob with a noisy radius; stretch > 0 elongates it toward angle dir */
function blob(cv, cx, cy, r0, amp, freq, off, stretch = 0, dir = 0, lobes = []) {
  return (x, y) => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
    const th = Math.atan2(dy, dx);
    let R = r0 * (1 + amp * cv.nz.fbm(Math.cos(th) * freq + off, Math.sin(th) * freq - off, 4));
    if (stretch) { const c = Math.max(0, Math.cos(th - dir)); R *= 1 + stretch * c * c; }
    for (const [la, lw, lh] of lobes) { const dd = Math.atan2(Math.sin(th - la), Math.cos(th - la)); R *= 1 + lh * Math.exp(-(dd * dd) / (lw * lw)); }
    return (d - R) * 0.9;
  };
}
const inside = (x, y, r = 0) => x - r > MARGIN && y - r > MARGIN && x + r < N - MARGIN && y + r < N - MARGIN;

// ---------------------------------------------------------------- building blocks
/** a flying droplet: ellipse stretched along travel angle + a tapering tail further out */
function droplet(cv, x, y, r, elong, ang, tail = true) {
  const rx = r * elong, ext = rx + (tail ? r * elong * 1.6 : 0);
  if (!inside(x, y, ext + 2 * U)) return;
  const c = Math.cos(ang), s = Math.sin(ang);
  cv.draw(cv.main, x - ext, y - ext, x + ext, y + ext, ellipse(x, y, rx, r, ang), 0);
  if (tail && elong > 1.35 && r > 2 * U) {
    const tx = x + c * rx * 0.6, ty = y + s * rx * 0.6;
    const ex = x + c * (rx + r * elong * 1.5), ey = y + s * (rx + r * elong * 1.5);
    cv.draw(cv.main, Math.min(tx, ex), Math.min(ty, ey), Math.max(tx, ex), Math.max(ty, ey), taper(tx, ty, ex, ey, r * 0.55, 0.6 * U), 2 * U);
  }
}
function mistDots(cv, rng, cx, cy, count, dir, spread, dmin, dmax, rmin, rmax) {
  for (let i = 0; i < count; i++) {
    const a = spread >= Math.PI ? rng.range(-Math.PI, Math.PI) : dir + rng.gauss() * spread;
    const d = dmin + (dmax - dmin) * Math.pow(rng.f(), 0.7);
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    const r = rmin + (rmax - rmin) * Math.pow(rng.f(), 2.2);
    if (!inside(x, y, r + 2)) continue;
    cv.draw(cv.mist, x - r, y - r, x + r, y + r, circle(x, y, r), 0, 0.3);
  }
}
/** jets: tapering streaks leaving the core in a cone; each one bends a little, thins out and breaks up
 *  into a trail of elongated droplets that shrink with distance */
function jets(cv, rng, cx, cy, r0, count, dir, spread, lmin, lmax) {
  for (let i = 0; i < count; i++) {
    let a = dir + rng.gauss() * spread;
    const L = r0 * rng.range(lmin, lmax);
    const solid = rng.range(0.3, 0.65);
    const bend = rng.gauss() * 0.08;
    let x = cx + Math.cos(a) * r0 * 0.75, y = cy + Math.sin(a) * r0 * 0.75;
    let r = r0 * Math.pow(rng.f(), 1.6) * 0.12 + 2.5 * U;
    const seg = 6, step = (L * solid) / seg;
    for (let k = 0; k < seg; k++) {
      a += bend;
      const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step, nr = r * rng.range(0.72, 0.86);
      if (!inside(nx, ny, r)) break;
      cv.draw(cv.main, Math.min(x, nx), Math.min(y, ny), Math.max(x, nx), Math.max(y, ny), taper(x, y, nx, ny, r, nr), 2.5 * U);
      x = nx; y = ny; r = nr;
    }
    // broken trail
    let d = 0;
    const rest = L * (1 - solid);
    let rr = Math.max(1.4 * U, r * rng.range(0.9, 1.4));
    while (d < rest && rr > 1.1 * U) {
      const g = rr * rng.range(1.5, 4.5);
      d += g + rr * 2;
      a += bend * 0.5 + rng.gauss() * 0.03;
      x += Math.cos(a) * (g + rr * 2); y += Math.sin(a) * (g + rr * 2);
      droplet(cv, x, y, rr, rng.range(1.6, 3), a);
      rr *= rng.range(0.7, 0.92);
    }
  }
}
/** radial satellite droplets: size falls and elongation grows with distance */
function satellites(cv, rng, cx, cy, r0, count, dir, spread, dmax, rmax) {
  for (let i = 0; i < count; i++) {
    const a = spread >= Math.PI ? rng.range(-Math.PI, Math.PI) : dir + rng.gauss() * spread;
    const f = Math.min(1, 0.08 + rng.exp() * 0.28);
    const d = r0 * 1.05 + (dmax - r0 * 1.05) * f;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    const r = Math.max(1.3 * U, rmax * Math.pow(1 - f, 1.6) * rng.range(0.25, 1));
    const elong = 1 + f * rng.range(0.6, 2.6);
    droplet(cv, x, y, r, elong, a);
  }
}
/** a drip running down (image +y) from (x, y0): wobbling tapered column ending in a bulb */
function drip(cv, rng, x, y0, w, L) {
  const seg = 14, pts = [];
  const ph = rng.range(0, 100);
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    pts.push([x + cv.nz.n2(ph, t * 2.2) * 5 * U * t, y0 + L * t, w * (1 - 0.35 * t) * (1 + 0.12 * cv.nz.n2(ph + 7, t * 5))]);
  }
  for (let i = 0; i < seg; i++) {
    const [ax, ay, ra] = pts[i], [bx, by, rb] = pts[i + 1];
    cv.draw(cv.main, Math.min(ax, bx) - ra, ay - ra, Math.max(ax, bx) + ra, by + rb, taper(ax, ay, bx, by, ra, rb), 3 * U, 0.35);
  }
  const [ex, ey, er] = pts[seg];
  const br = er * rng.range(1.45, 1.9);
  cv.draw(cv.main, ex - br, ey - br, ex + br, ey + br * 1.5, ellipse(ex, ey + br * 0.35, br, br * 1.25, Math.PI / 2), 5 * U, 0.35);
}

// ---------------------------------------------------------------- the three kinds
function genDir(cv, rng) {
  const dir = rng.range(-0.12, 0.12); // toward +X
  const cx = N * rng.range(0.27, 0.33), cy = N * rng.range(0.46, 0.54);
  const r0 = rng.range(62, 78) * U;
  const lobes = Array.from({ length: rng.int(4, 7) }, () => [dir + rng.gauss() * 1.3, rng.range(0.08, 0.2), rng.range(0.15, 0.45)]);
  cv.draw(cv.main, cx - r0 * 3.5, cy - r0 * 3.5, cx + r0 * 4, cy + r0 * 3.5, blob(cv, cx, cy, r0, 0.4, 2.2, rng.range(0, 50), 0.28, dir, lobes), 0);
  // secondary blobs overlapping the core toward +X: the core is never a clean disc
  for (let i = 0, n = rng.int(5, 8); i < n; i++) {
    const a = dir + rng.gauss() * 0.9, d = r0 * rng.range(0.55, 1.25), r = r0 * rng.range(0.16, 0.36);
    const bx = cx + Math.cos(a) * d, by = cy + Math.sin(a) * d;
    cv.draw(cv.main, bx - r * 2.5, by - r * 2.5, bx + r * 2.5, by + r * 2.5, blob(cv, bx, by, r, 0.4, 2, rng.range(0, 50)), 10 * U);
  }
  jets(cv, rng, cx, cy, r0, rng.int(16, 24), dir, 0.45, 1.8, 5.5);
  satellites(cv, rng, cx, cy, r0, rng.int(90, 130), dir, 0.42, N * 0.68, 17 * U);
  satellites(cv, rng, cx, cy, r0, rng.int(10, 18), 0, Math.PI, r0 * 1.9, 9 * U); // back/side spatter
  mistDots(cv, rng, cx, cy, rng.int(350, 520), dir, 0.5, r0 * 0.9, N * 0.7, 0.9 * U, 3.2 * U);
  if (rng.f() < 0.5) drip(cv, rng, cx + rng.range(-0.3, 0.3) * r0, cy + r0 * 0.6, rng.range(5, 7) * U, rng.range(0.12, 0.2) * N);
}
function genDrip(cv, rng) {
  const cx = N * rng.range(0.46, 0.54), cy = N * rng.range(0.3, 0.36);
  const r0 = rng.range(72, 88) * U;
  const lobes = Array.from({ length: rng.int(5, 8) }, () => [rng.range(-Math.PI, Math.PI), rng.range(0.1, 0.25), rng.range(0.2, 0.5)]);
  cv.draw(cv.main, cx - r0 * 3, cy - r0 * 3, cx + r0 * 3, cy + r0 * 3, blob(cv, cx, cy, r0, 0.38, 2.2, rng.range(0, 50), 0, 0, lobes), 0);
  for (let i = 0, n = rng.int(3, 5); i < n; i++) {
    const a = rng.range(-Math.PI, Math.PI), d = r0 * rng.range(0.6, 1.2), r = r0 * rng.range(0.2, 0.38);
    const bx = cx + Math.cos(a) * d, by = cy + Math.sin(a) * d;
    cv.draw(cv.main, bx - r * 2.5, by - r * 2.5, bx + r * 2.5, by + r * 2.5, blob(cv, bx, by, r, 0.4, 2, rng.range(0, 50)), 10 * U);
  }
  jets(cv, rng, cx, cy, r0, rng.int(8, 12), rng.range(-Math.PI, Math.PI), 2.5, 1.6, 3);
  satellites(cv, rng, cx, cy, r0, rng.int(35, 50), 0, Math.PI, r0 * 2.6, 13 * U);
  mistDots(cv, rng, cx, cy, rng.int(200, 300), 0, Math.PI, r0 * 1.0, r0 * 2.8, 0.9 * U, 2.8 * U);
  // drips leave the lower half of the core: several, uneven widths and lengths
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) {
    const t = (i + rng.range(0.2, 0.8)) / n;
    const x = cx + (t - 0.5) * 1.5 * r0;
    const y0 = cy + r0 * rng.range(0.35, 0.7) * Math.sqrt(Math.max(0.1, 1 - Math.pow((t - 0.5) * 1.5, 2)));
    const w = rng.range(4.5, 10) * U;
    const L = Math.min(N - MARGIN - 24 * U - y0, N * rng.range(0.18, 0.56));
    drip(cv, rng, x, y0, w, L);
  }
}
function genDrops(cv, rng) {
  const cx = N * 0.5, cy = N * 0.5;
  const dir = rng.range(-Math.PI, Math.PI);
  // a few medium drops, then a cloud of small ones, a handful elongated along a common cast-off line
  for (let i = 0, n = rng.int(3, 5); i < n; i++) {
    const x = cx + rng.gauss() * N * 0.13, y = cy + rng.gauss() * N * 0.13, r = rng.range(20, 42) * U;
    if (!inside(x, y, r * 1.6)) continue;
    cv.draw(cv.main, x - r * 1.6, y - r * 1.6, x + r * 1.6, y + r * 1.6, blob(cv, x, y, r, 0.35, 1.7, rng.range(0, 50)), 0);
    satellites(cv, rng, x, y, r, rng.int(5, 10), 0, Math.PI, r * 2.4, r * 0.28);
  }
  for (let i = 0, n = rng.int(40, 60); i < n; i++) {
    const x = cx + rng.gauss() * N * 0.2, y = cy + rng.gauss() * N * 0.2;
    const r = (2 + 14 * Math.pow(rng.f(), 2.4)) * U;
    const cast = rng.f() < 0.3;
    droplet(cv, x, y, r, cast ? rng.range(1.5, 2.6) : rng.range(1, 1.25), cast ? dir + rng.gauss() * 0.15 : rng.range(-Math.PI, Math.PI), cast);
  }
  mistDots(cv, rng, cx, cy, rng.int(160, 240), 0, Math.PI, 0, N * 0.42, 0.9 * U, 2.6 * U);
}

// ---------------------------------------------------------------- shading
function shade(cv) {
  const { nz, main, mist, rough } = cv;
  const pm = new Float32Array(N * N * 4); // premultiplied linear-ish sRGB, 0..1
  const aa = 0.9 * U;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const sd = main[i] + rough[i];
    let a = 0, r = 0, g = 0, b = 0;
    if (sd < aa) {
      const cov = Math.min(1, Math.max(0, 0.5 - sd / (2 * aa)));
      const e = Math.max(0, -sd);
      const t = 1 - Math.exp(-e / (26 * U));           // film thickness from the distance to the edge
      const rim = Math.exp(-e / (2.6 * U)) * Math.min(1, e / (0.8 * U) + 0.35); // drying ring
      const low = nz.fbm(x / (110 * U) + 3.3, y / (110 * U) + 8.1, 3);
      const grain = nz.n2(x / (2.6 * U) + 71, y / (2.6 * U) - 33);
      const mid = nz.fbm(x / (34 * U) - 17, y / (34 * U) + 4, 3);
      const tt = Math.min(1, Math.max(0, t * 1.05 + 0.16 * low + 0.12 * mid * t));
      const k = 1 + 0.12 * low + 0.035 * grain;
      const c = [0, 1, 2].map((j) => {
        let v = C_THIN[j] + (C_THICK[j] - C_THIN[j]) * Math.pow(tt, 0.75);
        v += (C_RIM[j] - v) * rim * 0.85;
        return Math.min(255, v * k) / 255;
      });
      a = cov * Math.min(0.97, 0.8 + 0.16 * tt + 0.08 * rim + 0.03 * low);
      r = c[0] * a; g = c[1] * a; b = c[2] * a;
    }
    const ms = mist[i];
    if (ms < aa && a < 0.97) {
      const cov = Math.min(1, Math.max(0, 0.5 - ms / (2 * aa)));
      const ma = cov * 0.72 * (1 - a);
      r += (C_MIST[0] / 255) * ma; g += (C_MIST[1] / 255) * ma; b += (C_MIST[2] / 255) * ma; a += ma;
    }
    pm[i * 4] = r; pm[i * 4 + 1] = g; pm[i * 4 + 2] = b; pm[i * 4 + 3] = a;
  }
  // SSxSS box filter in premultiplied space, then back to straight alpha. Fully transparent texels keep the
  // rim colour (encoded with exact: true) so bilinear / mip filtering never pulls a black or white fringe.
  const out = Buffer.alloc(OUT * OUT * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const j = ((y * SS + sy) * N + (x * SS + sx)) * 4;
      r += pm[j]; g += pm[j + 1]; b += pm[j + 2]; a += pm[j + 3];
    }
    r *= inv; g *= inv; b *= inv; a *= inv;
    const o = (y * OUT + x) * 4;
    if (a > 1 / 512) {
      out[o] = Math.round(Math.min(1, r / a) * 255); out[o + 1] = Math.round(Math.min(1, g / a) * 255); out[o + 2] = Math.round(Math.min(1, b / a) * 255);
    } else { out[o] = C_RIM[0]; out[o + 1] = C_RIM[1]; out[o + 2] = C_RIM[2]; }
    out[o + 3] = Math.round(a * 255);
  }
  return out;
}

// ---------------------------------------------------------------- main
const SET = [
  { id: 'dir1', kind: 'dir', seed: 1101 },
  { id: 'dir2', kind: 'dir', seed: 2202 },
  { id: 'dir3', kind: 'dir', seed: 3303 },
  { id: 'dir4', kind: 'dir', seed: 4404 },
  { id: 'drip1', kind: 'drip', seed: 5505 },
  { id: 'drip2', kind: 'drip', seed: 6606 },
  { id: 'drops1', kind: 'drops', seed: 7707 },
  { id: 'drops2', kind: 'drops', seed: 8808 },
];
const GEN = { dir: genDir, drip: genDrip, drops: genDrops };
/** stain box [u0, u1, v0, v1] of each kind (texture units, v down): the part of the square that holds the blood */
const BOX = { dir: [0.22, 0.64, 0.32, 0.7], drip: [0.33, 0.66, 0.12, 0.77], drops: [0.2, 0.82, 0.1, 0.8] };

const src = {};
for (const s of SET) {
  const rng = makeRng(s.seed), cv = makeCanvas(s.seed);
  GEN[s.kind](cv, rng);
  src[s.id] = { kind: s.kind, img: sharp(shade(cv), { raw: { width: OUT, height: OUT, channels: 4 } }) };
}

/** wider box of a 'dir' splat, used for the tall cells (spray rotated to point up) */
const BOX_UP = [0.2, 0.98, 0.3, 0.7];
/** the stain box of source `id`, fitted (contain, no distortion) and centred into a w x h cell; up = spray rotated to point up (core at the bottom) */
async function cell(id, w, h, up) {
  const { kind, img } = src[id], [u0, u1, v0, v1] = up ? BOX_UP : BOX[kind];
  let p = img.clone().extract({ left: Math.round(u0 * OUT), top: Math.round(v0 * OUT), width: Math.round((u1 - u0) * OUT), height: Math.round((v1 - v0) * OUT) });
  if (up) p = p.rotate(-90);
  return p.resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}
async function sheet(file, size, cells) {
  const comp = [];
  for (const [id, x, y, w, h, up] of cells) comp.push({ input: await cell(id, w, h, up), left: x, top: y });
  const buf = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 58, g: 5, b: 8, alpha: 0 } } })
    .composite(comp).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(OUT_DIR, file), buf);
  console.log(`${file}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}

mkdirSync(OUT_DIR, { recursive: true });
// Same layout as the original sheets, scaled by K (fw/fh in weaponfx.json are original px; effects.ts rescales).
const K = 3;
const q = 64 * K, t = 128 * K; // square cell, tall cell (64x128 original)
// tex_blood_2 (256x256 original): Fracture = 64x64 cells of the top row; Vertical1 = tall cells: frame 3 = col 3 top,
// frames 4-6 = bottom half cols 0-2. Tall cells: core at the bottom, spray up (as the original).
await sheet('tex_blood_2.png', 256 * K, [
  ['dir1', 0, 0, q, q], ['dir2', q, 0, q, q], ['drops1', 2 * q, 0, q, q],
  ['dir3', 0, q, q, q], ['dir4', q, q, q, q], ['drops2', 2 * q, q, q, q],
  ['dir1', 3 * q, 0, q, t, true],
  ['dir2', 0, 2 * q, q, t, true], ['dir3', q, 2 * q, q, t, true], ['dir4', 2 * q, 2 * q, q, t, true], ['dir1', 3 * q, 2 * q, q, t, true],
]);
// tex_blood_1 (128x128 original): Vertical2 = 2 tall cells (frames 0-1)
await sheet('tex_blood_1.png', 128 * K, [['dir3', 0, 0, q, t, true], ['dir4', q, 0, q, t, true]]);
