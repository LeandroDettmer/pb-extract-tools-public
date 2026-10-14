// Bakes the real 1PV camera pivot (the Neck bone) for src/gameplay/pbFpsCam.generated.ts.
// Assets: PBCross chars only (arms_1pv.glb, anim1pv, anim3pv/Common.glb); the 2017 exe gives the formula.
//
// PB 2017 exe, CGameCamera_FPS update (0x689980): the FPS camera is
//     M = T(FPSCamPos) * RotY(yaw + pi) * RotAxis(charRight, -pitch) * boneCtx.flinch,  M.pos += Neck.worldPos
// (bone 6 of the human bone table 0xd5d248 = "Neck"; bone 2 "IK" for non-local 3PV cameras). So the eye follows the
// *animated* Neck: the crouch height and the walk/run bob come from the lower-body clips (Low_*: Root/Pelvis/legs),
// the 1PV upper clips (arms_1pv.glb) keep the Neck fixed. This tool composes lower (anim3pv/Common.glb) + upper
// (arms_1pv.glb AttackIdle) on the arms skeleton and samples the Neck in model space (model faces +Z, +Y up, the
// character's right is -X). The chain above the IK bone (bone 2: Root > Pelvis > IK > Spine1..3 > Neck) is the
// upper body that CGameCharaBoneContext turns to the view, so the lower clip's pelvis twist (the 3PV rifle stance
// turns the hips ~30 deg) must not rotate it: Neck = IK(lower + upper) + (Neck - IK)(upper-only pose).
//
//   node tools/camera/bake-fpscam.mjs            -> writes src/gameplay/pbFpsCam.generated.ts
//
// Female skins have no anim3pv export: the swat_male Low_* clips are applied to the swat_female skeleton (the same
// retarget charModel does for 3rd person) -> tagged "derived" in docs/FIDELITY.md.
import { assetPath, generatedPath, rel } from '../lib/paths.mjs';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const CHARS = assetPath('chars');
const OUT = generatedPath("gameplay/pbFpsCam.generated.ts");
const N = 16; // samples per cycle

function load(file) {
  const g = fs.readFileSync(file);
  const jl = g.readUInt32LE(12);
  const J = JSON.parse(g.toString("utf8", 20, 20 + jl));
  const bin = g.subarray(20 + jl + 8);
  delete J.images; delete J.textures; delete J.samplers;
  for (const m of J.materials || []) {
    if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.baseColorTexture;
    delete m.normalTexture; delete m.emissiveTexture;
  }
  let js = Buffer.from(JSON.stringify(J));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const hdr = Buffer.alloc(12);
  hdr.write("glTF", 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (b, t) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length); h.write(t, 4, "latin1"); return Buffer.concat([h, b]); };
  const glb = Buffer.concat([hdr, ch(js, "JSON"), ch(bin, "BIN\0")]);
  return new Promise((res, rej) => new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length), "", res, rej));
}

const LOWER = new Set(["Root", "Pelvis", "L_Thigh", "L_Calf", "L_Foot", "L_Toe", "R_Thigh", "R_Calf", "R_Foot", "R_Toe"]);
const part = (c, lower) => new THREE.AnimationClip(`${c.name}#${lower ? "L" : "U"}`, c.duration,
  c.tracks.filter((t) => LOWER.has(t.name.split(".")[0]) === lower));

const lowClips = (await load(path.join(CHARS, "swat_male/anim3pv/Common.glb"))).animations;
const low = (n) => lowClips.find((c) => c.name === `common/${n}`);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

