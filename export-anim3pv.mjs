#!/usr/bin/env node
// 3rd-person animation library straight from the PBCross character AI (Chara/<Name>/<Name>.I3CHR), pure Node ESM.
//
//   node export-anim3pv.mjs [SWAT_Male]         # -> <out>/chars/<name>/anim3pv/
//   node export-anim3pv.mjs --list [SWAT_Male]  # itemId -> resolved 3PV AI (Cross | substitute), no write
//
// The I3CHR AI tree says which .i3a each state plays (tools/i3r2/charai-i3r2.mjs):
//   Lower  Stand|Sit x {Idle, Front, FrontLeft, FrontRight, Left, Right, Back, BackLeft, BackRight, Walk<8 dirs>,
//          JumpStart, JumpEnd}                        -> 8-direction locomotion, walk and run clips
//   Upper  <LinkedToCharaAI> x {AttackIdle, Zoom} x {Idle, Move, Attack, LoadMagazine, LoadBullet, Change, ...}
// with the state's blend-in time and clip duration. weapon.pef LinkedToCharaAI (the 2017 pef when the weapon exists
// there, tools/pef-cross.mjs) links each weapon to its AI, so the upper body plays the weapon's own reload/change/attack clips.
//
// Source: Cross only (Clients/PBCross/Chara/<Name>/<Name>.I3CHR + Chara_<Name>_*.i3AnimPack). Upper and lower trees come
// from the same I3CHR, read with readCharAI2017 (the 3.123 reader finds 1 upper tree in Cross, this one 159). No fallback client.
// The 2017 (Kaybo) I3CHR is not wired here: its weapon blocks and weapon list are not per client yet.
//
// Output (loaded lazily by src/game/charAnimLib.ts):
//   index.json   { lower: {Stand, Sit}, ai: {<AI>: {driver, stances: {AttackIdle, Zoom}}}, weapons: {<itemId>: <AI>},
//                  names: {<norm(name)>: <AI>}, aiSource: {<AI>: 'Cross'}, bundles: {<clip key>: <bundle file>} }
//   <dir>.glb    one animation-only GLB per clip folder (e.g. AssultRifle_AK47.glb): nodes = skeleton bone names,
//                clips named by key "<Folder>/<Sub>/<Clip>" (path under Chara/<Name>/3PV/, no extension).
// Tracks are the same bone-local TRS as model.glb (tools/export-anim.mjs addClips), so the clips bind to its bones.
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCharAI2017 } from './i3r2/charai-i3r2.mjs';
import { readAnimPack } from './i3r2/skin-anim.mjs';
import { GLB, readGLB } from './i3r2/skin-glb.mjs';
import { addClips } from './export-anim.mjs';
import { pefById } from './pef-cross.mjs';

// Cross only: the I3CHR AI tree, pef-cross weapon blocks and cross/weapons catalog are Cross data. Other clients fail with a message (lib/paths.mjs baseClient)
const GAME = clientPath(baseClient(['cross']));
const ASSETS = assetPath();

/**
 * Dual-wield AIs (DualHandGun / DualSMG / DualShotGun) have no single Idle: two layers (CGameCharaAnimControl::
 * PlayUpperDual), Left* clips key the trunk + LEFT arm, Right* the trunk + RIGHT arm; LoadMagazine / Change key both
 * arms. src/game/charAnimLib.ts dualTables merges the pairs (same as the 1PV side, tools/export-anim1pv.mjs).
 */
const DUAL_STATES = ['LeftIdle', 'RightIdle', 'LeftMove', 'RightMove', 'LeftAttack', 'RightAttack'];
/** states exported per upper stance (the rest - Extension*, Grenade/Knife/ShotGun/AttackIdle_Left/CrossIdle* stances - are not driven by the web client; *Master is exported only, [INFERIDO] 0x613710) */
const JUMP_DAMAGE = ['JumpStart', 'JumpEnd', 'DamageFrontLeftA', 'DamageFrontLeftB', 'DamageFrontRightA', 'DamageFrontRightB', 'DamageBackA', 'DamageBackB'];
const UPPER_STATES = {
  AttackIdle: ['Idle', 'Move', 'Attack', 'AttackReady', 'AttackBurst', 'SecondaryAttack', 'LoadMagazine', 'LoadBullet', 'LoadMagazineReady', 'Change',
    'LoadMagazine2', 'FireBullet', 'LoadMagMaster', 'LoadB_Master', 'LoadC_Master', 'LoadD_Master',
    'LeftJumpStart', 'LeftJumpEnd', 'RightJumpStart', 'RightJumpEnd', ...JUMP_DAMAGE, ...DUAL_STATES,
    // lobby / inventory showroom (src/lobby/screens/preview3d.ts): full-skeleton clips per weapon AI, not loaded by the match
    'UI_Idle_Stand', 'UI_IdleA', 'UI_IdleB', 'UI_Idle_Change'],
  Zoom: ['Idle', 'Move', 'Attack', 'AttackBurst', 'LoadMagazine', 'LoadBullet', 'LoadMagazineReady', 'LoadMagazine2', 'FireBullet', ...JUMP_DAMAGE],
};
/**
 * [RECRIADO] AI for weapons whose pef AI has no usable 3PV tree in either client (newer weapons): the basic PB weapon of
 * the pef class.
 * Keep the per-class values in sync with src/game/charAnimLib.ts CLASS_FALLBACK_AI.
 */
