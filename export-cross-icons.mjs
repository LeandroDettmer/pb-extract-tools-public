#!/usr/bin/env node
// Point Blank Cross V-37 item / map / card icons -> out/ui/cross/icons/ (docs/CROSS_UI.md "Ícones").
//   node export-cross-icons.mjs
//
// The Cross client draws every icon through CEquipShapeManager (PBCross PointBlank.exe, not packed, base 0x400000):
// CreateReadyStageImageRes 0x7a5eb0 loads the texture lists, each setter picks list[tex] and a cell of a fixed grid.
// Cell helper 0x7a5290(idx, w, h, cols): x = (idx % cols) * (w + 1) + 1, y = floor(idx / cols) * (h + 1) + 1.
//
//   list (0x7a5eb0)  textures                                   first %d  used by
//   WeaponSelect     Gui/WeaponShape/Weapon_Select%d (0x7a5e47)   0         SetWeaponSelectMark 0x7a6d30
//   Chara            Gui/Item/item_cha_%02d                       0         SetCharacterShape 0x7a6e20, SetPackageGoodsShape
//   Head             Gui/Item/item_head_%02d                      0         SetCharacterShape (class 2 and 5)
//   Beret            Gui/Item/item_Beret_New%02d                  0         SetCharacterShape (class 3)
//   Mask             Gui/Item/item_Mask_%d                        1         SetCharacterShape (class 4)
//   Count            Gui/Item/item_cash_A%d                       0         SetCashItemShape 0x7a7670 (usage 1)
//   Perido           Gui/Item/item_cash_B%d                       0         SetCashItemShape (usage 0)
//   Set              Gui/Item/item_cash_set%d                     0         SetPackageGoodsShape 0x7a7840
//   Map              Gui/Interface/UI_Source_MapImage%d           1         SetMapShape 0x7a73a0, SetRandomMapShape 0x7a75d0
//   (fixed)          Gui/Card/item_card.i3i, event_mission.i3i (loose on disk, 0x7a5f09 / 0x7a5f22): SetCardShape 0x7a7af0,
//                    SetCardSetShape 0x7a7c40
//
// Grids (all from the setters):
//   weapon   204x57, 5 columns, no gutter, 88 per texture (0x7a6d7a: tex = i / 88, cell = i % 88); i = Weapon.pef
//            _UIShapeIndex of (_ClassType, _Number) (_GetWeaponOrdIdx 0x7a8240)
//   chara    134x78, 3 columns, 18 per texture (0x7a6f4a); i = Character.pef UIShapeIndex
//   head/beret/mask  135x78, 3 columns, 18 per texture (0x7a6ffa / 0x7a70a8 / 0x7a7156); i = Equipment.pef UIShapeIndex.
//            Equipment/Event hats go through the Head list: case 5 of the switch (0x7a718c) calls the same lookup as
//            getHeadInfo (0x696300 / 0x699bc0) and their UIShapeIndex continue the Head range [INFERIDO for the group]
//   item     90x65, 5 columns (0x7a77b3); tex = Goods _UITexIndex (+0x928, 0x7af230), cell = _UIShapeIndex (+0x92c,
//            0x7af250). List by usage 0x68aea0 (digit 10^6 of the Cross item id: 0 -> Perido, 1..70 -> Count). Goods.pef
//            ShopItem _Type 0 = maintenance -> Perido, _Type 1/2 -> Count [INFERIDO: same split as the V12 Goods lists;
//            the max _UITexIndex of each _Type fits the list size: 2 < 3 textures, 16 < 18]
//   set      SetGoods: list = _UITexType (0x7af270), tex = _UITexIndex; "Chara" and "Set" use the 134x78 / 3-column grid,
//            any other type the 90x65 / 5-column one (string compares at 0x7a78f3 / 0x7a7951)
//   map      166x88, 3 columns; v = Stage.pef _UIShapeIndex (_InitStageImageIndex 0x7a86d0). 0x7a74dc: k = v / 65,
//            c = v % 65; k > 0 and c != 0 -> list[k] cell c - 1, else list[0] cell v. RANDOM STAGE = list[0] cell 0x1a
//            (0x7a7623). STAGE_ID -> stage name: table registered at 0x6dfa70 (push enum, name, label, STAGE_ID; call
//            0x6e0c50), lookup by STAGE_ID & 0xff (0x6e06f0). The Cross ord is NOT the web/3.123 mapId past the old maps
//            (4 = NStation in both, Metro = 68 here, 36 on the server): `maps` is keyed by the Cross ord, `byName.map` by the
//            Stage.pef name (case ignored, as the client looks it up by the registered name)
//   card     34x55; set 13 = event_mission, k = card, else item_card, k = (set - 1) * 10 + card; x = (k % 10) * 39 + 3,
//            y = floor(k / 10) * 60 + 3 (0x7a7b6c..0x7a7c07)
//   cardSet  56x59 at x 0x188 (392); set 13 = event_mission y 1, else item_card y = (set - 1) * 60 + 1 (0x7a7cbc..)
//
// Web ids (index.json `icons`, the server numbering): cross-icons-web-ids.json, the 3.123 name join frozen on 2026-10-13
// (the 3.123 client is gone). The Cross renumbered part of the items (Goods _GroupIndex differs from 3.123 for 281 of 581
// shared names, SetGoods _GoodsId for 347 of 353, 79 weapons), so the ids are not Cross numbers: never read a server id
// as a Cross id. Each entry is [family, Cross name, match]; the cell is re-read from the Cross pef by name.
//   weapon   3.123 Weapon.pef ITEMID of the same name, or the 2017 formula (_UsageType + 1) * 100000 + _ClassType * 1000 + _Number
//   chara    3.123 Character.pef ITEMID; RedBulls = REBEL_Male, Tarantula = REBEL_Female, AcidPol = SWAT_Male,
//            KeenEyes = SWAT_Female, ViperRed (601005) = REBEL_ViperRed [INFERIDO]. The Cross exe keys the list by its OWN
//            number (SetCharacterShape 0x7a6e8a..0x7a6ee6), so the table is the only link server id -> cell
//   head/beret/mask  equip/index.json items (export-headgear.mjs: server id -> Cross Equipment entry, the join that gives the
//            model) win over the table; the table holds the 3.123 Equipment.pef name matches [INFERIDO]
//   item     3.123 Goods.pef ShopItem: _Type 0 -> 1600000 + _GroupIndex, _Type 1 -> 1800000 + _GroupIndex
//   goods    3.123 Goods.pef SetGoods _GoodsId (index.json `goods`)
// Added after the 3.123 join: chara 601005 Viper Red = REBEL_ViperRed, 602006 = SWAT_Male (chars/index.json; names in itemNames.json) [INFERIDO];
// the catalog fill (weapons.json) adds weapon ids the join left out.
// Per-nation pef arrays are read at element 1 = Brazil (Script.i3Pack config/Nation.nlf of the Cross: _Default_, Brazil,
// China, ...; the arrays carry 18/19 elements for 15 nlf lines); `nationDiff` lists the fields where Brazil differs from
// _Default_. A ShopItem whose Brazil _GroupIndex is 0 is not sold there: no web id.
// Cells with less than 2 % opaque pixels go to `missing` (transparent = no picture in the client either).
import { assetPath, baseClient, clientPath, rel } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from './i3r2/skin-glb.mjs';
import { parsePef, toJSON } from './pef/pef2json.mjs';

