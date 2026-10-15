// Shared readers for the UI export pipeline (W2, docs/LOBBY_PLAN.md §2.3 / §4.3). Pure Node, builtins only.
//
// Formats (all verified on PointBlankRe_Lobby_RoomList, V12 3.123 and Kaybo 2017 use the same layout):
//   .i3UIs  I3R2 resource. Object table entry {cls,id,off,size}; each control record:
//     u8 nameLen, name, "GND1" (+12 u32 parent object id; the i3UIScene is id 1),
//     "UIC1" +4 u32 flags, +8 f32 x, y, z, w, h, +28 MD5(UPPER(templateName)), +44 u32, +48 f32 RGBA
//     then at UIC1+160 an optional "UCC1" caption chunk (data = tag+4):
//       +0 flags, +4 u32 textLen (UTF-16 units), +12 u32 ?, +16 u32 font weight, +20 u32 font size,
//       +24 u32 text ARGB, +28 u32 shadow ARGB, +32 u32 alignX, +36 u32 alignY, text UTF-16LE at +176.
//     i3UIScene: "UIS1" +12 u32 design width, +16 design height, then the Lua script path.
//   .i3UITemplate (V12/V11, one XML per template) and .i3Uil (Kaybo, one XML library): <ObjectN Class=
//     "i3UITemplate_*" ID Name [SubTemplateK=id]> with <ShapeN path nX nY nWidth nHeight u v w h>.
//     (u,v,w,h) = source rectangle inside the image named by `path`; (nX,nY,nWidth,nHeight) = the shape's
//     place inside the template's reference box (3-slice / 9-slice / one shape per state).
//   .i3VTexImage "VTIH": +8 u32 w, +12 u32 h, +0x18 u32 cipher flag; pixels at +2048, BGRA8 in 128x128 tiles
//     (64 KB, row-major tiles, rows inside a tile). flag=1 = IIA2 per tile (W3, tools/ui-export/vtex-crypt.mjs).
//     Files of 128 bytes are locale placeholders (header only).

import { assetPath, baseClient, clientPath, rel } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';

export const OUT = assetPath('ui');
export { rel };

const P123 = clientPath('br3123');
const KAYBO = clientPath('kaybo');
const CROSS = clientPath(baseClient('cross'));

// Where each UI version lives. vtex: lookup order (locale first, then _Common).
export const VERSIONS = {
  v12: {
    label: 'PointBlank 3.123 UI_V12',
    scenePacks: [path.join(P123, 'Pack', 'UI_V12.i3Pack')],
    templatePacks: [path.join(P123, 'Pack', 'UI_V12_VTexList_Template.i3Pack')],
    vtex: [path.join(P123, 'Locale', 'Brazil', 'UI_V12', 'VTexList'), path.join(P123, 'Locale', '_Common', 'UI_V12', 'VTexList')],
  },
  v11: {
    label: 'PointBlank 3.123 UI_V11 (UI_V11.i3Pack has no scenes; templates + atlases only)',
    scenePacks: [path.join(P123, 'Pack', 'UI_V11.i3Pack')],
    templatePacks: [path.join(P123, 'Pack', 'UI_V11_VTexList_Template.i3Pack')],
    vtex: [path.join(P123, 'Locale', 'Brazil', 'UI_V11', 'VTexList'), path.join(P123, 'Locale', '_Common', 'UI_V11', 'VTexList')],
  },
  kaybo: {
    label: 'PBKaybo 2017 UIRe',
    scenePacks: [path.join(KAYBO, 'Pack', 'UI_Re2.i3Pack')],
    sceneDirs: [path.join(KAYBO, 'UI_Temp')],
    templateLibs: [path.join(KAYBO, 'UIRe', 'PointBlankRe.i3Uil'), path.join(KAYBO, 'UI_Temp', 'PBRe.i3Uil')],
    vtex: [],
  },
  // Cross keeps only the UI_Temp scenes loose (vote, ghost mode, report...): same VTV2 virtual texture as Kaybo UI_Temp
  cross: {
    label: 'Point Blank Cross UI_Temp',
    scenePacks: [],
    sceneDirs: [path.join(CROSS, 'UI_Temp')],
    templateLibs: [path.join(CROSS, 'UI_Temp', 'PBRe.i3Uil')],
    vtex: [],
  },
};

// ---- pack / file iteration -------------------------------------------------
// Yields {path, name, buf} for every file of the packs (real names from the PFN index) and loose dirs.
export function* iterFiles(ver, kind, re = /./) {
  const V = VERSIONS[ver];
  const packs = kind === 'scene' ? V.scenePacks : V.templatePacks || [];
  for (const p of packs) {
    if (!fs.existsSync(p)) continue;
    const d = fs.readFileSync(p);
    for (const n of parsePack(d).nodes) for (const f of n.files) {
      if (!re.test(f.name)) continue;
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr);
      if (buf) yield { path: `${path.basename(p)}:${n.path}/${f.name}`, name: f.name, buf };
    }
  }
  if (kind === 'scene') for (const dir of V.sceneDirs || []) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/\.i3UIs$/i.test(f) && re.test(f))
      yield { path: rel(path.join(dir, f)), name: f, buf: fs.readFileSync(path.join(dir, f)) };
  }
}

