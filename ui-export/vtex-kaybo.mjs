#!/usr/bin/env node
// PBKaybo 2017 virtual texture ("VTV2") reader: UIRe/PointBlankRe.* and UI_Temp/PBRe.*. Pure Node ESM.
//
//   node ui-export/vtex-kaybo.mjs --list [UIRe|UI_Temp]
//   node ui-export/vtex-kaybo.mjs --png OUTDIR [UIRe|UI_Temp] [name ...]   # whole images
//
// Format (decoded from the files; the loader was not disassembled):
//   <base>.i3VTex  +0x00 'VTV2'  +0x04 u32 pixel format  +0x08 u32 1  +0x0C u32 width (32768)  +0x10 u32 height (32768)
//                  +0x18 u32 table offset (0x228)  +0x20 u32 offset of the tiles stored in this file (0x180800)
//     table: 256 x 256 entries (one per 128x128 tile of the virtual texture, row-major), 16 bytes each:
//       u32 refTex index (owner image), u32 sub-file (0 = this .i3VTex, n = n-th file of the .i3Subset),
//       u64 byte offset of the tile inside that file (0 with sub-file 0 = empty tile).
//     0x100228..0x180800 holds an allocation bitmap (not needed to read).
//   Pixel format 0xA0000604 (UIRe): DXT5, 16 KB per tile (32x32 blocks, row-major).
//                0x20000406 (UI_Temp): BGRA8, 64 KB per tile (128 rows of 512 bytes).
//   No cipher: tiles are plain (unlike the 3.123 V12 .i3VTexImage, see vtex-crypt.mjs).
//   <base>.i3RefTex u32 count, then count x 320 bytes: +0x20 char path[256] ("UIRe/Image/Main/UI_Source_6.tga"),
//     +0x120 16-byte hash, +0x130 u32 w, h, x, y = the image's rectangle in the virtual texture.
//   <base>.i3Subset 'VTS1' u32 nSubsets, u32 nFiles; nSubsets x 540 bytes (dir, name), then nFiles x 296 bytes
//     (char path[256] relative to the Apps/PB folder, "UIRe/Main_0.i3VTexSub", +260 u32 subset index).
//   <name>.i3VTexSub: 2048-byte zero header, then tiles in the table's pixel format.
//   UIRe/Ingame_0 and Loading_0 .i3VTexSub are stale (not listed in the .i3Subset, 2013 files).

import { clientPath, extractedPath, rel, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPS = clientPath(baseClient('kaybo'));
export const ROOTS = { UIRe: 'UIRe/PointBlankRe', UI_Temp: 'UI_Temp/PBRe' };
const T = 128, GRID = 256;
const FMT = { 0xa0000604: { name: 'DXT5', bytes: T * T }, 0x20000406: { name: 'BGRA8', bytes: T * T * 4 } };

const stem = p => p.split(/[\\/]/).pop().replace(/\.[^.]*$/, '').trim().toLowerCase();
const cstr = (b, o, n) => { const e = b.indexOf(0, o); return b.toString('latin1', o, e < 0 || e > o + n ? o + n : e); };

function readAt(fd, off, len) { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; }

// ---- DXT5 -----------------------------------------------------------------------------------------
const c565 = (c, o) => { const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31; o[0] = (r << 3) | (r >> 2); o[1] = (g << 2) | (g >> 4); o[2] = (b << 3) | (b >> 2); };
/** One 128x128 DXT5 tile -> RGBA (straight alpha). */
export function decodeDXT5Tile(src, out = Buffer.alloc(T * T * 4)) {
  const a = new Uint8Array(8), col = [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)];
  const bw = T / 4;
  for (let by = 0; by < bw; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * 16;
    a[0] = src[o]; a[1] = src[o + 1];
    if (a[0] > a[1]) for (let i = 1; i < 7; i++) a[i + 1] = ((7 - i) * a[0] + i * a[1] + 3) / 7 | 0;
    else { for (let i = 1; i < 5; i++) a[i + 1] = ((5 - i) * a[0] + i * a[1] + 2) / 5 | 0; a[6] = 0; a[7] = 255; }
    const abits = src.readUIntLE(o + 2, 6);
    const c0 = src.readUInt16LE(o + 8), c1 = src.readUInt16LE(o + 10);
    c565(c0, col[0]); c565(c1, col[1]);
    for (let k = 0; k < 3; k++) { col[2][k] = (2 * col[0][k] + col[1][k] + 1) / 3 | 0; col[3][k] = (col[0][k] + 2 * col[1][k] + 1) / 3 | 0; }
    const ci = src.readUInt32LE(o + 12);
    for (let p = 0; p < 16; p++) {
      const c = col[(ci >>> (2 * p)) & 3], al = a[Math.floor(abits / 2 ** (3 * p)) & 7];
      const d = ((by * 4 + (p >> 2)) * T + bx * 4 + (p & 3)) * 4;
      out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = al;
    }
  }
  return out;
}
function decodeBGRATile(src, out = Buffer.alloc(T * T * 4)) {
  for (let i = 0; i < T * T * 4; i += 4) { out[i] = src[i + 2]; out[i + 1] = src[i + 1]; out[i + 2] = src[i]; out[i + 3] = src[i + 3]; }
  return out;
}

