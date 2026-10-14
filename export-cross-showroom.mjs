#!/usr/bin/env node
// Point Blank Cross showroom (CReadyBg, the 3D room behind the classic lobby / room / inventory / shop / profile
// screens) -> out/ui/cross/showroom/. Pure Node ESM, builtins only.
//
//   node export-cross-showroom.mjs
//
// Source: Clients/PBCross/Pack/UI_Showroom.i3Pack, one "OLD" node Gui/Showroom with 21 files and no name index. The
// names come from the exe strings (CReadyBg, docs/CROSS_UI.md) and the pack order is the alphabetical (case-insensitive)
// order of those names, checked by magic and size below (the seven cameras sit together, Idle is the 2-key one, the two
// Left<->Right moves are the longest; leaflet_1/2 share one size).
//
// Output
//   showroom.glb (+ tex/*.png)  Gunshowcaseroom_Lighting.i3s: 11 static meshes, i3 world (= three.js space, AXES.md).
//                               Materials as tools/export-props.mjs: baseColor uv0; i3LuxMap -> occlusionTexture uv1 +
//                               extras.lightMap (render/pbLighting.ts pbWorldMaterial). Mesh extras.lighting = the
//                               scene's i3LightingEnableAttr (absent = on: CReadyBg::_InitAttrSet 0x5092e0 enables it on
//                               the parent attr set).
//   cameras.json                the 7 Camera_*.I3S in CReadyBg order (0x509fd0): Camera01 key world matrices
//                               (row-vector, AxisRotate applied, = three.js Matrix4.fromArray), times, i3Camera near/far.
//                               The camera looks down its -Z (checked: Camera_Idle frames the room and the character).
//   dummies                     in cameras.json: the 5 Dummy_* nodes of the scene (world matrices), looked up by
//                               _InitBackground 0x509910 (use not decoded).
//   lighting.json               render/pbLighting.ts format, from Stage.pef key Stage/Lobby read by _InitLight 0x509370.
//   Gunshowcaseroom_Ref.dds     the reflect map Create 0x50810d binds to the showroom (lighting.json envRef).

import { assetPath, clientPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, carveNamed, decodeContent } from './i3pack/unpack.mjs';
import { readI3R2 } from './i3r2/i3r2.mjs';
import { collectMeshes, meshIndices, readNode, mul } from './i3r2/scene.mjs';
import { GLB, checkGLB, readI3IB, decodeI3IB, encodePNG, stem } from './i3r2/skin-glb.mjs';

const PACK = clientPath('cross', 'Pack', 'UI_Showroom.i3Pack');
const OUT = assetPath('ui', 'cross', 'showroom');

/** pack file order = alphabetical order of the names the exe / scene reference */
const NAMES = [
  'back.i3i', 'Barricade_Stone_01.i3i',
  'Camera_Idle.I3S', 'Camera_IdleToLeft.I3S', 'Camera_IdleToRight.I3S', 'Camera_LeftToIdle.I3S', 'Camera_LeftToRight.I3S', 'Camera_RightToIdle.I3S', 'Camera_RightToLeft.I3S',
  'Car_BRKT_01_Police_01.i3i', 'Car_Humvee_01_indoor_01_Diff.i3i', 'Car_Humvee_01_Outdoor_01_Brown_01_Diff.i3i', 'Ch-47_inside.i3i', 'Ch-47_yellow.i3i', 'Cone_01.i3i', 'Front_1LightingMap.i3i',
  'Gunshowcaseroom_Lighting.i3s', 'Gunshowcaseroom_Ref.dds', 'leaflet_1.i3i', 'leaflet_2.i3i', 'road_1.i3i',
];
const MAGIC = { i3i: 'I3IB', i3s: 'I3R2', dds: 'DDS ' };

/** Stage.pef [Stage/Lobby] of the Cross client (Pack/Script.i3Pack Config/Stage.pef, tools/pef/pef2json.mjs): the same
 * value in every nation slot. _InitLight 0x509370 reads them; the light matrix is built by 0x508210:
 * T(0, 0, rot.z) . RotX(rot.y deg) (0x50bc10) . RotY(rot.x deg) (0x50bd80), row-vector. */
