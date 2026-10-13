#!/usr/bin/env node
// Point Blank weapon / character models -> glTF 2.0 (GLB + PNG textures), pure Node ESM, builtins only.
//
//   node export-model.mjs                     # default weapons + characters (see DEFAULTS)
//   node export-model.mjs weapon Weapon_AK-47_SOPMOD_R [...]
//   node export-model.mjs chara SWAT_Male [...]
//   node export-model.mjs --check             # re-validate every GLB listed in the index files
//
// Output
//   out/weapons/models/<id>.glb (+ tex/<id>/*.png) and weapons/models/index.json
//   out/chars/<name>/model.glb  (+ tex/*.png, skin + animation clips, see export-anim.mjs),
//   out/chars/<name>/arms_1pv.glb (first-person arms LOD + 1PV clips) and chars/index.json
//
// Space: every GLB is three.js space (Y-up, metres, see tools/AXES.md). The i3 "AxisRotate" root matrix
// (x, y, z) -> (-x, z, y) is kept as the root node "AxisRotate" above the bone hierarchy, so bone nodes keep
// their i3 local transforms (animation tracks apply unchanged). Skinned vertices are stored already rotated
// (mesh node at the scene root, as glTF requires) and the inverse bind matrices include the root rotation.
// Weapons: the origin is the grip bone "GunDummy" (the point that snaps to the character's hand dummy),
// the barrel points +Z, the muzzle is the bone node "FXDummy" (listed as `muzzle` in index.json / extras).
// Only plain IIA2 index arrays (key == 0) are exported; keyed geometries are skipped and counted.

import { assetPath, clientPath, rel, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanI3R2 } from './i3r2/i3r2.mjs';
import { mul } from './i3r2/scene.mjs';
import { IDENTITY, invert, decompose, xformPoint, xformDir, readBody, readSkeleton, collectBodyMeshes, plainIndices, scanConvexHulls } from './i3r2/skin.mjs';
import { GLB, checkGLB, textureLibrary, readI3IB, decodeI3IB, encodePNG, stem } from './i3r2/skin-glb.mjs';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';
import { charaClips, addClips } from './export-anim.mjs';
import { ddsOf, hasAlphaFast } from './export-visual.mjs';

// 3.123 folder, read only when a caller leaves packDir / animDir out (export-batch passes its own client folders)
const gameDir = () => clientPath(baseClient(['br3123']));
const OUT = process.env.PB_OUT_ROOT || assetPath(); // PB_OUT_ROOT: tools/export-model-dds.mjs writes to a temp dir
export const AXIS = [-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]; // i3 asset (Z-up) -> three (Y-up), row vector

const DEFAULTS = {
  weapons: [
    { pack: 'Weapon_AK-47_PBIC2013', id: 'ak47_pbic2013', kind: 'rifle' },
    { pack: 'Weapon_Aks74u', id: 'aks74u', kind: 'smg' },
    { pack: 'Weapon_SPAS_15_PBSC2013_NonLogo', id: 'spas15_pbsc2013', kind: 'shotgun' },
    { pack: 'Weapon_DesertEagle_GRS', id: 'deserteagle_grs', kind: 'pistol' },
    { pack: 'Weapon_BallisticKnife_GRS', id: 'ballisticknife_grs', kind: 'knife' },
    // plain geometry but the diffuse maps are stored in an obfuscated container (not I3IB): exported untextured
    { pack: 'Weapon_AK-47_SOPMOD_R', id: 'ak47_sopmod_r', kind: 'rifle' },
    { pack: 'Weapon_870MCS_SL', id: '870mcs_sl', kind: 'shotgun' },
  ],
  // Chara_SWAT_Female: every index array is keyed (IIA2 key != 0) -> not exportable; REBEL_* packs are empty stubs.
  charas: [{ name: 'SWAT_Male', team: 'blue' }],
};

// Hit zone of a PhysX shape name (the prefix is the damage part used by the game).
const ZONES = { H: 'head', B: 'body', AU: 'arm', AD: 'arm', HN: 'hand', LU: 'leg', LD: 'leg', F: 'foot' };
const zoneOf = (n) => ZONES[(n.match(/^([A-Z]+)_/) || [])[1]] || 'body';

