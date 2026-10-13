#!/usr/bin/env node
// Config extractor for the OLD (2017) PB client: Clients/PBKaybo/GameData/Apps/PB/Pack/Script.i3Pack
// -> extracted/pef2017/{raw,br}/<File>.json   (+ the plain files: .ini/.nlf/.i3Game)
//
//   node pef/extract-config.mjs [Script.i3Pack] [--nation N]
//
// Script.i3Pack layout (solved statically, 2026-09-27):
//   I3R2 container, 2 i3PackNodes ("", "config"). The "config" node record holds the PFN3 file table:
//   18 entries x 92 bytes at 0x162, bit-rotated right by 2 (circular). Entry (after decode):
//     +0x00 char name[64]   +0x43 u8 flags (bit 3 = payload encrypted)
//     +0x46 u16 sizeLo  +0x48 u16 offHi  +0x4A u16 sizeHi  +0x50 u16 offLo   (absolute pack offsets)
//   Encrypted payloads: each 0x800-byte block is bit-rotated right by 3 independently (circular per block).
//   Plain payloads (flags bit 3 clear): Nation.nlf, BCNewUI.i3Game.
//
// .pef = I3R2 file of i3Reg* objects (i3RegKey tree, i3RegINT32/REAL32/String/VEC*/i3RegArray).
//   i3RegArray: name, u32 9, u32 elemType (0 int,1 real,2 string,3 vec2,4 vec3,5 vec4,6 color,7 mat),
//   u32 count (19 = one value per nation), values. Strings are "RGS3"+u32 len+UTF-16LE.
//   i3RegKey: name, "TRN3" (+0xC u32 childCount, child ids from +0x4C), "RGK1" u32 valueCount, pad8, u64 ids.
// Nation slot: i3Registry::Get_LocationIndex() (i3SceneDx GET_REG_ARRAY_DATA indexes the array with it),
//   set by LocaleValue::Init -> _ParseNationFile(config/Nation.nlf): line index of the client locale.
//   Nation.nlf: 0 _Default_, 1 Brazil, 2 China, 3 Indonesia, 4 Korea, 5 Latin_America, 6 NorthAmerica,
//   7 Russia, 8 Thai, 9 Turkey, 10 Italy, 11 English, 12 MiddleEast, 13 Philippines, 14 Taiwan.
//   The BR client reads slot 1 (default --nation 1). raw/ keeps all 19 slots.
// A value and a sub-key with the same name (e.g. Gun/K-2: Damage=int and Damage{HelmetPenetrate..})
// are emitted as "Damage" and "Damage{}".
import { clientPath, extractedPath, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const ni = args.indexOf('--nation');
const NATION = ni >= 0 ? +args.splice(ni, 2)[1] : 1;
// 2017 Script.i3Pack, read only by main (pef/export-cross.mjs imports this module and must not need the 2017 client)
const packFile = () => args[0] || clientPath(baseClient(['kaybo']), 'Pack', 'Script.i3Pack');
const OUT = extractedPath('pef2017');

function ror(e, k) {
  const n = e.length, o = Buffer.alloc(n);
  for (let i = 0; i < n; i++) o[i] = ((e[(i - 1 + n) % n] << (8 - k)) | (e[i] >> k)) & 255;
  return o;
}

export function readScriptPack(b, tableOff = 0x162, count = 18) {
  // decode from 0x10 earlier so the first entry's leading byte gets its real predecessor bits
  const ent = ror(b.subarray(tableOff - 0x10, tableOff + count * 0x5c), 2).subarray(0x10);
  const files = [];
  for (let i = 0; i < count; i++) {
    const e = ent.subarray(i * 0x5c, i * 0x5c + 0x5c);
    let name = e.toString('latin1', 0, 64).split('\0')[0];
    if (i === 0 && /^.?bility.pef$/.test(name)) name = 'Ability.pef'; // first byte straddles the rotation seam
    const size = ((e.readUInt16LE(0x4a) << 16) | e.readUInt16LE(0x46)) >>> 0;
    const off = ((e.readUInt16LE(0x48) << 16) | e.readUInt16LE(0x50)) >>> 0;
    const enc = (e[0x43] & 8) !== 0;
    const src = b.subarray(off, off + size);
    let data = Buffer.from(src);
    if (enc) for (let c = 0; c < size; c += 0x800) ror(src.subarray(c, Math.min(size, c + 0x800)), 3).copy(data, c);
    files.push({ name, off, size, enc, data });
  }
  return files;
}

export function parsePef(b) {
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  const n = b.readUInt32LE(0x20), oo = u64(0x24);
  const strs = b.toString('latin1', u64(0x10), u64(0x10) + u64(0x18)).split('\r\n');
  // class index is not a plain string index past the first classes; resolve to the nearest i3Reg* name
  const i3idx = strs.map((s, i) => (/^i3Reg/.test(s) ? i : -1)).filter((i) => i >= 0);
  const cls = (ci) => { let best = null; for (const i of i3idx) if (i <= ci) best = strs[i]; return best; };
  const objs = new Map();
  for (let i = 0; i < n; i++) {
    const e = oo + i * 28;
    objs.set(b.readUInt32LE(e + 4), { cls: cls(b.readUInt32LE(e)), off: u64(e + 12), size: u64(e + 20) });
  }
  const f7 = (x) => +x.toPrecision(7);
  const rs3 = (p) => {
    if (b.toString('latin1', p, p + 4) !== 'RGS3') throw Error('RGS3@' + p);
    const L = b.readUInt32LE(p + 4);
    return [b.toString('utf16le', p + 8, p + 8 + L * 2), p + 8 + L * 2];
  };
  const fl = (p, k) => [...Array(k)].map((_, i) => f7(b.readFloatLE(p + i * 4)));
  const scal = (t, p) => {
    switch (t) {
      case 0: return [b.readInt32LE(p), p + 4];
      case 1: return [f7(b.readFloatLE(p)), p + 4];
      case 2: return rs3(p);
      case 3: return [fl(p, 2), p + 8];
      case 4: return [fl(p, 3), p + 12];
      case 5: return [fl(p, 4), p + 16];
      case 6: return [[...b.subarray(p, p + 4)], p + 4];
      case 7: return [fl(p, 16), p + 64];
      default: throw Error('type ' + t + '@' + p);
    }
  };
  const T = { i3RegINT32: 0, i3RegREAL32: 1, i3RegString: 2, i3RegVEC2D: 3, i3RegVEC3D: 4, i3RegVEC4D: 5, i3RegCOLOR: 6, i3RegMATRIX: 7 };
  const val = (o) => {
    const L = b[o.off], nm = b.toString('latin1', o.off + 1, o.off + 1 + L), p = o.off + 1 + L;
    if (o.cls === 'i3RegArray') {
      const t = b.readUInt32LE(p + 4), c = b.readUInt32LE(p + 8);
      let q = p + 12; const a = [];
      for (let i = 0; i < c; i++) { const [v, nq] = scal(t, q); a.push(v); q = nq; }
      return [nm, { t, a }];
    }
    return [nm, scal(T[o.cls], p + 4)[0]];
  };
  const keyInfo = (o) => {
    const d = b.subarray(o.off, o.off + o.size), t = d.indexOf('TRN3');
    const cc = d.readUInt32LE(t + 12), kids = [];
    for (let i = 0; i < cc; i++) kids.push(d.readUInt32LE(t + 0x4c + i * 4));
    const r = d.indexOf('RGK1', t + 0x4c + cc * 4), vc = d.readUInt32LE(r + 4), vals = [];
    for (let i = 0; i < vc; i++) vals.push(d.readUInt32LE(r + 16 + i * 8));
    return { name: d.toString('latin1', 1, t), kids, vals };
  };
  const key = (o) => {
    const { name, kids, vals } = keyInfo(o), node = {};
    for (const id of vals) { const [k, x] = val(objs.get(id)); node[k] = x; }
    for (const id of kids) {
      const k = objs.get(id);
      if (k && k.cls === 'i3RegKey') { const [nm, sub] = key(k); node[nm in node ? nm + '{}' : nm] = sub; }
    }
    return [name, node];
  };
  const child = new Set();
  for (const o of objs.values()) if (o.cls === 'i3RegKey') for (const id of keyInfo(o).kids) child.add(id);
  const out = {};
  for (const [id, o] of objs) if (o.cls === 'i3RegKey' && !child.has(id)) { const [k, v] = key(o); out[k] = v; }
  return out;
}

export function resolveNation(o, idx) {
  if (o && o.a) return o.a[idx] === undefined ? o.a[0] : o.a[idx];
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const n = {};
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('__')) n[k] = resolveNation(v, idx);
    return n;
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = readScriptPack(fs.readFileSync(packFile()));
  for (const d of ['raw', 'br', 'files']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
  for (const f of files) {
    if (!f.name.endsWith('.pef')) { fs.writeFileSync(path.join(OUT, 'files', f.name), f.data); console.log('file', f.name, f.size); continue; }
    const base = f.name.replace(/\.pef$/, '');
    const tree = parsePef(f.data);
    fs.writeFileSync(path.join(OUT, 'raw', base + '.json'), JSON.stringify(tree));
    const root = tree.RegistryRoot ?? tree;
    fs.writeFileSync(path.join(OUT, 'br', base + '.json'), JSON.stringify(resolveNation(root, NATION), null, 1));
    console.log('pef ', f.name, f.size);
  }
  console.log('out:', OUT, 'nation slot', NATION);
}
