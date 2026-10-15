// GLB writer / checker and I3IB texture decoding for the model + animation exporters, pure Node ESM.
// The I3IB/DXT/PNG code is the same as tools/export-visual.mjs (not exported there, so kept in sync by hand).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fail } from '../lib/paths.mjs';

// ---- I3IB textures ------------------------------------------------------------------------
export function readI3IB(d, o, end = d.length) {
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
    if (![1, 2, 3, 4].includes(bpp)) bpp = Math.floor((end - data) / (w * h));
    if (![3, 4].includes(bpp)) return { w, h, format, kind: 'unsupported', srcPath, data };
  }
  return { w, h, format, kind, bpp, mips, srcPath, data, off: o };
}

// Palette (4 x RGBA), block alpha and the 16 alpha values live in these typed arrays: no allocation per 4x4 block.
// Same float math as the first version, so the decoded bytes do not change.
const PAL = new Float64Array(16), ALPHA = new Float64Array(16), AV = new Float64Array(8);
// 565 colour -> PAL[o..o+2], alpha 255 at PAL[o+3]
function c565Into(c, o) {
  PAL[o] = ((c >> 11) & 31) * 255 / 31; PAL[o + 1] = ((c >> 5) & 63) * 255 / 63; PAL[o + 2] = (c & 31) * 255 / 31; PAL[o + 3] = 255;
}

export function decodeI3IB(d, t) {
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
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let b = t.data + (by * bw + bx) * bsz;
    if (t.kind === 'dxt3') {
      for (let i = 0; i < 16; i++) ALPHA[i] = ((d[b + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      b += 8;
    } else if (t.kind === 'dxt5') {
      const a0 = d[b], a1 = d[b + 1];
      AV[0] = a0; AV[1] = a1;
      if (a0 > a1) for (let i = 1; i < 7; i++) AV[i + 1] = ((7 - i) * a0 + i * a1) / 7;
      else { for (let i = 1; i < 5; i++) AV[i + 1] = ((5 - i) * a0 + i * a1) / 5; AV[6] = 0; AV[7] = 255; }
      // 16 three-bit indices = 48 bits: a double holds that exactly (below 2^53), so no BigInt per texel
      let bits = 0;
      for (let i = 0; i < 6; i++) bits += d[b + 2 + i] * 2 ** (8 * i);
      for (let i = 0; i < 16; i++) ALPHA[i] = AV[Math.floor(bits / 2 ** (3 * i)) & 7];
      b += 8;
    }
    const c0 = d.readUInt16LE(b), c1 = d.readUInt16LE(b + 2);
    c565Into(c0, 0); c565Into(c1, 4);
    if (c0 > c1 || t.kind !== 'dxt1') {
      for (let k = 0; k < 3; k++) {
        PAL[8 + k] = (2 * PAL[k] + PAL[4 + k]) / 3;
        PAL[12 + k] = (PAL[k] + 2 * PAL[4 + k]) / 3;
      }
      PAL[11] = 255; PAL[15] = 255;
    } else {
      for (let k = 0; k < 3; k++) PAL[8 + k] = (PAL[k] + PAL[4 + k]) / 2;
      PAL[11] = 255; PAL[12] = 0; PAL[13] = 0; PAL[14] = 0; PAL[15] = 0;
    }
    const idx = d.readUInt32LE(b + 4);
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const c = ((idx >>> (2 * i)) & 3) * 4, o = (y * w + x) * 4;
      out[o] = PAL[c]; out[o + 1] = PAL[c + 1]; out[o + 2] = PAL[c + 2];
      out[o + 3] = t.kind === 'dxt1' ? PAL[c + 3] : ALPHA[i];
    }
  }
  return out;
}

// zlib level of the IDAT stream. 9 = the default, the bytes every earlier run wrote. PB_PNG_LEVEL=0-8 is faster for 6 and
// gives other, slightly bigger bytes: a sha of the PNGs then differs from the default.
export const PNG_LEVEL = pngLevel();
function pngLevel() {
  const v = process.env.PB_PNG_LEVEL;
  if (v === undefined || v === '') return 9;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 9) fail(`PB_PNG_LEVEL must be an integer 0-9, got "${v}"`);
  return n;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); // node >= 22.2: same CRC-32 as the table version it replaces
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(rgba, w, h, withAlpha) {
  const ch = withAlpha ? 4 : 3, row = w * ch + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    if (withAlpha) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * row + 1); // RGBA row is already the PNG row
    else for (let x = 0; x < w; x++) for (let k = 0; k < ch; k++) raw[y * row + 1 + x * ch + k] = rgba[(y * w + x) * 4 + k];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = withAlpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: PNG_LEVEL })), pngChunk('IEND', Buffer.alloc(0))]);
}

