#!/usr/bin/env node
// Batch export of every playable map of PBCross (Clients/PBCross/Pack, the only map client) + maps/index.json.
//
//   node web-poc/tools/export-maps-2017.mjs [Map ...] [--index-only] [--client cross] [--jobs N]
//
// Maps run N at a time (--jobs N, else PB_JOBS, else min(4, cores)): one child process per map (--one <Map>), since
// each map writes only its own folder. Output is the same for any N.
//
// A map is "playable" when both <Map>.i3Pack (render scene) and <Map>_Col.i3Pack exist.
// For each one: export-visual.mjs (visual.glb + tex/ + lightmaps) and export-collision.mjs
// (collision.glb/json + GINS respawns with team) into out/maps/<dir>/, then the
// same checks as `export-visual.mjs --check-only` (GLB validity, collision vs visual bounds,
// respawns inside the visual bounds).
//
// <dir> is the map name lowercased.
// No fallback to other clients: the collision is <Map>_Col.i3Pack (not <Map>_Col_Hero.i3Pack, the hero mode variant).
//
// index.json: one entry per folder in maps/ (source cross):
//   { id, pack, mapId, mapIdSource, name, nameEn, source, tris, bounds, respawns, teams, respawnSource }
// mapId = server room map id (server/binary/Debug/Data/Maps/Matches.xml, MapStructure.xml, or the
// 2017 Stage.pef StageUID when neither lists it). name = PT-BR stage name from the Cross client
// (String.i3Pack -> Stage_Brazil.txt, IIA2-ciphered UTF-16LE: the key is recovered
// from the zero high bytes of the ASCII text, see loadStageNames).

import { assetPath, baseClient, clientPath } from './lib/paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportVisual, checkGLB } from './export-visual.mjs';
import { parsePack } from './i3pack/unpack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const PACK = clientPath(baseClient('cross'), 'Pack');
const MAPS = assetPath('maps');
const DEFAULT_JOBS = Math.min(4, os.availableParallelism());

// pack name -> server room map id. M = Matches.xml, S = MapStructure.xml (comment names),
// U = 2017 Stage.pef StageUID. Matches.xml lists the Dino Escape maps as 53 "Port Akaba",
// 54 "Red Rock", 55 "M. Station"; MapStructure names them BreedingNest / Dino Uptown / D_BreakDown.
// C_Sandstorm is left out: Matches.xml gives Convoy 85 to both "Sand Storm (convoy)" and "Still
// Raid", and Stage.pef has StillRaid StageUID 85.
const MAP_IDS = {
  NPort: [1, 'M'], Construction: [2, 'M'], Library: [3, 'M'], NStation: [4, 'M'], Construction2: [5, 'M'],
  Uptown: [6, 'M'], BurningHall: [7, 'M'], DSquad: [8, 'S'], Crackdown: [9, 'M'], SaintMansion: [10, 'M'],
  EasternRoad: [11, 'M'], Downtown: [12, 'M'], Luxville: [13, 'M'], Blowcity: [14, 'M'], Stormtube: [15, 'M'],
  Breakdown: [17, 'M'], TrainingCamp: [18, 'M'], Sentrybase: [19, 'M'], DesertCamp: [20, 'M'], Kickpoint: [21, 'M'],
  FaceRock: [22, 'M'], SupplyBase: [23, 'M'], SandStorm: [24, 'M'], Shoppingcenter: [25, 'M'], Safari: [26, 'M'],
  DragonAlley: [27, 'M'], MachuPichu: [28, 'M'], TwoTowers: [29, 'M'], GrandBazaar: [32, 'M'], Under23: [33, 'M'],
  TaipeiCityMall: [34, 'M'], Safari2: [35, 'M'], Metro: [36, 'M'], RushHour: [37, 'M'], CargoPort: [38, 'S'],
  WestStation: [41, 'M'], HouseMuseum: [42, 'M'], Outpost: [43, 'M'], Hospital: [44, 'M'], Downtown2: [45, 'M'],
  Cargoship: [46, 'M'], Airport: [47, 'M'], SafeHouse: [48, 'M'], Helispot: [51, 'M'], BlackPanther: [52, 'M'],
  BreedingNest: [53, 'S'], D_Uptown: [54, 'S'], D_Breakdown: [55, 'S'], DinoLab: [56, 'S'], Tutorial: [57, 'M'],
  WaterComplex: [65, 'M'], HotelCamouflage: [66, 'S'], PumpkinHollow: [67, 'M'], BattleShip: [69, 'M'],
  RampartTown: [70, 'S'], Ballistic: [71, 'S'], FalluCity: [76, 'S'], Hindrance: [77, 'S'], Sewerage: [78, 'M'],
  SlumArea: [79, 'U'], New_Library: [80, 'S'], FatalZone: [83, 'U'], MarineWave: [84, 'S'], StillRaid: [85, 'S'],
  BrokenAlley: [88, 'M'], Provence: [91, 'M'], Mihawk: [93, 'S'], Ampera: [95, 'U'], S_TwoTowers: [96, 'M'],
};
const ID_SRC = { M: 'Matches.xml', S: 'MapStructure.xml', U: 'Stage.pef StageUID' };
// Stage_Brazil.txt keys that differ from the pack name
const STAGE_KEY = { Luxville: 'LuxVille', SafeHouse: 'Safehouse', Shoppingcenter: 'ShoppingCenter', Rothenvillage: 'RothenVillage' };

