#!/usr/bin/env node
// In-game HUD textures + minimaps from the 2017 client (Clients/PBKaybo/GameData/Apps/PB/Pack), for src/game/pbHud.
//
//   node ui-export/hud-2017.mjs            # every map of out/maps/index.json + HUD textures
//   node ui-export/hud-2017.mjs nstation   # one map (+ HUD textures)
//
// Writes out/ui/hud/:
//   Hud.png, kill_message.png   decoded Gui/Ingame/Hud.i3i (UI_Ingame-Hud.i3Pack) and Gui/Ingame/kill_message.i3i
//                               (UI_Ingame.i3Pack). Hud.i3i is the texture Crosshair::Create (0x759400) loads.
//   blood.png                   Gui/Ingame/blood.i3i (UI_Ingame.i3Pack), the red screen blood drawn when the local
//                               player is hit (src/game/pbHud/layout.ts SCREEN_BLOOD). 512x1024 DXT5 whose alpha
//                               stops at row 767, so the alpha box is recorded in index.textures["blood.png"].content.
//   minimap/<mapId>.png         World/<Map>/Images/mini_<Map>.i3i of <Map>_SubData.i3Pack (DXT5, 512x1024)
//   minimap/<mapId>_text.png    mini_<Map>_text.i3i (area-name layer) when present
//   index.json                  "pb-hud-2017/1": provenance + minfo_<Map>.txt values per map
//
// minfo_<Map>.txt ([Default] RealMapScale, RealBakedSize, CenterX, CenterY; comments in the file, CP949):
//   RealBakedSize = size in image px of the larger map side, CenterX/Y = image px of the world origin,
//   RealMapScale = the larger world side in metres (CBattleHUD_MiniMap::_CalcMapScale 0x708870 computes the same
//   max(bound.x, bound.z) from the world bound). px per metre = RealBakedSize / RealMapScale.
//   Axis mapping u = CenterX - x*k, v = CenterY - z*k (three.js/i3-world x is mirrored: the image is baked in
//   asset space, see tools/AXES.md root matrix). Checked against collision: `--check` draws
//   every up-facing collision triangle + the respawns over the image (scratch PNG) for a visual match.
import { assetPath, clientPath, extractedPath, rel } from '../lib/paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG, readGLB } from '../i3r2/skin-glb.mjs';

const PACK = clientPath('kaybo', 'Pack');
const OUT = assetPath('ui', 'hud');


function decodeI3i(file) {
  const d = file.buf;
  const t = readI3IB(d, d.indexOf('I3IB'));
  if (!t || t.kind === 'unsupported') throw new Error(`${file}: unsupported I3IB`);
  return { rgba: decodeI3IB(d, t), w: t.w, h: t.h, format: t.kind };
}

/** Files of a pack in memory ({name, buf}); node paths are ignored (some 2017 packs store absolute D:\... paths). */
function unpackTo(pack) {
  const d = fs.readFileSync(pack);
  const out = [];
  for (const n of parsePack(d).nodes) {
    if (!n.indexOk) continue;
    for (const f of n.files) {
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      out.push({ name: f.name, buf });
    }
  }
  return out;
}

function parseIni(txt) {
  const o = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]\w*)\s*=\s*([-\d.]+)/.exec(line);
    if (m) o[m[1]] = Number(m[2]);
  }
  return o;
}

const index = { format: 'pb-hud-2017/1', generated: new Date().toISOString(), tool: 'tools/ui-export/hud-2017.mjs', textures: {}, minimaps: {} };
const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')); } catch { return null; } })();
fs.mkdirSync(path.join(OUT, 'minimap'), { recursive: true });