const KEY = baseClient('cross');
const CLIENT = clientPath(KEY);
const PACKS = path.join(CLIENT, 'Pack');
const OUT = assetPath('ui', KEY, 'icons');
const SHEET = (name) => `${KEY}/icons/${name}.png`;

// ---- inputs ----------------------------------------------------------------------------------------------------
/** pack file name -> Buffer, files of every node (all PFN2 with index here; pack paths may carry "D:/svn/...") */
function packFiles(file) {
  const d = fs.readFileSync(path.isAbsolute(file) ? file : path.join(PACKS, file)), out = new Map();
  for (const n of parsePack(d).nodes) for (const f of n.files ?? []) {
    let buf = d.subarray(f.offset, f.offset + f.size);
    if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
    out.set(f.name.toLowerCase(), buf);
  }
  return out;
}

function loadPefs(file, names) {
  const files = packFiles(file), out = {};
  for (const n of names) {
    const pef = parsePef(files.get(`${n.toLowerCase()}.pef`));
    let json = {};
    for (const r of pef.roots) json[pef.byId.get(r).name] = toJSON(pef, r, false, null);
    out[n] = Object.keys(json).length === 1 ? Object.values(json)[0] : json;
  }
  return out;
}

const BRAZIL = 1, nationDiff = new Set();
const one = (v, field) => {
  if (!Array.isArray(v)) return v;
  if (v[BRAZIL] !== v[0]) nationDiff.add(field);
  return v[BRAZIL];
};
const entries = (o) => Object.entries(o ?? {}).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
const norm = (s) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

