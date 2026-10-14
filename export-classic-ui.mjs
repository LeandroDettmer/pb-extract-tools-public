#!/usr/bin/env node
// Classic (i3Gui) UI -> out/ui/<classic|cross>/ (docs/I3GUI.md).
//   node export-classic-ui.mjs                 # EpicBlackout: the Option window -> ui/classic/option.json
//   node export-classic-ui.mjs --client cross  # PB Cross V-37: every window of the 10 UI_Project_* packs
//
// EpicBlackout: Pack/UI_Project_Popup.i3Pack carries two i3GuiRoot blobs: the generic popups and, second, the Option
// window (opOptionWin: tabs Jogar/Vídeo/Interface/Áudio/Controle/...). The tree is written as JSON (x/y relative to the
// parent, tpl.images = the state sprites as [texture, dx, dy, u, v, srcW, srcH, dstW, dstH, flip?]: flip 1 X | 2 Y, only
// when set); the two atlases are
// Gui/Main/UI_Source01.i3i (= UI_Main-SourceA node file 0) and UI_Source02.i3i (= UI_Main-SourceA file 1: the EpicBlackout
// packs are "OLD" nodes without names, the order is the one Cross keeps by name, A = 01/02/03, B = 04/05/05_New/06).
//
// Cross: one <pack>.json per UI_Project_*.i3Pack, same node format; `root` is a synthetic { cls: "Root" } whose children
// are the i3GuiRoot window of each .gui file in the pack (`file`, `version` added). Images name their atlas by path
// (Gui/Main/UI_Source01.i3i -> "main_ui_source01", PNG in atlas/, map in `atlas`). Texts: String.i3Pack
// String_Brazil.txt -> strings.json { STBL_IDX_*: text } ("\n" escapes turned into new lines).
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGuiSets } from './i3gui/i3gui.mjs';
import { parsePack, carveNamed, decodeContent } from './i3pack/unpack.mjs';
import { readI3IB, decodeI3IB, encodePNG } from './i3r2/skin-glb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ci = process.argv.indexOf('--client');
const client = ci >= 0 ? process.argv[ci + 1] : 'epic';

/** Files of a pack in memory: { path, name, offset, buf } (PFN2 by name; "OLD" nodes carved, name from the old index). */
function packFiles(file) {
  const d = fs.readFileSync(file), out = [];
  for (const n of parsePack(d).nodes) {
    if (!n.fileCount) continue;
    const files = n.indexOk ? n.files : carveNamed(d, n);
    for (const f of files) {
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      out.push({ path: n.path, name: f.name, offset: f.offset, buf });
    }
  }
  return { data: d, files: out };
}

function writeAtlas(buf, file, withAlpha) {
  const t = readI3IB(buf, buf.indexOf('I3IB'));
  fs.writeFileSync(file, encodePNG(Buffer.from(decodeI3IB(buf, t)), t.w, t.h, withAlpha));
  return t;
}

// Text attributes: the .gui files carry none (i3GuiDx OnLoad reads only layout / events / shape), the exe sets them per
// control. tools/data/cross-ui-text.json (tools/re/cross-text-attrs.py, Cross exe) -> `txt` on the node by name
// ("%d" / "%s" families as patterns). The EpicBlackout Option window reuses the Cross table (same control names) [INFERIDO].
const TEXT = JSON.parse(fs.readFileSync(path.join(HERE, 'data/cross-ui-text.json'), 'utf8'));
const TXT_KEYS = ['align', 'color', 'font', 'offset', 'space', 'wrap', 'caption', 'shadow'];
const pick = (v) => Object.fromEntries(TXT_KEYS.filter((k) => k in v).map((k) => [k, v[k]]));
const TXT_RULES = Object.entries(TEXT).filter(([k]) => k.includes('%'))
  .map(([k, v]) => [new RegExp(`^${k.replace(/%s/g, '\\w+?').replace(/%d/g, '\\d+')}$`), pick(v)]);