// ---- HUD textures
// kill_message1.i3i = 2nd banner sheet (Mission Start / Mission Success / Game Over / Intercept / Hold The Line
// / Mobility UP / Assist Kill / Special Gunner / Bomb Shot / One Shot One Kill / Assassin / Gas Attack / Awesome
// / revenge tiers HOT KILLER 1★ / NIGHTMARE 2★★ / MEAT CHOPPER 3★★★). Only mission_start / mission_success /
// game_over cells are mapped in `killmarks.ts` so far — the rest is documented in RE_GAPS.md #32.
// kill_mark_HistoryBG.i3i = 128x128 red star with "KILL" and a blood splash: HUD_TEXTURE_KILLHISTORY_BG (index 15, InitHudTexture
// 0x76e64c), the crest CChainKills::Create 0x7b9e90 puts behind the kill star (sprite +0x5e4), see src/game/pbHud/killStars.ts.
// help_observer.i3i (UI_Interface.i3Pack, Gui/Interface): the observer help band CHud::CreateHUD 0x747e7a builds from it
// (region 603,1 .. 812,59), see docs/OBSERVER.md.
// Hud_br.png = the BR 3.123 Hud.i3i: same layout and UVs as the 2017 sheet, but its mission panel title (515,148)-(680,177) reads
// "Alerta de Missão" where the 2017 one reads "임무 알림"; only the mission panel uses it (src/game/pbHud/layout.ts MISSION_PANEL).
const PACK_BR = clientPath('br3123', 'Pack');
// kill_message_th01/02/03.png = Portable 2022 (build TH) Locale_Thailand_GUI.i3Pack kill_message_01/_02/_03.i3i (1024x1024 DXT5):
// _01 same art/2x10 grid as the 2017 kill_message, _02 same grid as kill_message1 with new art, _03 = "ASSIST!" (cell 0,0). Skipped when the Portable client is absent.
const PACK_TH = clientPath('portable', 'Pack');
// kill_message_cross.png = Point Blank Cross (Clients/PBCross) UI_Ingame.i3Pack Gui/Ingame/kill_message.i3i: same 2x10 grid of 512x102 cells and the
// same cell per banner as 2017 (CChainKills::_SetSpriteKillMessage 0x7b0cf0 of the Cross exe has the 2017 table), new art. Its kill_message1.i3i,
// kill_mark_HistoryBG.i3i and the MV_Ann_* voices are byte-identical to 2017, so only this sheet is exported. Skipped when the Cross client is absent.
const PACK_CROSS = clientPath('cross', 'Pack');
for (const [pack, name, out, dir = 'Gui/Ingame', alphaBoxToo = false, root = PACK] of [
  ...[1, 2, 3].map((n) => ['Locale_Thailand_GUI', `kill_message_0${n}.i3i`, `kill_message_th0${n}.png`, 'Gui/Ingame', false, PACK_TH]),
  ['UI_Ingame', 'kill_message.i3i', 'kill_message_cross.png', 'Gui/Ingame', false, PACK_CROSS],
  ['UI_Ingame-Hud', 'Hud.i3i', 'Hud.png'],
  ['UI_Ingame-Hud', 'Hud.i3i', 'Hud_br.png', 'Gui/Ingame', false, PACK_BR],
  ['UI_Ingame', 'kill_message.i3i', 'kill_message.png'],
  ['UI_Ingame', 'kill_message1.i3i', 'kill_message1.png'],
  ['UI_Ingame', 'kill_mark_HistoryBG.i3i', 'kill_mark_HistoryBG.png'],
  ['UI_Ingame', 'blood.i3i', 'blood.png', 'Gui/Ingame', true],
  ['UI_Interface', 'help_observer.i3i', 'help_observer.png', 'Gui/Interface'],
]) {
  const file = path.join(root, `${pack}.i3Pack`);
  if ((root === PACK_TH || root === PACK_CROSS) && !fs.existsSync(file)) { console.log(`hud ${out}: no ${root === PACK_TH ? 'Portable' : 'Cross'} client, skipped`); continue; }
  const f = unpackTo(file).find((p) => p.name.toLowerCase() === name.toLowerCase());
  const img = decodeI3i(f);
  fs.writeFileSync(path.join(OUT, out), encodePNG(img.rgba, img.w, img.h, true));
  index.textures[out] = { status: 'original', w: img.w, h: img.h, src: `${rel(file)}:${dir}/${name}`, format: img.format };
  // the sheet is padded: blood.i3i is 512x1024 but its last 256 rows are fully transparent
  if (alphaBoxToo) index.textures[out].content = alphaBox(img);
  console.log(`hud ${out} ${img.w}x${img.h}${alphaBoxToo ? ` content ${JSON.stringify(alphaBox(img))}` : ''}`);
}

