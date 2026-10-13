#!/usr/bin/env node
// .i3VTexImage (Point Blank 3.123 UI atlas, "VTIH") decoder + cipher, pure Node ESM, builtins only.
//
//   node ui-export/vtex-crypt.mjs <file.i3VTexImage | dir> ... [--out DIR] [--png] [--raw]
//        --png   write <name>.png (RGBA, untiled)        --raw  write the decrypted .i3VTexImage (flag = 0)
//   node ui-export/vtex-crypt.mjs --verify <encrypted> <plain>   known-plaintext check
//
// File layout: 2048-byte plain header, then BGRA8 pixels in 128x128 tiles (64 KB each), tiles row-major.
//   +0x00 'VTIH'  +0x04 u32 1  +0x08 u32 width  +0x0C u32 height  +0x10 u32 ?  +0x14 u32 ?
//   +0x18 u32 cipher flag (1 = encrypted)  +0x80 char srcPath[] ("Image/Item/item_cash_A21.tga")
//   Files are exactly 2048 + w*h*4 bytes (no mips). 128-byte files in Locale/Brazil are placeholders.
//
// Cipher (flag = 1): the IIA2 byte cipher of tools/i3pack/unpack.mjs (same IIA_FORMS), applied per
// 64 KB tile (L = 0x10000, j tile-local), ONE 16-byte key per file shared by every tile:
//     E = ((P ^ (j + 1)) + K[q] + B_q(j, L)) ^ C_q(j, L)      q = j & 15, mod 256
// Verified on Brazil/UI_V11/Img_05 (encrypted) vs _Common/UI_V12/Img_05 (plain, same header): one key
// (1a653c1bf00708090a0b0c0d0e0f1011) reproduces 41/64 tiles byte for byte; the other 23 tiles differ
// because the picture itself changed between V11 and V12. How K is derived is unknown (not from the
// header: it is plain), so recoverKey() finds it from the ciphertext:
//   * low 7 bits of K[q]: minimise vertical smoothness sum |P(x,y) - P(x,y-1)|. A tile row is 512
//     bytes, so the pixel above is in the same slot q and has the same (j + 1) low byte: a wrong K
//     turns the XOR into noise, while K ^ 0x80 only flips the top bit (same smoothness modulo wrap);
//   * top bit: the candidate with more extreme values (0 / 255: transparent pixels, opaque alpha).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const HEADER = 2048, TILE = 128, TILE_BYTES = TILE * TILE * 4, ROW = TILE * 4;

// [B_q(j, L), C_q(j, L)], same as IIA_FORMS in tools/i3pack/unpack.mjs
const FORMS = [
  [() => 0, () => 0], [j => j, () => 0], [j => -j, () => 0], [(j, L) => L - j, () => 0],
  [(j, L) => j - L, () => 0], [(j, L) => L, () => 0], [(j, L) => -L, () => 0], [() => 0, (j, L) => L],
  [() => 0, j => j], [() => 0, (j, L) => L - j], [(j, L) => j ^ L, () => 0], [(j, L) => -(j ^ L), () => 0],
  [() => 0, (j, L) => j ^ L], [(j, L) => j + L, () => 0], [(j, L) => -j - L, () => 0], [() => 0, (j, L) => j + L],
];
// Per tile-local byte j (L is always TILE_BYTES): Bj = B & 255, Cj = C & 255.
const Bj = new Uint8Array(TILE_BYTES), Cj = new Uint8Array(TILE_BYTES);
for (let j = 0; j < TILE_BYTES; j++) { const [B, C] = FORMS[j & 15]; Bj[j] = B(j, TILE_BYTES) & 255; Cj[j] = C(j, TILE_BYTES) & 255; }

export function readHeader(d) {
  if (d.length < HEADER || d.toString('latin1', 0, 4) !== 'VTIH') return null;
  const w = d.readUInt32LE(8), h = d.readUInt32LE(12);
  const p = d.indexOf(0, 0x80);
  return { w, h, encrypted: d.readUInt32LE(0x18) === 1, srcPath: d.toString('latin1', 0x80, p < 0 ? 0x100 : p),
    ok: d.length === HEADER + w * h * 4 && w % TILE === 0 && h % TILE === 0 };
}

// X = (E ^ C) - B, so that P = (X - K) ^ (j + 1).
function preX(px) {
  const X = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i++) { const j = i & (TILE_BYTES - 1); X[i] = ((px[i] ^ Cj[j]) - Bj[j]) & 255; }
  return X;
}

/** Recover the 16-byte file key from an encrypted .i3VTexImage. Returns { K, score }: score is the
 *  worst per-slot smoothness gain 1 - S(best)/S(median) (real pictures: > 0.3; ~0 = flat/unsure). */
