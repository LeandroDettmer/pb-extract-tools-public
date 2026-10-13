#!/usr/bin/env node
// Which shop items of the ITEM tab (coupons, function items, cards, ...) and which head/face/beret parts are COMPLETE in
// the PB 2017 web lobby. Mirrors tools/audit-charas-2017.mjs. Pure Node ESM.
//
//   node audit-items-2017.mjs                 # -> out/ui/complete-items-2017.json
//   node audit-items-2017.mjs --list [ids..]  # per item: complete | missing parts (no write)
//
// Universe (what the server sells): system_shop rows with item_visible (Postgres pb-postgres-local) of the item-tab
// classes (itemInfo.ts tabOf = "item": not 1-14 / 27) and of the part classes 7 (head), 8 (face), 27 (beret), plus the
// system_shop_effects coupons, expanded like ShopManager (itemId = 17 DD GGG, DD = days). Without the DB:
// src/lobby/state/data/itemNames.json ids and coupon days 1/3/7/30. Every other id is incomplete by construction.
//
// Complete = all of:
//   pef2017  item tab: Goods.pef ShopItem of the 2017 client (extracted/pef2017/br/Goods.json) with _GroupIndex = id % 1000,
//            _Type 0 for classes 16/17 (period items; a 17 DD GGG coupon activates the 16 00 GGG item), _Type 1 for 18.
//            Other classes (mission cards, accessories 30, sprays, name cards, passes, boxes...) have no 2017 entry.
//            parts: exported 2017 accessory (out/equip/index.json, tools/export-headgear.mjs) with a GLB for
//            every family of the complete characters (chars/complete-2017.json).
//   icon     out/ui/icons-kaybo or icons (V12) index.json record; a 17 DD GGG coupon uses the 16 00 GGG icon
//            (the V12 index itself maps 1701017 -> icons/items/1600017.png).
//   name     a shown name that is not a placeholder: items.pt-BR.json, else the server name (itemNames.json; coupons:
//            system_shop_effects.coupon_name of 17 00 GGG + " N dia(s)"), else the 2017 client's own item name
//            (Pack/String.i3Pack Equipment_Latin_America.txt "Equipment\<cat>\<key>\_Name", parts only); rejected:
//            Hangul, "Unk ...", "#id", "Non String" or a raw resource key (A_E_Beret_X, ACC_S_X, NameCard_X).
//            Names the lobby would not find by itself (coupon days, 2017 part names) go to `names` (itemNames.ts).
//   effect   item tab only: the server handles it: 16 00 GGG is a named Plugin.Core/Enums/EffectId.cs id (the effect of
//            a used item is 1600000 + itemId % 1000), or PROTOCOL_AUTH_SHOP_ITEM_AUTH_REQ.cs handles the itemId itself.
// Items missing any part are hidden from the shop (src/lobby/state/charaSupport.ts isItemComplete / isCharaComplete);
// the inventory never hides equipped / active / basic items (model.ts inventoryItems keep). The DB is untouched.
import { assetPath, clientPath, extractedPath, serverPath, webPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';

const ASSETS = assetPath();
const SERVER = serverPath();
const OUT = path.join(ASSETS, 'ui/complete-items-2017.json');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const tryJson = (p) => { try { return rj(p); } catch { return null; } };
const cls = (id) => Math.floor(id / 100000);
const PARTS = { 7: 'Head', 8: 'Face', 27: 'Beret' };
const isItemTab = (id) => { const c = cls(id); return !(c >= 1 && c <= 14) && c !== 27; };
const CLASS_NAME = { 15: 'Dino', 16: 'Maintenance', 17: 'Coupon', 18: 'Function', 20: 'Point', 22: 'MissionCard', 26: 'MissionCard', 28: 'BattleBox',
  30: 'Accessory', 31: 'Accessory', 32: 'Spray', 33: 'Spray', 34: 'NameCard', 35: 'NameCard', 36: 'Pass', 37: 'SeasonExp', 40: 'Item40', 41: 'Item41', 50: 'Item50', 91: 'Item91', 99: 'Item99' };

function psql(q) {
  return execFileSync('docker', ['exec', 'pb-postgres-local', 'psql', '-U', 'postgres', '-d', 'pb', '-At', '-F', '\t', '-c', q], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
}

/** itemId -> { sold } of the universe. */
function universe(names) {
  const out = new Map();
  const couponIds = (coupon, days) => days.map((d) => Number(`${String(coupon).slice(0, 2)}${String(d).padStart(2, '0')}${String(coupon).slice(4, 7)}`));
  try {
    for (const [id, vis] of psql('select item_id, item_visible from system_shop')) {
      const n = Number(id);
      if (isItemTab(n) || PARTS[cls(n)]) out.set(n, { sold: vis === 't' });
    }
    for (const [coupon, days, vis] of psql('select coupon_id, coupon_count_day_list, coupon_visible from system_shop_effects'))
      for (const n of couponIds(coupon, days.split(',').map(Number))) out.set(n, { sold: vis === 't' });
    return { items: out, source: 'system_shop / system_shop_effects (Postgres)' };
  } catch { /* no DB: snapshot */ }
  for (const [id, [, src]] of Object.entries(names)) {
    const n = Number(id);
    if (src === 'system_shop_effects') for (const c of couponIds(n, [1, 3, 7, 30])) out.set(c, { sold: true });
    else if (isItemTab(n) || PARTS[cls(n)]) out.set(n, { sold: true });
  }
  return { items: out, source: 'itemNames.json snapshot (no DB)' };
}

/** 2017 client item-name table (String.i3Pack, UTF-16 "key<TAB>text" lines) -> Map key -> text; empty when absent. */
function clientStrings(file) {
  const out = new Map();
  try {
    const d = fs.readFileSync(clientPath(baseClient('kaybo'), 'Pack', 'String.i3Pack'));
    for (const n of parsePack(d).nodes) for (const f of n.files) {
      if (f.name !== file) continue;
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr);
      for (const line of buf.toString('utf16le').replace(/^﻿/, '').split(/\r?\n/)) {
        const t = line.indexOf('\t');
        if (t > 0) out.set(line.slice(0, t), line.slice(t + 1).trim());
      }
    }
  } catch { /* no 2017 client */ }
  return out;
}

function serverEffects() {
  const eff = new Set(), auth = new Set();
  const e = path.join(SERVER, 'Plugin.Core/Enums/EffectId.cs'), a = path.join(SERVER, 'Server.Game/Network/ClientPacket/PROTOCOL_AUTH_SHOP_ITEM_AUTH_REQ.cs');
  if (fs.existsSync(e)) for (const m of fs.readFileSync(e, 'utf8').matchAll(/public const int \w+\s*=\s*(\d{7})/g)) eff.add(Number(m[1]));
  if (fs.existsSync(a)) {
    const src = fs.readFileSync(a, 'utf8');
    for (const m of src.matchAll(/Field1 == (\d{7})/g)) auth.add(Number(m[1]));
    for (const m of src.matchAll(/Field1 > (\d{7}) && this\.Field1 < (\d{7})/g)) for (let i = Number(m[1]) + 1; i < Number(m[2]); i++) auth.add(i);
  }
  return { eff, auth, ok: eff.size > 0 };
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const RAW_KEY = /^[A-Za-z0-9]+(?:_[A-Za-z0-9.'-]+)+$/; // A_E_Beret_Black, ACC_S_Tiger, NameCard_X (no spaces)
const badName = (s) => !s || HANGUL.test(s) || /^unk\b/i.test(s) || /^#/.test(s) || /^non string$/i.test(s.trim()) || RAW_KEY.test(s.trim());

export function audit() {
  const names = rj(webPath('src/lobby/state/data/itemNames.json')).names;
  const ptbr = tryJson(path.join(ASSETS, 'ui/strings/items.pt-BR.json')) ?? {};
  const icons = [tryJson(path.join(ASSETS, 'ui/icons-kaybo/index.json')), tryJson(path.join(ASSETS, 'ui/icons/index.json'))].filter(Boolean);
  const goods = rj(extractedPath('pef2017', 'br', 'Goods.json')).ShopItem;
  const equip = tryJson(path.join(ASSETS, 'equip/index.json'));
  const chars = rj(path.join(ASSETS, 'chars/index.json')).chars;
  const charaOk = new Set(tryJson(path.join(ASSETS, 'chars/complete-2017.json'))?.complete ?? []);
  const fams = new Set(chars.filter((c) => (c.itemIds ?? []).some((i) => charaOk.has(i))).map((c) => equip?.charas?.[c.id]?.family).filter(Boolean));
  const pef = new Map();
  for (const [k, v] of Object.entries(goods)) pef.set(`${v._Type}:${v._GroupIndex}`, k);
  const srv = serverEffects();
  const { items, source } = universe(names);
  const equipNames = clientStrings('Equipment_Latin_America.txt');

  const iconOf = (id) => icons.some((j) => j.icons?.[id]?.sheet || j.goods?.[id]?.sheet);
  const rows = [];
  for (const [id, { sold }] of [...items].sort((a, b) => a[0] - b[0])) {
    const c = cls(id), g = id % 1000, miss = [];
    const base16 = 1600000 + g;
    // name: client pt-BR, server, coupon row 17 00 GGG + days, 2017 client part name
    const days = Math.floor(id / 1000) % 100;
    const couponBase = c === 17 ? names[1700000 + g]?.[0]?.trim() : '';
    const coupon = couponBase ? `${couponBase} ${days} dia${days > 1 ? 's' : ''}` : '';
    const eqIt = PARTS[c] ? equip?.items?.[id] : null, eqE = eqIt && equip.entries[eqIt.key];
    const n2017 = eqE ? equipNames.get(['Equipment', eqE.cat, eqE.pef, '_Name'].join('\\')) ?? '' : '';
    const own = [ptbr[id]?.name?.trim(), names[id]?.[0]?.trim()].find((x) => x && !badName(x));
    const name = own || [coupon, n2017].find((x) => x && !badName(x)) || names[id]?.[0]?.trim() || '';
    const shown = own ? null : name; // a name the lobby would not resolve by itself
    if (badName(name)) miss.push(`name (${name || 'none'})`);
    if (!(iconOf(id) || (c === 17 && iconOf(base16)))) miss.push('icon');
    if (PARTS[c]) {
      const it = equip?.items?.[id];
      const e = it && equip.entries[it.key];
      if (!e) miss.push('model (no 2017 accessory export: tools/export-headgear.mjs)');
      else {
        const lack = [...fams].filter((f) => !e.files[f]);
        if (lack.length) miss.push(`model families (${lack.join(',')})`);
      }
      rows.push({ id, name, shown, tab: 'chara', cls: PARTS[c], sold, miss });
      continue;
    }
    const type = c === 16 || c === 17 ? 0 : c === 18 ? 1 : null;
    const key = type === null ? null : pef.get(`${type}:${g}`);
    if (!key) miss.push('pef2017 (no Goods.pef ShopItem)');
    if (srv.ok && !(srv.eff.has(base16) || srv.auth.has(id))) miss.push('effect (server has no handler)');
    rows.push({ id, name, shown, tab: 'item', cls: CLASS_NAME[c] ?? `Class${c}`, sold, miss, pef: key ?? null });
  }
  return { rows, source };
}

function write({ rows, source }) {
  const counts = {};
  for (const r of rows) {
    const k = `${r.tab}/${r.cls}`;
    const c = (counts[k] ??= { sold: 0, soldComplete: 0, complete: 0, incomplete: 0 });
    c[r.miss.length ? 'incomplete' : 'complete']++;
    if (r.sold) { c.sold++; if (!r.miss.length) c.soldComplete++; }
  }
  const out = {
    generated: new Date().toISOString(), tool: 'tools/audit-items-2017.mjs', universe: source,
    note: 'complete = item tab: 2017 Goods.pef ShopItem + icon (icons-kaybo / V12) + a real name + a server effect handler; head/face/beret: exported 2017 accessory (equip/index.json) for every family of the complete characters + icon + name. Any item-tab or part itemId NOT in `complete` is hidden from the shop by src/lobby/state/charaSupport.ts (the inventory keeps equipped / active / basic ones).',
    counts,
    complete: rows.filter((r) => !r.miss.length).map((r) => r.id),
    names: Object.fromEntries(rows.filter((r) => !r.miss.length && r.shown).map((r) => [r.id, r.shown])),
    incomplete: Object.fromEntries(rows.filter((r) => r.miss.length).map((r) => [r.id, `${r.name || '?'}: ${r.miss.join('; ')}`])),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`${out.complete.length}/${rows.length} items complete (${source}) -> ${path.relative(process.cwd(), OUT)}`);
  for (const [k, c] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(20)} sold ${String(c.sold).padStart(4)} (complete ${String(c.soldComplete).padStart(3)})   all: complete ${String(c.complete).padStart(4)} incomplete ${String(c.incomplete).padStart(4)}`);
}

function list(ids) {
  const { rows } = audit();
  const want = ids.length ? ids.map(Number) : rows.filter((r) => r.sold).map((r) => r.id);
  for (const id of want) {
    const r = rows.find((x) => x.id === id);
    if (!r) { console.log(`${id}\t?\tnot sold / not an item-tab or part id`); continue; }
    console.log(`${r.id}\t${r.name}\t${r.cls}\t${r.sold ? 'sold' : 'hidden'}\t${r.miss.length ? `INCOMPLETE: ${r.miss.join('; ')}` : 'complete'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a[0] === '--list') list(a.slice(1));
  else write(audit());
}