const LOBBY = { ambient: [102, 102, 102], dDiffuse: [2, 2, 2, 2], dSpecular: [1, 1, 1, 1], dRotate: [-12, -34, 4], pDiffuse: [0.4, 0.5, 1, 1], pRange: 6, pPosition: [-0.1, 0.8, -0.45] };

const r5 = (v) => +v.toFixed(5);
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const readMat = (d, o) => Array.from({ length: 16 }, (_, k) => d.readFloatLE(o + k * 4));

function packFiles() {
  const d = fs.readFileSync(PACK);
  const node = parsePack(d).nodes.find((n) => n.fileCount);
  // .i3i names pair with their payload by the texture's own source name (carveNamed), the rest by table order
  const files = carveNamed(d, { ...node, files: NAMES.map((name) => ({ name })) });
  if (files.length !== NAMES.length) throw new Error(`UI_Showroom: ${files.length} files, expected ${NAMES.length}`);
  return files.map((f, i) => {
    let buf = d.subarray(f.offset, f.offset + f.size);
    if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
    if (!NAMES.includes(f.name)) throw new Error(`file ${i}: no name (payload ${f.name})`);
    const want = MAGIC[f.name.split('.').pop().toLowerCase()];
    if (buf.toString('latin1', 0, 4) !== want) throw new Error(`file ${i} (${f.name}): magic ${buf.toString('latin1', 0, 4)} != ${want}`);
    return { name: f.name, buf };
  }).sort((a, b) => NAMES.indexOf(a.name) - NAMES.indexOf(b.name));
}

// ---- scene -> GLB ------------------------------------------------------------------------------------------------------
function normalMatrix(m) { // (A^-1)^T of the upper 3x3, row-vector (same as export-props.mjs)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  return { det, n: [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]] };
}
const xformP = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];

