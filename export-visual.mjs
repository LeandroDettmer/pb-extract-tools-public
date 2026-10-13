#!/usr/bin/env node
// Export the visual (render) scene of a Point Blank map to glTF for three.js. Pure Node ESM, builtins only.
//
//   node export-visual.mjs <Map> [--pack-dir DIR | --root DIR] [--out DIR] [--name DIR_NAME] [--check-only]
//   e.g. node export-visual.mjs Metro
//
// Output (out/maps/<map lowercased>/):
//   visual.glb     one mesh per material, one primitive per i3GeometryAttr (GEO2); world matrices
//                  baked into the vertices (node TRS = identity). POSITION, NORMAL, TEXCOORD_0 (uv0),
//                  TEXCOORD_1 (lightmap uv). Images are external: tex/<name>.png.
//   visual.json    { meshes, primitives, tris, verts, textures, bounds, skipped, materials[] }
//   tex/*.png      mip 0 of every referenced I3IB texture (DXT1 / DXT4-5 / RGB(A)8 decoded to RGBA).
//
// Sources: <Map>.i3Pack (scene graph, sometimes embedded textures) and <Map>_Textures.i3Pack
// (external .i3i). The world scene is the I3R2 blob with the most i3Geometry nodes (the small
// ones are skyboxes). Only plain IIA2 index arrays (key == 0) are exported; keyed ones are skipped
// and counted. Axes: the scene's own matrix chain (root included) already gives three.js space
// (tools/AXES.md), so there is no extra conversion.
//
// Lightmaps (i3LuxMapBindAttr) are bound as occlusionTexture{texCoord:1} and repeated in
// material.extras.lightMap = { index, texCoord: 1 } so the app can use them as a three.js lightMap.
//
// I3IB layout (60-byte header, then the path, then the mip chain, largest first):
//   +0 'I3IB'  +6 u16 width  +8 u16 height  +10 u32 format  +24 u16 mipCount  +26 u16 pathLen  +60 path
//   format & 0xfff: 0x680 DXT1 (no alpha), 0x681 DXT1 (1-bit alpha), 0x602/0x603 DXT2/3,
//   0x604/0x605 DXT4/5, otherwise uncompressed (bytes/pixel inferred from the payload size, BGR(A)).

import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { scanI3R2 } from './i3r2/i3r2.mjs';
import { collectMeshes, meshIndices } from './i3r2/scene.mjs';


// ---- I3IB textures ------------------------------------------------------------------------
function readI3IB(d, o, end = d.length) {
  if (d.toString('latin1', o, o + 4) !== 'I3IB') return null;
  const w = d.readUInt16LE(o + 6), h = d.readUInt16LE(o + 8), format = d.readUInt32LE(o + 10);
  const mips = d.readUInt16LE(o + 24) || 1, pathLen = d.readUInt16LE(o + 26);
  if (!w || !h || w > 8192 || h > 8192 || pathLen > 512) return null;
  const srcPath = d.toString('latin1', o + 60, o + 60 + pathLen);
  const data = o + 60 + pathLen;
  const f = format & 0xfff;
  let kind, bpp = 0;
  if (f === 0x680 || f === 0x681) kind = 'dxt1';
  else if (f === 0x602 || f === 0x603) kind = 'dxt3';
  else if (f === 0x604 || f === 0x605) kind = 'dxt5';
  else {
    kind = 'raw';
    let px = 0;
    for (let m = 0; m < mips; m++) px += Math.max(1, w >> m) * Math.max(1, h >> m);
    bpp = Math.floor((end - data) / px);
    if (![1, 2, 3, 4].includes(bpp)) bpp = Math.floor((end - data) / (w * h)); // mip count unreliable
    if (![3, 4].includes(bpp)) return { w, h, format, kind: 'unsupported', srcPath, data };
  }
  return { w, h, format, kind, bpp, mips, srcPath, data, off: o };
}

const c565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];