// packDir: client Pack folder; texFallback: other pack files (same pack name in the other clients) searched for
// textures the pack itself does not carry. maxTex: longest texture side kept (larger maps are box-downscaled).
// texOverride(path) -> I3IB entry | null: replacement maps (weapon skins, see export-batch.mjs).
export function loadPack(packName, { packDir = path.join(gameDir(), 'Pack'), texFallback = [], maxTex = 0, texOverride = null, i3s = null } = {}) {
  const file = path.join(packDir, packName + '.i3Pack');
  const d = fs.readFileSync(file);
  // i3s: a pack can hold several models (Weapon_C5: BombTrigger.I3S = the hand detonator, C5.I3S = the brick): pick the
  // scene stored as that file, else the first one with a body
  let base = null;
  if (i3s) {
    const f = parsePack(d).nodes.flatMap((n) => n.files).find((x) => x.name.toLowerCase() === i3s.toLowerCase() + '.i3s');
    if (!f) throw new Error(`${packName}: no ${i3s}.I3S`);
    base = f.offset;
  }
  const scene = scanI3R2(d).find((b) => b.objects.some((o) => o.cls === 'i3Body') && (base === null || b.base === base));
  if (!scene) throw new Error(`${packName}: no i3Body scene`);
  const body = readBody(d, scene, scene.objects.find((o) => o.cls === 'i3Body'));
  const own = packTextures(d, packName);
  const fallback = (p) => { // fallback packs are opened one by one, only on a miss (and cached across exports)
    for (const f of texFallback) {
      if (!FALLBACK_CACHE.has(f)) FALLBACK_CACHE.set(f, fs.existsSync(f) ? packTextures(fs.readFileSync(f), f) : null);
      const hit = FALLBACK_CACHE.get(f)?.get(p);
      if (hit) return hit;
    }
    return null;
  };
  const tex = { get: (p) => texOverride?.(p) || own.get(p) || fallback(p) };
  return { d, scene, body, tex, maxTex, source: file, ddsOnly: process.env.PB_DDS_ONLY === '1' };
}

const FALLBACK_CACHE = new Map();
// Textures of a pack: I3IB blobs by their embedded source path, plus the pack's file table names (the 2017 client and
// texture-only packs store I3IB without a path; the name then only lives in the i3PackNode entry).
export function packTextures(d, source) {
  const lib = textureLibrary([[d, source]]);
  const named = new Map();
  try {
    for (const n of parsePack(d).nodes) {
      if (n.pfnVer === 'OLD') {
        // 2017 client: embedded I3IB blobs of this node carry no srcPath (see textureLibrary); the
        // node's own file-name table does, in the same physical order (files of a node are contiguous).
        const texNames = n.files.map((f) => f.name).filter((nm) => /\.i3i$/i.test(nm));
        if (!texNames.length) continue;
        const hits = [];
        for (let q = d.indexOf('I3IB', n.dataStart); q >= 0 && q < n.dataEnd; q = d.indexOf('I3IB', q + 4)) hits.push(q);
        texNames.forEach((nm, i) => {
          if (named.has(stem(nm)) || hits[i] == null) return;
          const t = readI3IB(d, hits[i], hits[i + 1] ?? n.dataEnd);
          if (t && t.kind !== 'unsupported') named.set(stem(nm), { ...t, srcPath: nm, buf: d, source });
        });
        continue;
      }
      for (const e of n.files) {
        if (!/.i3i$/i.test(e.name) || e.offset + e.size > d.length || named.has(stem(e.name))) continue;
        let buf = d.subarray(e.offset, e.offset + e.size);
        if (e.attr & 0x08000000) buf = decodeContent(Buffer.from(buf), e.attr);
        const t = buf && readI3IB(buf, 0, buf.length);
        if (t && t.kind !== 'unsupported') named.set(stem(e.name), { ...t, srcPath: t.srcPath || e.name, buf, source });
      }
    }
  } catch { /* not an i3Pack file table */ }
  const stems = new Set(named.keys());
  for (let q = d.indexOf('I3IB'); q >= 0; q = d.indexOf('I3IB', q + 4)) { const t = readI3IB(d, q); if (t?.srcPath) stems.add(stem(t.srcPath)); }
  return { get: (p) => lib.get(p) || named.get(stem(p)) || null, size: lib.size + named.size, stems };
}

// Box-downscale RGBA by 2 until both sides <= max (keeps power-of-two maps power-of-two).
export function shrinkRGBA(rgba, w, h, max) {
  while (max && (w > max || h > max) && w > 1 && h > 1) {
    const nw = w >> 1, nh = h >> 1, out = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let k = 0; k < 4; k++) {
      const i = (a, b) => rgba[((y * 2 + b) * w + x * 2 + a) * 4 + k];
      out[(y * nw + x) * 4 + k] = (i(0, 0) + i(1, 0) + i(0, 1) + i(1, 1) + 2) >> 2;
    }
    rgba = out; w = nw; h = nh;
  }
  return { rgba, w, h };
}

