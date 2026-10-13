// Death ragdoll data of every exported character: the PhysX bodies and D6 joints stored in its Chara_<X>.i3Pack.
//   node export-ragdoll.mjs            -> out/chars/<id>/ragdoll.json (ids of chars/index.json)
//
// Source: the PBCross Chara_<X>.i3Pack of each character (chara source in chars/index.json); no other client.
// Layouts (RE of i3SceneDx.dll; the Cross packs use the same objects):
// i3Skeleton       u32 shapeSetId[boneCount] (tools/i3r2/skin.mjs): one i3PhysixShapeSet per ragdoll bone
// i3PhysixShapeSet u8 nameLen + name, then 'PXA3' header (i3PhysixShapeSet::OnLoad 0x100d1480, 0x44 bytes):
//                  +0x0c u32 cooked stream size, +0x24 f32 restitution (getRestitution reads it), +0x28 f32 static
//                  friction, +0x2c f32 dynamic friction, +0x30 u32 i3PhysixJointInfoD6 id (setJointInfo; 0 = root),
//                  +0x38 f32 mass (= the NxBodyDesc mass inside the NXUSTREAM that follows: 10 / 6.5 / 4 ... kg)
//                  The stream holds the cooked convex hull (NXS\1 CVXM, bone-local, the same hulls as the hit boxes).
// i3PhysixJointInfoD6 0x198 bytes: 'PJI1', then (i3PhysixJointInfo::OnLoad 0x100c8f00 + SetTo 0x100c9270)
//                  f32[3] localAxis[0], localAxis[1], localNormal[0], localNormal[1], localAnchor[0], localAnchor[1],
//                  maxForce, maxTorque, u32 jointFlags; then D6 (OnLoad 0x100c9cc0) at +0x68: u32 x/y/z/swing1/swing2/
//                  twist motion (0 locked, 1 limited, 2 free), soft limits linear, swing1, swing2, twistLow, twistHigh as
//                  f32 {value, spring, damping, restitution} (the file order; NxJointLimitSoftDesc is value, restitution,
//                  spring, damping). Actor 0 = the parent bone's body, actor 1 = this bone's (CreateJoint 0x100ceb30).
// Hit part per shape name = CGameCharaCollisionContext::_GetHitHuman 0x817f10 (exe 2017).
import { assetPath, fail, sourcePath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack } from './export-model.mjs';
import { invert, readSkeleton, scanConvexHulls, xformPoint } from './i3r2/skin.mjs';
import { mul } from './i3r2/scene.mjs';

const CHARS = assetPath('chars');

