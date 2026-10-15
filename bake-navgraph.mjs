#!/usr/bin/env node
// Bakes the bots' navigation graph (src/game/navGraph.ts) offline: out/maps/<map>/navgraph.bin.
// The client loads it (NavGraph.load) instead of probing the collision with ~1-2 M raycasts on the main thread at the start
// of every match (outpost 23 s, s_twotowers 136 s in the browser). Same code as the game: the map goes through buildRealLevel
// (static colliders + props + glass panes) and NavGraph.build, with the respawns of loadMapMeta as seeds, so the loaded graph is
// the one the client would have built. Rebake when collision.glb / collision.json / props.json change (a stale file is
// rejected by bounds / respawn hash and the client builds live).
//
//   node bake-navgraph.mjs <map ...>      bake the listed maps
//   node bake-navgraph.mjs --all [--jobs N] [--force]   every map the game offers (one process per map; N = --jobs, else PB_JOBS, else min(4, cores))
import { webPath } from './lib/paths.mjs';
import './lib/nodeTs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const all = args.includes('--all'), force = args.includes('--force');
const ji = args.indexOf('--jobs');
const jobs = (ji >= 0 && Number(args[ji + 1])) || Number(process.env.PB_JOBS) || Math.min(4, os.availableParallelism()); // pbx sets PB_JOBS
const maps = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--jobs');

const { installNodeEnv, buildNodeLevel, availableMaps, PUBLIC } = await import(pathToFileURL(webPath('src/game/dev/navLevel.node.ts')).href);
installNodeEnv();

async function bakeOne(map) {
  const out = path.join(PUBLIC, 'assets/maps', map, 'navgraph.bin');
  const { NavGraph } = await import(pathToFileURL(webPath('src/game/navGraph.ts')).href);
  const lvl = await buildNodeLevel(map);
  const { bounds, spawns } = lvl.meta;
  if (!bounds) return { map, skipped: 'no bounds in collision.json' };
  const seeds = spawns.map((s) => s.feet);
  const t0 = performance.now();
  const g = NavGraph.build(lvl.world, lvl.R, bounds, seeds);
  const ms = performance.now() - t0;
  if (g.size < 20) return { map, skipped: `only ${g.size} nodes (the game plays this map without a graph)`, ms };
  const buf = Buffer.from(g.toBuffer(bounds, seeds));
  fs.writeFileSync(out, buf);
  return { map, nodes: g.size, bytes: buf.length, buildMs: Math.round(ms) };
}

if (all) {
  const list = await availableMaps();
  const todo = list.filter((m) => force || !fs.existsSync(path.join(PUBLIC, 'assets/maps', m, 'navgraph.bin')));
  console.log(`baking ${todo.length} of ${list.length} maps, ${jobs} at a time`);
  const results = [];
  let next = 0;
  const run = () => new Promise((resolve) => {
    const map = todo[next++];
    if (!map) return resolve();
    const t0 = performance.now();
    const c = spawn(process.execPath, [path.join(HERE, 'bake-navgraph.mjs'), map], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    c.stdout.on('data', (d) => (o += d));
    c.stderr.on('data', (d) => (e += d));
    c.on('close', (code) => {
      const line = o.split('\n').find((l) => l.startsWith('BAKE '));
      const r = line ? JSON.parse(line.slice(5)) : { map, error: (e || o).trim().split('\n').slice(-3).join(' | '), code };
      r.wallMs = Math.round(performance.now() - t0);
      results.push(r);
      console.log(JSON.stringify(r));
      run().then(resolve);
    });
  });
  await Promise.all(Array.from({ length: jobs }, run));
  fs.writeFileSync(path.join(os.tmpdir(), 'bake-navgraph.last.json'), JSON.stringify(results, null, 1)); // per-map nodes / bytes / build ms
  const bad = results.filter((r) => r.error);
  console.log(`done: ${results.filter((r) => r.nodes).length} baked, ${results.filter((r) => r.skipped).length} skipped, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
} else {
  if (!maps.length) { console.error('usage: bake-navgraph.mjs <map ...> | --all [--jobs N] [--force]'); process.exit(2); }
  for (const m of maps) console.log('BAKE ' + JSON.stringify(await bakeOne(m)));
}
