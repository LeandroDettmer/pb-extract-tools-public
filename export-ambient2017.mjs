#!/usr/bin/env node
// Map ambient sound of the 2017 client -> out/maps/<map>/ambient.json + sfx/ambient/<dir>/*.wav|ogg.
//
//   node tools/export-ambient2017.mjs [Outpost Stormtube ...]   (default: every <Map>_Scene.i3Pack with a live sound event)
//
// Decoded in docs/AUDIO_AUDIT.md §3: a map's ambient sound is a set of zones. Each live i3Evt (listed in <Map>.RSC) holds
// i3Sound + i3SoundPlayInfo layers (3D, looped) and is tied to the Box_N triggers that follow it in the RSC; the GINS record
// of a Box_N gives its centre / scale / quaternion. Evts missing from the RSC (Luxville, Library, Giran...) and layers with
// volume 0 (FaceRock) are dead. Madness is code, not scene data: its 4 clips are only exported to sfx/ambient/madness.
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carve, parsePack, decodeContent } from './i3pack/unpack.mjs';
import { readI3R2 } from './i3r2/i3r2.mjs';
import { readGINS } from './export-props.mjs';
import { convertWavs } from './wav-to-ogg.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack');
const MAPS_OUT = assetPath('maps');
const SFX_OUT = assetPath('sfx', 'ambient');
const BOX_CLS = 0x4cc77521;
const r4 = (v) => +v.toFixed(4);
const baseName = (n) => n.replace(/\\/g, '/').split('/').pop();

/** { lowercase wav name -> Buffer } of a Sound_Ambient_<dir>.i3Pack. Packs whose index does not decode (OLD nodes) are
 *  carved by RIFF size and zipped with the names the node lists, in file order. */
function ambientWavs(dir) {
  const file = path.join(PACKS, `Sound_Ambient_${dir}.i3Pack`);
  if (!fs.existsSync(file)) return null;
  const d = fs.readFileSync(file);
  const out = new Map();
  const { nodes } = parsePack(d);
  const node = nodes.find((n) => n.files.some((f) => /\.wav$/i.test(f.name)));
  if (!node) return out;
  if (node.indexOk) {
    for (const e of node.files) {
      let buf = d.subarray(e.offset, e.offset + e.size);
      if (e.attr) buf = decodeContent(buf, e.attr) ?? buf;
      out.set(e.name.toLowerCase(), buf);
    }
    return out;
  }
  const riffs = [];
  for (let p = d.indexOf('RIFF', 0, 'latin1'); p >= 0 && p + 12 <= d.length; ) {
    if (d.toString('latin1', p + 8, p + 12) !== 'WAVE') { p = d.indexOf('RIFF', p + 4, 'latin1'); continue; }
    const size = 8 + d.readUInt32LE(p + 4);
    riffs.push(d.subarray(p, Math.min(p + size, d.length)));
    p = d.indexOf('RIFF', p + size, 'latin1');
  }
  const names = node.files.map((f) => f.name);
  if (riffs.length !== names.length) throw new Error(`Sound_Ambient_${dir}: ${riffs.length} RIFF vs ${names.length} names`);
  names.forEach((n, i) => out.set(n.toLowerCase(), riffs[i]));
  return out;
}

/** RSC2 manifest: [{ evt, boxes[] }] in file order (every path is stored twice: consecutive duplicates collapse). */
function rscZones(d) {
  const r = d.indexOf('RSC2', 0, 'latin1');
  if (r < 0) return [];
  const zones = [];
  let last = '';
  for (const m of d.toString('latin1', r).matchAll(/_Generated\/([^/\0]+?)\.(i3Evt|i3s)/gi)) {
    const key = m[0].toLowerCase();
    if (key === last) continue;
    last = key;
    if (m[2].toLowerCase() === 'i3evt') zones.push({ evt: m[1], boxes: [] });
    else zones.at(-1)?.boxes.push(m[1]);
  }
  return zones;
}

const identity = (q) => Math.abs(q[0]) < 1e-3 && Math.abs(q[1]) < 1e-3 && Math.abs(q[2]) < 1e-3 && Math.abs(q[3] - 1) < 1e-3;

/** sound evts of a scene pack: [{ name, layers: [{ clip, dir, vol, lvol, min, max }] }]. The pack index lists the file
 *  names in carve order (OLD nodes); the i3TimeEventGen name wins when it has one (Luxville's list loses a name). */
function sceneEvents(d, log) {
  const out = [];
  for (const node of parsePack(d).nodes) {
    if (!node.files.length) continue;
    const { files } = carve(d, node);
    files.forEach((cf, i) => {
      if (cf.ext !== 'i3r2') return;
      let b;
      try { b = readI3R2(d, cf.offset); } catch { return; }
      const snd = b.objects.filter((o) => o.cls === 'i3Sound' && o.ext);
      if (!snd.length) return;
      const teg = b.objects.find((o) => o.cls === 'i3TimeEventGen');
      const tegName = teg ? d.toString('latin1', teg.off + 1, teg.off + 1 + d[teg.off]) : '';
      const stem = (node.files[i]?.name ?? '').replace(/.i3Evt$/i, '');
      const name = tegName || stem;
      if (tegName && stem && tegName.toLowerCase() !== stem.toLowerCase()) log(`  ${stem}: i3TimeEventGen name ${tegName} (used)`);
      const spi = b.objects.filter((o) => o.cls === 'i3SoundPlayInfo');
      if (spi.length !== snd.length) log(`  ${name}: ${snd.length} i3Sound vs ${spi.length} i3SoundPlayInfo`);
      const layers = snd.map((s, k) => {
        const p = spi[k]?.off;
        const m = /Sound[\\/]Ambient[\\/]([^\\/]+)[\\/]([^\\/]+)$/i.exec(s.extPath);
        if (p === undefined || !m) return null;
        const style = d.readUInt32LE(p + 8);
        if (style !== 0x03040010) log(`  ${name}: style ${style.toString(16)} (not 3D loop)`);
        return { dir: m[1], clip: m[2], vol: d.readUInt32LE(p + 0x18), lvol: d.readUInt32LE(p + 0x1c), min: r4(d.readFloatLE(p + 0x24)), max: r4(d.readFloatLE(p + 0x28)) };
      }).filter(Boolean);
      out.push({ name, layers });
    });
  }
  return out;
}