// Texture of an attr-state entry (i3TextureBindAttr / i3NormalMapBindAttr ...) -> I3IB or null.
function stateTexture(P, ao) {
  if (!ao) return null;
  const ref = P.d.readUInt32LE(ao.off), t = P.scene.byId.get(ref) || P.scene.byId.get(ref & 0xffff);
  if (!t) return null;
  if (t.ext) { const hit = t.extPath && P.tex.get(t.extPath); return hit ? { ...hit, ref: t.extPath } : { missing: t.extPath || `ext#${t.id}` }; }
  // embedded i3Texture: the object payload is the I3IB itself
  const inl = t.cls === 'i3Texture' && readI3IB(P.d, t.off, t.off + t.size);
  if (inl) return inl.kind === 'unsupported' ? { missing: inl.srcPath || `i3Texture#${t.id}` } : { ...inl, srcPath: inl.srcPath || `i3Texture_${t.id}`, buf: P.d, source: 'inline' };
  return null;
}

// Materials + PNG writer shared by both exporters (and tools/export-headgear.mjs).
export function materialFactory(G, P, texDir, texUri) {
  const J = G.json;
  J.images = []; J.textures = []; J.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  const texCache = new Map(), matCache = new Map(), missing = new Set();
  // asExtra: Phong N/S maps. The file is written (PNG + DDS twin) but NOT listed in glTF images/textures, so GLTFLoader never
  // downloads it; the material carries its uri in extras (pbNormal / pbSpec) and the client loads it only with its Gráficos toggle.
  const texture = (t, opaque, asExtra = false) => {
    // srcPath is part of the key: file-table textures (2017 packs) each live in their own buffer slice, so source +
    // data offset alone is the same for every map of a pack and the head got the body map (Chara_SWAT_Male 2017)
    const key = t.source + ':' + t.srcPath + ':' + t.data + ':' + opaque + ':' + asExtra;
    if (texCache.has(key)) return texCache.get(key);
    let r = null;
    if (t.kind !== 'unsupported') {
      const name = stem(t.srcPath).replace(/[^\w.-]+/g, '_');
      fs.mkdirSync(texDir, { recursive: true });
      let hasAlpha;
      if (P.ddsOnly) {
        // PB_DDS_ONLY=1 (tools/export-model-dds.mjs): no PNG/decode; the original DXT blocks go out as <name>.dds, only when the
        // PNG would not be box-downscaled (same dimensions as the PNG already on disk).
        let w = t.w, h = t.h;
        while (P.maxTex && (w > P.maxTex || h > P.maxTex) && w > 1 && h > 1) { w >>= 1; h >>= 1; }
        hasAlpha = !opaque && t.kind !== 'raw' && hasAlphaFast(t.buf, t);
        const dds = w === t.w && h === t.h && t.kind !== 'raw' ? ddsOf(t.buf, t, hasAlpha) : null;
        if (dds) fs.writeFileSync(path.join(texDir, name + '.dds'), dds);
        fs.writeFileSync(path.join(texDir, name + '.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // placeholder: checkGLB only wants the file to exist (temp dir)
      } else {
        const sh = shrinkRGBA(decodeI3IB(t.buf, t), t.w, t.h, P.maxTex);
        let minA = 255;
        if (!opaque) for (let i = 3; i < sh.rgba.length; i += 4) if (sh.rgba[i] < minA) minA = sh.rgba[i];
        hasAlpha = minA < 250;
        fs.writeFileSync(path.join(texDir, name + '.png'), encodePNG(sh.rgba, sh.w, sh.h, hasAlpha));
      }
      const uri = `${texUri}/${encodeURIComponent(name)}.png`;
      if (asExtra) r = { uri, hasAlpha };
      else {
        J.images.push({ uri, name });
        J.textures.push({ source: J.images.length - 1, sampler: 0 });
        r = { index: J.textures.length - 1, hasAlpha };
      }
    }
    texCache.set(key, r);
    return r;
  };
  return {
    missing,
    get(state) {
      const flag = (c) => (state[c] ? P.d[state[c].off] !== 0 : null);
      const alphaTest = flag('i3AlphaTestEnableAttr') === true, blend = flag('i3BlendEnableAttr') === true;
      const diff = flag('i3TextureEnableAttr') === false ? null : stateTexture(P, state.i3TextureBindAttr);
      if (diff?.missing) missing.add(stem(diff.missing));
      // diffuse alpha is only transparency when the state enables alpha test / blending (else it's a spec mask)
      const bt = diff && !diff.missing ? texture(diff, !(alphaTest || blend)) : null;
      const cull = state.i3FaceCullModeAttr ? P.d.readUInt32LE(state.i3FaceCullModeAttr.off) : null;
      const alphaMode = bt?.hasAlpha ? (blend && !alphaTest ? 'BLEND' : 'MASK') : 'OPAQUE';
      // Normal map (Phong_*N*, raw D3D data, G NOT flipped: pbLighting CHARA_FS applies the D3D convention) and specular map
      // (Phong_*S*: rgb = colour/2, a = shininess/255) go to material.extras as uris, not glTF textures (see texture()).
      const nrmT = flag('i3NormalMapEnableAttr') === false ? null : stateTexture(P, state.i3NormalMapBindAttr);
      const spcT = flag('i3SpecularMapEnableAttr') === false ? null : stateTexture(P, state.i3SpecularMapBindAttr);
      // a detail map that resolves to the diffuse's own file is a texture-name collision in the source pack (ak-47_f, ladle_*): not a real map
      const notDiff = (t) => (t && J.images[bt.index].uri !== t.uri ? t : null);
      const nt = bt && nrmT && !nrmT.missing ? notDiff(texture(nrmT, true, true)) : null;
      const st = bt && spcT && !spcT.missing ? notDiff(texture(spcT, false, true)) : null;
      // Reflect mask (_Ref / _RefMask, Phong_*RM*: rgb += texCUBE(map cubemap, reflect) * mask.rgb) and emissive (_Emissive + the material's
      // emissive colour, rgb += E * g_vMtlEmissive * 4): same extras mechanism. Cubemap + mask enable attrs must both not be off.
      const refT = flag('i3ReflectMapEnableAttr') === false || flag('i3ReflectMaskMapEnableAttr') === false ? null : stateTexture(P, state.i3ReflectMaskMapBindAttr);
      const emiT = flag('i3EmissiveMapEnableAttr') === false ? null : stateTexture(P, state.i3EmissiveMapBindAttr);
      const rt = bt && refT && !refT.missing ? notDiff(texture(refT, true, true)) : null;
      const et = bt && emiT && !emiT.missing ? notDiff(texture(emiT, true, true)) : null;
      // i3MaterialAttr::OnLoad order: ambient, diffuse, specular, emissive (rgba floats), shininess
      const ma = state.i3MaterialAttr, ec = et && ma ? [0, 1, 2].map((i) => +P.d.readFloatLE(ma.off + 48 + i * 4).toFixed(4)) : null;
      const key = [bt?.index, alphaMode, cull, nt?.uri, st?.uri, rt?.uri, et?.uri, ec].join('|');
      if (matCache.has(key)) return matCache.get(key);
      const mat = { name: diff?.srcPath ? stem(diff.srcPath) : 'untextured', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.8 } };
      if (bt) mat.pbrMetallicRoughness.baseColorTexture = { index: bt.index };
      if (alphaMode !== 'OPAQUE') mat.alphaMode = alphaMode;
      if (alphaMode === 'MASK') mat.alphaCutoff = 0.5;
      if (cull === 1) mat.doubleSided = true;
      if (nt || st || rt || et) mat.extras = { ...(nt && { pbNormal: nt.uri }), ...(st && { pbSpec: st.uri }), ...(rt && { pbRef: rt.uri }), ...(et && { pbEmissive: et.uri, pbEmissiveColor: ec }) };
      J.materials.push(mat);
      matCache.set(key, J.materials.length - 1);
      return J.materials.length - 1;
    },
  };
}

// Compact a GEO2 range of a vertex array into a primitive (optionally transforming positions/normals).
export function buildPrimitive(G, mesh, idx, { matrix = null, joints = null } = {}) {
  const remap = new Map(), order = [];
  const local = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    let r = remap.get(idx[i]);
    if (r === undefined) { r = order.length; remap.set(idx[i], r); order.push(idx[i]); }
    local[i] = r;
  }
  const va = mesh.va, nv = order.length;
  const pos = new Float32Array(nv * 3), nrm = va.nrm ? new Float32Array(nv * 3) : null, uv = va.uv ? new Float32Array(nv * 2) : null;
  const J4 = joints ? new Uint8Array(nv * 4) : null, W4 = joints ? new Float32Array(nv * 4) : null;
  order.forEach((s, i) => {
    let p = [va.pos[s * 3], va.pos[s * 3 + 1], va.pos[s * 3 + 2]];
    if (matrix) p = xformPoint(matrix, ...p);
    pos.set(p, i * 3);
    if (nrm) {
      let n = [va.nrm[s * 3], va.nrm[s * 3 + 1], va.nrm[s * 3 + 2]];
      if (matrix) n = xformDir(matrix, ...n);
      const l = Math.hypot(...n) || 1;
      nrm.set(n.map((v) => v / l), i * 3);
    }
    if (uv) { uv[i * 2] = va.uv[s * 2]; uv[i * 2 + 1] = va.uv[s * 2 + 1]; }
    if (J4) {
      const { j, w } = joints(s);
      J4.set(j, i * 4); W4.set(w, i * 4);
    }
  });
  const attributes = { POSITION: G.accessor(pos, 'VEC3', 34962, { minmax: true }) };
  if (nrm) attributes.NORMAL = G.accessor(nrm, 'VEC3', 34962);
  if (uv) attributes.TEXCOORD_0 = G.accessor(uv, 'VEC2', 34962);
  if (J4) { attributes.JOINTS_0 = G.accessor(J4, 'VEC4', 34962); attributes.WEIGHTS_0 = G.accessor(W4, 'VEC4', 34962); }
  const ind = nv < 65536 ? Uint16Array.from(local) : local;
  return { attributes, indices: G.accessor(ind, 'SCALAR', 34963), mode: 4, tris: idx.length / 3, verts: nv };
}