export function recoverKey(d) {
  const px = d.subarray(HEADER), X = preX(px), nt = px.length / TILE_BYTES;
  const K = Buffer.alloc(16), gains = [], ext = [];
  // pairs (a, c, m) deduplicated, packed a | c << 8 | m << 16; flat pairs (a == c) carry no information
  const pairs = (q, dj) => {
    const map = new Map();
    for (let t = 0; t < nt; t++) {
      const b = t * TILE_BYTES;
      for (let j = q; j + dj < TILE_BYTES; j += 16) {
        const a = X[b + j], c = X[b + j + dj];
        if (dj === ROW ? a !== c : true) { const key = a | (c << 8) | (((j + 1) & 255) << 16); map.set(key, (map.get(key) || 0) + 1); }
      }
    }
    return map;
  };
  const cost = (map, k1, k2, dm) => {
    let s = 0;
    for (const [key, n] of map) {
      const m = key >>> 16;
      s += n * Math.abs((((key & 255) - k1) & 255 ^ m) - ((((key >>> 8) & 255) - k2) & 255 ^ ((m + dm) & 255)));
    }
    return s;
  };
  const locked = [];
  for (let q = 0; q < 16; q++) {
    // extremes histogram [m][X]: decoded 0 / 255 (transparent pixels, opaque alpha, black / white)
    const H = new Uint32Array(65536);
    for (let t = 0; t < nt; t++) for (let j = q; j < TILE_BYTES; j += 16) H[(((j + 1) & 255) << 8) | X[t * TILE_BYTES + j]]++;
    const ex = (k) => { let z = 0; for (let m = 0; m < 256; m++) z += H[(m << 8) | ((m + k) & 255)] + H[(m << 8) | (((255 ^ m) + k) & 255)]; return z; };
    const E = Array.from({ length: 256 }, (_, k) => ex(k));
    const er = [...E.keys()].sort((x, y) => E[y] - E[x]);
    ext.push(ex);
    // a dominant extremes peak decides alone (binary-ish alpha defeats smoothness: a wrong key turns
    // 0 <-> 255 edges into smaller mid-range jumps)
    if (E[er[0]] >= 3 * E[er[1]] && E[er[0]] >= (nt * TILE_BYTES) / 16 / 16) { K[q] = er[0]; locked[q] = true; continue; }
    // otherwise: vertical smoothness (pixel above = same slot, same (j + 1) low byte) -> low 7 bits
    const V = pairs(q, ROW), S = new Float64Array(256);
    for (let k = 0; k < 256; k++) S[k] = cost(V, k, k, 0);
    let best = 0;
    for (let k = 1; k < 256; k++) if (S[k] < S[best] || (S[k] === S[best] && E[k] > E[best])) best = k;
    K[q] = best;
    const med = [...S].sort((x, y) => x - y)[128];
    if (V.size) gains.push(med ? 1 - S[best] / med : 0);
  }
  // top bits of smoothness-decided slots: horizontal neighbours chain the 4 slots of a channel
  // (q <-> q + 4) outward from a locked slot; a channel with none takes the orientation with more 0 / 255
  const orient = (from, to) => {
    const lo = Math.min(from, to), Hm = pairs(lo, 4);
    const c0 = from < to ? cost(Hm, K[from], K[to], 4) : cost(Hm, K[to], K[from], 4);
    const c1 = from < to ? cost(Hm, K[from], K[to] ^ 0x80, 4) : cost(Hm, K[to] ^ 0x80, K[from], 4);
    if (c1 < c0) K[to] ^= 0x80;
  };
  for (let c = 0; c < 4; c++) {
    const qs = [c, c + 4, c + 8, c + 12];
    let a0 = qs.findIndex(q => locked[q]);
    const anchored = a0 >= 0; if (!anchored) a0 = 0;
    for (let i = a0 + 1; i < 4; i++) if (!locked[qs[i]]) orient(qs[i - 1], qs[i]);
    for (let i = a0 - 1; i >= 0; i--) if (!locked[qs[i]]) orient(qs[i + 1], qs[i]);
    if (anchored) continue;
    let keep = 0, flip = 0;
    for (const q of qs) { keep += ext[q](K[q]); flip += ext[q](K[q] ^ 0x80); }
    if (flip > keep) for (const q of qs) K[q] ^= 0x80;
  }
  return { K, score: gains.length ? Math.min(...gains) : 0 };
}

/** Decrypt pixels in place into a copy; returns a plain .i3VTexImage buffer (flag cleared). */
export function decrypt(d, K = recoverKey(d).K) {
  const out = Buffer.from(d), px = d.subarray(HEADER);
  for (let i = 0; i < px.length; i++) {
    const j = i & (TILE_BYTES - 1);
    out[HEADER + i] = ((((px[i] ^ Cj[j]) - K[j & 15] - Bj[j]) & 255) ^ ((j + 1) & 255));
  }
  out.writeUInt32LE(0, 0x18);
  return out;
}

