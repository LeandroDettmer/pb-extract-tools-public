#!/usr/bin/env node
// PBCross pef export: Clients/PBCross/Pack/Script.i3Pack Config/*.pef -> extracted/pef-cross/br/<File>.json, and the
// Cross character table out/cross/config/character.json (+ sources.json).
//
//   node pef/export-cross.mjs [Script.i3Pack] [--nation N] [--dry-run]
//
// Why not extract-config.mjs: its readScriptPack reads the PFN3 table at 0x162 (Kaybo layout). The Cross pack uses
// parsePack (i3pack/unpack.mjs), which finds the Config node and decodes each file with its own attr. The pef parser
// and the nation resolve are the 2017 ones (extract-config parsePef / resolveNation), so a Cross block has the same
// shape as extracted/pef2017/br/*.json (K-2 Gun block is identical in both).
//
// character.json reads the PBCross Character.pef only: every value of a character block, plus a Movement group that
// repeats the movement keys (the layout charaStats.ts reads: Movement.FrontMoveSpeed). ITEMID is not in any Cross pef
// (Character, Goods and Equipment have no 60xxxx id); it comes from the server table the match server loads
// (--server: server/runtime/Data/Match/CharaHealth.xml, `;Name` comment = the Character.pef key, case ignored).
// Without --server the characters have no ITEMID, said in the log and in sources.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { parsePef, resolveNation } from './extract-config.mjs';
import { assetPath, baseClient, clientPath, pefDir, serverPathOpt } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const ni = args.indexOf('--nation');
const NATION = ni >= 0 ? +args.splice(ni, 2)[1] : 1;
const dryRun = args.includes('--dry-run');
// the client whose Script.i3Pack is read and whose pef-<key> / out/<key> folders are written. cross by default; [INFERIDO] other clients use the same Config/*.pef reader
const KEY = baseClient('cross');
// skip the value of --client <key> (it is not a pack path)
const PACK = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--client') || clientPath(KEY, 'Pack', 'Script.i3Pack');
const OUT = pefDir('br');
const CONFIG_OUT = assetPath(KEY, 'config');
const CHARA_HEALTH = serverPathOpt('runtime', 'Data', 'Match', 'CharaHealth.xml');

/** Config/*.pef of the Cross Script pack: { name, json } (json = nation-resolved, the same tree as pef2017/br). */
export function readCrossPefs(packFile = PACK, nation = NATION) {
  const pack = fs.readFileSync(packFile);
  const cfg = parsePack(pack).nodes.find(n => n.name === 'Config');
  if (!cfg) throw new Error(`no Config node in ${packFile}`);
  const out = [];
  for (const f of cfg.files) {
    if (!f.name.endsWith('.pef')) continue;
    const data = decodeContent(pack.subarray(f.offset, f.offset + f.size), f.attr);
    if (!data) throw new Error(`cannot decode ${f.name}`);
    const tree = parsePef(data);
    out.push({ name: f.name.replace(/\.pef$/, ''), json: resolveNation(tree.RegistryRoot ?? tree, nation) });
  }
  return out;
}

// Keys of the Movement group (the pef-3.123 Character.<name>.Movement layout the web reads); the Cross block has them flat.
const MOVE_KEYS = ['AccelRateFrontVsBack', 'AccelerationTime', 'BackMoveSpeed', 'ClunchJumpCheckTime', 'ClunchJumpHeight', 'DiagonalMoveSpeed',
  'FrontMoveSpeed', 'JumpDelay', 'JumpHeight', 'JumpPenaltyRate', 'JumpPenaltyTime', 'JumpTime', 'SideMoveSpeed', 'WalkBackMove',
  'WalkDiagonalMove', 'WalkFrontMove', 'WalkSideMove'];

/** CharaHealth.xml -> lower-case name -> item id. */
export function charaItemIds(xml) {
  const ids = new Map();
  for (const m of xml.matchAll(/<Chara Id="(\d+)"[^>]*\/>\s*;([^\s<]+)/g)) ids.set(m[2].toLowerCase(), +m[1]);
  return ids;
}

/** Character table from the Cross pef. Character blocks only (an object with _ResPath); scalar globals stay out. */
export function buildCharaTable(cross, ids) {
  const Character = {};
  const withItemId = [];
  for (const [name, src] of Object.entries(cross.Character ?? {})) {
    if (!src || typeof src !== 'object' || !src._ResPath) continue;
    const ITEMID = ids.get(name.toLowerCase());
    if (ITEMID) withItemId.push(name);
    const Movement = Object.fromEntries(MOVE_KEYS.filter(k => src[k] !== undefined).map(k => [k, src[k]]));
    Character[name] = { ...(ITEMID ? { ITEMID } : {}), ...structuredClone(src), Movement };
  }
  return { Character, withItemId };
}

function main() {
  const pefs = readCrossPefs();
  console.log(`Cross pef: ${pefs.map(p => p.name).join(', ')}`);
  if (dryRun) return;
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of pefs) fs.writeFileSync(path.join(OUT, `${p.name}.json`), JSON.stringify(p.json));
  const cross = pefs.find(p => p.name === 'Character').json;
  const ids = CHARA_HEALTH ? charaItemIds(fs.readFileSync(CHARA_HEALTH, 'utf8')) : new Map();
  if (!CHARA_HEALTH) console.log('character.json: --server not set (or no runtime/Data/Match/CharaHealth.xml): no ITEMID');
  const { Character, withItemId } = buildCharaTable(cross, ids);
  fs.mkdirSync(CONFIG_OUT, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_OUT, 'character.json'), JSON.stringify({ Mode: cross.Mode, Character }));
  fs.writeFileSync(path.join(CONFIG_OUT, 'sources.json'), JSON.stringify({
    order: ['pef-cross (PBCross Script.i3Pack): every value', `ITEMID: identity only, ${CHARA_HEALTH ? 'server runtime/Data/Match/CharaHealth.xml by name' : 'none (--server not set)'}`],
    character: { cross: Object.keys(Character).length, withItemId: withItemId.length, names: Object.keys(Character) },
  }, null, 1));
  console.log(`character.json: ${Object.keys(Character).length} characters, ${withItemId.length} with ITEMID`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