// ---- virtual texture ------------------------------------------------------------------------------
const opened = {};
/** Open one VTV2 set ('UIRe' | 'UI_Temp'). */
export function openVTex(root = 'UIRe') {
  if (opened[root]) return opened[root];
  const base = path.join(APPS, ROOTS[root]);
  const vfile = base + '.i3VTex';
  if (!fs.existsSync(vfile)) return (opened[root] = null);
  const fd = fs.openSync(vfile, 'r'), h = readAt(fd, 0, 0x40);
  if (h.toString('latin1', 0, 4) !== 'VTV2') throw new Error(`${vfile}: not VTV2`);
  const fmtCode = h.readUInt32LE(4), fmt = FMT[fmtCode];
  if (!fmt) throw new Error(`${vfile}: unknown pixel format 0x${fmtCode.toString(16)}`);
  const W = h.readUInt32LE(0x0c), H = h.readUInt32LE(0x10), tabOff = h.readUInt32LE(0x18);
  const table = readAt(fd, tabOff, GRID * GRID * 16);
  // sub-files (1-based in the table)
  const subs = [{ file: vfile, fd }];
  const sf = base + '.i3Subset';
  if (fs.existsSync(sf)) {
    const s = fs.readFileSync(sf), nSub = s.readUInt32LE(4), nFile = s.readUInt32LE(8), fb = 0x1c + nSub * 540;
    for (let i = 0; i < nFile; i++) {
      const f = path.join(APPS, cstr(s, fb + i * 296, 256));
      subs.push({ file: f, fd: fs.existsSync(f) ? fs.openSync(f, 'r') : null });
    }
  }
  const r = fs.readFileSync(base + '.i3RefTex'), images = [], byPath = new Map(), byStem = new Map();
  for (let i = 0, n = r.readUInt32LE(0); i < n; i++) {
    const o = 4 + i * 320, p = cstr(r, o + 0x20, 256);
    const im = { index: i, path: p, key: stem(p), w: r.readUInt32LE(o + 0x130), h: r.readUInt32LE(o + 0x134), x: r.readUInt32LE(o + 0x138), y: r.readUInt32LE(o + 0x13c) };
    images.push(im); byPath.set(p.toLowerCase().replace(/\\/g, '/'), im);
    if (!byStem.has(im.key)) byStem.set(im.key, []);
    byStem.get(im.key).push(im);
  }
  const tileCache = new Map();
  function tile(tx, ty) {
    const k = ty * GRID + tx;
    if (tileCache.has(k)) return tileCache.get(k);
    const e = k * 16, sub = table.readUInt32LE(e + 4), off = table.readUInt32LE(e + 8) + table.readUInt32LE(e + 12) * 2 ** 32;
    let px = null;
    if (sub < subs.length && subs[sub].fd !== null && (sub || off)) {
      const src = readAt(subs[sub].fd, off, fmt.bytes);
      px = fmt.name === 'DXT5' ? decodeDXT5Tile(src) : decodeBGRATile(src);
    }
    if (tileCache.size > 512) tileCache.clear();
    tileCache.set(k, px);
    return px;
  }
  /** Crop any rect of the virtual texture -> { w, h, rgba, tiles, emptyTiles }. */
  function readRect(x0, y0, w, h) {
    const rgba = Buffer.alloc(w * h * 4);
    let tiles = 0, emptyTiles = 0;
    for (let ty = Math.floor(y0 / T); ty * T < y0 + h; ty++) for (let tx = Math.floor(x0 / T); tx * T < x0 + w; tx++) {
      const px = tile(tx, ty); tiles++;
      if (!px) { emptyTiles++; continue; }
      const sx0 = Math.max(x0, tx * T), sx1 = Math.min(x0 + w, tx * T + T);
      for (let y = Math.max(y0, ty * T); y < Math.min(y0 + h, ty * T + T); y++)
        px.copy(rgba, ((y - y0) * w + sx0 - x0) * 4, ((y - ty * T) * T + sx0 - tx * T) * 4, ((y - ty * T) * T + sx1 - tx * T) * 4);
    }
    return { w, h, rgba, tiles, emptyTiles };
  }
  /** Image by template path ("UIRe/image/main/frame_1.tga") or by stem key; null when absent. */
  function find(key, shapePath) {
    if (shapePath) { const im = byPath.get(shapePath.toLowerCase().replace(/\\/g, '/')); if (im) return im; }
    return byStem.get(stem(key))?.[0] || null;
  }
  function readImage(im) { return { ...readRect(im.x, im.y, im.w, im.h), image: im }; }
  return (opened[root] = { root, file: vfile, format: fmt.name, W, H, images, subs, find, readImage, readRect });
}

