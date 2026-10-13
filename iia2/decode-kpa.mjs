// IIA2 (i3IndexArray) de-obfuscation, exact cipher from known-plaintext analysis. Pure Node ESM.
//
// Header: 'IIA2', u32 count, u32 usage, i32 mode (0 = u16, 1 = u32), u32 state, u32 key (seed,
// 0 = plain, 0x100..0x2FF = obfuscated), u32 pad[2] (0). Data at +32, L = count * (2|4) bytes.
//
// Byte-oriented cipher (same for u16/u32), byte j, q = j & 15, all mod 256:
//     E[j] = (((P[j] ^ (j + 1)) + base[q] + S[q] * L + B_q(j, L)) ^ C_q(j, L)
// with base[16] depending ONLY on the seed (verified: 211 seeds, 285 array pairs from 49 packs of
// PB RUSSIA (plain) vs PointBlank 3.123 (keyed), 0 conflicts; Outpost.i3Pack 88/88 exact).
// The seed -> base generator is not recovered (nonlinear; no LCG/MT/hash/GF(2)-affine fit), so
// known seeds come from kpa-keys.json and unknown ones are recovered from the ciphertext + mesh.
import fs from 'node:fs';

const S = [0, 0, 0, 1, -1, 1, -1, 0, 0, 0, 0, 0, 0, 1, -1, 0];
const BT = [ // B_q(j, L)
  () => 0, (j) => j, (j) => -j, (j) => -j, (j) => j, () => 0, () => 0, () => 0,
  () => 0, () => 0, (j, L) => j ^ L, (j, L) => -(j ^ L), () => 0, (j) => j, (j) => -j, () => 0,
];
const CT = [ // C_q(j, L)
  () => 0, () => 0, () => 0, () => 0, () => 0, () => 0, () => 0, (j, L) => L,
  (j) => j, (j, L) => L - j, () => 0, () => 0, (j, L) => j ^ L, () => 0, () => 0, (j, L) => j + L,
];

// seed (hex) -> 16 base bytes as hex, '..' = byte never observed (only small arrays had that seed)
export const KEYS = new Map(Object.entries(JSON.parse(fs.readFileSync(new URL('./kpa-keys.json', import.meta.url), 'utf8')))
  .map(([s, h]) => [parseInt(s, 16), h.match(/../g).map((b) => (b === '..' ? null : parseInt(b, 16)))]));
const tableCovers = (base, L) => base.every((b, q) => b !== null || q >= L);

/** Effective per-array key (16 bytes) from the seed base key. */
export function effKey(base, L) { return Uint8Array.from(base, (b, q) => ((b ?? 0) + S[q] * L) & 255); }
export function baseKey(keff, L) { return Uint8Array.from(keff, (k, q) => (k - S[q] * L) & 255); }

// P[j] = ((pre[j] - Keff[q]) & 255) ^ ((j + 1) & 255), pre[j] = ((E[j] ^ C) - B) & 255
function preBytes(data) {
  const L = data.length, pre = new Uint8Array(L);
  for (let j = 0; j < L; j++) { const q = j & 15; pre[j] = ((data[j] ^ (CT[q](j, L) & 255)) - (BT[q](j, L) & 255)) & 255; }
  return pre;
}
const decAt = (pre, j, k) => ((pre[j] - k) & 255) ^ ((j + 1) & 255);

export function decodeBytes(data, keff) {
  const pre = preBytes(data), out = new Uint8Array(data.length);
  for (let j = 0; j < data.length; j++) out[j] = decAt(pre, j, keff[j & 15]);
  return out;
}
export function encodeBytes(plain, keff) {
  const L = plain.length, out = new Uint8Array(L);
  for (let j = 0; j < L; j++) { const q = j & 15; out[j] = ((((plain[j] ^ ((j + 1) & 255)) + keff[q] + BT[q](j, L)) & 255) ^ (CT[q](j, L) & 255)); }
  return out;
}
function toIndices(b, bpi) {
  const n = (b.length / bpi) | 0, o = bpi === 4 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) { let v = 0; for (let k = bpi - 1; k >= 0; k--) v = v * 256 + b[i * bpi + k]; o[i] = v; }
  return o;
}

