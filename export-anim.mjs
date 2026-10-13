#!/usr/bin/env node
// Point Blank character animations (Chara/<Name>/*.i3AnimPack) -> glTF animation clips, pure Node ESM.
//
//   node export-anim.mjs list SWAT_Male [regex]    # list the clips of the character's anim packs
//   node export-anim.mjs pose <model.glb> [clip]   # validate: skin at bind + posed by a clip
//
// Clips are embedded by export-model.mjs into chars/<name>/model.glb (3rd person) and arms_1pv.glb (1st person).
// The game layers animations: "Low_*" clips drive Root/Pelvis/legs, "Up_*" clips drive IK/spine/arms, so the raw
// layer clips can be mixed in three.js (two AnimationActions on disjoint bones). For convenience the model also
// carries full-body clips (idle, walk, run, crouch, jump, fire, reload, death, ...) = union of one Low + one Up
// clip; the shorter looping layer is repeated to the longer duration. Clips name tracks by bone (= node name).
// Track values are i3 bone-local TRS (asset space), which is what the joint nodes carry: no conversion needed.

import { clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAnimPack } from './i3r2/skin-anim.mjs';
import { readGLB } from './i3r2/skin-glb.mjs';
import { compose, invert, xformPoint } from './i3r2/skin.mjs';
import { mul } from './i3r2/scene.mjs';

// 3.123 folder, read only by the CLI `list` (export-model passes its own animDir)
const gameDir = () => clientPath(baseClient(['br3123']));

// [clip name, pack suffix, path regex (lower-cased path, after 'chara/<name>/')]
const RAW_3PV = [
  ...['Idle', 'WalkFront', 'WalkBack', 'WalkLeft', 'WalkRight', 'MoveFront', 'MoveBack', 'MoveLeft', 'MoveRight'].flatMap((m) => [
    [`Low_Stand_${m}`, 'Common', `3pv/common/low_stand_${m.toLowerCase()}.i3a`], [`Low_Sit_${m}`, 'Common', `3pv/common/low_sit_${m.toLowerCase()}.i3a`]]),
  ['Low_JumpStart', 'Common', '3pv/common/low_jumpstart.i3a'], ['Low_JumpEnd', 'Common', '3pv/common/low_jumpend.i3a'],
  ...['AttackIdle', 'Attack', 'Move_AttackIdle', 'Move_Attack', 'AttackIdle_Zoom', 'Attack_Zoom', 'Change', 'DamageFrontLeftA', 'DamageBackA'].map((m) =>
    [`assault/Up_${m}`, 'Assault', `3pv/assultrifle/common/up_${m.toLowerCase()}.i3a`]),
  ['assault/AK47/Up_Reload', 'Assault', '3pv/assultrifle/ak47/up_reload.i3a'], ['assault/AK47/Up_Change', 'Assault', '3pv/assultrifle/ak47/up_change.i3a'],
  // Inventory/lobby showroom pose: full-skeleton clip (not a Low/Up layer), weapon lowered/relaxed, not aiming.
  ['ui_idle', 'Assault', '3pv/assultrifle/ui/ui_idlea.i3a'],
  ...['AttackIdle', 'Attack', 'Move_AttackIdle', 'Move_Attack', 'DamageFrontLeftA'].map((m) => [`handgun/Up_${m}`, 'HandGun', `3pv/handgun/common/up_${m.toLowerCase()}.i3a`]),
  ...['AttackIdle', 'Attack', 'AttackStab', 'Change', 'Move_AttackIdle'].map((m) => [`knife/Up_${m}`, 'Knife', `3pv/knife/common/up_${m.toLowerCase()}.i3a`]),
  ...['Front', 'Back', 'Left', 'Right'].flatMap((s) => ['A', 'B', 'H'].map((v) => [`Stand_Death${s}${v}`, 'Death', `death/stand_death${s.toLowerCase()}${v.toLowerCase()}1?.i3a`])),
  ...['Front', 'Back'].map((s) => [`Sit_Death${s}A`, 'Death', `death/sit_death${s.toLowerCase()}a1?.i3a`]),
];
// full-body convenience clips: [name, low clip, up clip, loop]
const COMBINED_3PV = [
  ['idle', 'Low_Stand_Idle', 'assault/Up_AttackIdle', true], ['walk', 'Low_Stand_WalkFront', 'assault/Up_Move_AttackIdle', true],
  ['run', 'Low_Stand_MoveFront', 'assault/Up_Move_AttackIdle', true], ['crouch', 'Low_Sit_Idle', 'assault/Up_AttackIdle', true],
  ['crouch_walk', 'Low_Sit_MoveFront', 'assault/Up_Move_AttackIdle', true], ['jump', 'Low_JumpStart', 'assault/Up_AttackIdle', false],
  ['land', 'Low_JumpEnd', 'assault/Up_AttackIdle', false], ['fire', 'Low_Stand_Idle', 'assault/Up_Attack', false],
  ['reload', 'Low_Stand_Idle', 'assault/AK47/Up_Reload', false], ['change', 'Low_Stand_Idle', 'assault/AK47/Up_Change', false],
  ['pistol_idle', 'Low_Stand_Idle', 'handgun/Up_AttackIdle', true], ['pistol_fire', 'Low_Stand_Idle', 'handgun/Up_Attack', false],
  ['knife_idle', 'Low_Stand_Idle', 'knife/Up_AttackIdle', true], ['knife_attack', 'Low_Stand_Idle', 'knife/Up_Attack', false],
  ['death', 'Stand_DeathFrontA', null, false],
];
const RAW_1PV = [
  ...['AttackIdle', 'Attack', 'Move_AttackIdle', 'Attackidle_Zoom', 'JumpStart_AttackIdle', 'JumpEnd_AttackIdle', 'Damage_AttackIdle'].map((m) =>
    [`assault/${m}`, 'Assault', `1pv/assultrifle/common/${m.toLowerCase()}.i3a`]),
  ...['Attack_Semi', 'Attack_Burst', 'Reload_A', 'Reload_B', 'Change'].map((m) => [`assault/AK47/${m}`, 'Assault', `1pv/assultrifle/ak47/${m.toLowerCase()}.i3a`]),
  ...['AttackIdle', 'Attack', 'Move_AttackIdle'].map((m) => [`handgun/${m}`, 'HandGun', `1pv/handgun/common/${m.toLowerCase()}.i3a`]),
  ...['AttackIdle', 'Attack_A', 'Attack_B', 'Attack_Stab', 'Change', 'Move_AttackIdle'].map((m) => [`knife/${m}`, 'Knife', `1pv/knife/common/${m.toLowerCase()}.i3a`]),
];
const ALIAS_1PV = [['idle', 'assault/AttackIdle'], ['move', 'assault/Move_AttackIdle'], ['fire', 'assault/AK47/Attack_Semi'],
  ['reload', 'assault/AK47/Reload_A'], ['change', 'assault/AK47/Change'], ['pistol_idle', 'handgun/AttackIdle'], ['pistol_fire', 'handgun/Attack'],
  ['knife_idle', 'knife/AttackIdle'], ['knife_attack', 'knife/Attack_A']];

