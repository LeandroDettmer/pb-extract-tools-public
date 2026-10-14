#!/usr/bin/env node
// Point Blank Cross brand art -> ui/cross/brand/ (web-poc index.html favicon, main.ts battle overlay logo).
//   pbx ui cross-brand
// icon.png / icon.ico: the window icon of Clients/PBCross/PointBlank.exe (PE .rsrc RT_GROUP_ICON 14 + RT_ICON 3).
//   icon.ico keeps every size of the group; icon.png is the largest one (PNG data as is, DIB 32 bpp decoded).
// logo.png: the POINT BLANK wordmark cut from the Cross login art (Pack/UI_Loading.i3Pack Login.i3i, 1024 x 1024, the
//   LOGIN window of the Cross client). Crop box is the wordmark only, measured on the decoded texture.
// login-bg.png: the login art without the green fill, top 1024 x 768 (the design size of the Cross stage). The LOGIN box
//   (ID / PASSWORD fields) is baked into it; the web login form sits over those fields.
import fs from 'node:fs';
import path from 'node:path';
import { clientPath, assetPath } from '../lib/paths.mjs';
import { parsePack, carve, decodeContent } from '../i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from '../i3r2/skin-glb.mjs';

const EXE = clientPath('cross', 'PointBlank.exe');
const PACK = clientPath('cross', 'Pack', 'UI_Loading.i3Pack');
const OUT = assetPath('ui', 'cross', 'brand');
const LOGIN_TEX = /^Login\.i3i$/i;
// [x0, y0, x1, y1] of the wordmark in the 1024 x 1024 login texture (login art: wordmark at the bottom of the picture)
const LOGO_BOX = [262, 620, 836, 704];
const LOGIN_BG_BOX = [0, 0, 1024, 768];