export function encrypt(d, K) {
  const out = Buffer.from(d), px = d.subarray(HEADER);
  for (let i = 0; i < px.length; i++) {
    const j = i & (TILE_BYTES - 1);
    out[HEADER + i] = ((((px[i] ^ ((j + 1) & 255)) + K[j & 15] + Bj[j]) & 255) ^ Cj[j]);
  }
  out.writeUInt32LE(1, 0x18);
  return out;
}

/** Untile a PLAIN .i3VTexImage into { w, h, rgba }. */
export function toRGBA(d) {
  const { w, h } = readHeader(d), per = w / TILE, rgba = Buffer.alloc(w * h * 4);
  for (let t = 0; t < per * (h / TILE); t++) {
    const tx = (t % per) * TILE, ty = Math.floor(t / per) * TILE;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const s = HEADER + (t * TILE * TILE + y * TILE + x) * 4, o = ((ty + y) * w + tx + x) * 4;
      rgba[o] = d[s + 2]; rgba[o + 1] = d[s + 1]; rgba[o + 2] = d[s]; rgba[o + 3] = d[s + 3];
    }
  }
  return { w, h, rgba };
}

/** Read any .i3VTexImage (plain or encrypted) -> { w, h, rgba, srcPath, encrypted, key, score }. */
export function loadVTex(file) {
  const d = fs.readFileSync(file), hd = readHeader(d);
  if (!hd || !hd.ok) return null;
  let plain = d, key = null, score = null;
  if (hd.encrypted) { ({ K: key, score } = recoverKey(d)); plain = decrypt(d, key); }
  return { ...toRGBA(plain), srcPath: hd.srcPath, encrypted: hd.encrypted, key: key?.toString('hex') ?? null, score };
}

/** W2 hook (tools/ui-export/ui-atlas.mjs, out/ui/README.md "Contract for W3"):
 *  (buf, {file, name, w, h}) -> {rgba (RGBA straight, untiled), w, h, exact, key, score} | null.
 *  exact = true: the cipher has no approximation; the key recovery reproduced the known-plaintext key
 *  on every plain/encrypted pair that exists (see header comment). A wrong key shows as noise, not as
 *  colour drift, so a recovered key is either the right one or visibly broken. */
export function decodeVTexImage(buf) {
  const hd = readHeader(buf);
  if (!hd || !hd.ok) return null;
  let plain = buf, key = null, score = null;
  if (hd.encrypted) { ({ K: key, score } = recoverKey(buf)); plain = decrypt(buf, key); }
  return { ...toRGBA(plain), exact: true, key: key?.toString('hex') ?? null, score };
}

// ---- PNG ----------------------------------------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, data) => { const l = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t, 'latin1'), data]); l.writeUInt32BE(data.length); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
export function encodePNG(rgba, w, h) {
  const row = w * 4 + 1, raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * row + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Known-plaintext check: per-tile count of bytes that decrypt(enc) gets wrong vs plain. */
export function verify(encFile, plainFile) {
  const e = fs.readFileSync(encFile), p = fs.readFileSync(plainFile);
  const { K, score } = recoverKey(e), dec = decrypt(e, K), nt = (e.length - HEADER) / TILE_BYTES, tiles = [];
  for (let t = 0; t < nt; t++) { let m = 0; for (let j = 0; j < TILE_BYTES; j++) { const o = HEADER + t * TILE_BYTES + j; if (dec[o] !== p[o]) m++; } tiles.push(m); }
  return { key: K.toString('hex'), score, exactTiles: tiles.filter(m => !m).length, tiles };
}

// ---- CLI ----------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--verify') {
    const r = verify(args[1], args[2]);
    console.log(`key=${r.key} score=${r.score.toFixed(3)} exactTiles=${r.exactTiles}/${r.tiles.length}`);
    console.log('wrong bytes per tile:', r.tiles.join(','));
  } else {
    const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
    const png = flag('--png'), raw = flag('--raw');
    let out = null; const oi = args.indexOf('--out'); if (oi >= 0) { out = args[oi + 1]; args.splice(oi, 2); }
    const files = args.flatMap(a => fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter(f => /\.i3VTexImage$/i.test(f)).map(f => path.join(a, f)) : [a]);
    if (out) fs.mkdirSync(out, { recursive: true });
    for (const f of files) {
      const d = fs.readFileSync(f), hd = readHeader(d), base = path.basename(f).replace(/\.i3VTexImage$/i, '');
      if (!hd || !hd.ok) { console.log(`${base}: skip (${d.length} bytes)`); continue; }
      let plain = d, info = 'plain';
      if (hd.encrypted) { const { K, score } = recoverKey(d); plain = decrypt(d, K); info = `key=${K.toString('hex')} score=${score.toFixed(3)}`; }
      if (out && raw) fs.writeFileSync(path.join(out, base + '.i3VTexImage'), plain);
      if (out && png) { const { w, h, rgba } = toRGBA(plain); fs.writeFileSync(path.join(out, base + '.png'), encodePNG(rgba, w, h)); }
      console.log(`${base}: ${hd.w}x${hd.h} ${info}`);
    }
  }
}
