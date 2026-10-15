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
import { assetPath, baseClient, clientPath } from '../lib/paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { parsePack, carveNamed, decodeContent } from '../i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from '../i3r2/skin-glb.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack');
const OUT = assetPath('ui', baseClient('cross'), 'loading');
const JOBS = Number(process.env.PB_JOBS) || Math.min(4, os.availableParallelism()); // PNG encodes at once (worker threads)

/** i3i files of a pack (in memory: some packs store absolute D:\... node paths) */
function i3is(file) {
  const d = fs.readFileSync(file), out = [];
  for (const n of parsePack(d).nodes) {
    if (!n.fileCount) continue;
    // OLD-format nodes (DeadTown_SubData) carry names only: carve the payload, names by content for .i3i (carveNamed)
    const files = n.indexOk ? n.files : carveNamed(d, n);
    for (const f of files) {
      if (!/\.i3i$/i.test(f.name)) continue;
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      out.push({ name: f.name, buf });
    }
  }
  return out;
}

// I3IB -> PNG bytes of one texture: the work of a worker thread (the RGBA decode and the level 9 deflate are most of the run)
function encode(buf, file) {
  const t = readI3IB(buf, buf.indexOf('I3IB'));
  if (!t || t.kind === 'unsupported') throw new Error(`unsupported I3IB (${file})`);
  return { file, w: t.w, h: t.h, png: encodePNG(Buffer.from(decodeI3IB(buf, t)), t.w, t.h, true) };
}

// jobs [{ file, buf }] -> encoded results in job order. JOBS worker threads, one texture at a time each.
function encodeAll(jobs) {
  const out = new Array(jobs.length);
  let next = 0, done = 0;
  return new Promise((resolve, reject) => {
    if (!jobs.length) return resolve(out);
    const feed = (w) => { if (next < jobs.length) w.postMessage({ i: next, file: jobs[next].file, buf: new Uint8Array(jobs[next++].buf) }); else w.terminate(); };
    for (let k = 0; k < Math.min(JOBS, jobs.length); k++) {
      const w = new Worker(new URL(import.meta.url), { argv: process.argv.slice(2) });
      w.on('message', (m) => { out[m.i] = m; if (++done === jobs.length) resolve(out); feed(w); });
      w.on('error', reject);
      feed(w);
    }
  });
}

async function main() {
  const index = { format: 'pb-cross-loading/1', generated: new Date().toISOString(), tool: 'ui-export/cross-loading.mjs', maps: {}, size: {} };
  fs.mkdirSync(OUT, { recursive: true });
  // the same order and the same first-wins rule as the serial export: a map's variant once, then the UI_Loading images
  const jobs = [];
  const LOAD = /^load_(.+?)_(dm_red|dm_blue|red|blue)\.i3i$/i;
  for (const f of fs.readdirSync(PACKS).filter((f) => /_(SubData|Images_NoText)\.i3Pack$/i.test(f)).sort()) {
    const map = f.replace(/_(SubData|Images_NoText)\.i3Pack$/i, '').toLowerCase();
    for (const e of i3is(path.join(PACKS, f))) {
      const m = LOAD.exec(e.name);
      if (!m || m[1].toLowerCase() !== map) continue;
      const v = m[2].toLowerCase();
      if (index.maps[map]?.includes(v)) continue;
      jobs.push({ file: `${map}_${v}.png`, buf: e.buf });
      (index.maps[map] ??= []).push(v);
    }
  }
  for (const e of i3is(path.join(PACKS, 'UI_Loading.i3Pack'))) {
    const n = e.name.toLowerCase();
    if (['loading.i3i', 'load_training.i3i', 'load_ccmode.i3i'].includes(n)) jobs.push({ file: n.replace(/\.i3i$/, '.png'), buf: e.buf });
  }
  for (const { file, w, h, png } of await encodeAll(jobs)) {
    fs.writeFileSync(path.join(OUT, file), png);
    index.size[file] = [w, h];
  }
  for (const f of ['loading.png', 'load_training.png', 'load_ccmode.png']) if (!index.size[f]) throw new Error(`UI_Loading.i3Pack: ${f} missing`);
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`${Object.keys(index.maps).length} maps with loading art ->`, OUT);
}

if (isMainThread) await main();
else parentPort.on('message', ({ i, file, buf }) => { const r = encode(Buffer.from(buf), file); parentPort.postMessage({ i, ...r }); });
