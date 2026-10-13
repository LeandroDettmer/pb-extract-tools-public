#!/usr/bin/env node
// Composes a scene into a PNG from the exported JSON + sheet, with the same geometry as the browser
// runtime (src/lobby/ui/geometry.ts, loaded through Node's type stripping). No browser needed.
//
//   node ui-export/ui-compose.mjs v12 PointBlankRe_Lobby_RoomList [out.png] [--outline]
//
// Drawn: template sprites (state 0 = normal), control colour alpha/tint, ListView item rows repeated to
// fill the box. Not drawn: captions (no font rasteriser in Node; the DOM runtime draws them).
// Frames with status "missing" are drawn as a [RECRIADO] placeholder: magenta-tinted translucent box with
// a 1px border, so a missing sprite is never mistaken for original art. --outline adds every control's
// bounds (cyan) for layout checks.

import { webPath } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OUT, decodePNG, encodePNG } from './lib.mjs';
const { frameKey, layoutTemplate, placeControls } = await import(pathToFileURL(webPath('src/lobby/ui/geometry.ts')).href);

export const PLACEHOLDER = [255, 0, 200, 0.28];

function blend(dst, W, H, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 4, ia = 1 - a;
  dst[i] = r * a + dst[i] * ia; dst[i + 1] = g * a + dst[i + 1] * ia; dst[i + 2] = b * a + dst[i + 2] * ia;
  dst[i + 3] = 255;
}
function fillRect(dst, W, H, x0, y0, w, h, c, border) {
  const X0 = Math.round(x0), Y0 = Math.round(y0), X1 = Math.round(x0 + w), Y1 = Math.round(y0 + h);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const edge = x === X0 || y === Y0 || x === X1 - 1 || y === Y1 - 1;
    if (border && edge) blend(dst, W, H, x, y, c[0], c[1], c[2], Math.min(1, c[3] * 3));
    else if (c[3] && !(border === 'only')) blend(dst, W, H, x, y, c[0], c[1], c[2], c[3]);
  }
}
// Nearest-neighbour stretch of a sheet rect into a dest rect (what a scaled sprite looks like, minus filtering).
function drawSprite(dst, W, H, sheet, f, dx, dy, dw, dh, tint) {
  const X0 = Math.round(dx), Y0 = Math.round(dy), X1 = Math.round(dx + dw), Y1 = Math.round(dy + dh);
  if (X1 <= X0 || Y1 <= Y0) return;
  for (let y = Y0; y < Y1; y++) {
    const sy = f.y + Math.min(f.h - 1, Math.floor((y - Y0 + 0.5) * f.h / (Y1 - Y0)));
    for (let x = X0; x < X1; x++) {
      const sx = f.x + Math.min(f.w - 1, Math.floor((x - X0 + 0.5) * f.w / (X1 - X0)));
      const si = (sy * sheet.w + sx) * 4;
      blend(dst, W, H, x, y, sheet.rgba[si] * tint[0], sheet.rgba[si + 1] * tint[1], sheet.rgba[si + 2] * tint[2], sheet.rgba[si + 3] / 255 * tint[3]);
    }
  }
}

export function compose(ver, sceneName, { outline = false, background = [24, 26, 30] } = {}) {
  const scene = JSON.parse(fs.readFileSync(path.join(OUT, 'scenes', ver, `${sceneName}.json`), 'utf8'));
  const sj = JSON.parse(fs.readFileSync(path.join(OUT, 'atlas', ver, `${sceneName}.json`), 'utf8'));
  const sheet = decodePNG(fs.readFileSync(path.join(OUT, 'atlas', ver, sj.png)));
  const W = scene.design.w, H = scene.design.h;
  const dst = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { dst[i * 4] = background[0]; dst[i * 4 + 1] = background[1]; dst[i * 4 + 2] = background[2]; dst[i * 4 + 3] = 255; }
  const stats = { controls: 0, pieces: 0, drawn: 0, missing: 0, empty: 0, noTemplate: 0 };
  const placed = placeControls(scene);
  const alphaOf = new Map();
  for (const p of placed) {
    const parentA = p.c.parent != null ? alphaOf.get(p.c.parent) ?? 1 : 1;
    const tint = p.c.color ? [p.c.color[0], p.c.color[1], p.c.color[2], p.c.color[3] * parentA] : [1, 1, 1, parentA];
    alphaOf.set(p.c.id, tint[3]);
    stats.controls++;
    const tpl = p.c.template ? scene.templates[p.c.template] : null;
    if (!tpl) { stats.noTemplate++; continue; }
    // ListView item: the box repeats the item row down to its own height (runtime behaviour, [RECRIADO])
    let rows = [0];
    if (p.c.cls === 'i3UIListView_Item') {
      const box = scene.controls.find(c => c.id === p.c.parent);
      const n = box ? Math.max(1, Math.floor((box.h - p.c.y) / p.c.h)) : 1;
      rows = Array.from({ length: n }, (_, k) => k * p.c.h);
    }
    for (const oy of rows) for (const pc of layoutTemplate(tpl, p.c.w, p.c.h, 0)) {
      stats.pieces++;
      const f = sj.frames[frameKey(pc.shape)];
      if (!f || f.empty || pc.w <= 0 || pc.h <= 0) { stats.empty++; continue; }
      if (f.status === 'missing' || f.x === undefined) {
        stats.missing++;
        fillRect(dst, W, H, p.ax + pc.x, p.ay + oy + pc.y, pc.w, pc.h, PLACEHOLDER, true);
        continue;
      }
      stats.drawn++;
      drawSprite(dst, W, H, sheet, f, p.ax + pc.x, p.ay + oy + pc.y, pc.w, pc.h, tint);
    }
  }
  if (outline) for (const p of placed) fillRect(dst, W, H, p.ax, p.ay, p.c.w, p.c.h, [0, 255, 255, 0.5], 'only');
  return { png: encodePNG(dst, W, H), W, H, stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const [ver = 'v12', scene = 'PointBlankRe_Lobby_RoomList', out] = args;
  const r = compose(ver, scene, { outline: process.argv.includes('--outline') });
  const file = out || path.join(OUT, 'preview', ver, `${scene}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.png);
  console.log(`${ver}/${scene} ${r.W}x${r.H} -> ${file}`, JSON.stringify(r.stats));
}