// ---- exe: STAGE_ID table (0x6dfa70) --------------------------------------------------------------------------------
function stageTable() {
  const p = fs.readFileSync(path.join(CLIENT, 'PointBlank.exe'));
  const pe = p.readUInt32LE(0x3c), n = p.readUInt16LE(pe + 6), opt = p.readUInt16LE(pe + 20), secs = [];
  for (let i = 0; i < n; i++) {
    const s = pe + 24 + opt + i * 40;
    secs.push({ vs: p.readUInt32LE(s + 8), va: p.readUInt32LE(s + 12), rs: p.readUInt32LE(s + 16), ro: p.readUInt32LE(s + 20) });
  }
  const off = (va) => { const r = va - 0x400000, s = secs.find((x) => x.va <= r && r < x.va + Math.max(x.vs, x.rs)); return s ? r - s.va + s.ro : -1; };
  const str = (va) => { const o = off(va); return o < 0 ? '' : p.toString('latin1', o, p.indexOf(0, o)); };
  const byOrd = {};
  // push enum; push name; push label; push STAGE_ID (68 imm32 / 6A imm8); mov ecx, 0xd878f0; call 0x6e0c50
  for (let o = off(0x6dfa73); ; ) {
    if (p[o] !== 0x68 || p[o + 5] !== 0x68 || p[o + 10] !== 0x68) break;
    const enumName = str(p.readUInt32LE(o + 1)), name = str(p.readUInt32LE(o + 6));
    let q = o + 15, id;
    if (p[q] === 0x68) { id = p.readUInt32LE(q + 1); q += 5; } else if (p[q] === 0x6a) { id = p[q + 1]; q += 2; } else break;
    if (p[q] !== 0xb9 || p.readUInt32LE(q + 1) !== 0xd878f0 || p[q + 5] !== 0xe8) break;
    const ord = id & 0xff;
    if (id) (byOrd[ord] ??= { name, enums: [] }).enums.push(enumName);
    if (id && byOrd[ord].name !== name) console.warn(`  stage ord ${ord}: ${byOrd[ord].name} / ${name} (${enumName})`);
    o = q + 10;
  }
  return byOrd;
}

// ---- atlases ---------------------------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const atlases = {};          // name -> { sheet, w, h, rgba }
function addAtlas(name, buf) {
  const t = readI3IB(buf, buf.indexOf('I3IB'));
  const rgba = Buffer.from(decodeI3IB(buf, t));
  fs.writeFileSync(path.join(OUT, `${name}.png`), encodePNG(rgba, t.w, t.h, true));
  atlases[name] = { sheet: SHEET(name), w: t.w, h: t.h, rgba };
}
/** list name -> atlas names in list order (%d from `first` while the texture exists, as the 0x7a5eb0 loops) */
const lists = {};
function loadList(list, file, fmt, first) {
  const files = packFiles(file);
  lists[list] = [];
  for (let i = first; ; i++) {
    const f = fmt(i), buf = files.get(`${f}.i3i`);
    if (!buf) break;
    addAtlas(f, buf);
    lists[list].push(f);
  }
}
const p2 = (i) => String(i).padStart(2, '0');
loadList('WeaponSelect', 'UI_WeaponShape.i3Pack', (i) => `weapon_select${i}`, 0);
loadList('Chara', 'UI_Item-Cha.i3Pack', (i) => `item_cha_${p2(i)}`, 0);
loadList('Head', 'UI_Item-Head.i3Pack', (i) => `item_head_${p2(i)}`, 0);
loadList('Beret', 'UI_Item-Beret_New.i3Pack', (i) => `item_beret_new${p2(i)}`, 0);
loadList('Mask', 'UI_Item-Mask.i3Pack', (i) => `item_mask_${i}`, 1);
loadList('Count', 'UI_Item-Cash.i3Pack', (i) => `item_cash_a${i}`, 0);
loadList('Perido', 'UI_Item-Cash.i3Pack', (i) => `item_cash_b${i}`, 0);
loadList('Set', 'UI_Item-Cash.i3Pack', (i) => `item_cash_set${i}`, 0);
loadList('Map', 'UI_Interface-Map.i3Pack', (i) => `ui_source_mapimage${i}`, 1);
for (const f of ['item_card', 'event_mission']) addAtlas(f, fs.readFileSync(path.join(CLIENT, 'Gui/Card', `${f}.i3i`)));