/** PE resource leaves: [{ type, name, data }] (type / name = numeric resource ids) */
function peResources(d) {
  const pe = d.readUInt32LE(0x3c);
  if (d.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${EXE}: not a PE file`);
  const nSec = d.readUInt16LE(pe + 6), optSize = d.readUInt16LE(pe + 20), opt = pe + 24;
  const dirs = opt + (d.readUInt16LE(opt) === 0x20b ? 112 : 96); // PE32+ / PE32 data directories
  const secs = [];
  for (let i = 0; i < nSec; i++) {
    const s = opt + optSize + i * 40;
    secs.push({ va: d.readUInt32LE(s + 12), vsize: d.readUInt32LE(s + 8), raw: d.readUInt32LE(s + 20), rsize: d.readUInt32LE(s + 16) });
  }
  const off = (rva) => {
    const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rsize));
    if (!s) throw new Error(`${EXE}: rva 0x${rva.toString(16)} outside the sections`);
    return rva - s.va + s.raw;
  };
  const base = off(d.readUInt32LE(dirs + 2 * 8)); // resource directory (data directory 2)
  const out = [];
  const walk = (dir, ids) => {
    const n = d.readUInt16LE(dir + 12) + d.readUInt16LE(dir + 14);
    for (let i = 0; i < n; i++) {
      const e = dir + 16 + i * 8, id = d.readUInt32LE(e), to = d.readUInt32LE(e + 4) & 0x7fffffff;
      if (id & 0x80000000) continue; // named entry
      if (d.readUInt32LE(e + 4) & 0x80000000) walk(base + to, [...ids, id]);
      else {
        const leaf = base + to, rva = d.readUInt32LE(leaf), size = d.readUInt32LE(leaf + 4);
        out.push({ type: ids[0], name: ids[1], data: d.subarray(off(rva), off(rva) + size) });
      }
    }
  };
  walk(base, []);
  return out;
}

/** 32 bpp DIB inside an icon (XOR bitmap, bottom-up BGRA) -> top-down RGBA */
function dibToRgba(b) {
  const size = b.readUInt32LE(0), w = b.readInt32LE(4), h2 = b.readInt32LE(8), bpp = b.readUInt16LE(14);
  const h = h2 / 2;
  if (bpp !== 32) throw new Error(`icon DIB ${bpp} bpp not handled`);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = size + (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4, o = (y * w + x) * 4;
      out[o] = b[s + 2]; out[o + 1] = b[s + 1]; out[o + 2] = b[s]; out[o + 3] = b[s + 3];
    }
  }
  return { rgba: out, w, h };
}

/** Login.i3i texture of UI_Loading.i3Pack, decoded to RGBA */
function loginTexture() {
  const d = fs.readFileSync(PACK);
  for (const n of parsePack(d).nodes) {
    if (!n.fileCount) continue;
    const files = n.indexOk ? n.files : carve(d, n).files.map((f, k) => ({ ...f, name: n.files[k]?.name ?? '' }));
    for (const f of files) {
      if (!LOGIN_TEX.test(f.name)) continue;
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      const t = readI3IB(buf, buf.indexOf('I3IB'));
      if (!t || t.kind === 'unsupported') throw new Error(`unsupported I3IB (${f.name})`);
      return { rgba: Buffer.from(decodeI3IB(buf, t)), w: t.w, h: t.h };
    }
  }
  throw new Error(`${PACK}: Login.i3i missing`);
}

function crop({ rgba, w }, [x0, y0, x1, y1]) {
  const cw = x1 - x0, out = Buffer.alloc(cw * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) rgba.copy(out, (y - y0) * cw * 4, (y * w + x0) * 4, (y * w + x1) * 4);
  return { rgba: out, w: cw, h: y1 - y0 };
}

fs.mkdirSync(OUT, { recursive: true });
const d = fs.readFileSync(EXE);
const res = peResources(d);
const groups = res.filter((r) => r.type === 14);
if (!groups.length) throw new Error(`${EXE}: no RT_GROUP_ICON`);
const grp = groups[0].data;
const count = grp.readUInt16LE(4);
const icons = new Map(res.filter((r) => r.type === 3).map((r) => [r.name, r.data]));
const entries = [];
for (let i = 0; i < count; i++) {
  const o = 6 + i * 14, id = grp.readUInt16LE(o + 12), img = icons.get(id);
  if (!img) throw new Error(`${EXE}: RT_ICON ${id} missing`);
  entries.push({ head: grp.subarray(o, o + 8), img, w: grp[o] || 256 }); // GRPICONDIRENTRY and ICONDIRENTRY share the first 8 bytes
}

// icon.ico: same images as the group, offsets rebuilt
const hdr = Buffer.alloc(6 + entries.length * 16);
hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(entries.length, 4);
let at = hdr.length;
entries.forEach((e, i) => {
  const o = 6 + i * 16;
  e.head.copy(hdr, o); // w h colors reserved planes bpp
  hdr.writeUInt32LE(e.img.length, o + 8); hdr.writeUInt32LE(at, o + 12);
  at += e.img.length;
});
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([hdr, ...entries.map((e) => e.img)]));

// icon.png: largest size
const big = entries.reduce((a, b) => (b.w > a.w ? b : a));
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const iconPng = big.img.subarray(0, 4).equals(PNG_SIG)
  ? big.img
  : (() => { const t = dibToRgba(big.img); return encodePNG(t.rgba, t.w, t.h, true); })();
fs.writeFileSync(path.join(OUT, 'icon.png'), iconPng);

const login = loginTexture();
const logo = crop(login, LOGO_BOX);
fs.writeFileSync(path.join(OUT, 'logo.png'), encodePNG(logo.rgba, logo.w, logo.h, true));
const bg = crop(login, LOGIN_BG_BOX);
fs.writeFileSync(path.join(OUT, 'login-bg.png'), encodePNG(bg.rgba, bg.w, bg.h, true));
console.log(`cross brand: icon.ico (${entries.map((e) => e.w).join(', ')} px), icon.png ${big.w}, logo.png ${logo.w}x${logo.h}, login-bg.png ${bg.w}x${bg.h} ->`, OUT);
