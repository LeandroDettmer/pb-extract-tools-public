#!/usr/bin/env node
// Battle HUD art from the Point Blank Cross client ONLY (Clients/PBCross) -> public/assets/ui/cross-hud/ (docs/CROSS_UI.md).
//   pbx ui cross-hud
//
// No other client is read: the HUD of Cross is code-drawn (CHud / CHUD_* / CBattleHUD_MiniMap in PointBlank.exe), so the
// art is the cell sheets the exe binds, and the element positions come from the exe (hud-layout.json, RE sweep).
//
// Writes:
//   hud/<Name>.png            every Gui/Ingame, Gui/Hud and Gui/Interface sheet of UI_Ingame-Hud, UI_Ingame, UI_Hud,
//                             UI_Interface (help, help_observer, level_icon) and UI_Interface-Map (the map picture of the map mode), decoded
//                             I3IB -> PNG (alpha kept). Name = file name without .i3i (case kept).
//   hud/blood.png             alphaBox recorded in index.json (the padded sheet's alpha stops at row 767, as in 2017)
//   kill/Weapon_Kill<n>.png   UI_WeaponShape.i3Pack Weapon_Kill0..11 (kill feed weapon icons, 127x39 cells, 8 columns)
//   minimap/<Map>.png         tab_mini_<Map>.i3i of <Map>_TabMinimap.i3Pack (+ <Map>_text.png when the pack has a _text sheet)
//   index.json                "pb-cross-hud/1": provenance (pack:path) per file, minimap info (info_<Map>.txt) per map
//
// info_<Map>.txt (Cross keys: CenterX/Y, Width/Height, RatioWidthBaked/RatioHeightBaked, Adjust*, frameWindowWidth/Height,
// totalTexCnt). NOT the 2017 minfo (no RealMapScale / RealBakedSize): the world -> minimap transform must come from the
// Cross exe (CBattleHUD_MiniMap, RE group), not from a value in this file. Airport and Kickpoint have 0 files in the
// Cross packs: reported as missing.
import { assetPath, baseClient, clientPath, pefDir, rel } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from '../i3r2/skin-glb.mjs';

const PACK = clientPath(baseClient('cross'), 'Pack');
const OUT = assetPath('ui', 'cross-hud');
const index = { format: 'pb-cross-hud/1', generated: new Date().toISOString(), tool: 'pb-extract-tools-cross/ui-export/cross-hud.mjs', client: 'PBCross', textures: {}, killIcons: {}, minimaps: {} };

// Sheets: the packs and file names are the Cross ones (checked with the pack listing, docs/CROSS_UI.md).
const SHEET_PACKS = [
  ['UI_Ingame-Hud', /^Gui\/Ingame\/.*\.i3i$/i],
  ['UI_Ingame', /^Gui\/Ingame\/.*\.i3i$/i],
  ['UI_Hud', /^Gui\/Hud\/.*\.i3i$/i],
  ['UI_Interface', /^Gui\/Interface\/(help|help_observer|level_icon)\.i3i$/i],
  ['UI_Interface-Map', /^Gui\/Interface\/UI_Source_MapImage\d\.i3i$|^Gui\/Interface\/UI_Source_MapMode\.i3i$/i],
];

/** I3IB texture of a pack entry -> { rgba, w, h } (throws for an unsupported format: the caller says which file). */
function decodeI3i(file) {
  const d = file.buf;
  const t = readI3IB(d, d.indexOf('I3IB'));
  if (!t || t.kind === 'unsupported') throw new Error(`${file.name}: unsupported I3IB`);
  return { rgba: decodeI3IB(d, t), w: t.w, h: t.h, format: t.kind };
}

/** Entries of a pack in memory ({ path, name, buf }); node paths kept (the Cross packs use relative paths). */
function unpackTo(file) {
  const d = fs.readFileSync(file);
  const out = [];
  for (const n of parsePack(d).nodes) {
    if (!n.indexOk) continue;
    for (const f of n.files) {
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      out.push({ path: n.path, name: f.name, buf });
    }
  }
  return out;
}

/** Bounding box of the non-transparent pixels (alpha > 8). */
function alphaBox(img) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.rgba[(y * img.w + x) * 4 + 3] > 8) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w: img.w, h: img.h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** info_<Map>.txt "[Default]" section -> { key: number | text }, key names kept as the file writes them (trimmed). */
function parseIni(txt) {
  const o = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) o[m[1]] = m[2] === '' || Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  }
  return o;
}