function exportScene(files, log) {
  const sceneFile = files.find((f) => f.name === 'Gunshowcaseroom_Lighting.i3s');
  const d = sceneFile.buf, file = readI3R2(d);
  const texByStem = new Map(files.filter((f) => f.name.endsWith('.i3i')).map((f) => [stem(f.name), f.buf]));
  const meshes = collectMeshes(d, file);
  const G = new GLB('pb export-cross-showroom.mjs'), J = G.json;
  J.images = []; J.textures = []; J.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  fs.mkdirSync(path.join(OUT, 'tex'), { recursive: true });
  const texIdx = new Map(), missing = new Set();
  const texture = (attr) => {
    const ao = attr && file.byId.get(attr.id);
    if (!ao) return null;
    const ref = d.readUInt32LE(ao.off), t = file.byId.get(ref) || file.byId.get(ref & 0xffff);
    if (!t?.ext) return null;
    const k = stem(t.extPath);
    if (texIdx.has(k)) return texIdx.get(k);
    const buf = texByStem.get(k);
    const i = buf && readI3IB(buf, 0, buf.length);
    if (!i || i.kind === 'unsupported') { missing.add(k); return null; }
    const rgba = decodeI3IB(buf, i);
    let minA = 255;
    for (let p = 3; p < rgba.length; p += 4) if (rgba[p] < minA) minA = rgba[p];
    const hasAlpha = minA < 250;
    fs.writeFileSync(path.join(OUT, 'tex', k + '.png'), encodePNG(rgba, i.w, i.h, hasAlpha));
    J.images.push({ uri: `tex/${encodeURIComponent(k)}.png`, name: k });
    J.textures.push({ source: J.images.length - 1, sampler: 0 });
    const r = { index: J.textures.length - 1, hasAlpha };
    texIdx.set(k, r);
    return r;
  };
  const matIdx = new Map();
  let tris = 0;
  for (const m of meshes) {
    const st = m.state;
    const bt = st.i3TextureEnableAttr?.value !== false ? texture(st.i3TextureBindAttr) : null;
    const lt = st.i3LuxMapEnableAttr?.value !== false ? texture(st.i3LuxMapBindAttr) : null;
    const lighting = st.i3LightingEnableAttr?.value !== false;
    const alphaTest = st.i3AlphaTestEnableAttr?.value === true;
    const alphaMode = bt?.hasAlpha ? (alphaTest || !st.i3BlendEnableAttr?.value ? 'MASK' : 'BLEND') : 'OPAQUE';
    const cutoff = st.i3AlphaFuncAttr ? Math.max(0.05, Math.min(0.95, (st.i3AlphaFuncAttr.ref || 128) / 255)) : 0.5;
    const key = [bt?.index, lt?.index, alphaMode, cutoff, lighting].join('|');
    if (!matIdx.has(key)) {
      const mat = { name: (bt ? J.images[J.textures[bt.index].source].name : 'untextured') + (lt ? '+lm' : ''), pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 }, extras: { lighting } };
      if (bt) mat.pbrMetallicRoughness.baseColorTexture = { index: bt.index, texCoord: 0 };
      if (lt) { mat.occlusionTexture = { index: lt.index, texCoord: 1 }; mat.extras.lightMap = { index: lt.index, texCoord: 1 }; }
      if (alphaMode !== 'OPAQUE') mat.alphaMode = alphaMode;
      if (alphaMode === 'MASK') mat.alphaCutoff = cutoff;
      J.materials.push(mat);
      matIdx.set(key, J.materials.length - 1);
    }
    const idx = meshIndices(m).indices;
    const remap = new Map(), order = [], local = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i++) {
      let r = remap.get(idx[i]);
      if (r === undefined) { r = order.length; remap.set(idx[i], r); order.push(idx[i]); }
      local[i] = r;
    }
    const { det, n: N } = normalMatrix(m.world);
    if (det < 0) for (let i = 0; i < local.length; i += 3) { const t = local[i + 1]; local[i + 1] = local[i + 2]; local[i + 2] = t; }
    const va = m.va, nv = order.length;
    const pos = new Float32Array(nv * 3), nrm = va.nrm ? new Float32Array(nv * 3) : null;
    const uv0 = va.uv[0] ? new Float32Array(nv * 2) : null, uv1 = va.uv[1] && lt ? new Float32Array(nv * 2) : null;
    order.forEach((s, i) => {
      pos.set(xformP(m.world, va.pos[s * 3], va.pos[s * 3 + 1], va.pos[s * 3 + 2]), i * 3);
      if (nrm) {
        const x = va.nrm[s * 3], y = va.nrm[s * 3 + 1], z = va.nrm[s * 3 + 2];
        const nx = x * N[0] + y * N[3] + z * N[6], ny = x * N[1] + y * N[4] + z * N[7], nz = x * N[2] + y * N[5] + z * N[8];
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm.set([nx / l, ny / l, nz / l], i * 3);
      }
      if (uv0) uv0.set([va.uv[0][s * 2], va.uv[0][s * 2 + 1]], i * 2);
      if (uv1) uv1.set([va.uv[1][s * 2], va.uv[1][s * 2 + 1]], i * 2);
    });
    const attributes = { POSITION: G.accessor(pos, 'VEC3', 34962, { minmax: true }) };
    if (nrm) attributes.NORMAL = G.accessor(nrm, 'VEC3', 34962);
    if (uv0) attributes.TEXCOORD_0 = G.accessor(uv0, 'VEC2', 34962);
    if (uv1) attributes.TEXCOORD_1 = G.accessor(uv1, 'VEC2', 34962);
    J.meshes.push({ name: m.name, primitives: [{ attributes, indices: G.accessor(nv < 65536 ? Uint16Array.from(local) : local, 'SCALAR', 34963), material: matIdx.get(key), mode: 4 }] });
    J.scenes[0].nodes.push(G.node({ name: m.name.split('/').pop(), mesh: J.meshes.length - 1 }));
    tris += local.length / 3;
    log(`  mesh ${m.name}: ${local.length / 3} tris, tex ${bt ? J.images[J.textures[bt.index].source].name : '-'}${lt ? ' + lux ' + J.images[J.textures[lt.index].source].name : ''}, lighting ${lighting}, ${alphaMode}`);
  }
  J.extras = { source: 'PBCross UI_Showroom.i3Pack:Gui/Showroom/Gunshowcaseroom_Lighting.i3s', axes: 'i3 world = three.js (tools/AXES.md)' };
  const glb = path.join(OUT, 'showroom.glb');
  fs.writeFileSync(glb, G.build());
  const chk = checkGLB(glb);
  if (!chk.ok) throw new Error(`showroom.glb: ${chk.errors.join('; ')}`);
  if (missing.size) log(`  missing textures: ${[...missing].join(', ')}`);
  log(`showroom.glb: ${meshes.length} meshes, ${tris} tris, ${J.images.length} textures`);

  // Dummy_* nodes (i3Transform under Scene Root): world matrices
  const dummies = {};
  const parent = new Map(), nodes = new Map();
  for (const o of file.objects) {
    if (o.ext || !['i3Node', 'i3Transform'].includes(o.cls)) continue;
    const n = readNode(d, o);
    if (o.cls === 'i3Transform') n.matrixRef = d.readUInt32LE(n.end);
    nodes.set(o.id, n);
    for (const c of n.children) parent.set(c, o.id);
  }
  for (const [id, n] of nodes) {
    if (!/^Dummy_/.test(n.name)) continue;
    let W = IDENT;
    for (let p = id; p !== undefined; p = parent.get(p)) {
      const mo = file.byId.get(nodes.get(p)?.matrixRef);
      if (mo?.cls === 'i3MatrixObject') W = mul(W, readMat(d, mo.off));
    }
    dummies[n.name] = W.map(r5);
  }
  return dummies;
}

