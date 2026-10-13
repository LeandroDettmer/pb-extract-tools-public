// Point Blank character AI tree (Chara/<Name>/<Name>.I3CHR, i3AIContext / i3AIState) -> which .i3a clip each
// animation state plays, per view (1PV/3PV), body layer (Lower/Upper) and weapon (weapon.pef LinkedToCharaAI).
//
// Layout (read from SWAT_Male.I3CHR, 3.123): every tree node is "<len><Name>AI_0" + "<len><Driver>" (+ GND1/AIC1
// chunks). Group/weapon nodes use the generic "AIDriver"; leaf stance nodes use a typed driver
// (AIDriverCharaLower, AIDriverCharaUpper_AssaultRifle, ...). A leaf's states ("<len><State>AIS1" chunks) are
// serialized BEFORE its own name, so pending states belong to the next leaf header:
//   Lower{ [Stand states] Stand, [Sit states] Sit }   Upper/3PV/<Group>/<Weapon>{ [states] AttackIdle, [states] Zoom }
// Upper entries are keyed "<Group>/<Weapon>": one AI name can exist in two groups (HandGun/DesertEagle and
// DualHandGun/DesertEagle).
// AIS1 chunk, offsets from the end of the "AIS1" tag:
//   +0 u32 flags (0x00200000 set on looping states: Idle/Move/Walk*), +20 f32 time scale (1.0),
//   +24 f32 blend-in time (s), +32 8x ff, +40 f32 clip duration (s), +60 u32 path length, +116 path.
import fs from 'node:fs';

export function readCharAI(file) {
  const b = fs.readFileSync(file);
  const s = b.toString('latin1');
  const re = /[\x20-\x7e]{4,}/g;
  const tok = [];
  let m;
  while ((m = re.exec(s))) tok.push([m.index, m[0]]);
  const views = { '1pv': { lower: {}, upper: {} }, '3pv': { lower: {}, upper: {} } };
  let pending = {};
  // generic "AIDriver" headers: a header followed directly by another one is a group (Upper, 3PV, HandGun, ...),
  // the last one before leaf stances is the weapon
  let group = null, weapon = null, sawLeaf = true;
  for (let i = 0; i < tok.length; i++) {
    const [off, t] = tok[i];
    if (t.endsWith('AIS1')) {
      const name = t.slice(0, -4);
      const o = off + t.length;
      if (o + 120 > b.length) continue;
      const len = b.readUInt32LE(o + 60);
      const clip = len > 0 && len < 260 ? b.toString('latin1', o + 116, o + 116 + len).replace(/\0.*$/s, '') : null;
      pending[name] = {
        clip: clip && /\.i3a$/i.test(clip) ? clip : null,
        flags: b.readUInt32LE(o),
        scale: +b.readFloatLE(o + 20).toFixed(4),
        blend: +b.readFloatLE(o + 24).toFixed(4),
        dur: +b.readFloatLE(o + 40).toFixed(4),
        loop: (b.readUInt32LE(o) & 0x00200000) !== 0,
      };
      continue;
    }
    if (!t.endsWith('AI_0')) continue;
    const name = t.slice(0, -4);
    const driver = tok[i + 1]?.[1] ?? '';
    if (driver === 'AIDriver') {
      if (weapon && !sawLeaf) group = weapon;
      weapon = name;
      sawLeaf = false;
      pending = {};
      continue;
    }
    sawLeaf = true;
    if (!/^AIDriverChara/.test(driver)) continue;
    const states = pending;
    pending = {};
    const any = Object.values(states).find((x) => x.clip);
    if (!any) continue;
    const view = /\/1PV\//i.test(any.clip) ? '1pv' : '3pv';
    if (driver === 'AIDriverCharaLower') views[view].lower[name] = states;
    else if (driver.startsWith('AIDriverCharaUpper_')) {
      const key = `${group}/${weapon}`;
      const w = (views[view].upper[key] ??= { group, weapon, driver: driver.slice('AIDriverCharaUpper_'.length), stances: {} });
      w.stances[name] = states;
    }
  }
  return views;
}
