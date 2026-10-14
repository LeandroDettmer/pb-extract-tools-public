#!/usr/bin/env node
// Which characters/equip parts are COMPLETE in the PBCross client, i.e. equippable with the Cross export only.
// Mirrors audit-weapons-cross.mjs. Pure Node ESM, reads exported assets + the system_shop name snapshot.
//
//   node audit-charas-cross.mjs                 # -> out/chars/complete-cross.json
//   node audit-charas-cross.mjs --list [ids..]  # per item: complete | missing parts (no write)
//
// Universe of "sold" itemIds = src/lobby/state/data/itemNames.json (system_shop.item_name snapshot), classes
// 6 (Character) and 7-14/27 (Head/Face/Jacket/Pocket/Glove/Belt/Holster/Skin/Beret parts).
//
// Complete = all of:
//   Character (class 6): the itemId appears in a out/chars/index.json entry's `itemIds`, that entry has
//     a model.glb on disk, >0 bones and hitboxes, and clipsFrom is swat_male/swat_female (or the entry IS one of
//     those two, which carry their own clips) so it can borrow the 1PV/3PV weapon animations already exported.
//   Parts (class 7-14, 27): no export pipeline exists yet (no chars/<x>/parts/* and no attachment support in
//     src/game/charModel.ts) -> always incomplete today. Re-enable a class once export-batch.mjs grows a
//     `parts`/`equip` mode and charModel.ts gains an attachment point for it.
// Items missing any part are hidden by the web client (src/lobby/state/charaSupport.ts: shop, inventory);
// the DB and the server keep them. Re-enable one by exporting what it lacks and re-running this tool.
import { assetPath, webPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = assetPath();
const OUT = path.join(ASSETS, 'chars/complete-cross.json');
const json = (p) => JSON.parse(fs.readFileSync(path.join(ASSETS, p), 'utf8'));
const jsonAbs = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const PART_CLASSES = { 7: 'Head', 8: 'Face', 9: 'Jacket', 10: 'Pocket', 11: 'Glove', 12: 'Belt', 13: 'Holster', 14: 'Skin', 27: 'Beret' };

export function audit() {
  const names = jsonAbs(webPath('src/lobby/state/data/itemNames.json')).names;
  const chars = json('chars/index.json').chars;
  const byItemId = new Map();
  for (const c of chars) for (const id of c.itemIds ?? (c.itemId != null ? [c.itemId] : [])) byItemId.set(id, c);

  const rows = [];
  for (const [idStr, [name]] of Object.entries(names)) {
    const id = Number(idStr);
    const cls = Math.floor(id / 100000);
    if (cls === 6) {
      const c = byItemId.get(id);
      const miss = [];
      if (!c) miss.push('not exported (no chars/index.json entry with this itemId)');
      else {
        const modelPath = path.join(ASSETS, 'chars', c.model ?? '');
        if (!c.model || !fs.existsSync(modelPath)) miss.push('model (chars/<x>/model.glb missing on disk)');
        if (!c.bones) miss.push('bones (no skeleton exported)');
        if (!c.hitboxes?.length) miss.push('hitboxes');
        const selfClips = c.id === 'swat_male' || c.id === 'swat_female';
        if (!selfClips && c.clipsFrom !== 'swat_male' && c.clipsFrom !== 'swat_female') miss.push(`clipsFrom (${c.clipsFrom ?? 'none'})`);
      }
      rows.push({ id, name, cls: 'Character', entry: c?.id ?? null, miss });
    } else if (PART_CLASSES[cls]) {
      rows.push({ id, name, cls: PART_CLASSES[cls], entry: null, miss: ['no 2017 part export (Equip_*.i3Pack not processed; no attachment support in src/game/charModel.ts)'] });
    }
  }
  return rows;
}

function write(rows) {
  const counts = {};
  for (const r of rows) {
    const c = (counts[r.cls] ??= { complete: 0, incomplete: 0 });
    c[r.miss.length ? 'incomplete' : 'complete']++;
  }
  const out = {
    generated: new Date().toISOString(), tool: 'tools/audit-charas-cross.mjs',
    note: 'complete = system_shop-sold Character itemId with an exported Cross chars/index.json model (skeleton + hitboxes + a swat_male/female clip source). Part items (head/face/jacket/pocket/glove/belt/holster/skin/beret) have no 2017 export or attachment pipeline yet and are always incomplete. Any itemId NOT in `complete` is hidden by src/lobby/state/charaSupport.ts.',
    counts,
    complete: rows.filter((r) => !r.miss.length).map((r) => r.id).sort((a, b) => a - b),
    incomplete: Object.fromEntries(rows.filter((r) => r.miss.length).map((r) => [r.id, `${r.name}: ${r.miss.join('; ')}`])),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const tot = rows.length, ok = out.complete.length;
  console.log(`${ok}/${tot} chara/equip items complete in Cross -> ${path.relative(process.cwd(), OUT)}`);
  for (const [k, c] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(12)} complete ${String(c.complete).padStart(4)}  incomplete ${String(c.incomplete).padStart(4)}`);
}

function list(ids) {
  const rows = audit();
  const want = ids.length ? ids.map(Number) : rows.map((r) => r.id);
  for (const id of want) {
    const r = rows.find((x) => x.id === id);
    if (!r) { console.log(`${id}\t?\tnot in system_shop snapshot`); continue; }
    console.log(`${r.id}\t${r.name}\t${r.cls}\t${r.miss.length ? `INCOMPLETE: ${r.miss.join('; ')}` : 'complete'}\tentry=${r.entry}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a[0] === '--list') list(a.slice(1));
  else write(audit());
}