const CLASS_FALLBACK = {
  Assault: 'AssaultRifle/K-2', Assault2: 'AssaultRifle/K-2', MG: 'AssaultRifle/K-2', SMG: 'SMG/K-1', SMG2: 'SMG/K-1', Sniper: 'SniperRifle/SSG69',
  Shotgun: 'ShotGun/870MCS', Pistol: 'HandGun/K5', Dual: 'HandGun/K5', Melee: 'Knife/M-7', Knuckle: 'Knife/M-7', Throwing: 'Throwing/K-400',
  Throwing2: 'Throwing/K-400',
};
const FALLBACK_AI = [...new Set(Object.values(CLASS_FALLBACK))];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * weapon.pef class (WeaponList.Weapon.<class>) -> AI groups of Upper/3PV, in preference order. Used when one AI name
 * exists in several groups (HandGun/DesertEagle vs DualHandGun/DesertEagle). Read from the group names; the exe's
 * CCharaAIIndexTable::getAIUpperID (0x98cfc0) lookup by weapon class is not decoded.
 */
const CLASS_GROUPS = {
  Assault: ['AssaultRifle'], Assault2: ['AssaultRifle'], SMG: ['SMG', 'AssaultRifle'], SMG2: ['SMG', 'AssaultRifle'], Sniper: ['SniperRifle'],
  Shotgun: ['ShotGun'], Pistol: ['HandGun', 'CIC'], Dual: ['DualHandGun', 'DualSMG', 'DualKnife', 'DualShotGun'], Melee: ['Knife'],
  Knuckle: ['Knife'], MG: ['MG'], Throwing: ['Throwing'], Throwing2: ['Throwing'], RocketLauncher: ['RocketLauncher'], Shield: ['Shield'],
  Bow: ['Bow'], Bomb: ['Mission', 'Nonamed'], Mission: ['Mission', 'Nonamed'],
};