export const md5Upper = name => crypto.createHash('md5').update(name.toUpperCase(), 'latin1').digest('hex');
const ZERO_HASH = '0'.repeat(32);

// ---- .i3UIs scenes ---------------------------------------------------------
const argb = v => {
  const a = (v >>> 24) & 255, r = (v >>> 16) & 255, g = (v >>> 8) & 255, b = v & 255;
  return [r, g, b, +(a / 255).toFixed(3)];
};
const f1 = v => Math.round(v * 100) / 100;

export function parseScene(buf) {
  if (buf.toString('latin1', 0, 4) !== 'I3R2') throw new Error('not I3R2');
  const so = buf.readUInt32LE(0x10), ss = buf.readUInt32LE(0x18), cnt = buf.readUInt32LE(0x20), to = buf.readUInt32LE(0x24);
  const S = buf.toString('latin1', so, so + ss).split('\r\n');
  const scene = { name: '', design: { w: 1024, h: 768 }, script: null, controls: [] };
  for (let i = 0; i < cnt; i++) {
    const e = to + i * 28;
    const cls = S[buf.readUInt32LE(e)], id = buf.readUInt32LE(e + 4);
    const off = buf.readUInt32LE(e + 12), size = buf.readUInt32LE(e + 20);
    const seg = buf.subarray(off, off + size);
    const nl = seg[0], name = seg.toString('latin1', 1, 1 + nl);
    const g = 1 + nl; // GND1 follows the name
    const parent = seg.toString('latin1', g, g + 4) === 'GND1' ? seg.readUInt32LE(g + 12) : 0;
    if (cls === 'i3UIScene') {
      scene.name = name;
      const u = seg.indexOf('UIS1');
      if (u >= 0) {
        const w = seg.readUInt32LE(u + 16), h = seg.readUInt32LE(u + 20);
        if (w >= 320 && w <= 4096 && h >= 200 && h <= 4096) scene.design = { w, h };
        const sp = seg.toString('latin1', u + 4, seg.length).match(/[\w\\/.]*script[\w\\/.]*/i);
        if (sp) scene.script = sp[0];
      }
      continue;
    }
    const u = seg.indexOf('UIC1', g);
    if (u < 0) { scene.controls.push({ id, parent: parent || null, cls, name, noLayout: true }); continue; }
    const F = k => f1(seg.readFloatLE(u + 8 + 4 * k));
    const hash = seg.subarray(u + 28, u + 44).toString('hex');
    const c = {
      id, parent: parent === 1 ? null : parent || null, cls, name,
      x: F(0), y: F(1), w: F(3), h: F(4),
      flags: '0x' + seg.readUInt32LE(u + 4).toString(16).padStart(8, '0'),
      tplHash: hash === ZERO_HASH ? null : hash,
    };
    const col = [0, 1, 2, 3].map(k => +seg.readFloatLE(u + 48 + 4 * k).toFixed(3));
    if (col.some(v => v !== 1)) c.color = col;
    const t = u + 160;
    if (seg.toString('latin1', t, t + 4) === 'UCC1') {
      const q = t + 4, len = seg.readUInt32LE(q + 4);
      const text = len > 0 && len < 2048 && q + 176 + len * 2 <= seg.length ? seg.toString('utf16le', q + 176, q + 176 + len * 2) : '';
      c.caption = {
        text, size: seg.readUInt32LE(q + 20), weight: seg.readUInt32LE(q + 16),
        color: argb(seg.readUInt32LE(q + 24)), shadow: argb(seg.readUInt32LE(q + 28)),
        alignX: seg.readUInt32LE(q + 32), alignY: seg.readUInt32LE(q + 36),
      };
    }
    scene.controls.push(c);
  }
  return scene;
}

// ---- templates (XML) ---------------------------------------------------------
const attrs = s => {
  const o = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};