function packFor(dir, suffix) {
  const f = fs.readdirSync(dir).find((n) => new RegExp(`^Chara_[A-Za-z_]+?_${suffix}\\.i3AnimPack$`, 'i').test(n));
  return f ? path.join(dir, f) : null;
}

// Repeat a layer clip's tracks until `total` seconds (looping layers shorter than their partner).
function loopTracks(clip, total) {
  const d = clip.duration;
  if (!(d > 0) || d >= total - 1e-4) return clip.tracks;
  return clip.tracks.map((t) => {
    const times = [], T = t.T && t.T.length > 1 ? [] : t.T, R = t.R && t.R.length > 1 ? [] : t.R;
    for (let k = 0; k * d < total - 1e-4; k++) t.times.forEach((tt, i) => {
      const at = tt + k * d;
      if (at > total + 1e-4 || (times.length && at <= times[times.length - 1] + 1e-5)) return;
      times.push(at);
      if (t.T && t.T.length > 1) T.push(t.T[i]);
      if (t.R && t.R.length > 1) R.push(t.R[i]);
    });
    return { ...t, times, T, R };
  });
}

// Load the clips of a character for a view ('3pv' | '1pv'): [{ name, duration, tracks, source }].
export function charaClips(dir, name, view) {
  const raw = view === '3pv' ? RAW_3PV : RAW_1PV;
  const packs = new Map(), out = new Map();
  for (const [clipName, suffix, re] of raw) {
    if (!packs.has(suffix)) { const f = packFor(dir, suffix); packs.set(suffix, f ? readAnimPack(f) : null); }
    const P = packs.get(suffix);
    if (!P) continue;
    const rx = new RegExp(`^chara/[^/]+/(.*/)?${re.replace(/\./g, '\\.')}$`, 'i');
    const i = P.entries.findIndex((e) => rx.test(e.path));
    if (i < 0) continue;
    try {
      const c = P.clip(i);
      out.set(clipName, { name: clipName, duration: c.duration, tracks: c.tracks, source: path.basename(P.file) + ':' + c.path });
    } catch (e) { console.warn(`  ${name}: ${clipName} skipped (${e.message})`); }
  }
  const clips = [...out.values()];
  if (view === '3pv') {
    for (const [cn, lowName, upName, loop] of COMBINED_3PV) {
      const low = out.get(lowName), up = upName ? out.get(upName) : null;
      if (!low || (upName && !up)) continue;
      if (!up) { clips.push({ ...low, name: cn, source: low.source }); continue; }
      const total = loop ? Math.max(low.duration, up.duration) : up.duration;
      const lowTracks = loopTracks(low, total), upTracks = loopTracks(up, total);
      const upBones = new Set(upTracks.map((t) => t.bone));
      clips.push({ name: cn, duration: total, tracks: [...lowTracks.filter((t) => !upBones.has(t.bone)), ...upTracks], source: `${lowName} + ${upName}` });
    }
  } else {
    for (const [cn, src] of ALIAS_1PV) if (out.get(src)) clips.push({ ...out.get(src), name: cn });
  }
  return clips;
}