fs.mkdirSync(path.join(OUT, 'hud'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'kill'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'minimap'), { recursive: true });

// ---- HUD sheets
for (const [pack, re] of SHEET_PACKS) {
  const file = path.join(PACK, `${pack}.i3Pack`);
  if (!fs.existsSync(file)) throw new Error(`cross-hud: ${rel(file)} missing`);
  for (const f of unpackTo(file)) {
    const full = `${f.path}/${f.name}`.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
    if (!re.test(full)) continue;
    const name = path.basename(f.name, path.extname(f.name));
    let img;
    try { img = decodeI3i(f); } catch (e) { console.log(`hud ${name}: ${e.message}`); continue; }
    const out = `hud/${name}.png`;
    fs.writeFileSync(path.join(OUT, out), encodePNG(img.rgba, img.w, img.h, true));
    index.textures[out] = { status: 'original', w: img.w, h: img.h, src: `${rel(file)}:${full}`, format: img.format };
    if (/^blood\.i3i$/i.test(f.name)) index.textures[out].content = alphaBox(img);
    console.log(`hud ${out} ${img.w}x${img.h}`);
  }
}

// ---- kill feed weapon icons (CHud 0x7b0ac0 of the Cross exe: same page/cell rule as the 2017 client, checked in
// tools/ui-export/hud-2017.mjs). Pages only; the cell map (ord -> page, cell) is the Cross Weapon.pef _UIShapeIndex.
{
  const file = path.join(PACK, 'UI_WeaponShape.i3Pack');
  const pages = [];
  for (const f of unpackTo(file).filter((p) => /^weapon_kill\d+\.i3i$/i.test(p.name))) {
    const n = Number(/(\d+)/.exec(f.name)[1]);
    const img = decodeI3i(f);
    fs.writeFileSync(path.join(OUT, 'kill', `Weapon_Kill${n}.png`), encodePNG(img.rgba, img.w, img.h, true));
    pages[n] = `kill/Weapon_Kill${n}.png`;
    console.log(`kill Weapon_Kill${n}.png ${img.w}x${img.h}`);
  }
  // ord = the weapon's _UIShapeIndex in the Cross Weapon.pef (CHud::SetKillText 0x741210 -> 0x7a8140 / 0x7a7f20 / 0x7a8240),
  // key = classType * 1000 + number (item id without the slot digit). Dino class 19 (by name) and class 100 (no weapon: fall /
  // other, table 0xd62d10) are not mapped yet.
  const pef = JSON.parse(fs.readFileSync(pefDir('br', 'Weapon.json'), 'utf8'));
  const ord = {};
  const walk = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') { if ('_UIShapeIndex' in v && '_ClassType' in v) ord[v._ClassType * 1000 + v._Number] = v._UIShapeIndex; else walk(v); } };
  walk(pef.WeaponList?.Weapon ?? pef);
  index.killIcons = { status: 'original', src: `${rel(file)}:Gui/WeaponShape/Weapon_Kill*.i3i + Cross Weapon.pef _UIShapeIndex`, cell: { w: 127, h: 39, cols: 8, perPage: 88 }, pages, ord };
  console.log(`kill icons: ${pages.filter(Boolean).length} pages, ${Object.keys(ord).length} weapons`);
}

// ---- minimaps: <Map>_TabMinimap.i3Pack holds tab_mini_<Map>.i3i + info_<Map>.txt (the Cross name; 2017 uses minfo_)
for (const f of fs.readdirSync(PACK).filter((n) => /_TabMinimap\.i3Pack$/i.test(n)).sort()) {
  const map = f.replace(/_TabMinimap\.i3Pack$/i, '');
  const file = path.join(PACK, f);
  const files = unpackTo(file);
  const low = (p) => p.name.toLowerCase();
  const mini = files.find((p) => /^tab_mini_.*\.i3i$/.test(low(p)) && !/_text\.i3i$/.test(low(p)));
  const text = files.find((p) => /^tab_mini_.*_text\.i3i$/.test(low(p)));
  const info = files.find((p) => /^(info|minfo)_.*\.txt$/.test(low(p)));
  if (!mini || !info) { index.minimaps[map] = { status: 'missing', note: `${f} has no tab_mini_*.i3i / info_*.txt` }; console.log(`minimap ${map}: missing`); continue; }
  const img = decodeI3i(mini);
  const ini = parseIni(info.buf.toString('latin1'));
  fs.writeFileSync(path.join(OUT, 'minimap', `${map}.png`), encodePNG(img.rgba, img.w, img.h, true));
  const rec = {
    status: 'original', png: `minimap/${map}.png`, w: img.w, h: img.h,
    info: ini, src: `${rel(file)}:${mini.name} + ${info.name}`, content: alphaBox(img),
  };
  if (text) {
    const t = decodeI3i(text);
    fs.writeFileSync(path.join(OUT, 'minimap', `${map}_text.png`), encodePNG(t.rgba, t.w, t.h, true));
    rec.text = `minimap/${map}_text.png`;
  }
  index.minimaps[map] = rec;
  console.log(`minimap ${map}: ${img.w}x${img.h} centre ${ini.CenterX},${ini.CenterY} ratio ${ini.RatioWidthBaked},${ini.RatioHeightBaked}`);
}

