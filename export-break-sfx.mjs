#!/usr/bin/env node
// Sounds of the map objects (i3ActionPlaySound of the .i3Obj: break + ambient loops, Sound_Object_* / Sound_Ambient_* packs).
//
//   node export-props.mjs --sounds   # refresh breakSounds / stateSounds of objects/index.json (no model re-export)
//   node export-break-sfx.mjs        # -> out/weapons/sfx/objects/<lower-case name>.wav (+ .ogg)
//
// Reads breakSounds / stateSounds of every def in out/objects/index.json (tools/export-props.mjs) and copies the wav
// (lower-case file name) from the pack its i3Sound path names (Sound/Object/Explosion -> Sound_Object_Explosion.i3Pack,
// Sound/Ambient/Redrock -> Sound_Ambient_Redrock.i3Pack). Writes the wav length (s) as `dur` of every stateSounds entry (the
// replay period of a looping clip, mapProps.ts). Glass objects carry no i3Sound of their own: they get OB_Glass_Big_Explosion
// [INFERIDO], the sound the other glass objects (Outpost, Stormtube...) name.
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { convertWavs } from './wav-to-ogg.mjs';
import { carve, parsePack, decodeContent } from './i3pack/unpack.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack');
const OUT = assetPath('weapons', 'sfx', 'objects');
const IDX = assetPath('objects', 'index.json');
const index = JSON.parse(fs.readFileSync(IDX, 'utf8'));

const EXPLOSION = 'Sound_Object_Explosion.i3Pack';
const packOf = (p) => { const m = /sound[\\/](ambient|object)[\\/]([^\\/]+)/i.exec(p); return m ? `Sound_${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}_${m[2]}.i3Pack` : EXPLOSION; };
const base = (p) => path.basename(p.replaceAll('\\', '/')).toLowerCase();

// explosive objects without an i3Sound: OB_Drum_Explosion / OB_Car_Big_Explosion [INFERIDO by name]
const want = new Map(['ob_glass_big_explosion.wav', 'ob_drum_explosion.wav', 'ob_car_big_explosion.wav'].map((n) => [n, EXPLOSION]));
for (const d of Object.values(index.objects)) {
  if (d.breakable || d.animated) for (const s of d.breakSounds || []) want.set(base(s), packOf(s));
  for (const st of d.stateSounds || []) for (const s of st.sounds) want.set(s.clip, packOf(s.path));
}

fs.mkdirSync(OUT, { recursive: true });
const missing = [];
// Cross object / ambient packs: names come from OLD nodes (unpack.mjs writes 000.wav...), so every named wav of a pack is
// read here: indexed nodes by offset, OLD nodes by carving the RIFFs and zipping them with the node's file names in order
function packWavs(file) {
  const d = fs.readFileSync(file), out = new Map();
  for (const node of parsePack(d).nodes) {
    if (!node.files.length) continue;
    if (node.indexOk) {
      for (const e of node.files) { const b = d.subarray(e.offset, e.offset + e.size); out.set(e.name.toLowerCase(), e.attr ? decodeContent(b, e.attr) ?? b : b); }
      continue;
    }
    const carved = carve(d, { ...node, fileCount: node.files.length }).files;
    if (carved.length === node.files.length) node.files.forEach((f, i) => out.set(f.name.toLowerCase(), d.subarray(carved[i].offset, carved[i].offset + carved[i].size)));
  }
  return out;
}
for (const pack of new Set(want.values())) {
  const wavs = packWavs(path.join(PACKS, pack));
  for (const [n, pk] of want) if (pk === pack) { const w = wavs.get(n); if (w) fs.writeFileSync(path.join(OUT, n), w); else missing.push(n); }
}
console.log(`object sfx: ${want.size - missing.length}/${want.size} -> ${OUT}${missing.length ? ' missing: ' + missing.join(', ') : ''}`);

// wav length: data chunk bytes / byte rate
function wavSeconds(file) {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(28);
  for (let p = 12; p + 8 <= b.length;) { const id = b.toString('latin1', p, p + 4), n = b.readUInt32LE(p + 4); if (id === 'data') return n / rate; p += 8 + n + (n & 1); }
  return null;
}
for (const d of Object.values(index.objects)) for (const st of d.stateSounds || []) for (const s of st.sounds) {
  const f = path.join(OUT, s.clip);
  if (fs.existsSync(f)) s.dur = +wavSeconds(f).toFixed(3);
}
fs.writeFileSync(IDX, JSON.stringify(index, null, 1));

convertWavs(OUT);