/** Root a Kaybo template shape path belongs to ('UI_Temp/...' -> UI_Temp, everything else -> UIRe). */
export const rootOf = shapePath => (/^ui_temp[\\/]/i.test(shapePath || '') ? 'UI_Temp' : 'UIRe');

/** Hook for ui-atlas.mjs: image `key` of a Kaybo template shape -> { w, h, rgba, src, root } | null. */
export function loadKayboImage(key, shapePath) {
  // own set first; then the other set by name (a few UIRe templates point at images only UI_Temp holds)
  let vt = openVTex(rootOf(shapePath)), im = vt?.find(key, shapePath);
  if (!im) { vt = openVTex(rootOf(shapePath) === 'UIRe' ? 'UI_Temp' : 'UIRe'); im = vt?.find(key); }
  if (!im) return null;
  const root = vt.root;
  const r = vt.readImage(im);
  if (r.emptyTiles === r.tiles) return null;
  const srcFile = rel(vt.file);
  return { w: r.w, h: r.h, rgba: r.rgba, root, path: im.path, src: `${srcFile}:${im.x},${im.y},${im.w},${im.h}`, emptyTiles: r.emptyTiles };
}

// ---- weapon icons (--icons) -----------------------------------------------------------------------
// Same rule as W3's ui-icons.mjs for 3.123: _UIShapeIndex over the concatenation of the weapon-shape
// ButtonImageSets, stride 88 (shapes 88/89 of a set are `selectimage`, not icons). The 2017 Weapon.pef
// has no UITemplate list; the sets are ButtonImageSet_WeaponShape1_hs..13_hs of UIRe/PointBlankRe.i3Uil
// (weapon_select0..12; the 13th has 69 shapes, max _UIShapeIndex 1115 = set 13 shape 59).
// The 2017 weapons carry no ITEMID: itemId = (_UsageType + 1) * 100000 + _ClassType * 1000 + _Number
// (equals the 3.123 ITEMID for 1442 of the 1518 weapon names both clients share; the rest were renumbered).
// Config: extracted/pef2017/br/Weapon.json (tools/pef/extract-config.mjs, nation slot 1).
export const ICON_STRIDE = 88, ICON_SETS = 13;

