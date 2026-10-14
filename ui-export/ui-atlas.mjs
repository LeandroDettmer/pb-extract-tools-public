#!/usr/bin/env node
// Atlas sheets: crops only the source rectangles a scene's templates use -> one PNG + JSON per scene.
//
//   node ui-export/ui-atlas.mjs                 # §2.2 target scenes, v12 + kaybo
//   node ui-export/ui-atlas.mjs v12 PointBlankRe_Lobby_RoomList [...]
//   node ui-export/ui-atlas.mjs v12 --all
//
// Needs out/ui/scenes/<ver>/*.json (run ui-scenes.mjs first).
// Writes out/ui/atlas/<ver>/<Scene>.{png,json} ("pb-ui-sheet/1") and merges
// out/ui/atlas/index.json ("pb-ui-atlas/1": per-image provenance + sheet list).
//
// Image resolution for key K of version V (first hit wins), recorded as the frame/image `status`:
//   1. V's VTexList, plain (flag 0)                         -> original
//   2. V's VTexList, encrypted, and W3's decoder exists     -> decrypted | decrypted-partial
//      (contract: tools/ui-export/vtex-crypt.mjs exports
//       decodeVTexImage(buf, {file, name, w, h}) -> {rgba, w, h, exact} | null)
//   3. same K, same size, plain in a fallback version       -> fallback-v11 / fallback-kaybo
//   4. nothing                                              -> missing (runtime draws a [RECRIADO] placeholder)
// kaybo: step 1 is the 2017 virtual texture (tools/ui-export/vtex-kaybo.mjs: VTV2 + .i3RefTex + .i3VTexSub),
// looked up by the shape's path (UIRe/... or UI_Temp/...: the two sets reuse image names at other sizes);
// index key kaybo/<img> for UIRe, kaybo/UI_Temp/<img> for UI_Temp.
// cross: the same reader on PBCross UI_Temp/PBRe.i3VTex (`ui-atlas.mjs cross --all` after `ui-scenes.mjs cross`), no fallback.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, rel, vtexIndex, decodeVTexPlain, encodePNG, writeJSON } from './lib.mjs';
import { loadKayboImage, rootOf } from './vtex-kaybo.mjs';
import { clientPath } from '../lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK = { v12: ['v11'], kaybo: ['v11'], v11: [], cross: [] };
const PAD = 1; // extruded border so stretched slices do not bleed

// Scenes of docs/LOBBY_PLAN.md §2.2 (and the Kaybo counterparts that exist).
export const TARGETS = {
  v12: ['PointBlankRe_Main', 'PointBlankRe_Lobby_RoomList', 'Lobby_CreatRoom_New', 'PointBlankRe_Lobby_MapInfo_ToolTip',
    'PointBlankRe_ReadyRoom_TeamSelect', 'PointBlankRe_ReadyRoom_UserInfo', 'PointBlankRe_CharaWindow',
    'PointBlankRe_Inven_Menu_plus_finder', 'PointBlankRe_Inven_Slot_V3', 'PointBlankRe_Shop_Slot_V3',
    'PointBlankRe_Profile_Info', 'PointBlankRe_MyInfomation_Myinfo', 'GameResult', 'PBRe_Ingame_Loading'],
  kaybo: ['PointBlankRe_Login', 'PointBlankRe_Channel_List', 'PointBlankRe_Main', 'PB_MainBottom', 'PointBlankRe_Lobby_RoomList',
    'PointBlankRe_Lobby_CreatRoom', 'PointBlankRe_Lobby_CreatRoom_ModeSelect', 'PointBlankRe_Lobby_CreatRoom_StageSelect',
    'pb_Lobby_CreatRoom_StageSelect_MapSlot', 'PBRe_Lobby_CreatRoom', 'PointBlankRe_Lobby_MapInfo_ToolTip',
    'PointBlankRe_ReadyRoom_TeamSelect', 'PointBlankRe_ReadyRoom_MapInfo',
    'PointBlankRe_Inven_ListMenu', 'PointBlankRe_Inven_ListMenu2', 'PointBlankRe_Inven_itemMount', 'PointBlankRe_inven_CharWindow',
    'InvenSubMenuWeapon', 'Ingame_Shop', 'IngameShop_itemSlot', 'IngameShop_Icon',
    'PointBlankRe_Shop_Menu', 'PointBlankRe_Shop_CharWindow', 'PointBlankRe_Shop_ListBox_item', 'PointBlankRe_Shop_BuyNow',
    'PointBlankRe_Shop_Cart', 'PointBlankRe_item_itemSlot', 'PointBlankRe_itemSlot_Detail', 'PBRe_PopUp_Shop_Cart',
    'PBRe_Tooltip_itemSlot', 'PBRe_Tooltip_WeaponitemSlot', 'PointBlankRe_MyInfo'],
};