const trs = (m) => {
  const { t, r, s } = decompose(m);
  const n = {};
  if (t.some((v) => Math.abs(v) > 1e-7)) n.translation = t;
  if (Math.abs(r[3]) < 1 - 1e-7) n.rotation = r;
  if (s.some((v) => Math.abs(v - 1) > 1e-5)) n.scale = s;
  return n;
};
const round = (a, k = 4) => a.map((v) => +v.toFixed(k));

// Bone hierarchy under an "AxisRotate" root node; returns node index per bone.
export function addSkeletonNodes(G, bones, rootChildren) {
  const J = G.json;
  const axisNode = G.node({ name: 'AxisRotate', matrix: AXIS, children: [] });
  const nodeOf = bones.map((b) => G.node({ name: b.name, ...trs(b.local) }));
  bones.forEach((b, i) => {
    const parent = b.parent < 0 ? J.nodes[axisNode] : J.nodes[nodeOf[b.parent]];
    (parent.children ||= []).push(nodeOf[i]);
  });
  rootChildren.push(axisNode);
  return { axisNode, nodeOf };
}

// ---- weapons ------------------------------------------------------------------------------
export function exportWeapon({ pack, id, kind, packDir = path.join(gameDir(), 'Pack'), texFallback = [], texOverride = null, i3s = null, extra = {} }, { outRoot = OUT, log = console.log, maxTex = 0 } = {}) {
  const P = loadPack(pack, { packDir, texFallback, maxTex, texOverride, i3s });
  const lod = P.body.lods[0];
  const sk = readSkeleton(P.d, P.scene, P.scene.byId.get(lod.skeleton));
  const { meshes } = collectBodyMeshes(P.d, P.scene, lod.root);
  const outDir = path.join(outRoot, 'weapons', 'models');
  const texDir = path.join(outDir, 'tex', id);
  fs.rmSync(texDir, { recursive: true, force: true });
  const G = new GLB('pb export-model.mjs');
  const J = G.json;
  const mats = materialFactory(G, P, texDir, `tex/${id}`);
  const { nodeOf } = addSkeletonNodes(G, sk.bones, J.scenes[0].nodes);
  const stats = { tris: 0, verts: 0, keyed: 0, skippedMaster: 0 };
  for (const m of meshes) {
    const leaf = m.name.split('/').pop();
    if (/_Master$/.test(leaf)) { stats.skippedMaster++; continue; } // duplicate "reload master" magazine
    let idx;
    try { idx = plainIndices(m); } catch { stats.keyed++; continue; }
    const prim = buildPrimitive(G, m, idx, { matrix: m.local === IDENTITY ? null : m.local });
    prim.material = mats.get(m.state);
    stats.tris += prim.tris; stats.verts += prim.verts;
    delete prim.tris; delete prim.verts;
    J.meshes.push({ name: leaf, primitives: [prim] });
    const bn = J.nodes[nodeOf[Math.max(0, m.bone)]];
    (bn.children ||= []).push(G.node({ name: leaf, mesh: J.meshes.length - 1 }));
  }
  if (!J.meshes.length) throw new Error(`${pack}: no exportable geometry (keyed ${stats.keyed})`);
  // bone positions in three space (root = grip)
  const at = (name) => { const b = sk.bones.find((x) => x.name === name); return b ? round(xformPoint(mul(b.world, AXIS), 0, 0, 0)) : null; };
  const dummies = Object.fromEntries(sk.bones.map((b) => [b.name, at(b.name)]));
  const muzzle = sk.bones.find((b) => /^FXDummy$/i.test(b.name)) ? 'FXDummy' : null;
  J.scenes[0].name = id;
  J.extras = { source: rel(P.source), axes: 'three.js space: Y-up, metres, origin = grip (GunDummy), barrel +Z', muzzle, grip: 'GunDummy', dummies };
  const glbFile = path.join(outDir, id + '.glb');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(glbFile, G.build());
  const check = checkGLB(glbFile);
  if (!check.ok) throw new Error(`${id}: GLB check failed ${check.errors.join('; ')}`);
  log(`weapon ${id}: ${check.meshes} meshes, ${check.tris} tris, ${check.images} tex, keyed skipped ${stats.keyed}, missing tex [${[...mats.missing]}], muzzle ${muzzle} ${JSON.stringify(dummies[muzzle])}`);
  return { id, kind, ...extra, pack, source: rel(P.source), file: `${id}.glb`, tris: check.tris, meshes: check.meshes, textures: check.images, missingTextures: [...mats.missing], textured: mats.missing.size === 0 && check.images > 0,
    keyedGeometriesSkipped: stats.keyed, bounds: check.bounds, muzzle, muzzlePos: dummies[muzzle] || null, grip: 'GunDummy', dummies };
}

