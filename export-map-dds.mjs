#!/usr/bin/env node
// Writes tex/<name>.dds (raw DXT blocks + original mips) next to the existing tex/<name>.png of every exported map,
// without touching visual.glb / visual.json / the PNGs (the PNG stays as the client's fallback).
//
//   node export-map-dds.mjs [mapdir ...]      (default: every dir in out/maps with visual.json)
//
// Pack source: visual.json.source in Clients/PBCross/Pack (the only map client). A map is
// accepted only when the image names, the texture count, the PNG dimensions AND the alpha flags match what is on disk; otherwise its .dds files are removed.
import { assetPath, clientPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { exportVisual } from './export-visual.mjs';

const ROOT = assetPath('maps');
const PACKS = [clientPath('cross', 'Pack')];

const CHILD = process.env.DDS_CHILD === '1';
const dirs = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(ROOT).filter((n) => fs.existsSync(path.join(ROOT, n, 'visual.json')));
// No args: one child process per map (the work is CPU-bound JS), a few at a time.
if (!CHILD && process.argv.length <= 2) {
  const queue = [...dirs], par = Math.max(1, Math.min(4, os.cpus().length - 2));
  let dds = 0, png = 0, bytes = 0, skipped = 0;
  const run = () => new Promise((res) => {
    const d = queue.shift();
    if (!d) return res();
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), d], { env: { ...process.env, DDS_CHILD: '1' } });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.on('close', () => {
      const m = /dds=(\d+) pngOnly=(\d+) ([\d.]+) MB/.exec(out);
      if (m) { dds += +m[1]; png += +m[2]; bytes += +m[3]; } else skipped++;
      process.stdout.write(out.split('\n').filter((l) => !l.startsWith('total')).join('\n') + '\n');
      run().then(res);
    });
  });
  await Promise.all(Array.from({ length: par }, run));
  console.log(`total dds=${dds} pngOnly=${png} ${bytes.toFixed(0)} MB, skipped maps=${skipped}`);
  process.exit(0);
}
let totalDds = 0, totalPng = 0, totalBytes = 0, bad = 0;
for (const dir of dirs) {
  const texDir = path.join(ROOT, dir, 'tex');
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'visual.json'), 'utf8')).source;
  const mapName = src.replace(/\.i3Pack$/i, '');
  let done = false;
  for (const f of fs.existsSync(texDir) ? fs.readdirSync(texDir) : []) if (f.endsWith('.dds')) fs.rmSync(path.join(texDir, f)); // stale/orphan
  for (const packDir of PACKS) {
    if (!fs.existsSync(path.join(packDir, src))) continue;
    let r;
    try { r = exportVisual(mapName, { packDir, outRoot: ROOT, dirName: dir, ddsOnly: true, log: () => {} }); } catch (e) { continue; }
    const names = r.summary.names;
    const nTex = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'visual.json'), 'utf8')).textures;
    let ok = names.length > 0 && names.length === nTex && names.every((n) => fs.existsSync(path.join(texDir, n + '.png')));
    if (ok) for (const n of names) {
      const f = path.join(texDir, n + '.dds');
      if (!fs.existsSync(f)) continue;
      const png = fs.readFileSync(path.join(texDir, n + '.png')), dds = fs.readFileSync(f);
      if (png.readUInt32BE(16) !== dds.readUInt32LE(16) || png.readUInt32BE(20) !== dds.readUInt32LE(12) || (png[25] === 6) !== ((dds.readUInt32LE(80) & 1) !== 0)) { ok = false; break; }
    }
    if (!ok) { for (const n of names) fs.rmSync(path.join(texDir, n + '.dds'), { force: true }); continue; }
    console.log(`${dir}: dds=${r.summary.dds} pngOnly=${r.summary.pngOnly} ${(r.summary.bytes / 1048576).toFixed(1)} MB (${path.basename(path.dirname(packDir)) === 'PB' ? 'kaybo' : '3.123'})`);
    totalDds += r.summary.dds; totalPng += r.summary.pngOnly; totalBytes += r.summary.bytes; done = true;
    break;
  }
  if (!done) { bad++; console.log(`${dir}: SKIPPED (no pack matches the existing PNGs)`); }
}
console.log(`total dds=${totalDds} pngOnly=${totalPng} ${(totalBytes / 1048576).toFixed(0)} MB, skipped maps=${bad}`);