function decodeI3IB(d, t) {
  const { w, h } = t;
  const out = Buffer.alloc(w * h * 4);
  if (t.kind === 'raw') {
    for (let i = 0; i < w * h; i++) {
      const s = t.data + i * t.bpp;
      out[i * 4] = d[s + 2]; out[i * 4 + 1] = d[s + 1]; out[i * 4 + 2] = d[s];
      out[i * 4 + 3] = t.bpp === 4 ? d[s + 3] : 255;
    }
    return out;
  }
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const bsz = t.kind === 'dxt1' ? 8 : 16;
  const pal = new Array(4), alpha = new Array(16), av = new Array(8);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let b = t.data + (by * bw + bx) * bsz;
    if (t.kind === 'dxt3') {
      for (let i = 0; i < 16; i++) alpha[i] = ((d[b + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      b += 8;
    } else if (t.kind === 'dxt5') {
      const a0 = d[b], a1 = d[b + 1];
      av[0] = a0; av[1] = a1;
      if (a0 > a1) for (let i = 1; i < 7; i++) av[i + 1] = ((7 - i) * a0 + i * a1) / 7;
      else { for (let i = 1; i < 5; i++) av[i + 1] = ((5 - i) * a0 + i * a1) / 5; av[6] = 0; av[7] = 255; }
      let bits = 0n;
      for (let i = 0; i < 6; i++) bits |= BigInt(d[b + 2 + i]) << BigInt(8 * i);
      for (let i = 0; i < 16; i++) alpha[i] = av[Number((bits >> BigInt(3 * i)) & 7n)];
      b += 8;
    }
    const c0 = d.readUInt16LE(b), c1 = d.readUInt16LE(b + 2);
    const p0 = c565(c0), p1 = c565(c1);
    pal[0] = [...p0, 255]; pal[1] = [...p1, 255];
    if (c0 > c1 || t.kind !== 'dxt1') {
      pal[2] = [0, 1, 2].map((k) => (2 * p0[k] + p1[k]) / 3).concat(255);
      pal[3] = [0, 1, 2].map((k) => (p0[k] + 2 * p1[k]) / 3).concat(255);
    } else {
      pal[2] = [0, 1, 2].map((k) => (p0[k] + p1[k]) / 2).concat(255);
      pal[3] = [0, 0, 0, 0];
    }
    const idx = d.readUInt32LE(b + 4);
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const c = pal[(idx >>> (2 * i)) & 3], o = (y * w + x) * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
      out[o + 3] = t.kind === 'dxt1' ? c[3] : alpha[i];
    }
  }
  return out;
}

// hasAlpha (min alpha of mip 0 < 250) without decoding colours: same answer as decodeI3IB, ~100x faster.
export function hasAlphaFast(d, t) {
  const bw = Math.max(1, (t.w + 3) >> 2), bh = Math.max(1, (t.h + 3) >> 2);
  const bsz = t.kind === 'dxt1' ? 8 : 16, av = new Array(8);
  for (let i = 0; i < bw * bh; i++) {
    const b = t.data + i * bsz;
    if (t.kind === 'dxt1') {
      if (d.readUInt16LE(b) <= d.readUInt16LE(b + 2) && d.readUInt32LE(b + 4) !== 0) { const idx = d.readUInt32LE(b + 4); for (let k = 0; k < 16; k++) if (((idx >>> (2 * k)) & 3) === 3) return true; }
    } else if (t.kind === 'dxt3') {
      for (let k = 0; k < 8; k++) if ((d[b + k] & 15) * 17 < 250 || (d[b + k] >> 4) * 17 < 250) return true;
    } else {
      const a0 = d[b], a1 = d[b + 1];
      av[0] = a0; av[1] = a1;
      if (a0 > a1) for (let k = 1; k < 7; k++) av[k + 1] = ((7 - k) * a0 + k * a1) / 7;
      else { for (let k = 1; k < 5; k++) av[k + 1] = ((5 - k) * a0 + k * a1) / 5; av[6] = 0; av[7] = 255; }
      if (Math.min(a0, a1) >= 250 && a0 > a1) continue; // palette all >= 250
      const lo = d.readUInt32LE(b + 2), hi = d.readUInt16LE(b + 6);
      for (let k = 0; k < 16; k++) {
        const bit = 3 * k, v = bit + 3 <= 32 ? (lo >>> bit) & 7 : bit >= 32 ? (hi >>> (bit - 32)) & 7 : ((lo >>> bit) | (hi << (32 - bit))) & 7;
        if (av[v] < 250) return true;
      }
    }
  }
  return false;
}

// ---- DDS (raw DXT blocks of the i3i, same row order as the PNG, original mip chain) ---------------------------
// The i3i chain is usually truncated (512 -> 4 levels): kept as is (D3D samples the same levels; WebGL2 immutable storage is
// complete with fewer levels). Only when every stored level has w,h multiple of 4 (S3TC rule); otherwise PNG only (client
// falls back). pf.flags bit 0 (ALPHAPIXELS) = hasAlpha.
const DDS_FOURCC = { dxt1: 'DXT1', dxt3: 'DXT3', dxt5: 'DXT5' };
export function ddsOf(d, t, hasAlpha) {
  const fcc = DDS_FOURCC[t.kind];
  if (!fcc) return null;
  const bsz = t.kind === 'dxt1' ? 8 : 16;
  const full = Math.min(t.mips, Math.floor(Math.log2(Math.max(t.w, t.h))) + 1);
  const sizes = [];
  for (let m = 0; m < full; m++) {
    const lw = Math.max(1, t.w >> m), lh = Math.max(1, t.h >> m);
    if (lw % 4 || lh % 4) { if (m === 0) return null; break; } // stop the chain before the first non-multiple-of-4 level
    sizes.push(Math.max(1, (lw + 3) >> 2) * Math.max(1, (lh + 3) >> 2) * bsz);
  }
  const levels = sizes.length;
  const total = sizes.reduce((a, b) => a + b, 0);
  if (t.data + total > d.length) return null; // short payload: PNG only
  const h = Buffer.alloc(128);
  h.write('DDS ', 0, 'latin1'); h.writeUInt32LE(124, 4);
  h.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000, 8);
  h.writeUInt32LE(t.h, 12); h.writeUInt32LE(t.w, 16); h.writeUInt32LE(sizes[0], 20); h.writeUInt32LE(levels, 28);
  h.writeUInt32LE(32, 76); h.writeUInt32LE(0x4 | (hasAlpha ? 0x1 : 0), 80); h.write(fcc, 84, 'latin1');
  h.writeUInt32LE(0x401008, 108);
  return Buffer.concat([h, d.subarray(t.data, t.data + total)]);
}

