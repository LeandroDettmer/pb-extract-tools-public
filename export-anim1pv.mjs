#!/usr/bin/env node
// 1st-person (arms) animation library per weapon, straight from the PBCross character AI, pure Node ESM.
//
//   node export-anim1pv.mjs [SWAT_Male SWAT_Female]   # -> <out>/chars/<name>/anim1pv/
//   node export-anim1pv.mjs --list [SWAT_Male]         # itemId -> resolved 1PV AI + clip set (no write)
//
// Source: ONLY the PBCross client (Clients/PBCross/Chara/<Name>/): <Name>.I3CHR (I3R2, tools/i3r2/charai-i3r2.mjs)
// gives Upper/1PV/<Group>/<Weapon>/{AttackIdle, Zoom}/<State> -> .i3a + i3AIState blend / duration; the clips come from
// Chara_<Name>_*.i3AnimPack (APF1/2/3). The Cross weapon.pef LinkedToCharaAI (lib/cross-weapons.mjs) links each
// weapon to its AI (AUG A3 Gold 103037 -> "AUG-A3" -> 1PV/AssultRifle3/AUG-A3/{Attack_Semi,Reload,Change} +
// AssultRifle3/Common/{AttackIdle,Move_AttackIdle,AttackIdle_Zoom}), so every weapon holds, fires, zooms, reloads and
// draws with its own clips, and the weapon (parented to WeaponPointDummyRight) follows that weapon's pose.
//
// Output (loaded lazily per equipped weapon by src/weapons/viewmodel.ts):
//   index.json  { ai: {<Group/Weapon>: {group, weapon, stances: {AttackIdle, Zoom}}}, weapons: {<itemId>: <AI>},
//                 names: {<norm(name)>: <AI>}, zoomType: {<itemId>: _ZoomType}, fallback: {<itemId>: why}, bundles }
//   <dir>.glb   animation-only GLB per clip folder (AssultRifle3_AUG-A3.glb, AssultRifle3_Common.glb, ...): nodes = the
//               arms_1pv.glb joint names, clips named by key "<Folder>/<Sub>/<Clip>" (path under Chara/<Name>/1PV/).
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCharAI2017 } from './i3r2/charai-i3r2.mjs';
import { readAnimPack } from './i3r2/skin-anim.mjs';
import { GLB, readGLB } from './i3r2/skin-glb.mjs';
import { addClips } from './export-anim.mjs';
import { pefById } from './pef-cross.mjs';

const GAME = clientPath(baseClient(['cross'])); // Cross only: pef-cross weapon blocks; other clients fail with a message
const ASSETS = assetPath();

/**
 * states the web viewmodel drives (Damage*, UI_*, *_Master, Jump* are not exported; ExtensionActivate/Deactivate = silencer on/off). Dual-wield AIs
 * (DualHandGun / DualSMG / DualShotGun) have no single Idle: two layers, Left* clips key spine + LEFT arm, Right*
 * clips spine + RIGHT arm (Dual_DesertEagle/AttackIdle_Left 30 tracks: IK, Spine1-3, Neck, Head, L Clavicle..L Twist4,
 * Pivot); LoadMagazine / Change key both arms. The viewmodel merges the pair per frame (viewmodel.ts dualClip).
 */
const DUAL_STATES = ['LeftIdle', 'RightIdle', 'LeftMove', 'RightMove', 'LeftAttack', 'RightAttack'];
/** jump / hit reaction clips + shotgun / beret reload states; *Master is exported only, not driven ([INFERIDO] 0x613710) */
const JUMP_DAMAGE = ['JumpStart', 'JumpEnd', 'DamageFrontLeftA', 'DamageFrontLeftB', 'DamageFrontRightA', 'DamageFrontRightB', 'DamageBackA', 'DamageBackB'];
const RELOAD_EXTRA = ['LoadMagazineReady', 'LoadMagazine2', 'FireBullet', 'LoadMagMaster', 'LoadB_Master', 'LoadC_Master', 'LoadD_Master'];
const STATES = {
  AttackIdle: ['Idle', 'Move', 'Attack', 'AttackBurst', 'Attack2', 'AttackReady', 'SecondaryAttack', 'LoadMagazine', 'LoadBullet', 'Change', 'ExtensionActivate', 'ExtensionDeactivate', ...DUAL_STATES,
    'LeftJumpStart', 'LeftJumpEnd', 'RightJumpStart', 'RightJumpEnd', ...JUMP_DAMAGE, ...RELOAD_EXTRA],
  Zoom: ['Idle', 'Move', 'Attack', 'AttackBurst', 'LoadMagazine', 'LoadBullet', 'Change', ...JUMP_DAMAGE, ...RELOAD_EXTRA],
};
/**
 * [RECRIADO] AI for weapons whose pef AI has no 1PV tree in the 2017 I3CHR (newer weapons, dual-wield AIs whose
 * Left-/Right- sub-layers the viewmodel does not drive): the basic PB weapon of the pef class. Keep in sync with
 * src/weapons/viewmodel.ts CLASS_FALLBACK_1PV.
 */