// ---- PT-BR stage names ------------------------------------------------------------------
// PBCross String.i3Pack / Stage_Brazil.txt is plain UTF-16LE (BOM FF FE), not IIA-ciphered.
function loadStageNames() {
  const d = fs.readFileSync(path.join(PACK, 'String.i3Pack'));
  const f = parsePack(d).nodes.flatMap((n) => n.files || []).find((x) => /^Stage_Brazil\.txt$/i.test(x.name));
  if (!f) return {};
  const names = {};
  for (const line of d.subarray(f.offset, f.offset + f.size).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const [key, val] = line.split('\t'), k = (key || '').split('\\');
    if (k[0] === 'Stage' && k[2] === '_Name') names[k[1]] = (val || '').trim();
  }
  return names;
}

// ---- export ---------------------------------------------------------------------------------
const listMaps = () => fs.readdirSync(PACK)
  .filter((f) => /_Col\.i3Pack$/i.test(f)).map((f) => f.replace(/_Col\.i3Pack$/i, ''))
  .filter((m) => fs.existsSync(path.join(PACK, `${m}.i3Pack`))).sort((a, b) => a.localeCompare(b));
const dirOf = (m) => m.toLowerCase();
const COLLISION = path.join(HERE, 'export-collision.mjs');

function exportMap(m) {
  const dir = dirOf(m);
  const { summary: s } = exportVisual(m, { packDir: PACK, outRoot: MAPS, dirName: dir, log: () => {} });
  execFileSync(process.execPath, [COLLISION, m, '--pack-dir', PACK, '--out', MAPS, '--name', dir], { stdio: 'pipe' });
  console.log(`${m} -> ${dir}: tris=${s.tris} textures=${s.textures} lightmapped=${s.lightmapped} keyedSkipped=${s.skipped.keyedGeometries} missingTex=${s.skipped.missingTextures.length}`);
}

// One child process (--one <Map>) per map, `jobs` at a time. Resolves to the count of maps that failed. A child's output is
// printed whole when it ends, so lines of different maps do not mix.
function exportPool(maps, jobs) {
  return new Promise((resolve) => {
    let next = 0, active = 0, bad = 0;
    const pump = () => {
      while (active < jobs && next < maps.length) {
        const child = spawn(process.execPath, [SELF, '--one', maps[next++]], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { err += `${e.message}\n`; });
        child.on('close', (code) => {
          process.stdout.write(out);
          if (err) process.stderr.write(err);
          if (code !== 0) bad++;
          active--;
          pump();
        });
        active++;
      }
      if (active === 0 && next >= maps.length) resolve(bad);
    };
    pump();
  });
}

// ---- checks + index ---------------------------------------------------------------------------
const r2 = (v) => v.map((x) => +x.toFixed(2));
function checkDir(dir) {
  const c = checkGLB(path.join(MAPS, dir, 'visual.glb'));
  const colFile = path.join(MAPS, dir, 'collision.json');
  const col = fs.existsSync(colFile) ? JSON.parse(fs.readFileSync(colFile, 'utf8')) : null;
  const colGlb = path.join(MAPS, dir, 'collision.glb');
  const res = { ok: c.ok, errors: c.errors, tris: c.tris, bounds: { min: r2(c.bounds.min), max: r2(c.bounds.max) }, col };
  if (col?.bounds) {
    res.dMin = r2(c.bounds.min.map((v, k) => v - col.bounds.min[k]));
    res.dMax = r2(c.bounds.max.map((v, k) => v - col.bounds.max[k]));
    res.colInside = res.dMin.every((v) => v <= 1) && res.dMax.every((v) => v >= -1); // collision box within visual box (1 m slack)
  }
  res.collisionGlbOk = fs.existsSync(colGlb) && fs.readFileSync(colGlb).toString('latin1', 0, 4) === 'glTF';
  const sp = (col?.respawns || []).filter((p) => p.pos);
  res.respawns = sp.length;
  res.inside = sp.filter((p) => p.pos.every((v, k) => v >= c.bounds.min[k] - 1 && v <= c.bounds.max[k] + 1)).length;
  res.teams = { red: sp.filter((p) => p.team === 'red').length, blue: sp.filter((p) => p.team === 'blue').length };
  return res;
}

