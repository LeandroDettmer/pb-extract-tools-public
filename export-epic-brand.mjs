#!/usr/bin/env node
// Branding images from the EpicBlackout client (login, loading and app icon).
//   pbx ui epic-brand
// Gui/Loading/FirstLoading.i3i (1024x1024 DXT5, art in the top 1024x768) ->
//   epic-brand/loading-bg.png    login / loading background (1024x768)
//   epic-brand/icon.png          136x136 PB flame emblem (favicon / app icon)
//   epic-brand/logo-loading.png  the project logo, cropped from the top-left corner (opaque, dark bg)
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readI3IB, decodeI3IB, encodePNG } from './i3r2/skin-glb.mjs';

const SRC = clientPath(baseClient('blackout'), 'Gui', 'Loading', 'FirstLoading.i3i');
const OUT = assetPath('epic-brand');
const LOGO = { x: 20, y: 8, w: 215, h: 168 };

const d = fs.readFileSync(SRC);
const t = readI3IB(d, d.indexOf('I3IB'));
const rgba = Buffer.from(decodeI3IB(d, t));
fs.mkdirSync(OUT, { recursive: true });
const H = 768;
fs.writeFileSync(path.join(OUT, 'loading-bg.png'), encodePNG(rgba.subarray(0, t.w * H * 4), t.w, H));
const logo = Buffer.alloc(LOGO.w * LOGO.h * 4);
for (let y = 0; y < LOGO.h; y++) rgba.copy(logo, y * LOGO.w * 4, ((LOGO.y + y) * t.w + LOGO.x) * 4, ((LOGO.y + y) * t.w + LOGO.x + LOGO.w) * 4);
fs.writeFileSync(path.join(OUT, 'logo-loading.png'), encodePNG(logo, LOGO.w, LOGO.h));
// app icon: the PB flame emblem, square crop of the logo
const ICON = { x: 38, y: 0, s: 136 };
const icon = Buffer.alloc(ICON.s * ICON.s * 4);
for (let y = 0; y < ICON.s; y++) logo.copy(icon, y * ICON.s * 4, (y * LOGO.w + ICON.x) * 4, (y * LOGO.w + ICON.x + ICON.s) * 4);
fs.writeFileSync(path.join(OUT, 'icon.png'), encodePNG(icon, ICON.s, ICON.s));
console.log('ok', OUT);