const CLASS_FALLBACK = {
  Assault: 'AssaultRifle/K-2', Assault2: 'AssaultRifle/K-2', MG: 'MG/RPD', SMG: 'SMG/K-1', SMG2: 'SMG/K-1', Sniper: 'SniperRifle/SSG69',
  Shotgun: 'ShotGun/870MCS', Pistol: 'HandGun/K5', Dual: 'HandGun/K5', Melee: 'Knife/M-7', Knuckle: 'Knife/M-7', Throwing: 'Throwing/K-400',
  Throwing2: 'Throwing/K-400',
};
/** weapon.pef class -> 1PV groups, in preference order (one AI name can sit in several groups: HandGun/P99 vs CIC/P99) */
const CLASS_GROUPS = {
  Assault: ['AssaultRifle'], Assault2: ['AssaultRifle'], SMG: ['SMG', 'AssaultRifle'], SMG2: ['SMG', 'AssaultRifle'], Sniper: ['SniperRifle'],
  Shotgun: ['ShotGun'], Pistol: ['HandGun', 'CIC'], Dual: ['DualHandGun', 'DualSMG', 'DualKnife', 'DualShotGun'], Melee: ['Knife'],
  Knuckle: ['Knife'], MG: ['MG'], Throwing: ['Throwing'], Throwing2: ['Throwing'], RocketLauncher: ['RocketLauncher'], Bow: ['Bow'], Bomb: ['Mission'],
};
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** weapon -> 1PV AI resolution (pure, no clip reading). */
export function resolve1pv(name = 'SWAT_Male') {
  const dir = path.join(GAME, 'Chara', name);
  const U = readCharAI2017(path.join(dir, `${name}.I3CHR`))['1pv'].upper;
  const byAiName = new Map();
  for (const [k, u] of Object.entries(U)) { const n = norm(u.weapon); if (!byAiName.has(n)) byAiName.set(n, []); byAiName.get(n).push(k); }
  const hasIdle = (k) => !!(U[k]?.stances.AttackIdle?.Idle?.clip || U[k]?.stances.AttackIdle?.RightIdle?.clip);
  // LinkedToCharaAI of the PBCross weapon.pef block (tools/pef-cross.mjs)
  const byId = pefById();
  const catalog = JSON.parse(fs.readFileSync(path.join(ASSETS, 'cross/weapons/weapons.json'), 'utf8')).weapons;
  const weapons = {}, names = {}, fallback = {}, zoomType = {};
  for (const w of catalog) {
    const p = byId.get(w.id);
    const linked = p?.linked;
    // no pef block (SCAR-H LB sniper / Std Sil are catalog-only): the AI of the same name
    const cands = (linked ? byAiName.get(norm(linked)) : p ? null : byAiName.get(norm(w.name))) ?? [];
    let ai = null;
    for (const g of CLASS_GROUPS[p?.cls] ?? []) { ai = cands.find((k) => U[k].group === g && hasIdle(k)) ?? null; if (ai) break; }
    ai ??= cands.find(hasIdle) ?? null;
    if (!ai) {
      const fb = p && CLASS_FALLBACK[p.cls];
      if (!fb || !U[fb]) continue;
      fallback[w.id] = cands.length ? `${cands[0]} (no Idle) -> ${fb}` : `${linked ?? '(no AI)'} has no 1PV tree in 2017 -> ${fb}`;
      ai = fb;
    }
    weapons[w.id] = ai;
    if (p?.zoomType !== undefined) zoomType[w.id] = p.zoomType;
    names[norm(w.name)] ??= ai;
  }
  return { dir, U, weapons, names, fallback, zoomType, catalog };
}