// ---- characters ---------------------------------------------------------------------------
// dummyBones: bone names of the skeleton the attach dummies' BoneRef indices refer to (the 3PV body LOD). The arms
// LOD has its own bone list, so the dummies are re-resolved by name there (index reuse parented them to random bones).
function exportCharaGLB(P, name, lod, { outDir, glbName, texUri, clips, hitboxes = true, dummyBones = null, log }) {
  const sk = readSkeleton(P.d, P.scene, P.scene.byId.get(lod.skeleton));
  const { meshes } = collectBodyMeshes(P.d, P.scene, lod.root);
  const G = new GLB('pb export-model.mjs');
  const J = G.json;
  const mats = materialFactory(G, P, path.join(outDir, texUri), texUri);
  const { nodeOf } = addSkeletonNodes(G, sk.bones, J.scenes[0].nodes);
  const worldThree = sk.bones.map((b) => mul(b.world, AXIS));
  // skin: joints = all bones, IBM = inverse(bone world in three space)
  const ibm = new Float32Array(sk.bones.length * 16);
  worldThree.forEach((w, i) => ibm.set(invert(w), i * 16));
  J.skins = [{ name, joints: nodeOf, skeleton: nodeOf[0], inverseBindMatrices: G.accessor(ibm, 'MAT4') }];
  const stats = { tris: 0, verts: 0, keyed: 0, rigid: 0 };
  const prims = [];
  for (const m of meshes) {
    let idx;
    try { idx = plainIndices(m); } catch { stats.keyed++; continue; }
    const va = m.va;
    // i3SkinGeometryAttr: one part per palette block (its triangles only), blend indices go through that block's palette
    const parts = m.palettes ? m.palettes.map((b) => ({ idx: idx.subarray(b.first, b.first + b.tris * 3), pal: b.pal })) : [{ idx, pal: null }];
    let matrix = AXIS;
    const skinJoints = (pal) => (s) => {
      const j = [0, 0, 0, 0], w = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const wk = va.weights[s * 4 + k]; if (wk <= 0) continue;
        const slot = va.joints[s * 4 + k];
        j[k] = pal ? pal[slot] : slot; if (j[k] === undefined) throw new Error(`${name}: blend slot ${slot} outside its palette`);
        w[k] = wk;
      }
      const sum = w[0] + w[1] + w[2] + w[3] || 1;
      return { j, w: w.map((v) => v / sum) };
    };
    // blend indices are skeleton bones of this LOD (= the skin joints) unless the geometry carries a palette
    const useSkin = va.joints && m.bone < 0;
    let rigidJoints = null;
    if (!useSkin) { // rigid geometry under a bone ref (or unskinned): bake the bind pose, weight 1 to that bone
      const b = Math.max(0, m.bone);
      matrix = mul(m.local, worldThree[b]);
      rigidJoints = () => ({ j: [b, 0, 0, 0], w: [1, 0, 0, 0] });
      stats.rigid++;
    }
    for (const part of parts) {
      const prim = buildPrimitive(G, m, part.idx, { matrix, joints: useSkin ? skinJoints(part.pal) : rigidJoints });
      prim.material = mats.get(m.state);
      stats.tris += prim.tris; stats.verts += prim.verts;
      delete prim.tris; delete prim.verts;
      prims.push({ name: m.name.split('/').pop(), prim });
    }
  }
  J.meshes.push({ name, primitives: prims.map((p) => p.prim), extras: { parts: prims.map((p) => p.name) } });
  J.scenes[0].nodes.push(G.node({ name: name + '_mesh', mesh: 0, skin: 0 }));
  // attachment dummies (i3Body children: BoneRef -> Transform) as child nodes of their bone
  const attach = {};
  for (const c of P.body.children) {
    for (const dm of collectBodyMeshes(P.d, P.scene, c).dummies) {
      const bi = dummyBones ? sk.bones.findIndex((b) => b.name === dummyBones[dm.bone]) : dm.bone;
      if (bi < 0 || bi >= sk.bones.length) continue;
      const bn = J.nodes[nodeOf[bi]];
      (bn.children ||= []).push(G.node({ name: dm.name, ...trs(dm.local) }));
      attach[dm.name] = { bone: sk.bones[bi].name, pos: round(xformPoint(mul(dm.local, worldThree[bi]), 0, 0, 0)) };
    }
  }
  // hit boxes: per-bone PhysX convex hulls -> bone-local AABB (joint node extras + summary)
  const boxes = [];
  if (hitboxes) {
    const shapeObjs = P.scene.objects.filter((o) => o.cls === 'i3PhysixShapeSet');
    const hulls = scanConvexHulls(P.d, P.scene.base); // the cooked hulls are object payloads inside the scene
    if (hulls.length === shapeObjs.length) {
      sk.bones.forEach((b, i) => {
        if (!b.shapeSet) return;
        const k = shapeObjs.findIndex((o) => o.id === b.shapeSet);
        const so = shapeObjs[k];
        const shapeName = P.d.toString('latin1', so.off + 1, so.off + 1 + P.d[so.off]);
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const v of hulls[k].verts) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], v[a]); mx[a] = Math.max(mx[a], v[a]); }
        const box = { bone: b.name, shape: shapeName, zone: zoneOf(shapeName), min: round(mn), max: round(mx), center: round(xformPoint(worldThree[i], ...mn.map((v, a) => (v + mx[a]) / 2))) };
        boxes.push(box);
        J.nodes[nodeOf[i]].extras = { hitbox: { shape: shapeName, zone: box.zone, min: box.min, max: box.max, space: 'bone-local' } };
      });
    } else log(`  ${name}: ${hulls.length} hulls vs ${shapeObjs.length} shape sets, hit boxes skipped`);
  }
  const clipInfo = clips ? addClips(G, nodeOf, sk.bones, clips) : [];
  J.scenes[0].name = name;
  J.extras = { source: P.body.name || name, axes: 'three.js space: Y-up, metres; root node AxisRotate = i3 (x,y,z)->(-x,z,y)', attach, hitboxes: boxes };
  if (!stats.tris) throw new Error(`${name}/${glbName}: no plain geometry (${stats.keyed} keyed index arrays)`);
  const glbFile = path.join(outDir, glbName);
  fs.writeFileSync(glbFile, G.build());
  const check = checkGLB(glbFile);
  if (!check.ok) throw new Error(`${name}/${glbName}: GLB check failed ${check.errors.join('; ')}`);
  return { check, stats, attach, boxes, clipInfo, missing: [...mats.missing], bones: sk.bones.length, boneNames: sk.bones.map((b) => b.name) };
}