/** weapon -> 3PV AI resolution (pure, no clip reading). `upper` = merged trees, 2017 entries win on the same key. */
export function resolve3pv(name = 'SWAT_Male') {
  const tree3 = readCharAI2017(path.join(GAME, 'Chara', name, `${name}.I3CHR`))['3pv'];
  const upper = tree3.upper, aiSource = {};
  for (const k of Object.keys(upper)) aiSource[k] = 'Cross';
  // norm(weapon AI) -> ["Group/Weapon", ...] (case-insensitive AI names: "vz52" = "Vz52", AUG_A3 = AUG-A3)
  const byAiName = new Map();
  for (const [k, u] of Object.entries(upper)) {
    const n = norm(u.weapon);
    if (!byAiName.has(n)) byAiName.set(n, []);
    if (!byAiName.get(n).includes(k)) byAiName.get(n).push(k);
  }
  // a dual tree (RightIdle / LeftIdle, no Idle) only for the dual-wield guns the web client mounts twice (weapons.json
  // className DualHandGun / DualSMG / DualShotgun, WeaponSystem dualFire); others (202025 HK45 Dual, a HandGun) keep
  // the single-weapon AI of the same name or the class fallback
  const DUAL_CLASSES = ['DualHandGun', 'DualSMG', 'DualShotgun'];
  const hasIdle = (k, dual = false) => !!(upper[k]?.stances.AttackIdle?.Idle?.clip || (dual && upper[k]?.stances.AttackIdle?.RightIdle?.clip));
  const resolveAI = (linked, cls) => {
    const cands = byAiName.get(norm(linked)) ?? [];
    for (const g of CLASS_GROUPS[cls] ?? []) { const hit = cands.find((k) => upper[k].group === g); if (hit) return hit; }
    return cands[0] ?? null;
  };
  const byId = pefById();
  const catalog = JSON.parse(fs.readFileSync(path.join(ASSETS, 'cross/weapons/weapons.json'), 'utf8')).weapons;
  const weapons = {}, names = {}, fallback = {}, zoomType = {}, unlinked = new Map();
  for (const w of catalog) {
    const p = byId.get(w.id);
    const linked = p?.linked;
    // no pef block: by weapon name, as export-anim1pv.mjs resolve1pv (SCAR-H Std Sil, MGL-32, MiniAxe...)
    let ai = linked ? resolveAI(linked, p.cls) : p ? null : (byAiName.get(norm(w.name)) ?? [])[0] ?? null;
    const dual = DUAL_CLASSES.includes(w.className);
    if (ai && !hasIdle(ai, dual)) {
      // dual-wield tree: same AI name in a single-weapon group (DualHandGun/DesertEagle -> HandGun/DesertEagle)
      const alt = (byAiName.get(norm(linked)) ?? []).find((k) => hasIdle(k)) ?? (p && CLASS_FALLBACK[p.cls]);
      fallback[w.id] = `${ai} (dual) -> ${alt}`;
      ai = alt ?? null;
    } else if (!ai && p && CLASS_FALLBACK[p.cls]) {
      ai = CLASS_FALLBACK[p.cls];
      fallback[w.id] = `${linked ?? '(no AI)'} has no 3PV tree -> ${ai}`;
      unlinked.set(linked ?? '(no AI)', (unlinked.get(linked ?? '(no AI)') ?? 0) + 1);
    }
    if (!ai || !upper[ai]) { unlinked.set(`${linked ?? '(no pef)'} [none]`, (unlinked.get(`${linked ?? '(no pef)'} [none]`) ?? 0) + 1); continue; }
    weapons[w.id] = ai;
    if (p?.zoomType !== undefined && upper[ai].stances.Zoom) zoomType[w.id] = p.zoomType;
    names[norm(w.name)] ??= ai;
  }
  return { tree3, upper, aiSource, weapons, names, fallback, zoomType, unlinked, catalog };
}

/** clip packs of one client: lower-cased clip key -> { P, i, key (pack spelling) } */
function packIndex(dir, keyOf) {
  const where = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => /\.i3AnimPack$/i.test(x))) {
    let P;
    try { P = readAnimPack(path.join(dir, f)); } catch { continue; }
    P.entries.forEach((e, i) => { const key = keyOf(e.path), k = key.toLowerCase(); if (!where.has(k)) where.set(k, { P, i, key }); });
  }
  return where;
}

