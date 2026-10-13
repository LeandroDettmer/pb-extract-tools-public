#!/usr/bin/env node
// itemId -> original V12 icon cell, pure Node ESM, builtins only.
//
//   node ui-export/ui-icons.mjs [--only weapons|chars|items|goods] [--sheet out.png] [--dry]
//
// Writes out/ui/icons/{weapons,chars,items}/<itemId>.png (+ goods/<goodsId>.png) and
// out/ui/icons/index.json ("pb-ui-icons/1", frame record + status of out/ui/README.md).
// Needs out/ui/templates/v12.json (W2: ui-templates.mjs). Encrypted atlases go through
// vtex-crypt.mjs. Configs are read straight from "Clients/PointBlank 3.123/Pack/Script.i3Pack" (Brazil values).
//
// How the client picks the cell (all from the 3.123 .pef files; every rule below was checked by eye on
// icons spread over the whole index range, see NOTES in index.json):
//   weapons  Weapon.pef   _UIShapeIndex over the concatenation of UITemplate Image00..Image44
//            (ButtonImageSet_WeaponShape{1..45}_hs). Stride 88, not the 90 shapes of each template: the last
//            2 shapes of a set are not icons (WeaponShape13 ends in two `selectimage` frames). With 90 the
//            icons drift by 2 per template (e.g. *_GRS 271..279 sit at weapon_select3_a shapes 7..15).
//   chars    Character.pef UIShapeIndexV1 over UITemplate Image0 (MAIN): Name_V1 "BtImgSet_Cha_" +
//            LoopLoad_V1 -> BtImgSet_Cha_01..45, stride 18 (max index 793 only fits 45 x 18).
//   items    Equipment.pef V1_Info.UIShapeIndex over the UITemplate sets of the category's Type
//            (HEADGEAR 1 -> ButtonImageSet_Item_Head, _01.._09; BERET 8 -> Item_Beret, _New2.._New4;
//            FACEGEAR 0 -> LoopLoad BtImgSet_ItemMask_01..26), stride 18. Belt/Glove/Upper/Lower/Holster/
//            Skin have no UI template in the .pef -> missing.
//   goods    Goods.pef ShopItem: _UITexIndex picks ONE set of the Goods UITemplate list of that type
//            (MAINTENANCE 1 -> BtImgSet_ItemCash_B{n}, EXPENDABLE 0 -> _A{n}, BBOX 3 -> BattleBox),
//            _UIShapeIndex is the shape inside it (no concatenation). itemId = class * 100000 + _GroupIndex
//            (server ComDiv.GetIdStatics): _Type 0 -> class 16 (checked on 12 server coupons, e.g. 1600065
//            BulletProofVestGM), _Type 1 -> class 18 (RBoxes 1800120/121/131), _Type >= 17 -> class = _Type
//            (checked for 28: BBoxes 2800001/12/17). Class 17 "1701GGG" ids (count variant of maintenance
//            group GGG, checked on 5 server names) are aliased only when the server Data references them.
//            SetGoods (_GoodsId, packages) -> BtImgSet_ItemCash_Set{n} for _UITexType "Set".

