#!/usr/bin/env node
// Per-map reflection cubemap -> out/maps/<map>/env_ref.dds (+ "envRef" key in that map's lighting.json). Pure Node ESM.
//
//   node export-env-ref.mjs [mapDir ...]      (default: every maps/<dir> with a lighting.json)
//
// CStageBattle::_LoadReflectMap loads World/<Map>/<Map>_Ref.dds (g_texReflect of the Phong_*RM_* shaders, docs/GRAPHICS_QUALITY.md §3).
// It is a plain DDS cubemap (DXT1, caps2 0xFE00, 6 faces, +X -X +Y -Y +Z -Z) stored raw inside <Map>.i3Pack, whose file index is
// not decodable for these maps, so the DDS header is found by scanning for "DDS ". The bytes go out untouched; lighting.json is only patched.
import { assetPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMap, listMapIds } from './export-lighting.mjs';

const MAPS = assetPath('maps');
const BLOCK = { DXT1: 8, DXT3: 16, DXT5: 16 };

/** First cubemap DDS in the pack bytes -> its exact byte range (header + 6 faces x mips), or null. */
export function findCubeDds(d) {
  for (let q = d.indexOf('DDS '); q >= 0; q = d.indexOf('DDS ', q + 4)) {
    if (q + 128 > d.length || d.readUInt32LE(q + 4) !== 124 || (d.readUInt32LE(q + 112) & 0xfe00) !== 0xfe00) continue;
    const h = d.readUInt32LE(q + 12), w = d.readUInt32LE(q + 16), mips = Math.max(1, d.readUInt32LE(q + 28));
    const cc = d.toString('latin1', q + 84, q + 88), blk = BLOCK[cc];
    if (!blk) continue;
    let face = 0;
    for (let m = 0; m < mips; m++) face += Math.max(1, (Math.max(1, w >> m) + 3) >> 2) * Math.max(1, (Math.max(1, h >> m) + 3) >> 2) * blk;
    const end = q + 128 + face * 6;
    if (end > d.length) continue;
    return { buf: d.subarray(q, end), w, h, mips, cc };
  }
  return null;
}

let bytes = 0;
for (const id of process.argv.length > 2 ? process.argv.slice(2) : listMapIds()) {
  const lj = path.join(MAPS, id, 'lighting.json');
  if (!fs.existsSync(lj)) { console.log(`${id}: no lighting.json, skipped`); continue; }
  try {
    const m = resolveMap(id, {});
    const hit = findCubeDds(fs.readFileSync(path.join(m.dir, `${m.pack}.i3Pack`)));
    const J = JSON.parse(fs.readFileSync(lj, 'utf8'));
    if (!hit) { delete J.envRef; fs.rmSync(path.join(MAPS, id, 'env_ref.dds'), { force: true }); fs.writeFileSync(lj, JSON.stringify(J)); console.log(`${id}: no cubemap in ${m.pack}.i3Pack`); continue; }
    fs.writeFileSync(path.join(MAPS, id, 'env_ref.dds'), hit.buf);
    J.envRef = 'env_ref.dds';
    fs.writeFileSync(lj, JSON.stringify(J));
    bytes += hit.buf.length;
    console.log(`${id}: ${hit.w}x${hit.h} ${hit.cc} mips ${hit.mips} ${hit.buf.length} B`);
  } catch (e) { process.exitCode = 1; console.error(`${id}: ERROR ${e.message}`); }
}
console.log(`total ${(bytes / 1024).toFixed(0)} KB`);
