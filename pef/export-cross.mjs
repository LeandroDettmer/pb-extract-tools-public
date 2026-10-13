#!/usr/bin/env node
// PBCross pef export: Clients/PBCross/Pack/Script.i3Pack Config/*.pef -> extracted/pef-cross/br/<File>.json, and the
// Cross-primary character table out/cross/config/character.json (+ sources.json, the fallback record).
//
//   node pef/export-cross.mjs [Script.i3Pack] [--nation N] [--dry-run]
//
// Why not extract-config.mjs: its readScriptPack reads the PFN3 table at 0x162 (Kaybo layout). The Cross pack uses
// parsePack (i3pack/unpack.mjs), which finds the Config node and decodes each file with its own attr. The pef parser
// and the nation resolve are the 2017 ones (extract-config parsePef / resolveNation), so a Cross block has the same
// shape as extracted/pef2017/br/*.json (K-2 Gun block is identical in both).
//
// Source order (PRIMARY first): PBCross -> PBKaybo 2017 (extracted/pef2017/br) -> 3.123 (out/config). An item
// takes the first source that has it. Only Character.json is merged here; Weapon.json is consumed by
// tools/export-weapons.mjs with the same order (weapon items join by _ClassType/_Number + name, see that file).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { parsePef, resolveNation } from './extract-config.mjs';
import { assetPath, clientPath, extractedPath } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const ni = args.indexOf('--nation');
const NATION = ni >= 0 ? +args.splice(ni, 2)[1] : 1;
const dryRun = args.includes('--dry-run');
const PACK = args.find(a => !a.startsWith('--')) || clientPath('cross', 'Pack', 'Script.i3Pack');
const OUT = extractedPath('pef-cross', 'br');
const CONFIG_OUT = assetPath('cross', 'config');
const P3_CHARA = assetPath('config', 'character.json');
const P17_CHARA = extractedPath('pef2017', 'br', 'Character.json');

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

const MOVE_GROUP = 'Movement';
/**
 * One character: the 3.123 entry with the Cross values laid over it. HP top-level, Movement keys that the 3.123
 * entry already has, DamageRate as a whole group (same keys: Arm Body Foot Hand Head Leg). Everything else (ITEMID,
 * PartsList, model) stays 3.123, so charaStats keeps its ITEMID join.
 */
export function overlayChara(base, src) {
  const out = structuredClone(base);
  if (src?.HP !== undefined) out.HP = src.HP;
  if (src && out[MOVE_GROUP] && typeof out[MOVE_GROUP] === 'object') {
    for (const k of Object.keys(out[MOVE_GROUP])) if (src[k] !== undefined && typeof src[k] !== 'object') out[MOVE_GROUP][k] = src[k];
  }
  if (src?.DamageRate) out.DamageRate = structuredClone(src.DamageRate);
  return out;
}

/** Character table with the Cross > 2017 > 3.123 order. Returns { Character, fallback } (fallback = names per source). */
export function buildCharaTable(cross, p17, p3) {
  const fallback = { cross: [], pef2017: [], pef3: [] };
  const Character = {};
  for (const [name, base] of Object.entries(p3.Character ?? {})) {
    if (!base || typeof base !== 'object') { Character[name] = base; continue; }
    const src = cross.Character?.[name] ?? p17.Character?.[name] ?? null;
    if (cross.Character?.[name]) fallback.cross.push(name);
    else if (src) fallback.pef2017.push(name);
    else fallback.pef3.push(name);
    Character[name] = overlayChara(base, src);
  }
  return { Character, fallback };
}

function main() {
  const pefs = readCrossPefs();
  console.log(`Cross pef: ${pefs.map(p => p.name).join(', ')}`);
  if (dryRun) return;
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of pefs) fs.writeFileSync(path.join(OUT, `${p.name}.json`), JSON.stringify(p.json));
  const cross = pefs.find(p => p.name === 'Character').json;
  const p17 = JSON.parse(fs.readFileSync(P17_CHARA, 'utf8'));
  const p3 = JSON.parse(fs.readFileSync(P3_CHARA, 'utf8'));
  const { Character, fallback } = buildCharaTable(cross, p17, p3);
  fs.mkdirSync(CONFIG_OUT, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_OUT, 'character.json'), JSON.stringify({ ...p3, Character }));
  fs.writeFileSync(path.join(CONFIG_OUT, 'sources.json'), JSON.stringify({
    order: ['pef-cross (PBCross Script.i3Pack)', 'pef-2017 (PBKaybo, extracted/pef2017/br)', 'pef-3.123 (out/config)'],
    character: { cross: fallback.cross.length, pef2017: fallback.pef2017.length, pef3: fallback.pef3.length, names: fallback },
  }, null, 1));
  console.log(`character.json: cross ${fallback.cross.length}, 2017 ${fallback.pef2017.length}, 3.123 ${fallback.pef3.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
