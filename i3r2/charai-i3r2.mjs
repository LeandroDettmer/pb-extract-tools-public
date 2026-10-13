// Point Blank character AI tree, 2017 client (PBKaybo Chara/<Name>/<Name>.I3CHR = I3R2 container), pure Node ESM.
// Same result shape as ./charai.mjs readCharAI (3.123 chunk stream): { '1pv'|'3pv': { lower, upper: { "<Group>/<Weapon>":
// { group, weapon, driver, stances: { AttackIdle|Zoom|...: { <State>: { clip, flags, scale, blend, dur, loop } } } } } }.
//
// Layout (read from PBKaybo SWAT_Male.I3CHR, I3R2 1.9): objects i3AI / i3AIContext / i3AIState / i3Animation (external,
// the .i3a path). Every object payload starts with <u8 len><name>.
//   i3AIContext: name, 'GND1', u32 0, u32 ?, u32 parentContextId (0 = root), 16 x 0, 'AIC1', u32 ?, u32 ownAIId, ...
//   i3AIState:   name, 'AIS1', then (offsets from the end of 'AIS1', same as 3.123):
//                +0 u32 flags (0x00200000 = loop), +12 u32 i3Animation ref, +20 f32 time scale, +24 f32 blend-in (s),
//                +40 f32 duration (s), +116 clip path (to the end of the payload)
// A leaf context's states are serialized right BEFORE it (after the previous context), like the 3.123 stream.
// Tree: Lower{Stand,Sit}  Upper{1PV|3PV{<Group>{<Weapon>{AttackIdle, Zoom, Grenade, ...}}}}. No AI driver names in
// this version (the 3.123 AIDriverCharaUpper_* strings are absent): `driver` = the group name.
import fs from 'node:fs';
import { readI3R2 } from './i3r2.mjs';

export function readCharAI2017(file) {
  const b = fs.readFileSync(file);
  const R = readI3R2(b);
  const nameOf = (o) => b.toString('latin1', o.off + 1, o.off + 1 + b[o.off]);
  const ctx = new Map(); // id -> { name, parent }
  const views = { '1pv': { lower: {}, upper: {} }, '3pv': { lower: {}, upper: {} } };
  let pending = {};
  const leaves = [];
  for (const o of R.objects) {
    if (o.ext || !o.size) continue;
    if (o.cls === 'i3AIState') {
      const name = nameOf(o);
      const p = o.off + 1 + b[o.off];
      if (b.toString('latin1', p, p + 4) !== 'AIS1') continue;
      const q = p + 4;
      const raw = b.toString('latin1', q + 116, o.off + o.size).replace(/\0.*$/s, '');
      const flags = b.readUInt32LE(q);
      pending[name] = {
        clip: /\.i3a$/i.test(raw) ? raw : null, flags, scale: +b.readFloatLE(q + 20).toFixed(4), blend: +b.readFloatLE(q + 24).toFixed(4),
        dur: +b.readFloatLE(q + 40).toFixed(4), loop: (flags & 0x00200000) !== 0,
      };
    } else if (o.cls === 'i3AIContext') {
      const name = nameOf(o);
      const p = o.off + 1 + b[o.off];
      if (b.toString('latin1', p, p + 4) !== 'GND1') continue;
      ctx.set(o.id, { name, parent: b.readUInt32LE(p + 12) });
      if (Object.keys(pending).length) leaves.push({ id: o.id, states: pending });
      pending = {};
    }
  }
  const chain = (id) => { const out = []; for (let c = ctx.get(id); c; c = ctx.get(c.parent)) out.unshift(c.name); return out; };
  for (const { id, states } of leaves) {
    const c = chain(id); // [Lower, Stand] | [Upper, 1PV, AssaultRifle, AUG-A3, AttackIdle]
    if (c[0] === 'Lower' && c.length === 2) {
      const any = Object.values(states).find((x) => x.clip);
      const view = any && /\/1PV\//i.test(any.clip) ? '1pv' : '3pv';
      views[view].lower[c[1]] = states;
    } else if (c[0] === 'Upper' && c.length === 5) {
      const view = c[1].toLowerCase();
      if (!views[view]) continue;
      const [, , group, weapon, stance] = c;
      const w = (views[view].upper[`${group}/${weapon}`] ??= { group, weapon, driver: group, stances: {} });
      w.stances[stance] = states;
    }
  }
  return views;
}
