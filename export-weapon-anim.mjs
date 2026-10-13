#!/usr/bin/env node
// The weapon's OWN animation (magazine out/in, slide / bolt, pistol hammer, shotgun pump), PBCross client only.
//
//   node export-weapon-anim.mjs            # -> <out>/weapons/anim/{index.json, lib/*.json}
//   node export-weapon-anim.mjs --list colt45 870mcs aug_a3_gold   # model id -> states / clips (no write)
//
// Source (Clients/PBCross/Pack/Weapon_*.i3Pack): a weapon pack is an i3Chara of its own
//   * I3R2 #1: i3AIContext "DefaultGND1" > i3AI "DefaultAI_0" > i3AIState list. i3AIState: u8 nameLen, name, 'AIS1',
//     +16 u16 i3Animation object id (0 = none; the i3Animation is an external ref to "Weapon/<W>/Resource/<Clip>.i3a"),
//     +18 u16 i3TimeSequence ref | 0x8000, ..., 8 x 0xff, f32 duration. State names = the exe's weapon AI table
//     (WeaponBase init 0x610710: Fire 1, Fire1PV 2, Fire3PV 3, Idle 8, Idle1PV 9, LoadMag 0xb, LoadBullet 0xc,
//     LoadMag1PV 0x29, LoadMag3PV 0x2a, Change 0x20, Change1PV 0x21, Change3PV 0x22, *Master* = master-beret variants).
//   * the .i3a clips live in an APF1/APF3 i3AnimPack embedded in the pack itself (skins reference the base pack's
//     clips by path: AUG A3 Gold -> "Weapon/AUG-A3/Resource/Reload_1PV.i3a", stored in Weapon_AUG-A3.i3Pack).
//   * tracks drive the weapon's skeleton bones (MagazineAnimationDummy, HandleAnimationDummy = slide / bolt,
//     VolAnimationDummy = pump / shell, ...), which export-model.mjs already writes as GLB nodes with the meshes as
//     children. Clips also carry tracks named after geometry leaves (Model_Handle, Model_Marazine, Model_Magazine ...):
//     those are not bones (i3Geometry under the bone, identity local), the engine binds tracks to the skeleton only, so
//     they are dropped (else three.js would bind them to the GLB mesh nodes of the same name).
// Output (fetched lazily per equipped weapon by src/weapons/weaponAnim.ts):
//   index.json  { sets: [{ ai, states: {<State>: {clip, dur}} }], models: {<model id>: set}, libs: {<clip>: lib file} }
//   lib/<pack>.json  { source, clips: {<clip path lower>: {name, duration, tracks: [{node, times, T?, R?}]}} }
//   Times in seconds, T metres (bone-local i3 space), R quaternion x,y,z,w (glTF convention, as in the APF pools).
import { assetPath, clientPath, sourcePath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanI3R2 } from './i3r2/i3r2.mjs';
import { readAnimPack, sampleTrack } from './i3r2/skin-anim.mjs';
import { readBody, readSkeleton } from './i3r2/skin.mjs';

const PACKS = clientPath(baseClient(['cross']), 'Pack'); // Cross only: Weapon_*.i3Pack of the Cross weapon AI; other clients fail with a message
const ASSETS = assetPath('weapons');
const OUT = path.join(ASSETS, 'anim');
const low = (p) => p.replace(/\\/g, '/').toLowerCase();

// ---- pack readers -------------------------------------------------------------------------------
/** i3AIState list of a weapon pack: [{ name, clip (i3a path) | null, dur }] */
// last: a pack with two i3Charas (Weapon_C5: BombTrigger = detonator AI first, C5_E = brick AI last) -> the last AI only
// Otherwise every i3AIContext scene is merged: the 1st wins, the next ones fill states that are absent or have no clip
// (K5: the Fire clip is in the 2nd AI; 49 of 52 multi-AI packs only repeat the same AI per LOD). [INFERIDO]: the exe's pick among them.
export function readWeaponAI(d, last = false) {
  const scenes = readWeaponAIs(d);
  if (!scenes.length) return null;
  if (last) return scenes[scenes.length - 1];
  return mergeAI(scenes);
}

