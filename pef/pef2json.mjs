#!/usr/bin/env node
// Point Blank .pef (i3RegistrySet) -> JSON. Pure Node ESM, builtins only.
//
//   node pef/pef2json.mjs <file.pef> [out.json] [--key Path/To/Key] [--meta] [--nation N] [--compact]
//
// Input is the DECRYPTED pef as written by tools/i3pack/unpack.mjs (Script.i3Pack/config/*.Pef).
// A .pef is an I3R2 resource file (see unpack.mjs readI3R2Header); every object is one of:
//
//   i3RegKey   : u8 nameLen, name,
//                'TRN3' u32 0, u32 0, u32 childCount, zeros (block = 0x4C bytes),
//                childCount x u32 child-key object id,
//                'RGK1' u32 dataCount, 8 bytes 0, dataCount x u64 data object id
//   i3RegData  : u8 nameLen, name, u32 dataType, value by type:
//                0 INT32 i32 | 1 REAL32 f32 | 2 String 'RGS3' u32 nChars, UTF-16LE[nChars]
//                3 VEC2D 2xf32 | 4 VEC3D 3xf32 | 5 VEC4D 4xf32 | 6 COLOR 4xu8 | 7 MATRIX 16xf32
//                9 Array: u32 elementType, u32 count, count x element (same encodings, no name/type)
//   (layout from i3SceneDx.dll i3Reg*::OnLoad of the Kaybo 2017 build + size checks on 3.123 data)
//
// Output: nested objects keyed by the ORIGINAL key/data names. A data value that shares its name
// with a child key is stored as "<name>@data". --meta wraps every data as {type, value}.
// Per-nation values: i3Registry stores localized data as i3RegArray of NATION_COUNT elements, one per
// line of config/Nation.nlf (0 _Default_, 1 Brazil, 2 SEAsia, 3 Indonesia, 4 Latin_America, 5 Russia,
// 6 Thai, 7 Turkey, 8 English, 9 Dev). --nation N replaces every such array by its element N.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readI3R2Header } from '../i3pack/unpack.mjs';

export const NATIONS = ['_Default_', 'Brazil', 'SEAsia', 'Indonesia', 'Latin_America', 'Russia', 'Thai', 'Turkey', 'English', 'Dev'];
const TYPE_NAMES = ['INT32', 'REAL32', 'String', 'VEC2D', 'VEC3D', 'VEC4D', 'COLOR', 'MATRIX', 'INT32Ex', 'Array'];
// float32 -> shortest decimal that round-trips to the same float32
const f32 = v => { if (!Number.isFinite(v)) return v; for (let p = 1; p <= 9; p++) { const s = +v.toPrecision(p); if (Math.fround(s) === v) return s; } return v; };

function readValue(d, p, type) {
  switch (type) {
    case 0: case 8: return [d.readInt32LE(p), p + 4];
    case 1: return [f32(d.readFloatLE(p)), p + 4];
    case 2: {
      if (d.toString('latin1', p, p + 4) !== 'RGS3') throw new Error(`bad RGS3 @${p}`);
      const n = d.readUInt32LE(p + 4);
      return [d.toString('utf16le', p + 8, p + 8 + n * 2).replace(/\0+$/, ''), p + 8 + n * 2];
    }
    case 3: case 4: case 5: case 7: {
      const n = { 3: 2, 4: 3, 5: 4, 7: 16 }[type], v = [];
      for (let i = 0; i < n; i++) v.push(f32(d.readFloatLE(p + i * 4)));
      return [v, p + n * 4];
    }
    case 6: return [[d[p], d[p + 1], d[p + 2], d[p + 3]], p + 4];
    default: throw new Error(`unknown reg data type ${type} @${p}`);
  }
}