function buildIndex(names) {
  const entries = [];
  for (const dir of fs.readdirSync(MAPS).filter((d) => fs.existsSync(path.join(MAPS, d, 'visual.glb'))).sort()) {
    const vj = JSON.parse(fs.readFileSync(path.join(MAPS, dir, 'visual.json'), 'utf8'));
    const pack = vj.source.replace(/\.i3Pack$/i, '');
    const k = checkDir(dir);
    const idKey = Object.keys(MAP_IDS).find((x) => x.toLowerCase() === pack.toLowerCase());
    const stageKey = STAGE_KEY[pack] || Object.keys(names).find((x) => x.toLowerCase() === pack.toLowerCase()) || pack;
    const sceneFile = path.join(PACK, `${pack}_Scene.i3Pack`);
    let gins = null;
    if (fs.existsSync(sceneFile)) { const d = fs.readFileSync(sceneFile), g = d.indexOf('GINS', 0, 'latin1'); if (g >= 0) gins = d.readUInt32LE(g + 4); }
    entries.push({
      id: dir, pack, mapId: idKey ? MAP_IDS[idKey][0] : null, mapIdSource: idKey ? ID_SRC[MAP_IDS[idKey][1]] : null,
      name: names[stageKey] || pack, nameEn: pack, source: 'cross',
      tris: k.tris, collisionTris: k.col?.tris ?? null, bounds: k.bounds,
      respawns: k.respawns, teams: k.teams,
      respawnSource: k.col?.respawnSource ? 'generated' : k.respawns ? `GINS v${gins}` : null,
      check: { visual: k.ok, collisionGlb: k.collisionGlbOk, respawnsInside: `${k.inside}/${k.respawns}`, collisionInsideVisual: k.colInside ?? null, dMin: k.dMin, dMax: k.dMax },
    });
  }
  return entries;
}

// ---- CLI --------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const ci = args.indexOf('--client'); // Cross is the only map client: any other key is refused
  if (ci >= 0) { if (args[ci + 1] !== 'cross') { console.error('maps: --client must be cross'); process.exit(2); } args.splice(ci, 2); }
  const indexOnly = flag('--index-only');
  const oneMap = opt('--one'); // the child of exportPool: this map only, in this process
  if (oneMap) {
    try { exportMap(oneMap); } catch (e) { console.error(`${oneMap}: ERROR ${e.message.split('\n')[0]}`); process.exitCode = 1; }
  } else {
    const jobs = Number(opt('--jobs') ?? process.env.PB_JOBS ?? DEFAULT_JOBS);
    if (!Number.isInteger(jobs) || jobs < 1) { console.error('maps: --jobs needs a whole number >= 1'); process.exit(2); }
    process.exitCode = await buildMaps(args, indexOnly, jobs);
  }
}

// Exports the maps (all, or the named ones) with `jobs` at a time, then the index and its checks. Resolves to the exit code.
async function buildMaps(args, indexOnly, jobs) {
  const all = listMaps();
  const maps = args.length ? all.filter((m) => args.some((a) => a.toLowerCase() === m.toLowerCase())) : all;
  let bad = 0;
  if (!indexOnly) {
    const t0 = Date.now();
    bad += await exportPool(maps, jobs);
    console.log(`maps: ${maps.length} exported, ${jobs} at a time, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const names = loadStageNames();
  const index = buildIndex(names);
  fs.writeFileSync(path.join(MAPS, 'index.json'), JSON.stringify(index, null, 1));
  for (const e of index) {
    const warn = !e.check.visual || !e.check.collisionGlb || (e.respawns && !e.check.respawnsInside.startsWith(`${e.respawns}/`));
    if (warn) bad++;
    console.log(`${warn ? 'FAIL' : 'ok  '} ${e.id.padEnd(18)} mapId=${String(e.mapId).padEnd(4)} ${e.name.padEnd(22)} tris=${String(e.tris).padEnd(7)} respawns=${e.respawns} (${e.teams.red}r/${e.teams.blue}b, ${e.respawnSource}) inside=${e.check.respawnsInside} colInVis=${e.check.collisionInsideVisual} dMin=${e.check.dMin} dMax=${e.check.dMax}`);
  }
  console.log(`index.json: ${index.length} maps (source cross), ${bad} problem(s)`);
  return bad ? 1 : 0;
}
