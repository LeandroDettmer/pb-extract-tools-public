#!/usr/bin/env node
// Which shop items of the ITEM tab are COMPLETE with the PBCross export only. Same output layout as
// audit-items-2017.mjs (complete / names / incomplete / counts), read by the lobby item-tab gate.
//
//   node audit-items-cross.mjs                 # -> out/ui/complete-items-cross.json
//   node audit-items-cross.mjs --list [ids..]  # per item: complete | missing parts (no write)
//
// Universe: PBCross Goods.pef ShopItem (extracted/pef-cross/br/Goods.json, pef/export-cross.mjs, Brazil slot) with
// _GroupIndex > 0 (0 = not sold in Brazil). itemId = 1600000 + _GroupIndex for _Type 0, 1800000 + _GroupIndex for
// _Type 1 (rule of export-cross-icons.mjs / ui-icons.mjs); other _Type values have no item-tab id and are counted only.
// The ids are the Cross numbering: the Cross renumbered _GroupIndex for part of the items (export-cross-icons.mjs header).
// Coupons (class 17) are not in Goods.pef: every system_shop_effects coupon N expands like ShopManager, 17 DD GGG per day
// count DD (Postgres pb-postgres-local), and is complete when its Cross base 16 00 GGG ShopItem is (icon + pt-BR name + days).
// No DB: coupons are not audited (warned) and stay hidden.
//
// Complete = all of:
//   icon   out/ui/cross/icons/index.json byName.item[<ShopItem name>] (export-cross-icons.mjs; name join, so the id
//          numbering does not matter)
//   name   PBCross Pack/String.i3Pack Goods_Brazil.txt "ShopItem\<name>\_Name", not a placeholder (Hangul, "Unk ...",
//          "#id", "Non String", a raw resource key). Shown names go to `names` (the lobby has no other source for them).
//
// Parts (classes 7 head, 8 face, 27 beret; the lobby chara-tab gate reads the same `complete`): universe = out/equip/index.json
// items (export-headgear.mjs: server id -> Cross Equipment entry). Complete = a GLB for every family of the complete Cross
// characters (chars/complete-cross.json) + Cross icon (icons[id], export-cross-icons.mjs) + Cross pt-BR name
// (Equipment_Brazil.txt "Equipment\<cat>\<pef>\_Name"). Server ids, not Cross numbering.
import { assetPath, baseClient, clientPath, pefDir } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';

const ASSETS = assetPath();
const OUT = path.join(ASSETS, 'ui/complete-items-cross.json');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const TYPE_BASE = { 0: 1600000, 1: 1800000 };
const TYPE_NAME = { 0: 'Maintenance', 1: 'Function' };
const PARTS = { 7: 'Head', 8: 'Face', 27: 'Beret' };