// ---- fonts the HUD text nodes name: CChainKills::Create 0x7b9e90 makes its kill-star numbers with i3TextNodeDX2 font "Gunplay"
// (Font/Gunplay.ttf of the 2017 client), registered by src/lobby/ui/assets.ts as "PB Gunplay".
{
  const src = path.join(PACK, '..', 'Font', 'Gunplay.ttf');
  fs.mkdirSync(path.join(OUT, '..', 'fonts'), { recursive: true });
  fs.copyFileSync(src, path.join(OUT, '..', 'fonts', 'Gunplay.ttf'));
  console.log('font Gunplay.ttf');
}

// ---- kill feed weapon icons: Gui/WeaponShape/Weapon_Kill{page}.i3i (UI_WeaponShape.i3Pack), CHud 0x7b0ac0:
// ord = CEquipShapeManager::_GetWeaponOrdIdx(class, number) (0x7b24f0), page = ord / 88, cell = ord % 88,
// UV = ((cell % 8) * 127, (cell / 8) * 39), 127 x 39. ord = the weapon's _UIShapeIndex in Weapon.pef
// (checked on the sheet: M-7 42 = knife, K-400 46 = grenade, P90_Ext 32 = P90). Key = classType * 1000 + number,
// i.e. the item id without its slot digit (103004 -> 3004).
{
  const files = unpackTo(path.join(PACK, 'UI_WeaponShape.i3Pack')).filter((p) => /^weapon_kill\d+\.i3i$/i.test(p.name));
  fs.mkdirSync(path.join(OUT, 'kill'), { recursive: true });
  const pages = [];
  for (const p of files) {
    const n = Number(/(\d+)/.exec(p.name)[1]);
    const img = decodeI3i(p);
    fs.writeFileSync(path.join(OUT, 'kill', `Weapon_Kill${n}.png`), encodePNG(img.rgba, img.w, img.h, true));
    pages[n] = `kill/Weapon_Kill${n}.png`;
  }
  const pef = JSON.parse(fs.readFileSync(extractedPath('pef2017', 'br', 'Weapon.json'), 'utf8'));
  const ord = {};
  const walk = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') { if ('_UIShapeIndex' in v && '_ClassType' in v) ord[v._ClassType * 1000 + v._Number] = v._UIShapeIndex; else walk(v); } };
  walk(pef.WeaponList.Weapon);
  index.killIcons = { status: 'original', src: 'Clients/PBKaybo/GameData/Apps/PB/Pack/UI_WeaponShape.i3Pack:Gui/WeaponShape/Weapon_Kill*.i3i + Weapon.pef _UIShapeIndex',
    cell: { w: 127, h: 39, cols: 8, perPage: 88 }, pages, ord };
  console.log(`kill icons: ${files.length} pages, ${Object.keys(ord).length} weapons`);
}