/** first AI wins; later ones fill absent states and states with a null clip */
function mergeAI(list) {
  const out = list[0].map((x) => ({ ...x }));
  for (const ai of list.slice(1)) for (const s of ai) {
    const cur = out.find((x) => x.name === s.name);
    if (!cur) out.push({ ...s });
    else if (!cur.clip && s.clip) { cur.clip = s.clip; cur.dur = s.dur; }
  }
  return out;
}

/** the i3AIState list of every i3AIContext scene of a pack (in file order) */
export function readWeaponAIs(d) {
  const res = [];
  for (const b of scanI3R2(d).filter((x) => x.objects.some((o) => o.cls === 'i3AIContext'))) res.push(readScene(d, b));
  return res;
}

function readScene(d, b) {
  const out = [];
  for (const o of b.objects) {
    if (o.cls !== 'i3AIState' || o.ext) continue;
    const nl = d[o.off], name = d.toString('latin1', o.off + 1, o.off + 1 + nl), p = o.off + 1 + nl;
    if (d.toString('latin1', p, p + 4) !== 'AIS1') throw new Error(`i3AIState ${name}: no AIS1 tag`);
    const a = b.byId.get(d.readUInt16LE(p + 16));
    let q = p + 20;
    while (q + 12 <= o.off + o.size && !(d.readUInt32LE(q) === 0xffffffff && d.readUInt32LE(q + 4) === 0xffffffff)) q++;
    const dur = q + 12 <= o.off + o.size ? d.readFloatLE(q + 8) : 0;
    out.push({ name, clip: a?.cls === 'i3Animation' && a.extPath ? a.extPath : null, dur: +dur.toFixed(4) });
  }
  return out;
}

/**
 * Aggregated packs (Weapon_Weapon, Weapon_Weapon Piercing Blow): many weapon AIs in one pack. Indexed by the folder of their
 * clips (weapon/<folder>/resource/...), NOT by the i3Chara name (the VSK94 AI is called "AUG-A3", the RPD one "RPD Silver").
 * norm(folder) -> merged AI. [INFERIDO]: Weapon_Weapon before "Piercing Blow" when both define the same state.
 */