// ---- cells -----------------------------------------------------------------------------------------------------
const missing = {};
const opaque = (a, x, y, w, h) => {
  let n = 0;
  for (let j = y; j < y + h && j < a.h; j++) for (let i = x; i < x + w && i < a.w; i++) if (a.rgba[(j * a.w + i) * 4 + 3] > 16) n++;
  return n;
};
/** rect record or null (reason in `missing[key]`). clip: the bottom rows may run past the texture (weapon grid: 88 cells of 57 rows
 *  on a 1024 texture, the last row ends at 1026; the exe samples the texture's bottom edge, the art sits above it) */
function cell(key, atlas, x, y, w, h, extra, clip = false) {
  const a = atlases[atlas];
  const why = !a ? `no texture for this list index` : x + w > a.w || (clip ? y >= a.h : y + h > a.h) ? `cell ${x},${y},${w},${h} outside ${atlas} ${a.w}x${a.h}`
    : opaque(a, x, y, w, h) < w * h * 0.02 ? `cell ${atlas}:${x},${y},${w},${h} is transparent` : null;
  if (why) { missing[key] = { ...extra, reason: why }; return null; }
  return { sheet: a.sheet, atlas, x, y, w, h, status: 'original', ...extra };
}
const grid = (idx, w, h, cols) => [(idx % cols) * (w + 1) + 1, Math.floor(idx / cols) * (h + 1) + 1];
function listCell(key, list, perTex, idx, w, h, cols, extra) {
  const atlas = lists[list][Math.floor(idx / perTex)];
  const [x, y] = grid(idx % perTex, w, h, cols);
  return cell(key, atlas, x, y, w, h, { ...extra, list, index: idx });
}

const P = loadPefs('Script.i3Pack', ['Weapon', 'Character', 'Equipment', 'Goods', 'Stage']);
const icons = {}, goods = {}, byName = { weapon: {}, chara: {}, head: {}, beret: {}, mask: {}, item: {}, goods: {} };
const count = { weapon: 0, chara: 0, head: 0, beret: 0, mask: 0, item: 0, goods: 0, map: 0, card: 0, cardSet: 0 };
const put = (table, id, r, fam) => { if (r && !table[id]) { table[id] = r; count[fam]++; } };
// web ids: the 3.123 name join, frozen (cross-icons-web-ids.json, 2026-10-13: the 3.123 client was deleted). Only the ids
// come from it; the cell is always the Cross one of the same name.
const WEB = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cross-icons-web-ids.json'), 'utf8'));

// weapons
const weaponList = (J) => { const m = {}; (function walk(o) { for (const [k, v] of entries(o)) if ('_Number' in v || 'ITEMID' in v) m[k] = v; else walk(v); })(J.WeaponList.Weapon); return m; };
for (const [name, v] of Object.entries(weaponList(P.Weapon))) {
  const cls = one(v._ClassType, '_ClassType'), num = one(v._Number, '_Number'), ui = one(v._UIShapeIndex, '_UIShapeIndex');
  if (ui == null || ui < 0) continue;
  const atlas = lists.WeaponSelect[Math.floor(ui / 88)], c = ui % 88;
  const r = cell(`weapon:${name}`, atlas, (c % 5) * 204, Math.floor(c / 5) * 57, 204, 57, { family: 'weapon', name, list: 'WeaponSelect', index: ui, classType: cls, number: num }, true);
  if (!r) continue;
  byName.weapon[name] = r;
}