// id: output folder (default name lower-cased); packDir / animDir: client folders (animDir = Chara/<X> with the
// i3AnimPacks, null = no embedded clips); extra: fields merged into the index entry.
export function exportChara({ name, team, id = name.toLowerCase(), packDir = path.join(gameDir(), 'Pack'), animDir = path.join(gameDir(), 'Chara', name), texFallback = [], extra = {} },
  { outRoot = OUT, log = console.log, maxTex = 0 } = {}) {
  const P = loadPack('Chara_' + name, { packDir, texFallback, maxTex });
  const outDir = path.join(outRoot, 'chars', id);
  // not rmSync(outDir): anim1pv/, anim3pv/ and ui_idle/ (other exporters) live in the same folder
  fs.mkdirSync(outDir, { recursive: true });
  // 3rd person body = the LOD with the most bones that has skinned geometry; 1PV arms = LOD 0 when it is arms-only
  const lods = P.body.lods.map((l) => ({ l, bones: readSkeleton(P.d, P.scene, P.scene.byId.get(l.skeleton)).bones.length, parts: collectBodyMeshes(P.d, P.scene, l.root).meshes.map((m) => m.name) }));
  // packs without part names (I3R2 1.7 'geoNN', skins): LOD 0 = 1PV arms (1-2 parts), then the 3PV LODs, most detailed first
  let body = lods.filter((x) => x.parts.some((p) => /Body/i.test(p))).sort((a, b) => b.bones - a.bones)[0];
  let arms = lods.find((x) => x.parts.length && x.parts.every((p) => /Arms/i.test(p)));
  if (!body && lods.length > 1 && lods[0].parts.length <= 2) {
    arms = lods[0];
    body = lods.slice(1).sort((a, b) => b.bones - a.bones)[0]; // stable: most detailed LOD among the full skeletons
  }
  if (body && !arms && lods[0] !== body && lods[0].parts.length && lods[0].parts.length <= 2) arms = lods[0]; // named body, arms parts not called *Arms*
  const dir3 = animDir;
  if (!body) throw new Error(`${name}: no body LOD`);
  const main = exportCharaGLB(P, name, body.l, { outDir, glbName: 'model.glb', texUri: 'tex', clips: dir3 ? charaClips(dir3, name, '3pv') : null, log });
  log(`chara ${name}: ${main.bones} bones, ${main.check.tris} tris, ${main.check.images} tex, ${main.boxes.length} hit boxes, ${main.clipInfo.length} clips, keyed skipped ${main.stats.keyed}, missing tex [${main.missing}]`);
  const entry = { name: id, source: rel(P.source), team, ...extra, model: `${id}/model.glb`, bones: main.bones, tris: main.check.tris,
    textures: main.check.images, bounds: main.check.bounds, clips: main.clipInfo, hitboxes: main.boxes, attach: main.attach, missingTextures: main.missing, keyedGeometriesSkipped: main.stats.keyed };
  if (arms) {
    const a = exportCharaGLB(P, name, arms.l, { outDir, glbName: 'arms_1pv.glb', texUri: 'tex', clips: dir3 ? charaClips(dir3, name, '1pv') : null, hitboxes: false, dummyBones: main.boneNames, log });
    log(`chara ${name} 1pv arms: ${a.bones} bones, ${a.check.tris} tris, ${a.clipInfo.length} clips`);
    entry.arms1pv = { model: `${id}/arms_1pv.glb`, bones: a.bones, tris: a.check.tris, clips: a.clipInfo };
  }
  return entry;
}