// ---- cameras -----------------------------------------------------------------------------------------------------------
/** row-vector rotation rows of a quaternion xyzw (D3DX, = export-props.mjs rowMat3) */
function rowMat3(q) {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
}

function readCamera(f, log) {
  const d = f.buf, file = readI3R2(d);
  const tr = file.objects.filter((o) => o.cls === 'i3Transform').map((o) => { const n = readNode(d, o); return { ...n, obj: o, matrixRef: d.readUInt32LE(n.end) }; });
  const axis = tr.find((n) => n.name === 'AxisRotate'), cam = tr.find((n) => n.name === 'Camera01');
  if (!axis || !cam || !axis.children.includes(cam.obj.id)) throw new Error(`${f.name}: no AxisRotate -> Camera01`);
  const A = readMat(d, file.byId.get(axis.matrixRef).off);
  const camObj = file.objects.find((o) => o.cls === 'i3Camera');
  const cn = readNode(d, camObj); // u32 mode, u32 ?, f32 fov, f32 near, f32 far, f32 w, f32 h (Camera_Idle: 8 0 0.7854 1 1000 640 480)
  const fov = d.readFloatLE(cn.end + 8), near = d.readFloatLE(cn.end + 12), far = d.readFloatLE(cn.end + 16);
  // i3TransformSequence: name, 6 flag bytes, u32 0, u32 keyCount, u32 0, f32 duration, T[n] vec3, R[n] quat, S[n] vec3, time[n]
  const seq = file.objects.find((o) => o.cls === 'i3TransformSequence');
  const nl = d[seq.off], q = seq.off + 1 + nl + 6, n = d.readUInt32LE(q + 4), duration = d.readFloatLE(q + 12), base = q + 16;
  if (base + n * 44 !== seq.off + seq.size) throw new Error(`${f.name}: sequence size ${seq.size} != ${n} keys`);
  const fl = (i) => d.readFloatLE(base + i * 4);
  const keys = [];
  for (let k = 0; k < n; k++) {
    const T = [0, 1, 2].map((c) => fl(k * 3 + c)), R = [0, 1, 2, 3].map((c) => fl(n * 3 + k * 4 + c)), S = [0, 1, 2].map((c) => fl(n * 7 + k * 3 + c));
    const r = rowMat3(R);
    const L = [r[0] * S[0], r[1] * S[0], r[2] * S[0], 0, r[3] * S[1], r[4] * S[1], r[5] * S[1], 0, r[6] * S[2], r[7] * S[2], r[8] * S[2], 0, T[0], T[1], T[2], 1];
    keys.push({ t: r5(fl(n * 10 + k)), m: mul(L, A).map(r5) });
  }
  const w = keys[0].m, look = [-w[8], -w[9], -w[10]].map((v) => +v.toFixed(3));
  log(`  ${f.name}: ${n} keys, ${duration.toFixed(3)} s, first pos ${[w[12], w[13], w[14]].map((v) => v.toFixed(3))} look ${look}, last pos ${keys[n - 1].m.slice(12, 15).map((v) => v.toFixed(3))}`);
  return { name: f.name.replace(/^Camera_|\.I3S$/gi, ''), duration: r5(duration), fov: r5(fov), near, far, keys };
}