import { clientPath, rel, serverPath, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { parsePef, toJSON } from '../pef/pef2json.mjs';
import { OUT, vtexIndex, encodePNG, writeJSON } from './lib.mjs';
import { decodeVTexImage } from './vtex-crypt.mjs';

const ICONS = path.join(OUT, 'icons');
const SCRIPT_PACK = clientPath(baseClient('br3123'), 'Pack', 'Script.i3Pack');
const SERVER_DATA = serverPath('runtime', 'Data');
const BRAZIL = 1;

// ---- inputs --------------------------------------------------------------------------------------
export function loadPefs(names) {
  const d = fs.readFileSync(SCRIPT_PACK), out = {};
  for (const n of parsePack(d).nodes) for (const f of n.files) {
    const base = f.name.replace(/\.pef$/i, '');
    if (!names.some(x => x.toLowerCase() === base.toLowerCase())) continue;
    const buf = decodeContent(d.subarray(f.offset, f.offset + f.size), f.attr);
    const pef = parsePef(buf);
    let json = {};
    for (const r of pef.roots) json[pef.byId.get(r).name] = toJSON(pef, r, false, BRAZIL);
    if (Object.keys(json).length === 1) json = Object.values(json)[0];
    out[names.find(x => x.toLowerCase() === base.toLowerCase())] = json;
  }
  return out;
}

const imageKeys = (uit) => Object.keys(uit).filter(k => /^Image\d+$/.test(k)).sort((a, b) => +a.slice(5) - +b.slice(5));
// LoopLoad prefix: <prefix>01, <prefix>02, ... while the template exists
const loopSets = (T, prefix) => { const s = []; for (let i = 1; T[prefix + String(i).padStart(2, '0')]; i++) s.push(prefix + String(i).padStart(2, '0')); return s; };

// ---- families -> jobs {family, id, name, kind, sets?, set?, index, stride} ---------------------------
function weaponJobs(W) {
  const sets = imageKeys(W.UITemplate).map(k => W.UITemplate[k].Name), jobs = [];
  for (const [cls, g] of Object.entries(W.WeaponList.Weapon)) for (const [name, v] of Object.entries(g)) {
    if (typeof v !== 'object' || v.ITEMID == null) continue;
    jobs.push({ family: 'weapons', id: v.ITEMID, name, kind: cls, sets, stride: 88, index: v._UIShapeIndex });
  }
  return jobs;
}
function charJobs(C, T) {
  const img = Object.values(C.UITemplate).find(v => v && v.Type === 0 && v.Name_V1);
  const sets = img?.LoopLoad_V1 ? loopSets(T, img.Name_V1) : [img?.Name_V1].filter(Boolean), jobs = [];
  for (const [name, v] of Object.entries(C.Character)) {
    if (typeof v !== 'object' || v.ITEMID == null) continue;
    jobs.push({ family: 'chars', id: v.ITEMID, name, kind: 'character', sets, stride: 18, index: v.UIShapeIndexV1 });
  }
  // Dino items (Character.pef /Dino: 1500511 Raptor, 1500512 Sting, 1500513 Acid...): UIShapeIndexV1 38..41 = MAIN set 3, shapes 2..5 (stride 18; checked by eye: 1500511 Raptor, 1500512 Sting, 1500513 Acid, 1500521 Tank)
  for (const [name, v] of Object.entries(C.Dino || {})) {
    if (typeof v !== 'object' || v.ITEMID == null) continue;
    jobs.push({ family: 'chars', id: v.ITEMID, name, kind: 'dino', sets, stride: 18, index: v.UIShapeIndexV1 });
  }
  return jobs;
}
const EQUIP_TYPE = { Belt: 'BELT', Beret: 'BERET', Facegear: 'FACEGEAR', Glove: 'GLOVE', Head: 'HEADGEAR', Holster: 'HOLSTER', Lower: 'LOWER', Skin: 'SKIN', Upper: 'UPPER' };
function equipJobs(E, T) {
  const U = E.UITemplate, jobs = [];
  for (const [cat, o] of Object.entries(E.Equipment)) {
    const type = U[EQUIP_TYPE[cat]];
    const sets = Object.keys(U).filter(k => U[k]?.Type === type && U[k].Name_V1).sort()
      .flatMap(k => U[k].LoopLoad_V1 ? loopSets(T, U[k].Name_V1) : [U[k].Name_V1]);
    for (const [name, v] of Object.entries(o)) {
      if (typeof v !== 'object' || v.ITEMID == null) continue;
      jobs.push({ family: 'items', id: v.ITEMID, name, kind: cat.toLowerCase(), sets, stride: 18, index: v.V1_Info?.UIShapeIndex ?? v.UIShapeIndex,
        reason: sets.length ? null : `no UI template for category ${cat} in Equipment.pef` });
    }
  }
  return jobs;
}
function serverIds() {
  const ids = new Set();
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(xml|json)$/i.test(e.name)) for (const m of fs.readFileSync(p, 'latin1').matchAll(/\b1[5-9]\d{5}\b|\b2\d{6}\b/g)) ids.add(+m[0]); } };
  if (fs.existsSync(SERVER_DATA)) walk(SERVER_DATA);
  return ids;
}
function goodsJobs(G) {
  const U = G.UITemplate, lists = {};
  for (const k of imageKeys(U)) (lists[U[k].Type] ||= []).push(U[k].Name);
  const listOf = { 0: U.MAINTENANCE, 1: U.EXPENDABLE, 28: U.BBOX, 29: U.BBOX };
  const jobs = [], byGroup0 = new Map();
  for (const [name, v] of Object.entries(G.ShopItem)) {
    if (typeof v !== 'object' || v._GroupIndex == null) continue;
    const cls = v._Type === 0 ? 16 : v._Type === 1 ? 18 : v._Type;
    const idRule = v._Type === 0 || v._Type === 1 || v._Type === 28 ? 'verified' : 'inferred (class = _Type)';
    const lt = listOf[v._Type] ?? U.EXPENDABLE;
    const j = { family: 'items', id: cls * 100000 + v._GroupIndex, name, kind: 'shop-item', set: lists[lt]?.[v._UITexIndex],
      index: v._UIShapeIndex, idRule, listRule: v._Type in listOf ? 'verified' : 'inferred (EXPENDABLE list)' };
    if (!j.set) j.reason = `no Goods UITemplate set ${v._UITexIndex} of type ${lt}`;
    // unverified item class with tex 0 / shape 0 = the .pef default (e.g. every SC_CashPerExp_*), not a real cell
    if (!(v._Type in listOf) && !v._UITexIndex && !v._UIShapeIndex) j.reason = `_Type ${v._Type}: UI index 0/0 is the unset default`;
    jobs.push(j);
    if (v._Type === 0) byGroup0.set(v._GroupIndex, j);
  }
  // class 17 count variants of maintenance items, only for ids the server references
  const aliases = [];
  for (const id of serverIds()) if (Math.floor(id / 100000) === 17 && Math.floor(id / 1000) % 100 === 1 && byGroup0.has(id % 1000)) aliases.push([id, byGroup0.get(id % 1000).id]);
  for (const [name, v] of Object.entries(G.SetGoods)) {
    if (typeof v !== 'object' || v._GoodsId == null) continue;
    const set = v._UITexType === 'Set' ? lists[U.SET]?.[v._UITexIndex] : null;
    jobs.push({ family: 'goods', id: v._GoodsId, name, kind: 'set-goods', set, index: v._UIShapeIndex,
      reason: set ? null : `_UITexType ${v._UITexType}: atlas list not identified` });
  }
  return { jobs, aliases };
}

