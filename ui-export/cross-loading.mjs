#!/usr/bin/env node
// Battle loading screen art of the Point Blank Cross client -> ui/cross/loading/.
//   pbx ui cross-loading
// Cross exe CGameSupportSet::SetLoadingSpr (0x4db100) loads, by the stage of the room:
//   World/%s/Images/load_%s_DM_Red.i3i | _DM_Blue | _Red | _Blue (0x4db233..0x4db2a0) = Pack/<Map>_SubData.i3Pack
//   (MarineWave ships its two team images in <Map>_Images_NoText.i3Pack instead), fallback Gui/Loading/Loading.i3i (0x4db2fc);
//   Gui/Loading/Load_CCmode.i3i or Load_Training.i3i (0x4db482 / 0x4db4a8) = Pack/UI_Loading.i3Pack.
// FirstLoading.i3i (spinner, "loading" caption) and Gui/Main/UI_Source03.i3i (tip icon) are already in ui/cross/atlas (cross-ui).
// Output: <map>_<variant>.png (map = lower-case pack name, variant red | blue | dm_red | dm_blue), loading.png,
// load_training.png, load_ccmode.png and index.json { maps: { <map>: [variants] }, size: { <file>: [w, h] } }.
import { assetPath, clientPath } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parsePack, carve, decodeContent } from '../i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from '../i3r2/skin-glb.mjs';

const PACKS = clientPath('cross', 'Pack');
const OUT = assetPath('ui', 'cross', 'loading');

/** i3i files of a pack (in memory: some packs store absolute D:\... node paths) */
function i3is(file) {
  const d = fs.readFileSync(file), out = [];
  for (const n of parsePack(d).nodes) {
    if (!n.fileCount) continue;
    // OLD-format nodes (DeadTown_SubData) carry names only: carve the payload, names by position (as export-classic-ui)
    const files = n.indexOk ? n.files : carve(d, n).files.map((f, k) => ({ ...f, name: n.files[k]?.name ?? '' }));
    for (const f of files) {
      if (!/\.i3i$/i.test(f.name)) continue;
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      out.push({ name: f.name, buf });
    }
  }
  return out;
}

const index = { format: 'pb-cross-loading/1', generated: new Date().toISOString(), tool: 'ui-export/cross-loading.mjs', maps: {}, size: {} };
function png(buf, file) {
  const t = readI3IB(buf, buf.indexOf('I3IB'));
  if (!t || t.kind === 'unsupported') throw new Error(`unsupported I3IB (${file})`);
  fs.writeFileSync(path.join(OUT, file), encodePNG(Buffer.from(decodeI3IB(buf, t)), t.w, t.h, true));
  index.size[file] = [t.w, t.h];
}

fs.mkdirSync(OUT, { recursive: true });
const LOAD = /^load_(.+?)_(dm_red|dm_blue|red|blue)\.i3i$/i;
for (const f of fs.readdirSync(PACKS).filter((f) => /_(SubData|Images_NoText)\.i3Pack$/i.test(f)).sort()) {
  const map = f.replace(/_(SubData|Images_NoText)\.i3Pack$/i, '').toLowerCase();
  for (const e of i3is(path.join(PACKS, f))) {
    const m = LOAD.exec(e.name);
    if (!m || m[1].toLowerCase() !== map) continue;
    const v = m[2].toLowerCase();
    if (index.maps[map]?.includes(v)) continue;
    png(e.buf, `${map}_${v}.png`);
    (index.maps[map] ??= []).push(v);
  }
}
for (const e of i3is(path.join(PACKS, 'UI_Loading.i3Pack'))) {
  const n = e.name.toLowerCase();
  if (['loading.i3i', 'load_training.i3i', 'load_ccmode.i3i'].includes(n)) png(e.buf, n.replace(/\.i3i$/, '.png'));
}
for (const f of ['loading.png', 'load_training.png', 'load_ccmode.png']) if (!index.size[f]) throw new Error(`UI_Loading.i3Pack: ${f} missing`);
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`${Object.keys(index.maps).length} maps with loading art ->`, OUT);
