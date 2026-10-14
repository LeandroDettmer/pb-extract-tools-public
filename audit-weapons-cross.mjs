#!/usr/bin/env node
// Which weapons are COMPLETE in the PBCross client, i.e. playable with the Cross export only (no 2017/3.123 asset). Pure Node ESM.
//
//   node audit-weapons-cross.mjs                 # -> out/weapons/complete-cross.json
//   node audit-weapons-cross.mjs --list [ids..]  # per weapon: complete | missing parts (no write)
//
// Complete = all of:
//   pef-cross the weapon.pef block exists in the PBCross pef (extracted/pef-cross/br/Weapon.json, pef-cross.mjs)
//   model     a textured PBCross model (weapons/models/index.json entry with the itemId, client cross)
//   ai1pv     its own 1PV AI for SWAT_Male and SWAT_Female (chars/<c>/anim1pv/index.json, no [RECRIADO] fallback)
//   ai3pv     its own 3PV AI from the PBCross I3CHR (chars/swat_male/anim3pv/index.json, aiSource Cross, no fallback)
//   clips     guns (slot 1/2): the model's weapon clips (weapons/anim/index.json models[<model id>])
//   sfx       Cross weapon sounds (weapons/sfx/pb2017.json weapons[<itemId>] with the pef fire clip, source PBCross Pack/Sound_Weapon_*)
//   icon      a Cross shop/inventory icon (ui/cross/icons/index.json icons[<itemId>].sheet): no placeholder card
// Weapons missing any part are hidden by the web client (src/lobby/state/weaponSupport.ts: shop, inventory, ?play=all);
// the DB and the server keep them. Re-enable one by exporting what it lacks and re-running this tool.
import { assetPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pefById } from './pef-cross.mjs';

const ASSETS = assetPath();
const OUT = path.join(ASSETS, 'weapons/complete-cross.json');
const json = (p) => JSON.parse(fs.readFileSync(path.join(ASSETS, p), 'utf8'));

export function audit() {
  const pef = pefById();
  const catalog = json('cross/weapons/weapons.json').weapons;
  const models = json('weapons/models/index.json').weapons;
  const anim = json('weapons/anim/index.json');
  const a1 = { SWAT_Male: json('chars/swat_male/anim1pv/index.json'), SWAT_Female: json('chars/swat_female/anim1pv/index.json') };
  const a3 = json('chars/swat_male/anim3pv/index.json');
  const sfx = json('weapons/sfx/pb2017.json').weapons;
  const icons = [json('ui/cross/icons/index.json').icons];
  const modelOf = new Map();
  for (const m of models) for (const id of m.itemIds ?? []) if (!modelOf.has(id)) modelOf.set(id, m);
  // specials: the model index carries the 2017 ITEMIDs (507xxx) where the catalog has 508xxx/528xxx -> match the pef block name
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const modelOfKey = new Map();
  for (const m of models) for (const it of m.items ?? []) if (!modelOfKey.has(norm(it.key))) modelOfKey.set(norm(it.key), m);
  const rows = [];
  for (const w of catalog) {
    const p = pef.get(w.id), m = modelOf.get(w.id) ?? (p && modelOfKey.get(norm(p.key))), miss = [];
    if (!p) miss.push('pef-cross');
    if (!m || m.client !== 'cross' || m.textured === false) miss.push(m ? `model (${m.client}${m.textured === false ? ', untextured' : ''})` : 'model');
    for (const [c, ix] of Object.entries(a1)) if (!ix.weapons[w.id] || ix.fallback[w.id]) miss.push(`ai1pv ${c}${ix.fallback[w.id] ? ` (${ix.fallback[w.id]})` : ''}`);
    const k3 = a3.weapons[w.id];
    if (!k3 || a3.fallback[w.id] || a3.aiSource?.[k3] !== 'Cross') miss.push(`ai3pv${a3.fallback[w.id] ? ` (${a3.fallback[w.id]})` : k3 ? ` (${k3} from ${a3.aiSource?.[k3]})` : ''}`);
    if ((w.slot === 1 || w.slot === 2) && !(m && anim.models[m.id] !== undefined)) miss.push('clips');
    // the entry must carry the named fire clip when the pef names one (a swap-only entry left SCAR-H Std Sil passing)
    if (!sfx[w.id] || (w.pb?.fireSound && !sfx[w.id].fire)) miss.push('sfx' + (w.pb?.fireSound && !sfx[w.id]?.fire ? ` (fire ${w.pb.fireSound} not in Cross)` : ''));
    if (!icons.some((ix) => ix[w.id]?.sheet)) miss.push('icon');
    rows.push({ id: w.id, name: w.name, slot: w.slotName, cls: w.className, ai1pv: a1.SWAT_Male.weapons[w.id] ?? null, ai3pv: k3 ?? null, model: m?.id ?? null, miss });
  }
  return rows;
}

function write(rows) {
  const counts = {};
  for (const r of rows) {
    const c = (counts[`${r.slot}/${r.cls}`] ??= { complete: 0, incomplete: 0 });
    c[r.miss.length ? 'incomplete' : 'complete']++;
  }
  const out = {
    generated: new Date().toISOString(), tool: 'tools/audit-weapons-cross.mjs',
    note: 'complete = PBCross pef block + textured Cross model + own 1PV AI (SWAT_Male/Female) + own Cross 3PV AI + weapon clips (guns) + Cross sounds + Cross icon. Any itemId NOT in `complete` (incl. DB items outside weapons.json) is hidden by src/lobby/state/weaponSupport.ts.',
    counts,
    complete: rows.filter((r) => !r.miss.length).map((r) => r.id).sort((a, b) => a - b),
    incomplete: Object.fromEntries(rows.filter((r) => r.miss.length).map((r) => [r.id, `${r.name}: ${r.miss.join('; ')}`])),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const tot = rows.length, ok = out.complete.length;
  console.log(`${ok}/${tot} weapons complete in Cross -> ${path.relative(process.cwd(), OUT)}`);
  for (const [k, c] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(28)} complete ${String(c.complete).padStart(4)}  incomplete ${String(c.incomplete).padStart(4)}`);
}

function list(ids) {
  const rows = audit(), pef = pefById();
  const want = ids.length ? ids.map(Number) : rows.map((r) => r.id);
  for (const id of want) {
    const r = rows.find((x) => x.id === id);
    if (!r) { const p = pef.get(id); console.log(`${id}\t${p?.key ?? '?'}\tINCOMPLETE: not in weapons.json${p ? `; pef-cross ${p ? 'yes' : 'no'}; LinkedToCharaAI ${p.linked}` : ''}`); continue; }
    console.log(`${r.id}\t${r.name}\t${r.miss.length ? `INCOMPLETE: ${r.miss.join('; ')}` : 'complete'}\t1pv=${r.ai1pv}\t3pv=${r.ai3pv}\tmodel=${r.model}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a[0] === '--list') list(a.slice(1));
  else write(audit());
}