// characters: Cross name -> cell
for (const [name, v] of entries(P.Character.Character)) {
  const ui = one(v.UIShapeIndex, 'UIShapeIndex');
  if (ui == null) continue;
  const r = listCell(`chara:${name}`, 'Chara', 18, ui, 134, 78, 3, { family: 'chara', name, idNumber: one(v._IDNumber, '_IDNumber') });
  if (r) byName.chara[name] = r;
}

// head / beret / mask (+ Event hats on the Head list)
for (const [group, list, fam] of [['Head', 'Head', 'head'], ['Event', 'Head', 'head'], ['Beret', 'Beret', 'beret'], ['Mask', 'Mask', 'mask']]) {
  for (const [name, v] of entries(P.Equipment.Equipment[group])) {
    const ui = one(v.UIShapeIndex, 'UIShapeIndex');
    if (ui == null) continue;
    const r = listCell(`${fam}:${name}`, list, 18, ui, 135, 78, 3, { family: fam, name, group, type: one(v._Type, '_Type') });
    if (!r) continue;
    byName[fam][name] = r;
  }
}
const equipFam = { Head: 'head', Event: 'head', Beret: 'beret', Mask: 'mask' };
const equipIdx = fs.existsSync(assetPath('equip', 'index.json')) ? JSON.parse(fs.readFileSync(assetPath('equip', 'index.json'), 'utf8')) : null;
for (const [id, it] of Object.entries(equipIdx?.items ?? {})) {
  const e = equipIdx.entries[it.key], fam = equipFam[e?.cat], r = fam && byName[fam][e.pef];
  if (!r) continue;
  if (!icons[id]) count[fam]++;
  icons[id] = { ...r, match: 'equip [INFERIDO]', v12: it.name3 };
}

// cash items and packages
for (const [name, v] of entries(P.Goods.ShopItem)) {
  const type = one(v._Type, '_Type'), tex = one(v._UITexIndex, '_UITexIndex'), ui = one(v._UIShapeIndex, '_UIShapeIndex');
  if (type == null || tex == null || ui == null) continue;
  const list = type === 0 ? 'Perido' : 'Count';
  const [x, y] = grid(ui, 90, 65, 5);
  const r = cell(`item:${name}`, lists[list][tex], x, y, 90, 65, { family: 'item', name, list, tex, index: ui, type, group: one(v._GroupIndex, '_GroupIndex') });
  if (!r) continue;
  byName.item[name] = r;
}
for (const [name, v] of entries(P.Goods.SetGoods)) {
  const list = one(v._UITexType, '_UITexType'), tex = one(v._UITexIndex, '_UITexIndex'), ui = one(v._UIShapeIndex, '_UIShapeIndex');
  const goodsId = one(v._GoodsId, '_GoodsId');
  if (goodsId == null) continue;
  const big = list === 'Chara' || list === 'Set';
  const [w, h, cols] = big ? [134, 78, 3] : [90, 65, 5];
  const [x, y] = grid(ui ?? 0, w, h, cols);
  const r = cell(`goods:${name}`, lists[list]?.[tex], x, y, w, h, { family: 'goods', name, list, tex, index: ui, goodsId });
  if (!r) continue;
  byName.goods[name] = r;
}

