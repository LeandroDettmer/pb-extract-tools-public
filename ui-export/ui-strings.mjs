#!/usr/bin/env node
// PT-BR strings -> out/ui/strings/pt-BR.json
//
//   node ui-export/ui-strings.mjs
//
// Source: Clients/PointBlank 3.123/Script/uiLuaString/Brazil/String_Brazil.lua (STBL_IDX_KEY = "text", plain
// UTF-8 Lua source — this is the real, in-the-clear PT-BR translation table the client Lua uses via
// pbString.lua's STBL_IDX_* globals). It is NOT the same table baked into the .i3UIs design captions
// (those are Korean design-time placeholders, see README "Strings").
//
// Item names -> items.pt-BR.json (itemId -> {name, desc, key}), from the Kaybo 2017 client, NOT from 3.123
// (Locale_Brazil_String.i3Pack Weapon_Brazil.txt etc. use a per-file cipher decodeContent() doesn't cover):
//   ids:   Pack/Script.i3Pack config/Weapon.pef (tools/pef/extract-config.mjs, nation slot 1):
//          weapon itemId = (_UsageType + 1) * 100000 + _ClassType * 1000 + _Number   (1090 of the server's
//          Data/Match/ItemStatistics.xml ids hit, e.g. Gun/K-2 -> 103004); Goods.pef SetGoods/* -> _GoodsId.
//   text:  Pack/String.i3Pack Script/String/Latin_America/{Weapon,Goods}_Latin_America.txt (UTF-16LE,
//          "Weapon\Gun\K-2\_Name<TAB>K-2", key = the .pef path). Names are the weapon/set names (language
//          neutral); desc is INDONESIAN (that client's only item text; no PT-BR item table exists in 2017).
//   Equipment/Character/ShopItem have names too but their itemId formula is unverified -> not emitted.

import { clientPath, rel } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, writeJSON } from './lib.mjs';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { readScriptPack, parsePef, resolveNation } from '../pef/extract-config.mjs';

const SRC = clientPath('br3123', 'Script', 'uiLuaString', 'Brazil', 'String_Brazil.lua');

// STBL_IDX_KEY / STR_TBL_KEY / STR_... = "text with \" \\ \n escapes"   (one assignment per logical entry; values may span
// balanced {col:...} tags but never real newlines in the .lua source itself)
const ASSIGN = /^((?:STBL_IDX|STR)_[A-Za-z0-9_]+)\s*=\s*"((?:\\.|[^"\\])*)"\s*$/;

function unescapeLua(s) {
  return s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

export function parseStringLua(text) {
  const out = {};
  let dupes = 0;
  for (const raw of text.split(/\r\n|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    const m = ASSIGN.exec(line);
    if (!m) continue;
    if (Object.prototype.hasOwnProperty.call(out, m[1])) dupes++;
    out[m[1]] = unescapeLua(m[2]);
  }
  return { strings: out, dupes };
}

export function exportStrings() {
  const text = fs.readFileSync(SRC, 'utf8');
  const { strings, dupes } = parseStringLua(text);
  const file = path.join(OUT, 'strings', 'pt-BR.json');
  writeJSON(file, strings);
  return { file, count: Object.keys(strings).length, dupes, source: SRC };
}

const KAYBO_PACK = clientPath('kaybo', 'Pack');
const BS = '\\';

function readKayboStringTable(name) {
  const d = fs.readFileSync(path.join(KAYBO_PACK, 'String.i3Pack'));
  for (const n of parsePack(d).nodes) for (const f of n.files) {
    if (f.name !== name) continue;
    let buf = d.subarray(f.offset, f.offset + f.size);
    if (f.attr) buf = decodeContent(buf, f.attr);
    const out = new Map();
    for (const line of buf.toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const t = line.indexOf('\t');
      if (t > 0) out.set(line.slice(0, t), line.slice(t + 1).replace(/\\n/g, '\n'));
    }
    return out;
  }
  throw new Error(`String.i3Pack: ${name} not found`);
}

export function exportItems() {
  const pefs = Object.fromEntries(readScriptPack(fs.readFileSync(path.join(KAYBO_PACK, 'Script.i3Pack')))
    .filter(f => f.name.endsWith('.pef')).map(f => { const t = parsePef(f.data); return [f.name, resolveNation(t.RegistryRoot ?? t, 1)]; }));
  const text = new Map([...readKayboStringTable('Weapon_Latin_America.txt'), ...readKayboStringTable('Goods_Latin_America.txt')]);
  const items = {};
  let dupes = 0;
  const add = (id, key) => {
    const name = text.get(key + BS + '_Name');
    if (!name) return;
    if (items[id]) { dupes++; return; }
    items[id] = { name, desc: text.get(key + BS + 'Description') || '', key };
  };
  const walk = (o, parts) => {
    for (const [k, v] of Object.entries(o)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if ('_ClassType' in v && '_Number' in v && '_UsageType' in v)
        add((v._UsageType + 1) * 100000 + v._ClassType * 1000 + v._Number, [...parts, k].join(BS));
      else walk(v, [...parts, k]);
    }
  };
  walk(pefs['Weapon.pef'].WeaponList.Weapon, ['Weapon']);
  const weapons = Object.keys(items).length;
  for (const [k, v] of Object.entries(pefs['Goods.pef'].SetGoods || {})) if (v._GoodsId) add(v._GoodsId, ['SetGoods', k].join(BS));
  const sorted = Object.fromEntries(Object.entries(items).sort((a, b) => a[0] - b[0]));
  const file = path.join(OUT, 'strings', 'items.pt-BR.json');
  writeJSON(file, sorted, true);
  return { file, weapons, sets: Object.keys(items).length - weapons, dupes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = exportStrings();
  const it = exportItems();
  console.log(`items: ${it.weapons} weapons + ${it.sets} sets${it.dupes ? ` (${it.dupes} duplicate ids, first kept)` : ''} -> ${rel(it.file)}`);
  console.log(`pt-BR: ${r.count} keys${r.dupes ? ` (${r.dupes} duplicate re-definitions kept last-wins)` : ''} -> ${rel(r.file)}`);
}