// ---- recovery for seeds that are not in the table -------------------------------------------
// 1) non-low index bytes: key bytes that keep every decoded value <= bound ((V-1) >> 8k), ties by
//    agreement with the value histogram of the other slots; 2) low bytes: cyclic Viterbi over the
//    slot chain minimising sum log1p(|idx[i+1] - idx[i]|) (triangle lists are locally coherent);
// 3) coordinate descent on a geometric cost (triangle size + face/vertex-normal agreement).
function recoverKeff(data, bpi, V, pos, nrm, lo = 0, hi = V - 1) {
  const L = data.length, n = (L / bpi) | 0, per = 16 / bpi, pre = preBytes(data), K = new Uint8Array(16);
  const js = (q) => { const a = []; for (let j = q; j < n * bpi; j += 16) a.push(j); return a; };
  // prefix of index i above byte k (bytes > k, already keyed) * 256 + byte k must stay in [lo, hi] >> 8k
  const prefix = (j, k) => { let v = 0; for (let t = bpi - 1; t > k; t--) v = v * 256 + decAt(pre, j - k + t, K[(j - k + t) & 15]); return v * 256; };
  const inRange = (v, k) => v >= Math.floor(lo / 256 ** k) && v <= Math.floor(hi / 256 ** k);
  // 1) high bytes, most significant first
  for (let k = bpi - 1; k >= 1; k--) {
    const cands = [];
    for (let q = k; q < 16; q += bpi) {
      const J = js(q), c = [];
      for (let kv = 0; kv < 256; kv++) { let ok = true; for (const j of J) if (!inRange(prefix(j, k) + decAt(pre, j, kv), k)) { ok = false; break; } if (ok) c.push(kv); }
      cands.push([q, c.length ? c : [...Array(256).keys()]]);
    }
    const pick = new Map(cands.map(([q, c]) => {
      let best = c[0], bm = Infinity;
      for (const kv of c) { let s = 0; for (const j of js(q)) s += decAt(pre, j, kv); if (s < bm) { bm = s; best = kv; } }
      return [q, best];
    }));
    for (let r = 0; r < 3; r++) for (const [q, c] of cands) {
      if (c.length < 2) continue;
      const H = new Float64Array(256); let tot = 0;
      for (const [o] of cands) if (o !== q) for (const j of js(o)) { H[decAt(pre, j, pick.get(o))]++; tot++; }
      if (!tot) continue;
      let bs = -Infinity, bk = pick.get(q);
      for (const kv of c) { let s = 0; for (const j of js(q)) s += Math.log((H[decAt(pre, j, kv)] + 0.05) / tot); if (s > bs) { bs = s; bk = kv; } }
      pick.set(q, bk);
    }
    for (const [q, v] of pick) K[q] = v;
  }
  const hiOf = (i) => { let v = 0; for (let k = bpi - 1; k >= 1; k--) v = v * 256 + decAt(pre, i * bpi + k, K[(i * bpi + k) & 15]); return v * 256; };
  const hv = Float64Array.from({ length: n }, (_, i) => hiOf(i));
  // 2) cyclic Viterbi over low-byte slot keys
  const step = Math.max(1, Math.floor(n / per / 800));
  const M = []; // M[w][a*256+b] cost between slot w (key a) and slot w+1 (key b)
  for (let w = 0; w < per; w++) {
    const m = new Float64Array(65536);
    for (let blk = 0; blk * per + w + 1 < n; blk += step) {
      const i = blk * per + w, i2 = i + 1, j = i * bpi, j2 = i2 * bpi;
      const la = new Float64Array(256);
      for (let a = 0; a < 256; a++) la[a] = hv[i] + decAt(pre, j, a);
      for (let a = 0; a < 256; a++) if (la[a] < lo || la[a] > hi) la[a] = -1e9;
      for (let b = 0; b < 256; b++) {
        let vb = hv[i2] + decAt(pre, j2, b);
        if (vb < lo || vb > hi) vb = 1e9;
        for (let a = 0; a < 256; a++) m[a * 256 + b] += Math.log1p(Math.min(1e6, Math.abs(vb - la[a])));
      }
    }
    M.push(m);
  }
  let bestC = Infinity, bestPath = null;
  for (let k0 = 0; k0 < 256; k0++) {
    let cost = new Float64Array(256).fill(Infinity); cost[k0] = 0;
    const back = [];
    for (let w = 0; w < per; w++) {
      const nc = new Float64Array(256).fill(Infinity), bk = new Uint8Array(256);
      for (let a = 0; a < 256; a++) { if (cost[a] === Infinity) continue; const m = M[w]; for (let b = 0; b < 256; b++) { const c = cost[a] + m[a * 256 + b]; if (c < nc[b]) { nc[b] = c; bk[b] = a; } } }
      back.push(bk); cost = nc;
    }
    if (cost[k0] < bestC) { // close the cycle: slot per == slot 0 of next block
      bestC = cost[k0];
      const path = new Uint8Array(per); let cur = k0;
      for (let w = per - 1; w >= 0; w--) { cur = back[w][cur]; path[w] = cur; }
      bestPath = path;
    }
  }
  for (let w = 0; w < per; w++) K[w * bpi] = bestPath[w];
  if (pos) geomRefine(pre, bpi, n, K, V, pos, nrm, lo, hi);
  return K;
}