let w3 = null;
async function loadW3() {
  const f = path.join(HERE, 'vtex-crypt.mjs');
  if (w3 !== null || !fs.existsSync(f)) return w3 || null;
  try { const m = await import('file://' + f.replace(/\\/g, '/')); w3 = typeof m.decodeVTexImage === 'function' ? m : false; }
  catch (e) { console.warn('vtex-crypt.mjs present but failed to load:', e.message); w3 = false; }
  return w3 || null;
}

const indexes = {};
const idx = v => (indexes[v] ||= vtexIndex(v));
const pixCache = new Map();

// -> {status, w, h, rgba?, src, encrypted, note?}
async function resolveImage(ver, key, shapePath) {
  const ck = imageKey(ver, key, shapePath);
  if (pixCache.has(ck)) return pixCache.get(ck);
  let r = null;
  if (ver === 'kaybo' || ver === 'cross') {
    // cross: the Cross UI_Temp virtual texture (same VTV2 format), no fallback to another client
    const k = loadKayboImage(key, shapePath, ver === 'cross' ? clientPath('cross') : undefined);
    if (k) r = { status: 'original', w: k.w, h: k.h, rgba: k.rgba, src: k.src, encrypted: false,
      ...(k.path.toLowerCase() !== String(shapePath).toLowerCase() ? { note: `shape path ${shapePath}, found as ${k.path}` } : {}) };
  }
  const own = idx(ver).get(key);
  if (!r && own && !own.encrypted) r = { status: 'original', ...decodeVTexPlain(fs.readFileSync(own.file)), src: rel(own.file), encrypted: false };
  if (!r && own?.encrypted) {
    const m = await loadW3();
    const d = m && m.decodeVTexImage(fs.readFileSync(own.file), { file: own.file, name: key, w: own.w, h: own.h });
    if (d?.rgba) r = { status: d.exact ? 'decrypted' : 'decrypted-partial', w: d.w, h: d.h, rgba: d.rgba, src: rel(own.file), encrypted: true };
  }
  if (!r) for (const fv of FALLBACK[ver] || []) {
    const h = idx(fv).get(key);
    if (!h || h.encrypted || (own && (own.w !== h.w || own.h !== h.h))) continue;
    r = { status: `fallback-${fv}`, ...decodeVTexPlain(fs.readFileSync(h.file)), src: rel(h.file), encrypted: false, fallbackOf: own ? rel(own.file) : null };
    break;
  }
  if (!r) {
    const fb = (FALLBACK[ver] || []).map(fv => idx(fv).get(key)).find(Boolean);
    const note = own?.encrypted ? 'encrypted .i3VTexImage (IIA2, W3) and no plain fallback of the same size'
      : ver === 'kaybo' ? 'not in the 2017 UIRe/UI_Temp .i3RefTex; ' + (fb ? 'V11 copy is encrypted' : 'no V11 copy')
      : 'no .i3VTexImage with this name';
    r = { status: 'missing', w: own?.w ?? fb?.w ?? 0, h: own?.h ?? fb?.h ?? 0, src: own ? rel(own.file) : fb ? rel(fb.file) : null, encrypted: !!(own || fb)?.encrypted, note };
  }
  pixCache.set(ck, r);
  return r;
}

// Index/cache key of an image: kaybo keeps its two VTV2 sets apart (same names, other pixels).
const imageKey = (ver, key, shapePath) => ver === 'kaybo' && rootOf(shapePath) === 'UI_Temp' ? `kaybo/UI_Temp/${key}` : `${ver}/${key}`;

function collectShapes(t, out) {
  if (!t) return;
  for (const s of t.shapes) if (s.img && s.uw > 0 && s.vh > 0) out.set(`${s.img}:${s.u},${s.v},${s.uw},${s.vh}`, s);
  for (const c of t.sub || []) collectShapes(c, out);
}

function crop(img, u, v, w, h) {
  const out = Buffer.alloc(w * h * 4);
  let any = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.w - 1, Math.max(0, u + x)), sy = Math.min(img.h - 1, Math.max(0, v + y));
    const si = (sy * img.w + sx) * 4, di = (y * w + x) * 4;
    img.rgba.copy(out, di, si, si + 4);
    if (out[di + 3]) any = true;
  }
  return { rgba: out, w, h, any };
}

