#!/usr/bin/env node
// C5 brick models (thrown / planted C5) -> out/weapons/models/<c5 id>_bomb.glb + models/index.json entries.
//
//   node export-c5-bomb.mjs
//
// Weapon_C5.i3Pack holds two models: BombTrigger.I3S (Model_Switch + Model_Handle = the detonator the hand holds after
// the throw) and C5.I3S (Model_C5 under C5AnimationDummy = the brick that flies and sticks). export-batch.mjs takes the
// first i3Body of a pack, so it only ever exported the detonator: the thrown C5 was drawn as a detonator (atlas UVs of
// the brick region missing). Here the brick is exported with export-model.mjs `i3s`.
//   c5_bomb          Weapon_C5 / C5.I3S            (C5, C5_D, C5_EV)
//   c5_cny_2015_bomb Weapon_C5_CNY-2015 / C5_CNY-2015.I3S (own textures)
//   <skin>_bomb      base brick geometry + the diffuse map of the skin glb already exported by export-batch (same atlas)
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportWeapon } from './export-model.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack'); // Cross only by default (--client <key> for a diagnostic run)
const MODELS = assetPath('weapons', 'models');
const IDX = path.join(MODELS, 'index.json');
const log = console.log;

const readGlb = (f) => {
  const b = fs.readFileSync(f), n = b.readUInt32LE(12);
  return { json: JSON.parse(b.subarray(20, 20 + n).toString('utf8')), bin: b.subarray(20 + n + 8) };
};
const writeGlb = (f, json, bin) => {
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bp = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const h = Buffer.alloc(12);
  h.write('glTF', 0, 'latin1'); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + js.length + 8 + bp.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.write('JSON', 4, 'latin1');
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bp.length, 0); c2.write('BIN\0', 4, 'latin1');
  fs.writeFileSync(f, Buffer.concat([h, c1, js, c2, bp]));
};

const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const byId = new Map(idx.weapons.map((e) => [e.id, e]));
const put = (e) => byId.set(e.id, e);

// base brick + CNY (own pack)
const jobs = [
  { pack: 'Weapon_C5', id: 'c5_bomb', i3s: 'C5', of: 'c5' },
  { pack: 'Weapon_C5_CNY-2015', id: 'c5_cny_2015_bomb', i3s: 'C5_CNY-2015', of: 'c5_cny_2015' },
];
for (const j of jobs) {
  const base = byId.get(j.of);
  const e = exportWeapon({ pack: j.pack, id: j.id, kind: 'projectile', packDir: PACKS, i3s: j.i3s,
    extra: { client: 'cross', sourceVersion: 'Cross', family: base?.family, animSet: base?.animSet, projectileOf: j.of } }, { log });
  put(e);
}

// skins: brick geometry of c5_bomb + the skin's diffuse (already exported next to the skin's detonator glb)
const brick = readGlb(path.join(MODELS, 'c5_bomb.glb'));
for (const s of idx.weapons.filter((e) => e.skinOf === 'c5' && !/_bomb$/.test(e.id))) {
  const sk = readGlb(path.join(MODELS, s.file));
  const uri = sk.json.images?.[0]?.uri;
  if (!uri) { log(`skip ${s.id}: no texture`); continue; }
  const id = `${s.id}_bomb`;
  const json = structuredClone(brick.json);
  json.images[0] = { ...json.images[0], uri, name: sk.json.images[0].name };
  json.materials[0].name = sk.json.materials?.[0]?.name || json.materials[0].name;
  writeGlb(path.join(MODELS, `${id}.glb`), json, brick.bin);
  put({ ...byId.get('c5_bomb'), id, file: `${id}.glb`, skinOf: 'c5_bomb', skin: s.skin, projectileOf: s.id });
  log(`skin ${id}: texture ${uri}`);
}

fs.writeFileSync(IDX, JSON.stringify({ ...idx, generated: new Date().toISOString(),
  weapons: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) }, null, 1));
log('models/index.json:', byId.size, 'entries');
