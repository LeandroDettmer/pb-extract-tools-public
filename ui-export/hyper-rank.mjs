#!/usr/bin/env node
// Point Blank Hyper scoreboard patente icon -> out/ui/hyper/{rank.json,level_icon.png}
//
//   node ui-export/hyper-rank.mjs
//
// The Hyper Tab (TapMinimap_new_Thai, UI_V12.i3Pack) fills column 1 of its i3UIListView_Red/Blue with the template
// ButtonImageSet_Level_Icon_hs (Script TapMinimap_new_thai.luab InitList: setTemplateName(1, ...)): 111 shapes of 20x20
// in image/interface/level_icon.tga, drawn 1:1. Template = Clients/Point Blank Hyper/Pack/UI_V11_VTexList_Template.i3Pack,
// texture = Locale/Thai/UI_V11/VTexList/Level_icon.i3VTexImage (cipher flag 1, vtex-crypt.mjs).
// rank.json = { template, sheet } in the pb-ui-scene / pb-ui-sheet shapes `buildSkin` takes; the sheet is the whole
// texture (frame key "level_icon:u,v,w,h" -> same rectangle), no repacking.

import { clientPath, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { OUT, encodePNG, parseTemplateObjects, resolveTemplate, writeJSON } from './lib.mjs';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { decodeVTexImage } from './vtex-crypt.mjs';

const HYPER = clientPath(baseClient('hyper'));
const pack = path.join(HYPER, 'Pack', 'UI_V11_VTexList_Template.i3Pack');
const d = fs.readFileSync(pack);
let tpl = null;
for (const n of parsePack(d).nodes) for (const f of n.files) if (f.name === 'ButtonImageSet_Level_Icon_hs.i3UITemplate') {
  const buf = f.attr ? decodeContent(d.subarray(f.offset, f.offset + f.size), f.attr) : d.subarray(f.offset, f.offset + f.size);
  const { objs, key } = parseTemplateObjects(buf.toString('utf8'));
  tpl = resolveTemplate(objs, key);
}
if (!tpl) throw new Error('template ButtonImageSet_Level_Icon_hs not found');

const file = path.join(HYPER, 'Locale', 'Thai', 'UI_V11', 'VTexList', 'Level_icon.i3VTexImage');
const img = decodeVTexImage(fs.readFileSync(file), { file, name: 'level_icon' });
if (!img) throw new Error('Level_icon decode failed');

const out = path.join(OUT, 'hyper');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'level_icon.png'), encodePNG(img.rgba, img.w, img.h));
const frames = {};
for (const s of tpl.shapes) frames[`${s.img}:${s.u},${s.v},${s.uw},${s.vh}`] = { status: 'original', x: s.u, y: s.v, w: s.uw, h: s.vh };
writeJSON(path.join(out, 'rank.json'), {
  format: 'pb-hyper-rank/1', src: 'Clients/Point Blank Hyper', exact: img.exact, w: 20, h: 20, template: tpl,
  sheet: { format: 'pb-ui-sheet/1', version: 'hyper', sheet: 'level_icon', png: 'level_icon.png', w: img.w, h: img.h, frames },
});
console.log(`hyper rank: ${tpl.shapes.length} shapes, texture ${img.w}x${img.h} exact=${img.exact}`);
