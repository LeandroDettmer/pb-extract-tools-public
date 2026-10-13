#!/usr/bin/env node
// Writes <name>.dds (raw DXT blocks + original mips) next to the existing PNG of every exported weapon / character texture,
// without touching any GLB / PNG / index (the PNG stays as the client's fallback; "Texturas leves" = models_lod, PNG only).
//
//   node export-model-dds.mjs [--only <regex>]
//
// Re-runs tools/export-batch.mjs (same pack / fallback / skin selection as the real export) with PB_DDS_ONLY=1 into a temp dir
// (PB_OUT_ROOT), then copies a .dds into out only when the PNG already on disk has the same name and dimensions and
// is not alpha where the DDS is not. Stale .dds (no matching PNG, or rejected) are removed.
import { TOOLS, assetPath } from './lib/paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PUB = assetPath();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-model-dds-'));
const rest = process.argv.slice(2);
const r = spawnSync(process.execPath, [path.join(TOOLS, 'export-batch.mjs'), 'chars', 'weapons', '--skins', ...rest],
  { env: { ...process.env, PB_DDS_ONLY: '1', PB_OUT_ROOT: tmp }, stdio: ['ignore', 'ignore', 'inherit'] });
// export-batch rewrites extracted/export-batch-report.json even for a temp run: not touched here (restore from git/backup if needed)
if (r.status !== 0) { console.error('export-batch failed', r.status); process.exit(1); }

const walk = (d, out = []) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name), out) : out.push(path.join(d, e.name)); return out; };
const stat = { dds: 0, bytes: 0, noPng: 0, mismatch: 0, removed: 0 };
const kept = new Set();
for (const root of ['weapons/models', 'chars']) {
  for (const f of walk(path.join(tmp, root)).filter((x) => x.endsWith('.dds'))) {
    const rel = path.relative(tmp, f);
    const dst = path.join(PUB, rel), png = dst.replace(/\.dds$/, '.png');
    if (!fs.existsSync(png)) { stat.noPng++; continue; }
    const p = fs.readFileSync(png), d = fs.readFileSync(f);
    if (p.readUInt32BE(16) !== d.readUInt32LE(16) || p.readUInt32BE(20) !== d.readUInt32LE(12) || (p[25] === 6 && !(d.readUInt32LE(80) & 1))) { stat.mismatch++; continue; }
    fs.writeFileSync(dst, d); kept.add(dst); stat.dds++; stat.bytes += d.length;
  }
  for (const f of walk(path.join(PUB, root)).filter((x) => x.endsWith('.dds') && !kept.has(x))) { fs.rmSync(f); stat.removed++; }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`dds=${stat.dds} (${(stat.bytes / 1048576).toFixed(0)} MB) noPng=${stat.noPng} dimsOrAlphaMismatch=${stat.mismatch} staleRemoved=${stat.removed}`);