// ---- PNG (zlib from node, own CRC) --------------------------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h, withAlpha) {
  const ch = withAlpha ? 4 : 3, row = w * ch + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < w; x++) for (let k = 0; k < ch; k++) raw[y * row + 1 + x * ch + k] = rgba[(y * w + x) * 4 + k];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = withAlpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- texture library ------------------------------------------------------------------------
const normPath = (p) => p.replace(/\\/g, '/').toLowerCase();
const stem = (p) => path.posix.basename(normPath(p)).replace(/\.[^.]*$/, '');

// Every I3IB in a buffer (payload ends at the next I3IB / EOF).
function scanI3IB(d, source) {
  const hits = [];
  for (let p = d.indexOf('I3IB'); p >= 0; p = d.indexOf('I3IB', p + 4)) hits.push(p);
  const out = [];
  hits.forEach((p, i) => { const t = readI3IB(d, p, hits[i + 1] ?? d.length); if (t) out.push({ ...t, buf: d, source }); });
  return out;
}

// Match external .i3i references to I3IBs: by embedded path, then stem; nameless I3IBs
// (some packs strip the path) are assigned by their alphabetical slot between named neighbours.
function buildResolver(packTextures, wanted) {
  const byPath = new Map(), byStem = new Map();
  for (const t of packTextures) if (t.srcPath) {
    byPath.set(normPath(t.srcPath), t);
    if (!byStem.has(stem(t.srcPath))) byStem.set(stem(t.srcPath), t);
  }
  const res = new Map();
  const missing = [];
  for (const w of wanted) {
    const t = byPath.get(normPath(w)) || byStem.get(stem(w));
    if (t) res.set(w, t); else missing.push(w);
  }
  const guessed = [];
  for (const [i, t] of packTextures.entries()) {
    if (t.srcPath) continue;
    const before = packTextures.slice(0, i).reverse().find((x) => x.srcPath && x.source === t.source);
    const after = packTextures.slice(i + 1).find((x) => x.srcPath && x.source === t.source);
    const lo = before ? stem(before.srcPath) : '', hi = after ? stem(after.srcPath) : '￿';
    const cands = missing.filter((m) => !res.has(m) && stem(m) > lo && stem(m) < hi);
    if (cands.length === 1) { res.set(cands[0], t); t.guessName = stem(cands[0]); guessed.push(t.guessName); }
    else if (cands.length > 1) {
      // several gaps in one slot: keep pack order == alphabetical order
      const gap = []; for (let j = i; j < packTextures.length && !packTextures[j].srcPath; j++) gap.push(packTextures[j]);
      if (gap[0] === t && gap.length === cands.length) {
        cands.sort((a, b) => (stem(a) < stem(b) ? -1 : 1)).forEach((m, k) => { res.set(m, gap[k]); gap[k].guessName = stem(m); guessed.push(stem(m)); });
      }
    }
  }
  return { res, missing: missing.filter((m) => !res.has(m)), guessed };
}