export const normPath = (p) => p.replace(/\\/g, '/').toLowerCase();
export const stem = (p) => path.posix.basename(normPath(p)).replace(/\.[^.]*$/, '');

// Every I3IB in a buffer (payload ends at the next I3IB / EOF), indexed by path and stem.
export function textureLibrary(buffers) {
  const byPath = new Map(), byStem = new Map();
  for (const [d, source] of buffers) {
    const hits = [];
    for (let p = d.indexOf('I3IB'); p >= 0; p = d.indexOf('I3IB', p + 4)) hits.push(p);
    hits.forEach((p, i) => {
      const t = readI3IB(d, p, hits[i + 1] ?? d.length);
      if (!t || !t.srcPath) return;
      const e = { ...t, buf: d, source };
      if (!byPath.has(normPath(t.srcPath))) byPath.set(normPath(t.srcPath), e);
      if (!byStem.has(stem(t.srcPath))) byStem.set(stem(t.srcPath), e);
    });
  }
  return { get: (p) => byPath.get(normPath(p)) || byStem.get(stem(p)) || null, size: byPath.size };
}

// ---- GLB builder --------------------------------------------------------------------------
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
export class GLB {
  constructor(generator) {
    this.chunks = []; this.len = 0;
    this.json = { asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], buffers: [], bufferViews: [], accessors: [] };
  }
  view(arr, target) {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.len += pad; }
    const bv = { buffer: 0, byteOffset: this.len, byteLength: arr.byteLength };
    if (target) bv.target = target;
    this.chunks.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); this.len += arr.byteLength;
    this.json.bufferViews.push(bv);
    return this.json.bufferViews.length - 1;
  }
  accessor(arr, type, target, { minmax = false, normalized = false } = {}) {
    const componentType = arr instanceof Float32Array ? 5126 : arr instanceof Uint32Array ? 5125 : arr instanceof Uint16Array ? 5123 : 5121;
    const nc = NCOMP[type];
    const acc = { bufferView: this.view(arr, target), componentType, count: arr.length / nc, type };
    if (normalized) acc.normalized = true;
    if (minmax) {
      const mn = new Array(nc).fill(Infinity), mx = new Array(nc).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) { const k = i % nc; if (arr[i] < mn[k]) mn[k] = arr[i]; if (arr[i] > mx[k]) mx[k] = arr[i]; }
      acc.min = mn; acc.max = mx;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  node(n) { this.json.nodes.push(n); return this.json.nodes.length - 1; }
  build() {
    const J = this.json;
    for (const k of ['materials', 'meshes']) if (!J[k].length) delete J[k];
    const bin = Buffer.concat(this.chunks);
    const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    J.buffers = [{ byteLength: binPad.length }];
    let js = Buffer.from(JSON.stringify(J), 'utf8');
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const hdr = Buffer.alloc(12); hdr.write('glTF', 0, 'latin1'); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8);
    const ch = (b, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, b]); };
    return Buffer.concat([hdr, ch(js, 'JSON'), ch(binPad, 'BIN\0')]);
  }
}

// ---- independent GLB reader / checker -------------------------------------------------------
export function readGLB(file) {
  const g = fs.readFileSync(file);
  if (g.toString('latin1', 0, 4) !== 'glTF' || g.readUInt32LE(4) !== 2) throw new Error('bad GLB header');
  if (g.readUInt32LE(8) !== g.length) throw new Error('GLB length mismatch');
  const jl = g.readUInt32LE(12);
  if (g.toString('latin1', 16, 20) !== 'JSON') throw new Error('no JSON chunk');
  const J = JSON.parse(g.toString('utf8', 20, 20 + jl));
  const bo = 20 + jl, bl = g.readUInt32LE(bo);
  if (g.toString('latin1', bo + 4, bo + 8) !== 'BIN\0') throw new Error('no BIN chunk');
  const bin = g.subarray(bo + 8, bo + 8 + bl);
  const CS = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
  const read = (ai) => {
    const a = J.accessors[ai], v = J.bufferViews[a.bufferView];
    const n = a.count * NCOMP[a.type], sz = CS[a.componentType];
    const o = v.byteOffset + (a.byteOffset || 0);
    if (o + n * sz > bin.length) throw new Error(`accessor ${ai} out of range`);
    const b = bin.buffer.slice(bin.byteOffset + o, bin.byteOffset + o + n * sz);
    return a.componentType === 5126 ? new Float32Array(b) : a.componentType === 5125 ? new Uint32Array(b) : a.componentType === 5123 ? new Uint16Array(b) : new Uint8Array(b);
  };
  return { J, read, dir: path.dirname(file) };
}