// Shelf packer; returns sheet w/h and sets .x/.y on each item (item.w/h include no padding).
function pack(items) {
  const width = Math.max(1024, ...items.map(i => i.w + 2 * PAD));
  let x = 0, y = 0, rowH = 0;
  for (const it of [...items].sort((a, b) => b.h - a.h || b.w - a.w)) {
    const iw = it.w + 2 * PAD, ih = it.h + 2 * PAD;
    if (x + iw > width) { x = 0; y += rowH; rowH = 0; }
    it.x = x + PAD; it.y = y + PAD; x += iw; rowH = Math.max(rowH, ih);
  }
  return { w: width, h: Math.max(1, y + rowH) };
}

function blit(sheet, sw, it) {
  // copy with PAD-pixel edge extrusion
  for (let y = -PAD; y < it.h + PAD; y++) for (let x = -PAD; x < it.w + PAD; x++) {
    const sx = Math.min(it.w - 1, Math.max(0, x)), sy = Math.min(it.h - 1, Math.max(0, y));
    const si = (sy * it.w + sx) * 4, di = ((it.y + y) * sw + it.x + x) * 4;
    it.rgba.copy(sheet, di, si, si + 4);
  }
}

export async function buildSheet(ver, sceneName) {
  const sf = path.join(OUT, 'scenes', ver, `${sceneName}.json`);
  if (!fs.existsSync(sf)) throw new Error(`scene not exported: ${rel(sf)} (run ui-scenes.mjs)`);
  const scene = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const shapes = new Map();
  for (const t of Object.values(scene.templates)) collectShapes(t, shapes);
  const frames = {}, items = [], images = {};
  for (const [key, s] of shapes) {
    const img = await resolveImage(ver, s.img, s.path);
    images[imageKey(ver, s.img, s.path)] = img;
    if (!img.rgba) { frames[key] = { status: img.status }; continue; }
    const c = crop(img, s.u, s.v, s.uw, s.vh);
    if (!c.any) { frames[key] = { status: img.status, empty: true }; continue; }
    const it = { key, status: img.status, ...c };
    items.push(it);
  }
  const { w, h } = items.length ? pack(items) : { w: 1, h: 1 };
  const sheet = Buffer.alloc(w * h * 4);
  for (const it of items) { blit(sheet, w, it); frames[it.key] = { status: it.status, x: it.x, y: it.y, w: it.w, h: it.h }; }
  const dir = path.join(OUT, 'atlas', ver);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sceneName}.png`), encodePNG(sheet, w, h));
  const sortedFrames = Object.fromEntries(Object.entries(frames).sort((a, b) => a[0].localeCompare(b[0])));
  writeJSON(path.join(dir, `${sceneName}.json`), { format: 'pb-ui-sheet/1', version: ver, sheet: sceneName, png: `${sceneName}.png`, w, h, frames: sortedFrames }, true);
  const count = st => Object.values(frames).filter(f => f.status === st).length;
  return { sheet: `${ver}/${sceneName}`, w, h, frames: Object.keys(frames).length, packed: items.length, missing: count('missing'), images };
}

async function main() {
  const args = process.argv.slice(2);
  const jobs = [];
  if (!args.length) for (const [v, list] of Object.entries(TARGETS)) for (const s of list) jobs.push([v, s]);
  else {
    const v = args[0], rest = args.slice(1);
    const names = rest.includes('--all')
      ? fs.readdirSync(path.join(OUT, 'scenes', v)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
      : rest.length ? rest : TARGETS[v] || [];
    for (const s of names) jobs.push([v, s]);
  }
  const idxFile = path.join(OUT, 'atlas', 'index.json');
  let index = { format: 'pb-ui-atlas/1', images: {}, sheets: {} };
  try { const p = JSON.parse(fs.readFileSync(idxFile, 'utf8')); if (p.format === index.format) index = p; } catch { /* first run */ }
  for (const [v, s] of jobs) {
    if (!fs.existsSync(path.join(OUT, 'scenes', v, `${s}.json`))) { console.log(`${v}/${s}: scene not found, skipped`); continue; }
    const r = await buildSheet(v, s);
    index.sheets[r.sheet] = `atlas/${r.sheet}.json`;
    for (const [k, img] of Object.entries(r.images)) {
      const { rgba, ...meta } = img;
      index.images[k] = meta;
    }
    console.log(`${r.sheet}: ${r.w}x${r.h} frames=${r.frames} packed=${r.packed} missing=${r.missing}`);
  }
  index.images = Object.fromEntries(Object.entries(index.images).sort((a, b) => a[0].localeCompare(b[0])));
  index.sheets = Object.fromEntries(Object.entries(index.sheets).sort((a, b) => a[0].localeCompare(b[0])));
  const tally = {};
  for (const m of Object.values(index.images)) tally[m.status] = (tally[m.status] || 0) + 1;
  index.summary = tally;
  writeJSON(idxFile, index, true);
  console.log('images by status', JSON.stringify(tally));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