// ---- math ---------------------------------------------------------------------------------
const xformP = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];
function normalMatrix(m) { // (A^-1)^T of the upper 3x3, row-vector convention: n' = n * N
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  // transpose of inv
  return { det, n: [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]] };
}

// ---- GLB ----------------------------------------------------------------------------------
class GLBBuilder {
  constructor() { this.chunks = []; this.len = 0; this.json = { asset: { version: '2.0', generator: 'pb export-visual.mjs' }, buffers: [], bufferViews: [], accessors: [] }; }
  view(buf, target) {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.len += pad; }
    const bv = { buffer: 0, byteOffset: this.len, byteLength: buf.byteLength };
    if (target) bv.target = target;
    this.chunks.push(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)); this.len += buf.byteLength;
    this.json.bufferViews.push(bv);
    return this.json.bufferViews.length - 1;
  }
  accessor(arr, type, componentType, target, minmax) {
    const ncomp = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    const acc = { bufferView: this.view(arr, target), componentType, count: arr.length / ncomp, type };
    if (minmax) {
      const mn = new Array(ncomp).fill(Infinity), mx = new Array(ncomp).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) { const k = i % ncomp; if (arr[i] < mn[k]) mn[k] = arr[i]; if (arr[i] > mx[k]) mx[k] = arr[i]; }
      acc.min = mn; acc.max = mx;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  build() {
    const bin = Buffer.concat(this.chunks);
    const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    this.json.buffers.push({ byteLength: binPad.length });
    let js = Buffer.from(JSON.stringify(this.json), 'utf8');
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const hdr = Buffer.alloc(12); hdr.write('glTF', 0, 'latin1'); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8);
    const ch = (b, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, b]); };
    return Buffer.concat([hdr, ch(js, 'JSON'), ch(binPad, 'BIN\0')]);
  }
}