export function weaponIconJobs(weaponJson) {
  const jobs = [];
  const walk = (o, kind) => {
    for (const [k, v] of Object.entries(o)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (v._UIShapeIndex != null && v._Number != null && v._ClassType != null && v._UsageType != null)
        jobs.push({ id: (v._UsageType + 1) * 100000 + v._ClassType * 1000 + v._Number, name: k, kind, index: v._UIShapeIndex });
      else walk(v, k);
    }
  };
  walk(weaponJson.WeaponList.Weapon, '');
  return jobs;
}

/** index -> { set, shape, s } in the Kaybo templates, or { reason }. */
export function weaponIconShape(T, index, stride = ICON_STRIDE) {
  if (index == null || index < 0) return { reason: 'no _UIShapeIndex' };
  const set = `ButtonImageSet_WeaponShape${Math.floor(index / stride) + 1}_hs`, k = index % stride;
  const s = T[set]?.shapes?.[k];
  if (!s) return { reason: `shape ${k} of ${set} does not exist` };
  if (!s.img || !s.uw || !s.vh) return { reason: `shape ${k} of ${set} is empty` };
  return { set, shape: k, s };
}

export function cropImage(img, u, v, w, h) {
  const rgba = Buffer.alloc(w * h * 4);
  let opaque = 0;
  for (let y = 0; y < h; y++) {
    if (v + y < img.h) img.rgba.copy(rgba, y * w * 4, ((v + y) * img.w + u) * 4, ((v + y) * img.w + Math.min(img.w, u + w)) * 4);
    for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4 + 3]) opaque++;
  }
  return { rgba, w, h, opaque };
}

