// PBCross weapon.pef joined per ITEMID, for the anim exporters and tools/audit-weapons-cross.mjs.
//
// The ITEMID of each block comes from cross/weapons/weapons.json (lib/cross-weapons.mjs); extracted/pef-cross/br/Weapon.json
// holds the values. Only PBCross blocks exist here: a weapon PBCross does not ship has no entry (in the 2017 / 3.123 pef
// it would have one; they are not read any more).
import { crossWeaponBlocks } from './lib/cross-weapons.mjs';

let cache = null;
/** Map ITEMID -> { key, cls (pef group), e (PBCross block), linked (LinkedToCharaAI), zoomType (_ZoomType) } */
export function pefById() {
  if (cache) return cache;
  cache = new Map();
  for (const [id, { key, group, w }] of crossWeaponBlocks()) {
    cache.set(id, { key, cls: group, e: w, linked: w.LinkedToCharaAI || null, zoomType: w._ZoomType });
  }
  return cache;
}