function triCostFn(pos, nrm, V, lo = 0, hi = V - 1) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V; i++) for (let k = 0; k < 3; k++) { const v = pos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  const scale = Math.max(1e-6, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 1000), PEN = 20;
  return (a, b, c) => {
    const bad = (a < lo || a > hi) + (b < lo || b > hi) + (c < lo || c > hi);
    if (bad) return PEN * (1 + bad); // graded, so fixing one vertex of a triangle still pays off
    if (a === b || b === c || a === c) return PEN;
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const per = Math.hypot(ux, uy, uz) + Math.hypot(vx, vy, vz) + Math.hypot(ux - vx, uy - vy, uz - vz);
    const ax2 = uy * vz - uz * vy, ay2 = uz * vx - ux * vz, az2 = ux * vy - uy * vx;
    if (Math.hypot(ax2, ay2, az2) <= 1e-6 * per * per) return PEN; // zero area (coincident positions)
    let cost = Math.log1p(per / scale);
    if (nrm) {
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx, fl = Math.hypot(fx, fy, fz);
      // every vertex normal must agree with the face (coincident vertices of different faces differ only here)
      let w = 1;
      for (const v of [a, b, c]) {
        const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2], nl = Math.hypot(nx, ny, nz);
        if (fl > 0 && nl > 0) w = Math.min(w, Math.abs(fx * nx + fy * ny + fz * nz) / (fl * nl));
      }
      cost += 6 * (1 - w);
    }
    return cost;
  };
}

