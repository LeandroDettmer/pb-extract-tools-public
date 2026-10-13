#!/usr/bin/env node
// Per-sound volume / distance table of the 2017 client (i3GameResSound data of the sound resource lists).
//
//   node export-sound-rsc.mjs     # -> src/game/data/soundRsc2017.json (committed, ~35 KB)
//
// Clients/PBCross/Pack/Sound.i3Pack holds the resource lists Sound/{Weapon,Character,Voice,Object,
// Interface,Dinosaur}.RSC. Layout (i3ResourceManager::LoadRSC, i3FrameworkDx): "RSCF" u32 count, then per entry
// "RSC1" u32 type, u32 nameLen, u32 pathLen, u32 0, name\0, path\0, then the resource's own data. Type 5 = sound: the
// 16 bytes i3GameResSound::LoadFromFile (i3FrameworkDx 0x100fdac0) reads into a new i3SoundPlayInfo:
//   +0 f32 max distance, +4 f32 min distance  -> SetDistanceInfo(max, min, 0)  (info +0x24 / +0x20)
//   +8 i32 default volume (0..100)            -> SetDefaultVolume               (info +0x14, used by 3D sounds)
//   +c i32 listener volume (0..100)           -> setListenerVolume              (info +0x18, used by 2D sounds)
// i3SoundPlayState::_calcCtxVolume (i3SoundDx 0x100155c0) picks +0x18 when the sound plays 2D (3D mode 0x1000000:
// the own 1PV shot, announcer, radio, UI) and +0x14 otherwise. A few entries have max < min (WM_Jackhammer_*: 5 / 50);
// they are kept as they are: the engine uses them that way.
// Output: { files: { "<wav name lower, no ext>": [min, max, vol, lvol] } }. Dinosaur.RSC is left out (no dino mode).
import { clientPath, generatedPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeContent, parsePack } from './i3pack/unpack.mjs';

const PACK = clientPath(baseClient('cross'), 'Pack', 'Sound.i3Pack');
const OUT = generatedPath('game/data/soundRsc2017.json');
const LISTS = ['Weapon.RSC', 'Character.RSC', 'Voice.RSC', 'Object.RSC', 'Interface.RSC'];

function parseRsc(b, list) {
  if (b.toString('latin1', 0, 4) !== 'RSCF') throw new Error(`${list}: not an RSCF file`);
  const n = b.readUInt32LE(4), rows = [];
  let p = 8;
  for (let i = 0; i < n; i++) {
    const mg = b.toString('latin1', p, p + 4);
    if (mg !== 'RSC1' && mg !== 'RSC2') throw new Error(`${list}: bad entry ${i} at 0x${p.toString(16)}`);
    const type = b.readUInt32LE(p + 4), nl = b.readUInt32LE(p + 8), pl = b.readUInt32LE(p + 12);
    let q = p + 20;
    const name = b.toString('latin1', q, q + nl); q += nl + 1;
    q += pl + 1; // path
    if (type !== 5) throw new Error(`${list}: entry ${name} is type ${type}, not a sound`);
    rows.push({ name, min: b.readFloatLE(q + 4), max: b.readFloatLE(q), vol: b.readInt32LE(q + 8), lvol: b.readInt32LE(q + 12) });
    p = q + 16;
  }
  return rows;
}

const d = fs.readFileSync(PACK);
const { nodes } = parsePack(d);
const files = {};
let total = 0;
for (const list of LISTS) {
  const node = nodes.find((n) => n.files.some((f) => f.name === list));
  const f = node?.files.find((x) => x.name === list);
  if (!f) throw new Error(`${list} not found in ${PACK}`);
  let buf = d.subarray(f.offset, f.offset + f.size);
  if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
  const rows = parseRsc(buf, list);
  for (const r of rows) {
    const k = r.name.replace(/\.wav$/i, '').toLowerCase();
    const v = [r.min, r.max, r.vol, r.lvol].map((x) => +x.toFixed(3));
    const had = files[k];
    if (had && had.join() !== v.join()) console.warn(`${k}: ${had} vs ${v} (${list}), keeping the first`);
    else files[k] = v;
  }
  total += rows.length;
  console.log(`${list}: ${rows.length}`);
}
const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
fs.writeFileSync(OUT, JSON.stringify({
  source: 'Clients/PBCross/Pack/Sound.i3Pack Sound/*.RSC (tools/export-sound-rsc.mjs)',
  fields: ['min', 'max', 'vol', 'lvol'],
  files: sorted,
}) + '\n');
console.log(`${total} entries, ${Object.keys(sorted).length} names -> ${path.relative(process.cwd(), OUT)}`);
