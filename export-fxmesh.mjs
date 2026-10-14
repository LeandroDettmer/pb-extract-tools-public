#!/usr/bin/env node
// Mesh layers of the weapon effects (weaponfx.json particles type "mesh": Effect/H/*.i3s) -> GLB, e.g. the ejected
// shell casings (Bul_* effects). Pure Node ESM.
//
//   node export-fxmesh.mjs      # -> out/weapons/fx/mesh/<name>.glb + tex/ + index.json
//
// Model: the i3s files sit in Effect_High.i3Pack (Effect/H), the diffuse maps (Assult_Vol.i3i ...) in Effect.i3Pack.
// The scene is the plain i3Geometry graph of tools/i3r2/scene.mjs (same reader as export-props.mjs); positions are
// baked through the node chain (AxisRotate included) so the GLB is three.js space, origin = the mesh pivot.
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack } from './i3pack/unpack.mjs';
import { scanI3R2 } from './i3r2/i3r2.mjs';
import { collectMeshes, meshIndices, readAttr } from './i3r2/scene.mjs';
import { GLB, readI3IB, decodeI3IB, encodePNG, stem, checkGLB } from './i3r2/skin-glb.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack'); // Cross only by default (--client <key> for a diagnostic run)
const OUT = assetPath('weapons', 'fx', 'mesh');
const MODELS = ['Assult_Vol.i3s', '870MCS_Vol.i3s', 'Mesh_glow_01.I3S', 'Mesh_VL_BG01.i3s', 'Mesh_VL_BG02.I3S', 'Mesh_VL_BG03.i3s', 'Mesh_VL_BG05.i3s'];

const packEntries = (name, dir) => {
  const d = fs.readFileSync(path.join(PACKS, name + '.i3Pack'));
  const n = parsePack(d).nodes.find((x) => x.path === dir);
  return { d, files: n?.files || [] };
};
const slice = ({ d, files }, file) => {
  const e = files.find((f) => f.name.toLowerCase() === file.toLowerCase());
  return e ? d.subarray(e.offset, e.offset + e.size) : null;
};
const xformP = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];

const models = packEntries('Effect_High', 'Effect/H');
const textures = packEntries('Effect', 'Effect');
fs.mkdirSync(path.join(OUT, 'tex'), { recursive: true });
const index = { source: 'PBKaybo Effect_High.i3Pack:Effect/H + Effect.i3Pack', models: {} };

for (const file of MODELS) {
  const d = slice(models, file);
  if (!d) { console.warn(`missing ${file}`); continue; }
  const scene = scanI3R2(d).find((b) => b.objects.some((o) => o.cls === 'i3Geometry'));
  if (!scene) { console.warn(`${file}: no geometry`); continue; }
  const meshes = collectMeshes(d, scene);
  const G = new GLB('pb export-fxmesh.mjs'), J = G.json;
  J.images = []; J.textures = []; J.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  const missing = new Set();
  const texOf = new Map();
  const texture = (i3iName) => {
    if (texOf.has(i3iName)) return texOf.get(i3iName);
    const b = slice(textures, i3iName);
    const t = b && readI3IB(b, 0, b.length);
    if (!t || t.kind === 'unsupported') { missing.add(i3iName); texOf.set(i3iName, null); return null; }
    const rgba = decodeI3IB(b, t);
    let minA = 255;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < minA) minA = rgba[i];
    const name = stem(i3iName);
    fs.writeFileSync(path.join(OUT, 'tex', name + '.png'), encodePNG(rgba, t.w, t.h, minA < 250));
    J.images.push({ uri: `tex/${name}.png`, name });
    J.textures.push({ source: J.images.length - 1, sampler: 0 });
    const r = { index: J.textures.length - 1, alpha: minA < 250 };
    texOf.set(i3iName, r);
    return r;
  };
  const model = path.parse(file).name;
  let tris = 0;
  for (const m of meshes) {
    let idx;
    try { idx = meshIndices(m).indices; } catch { continue; }
    const bind = m.state.i3TextureBindAttr;
    const ext = bind && (readAttr(d, scene.byId.get(bind.id), scene).ext ?? bind.ext);
    const tex = texture(ext ? path.posix.basename(String(ext).replace(/\\/g, '/')) : `${model}.i3i`);
    const va = m.va, remap = new Map(), order = [], local = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i++) {
      let r = remap.get(idx[i]);
      if (r === undefined) { r = order.length; remap.set(idx[i], r); order.push(idx[i]); }
      local[i] = r;
    }
    const pos = new Float32Array(order.length * 3), uv0 = va.uv[0] ? new Float32Array(order.length * 2) : null;
    order.forEach((s, i) => {
      pos.set(xformP(m.world, va.pos[s * 3], va.pos[s * 3 + 1], va.pos[s * 3 + 2]), i * 3);
      if (uv0) { uv0[i * 2] = va.uv[0][s * 2]; uv0[i * 2 + 1] = va.uv[0][s * 2 + 1]; }
    });
    const attributes = { POSITION: G.accessor(pos, 'VEC3', 34962, { minmax: true }) };
    if (uv0) attributes.TEXCOORD_0 = G.accessor(uv0, 'VEC2', 34962);
    const mat = { name: tex ? J.images[J.textures[tex.index].source].name : 'untextured', pbrMetallicRoughness: { metallicFactor: 0.6, roughnessFactor: 0.4 }, doubleSided: true };
    if (tex) mat.pbrMetallicRoughness.baseColorTexture = { index: tex.index, texCoord: 0 };
    J.materials.push(mat);
    J.meshes.push({ name: m.name, primitives: [{ attributes, indices: G.accessor(order.length < 65536 ? Uint16Array.from(local) : local, 'SCALAR', 34963), material: J.materials.length - 1, mode: 4 }] });
    J.nodes.push({ name: m.name.split('/').pop(), mesh: J.meshes.length - 1 });
    tris += local.length / 3;
  }
  if (!J.meshes.length) { console.warn(`${file}: nothing exportable`); continue; }
  J.scenes = [{ name: model, nodes: J.nodes.map((_, i) => i) }];
  const glb = path.join(OUT, model.toLowerCase() + '.glb');
  fs.writeFileSync(glb, G.build());
  const chk = checkGLB(glb);
  console.log(`${model}: ${J.meshes.length} meshes, ${tris} tris, tex ${J.images.length}, missing [${[...missing]}], check ${chk.ok ? 'ok' : chk.errors.join('; ')}`, JSON.stringify(chk.bounds));
  index.models[file] = { glb: `${model.toLowerCase()}.glb`, tris, missingTextures: [...missing], bounds: chk.bounds };
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