export function parsePef(d) {
  const h = readI3R2Header(d, 0);
  if (!h) throw new Error('not an I3R2 file (decrypt it with unpack.mjs first)');
  const byId = new Map();
  for (const o of h.objects) {
    const cls = h.strings[o.cls];
    const nl = d[o.off], name = d.toString('latin1', o.off + 1, o.off + 1 + nl);
    let p = o.off + 1 + nl;
    const end = o.off + o.size;
    if (cls === 'i3RegKey') {
      if (d.toString('latin1', p, p + 4) !== 'TRN3') throw new Error(`key ${o.id}: no TRN3`);
      const nc = d.readUInt32LE(p + 12);
      p += 0x4c;
      const children = [];
      for (let i = 0; i < nc; i++, p += 4) children.push(d.readUInt32LE(p));
      if (d.toString('latin1', p, p + 4) !== 'RGK1') throw new Error(`key ${o.id}: no RGK1`);
      const nd = d.readUInt32LE(p + 4);
      p += 16;
      const data = [];
      for (let i = 0; i < nd; i++, p += 8) data.push(d.readUInt32LE(p));
      if (p !== end) throw new Error(`key ${o.id} (${name}): ${end - p} bytes left`);
      byId.set(o.id, { kind: 'key', name, children, data });
    } else if (cls?.startsWith('i3Reg')) {
      const type = d.readUInt32LE(p); p += 4;
      let value, elementType;
      if (type === 9) {
        elementType = d.readUInt32LE(p);
        const n = d.readUInt32LE(p + 4); p += 8;
        value = [];
        for (let i = 0; i < n; i++) { let v; [v, p] = readValue(d, p, elementType); value.push(v); }
      } else [value, p] = readValue(d, p, type);
      if (p !== end) throw new Error(`data ${o.id} (${name}, ${cls}): ${end - p} bytes left`);
      byId.set(o.id, { kind: 'data', name, cls, type, elementType, value });
    } else {
      byId.set(o.id, { kind: 'other', name, cls });
    }
  }
  const isChild = new Set();
  for (const e of byId.values()) if (e.kind === 'key') for (const c of e.children) isChild.add(c);
  const roots = [...byId].filter(([id, e]) => e.kind === 'key' && !isChild.has(id)).map(([id]) => id);
  return { byId, roots };
}

export function toJSON({ byId }, id, meta = false, nation = null) {
  const k = byId.get(id), out = {};
  for (const c of k.children) { const ck = byId.get(c); if (ck?.kind === 'key') out[ck.name] = toJSON({ byId }, c, meta, nation); }
  for (const di of k.data) {
    const e = byId.get(di);
    if (!e || e.kind !== 'data') continue;
    const nm = e.name in out ? `${e.name}@data` : e.name;
    const perNation = nation !== null && e.type === 9 && e.value.length === NATIONS.length;
    const value = perNation ? e.value[nation] : e.value;
    const type = e.type === 9 && !perNation ? `Array<${TYPE_NAMES[e.elementType]}>` : TYPE_NAMES[e.type === 9 ? e.elementType : e.type];
    out[nm] = meta ? { type, value } : value;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = f => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const keyPath = flag('--key');
  const nf = flag('--nation');
  const nation = nf === null ? null : (/^\d+$/.test(nf) ? +nf : NATIONS.findIndex(n => n.toLowerCase() === nf.toLowerCase()));
  if (nation !== null && !(nation >= 0 && nation < NATIONS.length)) throw new Error(`bad --nation ${nf}`);
  const ci = args.indexOf('--compact'); const compact = ci >= 0; if (compact) args.splice(ci, 1);
  const mi = args.indexOf('--meta'); const meta = mi >= 0; if (meta) args.splice(mi, 1);
  const [inFile, outFile] = args;
  const pef = parsePef(fs.readFileSync(inFile));
  let json = {};
  for (const r of pef.roots) json[pef.byId.get(r).name] = toJSON(pef, r, meta, nation);
  if (Object.keys(json).length === 1) json = Object.values(json)[0]; // single (nameless) root
  if (keyPath) for (const part of keyPath.split('/').filter(Boolean)) json = json?.[part];
  const txt = JSON.stringify(json, null, compact ? 0 : 1);
  if (outFile) { fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, txt); }
  else process.stdout.write(txt + '\n');
  console.error(`${path.basename(inFile)}: ${pef.byId.size} objects, ${pef.roots.length} root key(s) -> ${outFile || 'stdout'} (${(txt.length / 1048576).toFixed(1)} MB)`);
}