// maps: keyed by STAGE_ID & 0xff (web mapId); "random" = SetRandomMapShape
const stageUI = Object.fromEntries(entries(P.Stage.Stage).map(([k, v]) => [k.toLowerCase(), one(v._UIShapeIndex, '_UIShapeIndex')]));
const mapCell = (key, v, extra) => {
  const k = Math.floor(v / 65), c = v % 65;
  const [tex, idx] = k > 0 && c !== 0 ? [k, c - 1] : [0, v];
  const [x, y] = grid(idx, 166, 88, 3);
  return cell(key, lists.Map[tex], x, y, 166, 88, { ...extra, list: 'Map', tex, index: v });
};
// web ids of the frozen join: the cell of each name; ids the equip join above already gave keep their entry (put skips them)
for (const [id, [fam, name, match]] of Object.entries(WEB.icons)) {
  const r = byName[fam]?.[name];
  if (r) put(icons, id, { ...r, match }, fam); else missing[`web:${id}`] = { family: fam, name, reason: 'no Cross cell of this name' };
}
for (const [id, name] of Object.entries(WEB.goods)) {
  const r = byName.goods[name];
  if (r) put(goods, id, { ...r, match: 'name' }, 'goods'); else missing[`web:goods:${id}`] = { family: 'goods', name, reason: 'no Cross cell of this name' };
}
// the catalog (cross/weapons/weapons.json, written by export-weapons) names the pef block of every server id: a server id
// the rules above left without a cell (Cheytac 105071 = pef Cheytac_M200_TH_1year) takes the cell of its own block,
// the same one the model and the audit use. Only fills ids the join above left out.
if (fs.existsSync(assetPath(KEY, 'weapons', 'weapons.json'))) {
  for (const w of JSON.parse(fs.readFileSync(assetPath(KEY, 'weapons', 'weapons.json'), 'utf8')).weapons) {
    const r = byName.weapon[/^pef-cross:[^/]+\/(.+)$/.exec(w.pb?.src ?? '')?.[1]];
    if (r) put(icons, w.id, { ...r, match: 'catalog' }, 'weapon');
  }
}

const maps = {};
for (const [ord, s] of Object.entries(stageTable())) {
  const v = stageUI[s.name.toLowerCase()];
  if (v == null || v < 0) { missing[`map:${ord}`] = { family: 'map', name: s.name, reason: `Stage.pef _UIShapeIndex ${v}` }; continue; }
  put(maps, ord, mapCell(`map:${ord}`, v, { family: 'map', name: s.name, enums: s.enums }), 'map');
}
maps.random = mapCell('map:random', 0x1a, { family: 'map', name: 'RANDOM STAGE' });
byName.map = {};
for (const [name, v] of entries(P.Stage.Stage)) {
  const ui = one(v._UIShapeIndex, '_UIShapeIndex');
  if (ui == null || ui < 0) continue;
  const r = mapCell(`map:${name}`, ui, { family: 'map', name });
  if (r) byName.map[name] = r;
}

// cards: "<set>:<card>" and the deck of each set; rows of item_card = sets 1.., event_mission = set 13
const cards = {}, cardSets = {};
const setRows = Math.floor((atlases.item_card.h - 3) / 60);
for (let set = 1; set <= setRows; set++) {
  const ev = set === 13, atlas = ev ? 'event_mission' : 'item_card';
  for (let card = 0; card < 10; card++) {
    const k = ev ? card : (set - 1) * 10 + card;
    put(cards, `${set}:${card}`, cell(`card:${set}:${card}`, atlas, (k % 10) * 39 + 3, Math.floor(k / 10) * 60 + 3, 34, 55, { family: 'card', set, card }), 'card');
  }
  put(cardSets, set, cell(`cardSet:${set}`, atlas, 0x188, ev ? 1 : (set - 1) * 60 + 1, 56, 59, { family: 'cardSet', set }), 'cardSet');
}

const index = {
  format: 'pb-cross-icons/1',
  generated: new Date().toISOString(),
  tool: 'tools/export-cross-icons.mjs',
  notes: 'Cell rules, exe VAs and web-id rules: header of the tool and docs/CROSS_UI.md "Ícones". sheet = path under UI_BASE; ' +
    'x/y/w/h = the rect the client passes to SetTextureCoord. icons = web/server item id (3.123 numbering), goods = 3.123 SetGoods _GoodsId, ' +
    'maps = Cross STAGE_ID & 0xff (not the server mapId past 35: use byName.map with the stage name) + "random", cards = "<set>:<card>", cardSets = set, byName = every Cross entry by its pef name.',
  summary: { ...count, byName: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, Object.keys(v).length])), missing: Object.keys(missing).length,
    nationDiff: [...nationDiff] },
  atlases: Object.fromEntries(Object.entries(atlases).map(([k, a]) => [k, { sheet: a.sheet, w: a.w, h: a.h }])),
  icons, goods, maps, cards, cardSets, byName, missing,
};
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
console.log(`${Object.keys(atlases).length} atlases ->`, rel(OUT));
console.log(JSON.stringify(index.summary));