const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function readAggregatedAI(d) {
  const byFolder = new Map();
  for (const ai of readWeaponAIs(d)) {
    const count = new Map();
    for (const x of ai) { const f = (x.clip && low(x.clip).match(/^weapon\/([^/]+)\//) || [])[1]; if (f) count.set(f, (count.get(f) || 0) + 1); }
    const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!top) continue;
    const k = normKey(top);
    byFolder.set(k, byFolder.has(k) ? mergeAI([byFolder.get(k), ai]) : ai);
  }
  return byFolder;
}
const AGG_PACKS = ['Weapon_Weapon', 'Weapon_Weapon Piercing Blow'];
/** every AI an aggregated pack defines for one clip folder, first pack first */
const aggByFolder = new Map();

/** every APF block embedded in a pack -> readAnimPack() handles */
function embeddedAnimPacks(d) {
  const out = [];
  for (let p = d.indexOf('APF'); p >= 0; p = d.indexOf('APF', p + 1)) {
    if (!/^APF[123]$/.test(d.toString('latin1', p, p + 4))) continue;
    const base = d.readUInt32LE(p + 0x14), size = d.readUInt32LE(p + 0x1c), n = d.readUInt32LE(p + 4);
    if (base !== 0xa4 + n * 284 || p + base + size > d.length) continue;
    try { out.push(readAnimPack(d.subarray(p, p + base + size))); } catch { /* false positive */ }
  }
  return out;
}

/** skeleton bone names of the pack's LOD 0 (the only nodes a clip track binds to) */
function skeletonBones(d) {
  const scene = scanI3R2(d).find((b) => b.objects.some((o) => o.cls === 'i3Body'));
  if (!scene) return null;
  const body = readBody(d, scene, scene.objects.find((o) => o.cls === 'i3Body'));
  return new Set(readSkeleton(d, scene, scene.byId.get(body.lods[0].skeleton)).bones.map((b) => b.name));
}

const r5 = (v) => +v.toFixed(5);

/** APF clip -> JSON clip (skeleton-bone tracks only; bones = null keeps every track) */
function clipJson(c, bones) {
  const tracks = [];
  for (const tr of c.tracks) {
    if ((!tr.T && !tr.R) || (bones && !bones.has(tr.bone))) continue;
    const times = tr.times.length ? tr.times : [0];
    const e = { node: tr.bone, times: times.map(r5) };
    // constant channels hold one key: repeat it so every channel has times.length keys
    if (tr.T) e.T = times.flatMap((_, i) => tr.T[Math.min(i, tr.T.length - 1)].map(r5));
    if (tr.R) e.R = times.flatMap((_, i) => tr.R[Math.min(i, tr.R.length - 1)].map(r5));
    tracks.push(e);
  }
  return { name: c.name, duration: r5(c.duration), tracks };
}

// ---- main -------------------------------------------------------------------------------------
const listOnly = process.argv[2] === '--list';
const models = JSON.parse(fs.readFileSync(path.join(ASSETS, 'models', 'index.json'), 'utf8')).weapons;
const packFiles = fs.readdirSync(PACKS).filter((f) => /^Weapon.*\.i3Pack$/i.test(f));
const packByLow = new Map(packFiles.map((f) => [f.toLowerCase().replace(/\.i3pack$/, ''), f]));

// 1) clip library: clip path -> { pack, animPack, index } (first pack holding it wins, the base pack is preferred)
const lib = new Map();
const aggAIs = []; // [{ pack, byFolder }] in AGG_PACKS order
const ais = new Map(); // pack (lower) -> AI states
const ownByPack = new Map(); // pack (lower) -> clip path (lower) -> { pack, A, i }: every clip a pack embeds, even when another pack has the same path
let scanned = 0;
for (const f of packFiles) {
  const d = fs.readFileSync(path.join(PACKS, f));
  scanned++;
  const key = f.replace(/\.i3Pack$/i, '');
  let ai = null;
  try { ai = readWeaponAI(d); } catch (e) { console.warn(`${f}: AI ${e.message}`); }
  if (ai) ais.set(key.toLowerCase(), ai);
  if (AGG_PACKS.includes(key)) { try { aggAIs[AGG_PACKS.indexOf(key)] = readAggregatedAI(d); } catch (e) { console.warn(`${f}: aggregated AI ${e.message}`); } }
  for (const A of embeddedAnimPacks(d)) {
    A.entries.forEach((e, i) => {
      const k = low(e.path), prev = lib.get(k);
      (ownByPack.get(key.toLowerCase()) ?? ownByPack.set(key.toLowerCase(), new Map()).get(key.toLowerCase())).set(k, { pack: key, A, i, own: true, d: null });
      const folder = (k.match(/^weapon\/([^/]+)\//) || [])[1] || '';
      const own = folder && key.toLowerCase().replace(/^weapon_/, '') === folder;
      if (!prev || (own && !prev.own)) lib.set(k, { pack: key, A, i, own, d: null });
    });
  }
}
for (const by of aggAIs) if (by) for (const [k, a] of by) aggByFolder.set(k, aggByFolder.has(k) ? mergeAI([aggByFolder.get(k), a]) : a);
console.log(`aggregated AIs: ${aggByFolder.size} clip folders`);
console.log(`scanned ${scanned} weapon packs: ${ais.size} with an AI, ${lib.size} distinct weapon clips`);

// 2) model -> AI (the 2017 pack of the same name; else the model's own source pack for the state -> clip names only)
const sets = [], setKey = new Map(), byModel = {}, missing = {};
const used = new Map(); // clip path -> lib entry
for (const m of models) {
  let ai = m.projectileOf ? null : ais.get(m.pack.toLowerCase()), aiFrom = ''; // projectileOf: the thrown brick (C5) has its own AI in the pack
  // aggregated AIs (Weapon_Weapon*): fill states that are absent / have no clip, or give the whole AI when the pack has none.
  // The aggregated AI is the one whose clip folder is the pack suffix (normalized). [INFERIDO]: which AI the exe prefers when both define a state.
  const aggFill = m.projectileOf ? null : aggByFolder.get(normKey(m.pack.replace(/^weapon_/i, '')));
  const aggStates = new Set();
  if (aggFill) {
    if (!ai) { ai = aggFill.map((x) => ({ ...x })); aggStates.add('*'); }
    else {
      ai = ai.map((x) => ({ ...x }));
      for (const s of aggFill) {
        const cur = ai.find((x) => x.name === s.name);
        if (!cur) { ai.push({ ...s }); aggStates.add(s.name); }
        else if (!cur.clip && s.clip) { cur.clip = s.clip; cur.dur = s.dur; aggStates.add(s.name); }
      }
    }
  }
  if (!ai && m.source && sourcePath(m.source)) {
    try { ai = readWeaponAI(fs.readFileSync(sourcePath(m.source)), !!m.projectileOf); aiFrom = m.client || 'source'; } catch { ai = null; }
  }
  // a pack with its own clips but no AI (BallisticKnife_GRS: another skeleton, same clip paths as the base pack): the AI of the
  // pack whose Idle/Fire clips it embeds, with the clips read from the model's own pack
  const mine = ownByPack.get(m.pack.toLowerCase());
  const mineKey = (c) => `${m.pack.toLowerCase()}|${low(c)}`;
  if (!ai && mine && m.family === 'ballisticknife') {
    for (const [pk, a] of ais) {
      const need = a.filter((x) => x.clip && (x.name === 'Idle' || x.name === 'Fire'));
      if (need.length === 2 && need.every((x) => mine.has(low(x.clip)))) { ai = a; aiFrom = `${pk} AI, own clips`; break; }
    }
  }
  if (!ai) { missing[m.id] = 'no weapon AI'; continue; }
  const states = {};
  const ownClips = aiFrom.endsWith('own clips');
  for (const s of ai) {
    if (!s.clip) continue;
    const k0 = low(s.clip), mh = ownClips ? mine.get(k0) : null, hit = mh ?? lib.get(k0), k = mh ? mineKey(s.clip) : k0;
    if (!hit) { if (!aggStates.has('*') && !aggStates.has(s.name)) (missing[m.id] ||= []).push?.(s.clip); continue; }
    states[s.name] = { clip: k, dur: s.dur };
    used.set(k, hit);
  }
  if (!Object.keys(states).length) { if (!missing[m.id]) missing[m.id] = 'no clip in the Cross packs'; continue; }
  const sk = JSON.stringify(states);
  if (!setKey.has(sk)) { setKey.set(sk, sets.length); sets.push({ ai: m.pack + (aiFrom ? ` (${aiFrom} AI)` : ''), states }); }
  byModel[m.id] = setKey.get(sk);
}
const skinBase = []; // models with no AI at all that took the set of their base gun (group D)
// Skins whose own pack lacks some clips (e.g. l115a1_gold has no Reload.i3a; the mesh and dummies are the base gun's):
// use the complete set of the base gun (skinOf, else the longest id prefix that resolved with no missing clips).
for (const m of models) {
  const noAi = missing[m.id] === 'no weapon AI';
  if (!noAi && (!Array.isArray(missing[m.id]) || byModel[m.id] === undefined)) continue;
  const toks = m.id.split('_');
  let base = m.skinOf && byModel[m.skinOf] !== undefined && !missing[m.skinOf] ? m.skinOf : null;
  for (let n = toks.length - 1; !base && n > 0; n--) {
    const cand = toks.slice(0, n).join('_');
    if (byModel[cand] !== undefined && !missing[cand]) base = cand;
  }
  if (base) { byModel[m.id] = byModel[base]; missing[m.id] = { usesBase: base, lacked: missing[m.id] }; if (noAi) skinBase.push(m.id); }
}

console.log(`no-AI skins on the base set: ${skinBase.length}`);
if (listOnly) {
  for (const id of process.argv.slice(3)) {
    const s = sets[byModel[id]];
    console.log(id, s ? s.ai : `-- ${JSON.stringify(missing[id])}`);
    if (s) for (const [n, v] of Object.entries(s.states)) console.log(`   ${n.padEnd(20)} ${v.dur.toFixed(3)}s  ${v.clip}  [${used.get(v.clip).pack}]`);
  }
  process.exit(0);
}

// 3) write the libraries (one per owner pack, only the clips some model uses)
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
const usersOf = new Map(); // clip key -> Set of model packs whose set plays it
for (const m of models) {
  const set = sets[byModel[m.id]];
  if (set) for (const v of Object.values(set.states)) (usersOf.get(v.clip) ?? usersOf.set(v.clip, new Set()).get(v.clip)).add(m.pack);
}
const isAgg = (pack) => /^Weapon_Weapon(AnimPack| |$)/i.test(pack);
const skelCache = new Map();
const skelOf = (pack) => {
  const kk = pack.toLowerCase();
  if (!skelCache.has(kk)) { const f = packByLow.get(kk); skelCache.set(kk, f ? skeletonBones(fs.readFileSync(path.join(PACKS, f))) : null); }
  return skelCache.get(kk);
};
/** union of the skeletons of the models using the clip; null (keep every track) when none has a body */
const unionBones = (k) => {
  const u = new Set();
  for (const mp of usersOf.get(k) ?? []) for (const b of skelOf(mp) ?? []) u.add(b);
  return u.size ? u : null;
};
const byPack = new Map();
for (const [k, h] of used) (byPack.get(h.pack) ?? byPack.set(h.pack, []).get(h.pack)).push([k, h]);
const libs = {};
let clips = 0, bad = 0, bytes = 0;
for (const [pack, list] of byPack) {
  const d = fs.readFileSync(path.join(PACKS, packByLow.get(pack.toLowerCase())));
  const bones = isAgg(pack) ? null : skeletonBones(d);
  const out = { source: `Clients/PBKaybo/GameData/Apps/PB/Pack/${pack}.i3Pack`, tool: 'export-weapon-anim.mjs', clips: {} };
  for (const [k, h] of list) {
    try { out.clips[k] = clipJson(h.A.clip(h.i), isAgg(pack) ? unionBones(k) : bones); clips++; } catch (e) { bad++; console.warn(`${pack}: ${k} ${e.message}`); continue; }
    libs[k] = `lib/${pack.toLowerCase()}.json`;
  }
  const s = JSON.stringify(out);
  bytes += s.length;
  fs.writeFileSync(path.join(OUT, 'lib', `${pack.toLowerCase()}.json`), s);
}
// states whose clip failed to parse are dropped
for (const s of sets) for (const [n, v] of Object.entries(s.states)) if (!libs[v.clip]) delete s.states[n];
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ generated: new Date().toISOString(), tool: 'export-weapon-anim.mjs',
  source: 'Clients/PBCross/Pack (PBCross client)', sets, models: byModel, libs, missing }));
console.log(`models with anim ${Object.keys(byModel).length}/${models.length}, ${sets.length} state sets, ${clips} clips (${bad} unreadable) in ${byPack.size} libs, ${(bytes / 1024).toFixed(0)} KiB`);
