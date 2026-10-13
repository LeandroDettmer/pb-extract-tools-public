// Snapshot/restore dos assets que os exporters de modelo/anim reescrevem. Fora do git e de out.
// node tools/assets-snapshot.mjs [--only a,b] | --restore [<nome>] [--only a,b]
import { assetPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { snapshotPath } from './lib/paths.mjs';
const ASSETS = assetPath();
const SNAPS = snapshotPath();
const KEEP = 3;
const DIRS = ['weapons/models', 'weapons/models_lod', 'weapons/anim', 'weapons/fx', 'weapons/sfx', 'chars'];

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : (argv[i + 1]?.startsWith('--') ? '' : argv[i + 1] ?? ''); };
const only = flag('--only')?.split(',').filter(Boolean);
const dirs = only ?? DIRS;
const restore = argv.includes('--restore');

const robo = (src, dst, mirror) => {
  const r = spawnSync('robocopy', [src, dst, mirror ? '/MIR' : '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NP', '/NJS'], { stdio: 'inherit' });
  if (r.status == null || r.status >= 8) throw new Error(`robocopy falhou (${r.status}): ${src} -> ${dst}`);
};
const dirBytes = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => { const p = path.join(d, e.name); return s + (e.isDirectory() ? dirBytes(p) : fs.statSync(p).size); }, 0);
const list = () => fs.existsSync(SNAPS) ? fs.readdirSync(SNAPS).filter((n) => /^\d{4}-\d\d-\d\dT/.test(n)).sort() : [];

if (restore) {
  const name = flag('--restore') || list().at(-1);
  if (!name || !fs.existsSync(path.join(SNAPS, name))) { console.error(`snapshot nao existe: ${name ?? '(nenhum)'}. Disponiveis: ${list().join(', ') || '-'}`); process.exit(1); }
  for (const d of dirs) {
    const src = path.join(SNAPS, name, d);
    if (fs.existsSync(src)) { console.log(`restore ${d} <- ${name}`); robo(src, path.join(ASSETS, d), true); }
  }
  process.exit(0);
}

const present = dirs.filter((d) => fs.existsSync(path.join(ASSETS, d)));
const need = present.reduce((s, d) => s + dirBytes(path.join(ASSETS, d)), 0);
const free = Number(fs.statfsSync(path.dirname(SNAPS), { bigint: true }).bavail * BigInt(fs.statfsSync(path.dirname(SNAPS)).bsize));
if (free < need * 1.1) { console.error(`sem espaco: precisa ${(need / 2 ** 30).toFixed(1)} GB, livre ${(free / 2 ** 30).toFixed(1)} GB em ${SNAPS}`); process.exit(1); }

const name = new Date().toISOString().replace(/:/g, '-');
for (const d of present) { console.log(`snapshot ${d}`); robo(path.join(ASSETS, d), path.join(SNAPS, name, d), false); }
// so apaga dentro de SNAPS, so nomes ISO
for (const old of list().slice(0, -KEEP)) fs.rmSync(path.join(SNAPS, old), { recursive: true, force: true });
console.log(`ok: ${path.join(SNAPS, name)} (${(need / 2 ** 20).toFixed(0)} MB). Mantidos: ${list().length}`);