const txtOf = (name) => (name !== '_meta' && TEXT[name] ? pick(TEXT[name]) : TXT_RULES.find(([re]) => re.test(name))?.[1]);

// i3GuiStatic::SetShapeFlip(shape, flipX, flipY) the exe calls per control, image index -> 1 X | 2 Y. Cross exe 0x7d1810
// (its only 6 calls): this+0xe0 = rrRed, +0xe4 = rrBlue (bound at 0x7c59c8 / 0x7c59e7). Each team background is one atlas
// corner (rounded top-left for red, top-right for blue) drawn 2x2, the copies mirrored into one panel. No GIM1 of the Cross
// or EpicBlackout packs sets its own flip words, and the EpicBlackout / 3.123 exes do not import SetShapeFlip.
const SHAPE_FLIP = { rrRed: { 1: 1, 2: 2, 3: 3 }, rrBlue: { 0: 1, 2: 3, 3: 2 } };
const ser = (n, tex) => ({
  name: n.name, cls: n.cls, x: n.x, y: n.y, w: n.w, h: n.h,
  ...(txtOf(n.name) ? { txt: txtOf(n.name) } : {}),
  ...(n.tpl ? { tpl: n.tpl.name, images: n.tpl.images.map((i, k) => {
    const flip = SHAPE_FLIP[n.name]?.[k] ?? (i.fx ? 1 : 0) | (i.fy ? 2 : 0);
    return [tex(i.tex), i.dx, i.dy, i.u, i.v, i.sw, i.sh, i.dw, i.dh, ...(flip ? [flip] : [])];
  }) } : {}),
  ...(n.children.length ? { children: n.children.map((c) => ser(c, tex)) } : {}),
});

function exportEpic() {
  const PACKS = clientPath(baseClient('blackout'), 'Pack');
  const OUT = assetPath('ui', 'classic');
  const TEX = { 3: 'source01', 199: 'source02', 1750: 'grade' };
  fs.mkdirSync(path.join(OUT, 'atlas'), { recursive: true });
  const srcA = packFiles(path.join(PACKS, 'UI_Main-SourceA.i3Pack')).files;
  for (const [name, k] of [['source01', 0], ['source02', 1]]) {
    const t = writeAtlas(srcA[k].buf, path.join(OUT, 'atlas', `${name}.png`));
    console.log(name, t.w, t.h);
  }
  const sets = readGuiSets(fs.readFileSync(path.join(PACKS, 'UI_Project_Popup.i3Pack')));
  const option = sets.find((s) => [...s.nodes.values()].some((n) => n.name === 'opOptionWin'));
  const win = [...option.nodes.values()].find((n) => n.name === 'opOptionWin');
  const root = ser(win, (t) => TEX[t] ?? t);
  fs.writeFileSync(path.join(OUT, 'option.json'), JSON.stringify({ format: 'pb-classic-gui/1', source: 'EpicBlackout UI_Project_Popup.i3Pack (2nd i3GuiRoot)', root }));
  console.log('option.json', option.nodes.size, 'controls');
}

