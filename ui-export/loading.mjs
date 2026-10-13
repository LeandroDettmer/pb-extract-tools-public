#!/usr/bin/env node
// Battle loading screen art -> out/ui/loading/ (docs/LOADING_SCREEN.md).
//   node tools/ui-export/loading.mjs
// Per map: Pack/<Map>_Images_NoText.i3Pack (3.123 BR) = World/<Map>/Images_NoText/Load_<Map>.i3i (16:9) and Load_<Map>_43.i3i (4:3).
// Maps that ship only team variants (Helispot) or whose pack is the plain <Map>_Images.i3Pack use load_<Map>_Blue/_Red.
// Generic fallback (maps without art): PBKaybo UI_Loading.i3Pack Gui/Loading/Loading.i3i.
import { assetPath, clientPath } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from '../i3r2/skin-glb.mjs';

const BR = clientPath('br3123', 'Pack');
const KAYBO = clientPath('kaybo', 'Pack');
const OUT = assetPath('ui', 'loading');

/** Files of a pack in memory (node paths ignored: some packs store absolute D:\... paths). */
function files(pack) {
  const d = fs.readFileSync(pack);
  const out = [];
  for (const n of parsePack(d).nodes) {
    if (!n.indexOk) continue;
    for (const f of n.files) {
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      out.push({ name: f.name, buf });
    }
  }
  return out;
}

function toPng(buf, dest) {
  const t = readI3IB(buf, buf.indexOf('I3IB'));
  if (!t || t.kind === 'unsupported') throw new Error(`unsupported I3IB (${dest})`);
  fs.writeFileSync(path.join(OUT, dest), encodePNG(decodeI3IB(buf, t), t.w, t.h, false));
  return { w: t.w, h: t.h };
}

const idx = JSON.parse(fs.readFileSync(assetPath('maps', 'index.json'), 'utf8'));
const maps = [...new Map((Array.isArray(idx) ? idx : idx.maps).map((m) => [m.id, m])).values()];
fs.mkdirSync(OUT, { recursive: true });
const index = { format: 'pb-loading/1', generated: new Date().toISOString(), tool: 'tools/ui-export/loading.mjs', generic: null, maps: {} };

for (const m of maps) {
  const found = new Map(); // lower-case file name -> buf
  for (const suf of ['_Images_NoText', '_Images']) {
    const p = path.join(BR, `${m.pack}${suf}.i3Pack`);
    if (!fs.existsSync(p) || fs.statSync(p).size < 1000) continue;
    for (const f of files(p)) if (/^load_.*\.i3i$/i.test(f.name) && !found.has(f.name.toLowerCase())) found.set(f.name.toLowerCase(), f.buf);
  }
  // wide / 4:3 = the plain and _43 art; team (Blue/Red) only when there is no plain one
  const key = (re) => [...found.keys()].find((k) => re.test(k));
  const w169 = [...found.keys()].find((k) => !/_(43|dm|blue|red)(_|\.)/.test(k) && !/_(43|dm|blue|red)\.i3i$/.test(k));
  const w43 = [...found.keys()].find((k) => /_43\.i3i$/.test(k));
  const blue = [...found.keys()].find((k) => /_blue\.i3i$/.test(k) && !/_dm_/.test(k));
  const red = [...found.keys()].find((k) => /_red\.i3i$/.test(k) && !/_dm_/.test(k));
  const rec = {};
  if (w169) rec.wide = { file: `${m.id}.png`, ...toPng(found.get(w169), `${m.id}.png`) };
  if (w43) rec.std = { file: `${m.id}_43.png`, ...toPng(found.get(w43), `${m.id}_43.png`) };
  if (!w169 && !w43 && blue) rec.wide = { file: `${m.id}.png`, ...toPng(found.get(blue), `${m.id}.png`), note: 'team variant (Blue), no plain art' };
  if (!w169 && !w43 && !blue && red) rec.wide = { file: `${m.id}.png`, ...toPng(found.get(red), `${m.id}.png`), note: 'team variant (Red), no plain art' };
  if (Object.keys(rec).length) index.maps[m.id] = rec;
  else console.log(`${m.id}: no loading art`);
}

const gen = files(path.join(KAYBO, 'UI_Loading.i3Pack')).find((f) => f.name === 'Loading.i3i');
index.generic = { file: '_generic.png', ...toPng(gen.buf, '_generic.png'), source: 'PBKaybo UI_Loading.i3Pack Gui/Loading/Loading.i3i' };
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`${Object.keys(index.maps).length}/${maps.length} maps with art`, JSON.stringify(index.generic));