export function checkGLB(file) {
  const { J, read, dir } = readGLB(file);
  const err = [];
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let tris = 0, prims = 0, badIdx = 0, nan = 0, badW = 0, badJ = 0;
  for (const m of J.meshes || []) for (const p of m.primitives) {
    prims++;
    const cnt = J.accessors[p.attributes.POSITION].count;
    for (const [k, ai] of Object.entries(p.attributes)) if (J.accessors[ai].count !== cnt) err.push(`${m.name}: ${k} count`);
    const pos = read(p.attributes.POSITION);
    for (let i = 0; i < pos.length; i++) { if (!Number.isFinite(pos[i])) nan++; const k = i % 3; if (pos[i] < mn[k]) mn[k] = pos[i]; if (pos[i] > mx[k]) mx[k] = pos[i]; }
    const idx = read(p.indices);
    if (idx.length % 3) err.push(`${m.name}: index count % 3`);
    for (let i = 0; i < idx.length; i++) if (idx[i] >= cnt) badIdx++;
    tris += idx.length / 3;
    if (p.material === undefined || !J.materials[p.material]) err.push(`${m.name}: bad material`);
    if (p.attributes.WEIGHTS_0 !== undefined) {
      const w = read(p.attributes.WEIGHTS_0), j = read(p.attributes.JOINTS_0);
      const skinNode = J.nodes.find((n) => n.mesh === J.meshes.indexOf(m));
      const nJ = skinNode && skinNode.skin !== undefined ? J.skins[skinNode.skin].joints.length : 0;
      if (!nJ) err.push(`${m.name}: skinned primitive on a node without skin`);
      for (let i = 0; i < w.length; i += 4) { const s = w[i] + w[i + 1] + w[i + 2] + w[i + 3]; if (Math.abs(s - 1) > 1e-3) badW++; }
      for (let i = 0; i < j.length; i++) if (j[i] >= nJ) badJ++;
    }
  }
  if (nan) err.push(`${nan} non-finite positions`);
  if (badIdx) err.push(`${badIdx} indices out of range`);
  if (badW) err.push(`${badW} vertices with weight sum != 1`);
  if (badJ) err.push(`${badJ} joint indices out of range`);
  for (const s of J.skins || []) {
    const ibm = read(s.inverseBindMatrices);
    if (ibm.length !== s.joints.length * 16) err.push('inverseBindMatrices count');
    if (s.joints.some((j) => !J.nodes[j])) err.push('skin joint missing');
  }
  const clips = [];
  for (const a of J.animations || []) {
    let dur = 0;
    for (const c of a.channels) {
      const s = a.samplers[c.sampler];
      if (!s || !J.nodes[c.target.node]) { err.push(`${a.name}: bad channel`); continue; }
      const t = read(s.input), v = read(s.output);
      const nc = { translation: 3, rotation: 4, scale: 3 }[c.target.path];
      if (v.length !== t.length * nc) err.push(`${a.name}: sampler ${c.sampler} output count`);
      for (let i = 1; i < t.length; i++) if (!(t[i] > t[i - 1])) { err.push(`${a.name}: non-increasing times`); break; }
      for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) { err.push(`${a.name}: non-finite key`); break; }
      dur = Math.max(dur, t[t.length - 1]);
    }
    clips.push({ name: a.name, channels: a.channels.length, duration: +dur.toFixed(3) });
  }
  for (const im of J.images || []) {
    const f = path.join(dir, decodeURIComponent(im.uri));
    if (!fs.existsSync(f)) { err.push(`missing image ${im.uri}`); continue; }
    if (fs.readFileSync(f).readUInt32BE(0) !== 0x89504e47) err.push(`not PNG ${im.uri}`);
  }
  return { ok: err.length === 0, errors: err.slice(0, 20), meshes: (J.meshes || []).length, primitives: prims, tris, nodes: J.nodes.length,
    joints: (J.skins || []).reduce((s, k) => s + k.joints.length, 0), materials: (J.materials || []).length, images: (J.images || []).length,
    clips, bounds: { min: mn.map((v) => +v.toFixed(4)), max: mx.map((v) => +v.toFixed(4)) } };
}
