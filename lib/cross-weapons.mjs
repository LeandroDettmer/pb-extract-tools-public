// PBCross weapon blocks joined per ITEMID, for the weapon exporters (weaponfx, anim1pv, anim3pv, audit-weapons-cross).
// The Cross Weapon.pef (extracted/pef-cross/br/Weapon.json, written by `pbx re cross-pef`) has no ITEMID. The runtime catalog
// cross/weapons/weapons.json carries it as `id`, and its pb.src names the block: "pef-cross:<Group>/<Key>".
import { assetPath, baseClient, pefDir } from './paths.mjs';
import fs from 'node:fs';

/** extracted/pef-<key>/br/Weapon.json (cross: pef-cross): { WeaponList: { Weapon: { <globals>, <Group>: { <Key>: block } } } } */
export function crossWeaponPef() {
  return JSON.parse(fs.readFileSync(pefDir('br', 'Weapon.json'), 'utf8'));
}

/** ITEMID -> { key, group, w } for every catalog weapon whose pef block is in PBCross. Catalog ids without a block are left out. */
export function crossWeaponBlocks(pef = crossWeaponPef()) {
  const W = pef.WeaponList.Weapon;
  const cat = JSON.parse(fs.readFileSync(assetPath(baseClient('cross'), 'weapons', 'weapons.json'), 'utf8')).weapons;
  const byId = new Map();
  for (const x of cat) {
    const m = /^pef-cross:([^/]+)\/(.+)$/.exec(x.pb?.src ?? '');
    const w = m && W[m[1]]?.[m[2]];
    if (w && typeof w === 'object' && !byId.has(x.id)) byId.set(x.id, { key: m[2], group: m[1], w });
  }
  return byId;
}