/** PBCross String.i3Pack table (UTF-16 "key<TAB>text" lines) -> Map key -> text. */
function crossStrings(file) {
  const d = fs.readFileSync(clientPath(baseClient('cross'), 'Pack', 'String.i3Pack'));
  for (const n of parsePack(d).nodes) for (const f of n.files) {
    if (f.name !== file) continue;
    let buf = d.subarray(f.offset, f.offset + f.size);
    if (f.attr) buf = decodeContent(buf, f.attr);
    const out = new Map();
    for (const line of buf.toString('utf16le').replace(/^﻿/, '').split(/\r?\n/)) {
      const t = line.indexOf('\t');
      if (t > 0) out.set(line.slice(0, t), line.slice(t + 1).trim());
    }
    return out;
  }
  throw new Error(`String.i3Pack: ${file} not found`);
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const RAW_KEY = /^[A-Za-z0-9]+(?:_[A-Za-z0-9.'-]+)+$/;
const badName = (s) => !s || HANGUL.test(s) || /^unk\b/i.test(s) || /^#/.test(s) || /^non string$/i.test(s.trim()) || RAW_KEY.test(s.trim());

/** system_shop_effects rows (coupon_id, coupon_count_day_list) of the server DB; [] when the DB is down (warned). */
function couponRows() {
  try {
    return execFileSync('docker', ['exec', 'pb-postgres-local', 'psql', '-U', 'postgres', '-d', 'pb', '-At', '-F', '\t', '-c',
      'select coupon_id, coupon_count_day_list from system_shop_effects'], { encoding: 'utf8', maxBuffer: 16 << 20 })
      .split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
  } catch (e) {
    console.error(`WARNING no DB (${e.message.split('\n')[0]}): coupons (class 17) not audited, they stay hidden`);
    return [];
  }
}

export function audit() {
  const goods = rj(pefDir('br', 'Goods.json')).ShopItem;
  const icons = rj(path.join(ASSETS, 'ui', baseClient('cross'), 'icons/index.json')).byName?.item ?? {};
  const text = crossStrings('Goods_Brazil.txt');
  const rows = [];
  const noId = {};
  for (const [key, v] of Object.entries(goods)) {
    const base = TYPE_BASE[v._Type];
    if (!v._GroupIndex) continue;
    if (base === undefined) { noId[v._Type] = (noId[v._Type] ?? 0) + 1; continue; }
    const id = base + v._GroupIndex;
    const name = text.get(`ShopItem\\${key}\\_Name`) ?? '';
    const miss = [];
    if (badName(name)) miss.push(`name (${name || 'none'})`);
    if (!icons[key]) miss.push('icon');
    rows.push({ id, key, name, tab: 'item', cls: TYPE_NAME[v._Type], miss });
  }
  // coupons (class 17): ShopManager expands a system_shop_effects coupon N as 17 DD GGG (DD = days). The Cross item it
  // activates is the 16 00 GGG ShopItem (_Type 0, _GroupIndex GGG: QuickChangeWeapon = 1700026 -> 1600026). The coupon is
  // complete when that base is complete: its Cross icon and its pt-BR name + " N dia(s)" (ShopItem\<base>\_Name).
  const baseByGroup = new Map();
  for (const [key, v] of Object.entries(goods)) if (v._Type === 0 && v._GroupIndex) baseByGroup.set(v._GroupIndex, key);
  for (const [coupon, daysCsv] of couponRows()) {
    const c = Number(coupon);
    for (const d of daysCsv.split(',').map(Number)) {
      const id = Number(`${String(c).slice(0, 2)}${String(d).padStart(2, '0')}${String(c).slice(4, 7)}`);
      const g = id % 1000, key = baseByGroup.get(g);
      const name = key ? `${text.get(`ShopItem\\${key}\\_Name`) ?? ''} ${d} dia${d > 1 ? 's' : ''}`.trim() : '';
      const miss = [];
      if (!key) miss.push(`no Cross ShopItem for the base 16 00 ${String(g).padStart(3, '0')}`);
      else {
        if (badName(text.get(`ShopItem\\${key}\\_Name`) ?? '')) miss.push(`name (${name || 'none'})`);
        if (!icons[key]) miss.push('icon');
      }
      rows.push({ id, key: key ?? `coupon ${c}`, name, tab: 'item', cls: 'Coupon', miss });
    }
  }
  // parts: server ids of the exported Cross accessories
  const equip = rj(path.join(ASSETS, 'equip/index.json'));
  const ids = rj(path.join(ASSETS, 'ui', baseClient('cross'), 'icons/index.json')).icons;
  const charaOk = new Set(rj(path.join(ASSETS, 'chars/complete-cross.json')).complete);
  const fams = new Set(rj(path.join(ASSETS, 'chars/index.json')).chars.filter((c) => (c.itemIds ?? []).some((i) => charaOk.has(i)))
    .map((c) => equip.charas?.[c.id]?.family).filter(Boolean));
  const eqText = crossStrings('Equipment_Brazil.txt');
  for (const [sid, it] of Object.entries(equip.items ?? {})) {
    const id = Number(sid), e = equip.entries[it.key], cls = PARTS[Math.floor(id / 100000)];
    if (!cls) continue;
    const name = e ? eqText.get(['Equipment', e.cat, e.pef, '_Name'].join('\\'))?.trim() ?? '' : '';
    const miss = [];
    if (!e) miss.push('model (no Cross accessory export)');
    else { const lack = [...fams].filter((f) => !e.files?.[f]); if (lack.length) miss.push(`model families (${lack.join(',')})`); }
    if (badName(name)) miss.push(`name (${name || 'none'})`);
    if (!ids[id]) miss.push('icon');
    rows.push({ id, key: e?.pef ?? it.key, name, tab: 'chara', cls, miss });
  }
  rows.sort((a, b) => a.id - b.id);
  return { rows, noId };
}

function write({ rows, noId }) {
  const counts = {};
  for (const r of rows) {
    const c = (counts[`${r.tab}/${r.cls}`] ??= { complete: 0, incomplete: 0 });
    c[r.miss.length ? 'incomplete' : 'complete']++;
  }
  const out = {
    tool: 'tools/audit-items-cross.mjs', universe: 'PBCross Goods.pef ShopItem (_Type 0/1, Brazil _GroupIndex > 0) + equip/index.json parts (7/8/27)',
    note: 'complete = Cross Goods.pef ShopItem + Cross icon (ui/cross/icons byName.item) + Cross pt-BR name (String.i3Pack Goods_Brazil.txt). ids = Cross numbering (1600000/1800000 + Cross _GroupIndex). Parts 7/8/27 (server ids): Cross accessory GLB for every complete-chara family + Cross icon + Cross name (Equipment_Brazil.txt).',
    counts, otherTypes: noId,
    complete: rows.filter((r) => !r.miss.length).map((r) => r.id),
    names: Object.fromEntries(rows.filter((r) => !r.miss.length).map((r) => [r.id, r.name])),
    incomplete: Object.fromEntries(rows.filter((r) => r.miss.length).map((r) => [r.id, `${r.name || r.key}: ${r.miss.join('; ')}`])),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`${out.complete.length}/${rows.length} items complete -> ${path.relative(process.cwd(), OUT)}`);
}

function list(ids) {
  const { rows } = audit();
  for (const r of ids.length ? ids.map((id) => rows.find((x) => x.id === Number(id)) ?? { id, key: '?', miss: ['not a Cross ShopItem id'] }) : rows)
    console.log(`${r.id}\t${r.key}\t${r.name ?? ''}\t${r.miss.length ? `INCOMPLETE: ${r.miss.join('; ')}` : 'complete'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a[0] === '--list') list(a.slice(1));
  else write(audit());
}