// ---- cells ---------------------------------------------------------------------------------------
function resolveShape(T, j) {
  if (j.reason) return { reason: j.reason };
  if (j.index == null || j.index < 0) return { reason: 'no UI shape index in the .pef' };
  let set, k;
  if (j.set) { set = j.set; k = j.index; }
  else { set = j.sets[Math.floor(j.index / j.stride)]; k = j.index % j.stride; }
  const s = set && T[set]?.shapes?.[k];
  if (!s) return { reason: `shape ${k} of ${set || '(set ' + Math.floor(j.index / j.stride) + ')'} does not exist` };
  if (!s.uw || !s.vh || !s.img) return { reason: `shape ${k} of ${set} is empty` };
  return { set, shape: k, s };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1] ?? true; };
  const only = opt('--only'), sheetOut = opt('--sheet'), dry = args.includes('--dry');
  const T = JSON.parse(fs.readFileSync(path.join(OUT, 'templates', 'v12.json'), 'utf8')).templates;
  const P = loadPefs(['Weapon', 'Character', 'Equipment', 'Goods']);
  const goods = goodsJobs(P.Goods);
  let jobs = [...weaponJobs(P.Weapon), ...charJobs(P.Character, T), ...equipJobs(P.Equipment, T), ...goods.jobs];
  if (only) jobs = jobs.filter(j => j.family === only || (only === 'goods' && j.kind === 'shop-item'));

  const vidx = vtexIndex('v12');
  const icons = {}, goodsOut = {}, missing = {}, dup = [];
  const cells = [];
  for (const j of jobs) {
    const table = j.family === 'goods' ? goodsOut : icons;
    if (table[j.id] || (missing[j.id] && j.family !== 'goods')) { dup.push(`${j.id} ${j.name}`); continue; }
    const r = resolveShape(T, j);
    const h = r.s && vidx.get(r.s.img);
    if (r.s && !h) r.reason = `atlas ${r.s.img} not found in V12 VTexList`;
    if (r.reason) { (j.family === 'goods' ? goodsOut : missing)[j.id] = { status: 'missing', family: j.family, kind: j.kind, name: j.name, reason: r.reason }; continue; }
    cells.push({ j, ...r, h });
  }
  // decode atlas by atlas (bounded memory)
  cells.sort((a, b) => a.s.img.localeCompare(b.s.img));
  const sheet = [];
  let cur = null, atlas = null;
  for (const c of cells) {
    if (cur !== c.s.img) { cur = c.s.img; atlas = decodeVTexImage(fs.readFileSync(c.h.file)); }
    const { u, v, uw, vh } = c.s, rgba = Buffer.alloc(uw * vh * 4);
    let opaque = 0;
    for (let y = 0; y < vh; y++) {
      atlas.rgba.copy(rgba, y * uw * 4, ((v + y) * atlas.w + u) * 4, ((v + y) * atlas.w + u + uw) * 4);
      for (let x = 0; x < uw; x++) if (rgba[(y * uw + x) * 4 + 3]) opaque++;
    }
    const table = c.j.family === 'goods' ? goodsOut : icons;
    if (opaque < uw * vh * 0.02) { (c.j.family === 'goods' ? goodsOut : missing)[c.j.id] = { status: 'missing', family: c.j.family, kind: c.j.kind, name: c.j.name, reason: `cell ${c.s.img}:${u},${v},${uw},${vh} (${c.set} #${c.shape}) is transparent` }; continue; }
    const file = `icons/${c.j.family}/${c.j.id}.png`;
    if (!dry) { fs.mkdirSync(path.join(ICONS, c.j.family), { recursive: true }); fs.writeFileSync(path.join(OUT, file), encodePNG(rgba, uw, vh)); }
    table[c.j.id] = { sheet: file, x: 0, y: 0, w: uw, h: vh, status: c.h.encrypted ? 'decrypted' : 'original',
      src: `${c.s.img}:${u},${v},${uw},${vh}`, atlas: rel(c.h.file), template: c.set, shape: c.shape, index: c.j.index,
      family: c.j.family, kind: c.j.kind, name: c.j.name, ...(c.j.idRule && c.j.idRule !== 'verified' ? { idRule: c.j.idRule } : {}),
      ...(c.j.listRule && c.j.listRule !== 'verified' ? { listRule: c.j.listRule } : {}) };
    if (sheetOut) sheet.push({ rgba, uw, vh, key: `${c.j.family}/${c.j.id}` });
  }
  for (const [alias, id] of goods.aliases) if (icons[id] && !icons[alias]) icons[alias] = { ...icons[id], aliasOf: id, idRule: 'alias: class 17 sub 01 = count variant of maintenance group (server Data names)' };

  // Kunai 301107 (Melee/Kunai) has no UI shape in the .pef; the exe runs it as the Dual_Kunai (315008), so it shows that icon
  if (icons[315008] && !icons[301107]) { icons[301107] = { ...icons[315008], aliasOf: 315008, idRule: 'alias: Kunai 301107 is the Dual_Kunai blade pair (no shape in the .pef)' }; delete missing[301107]; }

  const count = (o) => Object.values(o).reduce((a, v) => (a[v.family] = (a[v.family] || 0) + 1, a), {});
  const index = {
    format: 'pb-ui-icons/1', version: 'v12', generated: new Date().toISOString(), tool: 'tools/ui-export/ui-icons.mjs',
    notes: 'status/frame record as out/ui/README.md. sheet = one PNG per id (x=y=0). ' +
      'Cell rules and their checks: header of tools/ui-export/ui-icons.mjs. idRule/listRule present = not verified against server data.',
    summary: { icons: count(icons), missing: count(missing), goods: Object.values(goodsOut).filter(g => g.sheet).length, goodsMissing: Object.values(goodsOut).filter(g => !g.sheet).length, duplicatesSkipped: dup.length },
    icons, missing, goods: goodsOut,
  };
  if (!dry) writeJSON(path.join(ICONS, 'index.json'), index, true);
  console.log(JSON.stringify(index.summary));
  const reasons = {};
  for (const m of Object.values(missing)) { const k = m.family + ': ' + m.reason.replace(/\d+/g, 'N').replace(/ [A-Za-z_]+\.pef$/, ''); reasons[k] = (reasons[k] || 0) + 1; }
  console.log(reasons);

  if (sheetOut && sheet.length) { // contact sheet of up to 60 evenly spread icons, for eyeballing
    const pick = sheet.filter((_, i) => i % Math.max(1, Math.floor(sheet.length / 60)) === 0).slice(0, 60);
    const cw = 184, ch = 81, cols = 6, rows = Math.ceil(pick.length / cols), W = cw * cols, H = ch * rows, o = Buffer.alloc(W * H * 4);
    pick.forEach((p, n) => { const ox = (n % cols) * cw, oy = Math.floor(n / cols) * ch;
      for (let y = 0; y < Math.min(p.vh, ch); y++) for (let x = 0; x < Math.min(p.uw, cw); x++) { const s = (y * p.uw + x) * 4, d = ((oy + y) * W + ox + x) * 4, a = p.rgba[s + 3] / 255;
        for (let k = 0; k < 3; k++) o[d + k] = p.rgba[s + k] * a + 45 * (1 - a); o[d + 3] = 255; } });
    fs.writeFileSync(sheetOut, encodePNG(o, W, H));
    console.log('sheet', sheetOut, pick.map(p => p.key).join(' '));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
