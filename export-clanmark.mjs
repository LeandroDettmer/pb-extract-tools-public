#!/usr/bin/env node
// Clan mark atlas exporter (Point Blank Cross, Clients/PBCross). Writes out/ui/clanmark/:
//   frame_{m|s}_{fill|outline}.png      back (fundo) layer, 27 cells in 9x3
//   shape_{m|s}_{fill|outline}_{page}.png  shape (símbolo) layer, 81 cells per page in 9x9 (page 0..2)
//   clanmark.json                       grid, counts, palettes (exe bytes) and the file map
//
//   node export-clanmark.mjs
//
// Sources: Pack/Chara_ClanMarkContents.i3Pack (12 I3IB, 512 medium x6 + 256 small x6, order = OLD node names:
//   Medium_Filled_01..03, Medium_Outline_01..03, Small_Filled_01..03, Small_Outline_01..03)
//   Pack/Chara_ClanMarkFrames.i3Pack (4 I3IB: Medium_Filled_01, Medium_Outline_01, Small_Filled_01, Small_Outline_01).
// Packs are OLD (names only, no offsets): textures are found by the I3IB magic; each one ends where the next starts.
// Textures are BGRA 8-bit raw (format 0x20000406), so size = w*h*4. Grid pitch measured on the pixels (see CLAN.md 7).
// Counts: ConfigEx.pef `CustomClanMarkContentCount` / `CustomClanMarkFrameCount` (i3RegArray, slot 1 = Brazil):
//   content 81 (nations with the 3rd filled page: 181), frame 27. Palettes: exe VA 0xb2cc20 (user, 11 x RGBA),
//   0xb2cc4c (layer 0, shape), 0xb2cc78 (layer 1, back). Values read from PointBlank.exe Cross .rdata (file = VA - 0x401600).
import { assetPath, baseClient, clientPath, rel } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readI3IB, decodeI3IB, encodePNG } from './i3r2/skin-glb.mjs';

const OUT = assetPath('ui', 'clanmark');
const EXE = clientPath(baseClient('cross'), 'PointBlank.exe');

const CONTENT_ORDER = ['Medium_Filled_01', 'Medium_Filled_02', 'Medium_Filled_03', 'Medium_Outline_01', 'Medium_Outline_02', 'Medium_Outline_03',
  'Small_Filled_01', 'Small_Filled_02', 'Small_Filled_03', 'Small_Outline_01', 'Small_Outline_02', 'Small_Outline_03'];
const FRAME_ORDER = ['Medium_Filled_01', 'Medium_Outline_01', 'Small_Filled_01', 'Small_Outline_01'];
// Brazil slot (Nation.nlf line 1) of ConfigEx.pef counts (other nations: content 181 for some, same frame 27)
const COUNTS = { contentCells: 81, frameCells: 27, colors: 10 };
// pitch measured on the alpha of every sheet (column/row runs, 8 steps): 512 sheets = 53 px (start 3 + 53k), 256 sheets = 26 px (start 1 + 26k)
const GRID = { cols: 9, contentRows: 9, frameRows: 3, pitch: { m: 53, s: 26 } };

/** I3IB blocks in file order; each one ends where the next begins */
function texturesOf(file) {
  const d = fs.readFileSync(file), hits = [];
  for (let i = d.indexOf('I3IB'); i >= 0; i = d.indexOf('I3IB', i + 1)) hits.push(i);
  return hits.map((h, k) => {
    const t = readI3IB(d, h, hits[k + 1] ?? d.length);
    if (!t || t.kind !== 'raw' || t.bpp !== 4) throw new Error(`${path.basename(file)} block ${k}: unexpected format ${t?.kind} bpp ${t?.bpp}`);
    return { w: t.w, h: t.h, rgba: Buffer.from(decodeI3IB(d, t)) };
  });
}

/** exe palettes, read from the Cross .rdata (VA - 0x401600 = file offset) */
function palettes() {
  const exe = fs.readFileSync(EXE);
  const off = (va) => va - 0x401600;
  const rgba = (va, n, stride) => Array.from({ length: n }, (_, i) => {
    const o = off(va) + i * stride;
    return [exe[o], exe[o + 1], exe[o + 2], exe[o + 3]];
  });
  return {
    user: rgba(0xb2cc20, 11, 4),     // GetUserColorTable (idx 0..10): swatches of the popup
    shape: rgba(0xb2cc4c, 11, 4),    // GetLayerColorTable(layer 0): tint of the shape layer
    back: rgba(0xb2cc78, 11, 4),     // GetLayerColorTable(layer 1): tint of the back layer
  };
}

fs.mkdirSync(OUT, { recursive: true });
const contents = texturesOf(clientPath(baseClient('cross'), 'Pack', 'Chara_ClanMarkContents.i3Pack'));
const frames = texturesOf(clientPath(baseClient('cross'), 'Pack', 'Chara_ClanMarkFrames.i3Pack'));
if (contents.length !== CONTENT_ORDER.length || frames.length !== FRAME_ORDER.length) {
  throw new Error(`block count: contents ${contents.length}, frames ${frames.length}`);
}
const write = (name, t) => fs.writeFileSync(path.join(OUT, name), encodePNG(t.rgba, t.w, t.h, true));
const files = {};
const frameNames = { m_fill: 0, m_outline: 1, s_fill: 2, s_outline: 3 };
for (const [key, i] of Object.entries(frameNames)) {
  const name = `frame_${key}.png`;
  write(name, frames[i]);
  files[`frame.${key}`] = { file: name, w: frames[i].w, h: frames[i].h, src: FRAME_ORDER[i] };
}
// shape pages: fill pages 0..2 are the 3 filled sets, outline pages keep the same page number
const shapeIdx = { m_fill: [0, 1, 2], m_outline: [3, 4, 5], s_fill: [6, 7, 8], s_outline: [9, 10, 11] };
for (const [key, idxs] of Object.entries(shapeIdx)) {
  idxs.forEach((i, page) => {
    const name = `shape_${key}_${page}.png`;
    write(name, contents[i]);
    files[`shape.${key}.${page}`] = { file: name, w: contents[i].w, h: contents[i].h, src: CONTENT_ORDER[i] };
  });
}

const json = {
  source: 'Clients/PBCross/Pack/Chara_ClanMark{Contents,Frames}.i3Pack + PointBlank.exe (Cross) + ConfigEx.pef (Script.i3Pack)',
  // logo index rule [INFERIDO]: 0 = no image; k >= 1 = cell k-1 of the layer (MakeClanMarkTex asserts 'idx > 0'),
  // page = floor((k-1) / contentCells), cell = (k-1) % contentCells. Colour index 0 = white (no tint).
  counts: { ...COUNTS, shapePages: 3, frameCells: COUNTS.frameCells },
  grid: GRID,
  palettes: palettes(),
  files,
};
fs.writeFileSync(path.join(OUT, 'clanmark.json'), JSON.stringify(json, null, 1) + '\n');
console.log(`clanmark: ${Object.keys(files).length} png + clanmark.json -> ${rel(OUT)}`);