const mapIndex = JSON.parse(fs.readFileSync(path.join(MAPS_OUT, 'index.json'), 'utf8')).filter((m) => m.source === 'cross');
const wavCache = new Map();
const copied = new Set();
function copyClip(dir, clip) {
  const key = dir.toLowerCase();
  if (!wavCache.has(key)) wavCache.set(key, ambientWavs(dir));
  const wav = wavCache.get(key)?.get(clip.toLowerCase());
  if (!wav) return null;
  const out = clip.toLowerCase();
  const rel = `ambient/${key}/${out}`;
  if (!copied.has(rel)) {
    fs.mkdirSync(path.join(SFX_OUT, key), { recursive: true });
    fs.writeFileSync(path.join(SFX_OUT, key, out), wav);
    copied.add(rel);
  }
  return rel;
}

function exportMap(pack) {
  const file = path.join(PACKS, `${pack}_Scene.i3Pack`);
  const d = fs.readFileSync(file);
  const evts = new Map(sceneEvents(d, console.log).map((e) => [e.name.toLowerCase(), e]));
  if (!evts.size) return null;
  const entry = mapIndex.find((m) => m.pack.toLowerCase() === pack.toLowerCase());
  if (!entry) { console.log(`${pack}: not in maps/index.json, skipped`); return null; }
  const boxes = new Map(readGINS(d).records.filter((r) => r.cls === BOX_CLS).map((r) => [r.name.toLowerCase(), r]));
  const emitters = [];
  for (const z of rscZones(d)) {
    const ev = evts.get(z.evt.toLowerCase());
    if (!ev) continue;
    const layers = [];
    for (const l of ev.layers) {
      if (l.vol <= 0) { console.log(`  ${pack}/${ev.name}: ${l.clip} vol 0, dead`); continue; }
      const rel = copyClip(l.dir, l.clip);
      if (!rel) { console.log(`  ${pack}/${ev.name}: ${l.dir}/${l.clip} not in Sound_Ambient_${l.dir}`); continue; }
      layers.push({ file: rel, loop: true, vol: l.vol / 100, lvol: l.lvol / 100, min: l.min, max: l.max });
    }
    if (!layers.length) continue;
    const bx = z.boxes.map((n) => {
      const r = boxes.get(n.toLowerCase());
      if (!r) { console.log(`  ${pack}/${ev.name}: ${n} has no GINS record`); return null; }
      return { c: r.pos.map(r4), s: r.scale.map(r4), ...(identity(r.quat) ? {} : { q: r.quat.map(r4) }) };
    }).filter(Boolean);
    if (!bx.length) { console.log(`  ${pack}/${ev.name}: no box, skipped`); continue; }
    const rot = bx.filter((b) => b.q).length;
    if (rot) console.log(`  ${pack}/${ev.name}: ${rot}/${bx.length} box(es) with a rotation (kept as q)`);
    emitters.push({ id: ev.name, trigger: 'zone', boxes: bx, layers });
  }
  if (!emitters.length) return null;
  const json = { source: `${pack}_Scene.i3Pack (RSC-live i3Evt) + Sound_Ambient_*.i3Pack`, mapKey: entry.id, emitters };
  fs.writeFileSync(path.join(MAPS_OUT, entry.id, 'ambient.json'), JSON.stringify(json, null, 1));
  return { id: entry.id, emitters: emitters.length, boxes: emitters.reduce((a, e) => a + e.boxes.length, 0) };
}

// map names are the positional args; `--client <key>` is the base client switch (baseClient)
const arg = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--client');
const packs = arg.length ? arg : fs.readdirSync(PACKS).map((f) => /^(.+)_Scene\.i3Pack$/i.exec(f)?.[1]).filter(Boolean);
const done = [];
for (const p of packs) {
  let r;
  try { r = exportMap(p); } catch (e) { console.log(`${p}: ERROR ${e.message}`); continue; }
  if (r) { console.log(`${p} -> maps/${r.id}/ambient.json: ${r.emitters} emitter(s), ${r.boxes} box(es)`); done.push(p); }
}
// Madness (mode, not map): the 4 announcer-path clips; played by game/audio3d.ts
const mad = ambientWavs('Madness');
if (mad) for (const n of mad.keys()) copyClip('Madness', n);
console.log(`ambient.json for ${done.length} map(s): ${done.join(', ')}; madness clips ${mad ? mad.size : 0}`);
convertWavs(SFX_OUT);
