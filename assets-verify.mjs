// Compara weapons/models/index.json e chars/index.json atuais com um baseline. Exit 1 em regressao.
// node tools/assets-verify.mjs [--base <snapshotDir | pasta | index.json>]
import { assetPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { snapshotPath } from './lib/paths.mjs';
const ASSETS = assetPath();
const SNAPS = snapshotPath();
const SHRINK = 0.2;

const bi = process.argv.indexOf('--base');
let base = bi >= 0 ? path.resolve(process.argv[bi + 1]) : null;
if (!base) {
  const l = fs.existsSync(SNAPS) ? fs.readdirSync(SNAPS).filter((n) => /^\d{4}-\d\d-\d\dT/.test(n)).sort() : [];
  // --if-baseline (export all): a first export into an empty folder has no snapshot, so nothing can regress
  if (!l.length && process.argv.includes('--if-baseline')) { console.log('sem baseline (snapshot vazio): nada a comparar'); process.exit(0); }
  if (!l.length) { console.error('sem baseline: rode assets:snapshot ou passe --base'); process.exit(1); }
  base = path.join(SNAPS, l.at(-1));
}
// kind: rel = pasta dos assets, flat = nome achatado (prodcmp), key = lista no JSON, id = chave da entrada, dir = pasta dos glb
const KINDS = [
  { rel: 'weapons/models', key: 'weapons', id: (e) => e.file, dir: 'weapons/models' },
  { rel: 'chars', key: 'chars', id: (e) => e.file ?? e.model, dir: 'chars' },
];
const flatOf = (rel) => rel.replace(/\//g, '__');
const find = (rel) => [path.join(base, rel, 'index.json'), path.join(base, `${flatOf(rel)}__index.json`), path.join(base, `${flatOf(rel)}.json`)].find(fs.existsSync)
  ?? (base.endsWith('.json') && path.basename(base).includes(flatOf(rel)) ? base : null);
const baseGlb = (dir, f) => [path.join(base, dir, f), path.join(base, `${flatOf(dir)}__${f.replace(/\//g, '__')}`)].find(fs.existsSync);
const miss = (e) => new Set((e.missingTextures ?? []).filter((n) => !/_(norm|spec)$/i.test(n)));

let fail = 0;
for (const k of KINDS) {
  const bp = find(k.rel);
  if (!bp) { console.log(`[${k.rel}] sem baseline em ${base}, pulado`); continue; }
  const cur = new Map(JSON.parse(fs.readFileSync(path.join(ASSETS, k.rel, 'index.json'), 'utf8'))[k.key].map((e) => [k.id(e), e]));
  const old = JSON.parse(fs.readFileSync(bp, 'utf8'))[k.key];
  const gone = [], texReg = [], shrunk = [], glbGone = [];
  for (const o of old) {
    const id = k.id(o), c = cur.get(id);
    if (!c) { gone.push(id); continue; }
    const om = miss(o), added = [...miss(c)].filter((n) => !om.has(n));
    if (added.length) texReg.push(`${id} +${added.join(',')}`);
    const f = path.join(ASSETS, k.dir, id), b = baseGlb(k.dir, id);
    if (!fs.existsSync(f)) { glbGone.push(id); continue; }
    if (b) { const bs = fs.statSync(b).size, cs = fs.statSync(f).size; if (cs < bs * (1 - SHRINK)) shrunk.push(`${id} ${bs}->${cs}`); }
  }
  const bad = gone.length + texReg.length + glbGone.length;
  fail += bad;
  console.log(`[${k.rel}] base=${old.length} atual=${cur.size} | entradas sumidas=${gone.length} | missingTextures cresceu=${texReg.length} | glb sumiu=${glbGone.length} | glb encolheu>20%=${shrunk.length}`);
  for (const [t, a] of [['SUMIU', gone], ['TEX', texReg], ['GLB SUMIU', glbGone], ['ENCOLHEU', shrunk]]) for (const x of a.slice(0, 20)) console.log(`  ${t}: ${x}`);
}
// any file of a snapshot baseline that no longer exists (an exporter wiping chars/<id>/ took anim1pv/anim3pv/ui_idle)
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
if (fs.existsSync(path.join(base, "chars")) || fs.existsSync(path.join(base, "weapons"))) {
  const lost = walk(base).map((p) => path.relative(base, p)).filter((r) => !fs.existsSync(path.join(ASSETS, r)));
  fail += lost.length;
  console.log(`[arquivos] sumiram=${lost.length}`);
  for (const x of lost.slice(0, 20)) console.log(`  SUMIU: ${x}`);
}
console.log(fail ? `FALHOU: ${fail} regressoes` : 'ok');
process.exit(fail ? 1 : 0);