// Write clips into a GLB builder; tracks bind to bone nodes by name. Returns [{ name, duration, channels, source }].
export function addClips(G, nodeOf, bones, clips) {
  const J = G.json;
  J.animations ||= [];
  const byName = new Map(bones.map((b, i) => [b.name, nodeOf[i]]));
  const info = [];
  for (const c of clips) {
    const anim = { name: c.name, samplers: [], channels: [], extras: { source: c.source } };
    const inputs = new Map(); // shared time accessors
    const input = (times) => {
      const key = times.join(',');
      if (!inputs.has(key)) inputs.set(key, G.accessor(Float32Array.from(times), 'SCALAR', undefined, { minmax: true }));
      return inputs.get(key);
    };
    for (const t of c.tracks) {
      const node = byName.get(t.bone);
      if (node === undefined) continue;
      for (const [chan, keys, nc] of [['translation', t.T, 3], ['rotation', t.R, 4], ['scale', t.S, 3]]) {
        if (!keys || !keys.length) continue;
        // [PB2017 anomaly] a constant "S" vec3 with a zeroed axis (e.g. Karambit Common/AttackIdle: 0.028,0,0 on
        // every bone) is not a real per-bone rest scale (that never varies per-clip and never zeroes an axis) -
        // applying it collapses every child parented under the bone (the weapon) to a degenerate, invisible mesh.
        if (chan === 'scale' && keys.every((v) => v.some((x) => Math.abs(x) < 1e-4) && v.some((x) => Math.abs(x) > 1e-4))) continue;
        // keep strictly increasing times (drop duplicated keys)
        let times = keys.length === 1 ? [0] : t.times.slice(0, keys.length), vals = keys;
        const keep = times.map((v, i) => i === 0 || v > times[i - 1] + 1e-6);
        if (keep.includes(false)) { times = times.filter((_, i) => keep[i]); vals = keys.filter((_, i) => keep[i]); }
        const out = new Float32Array(vals.length * nc);
        vals.forEach((v, i) => {
          let q = v;
          if (chan === 'rotation') { const l = Math.hypot(...v) || 1; q = v.map((x) => x / l); if (i && q.reduce((s, x, k) => s + x * out[(i - 1) * 4 + k], 0) < 0) q = q.map((x) => -x); }
          out.set(q, i * nc);
        });
        anim.samplers.push({ input: input(times), output: G.accessor(out, nc === 4 ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' });
        anim.channels.push({ sampler: anim.samplers.length - 1, target: { node, path: chan } });
      }
    }
    if (!anim.channels.length) continue;
    J.animations.push(anim);
    info.push({ name: c.name, duration: +c.duration.toFixed(3), channels: anim.channels.length, source: c.source });
  }
  return info;
}

// ---- validation: pose a skinned GLB with a clip and skin its vertices on the CPU --------------------------
const rowFromCol = (m) => Array.from(m); // glTF column-major (column vectors) == our row-major row-vector layout

export function posedMesh(file, clipName, time = 0) {
  const { J, read } = readGLB(file);
  const N = J.nodes;
  const local = N.map((n) => (n.matrix ? rowFromCol(n.matrix) : compose(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1])));
  const trsOf = N.map((n) => ({ t: n.translation || [0, 0, 0], r: n.rotation || [0, 0, 0, 1], s: n.scale || [1, 1, 1] }));
  if (clipName) {
    const a = J.animations.find((x) => x.name === clipName);
    if (!a) throw new Error(`no clip ${clipName}`);
    for (const ch of a.channels) {
      const s = a.samplers[ch.sampler], tIn = read(s.input), v = read(s.output), nc = ch.target.path === 'rotation' ? 4 : 3;
      let i = 0; while (i + 1 < tIn.length && tIn[i + 1] <= time) i++;
      const j = Math.min(i + 1, tIn.length - 1), span = tIn[j] - tIn[i], f = span > 0 ? Math.min(1, Math.max(0, (time - tIn[i]) / span)) : 0;
      let val = Array.from({ length: nc }, (_, k) => v[i * nc + k] + (v[j * nc + k] - v[i * nc + k]) * f);
      if (nc === 4) { const l = Math.hypot(...val); val = val.map((x) => x / l); }
      const key = { translation: 't', rotation: 'r', scale: 's' }[ch.target.path];
      trsOf[ch.target.node][key] = val;
      local[ch.target.node] = compose(trsOf[ch.target.node].t, trsOf[ch.target.node].r, trsOf[ch.target.node].s);
    }
  }
  const parent = new Array(N.length).fill(-1);
  N.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
  const world = new Array(N.length);
  const W = (i) => world[i] || (world[i] = parent[i] < 0 ? local[i] : mul(local[i], W(parent[i])));
  const skin = J.skins[0], ibm = read(skin.inverseBindMatrices);
  const jm = skin.joints.map((jn, k) => mul(Array.from(ibm.subarray(k * 16, k * 16 + 16)), W(jn)));
  const pts = [];
  for (const p of J.meshes[0].primitives) {
    const pos = read(p.attributes.POSITION), jj = read(p.attributes.JOINTS_0), ww = read(p.attributes.WEIGHTS_0);
    for (let v = 0; v < pos.length / 3; v++) {
      const out = [0, 0, 0];
      for (let k = 0; k < 4; k++) { const w = ww[v * 4 + k]; if (!w) continue; const q = xformPoint(jm[jj[v * 4 + k]], pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); out[0] += q[0] * w; out[1] += q[1] * w; out[2] += q[2] * w; }
      pts.push(out, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    }
  }
  const jointPos = Object.fromEntries(skin.joints.map((jn) => [N[jn].name, xformPoint(W(jn), 0, 0, 0)]));
  return { pts, jointPos, clips: (J.animations || []).map((a) => a.name) };
}

export function poseReport(file, clipName, time) {
  const { pts, jointPos } = posedMesh(file, clipName, time);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let maxDisp = 0, sumDisp = 0, n = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const p = pts[i], r = pts[i + 1];
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    const dsp = Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]);
    maxDisp = Math.max(maxDisp, dsp); sumDisp += dsp; n++;
  }
  const r3 = (a) => a.map((v) => +v.toFixed(3));
  const j = (nm) => (jointPos[nm] ? r3(jointPos[nm]) : null);
  return { clip: clipName || '(bind)', time, verts: n, bounds: { min: r3(mn), max: r3(mx) }, height: +(mx[1] - mn[1]).toFixed(3),
    maxDisp: +maxDisp.toFixed(4), meanDisp: +(sumDisp / n).toFixed(4), head: j('Head'), lFoot: j('L Foot'), rFoot: j('R Foot'), rHand: j('R Hand') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  if (cmd === 'list') {
    const dir = path.join(gameDir(), 'Chara', a1);
    for (const f of fs.readdirSync(dir).filter((x) => /\.i3AnimPack$/i.test(x))) {
      let P; try { P = readAnimPack(path.join(dir, f)); } catch (e) { console.log(f, 'unsupported:', e.message); continue; }
      for (const e of P.entries) if (!a2 || new RegExp(a2, 'i').test(e.path)) console.log(f, e.type, e.tracks, e.path);
    }
  } else if (cmd === 'pose') {
    const { clips } = posedMesh(a1);
    const which = a2 ? [a2] : clips;
    console.log(JSON.stringify(poseReport(a1, null, 0)));
    for (const c of which) console.log(JSON.stringify(poseReport(a1, c, a3 ? +a3 : 0.3)));
  } else { console.error('usage: export-anim.mjs list <Chara> [regex] | pose <model.glb> [clip] [time]'); process.exit(2); }
}