// ---- radar: CBattleHUD_MiniMap::Create 0x6fdc90 of the Cross exe reads World/<map>/Images/minfo_<map>.txt [Default]
// (RealMapScale, RealBakedSize, CenterX, CenterY, AdditionalImgCnt) and mini_<map>.i3i (+ mini_<map>_text.i3i) from
// <Map>_SubData.i3Pack. RealMapScale missing = _CalcMapScale 0x6fe3b0 (max X/Z extent of the world bound box): left null
// here, the client has the level bounds. Extra floors (mini_<map>_%02d, AdditionalImgCnt) are not exported yet.
fs.mkdirSync(path.join(OUT, 'radar'), { recursive: true });
index.radar = {};
for (const f of fs.readdirSync(PACK).filter((n) => /_SubData\.i3Pack$/i.test(n)).sort()) {
  const map = f.replace(/_SubData\.i3Pack$/i, '');
  const file = path.join(PACK, f);
  let files;
  try { files = unpackTo(file); } catch (e) { index.radar[map] = { status: 'missing', note: `${f}: ${e.message}` }; console.log(`radar ${map}: ${e.message}`); continue; }
  const low = (p) => p.name.toLowerCase();
  const minfo = files.find((p) => /^minfo_.*\.txt$/.test(low(p)));
  const mini = files.find((p) => /^mini_.*\.i3i$/.test(low(p)) && !/_text\.i3i$/.test(low(p)) && !/_\d\d\.i3i$/.test(low(p)));
  const text = files.find((p) => /^mini_.*_text\.i3i$/.test(low(p)) && !/_text_\d\d\.i3i$/.test(low(p)));
  if (!minfo || !mini) { index.radar[map] = { status: 'missing', note: `${f} has no minfo_*.txt / mini_*.i3i` }; console.log(`radar ${map}: missing`); continue; }
  const ini = parseIni(minfo.buf.toString('latin1'));
  let img;
  try { img = decodeI3i(mini); } catch (e) { index.radar[map] = { status: 'missing', note: e.message }; console.log(`radar ${map}: ${e.message}`); continue; }
  fs.writeFileSync(path.join(OUT, 'radar', `${map}.png`), encodePNG(img.rgba, img.w, img.h, true));
  const num = (v) => (typeof v === 'number' ? v : null);
  const rec = {
    status: 'original', png: `radar/${map}.png`, w: img.w, h: img.h,
    minfo: { realMapScale: num(ini.RealMapScale), realBakedSize: num(ini.RealBakedSize), centerX: num(ini.CenterX), centerY: num(ini.CenterY), additionalImgCnt: num(ini.AdditionalImgCnt) ?? 0 },
    src: `${rel(file)}:${mini.name} + ${minfo.name}`,
  };
  if (text) {
    try {
      const t = decodeI3i(text);
      fs.writeFileSync(path.join(OUT, 'radar', `${map}_text.png`), encodePNG(t.rgba, t.w, t.h, true));
      rec.text = `radar/${map}_text.png`;
    } catch (e) { console.log(`radar ${map} text: ${e.message}`); }
  }
  index.radar[map] = rec;
  console.log(`radar ${map}: ${img.w}x${img.h} scale ${rec.minfo.realMapScale} baked ${rec.minfo.realBakedSize} centre ${rec.minfo.centerX},${rec.minfo.centerY}`);
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`cross-hud: ${Object.keys(index.textures).length} sheets, ${Object.keys(index.minimaps).length} minimaps, ${Object.values(index.radar).filter((r) => r.status === 'original').length} radar maps -> ${rel(OUT)}`);