function geomRefine(pre, bpi, n, K, V, pos, nrm, lo, hi) {
  const tc = triCostFn(pos, nrm, V, lo, hi), per = 16 / bpi;
  const idx = new Float64Array(n);
  const val = (i) => { let v = 0; for (let k = bpi - 1; k >= 0; k--) v = v * 256 + decAt(pre, i * bpi + k, K[(i * bpi + k) & 15]); return v; };
  const full = () => { for (let i = 0; i < n; i++) idx[i] = val(i); };
  const total = () => { let c = 0; for (let t = 0; t + 2 < n; t += 3) c += tc(idx[t], idx[t + 1], idx[t + 2]); return c; };
  const sweep = (q) => {
    const w = (q / bpi) | 0, k = q % bpi, mul = 256 ** k, is = [];
    for (let i = w; i < n; i += per) if (i - (i % 3) + 2 < n) is.push(i);
    if (!is.length) return false;
    const base = is.map((i) => idx[i] - mul * decAt(pre, i * bpi + k, K[q]));
    const cost = (kv, bound) => {
      let c = 0;
      for (let m = 0; m < is.length && c < bound; m++) {
        const i = is[m], t = i - (i % 3), v = base[m] + mul * decAt(pre, i * bpi + k, kv);
        c += tc(t === i ? v : idx[t], t + 1 === i ? v : idx[t + 1], t + 2 === i ? v : idx[t + 2]);
      }
      return c;
    };
    const old = K[q]; let bk = old, bc = cost(old, Infinity); // keep the current byte unless strictly better
    for (let kv = 0; kv < 256; kv++) { if (kv === old) continue; const c = cost(kv, bc); if (c < bc - 1e-9) { bc = c; bk = kv; } }
    K[q] = bk;
    for (let m = 0; m < is.length; m++) idx[is[m]] = base[m] + mul * decAt(pre, is[m] * bpi + k, bk);
    return bk !== old;
  };
  const descend = (qs) => { for (let s = 0; s < 8; s++) { let ch = false; for (const q of qs) if (sweep(q)) ch = true; if (!ch) break; } };
  const all = [...Array(16).keys()], loQ = all.filter((q) => q % bpi === 0);
  full(); descend(all);
  // small arrays: random restarts of the low-byte keys (local minima are common with few triangles)
  const restarts = n <= 1500 ? 48 : n <= 6000 ? 8 : 0;
  let best = Uint8Array.from(K), bestS = total(), seed = 0x2545f491 ^ n;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed & 255; };
  for (let r = 0; r < restarts; r++) {
    K.set(best); for (const q of loQ) K[q] = rnd();
    full(); descend(loQ); descend(all);
    const sc = total(); if (sc < bestS - 1e-9) { bestS = sc; best = Uint8Array.from(K); }
  }
  K.set(best);
}

/** Quality of a decoded triangle list: fraction of in-range, non-degenerate triangles. */
export function triQuality(idx, V, start = 0, count = idx.length) {
  let ok = 0, t = 0;
  for (let i = start; i + 2 < start + count; i += 3, t++) { const a = idx[i], b = idx[i + 1], c = idx[i + 2]; if (a < V && b < V && c < V && a !== b && b !== c && a !== c) ok++; }
  return t ? ok / t : 1;
}

/**
 * decodeIIA2(bytes, { key, pad0, pad1, count, mode, vertexCount?, positions?, normals? })
 * bytes: index data (or the whole chunk starting with 'IIA2'). key = seed at +0x14.
 * Returns Uint16Array | Uint32Array with .iia2 = { method: 'plain'|'table'|'recovered', keff, base }.
 */
export function decodeIIA2(bytes, { key = 0, count, mode = 0, vertexCount, positions, normals, range } = {}) {
  let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length >= 32 && data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x41 && data[3] === 0x32) data = data.subarray(32);
  const bpi = mode === 1 ? 4 : 2;
  if (count != null) data = data.subarray(0, count * bpi);
  const L = data.length;
  if (!key) { const o = toIndices(data, bpi); o.iia2 = { method: 'plain' }; return o; }
  let method = 'table', keff;
  if (KEYS.has(key) && tableCovers(KEYS.get(key), L)) keff = effKey(KEYS.get(key), L);
  else {
    method = 'recovered';
    const V = vertexCount ?? (positions ? (positions.length / 3) | 0 : 2 ** (8 * bpi));
    keff = recoverKeff(data, bpi, V, positions, normals, range ? range[0] : 0, range ? range[1] : V - 1);
  }
  const o = toIndices(decodeBytes(data, keff), bpi);
  o.iia2 = { method, keff, base: baseKey(keff, L) };
  return o;
}

/** Mean |cos| between face normals and summed vertex normals (1 = coherent, ~0.5 = random). */
export function normalAgreement(idx, pos, nrm, start = 0, count = idx.length) {
  if (!nrm) return 1;
  const V = (pos.length / 3) | 0; let s = 0, t = 0;
  for (let i = start; i + 2 < start + count; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a >= V || b >= V || c >= V) continue;
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx, fl = Math.hypot(fx, fy, fz);
    const nx = nrm[a * 3] + nrm[b * 3] + nrm[c * 3], ny = nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1], nz = nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2], nl = Math.hypot(nx, ny, nz);
    if (fl > 0 && nl > 0) { s += Math.abs(fx * nx + fy * ny + fz * nz) / (fl * nl); t++; }
  }
  return t ? s / t : 0;
}