async function exportIcons({ dry = false, check = false } = {}) {
  const { OUT, encodePNG, decodePNG, writeJSON } = await import('./lib.mjs');
  const T = JSON.parse(fs.readFileSync(path.join(OUT, 'templates', 'kaybo.json'), 'utf8')).templates;
  const cfg = extractedPath('pef2017', 'br', 'Weapon.json');
  const jobs = weaponIconJobs(JSON.parse(fs.readFileSync(cfg, 'utf8')));
  const imgCache = new Map();
  const image = (s) => { const k = s.path.toLowerCase(); if (!imgCache.has(k)) imgCache.set(k, loadKayboImage(s.img, s.path)); return imgCache.get(k); };
  if (check) {
    // stride check against W3's 3.123 icons of the same itemId + name. V12 redrew them at 183x80, so compare
    // silhouettes: alpha > 128 inside the opaque bounding box, resampled to 48x16, IoU. Only indexes >= 88
    // tell the strides apart. Result 2026-09-27: stride 88 -> 1194/1223 with IoU > 0.6 (mean 0.883),
    // stride 90 -> 94/1223 (mean 0.409).
    const v12 = JSON.parse(fs.readFileSync(path.join(OUT, 'icons', 'index.json'), 'utf8')).icons;
    const mask = (t, N = 48, M = 16) => {
      let x0 = t.w, y0 = t.h, x1 = -1, y1 = -1;
      for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.rgba[(y * t.w + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (x1 < 0) return null;
      const m = new Uint8Array(N * M);
      for (let j = 0; j < M; j++) for (let i = 0; i < N; i++)
        m[j * N + i] = t.rgba[((y0 + Math.floor((j + 0.5) * (y1 - y0 + 1) / M)) * t.w + x0 + Math.floor((i + 0.5) * (x1 - x0 + 1) / N)) * 4 + 3] > 128 ? 1 : 0;
      return m;
    };
    const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 0; };
    const res = { 88: [], 90: [] };
    for (const j of jobs) {
      const ref = v12[j.id];
      if (j.index < 88 || !ref || ref.family !== 'weapons' || ref.name.toLowerCase() !== j.name.toLowerCase()) continue;
      const mb = mask(decodePNG(fs.readFileSync(path.join(OUT, ref.sheet)))); if (!mb) continue;
      for (const stride of [88, 90]) {
        const r = weaponIconShape(T, j.index, stride);
        const ma = r.s && mask(cropImage(image(r.s), r.s.u, r.s.v, r.s.uw, r.s.vh));
        res[stride].push(ma ? iou(ma, mb) : 0);
      }
    }
    for (const [st, a] of Object.entries(res))
      console.log(`stride ${st}: ${a.filter(x => x > 0.6).length}/${a.length} silhouettes match the 3.123 icon (IoU > 0.6), mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)}`);
    return;
  }
  const DIR = path.join(OUT, 'icons-kaybo'), icons = {}, missing = {};
  for (const j of jobs) {
    const r = weaponIconShape(T, j.index);
    const img = r.s && image(r.s);
    if (r.s && !img) r.reason = `image ${r.s.path} not in the 2017 .i3RefTex`;
    if (r.reason) { missing[j.id] = { status: 'missing', family: 'weapons', kind: j.kind, name: j.name, index: j.index, reason: r.reason }; continue; }
    const { u, v, uw, vh } = r.s, c = cropImage(img, u, v, uw, vh);
    if (c.opaque < uw * vh * 0.02) { missing[j.id] = { status: 'missing', family: 'weapons', kind: j.kind, name: j.name, index: j.index, reason: `cell ${r.s.img}:${u},${v},${uw},${vh} (${r.set} #${r.shape}) is transparent` }; continue; }
    const file = `icons-kaybo/weapons/${j.id}.png`;
    if (!dry) { fs.mkdirSync(path.join(DIR, 'weapons'), { recursive: true }); fs.writeFileSync(path.join(OUT, file), encodePNG(c.rgba, uw, vh)); }
    icons[j.id] = { sheet: file, x: 0, y: 0, w: uw, h: vh, status: 'original', src: `${r.s.img}:${u},${v},${uw},${vh}`, atlas: img.src,
      template: r.set, shape: r.shape, index: j.index, family: 'weapons', kind: j.kind, name: j.name };
  }
  const index = { format: 'pb-ui-icons/1', version: 'kaybo', generated: new Date().toISOString(), tool: 'tools/ui-export/vtex-kaybo.mjs --icons',
    notes: 'Same record as icons/index.json (W3). Weapons only (2017 Character/Equipment/Goods .pef have no UITemplate lists or ITEMIDs). ' +
      'Cell rule and itemId formula: header of the weapon-icon section of tools/ui-export/vtex-kaybo.mjs.',
    summary: { icons: Object.keys(icons).length, missing: Object.keys(missing).length }, icons, missing };
  if (!dry) writeJSON(path.join(DIR, 'index.json'), index, true);
  console.log(JSON.stringify(index.summary));
  const reasons = {};
  for (const m of Object.values(missing)) { const k = m.reason.replace(/\d+/g, 'N'); reasons[k] = (reasons[k] || 0) + 1; }
  console.log(reasons);
}

// ---- CLI ----------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--icons') { await exportIcons({ dry: args.includes('--dry'), check: args.includes('--check') }); process.exit(0); }
  const { encodePNG } = await import('./lib.mjs');
  let out = null; const oi = args.indexOf('--png'); if (oi >= 0) { out = args[oi + 1]; args.splice(oi, 2); }
  const list = args[0] === '--list'; if (list) args.shift();
  const root = ROOTS[args[0]] ? args.shift() : 'UIRe';
  const vt = openVTex(root);
  console.log(`${root}: ${vt.format} ${vt.W}x${vt.H}, ${vt.images.length} images, ${vt.subs.length - 1} sub-files`);
  const want = args.map(stem);
  for (const im of vt.images) {
    if (want.length && !want.includes(im.key)) continue;
    if (list || !out) { console.log(`${im.index}\t${im.path}\t${im.w}x${im.h}@${im.x},${im.y}`); continue; }
    const r = vt.readImage(im);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${im.key}${vt.images.filter(o => o.key === im.key).length > 1 ? '_' + im.index : ''}.png`), encodePNG(r.rgba, r.w, r.h));
    console.log(`${im.path} ${im.w}x${im.h} empty tiles ${r.emptyTiles}/${r.tiles}`);
  }
}