const num = v => { const n = +v; return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

// Image key = lowercased file stem ("image/main/Frame_v01.tga" -> "frame_v01"); VTexList dirs are flat.
export const imageKey = p => (p ? path.posix.basename(p.replace(/\\/g, '/')).replace(/\.[^.]*$/, '').toLowerCase() : '');

function parseShapes(body) {
  const shapes = [];
  for (const m of body.matchAll(/<Shape\d+\s([^>]*)>/g)) {
    const a = attrs(m[1]);
    const s = { img: imageKey(a.path), x: num(a.nX), y: num(a.nY), w: num(a.nWidth), h: num(a.nHeight),
      u: Math.round(num(a.u)), v: Math.round(num(a.v)), uw: Math.round(num(a.w)), vh: Math.round(num(a.h)) };
    if (a.path && !s.img) s.img = a.path;
    if (!s.img) s.img = null;
    if (a.path) s.path = a.path;
    shapes.push(s);
  }
  return shapes;
}

// Returns Map<id, {id, cls, name, shapes, sub:[ids]}> for every <ObjectN> of an XML resource file.
export function parseTemplateObjects(xml) {
  const objs = new Map();
  const re = /<Object\d+\s([^>]*?)(\/>|>([\s\S]*?)<\/Object\d+>)/g;
  for (const m of xml.matchAll(re)) {
    const a = attrs(m[1]);
    const id = +a.ID;
    const sub = Object.keys(a).filter(k => /^SubTemplate\d+$/.test(k)).sort((x, y) => parseInt(x.slice(11)) - parseInt(y.slice(11))).map(k => +a[k]);
    objs.set(id, { id, cls: a.Class, name: a.Name || '', template: a.Template ? +a.Template : undefined, shapes: m[3] ? parseShapes(m[3]) : [], sub });
  }
  const hdr = xml.match(/<Header\s([^>]*)>/);
  return { objs, key: hdr ? +attrs(hdr[1]).KeyObject : 0 };
}

// Resolve a template object (and its sub-templates, recursively) into the exported JSON shape.
export function resolveTemplate(objs, id, depth = 0) {
  const o = objs.get(id);
  if (!o || depth > 6) return null;
  const t = { cls: (o.cls || '').replace(/^i3UITemplate_/, ''), shapes: o.shapes };
  if (o.name) t.name = o.name;
  if (o.sub.length) t.sub = o.sub.map(s => resolveTemplate(objs, s, depth + 1));
  return t;
}

// All top-level templates of a version: Map<name, template>. V12/V11: one XML per template (KeyObject);
// Kaybo: library where i3UILTreeNode_Template{Name, Template=id} names the top-level templates.
export function loadTemplates(ver) {
  const V = VERSIONS[ver];
  const out = new Map();
  for (const f of iterFiles(ver, 'template', /\.i3UITempl/i)) {
    const { objs, key } = parseTemplateObjects(f.buf.toString('utf8'));
    const t = resolveTemplate(objs, key);
    if (!t) continue;
    const name = t.name || f.name.replace(/\.i3UITempl?a?t?e?$/i, '');
    t.src = f.path;
    out.set(name, t);
  }
  for (const lib of V.templateLibs || []) {
    if (!fs.existsSync(lib)) continue;
    const { objs } = parseTemplateObjects(fs.readFileSync(lib, 'latin1'));
    for (const o of objs.values()) {
      if (o.cls !== 'i3UILTreeNode_Template' || !o.template || out.has(o.name)) continue;
      const t = resolveTemplate(objs, o.template);
      if (t) { t.name = o.name; t.src = rel(lib); out.set(o.name, t); }
    }
  }
  return out;
}

// ---- .i3VTexImage ------------------------------------------------------------
export const VTEX_HEADER = 2048, VTEX_TILE = 128;
export function readVTexHeader(file) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(64);
  fs.readSync(fd, b, 0, 64, 0);
  fs.closeSync(fd);
  const w = b.readUInt32LE(8), h = b.readUInt32LE(12);
  const need = VTEX_HEADER + w * h * 4;
  return { file, magic: b.toString('latin1', 0, 4), w, h, encrypted: b.readUInt32LE(0x18) !== 0, placeholder: st.size < need, size: st.size };
}
// Plain (flag=0) VTexImage -> RGBA (straight alpha).
export function decodeVTexPlain(buf) {
  const w = buf.readUInt32LE(8), h = buf.readUInt32LE(12), T = VTEX_TILE;
  const per = Math.max(1, w / T), rgba = Buffer.alloc(w * h * 4);
  const tiles = Math.max(1, (w / T) * (h / T));
  for (let t = 0; t < tiles; t++) {
    const tx = (t % per) * T, ty = Math.floor(t / per) * T;
    for (let y = 0; y < T && ty + y < h; y++) for (let x = 0; x < T && tx + x < w; x++) {
      const si = VTEX_HEADER + (t * T * T + y * T + x) * 4, di = ((ty + y) * w + tx + x) * 4;
      rgba[di] = buf[si + 2]; rgba[di + 1] = buf[si + 1]; rgba[di + 2] = buf[si]; rgba[di + 3] = buf[si + 3];
    }
  }
  return { w, h, rgba };
}

// Index of image key -> VTexImage header for a version (first dir wins, placeholders skipped).
export function vtexIndex(ver) {
  const idx = new Map();
  for (const dir of VERSIONS[ver].vtex) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.i3VTexImage$/i.test(f)) continue;
      const k = f.replace(/\.i3VTexImage$/i, '').trim().toLowerCase();
      if (idx.has(k)) continue;
      const h = readVTexHeader(path.join(dir, f));
      if (h.magic !== 'VTIH' || h.placeholder) continue;
      idx.set(k, h);
    }
  }
  return idx;
}

// ---- PNG ---------------------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// Minimal decoder for 8-bit RGBA / RGB non-interlaced PNGs (what encodePNG and common tools write).
export function decodePNG(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('unsupported PNG'); }
    else if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error('unsupported PNG color type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) rgba[(y * w + x) * 4 + k] = k < bpp ? cur[x * bpp + k] : 255;
    cur.copy(prev);
  }
  return { w, h, rgba };
}

// Compact by default (scenes/templates are large); pretty for small hand-read manifests.
export const writeJSON = (file, obj, pretty = false) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj)) + '\n');
};