export function buildAnim1pv(name = 'SWAT_Male', { log = console.log } = {}) {
  const { dir, U, weapons, names, fallback, zoomType } = resolve1pv(name);
  const outDir = path.join(ASSETS, 'chars', name.toLowerCase(), 'anim1pv');
  const prefix = new RegExp(`^chara/${name}/1pv/`, 'i');
  const rel = (p) => p.replace(/\\/g, '/').replace(prefix, '').replace(/\.i3a$/i, '');
  // pack entries by lower-cased key, keeping the pack's own spelling for the clip key
  const where = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => /\.i3AnimPack$/i.test(x))) {
    let P;
    try { P = readAnimPack(path.join(dir, f)); } catch (e) { log(`  ${f}: ${e.message}`); continue; }
    P.entries.forEach((e, i) => { if (!prefix.test(e.path)) return; const k = rel(e.path); if (!where.has(k.toLowerCase())) where.set(k.toLowerCase(), { P, i, key: k }); });
  }
  const used = new Set([...Object.values(weapons), ...Object.values(CLASS_FALLBACK).filter((k) => U[k])]);
  const ai = {}, need = new Map(), missing = new Set();
  for (const k of [...used].sort()) {
    const u = U[k], stances = {};
    for (const [s, keep] of Object.entries(STATES)) {
      const S = u.stances[s];
      if (!S) continue;
      const o = {};
      for (const st of keep) {
        const x = S[st];
        if (!x?.clip) continue;
        const w = where.get(rel(x.clip).toLowerCase());
        if (!w) { missing.add(rel(x.clip)); continue; }
        need.set(w.key, w);
        o[st] = { clip: w.key, blend: x.blend, dur: x.dur, loop: x.loop };
      }
      if (o.Idle || (o.LeftIdle && o.RightIdle)) stances[s] = o;
    }
    ai[k] = { group: u.group, weapon: u.weapon, stances };
  }
  const bones = (() => {
    const { J } = readGLB(path.join(ASSETS, 'chars', name.toLowerCase(), 'arms_1pv.glb'));
    return J.skins[0].joints.map((j) => ({ name: J.nodes[j].name }));
  })();
  const groups = new Map();
  for (const [key, w] of [...need].sort(([a], [b]) => a.localeCompare(b))) {
    let c;
    try { c = w.P.clip(w.i); } catch (e) { missing.add(`${key} (${e.message})`); continue; }
    const folder = key.split('/').slice(0, -1).join('_') || 'root';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push({ name: key, duration: c.duration, tracks: c.tracks, source: path.basename(w.P.file) + ':' + c.path });
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.glb')) fs.unlinkSync(path.join(outDir, f));
  const bundles = {};
  let bytes = 0, clipCount = 0;
  for (const [folder, clips] of groups) {
    const G = new GLB('pb export-anim1pv.mjs');
    const nodeOf = bones.map((b) => G.node({ name: b.name }));
    G.json.scenes[0].nodes = nodeOf.slice();
    const info = addClips(G, nodeOf, bones, clips);
    const file = `${folder.replace(/[^A-Za-z0-9_.-]/g, '_')}.glb`;
    const buf = G.build();
    fs.writeFileSync(path.join(outDir, file), buf);
    bytes += buf.length;
    clipCount += info.length;
    for (const c of info) bundles[c.name] = file;
  }
  for (const a of Object.values(ai)) for (const S of Object.values(a.stances)) for (const k of Object.keys(S)) if (!bundles[S[k].clip]) delete S[k];
  const index = {
    generated: new Date().toISOString(), tool: 'export-anim1pv.mjs', source: `PBCross Chara/${name}/${name}.I3CHR + Chara_${name}_*.i3AnimPack`,
    note: 'state = { clip, blend (s, i3AIState blend-in), dur (s, i3AIState duration), loop }; zoomType = weapon.pef _ZoomType (2|3 -> Zoom stance); fallback = [RECRIADO] AI substitutions',
    ai, weapons, names, zoomType, fallback, bundles,
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index));
  log(`${name}: ${Object.keys(ai).length} 1PV AIs for ${Object.keys(weapons).length} weapons, ${clipCount} clips in ${groups.size} bundles, ${(bytes / 1048576).toFixed(1)} MB -> ${path.relative(process.cwd(), outDir)}`);
  if (missing.size) log(`  ${missing.size} clips missing in the packs: ${[...missing].slice(0, 10).join(', ')}${missing.size > 10 ? ' ...' : ''}`);
  if (Object.keys(fallback).length) log(`  ${Object.keys(fallback).length} weapons on a substitute AI (index.fallback)`);
  return index;
}

function list(name) {
  const { U, weapons, fallback, zoomType, catalog } = resolve1pv(name);
  const short = (c) => c?.replace(/^Chara\/[^/]+\/1PV\//i, '').replace(/\.i3a$/i, '') ?? '-';
  for (const w of catalog) {
    const k = weapons[w.id];
    if (!k) { console.log(`${w.id}\t${w.name}\t(no 1PV AI)`); continue; }
    const A = U[k].stances.AttackIdle ?? {}, Z = U[k].stances.Zoom;
    const zt = zoomType[w.id];
    console.log([w.id, w.name, k + (fallback[w.id] ? ' [RECRIADO fallback]' : ''), `idle=${short(A.Idle?.clip)}`, `fire=${short(A.Attack?.clip)}`,
      `reload=${short(A.LoadMagazine?.clip)}`, `change=${short(A.Change?.clip)}`, `move=${short(A.Move?.clip)}`,
      `zoom=${Z && (zt === 2 || zt === 3) ? short(Z.Idle?.clip) : '-'}(ZoomType ${zt ?? '-'})`].join('\t'));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  if (a[0] === '--list') list(a[1] || 'SWAT_Male');
  else for (const n of a.length ? a : ['SWAT_Male', 'SWAT_Female']) buildAnim1pv(n);
}