/**
 * Decode every index array of a scene (meshes from scene.mjs collectMeshes: { ia, va, geo }).
 * Table/plain arrays first; unknown seeds are then recovered in file order, bounded by the vertex
 * ranges of the nearest trusted arrays on the same vertex array (exported meshes use consecutive
 * vertex ranges). Returns Map ia.id -> { indices, method, quality, normals }.
 */
export function decodeMeshesIIA2(meshes) {
  const out = new Map(), groups = new Map();
  for (const m of meshes) { if (!groups.has(m.va.id)) groups.set(m.va.id, new Map()); groups.get(m.va.id).set(m.ia.id, m); }
  const opts = (m) => ({ key: m.ia.key, count: m.ia.count, mode: m.ia.unit === 4 ? 1 : 0, positions: m.va.pos, normals: m.va.nrm, vertexCount: m.va.count });
  const score = (m, idx) => {
    const s = m.geo.startIndex, c = m.geo.primCount * 3;
    return { tri: triQuality(idx, m.va.count, s, c), nrm: normalAgreement(idx, m.va.pos, m.va.nrm, s, c) };
  };
  const put = (m, idx) => {
    let mn = Infinity, mx = -Infinity; for (const v of idx) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const q = score(m, idx), trusted = idx.iia2.method !== 'recovered' || (q.tri >= 0.99 && q.nrm >= 0.9);
    out.set(m.ia.id, { indices: idx, method: idx.iia2.method, quality: q, trusted, range: [mn, mx] });
  };
  for (const g of groups.values()) {
    const list = [...g.values()].sort((a, b) => a.ia.id - b.ia.id);
    for (const m of list) if (!m.ia.key || KEYS.has(m.ia.key)) { const idx = decodeIIA2(m.ia.bytes, opts(m)); if (idx.iia2.method !== 'recovered') put(m, idx); }
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const m = list[i], cur = out.get(m.ia.id);
        if (cur && cur.trusted) continue;
        let prev = null, next = null;
        for (let k = i - 1; k >= 0 && !prev; k--) { const r = out.get(list[k].ia.id); if (r && r.trusted) prev = r.range; }
        for (let k = i + 1; k < list.length && !next; k++) { const r = out.get(list[k].ia.id); if (r && r.trusted) next = r.range; }
        const V = m.va.count, bounds = [];
        if (prev && next && prev[1] < next[0]) bounds.push([prev[1] + 1, next[0] - 1]); // the gap between neighbours
        if (prev && next && prev[0] <= next[1]) bounds.push([prev[0], next[1]]);
        if (prev && !next) bounds.push([prev[1] + 1, V - 1], [prev[0], V - 1]);
        if (!prev && next) bounds.push([0, next[0] - 1], [0, next[1]]);
        if (prev && next) bounds.push([Math.min(prev[0], next[0]), Math.max(prev[1], next[1])]);
        // vertices of this VA that no trusted array references yet
        const used = new Uint8Array(V);
        for (const o of list) { const r = out.get(o.ia.id); if (r && r.trusted && o !== m) for (const v of r.indices) if (v < V) used[v] = 1; }
        let u0 = -1, u1 = -1; for (let v = 0; v < V; v++) if (!used[v]) { if (u0 < 0) u0 = v; u1 = v; }
        if (u0 >= 0) bounds.push([u0, u1]);
        bounds.push([0, V - 1]);
        for (const [lo, hi] of bounds) {
          if (lo > hi || (cur && cur.tried && cur.tried.has(lo + ':' + hi))) continue;
          const idx = decodeIIA2(m.ia.bytes, { ...opts(m), range: [lo, hi] });
          const tried = (out.get(m.ia.id) || {}).tried || new Set();
          tried.add(lo + ':' + hi);
          const was = out.get(m.ia.id);
          put(m, idx); const now = out.get(m.ia.id); now.tried = tried; now.lo = lo; now.hi = hi;
          if (was && !now.trusted && was.quality.nrm > now.quality.nrm) Object.assign(now, { ...was, tried });
          if (now.trusted) { changed = true; break; }
        }
      }
      if (!changed) break;
    }
  }
  return out;
}