export function buildAnim3pv(name = 'SWAT_Male', { log = console.log } = {}) {
  const { tree3, upper, aiSource, weapons, names, fallback, zoomType, unlinked, catalog } = resolve3pv(name);
  const outDir = path.join(ASSETS, 'chars', name.toLowerCase(), 'anim3pv');
  const prefix = new RegExp(`^chara/${name}/3pv/`, 'i');
  const keyOf = (p) => p.replace(/\\/g, '/').replace(prefix, '').replace(/\.i3a$/i, '');
  const slim = (S, keep) => {
    const o = {};
    for (const [k, x] of Object.entries(S)) if ((!keep || keep.includes(k)) && x.clip) o[k] = { clip: keyOf(x.clip), blend: x.blend, dur: x.dur, loop: x.loop };
    return o;
  };
  const used = new Set(Object.values(weapons));
  for (const k of FALLBACK_AI) if (upper[k]) used.add(k);
  const ai = {};
  for (const k of [...used].sort()) {
    const u = upper[k];
    ai[k] = { group: u.group, weapon: u.weapon, driver: u.driver, stances: Object.fromEntries(Object.entries(u.stances).filter(([s]) => UPPER_STATES[s]).map(([s, S]) => [s, slim(S, UPPER_STATES[s])])) };
  }
  const lower = Object.fromEntries(Object.entries(tree3.lower).map(([s, S]) => [s, slim(Object.fromEntries(Object.entries(S).filter(([k]) => !/^Death/.test(k))))]));

  // clips needed -> pack entries (PBCross packs only)
  const where = packIndex(path.join(GAME, 'Chara', name), keyOf);
  const need = new Set(); // lower-cased clip keys
  for (const S of Object.values(lower)) for (const x of Object.values(S)) need.add(x.clip.toLowerCase());
  for (const a of Object.values(ai)) for (const S of Object.values(a.stances)) for (const x of Object.values(S)) need.add(x.clip.toLowerCase());
  const bones = (() => {
    const { J } = readGLB(path.join(ASSETS, 'chars', name.toLowerCase(), 'model.glb'));
    return J.skins[0].joints.map((j) => ({ name: J.nodes[j].name }));
  })();
  const groups = new Map(), missing = [], canon = new Map(); // lower key -> exported key spelling
  for (const k of [...need].sort((a, b) => a.localeCompare(b))) {
    const w = where.get(k);
    if (!w) { missing.push(k); continue; }
    let c;
    try { c = w.P.clip(w.i); } catch (e) { missing.push(`${w.key} (${e.message})`); continue; }
    const folder = w.key.split('/').slice(0, -1).join('_') || 'root';
    // one bundle per folder, case-insensitive (2017 SNIFFERRIFLE2/SSG69 vs SnifferRifle2/SSG69 on a Windows disk)
    const g = folder.toLowerCase();
    if (!groups.has(g)) groups.set(g, { folder, clips: [] });
    groups.get(g).clips.push({ name: w.key, duration: c.duration, tracks: c.tracks, source: path.basename(w.P.file) + ':' + c.path });
    canon.set(k, w.key);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.glb')) fs.unlinkSync(path.join(outDir, f));
  const bundles = {};
  let bytes = 0, clipCount = 0;
  for (const { folder, clips } of groups.values()) {
    const G = new GLB('pb export-anim3pv.mjs');
    const nodeOf = bones.map((b) => G.node({ name: b.name }));
    G.json.scenes[0].nodes = nodeOf.slice();
    addClips(G, nodeOf, bones, clips);
    const file = `${folder.replace(/[^A-Za-z0-9_.-]/g, '_')}.glb`;
    const buf = G.build();
    fs.writeFileSync(path.join(outDir, file), buf);
    bytes += buf.length;
    clipCount += clips.length;
    for (const c of clips) bundles[c.name] = file;
  }
  // states -> exported key spelling; drop states whose clip could not be exported
  const ok = (S) => {
    for (const k of Object.keys(S)) {
      const key = canon.get(S[k].clip.toLowerCase());
      if (key && bundles[key]) S[k].clip = key; else delete S[k];
    }
  };
  Object.values(lower).forEach(ok);
  for (const a of Object.values(ai)) Object.values(a.stances).forEach(ok);
  const index = {
    generated: new Date().toISOString(), tool: 'export-anim3pv.mjs',
    source: `PBCross Chara/${name}/${name}.I3CHR (upper + lower); + Chara_${name}_*.i3AnimPack`,
    note: 'state = { clip, blend (s, i3AIState blend-in), dur (s, i3AIState duration), loop }; zoomType = weapon.pef _ZoomType (2|3 -> Zoom AI); fallback = [RECRIADO] AI substitutions; aiSource = client of each AI tree',
    lower, ai, weapons, names, zoomType, fallback, aiSource: Object.fromEntries(Object.keys(ai).map((k) => [k, aiSource[k]])), bundles,
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index));
  log(`${name}: ${Object.keys(ai).length} AIs for ${Object.keys(weapons).length}/${catalog.length} weapons, ${clipCount} clips in ${groups.size} bundles, ${(bytes / 1048576).toFixed(1)} MB -> ${path.relative(process.cwd(), outDir)}`);
  if (missing.length) log(`  ${missing.length} clips missing in the packs: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' ...' : ''}`);
  if (unlinked.size) log(`  ${Object.keys(fallback).length} weapons on a substitute AI (index.fallback); pef AIs without a 3PV tree: ${[...unlinked].map(([k, n]) => `${k} x${n}`).join(', ')}`);
  return index;
}

function list(name) {
  const { upper, aiSource, weapons, fallback, catalog } = resolve3pv(name);
  const short = (c) => c?.replace(/^Chara\/[^/]+\/3PV\//i, '').replace(/\.i3a$/i, '') ?? '-';
  for (const w of catalog) {
    const k = weapons[w.id];
    if (!k) { console.log(`${w.id}\t${w.name}\t(no 3PV AI)`); continue; }
    const A = upper[k].stances.AttackIdle ?? {};
    console.log([w.id, w.name, `${k} [${aiSource[k]}]${fallback[w.id] ? ` [RECRIADO substitute: ${fallback[w.id]}]` : ''}`, `idle=${short(A.Idle?.clip)}`,
      `fire=${short(A.Attack?.clip)}`, `reload=${short(A.LoadMagazine?.clip)}`, `change=${short(A.Change?.clip)}`].join('\t'));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a[0] === '--list') list(a[1] || 'SWAT_Male');
  else buildAnim3pv(a[0] || 'SWAT_Male');
}