// ---- lighting ----------------------------------------------------------------------------------------------------------
function lighting() {
  const rad = (v) => (v * Math.PI) / 180;
  const a = rad(LOBBY.dRotate[1]), b = rad(LOBBY.dRotate[0]);
  // row 2 (+Z axis) of RotX(a) . RotY(b), D3DX row-vector rotations: the light's +Z = dirToLight, as export-lighting.mjs zAxis
  const dir = [Math.cos(a) * Math.sin(b), -Math.sin(a), Math.cos(a) * Math.cos(b)].map(r5);
  return {
    map: 'showroom',
    sources: { stage: 'PBCross Script.i3Pack Config/Stage.pef [Stage/Lobby]', exe: 'CReadyBg::_InitLight 0x509370, light matrix 0x508210' },
    ambient: LOBBY.ambient.map((v) => r5(v / 255)), ambientI3Color: [...LOBBY.ambient, 255],
    // [INFERIDO] Stage/Lobby has no DefaultDiffuse: the i3MaterialAttr diffuse of the chara packs and of the showroom meshes
    defaultDiffuse: [0.588, 0.588, 0.588],
    camFar: 1000,
    light: { name: 'D_Light', diffuse: LOBBY.dDiffuse, specular: LOBBY.dSpecular, rotate: LOBBY.dRotate, dirToLight: dir },
    // second light of _InitLight (I3G_LIGHT point, 0x509819): the PB shaders here take one directional light, kept for reference
    pointLight: { diffuse: LOBBY.pDiffuse, specular: [1, 1, 1, 1], range: LOBBY.pRange, position: LOBBY.pPosition },
    fog: [], worldMaterials: [], lightVolume: null,
    envRef: 'Gunshowcaseroom_Ref.dds',
  };
}

function main() {
  const log = console.log;
  const files = packFiles();
  fs.mkdirSync(OUT, { recursive: true });
  const dummies = exportScene(files, log);
  log('cameras:');
  const cameras = files.filter((f) => /^Camera_/.test(f.name)).map((f) => readCamera(f, log));
  fs.writeFileSync(path.join(OUT, 'cameras.json'), JSON.stringify({
    source: 'PBCross UI_Showroom.i3Pack Gui/Showroom/Camera_*.I3S', order: 'CReadyBg anim index 0..6 (0x509fd0)',
    matrix: 'row-vector world matrix of Camera01 (AxisRotate applied) = three.js Matrix4.fromArray; the camera looks down -Z',
    cameras, dummies,
  }));
  fs.writeFileSync(path.join(OUT, 'lighting.json'), JSON.stringify(lighting()));
  const dds = files.find((f) => f.name.endsWith('.dds')).buf;
  fs.writeFileSync(path.join(OUT, 'Gunshowcaseroom_Ref.dds'), dds);
  log(`Gunshowcaseroom_Ref.dds: ${dds.length} B, cube ${(dds.readUInt32LE(112) & 0x200) !== 0}`);
  log(`out: ${OUT}`);
}

main();
