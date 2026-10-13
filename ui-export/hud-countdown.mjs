#!/usr/bin/env node
// Round start countdown digits (CHUD_CountDown) from the 3.1 client: Gui/Ingame/count_110.i3i.
//
//   node ui-export/hud-countdown.mjs
//
// The 2017 (Kaybo) and later clients dropped this HUD; `Clients/Point-Blank-Portable/3-PointBlank/PointBlank.exe` still has
// CHUD_CountDown::CreateHUD 0x77d5b0 (see src/game/pbHud/countdown.ts for the decoded behaviour). Its UI_Ingame.i3Pack is an
// old pack the pack parser cannot index (magic "AVIX"), but the textures inside are plain: the I3IB block that carries the
// source path "...\count_110.tga" is a 512 x 512 uncompressed 32-bit image (format 0x20000106, B G R A, 1 MiB right after the
// header: the next I3IB starts 1 048 576 bytes later). Cells: 110 x 110, "1" at x 0, "2" at x 110, "3" at x 220.
//
// Writes out/ui/hud/count_110.png and adds it to hud/index.json "textures".
import { assetPath, clientPath, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readI3IB, encodePNG } from '../i3r2/skin-glb.mjs';

const PACK = clientPath(baseClient('portable'), 'Pack', 'UI_Ingame.i3Pack');
const OUT = assetPath('ui', 'hud');

const d = fs.readFileSync(PACK);
const at = d.indexOf('count_110.tga');
if (at < 0) throw new Error('count_110.tga not found in ' + PACK);
const head = d.lastIndexOf('I3IB', at);
const t = readI3IB(d, head);
if (!t || t.w !== 512 || t.h !== 512 || !/count_110\.tga$/i.test(t.srcPath)) throw new Error('unexpected I3IB header ' + JSON.stringify(t));
const raw = d.subarray(t.data, t.data + 512 * 512 * 4);
const rgba = Buffer.alloc(raw.length);
for (let i = 0; i < raw.length; i += 4) { rgba[i] = raw[i + 2]; rgba[i + 1] = raw[i + 1]; rgba[i + 2] = raw[i]; rgba[i + 3] = raw[i + 3]; }
fs.writeFileSync(path.join(OUT, 'count_110.png'), encodePNG(rgba, 512, 512, true));

const idxFile = path.join(OUT, 'index.json');
const index = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
index.textures['count_110.png'] = {
  status: 'original', w: 512, h: 512, src: 'Clients/Point-Blank-Portable/3-PointBlank/Pack/UI_Ingame.i3Pack:Gui/Ingame/count_110.i3i',
  format: 'bgra32', cell: { w: 110, h: 110, digits: ['1', '2', '3'] },
};
fs.writeFileSync(idxFile, JSON.stringify(index, null, 1));
console.log('hud count_110.png 512x512 (digits 1 2 3, 110 px cells)');