// Independent GLB check: parse the container, JSON and BIN, verify every accessor and image.
export function checkGLB(file) {
  const g = fs.readFileSync(file);
  const err = [];
  if (g.toString('latin1', 0, 4) !== 'glTF' || g.readUInt32LE(4) !== 2) throw new Error('bad GLB header');
  if (g.readUInt32LE(8) !== g.length) err.push('length mismatch');
  const jl = g.readUInt32LE(12);
  if (g.toString('latin1', 16, 20) !== 'JSON') throw new Error('no JSON chunk');
  const J = JSON.parse(g.toString('utf8', 20, 20 + jl));
  const bo = 20 + jl, bl = g.readUInt32LE(bo);
  if (g.toString('latin1', bo + 4, bo + 8) !== 'BIN\0') throw new Error('no BIN chunk');
  const bin = g.subarray(bo + 8, bo + 8 + bl);
  if (J.buffers[0].byteLength > bin.length) err.push('buffer larger than BIN');
  const CS = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }, NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (ai) => {
    const a = J.accessors[ai], v = J.bufferViews[a.bufferView];
    const n = a.count * NC[a.type], sz = CS[a.componentType];
    if (v.byteOffset + (a.byteOffset || 0) + n * sz > J.buffers[0].byteLength) err.push(`accessor ${ai} out of range`);
    const o = bin.byteOffset + v.byteOffset + (a.byteOffset || 0);
    return a.componentType === 5126 ? new Float32Array(bin.buffer.slice(o, o + n * 4))
      : a.componentType === 5125 ? new Uint32Array(bin.buffer.slice(o, o + n * 4)) : new Uint16Array(bin.buffer.slice(o, o + n * 2));
  };
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let tris = 0, prims = 0, nan = 0, badIdx = 0, degenerate = 0;
  for (const m of J.meshes) for (const p of m.primitives) {
    prims++;
    const pos = read(p.attributes.POSITION), cnt = J.accessors[p.attributes.POSITION].count;
    for (const k of ['NORMAL', 'TEXCOORD_0', 'TEXCOORD_1']) if (p.attributes[k] !== undefined && J.accessors[p.attributes[k]].count !== cnt) err.push(`${m.name}: ${k} count`);
    for (let i = 0; i < pos.length; i++) { if (!Number.isFinite(pos[i])) nan++; const k = i % 3; if (pos[i] < mn[k]) mn[k] = pos[i]; if (pos[i] > mx[k]) mx[k] = pos[i]; }
    const idx = read(p.indices);
    if (idx.length % 3) err.push(`${m.name}: index count % 3`);
    for (let i = 0; i < idx.length; i++) if (idx[i] >= cnt) badIdx++;
    for (let i = 0; i < idx.length; i += 3) if (idx[i] === idx[i + 1] || idx[i + 1] === idx[i + 2] || idx[i] === idx[i + 2]) degenerate++;
    tris += idx.length / 3;
    if (p.material === undefined || !J.materials[p.material]) err.push(`${m.name}: bad material`);
  }
  if (nan) err.push(`${nan} non-finite positions`);
  if (badIdx) err.push(`${badIdx} indices out of range`);
  const dir = path.dirname(file);
  for (const im of J.images || []) {
    const f = path.join(dir, im.uri);
    if (!fs.existsSync(f)) { err.push(`missing image ${im.uri}`); continue; }
    const b = fs.readFileSync(f);
    if (b.readUInt32BE(0) !== 0x89504e47) err.push(`not PNG ${im.uri}`);
  }
  for (const t of J.textures || []) if (!J.images[t.source]) err.push('texture without image');
  return { ok: err.length === 0, errors: err.slice(0, 20), meshes: J.meshes.length, primitives: prims, tris, degenerate, materials: J.materials.length, images: (J.images || []).length, bounds: { min: mn, max: mx } };
}

// ---- export -------------------------------------------------------------------------------
function attrObjTexture(buf, file, a) { // i3TextureBindAttr / i3LuxMapBindAttr -> i3Texture object
  const ao = a && file.byId.get(a.id);
  return ao ? file.byId.get(buf.readUInt32LE(ao.off) & 0xffff) || null : null;
}

