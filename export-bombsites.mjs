#!/usr/bin/env node
// Bomb Mission sites (A / B) of every stage, from the PBCross client's own Stage config (Cross only, no 2017 fallback).
//
//   node web-poc/tools/export-bombsites.mjs   # -> public/assets/cross/maps/bombsites.json
//
// Source: extracted/pef-cross/br/Stage.json (Config "Stage" > <StageName> > BombPosition_A / BombPosition_B / BombFloorOnMiniMap_A/B),
// read by CStageBattle::LoadProperties 0x764080 into the stage (+0xbc / +0xcc positions, +0xc8 / +0xd8 floors), copied to the mission
// manager by CStageBattle::OnCreate (getBombPosition 0x765fe0).
// The area test (CGameMissionManager 0x585470, local chara only): d = chara pos - site; in the area when d.d < 4.0 (squared length,
// 4bba60 has no sqrt => 3D distance < 2 m) AND |d.y| < 0.2. A site at (0,0,0) is "not present" (0x76b570 tests all three components
// against 0): the stage has no such area. (The reference server's MapStructure.xml has the same positions and its own "EveryWhere" rule.)
// Each site is checked against the exported collision floor: `floorDy` = site Y - the closest upward-facing floor at its XZ.
import { assetPath, extractedPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

const STAGE_CROSS = extractedPath('pef-cross', 'br', 'Stage.json'); // tools/pef/export-cross.mjs
const MAPS = assetPath('maps');
const OUT_DIR = assetPath('cross', 'maps');
// Biolab and OldDock: Cross BombPosition_A is the same point for both (-14.4126, 7.4243, 34.4615), a copied value, so they
// have no bomb mode (absent from bombsites.json; game.ts initBomb reads only this file, no server fallback) [INFERIDO]
const NO_BOMB_MODE = ['Biolab', 'OldDock'];
const stages = JSON.parse(fs.readFileSync(STAGE_CROSS, 'utf8')).Stage;
for (const k of NO_BOMB_MODE) delete stages[k];
const index = JSON.parse(fs.readFileSync(path.join(MAPS, 'index.json'), 'utf8'));

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const byName = new Map();
// folder id first (a_blowcity has no mapId: the stage "Blowcity" is the folder "blowcity"), then names; entries with a mapId win ties
for (const pass of [(e) => [e.id], (e) => [e.name, e.nameEn, e.pack?.replace(/\.i3Pack$/i, '')]]) {
  for (const e of [...index].sort((a, b) => Number(b.mapId != null) - Number(a.mapId != null))) {
    if (e.id.endsWith('_2017')) continue;
    for (const k of pass(e)) if (k && !byName.has(norm(k))) byName.set(norm(k), e);
  }
}

/** collision.glb -> triangles (upward-facing only) */
function floorTris(dir) {
  const f = path.join(MAPS, dir, 'collision.glb');
  if (!fs.existsSync(f)) return null;
  const b = fs.readFileSync(f);
  const jl = b.readUInt32LE(12), j = JSON.parse(b.toString('utf8', 20, 20 + jl));
  const bin = b.subarray(20 + jl + 8);
  const tris = [];
  const view = (acc) => { const bv = j.bufferViews[acc.bufferView]; return bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0); };
  for (const m of j.meshes) for (const p of m.primitives) {
    const pa = j.accessors[p.attributes.POSITION], po = view(pa);
    const pos = new Float32Array(bin.buffer.slice(po, po + pa.count * 12));
    const ia = j.accessors[p.indices], io = view(ia);
    const idx = ia.componentType === 5125 ? new Uint32Array(bin.buffer.slice(io, io + ia.count * 4)) : new Uint16Array(bin.buffer.slice(io, io + ia.count * 2));
    for (let i = 0; i < idx.length; i += 3) {
      const t = [0, 1, 2].map((k) => [pos[idx[i + k] * 3], pos[idx[i + k] * 3 + 1], pos[idx[i + k] * 3 + 2]]);
      const [a, c, d] = t;
      const ny = (c[2] - a[2]) * (d[0] - a[0]) - (c[0] - a[0]) * (d[2] - a[2]);
      if (ny > 0) tris.push(t);
    }
  }
  return tris;
}
function floorsAt(tris, x, z) {
  const out = [];
  for (const [a, c, d] of tris) {
    const den = (c[2] - d[2]) * (a[0] - d[0]) + (d[0] - c[0]) * (a[2] - d[2]);
    if (Math.abs(den) < 1e-9) continue;
    const l1 = ((c[2] - d[2]) * (x - d[0]) + (d[0] - c[0]) * (z - d[2])) / den;
    const l2 = ((d[2] - a[2]) * (x - d[0]) + (a[0] - d[0]) * (z - d[2])) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    out.push(l1 * a[1] + l2 * c[1] + l3 * d[1]);
  }
  return out;
}

const out = { source: 'extracted/pef-cross/br/Stage.json (Config Stage; PointBlank.exe 2017 CStageBattle::LoadProperties 0x764080 is the RE of the fields)', rule: { dist: 2, dy: 0.2 }, maps: {} };
const unmatched = [];
let withBombs = 0;
for (const [stage, v] of Object.entries(stages)) {
  const A = v.BombPosition_A, B = v.BombPosition_B;
  if (!A && !B) continue;
  const present = (p) => Array.isArray(p) && !(p[0] === 0 && p[1] === 0 && p[2] === 0);
  const sites = [A, B].map((p, i) => (present(p) ? { area: i, pos: p, floor: v[`BombFloorOnMiniMap_${'AB'[i]}`] ?? 0 } : null));
  if (!sites.some(Boolean)) continue;
  const e = byName.get(norm(stage));
  if (!e) { unmatched.push(stage); continue; }
  withBombs++;
  const tris = floorTris(e.id);
  const entry = { stage, mapId: e.mapId, sites: [] };
  for (const s of sites) {
    if (!s) { entry.sites.push(null); continue; }
    let floorDy = null;
    if (tris) {
      const fl = floorsAt(tris, s.pos[0], s.pos[2]);
      if (fl.length) floorDy = +fl.map((y) => s.pos[1] - y).sort((a, b) => Math.abs(a) - Math.abs(b))[0].toFixed(3);
    }
    entry.sites.push({ ...s, floorDy });
  }
  out.maps[e.id] = entry;
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'bombsites.json'), JSON.stringify(out, null, 1));
const bad = Object.values(out.maps).flatMap((m) => m.sites.map((s, i) => (s && (s.floorDy === null || Math.abs(s.floorDy) >= 0.2) ? `${m.stage} ${'AB'[i]} floorDy=${s.floorDy}` : null)).filter(Boolean));
console.log(`stages with bomb sites: ${withBombs} (of ${Object.keys(stages).length}); unmatched to a map folder: ${unmatched.join(', ') || '-'}`);
console.log(`sites off the |dy| < 0.2 floor rule / no floor found: ${bad.length ? '\n  ' + bad.join('\n  ') : 0}`);
