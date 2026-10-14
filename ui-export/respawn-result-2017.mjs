#!/usr/bin/env node
// Respawn_Result.gui of the 2017 client (Clients/PBKaybo/GameData/Apps/PB/Pack/UI_Project_HUD.i3Pack) -> the i3Gui tree
// + the atlases it binds, for src/game/pbHud. Same node format as tools/export-classic-ui.mjs (--client cross).
//
//   node ui-export/respawn-result-2017.mjs
//
// Writes out/ui/hud/respawn/:
//   respawn_result.json   { format, source, atlas: { name: "atlas/<name>.png" }, root }
//                         root = the Window 1024x768 of Respawn_Result.gui (Respawn_BG, Result_BG, Result_Training_BG,
//                         Esc_PopupBG). Result_BG holds the match-result rows RedSlot_* / BlueSlot_* 1..8 (ClanMark_N 25x25
//                         at (1,1), Beginer_N, Rank_N, ID_N, Kill_N, Death_N, Exp_N, Score_N, Mission_N, Pino_N, Item_N,
//                         Event_N, PC_Room_N, ESport_N, Challenge_N).
//   atlas/<name>.png      RGBA atlases of the textures the .gui references (Gui/Ingame/RESULT.I3I -> "ingame_result").
//
// Texts are not in the file: the exe assigns them per control at run time (see docs/I3GUI.md).
import { assetPath, clientPath, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGuiSets } from '../i3gui/i3gui.mjs';
import { parsePack, carveNamed, decodeContent } from '../i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from '../i3r2/skin-glb.mjs';

const PACKS = clientPath(baseClient('kaybo'), 'Pack');
const OUT = assetPath('ui', 'hud', 'respawn');
const PACK = 'UI_Project_HUD.i3Pack';
const GUI = 'Respawn_Result.gui';

/** Files of a pack in memory: { path, name, buf } (PFN2 by name; "OLD" nodes carved, name from the old index). */
function packFiles(file) {
  const d = fs.readFileSync(file), out = [];
  for (const n of parsePack(d).nodes) {
    if (!n.fileCount) continue;
    const files = n.indexOk ? n.files : carveNamed(d, n);
    for (const f of files) {
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      out.push({ path: n.path, name: f.name, buf });
    }
  }
  return out;
}

// Gui texture path -> key ("gui/ingame/result.i3i"), lower case, '\' and 'D:/...' prefixes dropped.
const key = (p) => { const s = p.replace(/\\/g, '/').toLowerCase(), i = s.search(/(^|\/)gui\//); return i < 0 ? s : s.slice(s[i] === '/' ? i + 1 : i); };
const atlasName = (k) => k.replace(/^gui\//, '').replace(/\.i3i$/, '').replace(/[/ ]/g, '_');

// Only the UI packs that can hold a Gui/ texture (Weapon/Item skipped, as in export-classic-ui.mjs).
const lib = new Map();
for (const f of fs.readdirSync(PACKS).filter((f) => /^UI_.*\.i3Pack$/i.test(f) && !/^UI_(Weapon|Item)/i.test(f))) {
  for (const e of packFiles(path.join(PACKS, f))) if (/\.i3i$/i.test(e.name)) lib.set(key(`${e.path}/${e.name}`), e.buf);
}

// readGuiSets order = the .gui order of the pack (UI_Project_HUD: Respawn_Result, BOSS_Result, BOSS_Score, BOSS_Start).
const gui = readGuiSets(fs.readFileSync(path.join(PACKS, PACK)))[0];
if (!gui || gui.roots.length !== 1 || gui.nodes.size !== 447) throw new Error(`${GUI} not at set 0 of ${PACK}`);

const atlas = {}, missing = new Set(), atlasKey = {};
const tex = (t) => {
  const ext = gui.textures[t];
  if (!ext) return t;
  const k = key(ext), name = atlasName(k);
  if (!lib.has(k)) { missing.add(ext); return name; }
  atlas[name] = `atlas/${name}.png`;
  atlasKey[name] = k;
  return name;
};
const ser = (n) => ({
  name: n.name, cls: n.cls, x: n.x, y: n.y, w: n.w, h: n.h,
  ...(n.tpl ? { tpl: n.tpl.name, images: n.tpl.images.map((i) => {
    const flip = (i.fx ? 1 : 0) | (i.fy ? 2 : 0);
    return [tex(i.tex), i.dx, i.dy, i.u, i.v, i.sw, i.sh, i.dw, i.dh, ...(flip ? [flip] : [])];
  }) } : {}),
  ...(n.children.length ? { children: n.children.map(ser) } : {}),
});

const root = ser(gui.roots[0]); // fills `atlas` through tex()
fs.mkdirSync(path.join(OUT, 'atlas'), { recursive: true });
for (const name of Object.keys(atlas)) {
  const buf = lib.get(atlasKey[name]);
  const t = readI3IB(buf, buf.indexOf('I3IB'));
  fs.writeFileSync(path.join(OUT, atlas[name]), encodePNG(Buffer.from(decodeI3IB(buf, t)), t.w, t.h, true));
  console.log('atlas', name, t.w, t.h);
}
fs.writeFileSync(path.join(OUT, 'respawn_result.json'), JSON.stringify({ format: 'pb-classic-gui/1', source: `PBKaybo Pack/${PACK} ${GUI}`, atlas, root }));
console.log('respawn_result.json', gui.nodes.size, 'controls', missing.size ? `missing: ${[...missing].join(', ')}` : 'no missing textures');