export function exportVisual(mapName, { packDir = clientPath(baseClient('cross'), 'Pack'), outRoot = assetPath('maps'), log = console.log, dirName, ddsOnly = false } = {}) {
  const packFile = path.join(packDir, `${mapName}.i3Pack`);
  const d = fs.readFileSync(packFile);
  const scenes = scanI3R2(d).filter((b) => b.objects.some((o) => o.cls === 'i3Geometry'))
    .sort((a, b) => b.objects.filter((o) => o.cls === 'i3Geometry').length - a.objects.filter((o) => o.cls === 'i3Geometry').length);
  if (!scenes.length) throw new Error(`${mapName}: no scene with i3Geometry`);
  const file = scenes[0];
  const meshes = collectMeshes(d, file, { log: (s) => log('  ' + s) });

  // textures: embedded i3Texture objects hold an I3IB; external ones live in <Map>_Textures / <Map> packs
  const packTex = [];
  for (const extra of [`${mapName}_Textures.i3Pack`, `${mapName}.i3Pack`]) {
    const f = path.join(packDir, extra);
    if (fs.existsSync(f)) packTex.push(...scanI3IB(extra === `${mapName}.i3Pack` ? d : fs.readFileSync(f), extra));
  }
  const wanted = new Set();
  for (const m of meshes) for (const k of ['i3TextureBindAttr', 'i3LuxMapBindAttr']) {
    const t = attrObjTexture(d, file, m.state[k]);
    if (t?.ext) wanted.add(t.extPath);
  }
  const { res, missing, guessed } = buildResolver(packTex, [...wanted]);
  const texOf = (a) => { // -> I3IB descriptor or null
    const t = attrObjTexture(d, file, a);
    if (!t) return null;
    if (t.ext) return res.get(t.extPath) || null;
    const i = readI3IB(d, t.off, t.off + t.size);
    return i ? { ...i, buf: d, source: 'embedded' } : null;
  };

  const outDir = path.join(outRoot, dirName || mapName.toLowerCase());
  const texDir = path.join(outDir, 'tex');
  if (!ddsOnly) fs.rmSync(texDir, { recursive: true, force: true });
  fs.mkdirSync(texDir, { recursive: true });
  const ddsStats = { dds: 0, pngOnly: 0, bytes: 0 };

  const G = new GLBBuilder();
  const J = G.json;
  J.images = []; J.textures = []; J.materials = []; J.meshes = []; J.nodes = [];
  J.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  const texIndex = new Map(); // I3IB offset key -> { index, hasAlpha }
  const usedNames = new Set();
  const texture = (t) => {
    const key = t.source + ':' + t.data;
    if (texIndex.has(key)) return texIndex.get(key);
    let r = null;
    if (t.kind !== 'unsupported') {
      let rgba = null, hasAlpha;
      if (ddsOnly && t.kind !== 'raw') hasAlpha = hasAlphaFast(t.buf, t);
      else {
        rgba = decodeI3IB(t.buf, t);
        let minA = 255;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < minA) minA = rgba[i];
        hasAlpha = minA < 250;
      }
      let name = (t.srcPath ? stem(t.srcPath) : t.guessName || `tex_${t.data.toString(16)}`).replace(/[^\w.-]+/g, '_');
      while (usedNames.has(name.toLowerCase())) name += '_';
      usedNames.add(name.toLowerCase());
      if (!ddsOnly) fs.writeFileSync(path.join(texDir, name + '.png'), encodePNG(rgba, t.w, t.h, hasAlpha));
      const dds = ddsOf(t.buf, t, hasAlpha);
      if (dds) { fs.writeFileSync(path.join(texDir, name + '.dds'), dds); ddsStats.dds++; ddsStats.bytes += dds.length; }
      else { fs.rmSync(path.join(texDir, name + '.dds'), { force: true }); ddsStats.pngOnly++; }
      J.images.push({ uri: `tex/${encodeURIComponent(name)}.png`, name });
      J.textures.push({ source: J.images.length - 1, sampler: 0 });
      r = { index: J.textures.length - 1, hasAlpha, kind: t.kind, w: t.w, h: t.h };
    }
    texIndex.set(key, r);
    return r;
  };

  // materials
  const matIndex = new Map(), groups = new Map();
  const stats = { primitives: 0, tris: 0, verts: 0, keyed: 0, keyedTris: 0, noTexture: 0 };
  for (const m of meshes) {
    const st = m.state;
    const texOn = st.i3TextureEnableAttr?.value !== false, luxOn = st.i3LuxMapEnableAttr?.value !== false;
    const base = texOn ? texOf(st.i3TextureBindAttr) : null;
    const lux = luxOn ? texOf(st.i3LuxMapBindAttr) : null;
    const bt = base && texture(base), lt = lux && texture(lux);
    if (!bt) stats.noTexture++;
    const cullAttr = st.i3FaceCullModeAttr ? d[file.byId.get(st.i3FaceCullModeAttr.id).off] : null; // D3DCULL: 1 none, 2 cw, 3 ccw
    const doubleSided = cullAttr === 1;
    const blend = st.i3BlendEnableAttr?.value === true;
    const alphaTest = st.i3AlphaTestEnableAttr?.value === true;
    const alphaMode = bt?.hasAlpha ? (blend && !alphaTest ? 'BLEND' : 'MASK') : 'OPAQUE';
    const cutoff = st.i3AlphaFuncAttr ? Math.max(0.05, Math.min(0.95, (st.i3AlphaFuncAttr.ref || 128) / 255)) : 0.5;
    const key = [bt?.index, lt?.index, alphaMode, doubleSided, cutoff].join('|');
    if (!matIndex.has(key)) {
      const texName = base ? (base.srcPath ? stem(base.srcPath) : base.guessName || 'tex') : 'untextured';
      const mat = { name: texName + (lt ? '+lm' : ''), pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 }, extras: {} };
      if (bt) mat.pbrMetallicRoughness.baseColorTexture = { index: bt.index, texCoord: 0 };
      if (lt) { mat.occlusionTexture = { index: lt.index, texCoord: 1 }; mat.extras.lightMap = { index: lt.index, texCoord: 1 }; }
      if (alphaMode !== 'OPAQUE') mat.alphaMode = alphaMode;
      if (alphaMode === 'MASK') mat.alphaCutoff = cutoff;
      if (doubleSided) mat.doubleSided = true;
      if (!Object.keys(mat.extras).length) delete mat.extras;
      J.materials.push(mat);
      matIndex.set(key, J.materials.length - 1);
      groups.set(J.materials.length - 1, []);
    }
    const mi = matIndex.get(key);

    let idx;
    try { idx = meshIndices(m).indices; } catch { stats.keyed++; stats.keyedTris += m.geo.primCount; continue; }
    // compact the shared vertex array to the vertices this GEO2 uses, bake the world matrix
    const remap = new Map(), order = [];
    const local = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i++) {
      let r = remap.get(idx[i]);
      if (r === undefined) { r = order.length; remap.set(idx[i], r); order.push(idx[i]); }
      local[i] = r;
    }
    const { det, n: N } = normalMatrix(m.world);
    if (det < 0) for (let i = 0; i < local.length; i += 3) { const t = local[i + 1]; local[i + 1] = local[i + 2]; local[i + 2] = t; }
    const va = m.va, W = m.world, nv = order.length;
    const pos = new Float32Array(nv * 3), nrm = va.nrm ? new Float32Array(nv * 3) : null;
    const uv0 = va.uv[0] ? new Float32Array(nv * 2) : null, uv1 = va.uv[1] && lt ? new Float32Array(nv * 2) : null;
    order.forEach((s, i) => {
      const p = xformP(W, va.pos[s * 3], va.pos[s * 3 + 1], va.pos[s * 3 + 2]);
      pos.set(p, i * 3);
      if (nrm) {
        const x = va.nrm[s * 3], y = va.nrm[s * 3 + 1], z = va.nrm[s * 3 + 2];
        const nx = x * N[0] + y * N[3] + z * N[6], ny = x * N[1] + y * N[4] + z * N[7], nz = x * N[2] + y * N[5] + z * N[8];
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
      }
      if (uv0) { uv0[i * 2] = va.uv[0][s * 2]; uv0[i * 2 + 1] = va.uv[0][s * 2 + 1]; }
      if (uv1) { uv1[i * 2] = va.uv[1][s * 2]; uv1[i * 2 + 1] = va.uv[1][s * 2 + 1]; }
    });
    groups.get(mi).push({ name: m.name, pos, nrm, uv0, uv1, idx: nv < 65536 ? Uint16Array.from(local) : local });
    stats.primitives++; stats.tris += local.length / 3; stats.verts += nv;
  }

  for (const [mi, prims] of groups) {
    if (!prims.length) continue;
    const mesh = { name: J.materials[mi].name, primitives: [], extras: { sources: prims.map((p) => p.name) } };
    for (const p of prims) {
      const attributes = { POSITION: G.accessor(p.pos, 'VEC3', 5126, 34962, true) };
      if (p.nrm) attributes.NORMAL = G.accessor(p.nrm, 'VEC3', 5126, 34962);
      if (p.uv0) attributes.TEXCOORD_0 = G.accessor(p.uv0, 'VEC2', 5126, 34962);
      if (p.uv1) attributes.TEXCOORD_1 = G.accessor(p.uv1, 'VEC2', 5126, 34962);
      const indices = G.accessor(p.idx, 'SCALAR', p.idx instanceof Uint16Array ? 5123 : 5125, 34963);
      mesh.primitives.push({ attributes, indices, material: mi, mode: 4 });
    }
    J.meshes.push(mesh);
    J.nodes.push({ name: mesh.name, mesh: J.meshes.length - 1 });
  }
  J.scenes = [{ name: mapName, nodes: J.nodes.map((_, i) => i) }];
  J.scene = 0;
  J.extras = { source: `${mapName}.i3Pack`, axes: 'i3 world == three.js (Y-up, metres), see tools/AXES.md', lightMap: 'material.extras.lightMap = { index, texCoord: 1 }' };

  if (ddsOnly) return { summary: { ...ddsStats, names: J.images.map((i) => i.name) }, outDir };
  const glbFile = path.join(outDir, 'visual.glb');
  fs.writeFileSync(glbFile, G.build());
  const check = checkGLB(glbFile);
  const summary = {
    source: `${mapName}.i3Pack`, scene: { base: file.base, objects: file.objects.length, otherScenes: scenes.length - 1 },
    meshes: J.meshes.length, primitives: stats.primitives, tris: stats.tris, verts: stats.verts,
    materials: J.materials.length, textures: J.images.length,
    lightmapped: J.materials.filter((m) => m.occlusionTexture).length,
    alpha: { MASK: J.materials.filter((m) => m.alphaMode === 'MASK').length, BLEND: J.materials.filter((m) => m.alphaMode === 'BLEND').length },
    skipped: { keyedGeometries: stats.keyed, keyedTris: stats.keyedTris, untexturedGeometries: stats.noTexture, missingTextures: missing.map(stem), guessedTextureNames: guessed },
    bounds: check.bounds, check: { ok: check.ok, errors: check.errors, degenerateTris: check.degenerate },
  };
  fs.writeFileSync(path.join(outDir, 'visual.json'), JSON.stringify(summary, null, 1));
  return { summary, outDir };
}