function exportCross() {
  const CLIENT = clientPath('cross');
  const PACKS = path.join(CLIENT, 'Pack');
  const OUT = assetPath('ui', 'cross');
  fs.mkdirSync(path.join(OUT, 'atlas'), { recursive: true });
  // Gui texture path -> key ("gui/main/ui_source01.i3i"); pack paths may carry "D:/PointBlank_Resource/BrazilQA/".
  const key = (p) => { const s = p.replace(/\\/g, '/').toLowerCase(), i = s.search(/(^|\/)gui\//); return i < 0 ? s : s.slice(s[i] === '/' ? i + 1 : i); };
  const atlasName = (k) => k.replace(/^gui\//, '').replace(/\.i3i$/, '').replace(/[/ ]/g, '_');

  const lib = new Map();
  for (const f of fs.readdirSync(PACKS).filter((f) => /^UI_.*\.i3Pack$/i.test(f) && !/^UI_(Weapon|Item)/i.test(f))) {
    for (const e of packFiles(path.join(PACKS, f)).files) if (/\.i3i$/i.test(e.name)) lib.set(key(`${e.path}/${e.name}`), () => e.buf);
  }
  const walkDir = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p);
    else if (/\.i3i$/i.test(e.name)) { const k = key(path.relative(CLIENT, p)); if (!lib.has(k)) lib.set(k, () => fs.readFileSync(p)); }
  });
  walkDir(path.join(CLIENT, 'Gui'));

  const atlases = new Map(), missing = new Set();
  let total = 0, orphans = 0;
  for (const f of fs.readdirSync(PACKS).filter((f) => /^UI_Project.*\.i3Pack$/i.test(f)).sort()) {
    const pack = f.replace(/\.i3Pack$/i, '');
    const files = packFiles(path.join(PACKS, f)).files.sort((a, b) => a.offset - b.offset);
    const sets = readGuiSets(fs.readFileSync(path.join(PACKS, f)));
    const used = {};
    const windows = [];
    for (const s of sets) {
      const tex = (t) => {
        const ext = s.textures[t];
        if (!ext) return t;
        const k = key(ext), name = atlasName(k);
        if (!lib.has(k)) { missing.add(ext); return name; }
        atlases.set(name, k); used[name] = `atlas/${name}.png`;
        return name;
      };
      // One .gui per i3GuiRoot when the counts match (the carved offsets of an "OLD" node are not exact), else by offset
      // (UI_Project.i3Pack: SpecialCharInput.guiNode has no root).
      const owner = files.length === sets.length ? files[sets.indexOf(s)] : files.filter((e) => e.offset <= s.base).at(-1);
      const file = path.posix.basename(owner?.name ?? `set${sets.indexOf(s)}`);
      const extra = s.roots.slice(1);
      orphans += extra.length;
      if (extra.length) console.warn(`  ${pack} ${file}: ${extra.length} orphan(s): ${extra.slice(0, 5).map((n) => n.name).join(', ')}`);
      for (const r of s.roots) windows.push({ ...ser(r, tex), file, version: s.version });
      total += s.nodes.size;
      console.log(`  ${pack} ${file}: ${s.nodes.size} controls`);
    }
    const root = { name: pack, cls: 'Root', x: 0, y: 0, w: 0, h: 0, children: windows };
    fs.writeFileSync(path.join(OUT, `${pack}.json`), JSON.stringify({ format: 'pb-classic-gui/1', source: `PBCross Pack/${f}`, atlas: used, root }));
    console.log(`${pack}.json`, sets.length, 'gui sets');
  }
  // Textures the exe binds in code, not through a .gui: the "Map" group of SetMapShape 0x7a73a0 (Gui/Interface/
  // UI_Source_MapImage%d.i3i from 1 on, loaded at 0x7a5f73), the map pictures of lbImageDummy / rrImageDummy / rrCreateImageDummy
  for (const k of ['gui/interface/ui_source_mapimage1.i3i', 'gui/interface/ui_source_mapimage2.i3i']) if (lib.has(k)) atlases.set(atlasName(k), k);
  for (const [name, k] of atlases) {
    const t = writeAtlas(lib.get(k)(), path.join(OUT, 'atlas', `${name}.png`), true);
    console.log('atlas', name, t.w, t.h);
  }

  const strPack = packFiles(path.join(PACKS, 'String.i3Pack')).files.find((e) => e.name === 'String_Brazil.txt');
  const strings = {};
  for (const line of strPack.buf.toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab > 0) strings[line.slice(0, tab)] = line.slice(tab + 1).replace(/\\n/g, '\n');
  }
  fs.writeFileSync(path.join(OUT, 'strings.json'), JSON.stringify(strings));
  console.log('strings.json', Object.keys(strings).length, 'texts');
  console.log(`total ${total} controls, ${orphans} orphans, ${atlases.size} atlases${missing.size ? `, missing textures: ${[...missing].join(', ')}` : ''}`);
}

if (client === 'cross') exportCross();
else exportEpic();