// ---- minimaps
const maps = JSON.parse(fs.readFileSync(assetPath('maps', 'index.json'), 'utf8'));
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const check = process.argv.includes('--check');
if (prev && only.length) index.minimaps = prev.minimaps ?? {};
for (const m of maps) {
  if (only.length && !only.includes(m.id)) continue;
  const pack = path.join(PACK, `${m.pack}_SubData.i3Pack`);
  if (!fs.existsSync(pack)) { index.minimaps[m.id] = { status: 'missing', note: `no ${m.pack}_SubData.i3Pack in the 2017 client` }; console.log(`map ${m.id}: no SubData`); continue; }
  let files;
  try { files = unpackTo(pack); } catch (e) { index.minimaps[m.id] = { status: 'missing', note: e.message }; continue; }
  const low = (p) => p.name.toLowerCase();
  const mini = files.find((p) => /^mini_.*\.i3i$/.test(low(p)) && !/_text\.i3i$/.test(low(p)));
  const text = files.find((p) => /^mini_.*_text\.i3i$/.test(low(p)));
  const info = files.find((p) => /^minfo_.*\.txt$/.test(low(p)));
  if (!mini || !info) { index.minimaps[m.id] = { status: 'missing', note: 'SubData has no mini_*.i3i / minfo_*.txt' }; console.log(`map ${m.id}: no minimap`); continue; }
  const img = decodeI3i(mini);
  const ini = parseIni(info.buf.toString('latin1'));
  fs.writeFileSync(path.join(OUT, 'minimap', `${m.id}.png`), encodePNG(img.rgba, img.w, img.h, true));
  const rec = {
    status: 'original', png: `minimap/${m.id}.png`, w: img.w, h: img.h,
    realMapScale: ini.RealMapScale, realBakedSize: ini.RealBakedSize, centerX: ini.CenterX, centerY: ini.CenterY,
    src: `${rel(pack)}:${mini.name} + ${info.name}`,
    content: alphaBox(img),
  };
  if (text) {
    const t = decodeI3i(text);
    fs.writeFileSync(path.join(OUT, 'minimap', `${m.id}_text.png`), encodePNG(t.rgba, t.w, t.h, true));
    rec.text = `minimap/${m.id}_text.png`;
  }
  index.minimaps[m.id] = rec;
  console.log(`map ${m.id}: ${img.w}x${img.h} scale ${ini.RealMapScale} baked ${ini.RealBakedSize} centre ${ini.CenterX},${ini.CenterY}`);
  if (check) checkOverlay(m.id, img, rec);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));

/** Bounding box of the non-transparent pixels (the Tab board fits this part of the image). */
function alphaBox(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.rgba[(y * img.w + x) * 4 + 3] > 8) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w: img.w, h: img.h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Scratch PNG: up-facing collision triangles (cyan) + respawns (red/blue) projected with the minimap transform. */
function checkOverlay(id, img, rec) {
  const col = JSON.parse(fs.readFileSync(assetPath('maps', id, 'collision.json'), 'utf8'));
  const k = rec.realBakedSize / rec.realMapScale;
  const out = Buffer.from(img.rgba);
  const put = (x, y, c) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    const i = (y * img.w + x) * 4;
    for (let j = 0; j < 3; j++) out[i + j] = (out[i + j] + c[j]) >> 1;
    out[i + 3] = 255;
  };
  const uv = (x, z) => [rec.centerX - x * k, rec.centerY - z * k];
  try {
    const g = readGLB(assetPath('maps', id, 'collision.glb'));
    for (const mesh of g.J.meshes ?? []) for (const p of mesh.primitives) {
      const pos = g.read(p.attributes.POSITION);
      for (let i = 0; i < pos.length; i += 3) { const [u, v] = uv(pos[i], pos[i + 2]); put(u, v, [0, 255, 255]); }
    }
  } catch (e) { console.log(`  no collision.glb: ${e.message}`); }
  for (const r of col.respawns ?? []) {
    const [u, v] = uv(r.pos[0], r.pos[2]);
    const c = r.team === 'blue' ? [0, 0, 255] : [255, 0, 0];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) put(u + dx, v + dy, c);
  }
  const b = col.bounds;
  for (const [x, z] of [[b.min[0], b.min[2]], [b.max[0], b.min[2]], [b.max[0], b.max[2]], [b.min[0], b.max[2]]]) {
    const [u, v] = uv(x, z);
    for (let d = -6; d <= 6; d++) { put(u + d, v, [0, 255, 0]); put(u, v + d, [0, 255, 0]); }
  }
  const f = path.join(os.tmpdir(), `pbhud-check-${id}.png`);
  fs.writeFileSync(f, encodePNG(out, img.w, img.h, true));
  console.log(`  check -> ${f}`);
}