// ---- CLI ------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  opt('--client'); // read by baseClient() from argv
  const packDir = opt('--pack-dir') ?? opt('--root'), outRoot = opt('--out'), dirName = opt('--name'); // --root: alternative pack root (e.g. Clients/PBKaybo/GameData/Apps/PB/Pack)
  const checkOnly = args.includes('--check-only'); if (checkOnly) args.splice(args.indexOf('--check-only'), 1);
  if (!args.length) { console.error('usage: export-visual.mjs <Map> [...Map] [--pack-dir DIR] [--out DIR] [--name DIR_NAME] [--check-only]'); process.exit(2); }
  if (dirName && args.length > 1) { console.error('--name needs exactly one <Map>'); process.exit(2); }
  let bad = 0;
  for (const map of args) {
    const root = outRoot ? path.resolve(outRoot) : assetPath('maps');
    const dir = path.join(root, dirName || map.toLowerCase());
    try {
      if (!checkOnly) {
        const { summary: s } = exportVisual(map, { ...(packDir && { packDir: path.resolve(packDir) }), outRoot: root, dirName });
        console.log(`${map}: meshes=${s.meshes} prims=${s.primitives} tris=${s.tris} verts=${s.verts} materials=${s.materials} textures=${s.textures} lightmapped=${s.lightmapped} alpha=${JSON.stringify(s.alpha)} keyedSkipped=${s.skipped.keyedGeometries} missingTex=${s.skipped.missingTextures.length} guessed=${s.skipped.guessedTextureNames.join(',') || '-'}`);
      }
      const c = checkGLB(path.join(dir, 'visual.glb'));
      const r = (v) => v.map((x) => +x.toFixed(2));
      console.log(`  check ${c.ok ? 'OK' : 'FAIL'}: meshes=${c.meshes} prims=${c.primitives} tris=${c.tris} images=${c.images} bounds min=${r(c.bounds.min)} max=${r(c.bounds.max)}${c.ok ? '' : ' ' + c.errors.join('; ')}`);
      const colFile = path.join(dir, 'collision.json');
      if (fs.existsSync(colFile)) {
        const col = JSON.parse(fs.readFileSync(colFile, 'utf8'));
        if (col.bounds?.min?.every(Number.isFinite)) {
          const dmin = c.bounds.min.map((v, k) => v - col.bounds.min[k]), dmax = c.bounds.max.map((v, k) => v - col.bounds.max[k]);
          console.log(`  vs collision: dMin=${r(dmin)} dMax=${r(dmax)}`);
        } else console.log('  vs collision: collision.json has no bounds yet');
        const sp = (col.respawns || []).filter((s) => s.pos);
        const inside = sp.filter((s) => s.pos.every((v, k) => v >= c.bounds.min[k] - 1 && v <= c.bounds.max[k] + 1)).length;
        if (sp.length) console.log(`  respawns inside visual bounds: ${inside}/${sp.length}`);
      }
      if (!c.ok) bad++;
    } catch (e) { bad++; console.error(`${map}: ERROR ${e.stack}`); }
  }
  process.exitCode = bad ? 1 : 0;
}