async function bake(char) {
  const arms = await load(path.join(CHARS, char, "arms_1pv.glb"));
  const model = arms.scene;
  const neck = model.getObjectByName("Neck");
  const ik = model.getObjectByName("IK");
  // PBCross arms_1pv has the assault upper clip only on the female rig; the male rig takes the same assault idle from its
  // assault rifle 1PV set (anim1pv/assultrifle_Common.glb, same rig)
  const idle = arms.animations.find((c) => c.name === "assault/AttackIdle")
    ?? (await load(path.join(CHARS, char, "anim1pv", "assultrifle_Common.glb"))).animations.find((c) => c.name === "assultrifle/Common/AttackIdle");
  const mixer = new THREE.AnimationMixer(model);
  const local = (o) => model.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  let chain = null; // Neck - IK with the upper clip only
  const sample = (lowerClip, cycles = 1) => {
    mixer.stopAllAction();
    const up = mixer.clipAction(part(idle, false)); up.play();
    const lo = lowerClip ? mixer.clipAction(part(lowerClip, true)) : null; lo?.play();
    const dur = lowerClip ? lowerClip.duration : idle.duration;
    const pts = [];
    for (let i = 0; i < N * cycles; i++) {
      const t = (i / (N * cycles)) * dur;
      up.time = t % idle.duration;
      if (lo) lo.time = t;
      mixer.update(0);
      model.updateMatrixWorld(true);
      const n = local(neck), k = local(ik);
      if (!chain) chain = n.clone().sub(k);
      pts.push(lowerClip ? k.add(chain) : n);
    }
    return { dur, pts };
  };
  const mean = (pts) => pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
  // upper-only Neck (bind-pose Root): the viewmodel mounts the arms relative to this point
  const upperOnly = sample(null).pts[0];
  const stand = sample(low("Low_Stand_Idle"));
  const sit = sample(low("Low_Sit_Idle"));
  const standMean = mean(stand.pts), sitMean = mean(sit.pts);
  // bob = Neck - idle mean of the same posture; x = character right (-model X), z = forward (+model Z)
  const curve = (clip, base) => {
    const s = sample(low(clip));
    return { dur: r4(s.dur), right: s.pts.map((p) => r4(-(p.x - base.x))), up: s.pts.map((p) => r4(p.y - base.y)),
      fwd: s.pts.map((p) => r4(p.z - base.z)) };
  };
  return {
    neckUpper: [r4(upperOnly.x), r4(upperOnly.y), r4(upperOnly.z)],
    neckStand: [r4(standMean.x), r4(standMean.y), r4(standMean.z)],
    neckSit: [r4(sitMean.x), r4(sitMean.y), r4(sitMean.z)],
    bob: {
      idle: curve("Low_Stand_Idle", standMean),
      run: curve("Low_Stand_MoveFront", standMean),
      walk: curve("Low_Stand_WalkFront", standMean),
      sitIdle: curve("Low_Sit_Idle", sitMean),
      sitMove: curve("Low_Sit_MoveFront", sitMean),
    },
  };
}

const male = await bake("swat_male");
const female = await bake("swat_female");
const ts = `// GENERATED by tools/camera/bake-fpscam.mjs - do not edit. Neck bone (the PB FPS camera pivot, exe-2017
// CGameCamera_FPS 0x689980) sampled on arms_1pv.glb AttackIdle + anim3pv Low_* clips. Model space in meters: y up;
// bob curves are ${N} samples per clip cycle, offsets from the posture's idle mean (right, up, forward).
export interface NeckBob { dur: number; right: number[]; up: number[]; fwd: number[] }
export interface NeckTable {
  /** Neck with the upper 1PV clip only (Root at bind pose): the viewmodel's arms are mounted relative to it */
  neckUpper: [number, number, number];
  /** time-mean Neck, Low_Stand_Idle / Low_Sit_Idle + AttackIdle */
  neckStand: [number, number, number];
  neckSit: [number, number, number];
  bob: { idle: NeckBob; run: NeckBob; walk: NeckBob; sitIdle: NeckBob; sitMove: NeckBob };
}
export const PB_NECK: { male: NeckTable; female: NeckTable } = ${JSON.stringify({ male, female })};
`;
fs.writeFileSync(OUT, ts);
console.log("wrote", rel(OUT), "male stand", male.neckStand, "sit", male.neckSit, "female stand", female.neckStand, "sit", female.neckSit);