/** CHARA_HIT_PART of a ragdoll shape (0x817f10: switch on the name's letters) */
export function hitPartOf(n) {
  const c = (i) => n[i] ?? '';
  switch (c(0)) {
    case 'A': return c(1) === 'U' ? (c(3) === 'L' ? 13 : 16) : c(3) === 'L' ? 14 : 17; // upper arm / forearm L, R
    case 'B':
      if (c(2) === 'N') return 5; // neck
      if (c(2) === 'S') return { 1: 2, 2: 3, 3: 4 }[c(7)] ?? 1; // spine 1-3
      if (c(4) === 'C') return c(2) === 'L' ? 11 : 12; // clavicle
      return c(6) === 'H' ? 34 : 1; // root
    case 'F': return c(2) === 'L' ? 23 : 26; // foot
    case 'H': return c(1) === 'N' ? (c(3) === 'L' ? 15 : 18) : 34; // hand / head
    case 'L': return c(1) === 'U' ? (c(3) === 'L' ? 19 : 20) : c(3) === 'L' ? 21 : 24; // thigh / calf
    case 'M': return c(2) === 'd' ? 34 : 0;
    default: return 0;
  }
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const vec = (d, o) => [0, 1, 2].map((k) => r4(d.readFloatLE(o + k * 4)));

function readJoint(d, o) {
  if (d.toString('latin1', o, o + 4) !== 'PJI1') throw new Error(`joint @${o}: not PJI1`);
  const f = (k) => d.readFloatLE(o + k * 4), u = (k) => d.readUInt32LE(o + k * 4);
  const lim = (k) => [f(k), f(k + 1), f(k + 2), f(k + 3)].map(r4); // value, spring, damping, restitution
  return {
    axis: [vec(d, o + 4), vec(d, o + 16)],
    normal: [vec(d, o + 28), vec(d, o + 40)],
    anchor: [vec(d, o + 52), vec(d, o + 64)],
    motion: [26, 27, 28, 29, 30, 31].map(u),
    swing1: lim(36), swing2: lim(40), twistLow: lim(44), twistHigh: lim(48),
  };
}

export function ragdollOf(packPath) {
  const P = loadPack(path.basename(packPath, '.i3Pack'), { packDir: path.dirname(packPath) });
  const { d, scene } = P;
  const shapeObjs = scene.objects.filter((o) => o.cls === 'i3PhysixShapeSet');
  const hulls = scanConvexHulls(d, scene.base);
  if (!shapeObjs.length || hulls.length !== shapeObjs.length) throw new Error(`${packPath}: ${hulls.length} hulls vs ${shapeObjs.length} shape sets`);
  // the skeleton whose bones carry the shape sets (the body LODs share them)
  const sk = scene.objects.filter((o) => o.cls === 'i3Skeleton').map((o) => readSkeleton(d, scene, o))
    .sort((a, b) => b.bones.filter((x) => x.shapeSet).length - a.bones.filter((x) => x.shapeSet).length)[0];
  const bones = sk.bones;
  const bodies = [];
  let worstAnchor = 0;
  for (const b of bones) {
    if (!b.shapeSet) continue;
    const k = shapeObjs.findIndex((o) => o.id === b.shapeSet);
    const so = shapeObjs[k];
    const name = d.toString('latin1', so.off + 1, so.off + 1 + d[so.off]);
    const h = so.off + 1 + d[so.off];
    if (d.toString('latin1', h, h + 3) !== 'PXA') throw new Error(`${name}: no PXA header`);
    const jointId = d.readUInt32LE(h + 0x30);
    // parent body = nearest ancestor bone with a shape set
    let p = b.parent;
    while (p >= 0 && !bones[p].shapeSet) p = bones[p].parent;
    const body = {
      bone: b.name, shape: name, part: hitPartOf(name), parent: p >= 0 ? bones[p].name : null,
      mass: r4(d.readFloatLE(h + 0x38)), restitution: r4(d.readFloatLE(h + 0x24)),
      friction: [r4(d.readFloatLE(h + 0x28)), r4(d.readFloatLE(h + 0x2c))],
      hull: hulls[k].verts.map((v) => v.map(r4)),
      joint: null,
    };
    if (jointId) {
      const jo = scene.byId.get(jointId);
      if (jo?.cls !== 'i3PhysixJointInfoD6') throw new Error(`${name}: joint #${jointId} is ${jo?.cls}`);
      if (p < 0) throw new Error(`${name}: joint without a parent body`);
      body.joint = readJoint(d, jo.off);
      // check: anchor 0 = this bone's origin in the parent bone's frame (actor 0 = parent)
      const o = xformPoint(mul(b.world, invert(bones[p].world)), 0, 0, 0);
      worstAnchor = Math.max(worstAnchor, Math.hypot(...o.map((v, i) => v - body.joint.anchor[0][i])));
    }
    bodies.push(body);
  }
  return { bodies, worstAnchor };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = JSON.parse(fs.readFileSync(path.join(CHARS, 'index.json'), 'utf8'));
  let ok = 0, bad = 0;
  for (const c of index.chars) {
    const src = sourcePath(c.source) ?? fail(`no client folder for ${c.source}`);
    try {
      const { bodies, worstAnchor } = ragdollOf(src);
      const known = new Set(c.hitboxes?.map((h) => h.bone) ?? []);
      const missing = bodies.filter((b) => known.size && !known.has(b.bone)).map((b) => b.bone);
      fs.mkdirSync(path.join(CHARS, c.name), { recursive: true });
      fs.writeFileSync(path.join(CHARS, c.name, 'ragdoll.json'), JSON.stringify({ source: c.source, tool: 'tools/export-ragdoll.mjs', bodies }));
      console.log(`${c.name}: ${bodies.length} bodies, ${bodies.filter((b) => b.joint).length} joints, anchor err ${worstAnchor.toFixed(4)} m${missing.length ? `, not in GLB hit boxes: ${missing}` : ''}`);
      ok++;
    } catch (e) {
      console.log(`${c.name}: SKIP ${e.message}`);
      bad++;
    }
  }
  console.log(`${ok} ragdolls written, ${bad} skipped`);
}