// ---- CLI ----------------------------------------------------------------------------------
function writeIndex(file, key, entries) {
  let prev = { [key]: [] };
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new index */ }
  const byId = new Map((prev[key] || []).map((e) => [e.id || e.name, e]));
  for (const e of entries) byId.set(e.id || e.name, e);
  // keep only entries whose GLB still exists
  const dir = path.dirname(file);
  const list = [...byId.values()].filter((e) => fs.existsSync(path.join(dir, e.file || e.model)));
  fs.writeFileSync(file, JSON.stringify({ generated: new Date().toISOString(), tool: 'tools/export-model.mjs', [key]: list }, null, 1));
  return list.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const wIndex = path.join(OUT, 'weapons', 'models', 'index.json'), cIndex = path.join(OUT, 'chars', 'index.json');
  if (args[0] === '--check') {
    let bad = 0;
    for (const [idx, key, dir] of [[wIndex, 'weapons', path.dirname(wIndex)], [cIndex, 'chars', path.dirname(cIndex)]]) {
      for (const e of JSON.parse(fs.readFileSync(idx, 'utf8'))[key]) {
        for (const f of [e.file || e.model, e.arms1pv?.model].filter(Boolean)) {
          const c = checkGLB(path.join(dir, f));
          if (!c.ok) bad++;
          console.log(c.ok ? 'OK ' : 'BAD', f, `${c.tris} tris, ${c.joints} joints, ${c.clips.length} clips, ${c.images} images`, c.errors.join('; '));
        }
      }
    }
    process.exit(bad ? 1 : 0);
  }
  const weapons = [], charas = [];
  if (!args.length) { weapons.push(...DEFAULTS.weapons); charas.push(...DEFAULTS.charas); }
  else if (args[0] === 'weapon') args.slice(1).forEach((p) => weapons.push(DEFAULTS.weapons.find((w) => w.pack === p) || { pack: p, id: p.replace(/^Weapon_/, '').toLowerCase().replace(/[^\w]+/g, '_'), kind: 'unknown' }));
  else if (args[0] === 'chara') args.slice(1).forEach((n) => charas.push(DEFAULTS.charas.find((c) => c.name === n) || { name: n, team: 'unknown' }));
  else { console.error('usage: export-model.mjs [weapon <Pack> ... | chara <Name> ... | --check]'); process.exit(2); }
  const wOut = [], cOut = [];
  let failed = 0;
  for (const w of weapons) try { wOut.push(exportWeapon(w)); } catch (e) { failed++; console.error(`weapon ${w.pack}: FAILED ${e.message}`); }
  for (const c of charas) try { cOut.push(exportChara(c)); } catch (e) { failed++; console.error(`chara ${c.name}: FAILED ${e.stack}`); }
  if (wOut.length) console.log('weapons/models/index.json:', writeIndex(wIndex, 'weapons', wOut), 'entries');
  if (cOut.length) console.log('chars/index.json:', writeIndex(cIndex, 'chars', cOut), 'entries');
  process.exit(failed ? 1 : 0);
}
