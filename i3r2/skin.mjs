// i3Engine skinned / bone-attached models (Point Blank characters and weapons), pure Node ESM.
// Layouts recovered from Chara_SWAT_Male.i3Pack and the Weapon_* packs (I3R2 1.8 / 1.9):
//
// i3Body          i3Node part (children = i3BoneRef attachment dummies), 'SKN2' block,
//                 and at the very end u32 lodCount + u32 lodId[lodCount]
// i3LOD           'BLD1', u32 ?, u32 skeletonId, u32 0, u32 rootNodeId, u32 0, u32 boneMapId (i3MemoryBuffer | 0), ...
// i3Skeleton      'SKT1', u32 flags, u32 boneMatrixListId, u32 boneCount, u32 reserved[4],
//                 u32 shapeSetId[boneCount] (i3PhysixShapeSet per bone, 0 = none)   [hit boxes / ragdoll]
// i3BoneMatrixListAttr  'BMA2' (or 'BMA1', same layout), u32 boneCount, u32 matrixArrayId (inverse binds, may be 0), 36 bytes 0,
//                 boneCount x 128 bytes: char name[32], i32 parent, 12 pad, f32 local[16] (row-major, row vector),
//                 u32 depth, 12 pad
// i3MatrixArray   u32 count, count x f32[16]: inverse bind (model -> bone) matrices
// i3BoneRef       i3Node part (children in bone space), then u32 0, u32 boneIndex, u32 0, u32 0
// i3MemoryBuffer  u32 byteSize, then data (LOD bone map: u32 boneIndex[])
// VA30 format bits (see readVertexArrayEx): 0x1 pos, 0x2 normal, 0x4 tangent, 0x8 color, 0x20 binormal,
//                 bits 6-9 texcoord components, bits 10-13 texcoord sets, bits 14-15 blend index count, bit 29 tangent is xyzw
//                 (always stored as 4 x u8), bits 18-19 blend weight count (f32; last weight = 1 - sum).
//                 Persist order: pos, normal, color, texcoords, blend indices, blend weights, tangent, binormal.
// Cooked PhysX 2.8 convex hulls ('NXS\1' 'CVXM' ... 'CVHL' u32 ver, u32 nbVerts, ... @+0x20 f32[3][nbVerts])
// follow the scene inside the pack, one per i3PhysixShapeSet (same order); vertices are bone-local.

import { readNode, readGeometryAttr, readIndexArrayRaw, mul } from './scene.mjs';

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mat16 = (buf, o) => Array.from({ length: 16 }, (_, i) => buf.readFloatLE(o + i * 4));
const cstr = (buf, o, n) => buf.toString('latin1', o, o + n).replace(/\0.*$/s, '');

// Inverse of a rigid/affine row-vector matrix (general 4x4 inverse).
export function invert(m) {
  const a = m, inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  return inv.map((v) => v / det);
}
export const xformPoint = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];
export const xformDir = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8], x * m[1] + y * m[5] + z * m[9], x * m[2] + y * m[6] + z * m[10]];

// Row-vector matrix -> { t, r (quat x,y,z,w, glTF convention), s }.
export function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  // column-vector rotation R = transpose of the row-vector 3x3
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx, r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy, r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  let x, y, z, w;
  const tr = r00 + r11 + r22;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s; }
  else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / s; x = s / 4; y = (r01 + r10) / s; z = (r02 + r20) / s; }
  else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / s; x = (r01 + r10) / s; y = s / 4; z = (r12 + r21) / s; }
  else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = s / 4; }
  const l = Math.hypot(x, y, z, w);
  return { t: [m[12], m[13], m[14]], r: [x / l, y / l, z / l, w / l], s: [sx, sy, sz] };
}
// TRS (glTF quaternion) -> row-vector matrix.
export function compose(t, q, s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const c = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  // row i of the row-vector matrix = column i of the column-vector matrix
  return [c[0] * s[0], c[3] * s[0], c[6] * s[0], 0, c[1] * s[1], c[4] * s[1], c[7] * s[1], 0, c[2] * s[2], c[5] * s[2], c[8] * s[2], 0, t[0], t[1], t[2], 1];
}

export function readBoneList(buf, obj) {
  const o = obj.off;
  const magic = buf.toString('latin1', o, o + 4);
  if (magic !== 'BMA2' && magic !== 'BMA1') throw new Error(`i3BoneMatrixListAttr#${obj.id}: not BMA1/BMA2 (${magic})`);
  const count = buf.readUInt32LE(o + 4), matrixArray = buf.readUInt32LE(o + 8);
  if (48 + count * 128 !== obj.size) throw new Error(`BMA2#${obj.id}: size ${obj.size} != 48 + ${count} * 128`);
  const bones = [];
  for (let i = 0; i < count; i++) {
    const r = o + 48 + i * 128;
    bones.push({ index: i, name: cstr(buf, r, 32), parent: buf.readInt32LE(r + 32), local: mat16(buf, r + 48), depth: buf.readUInt32LE(r + 112) });
  }
  for (const b of bones) {
    if (b.parent >= b.index) throw new Error(`BMA2#${obj.id}: bone ${b.name} parent ${b.parent} not before it`);
    b.world = b.parent < 0 ? b.local : mul(b.local, bones[b.parent].world);
  }
  return { bones, matrixArray };
}

export function readMatrixArray(buf, obj) {
  const n = buf.readUInt32LE(obj.off);
  return Array.from({ length: n }, (_, i) => mat16(buf, obj.off + 4 + i * 64));
}

export function readSkeleton(buf, file, obj) {
  const o = obj.off;
  if (buf.toString('latin1', o, o + 4) !== 'SKT1') throw new Error(`i3Skeleton#${obj.id}: not SKT1`);
  const bmaId = buf.readUInt32LE(o + 8), count = buf.readUInt32LE(o + 12);
  const shapes = [];
  for (let i = 0; i < count; i++) shapes.push(buf.readUInt32LE(o + 48 + i * 4));
  const { bones, matrixArray } = readBoneList(buf, file.byId.get(bmaId));
  if (count && count !== bones.length) throw new Error(`i3Skeleton#${obj.id}: ${count} shape slots vs ${bones.length} bones`);
  const invBind = matrixArray ? readMatrixArray(buf, file.byId.get(matrixArray)) : null;
  shapes.forEach((s, i) => { if (s) bones[i].shapeSet = s; });
  return { id: obj.id, bones, invBind };
}

export function readLOD(buf, obj) {
  const o = obj.off;
  if (buf.toString('latin1', o, o + 4) !== 'BLD1') throw new Error(`i3LOD#${obj.id}: not BLD1`);
  return { id: obj.id, skeleton: buf.readUInt32LE(o + 8), root: buf.readUInt32LE(o + 16), boneMap: buf.readUInt32LE(o + 24) };
}

export function readBody(buf, file, obj) {
  const node = readNode(buf, obj);
  const end = obj.off + obj.size;
  for (let k = 1; k <= 16; k++) {
    const at = end - 4 * (k + 1);
    if (buf.readUInt32LE(at) !== k) continue;
    const ids = Array.from({ length: k }, (_, i) => buf.readUInt32LE(at + 4 + i * 4));
    if (ids.every((id) => file.byId.get(id)?.cls === 'i3LOD')) return { name: node.name, children: node.children, lods: ids.map((id) => readLOD(buf, file.byId.get(id))) };
  }
  throw new Error(`i3Body#${obj.id}: LOD list not found`);
}

export function readMemoryU32(buf, obj) {
  const n = buf.readUInt32LE(obj.off) / 4;
  return Array.from({ length: n }, (_, i) => buf.readUInt32LE(obj.off + 4 + i * 4));
}

// VA30 with skinning channels. Returns pos/nrm/uv (asset space) + joints (u8 x4) / weights (f32 x4) when present.
export function readVertexArrayEx(buf, obj) {
  const o = obj.off;
  if (buf.toString('latin1', o, o + 4) !== 'VA30') throw new Error(`i3VertexArray#${obj.id}: not VA30`);
  const format = buf.readUInt32LE(o + 4), count = buf.readUInt32LE(o + 8);
  const stride = (obj.size - 40) / count;
  const hasN = !!(format & 2), hasC = !!(format & 8), hasTan = !!(format & 4), hasBin = !!(format & 0x20);
  const tcCount = (format >> 6) & 0xf, tcSets = (format >> 10) & 0xf, nIdx = (format >> 14) & 3, nW = (format >> 18) & 3;
  let at = 12;
  const nAt = hasN ? at : -1; if (hasN) at += 12;
  if (hasC) at += 4;
  const uvAt = at; at += tcSets * tcCount * 4;
  const idxAt = nIdx ? at : -1; if (nIdx) at += 4;
  const wAt = at; at += nW * 4;
  if (hasTan) at += format & 0x20000000 ? 16 : 12; // bit 29: tangent carries w (handedness)
  if (hasBin) at += 12;
  if (at !== stride) throw new Error(`i3VertexArray#${obj.id}: stride ${stride} != layout ${at} (fmt ${format.toString(16)})`);
  const d = o + 40;
  const pos = new Float32Array(count * 3), nrm = hasN ? new Float32Array(count * 3) : null, uv = tcSets ? new Float32Array(count * 2) : null;
  const joints = nIdx ? new Uint8Array(count * 4) : null, weights = nIdx ? new Float32Array(count * 4) : null;
  for (let i = 0; i < count; i++) {
    const v = d + i * stride;
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = buf.readFloatLE(v + k * 4);
    if (nrm) for (let k = 0; k < 3; k++) nrm[i * 3 + k] = buf.readFloatLE(v + nAt + k * 4);
    if (uv) { uv[i * 2] = buf.readFloatLE(v + uvAt); uv[i * 2 + 1] = buf.readFloatLE(v + uvAt + 4); }
    if (joints) {
      let rest = 1;
      for (let k = 0; k < nIdx; k++) {
        joints[i * 4 + k] = buf[v + idxAt + k];
        const w = k < nW ? buf.readFloatLE(v + wAt + k * 4) : rest;
        weights[i * 4 + k] = w; rest -= w;
      }
    }
  }
  return { id: obj.id, count, stride, format, nIdx, nW, pos, nrm, uv, joints, weights };
}

// i3SkinGeometryAttr bone palettes: after the 21 leading bytes, 'SGA1', u32 blockCount, u32 paletteBufferId, 16 bytes 0.
// The buffer (i3MemoryBuffer) holds blockCount x [u32 firstIndex, u32 triCount, u32 n, u8 palette[n]]: each block is a
// run of triangles (index array offset firstIndex, a multiple of 3) whose vertex blend indices are palette slots, not
// skeleton bones (Cross REBEL / D-Fox / Hide / Leopard bodies: palette max 19..53 over a 63-bone skeleton).
export function sgaPalettes(buf, file, obj) {
  if (obj.cls !== 'i3SkinGeometryAttr') return null;
  const o = obj.off, count = buf.readUInt32LE(o + 25);
  const mb = file.byId.get(buf.readUInt32LE(o + 29));
  if (mb?.cls !== 'i3MemoryBuffer') throw new Error(`i3SkinGeometryAttr#${obj.id}: palette buffer missing`);
  // the buffer tail is padding (0xCD fill): blocks are contiguous from triangle 0 and cover every triangle of the geometry
  const out = [];
  let p = mb.off + 4, next = 0;
  for (let i = 0; i < count; i++) {
    const first = buf.readUInt32LE(p), tris = buf.readUInt32LE(p + 4), n = buf.readUInt32LE(p + 8);
    if (first !== next * 3) throw new Error(`i3SkinGeometryAttr#${obj.id}: palette block ${i} starts at index ${first}, expected ${next * 3}`);
    out.push({ first, tris, pal: Array.from(buf.subarray(p + 12, p + 12 + n)) });
    p += 12 + ((n + 3) & ~3); next += tris; // palette padded to u32
  }
  if (next !== buf.readUInt32LE(o + 1) || p > mb.off + mb.size) throw new Error(`i3SkinGeometryAttr#${obj.id}: palette blocks cover ${next} of ${buf.readUInt32LE(o + 1)} triangles`);
  return out;
}

// Walk an LOD root: collect geometries with the bone they hang from (i3BoneRef) and the local matrix below it.
export function collectBodyMeshes(buf, file, rootId) {
  const meshes = [], dummies = [];
  const attrState = (n, state, obj) => {
    const st = { ...state };
    const o = n.end;
    // 'ATS1', u32 count, 8 bytes, u32 attrId[count]; I3R2 1.7 (untagged): u16 count, u32 attrId[count]
    const v17 = buf.toString('latin1', o, o + 4) !== 'ATS1';
    const cnt = v17 ? buf.readUInt16LE(o) : buf.readUInt32LE(o + 4), at = v17 ? o + 2 : o + 16;
    if (v17 && at + cnt * 4 !== obj.off + obj.size) throw new Error('i3AttrSet: no ATS1 and not the 1.7 layout');
    for (let i = 0; i < cnt; i++) { const ao = file.byId.get(buf.readUInt32LE(at + i * 4)); if (ao) st[ao.cls] = ao; }
    return st;
  };
  const walk = (id, bone, local, state, path) => {
    const obj = file.byId.get(id);
    if (!obj || obj.ext) return;
    if (!['i3Node', 'i3AttrSet', 'i3Geometry', 'i3Transform', 'i3Transform2', 'i3BoneRef', 'i3LOD', 'i3Switch'].includes(obj.cls)) return;
    const n = readNode(buf, obj);
    let b = bone, m = local, st = state;
    const p = n.name ? [...path, n.name] : path;
    if (obj.cls === 'i3BoneRef') { b = buf.readUInt32LE(n.end + 4); m = IDENTITY; }
    if (obj.cls === 'i3Transform' || obj.cls === 'i3Transform2') {
      const mo = file.byId.get(buf.readUInt32LE(n.end));
      if (mo?.cls === 'i3MatrixObject') m = mul(mat16(buf, mo.off), local);
      if (!n.children.length) dummies.push({ name: n.name, bone: b, local: m });
    }
    if (obj.cls === 'i3AttrSet') st = attrState(n, state, obj);
    if (obj.cls === 'i3Geometry') {
      const cnt = buf.readUInt32LE(n.end);
      for (let i = 0; i < cnt; i++) {
        const go = file.byId.get(buf.readUInt32LE(n.end + 4 + i * 4));
        if (go?.cls !== 'i3GeometryAttr' && go?.cls !== 'i3SkinGeometryAttr') continue;
        const geo = readGeometryAttr(buf, go);
        if (geo.primType !== 4) continue;
        meshes.push({ name: p.join('/') || `geo${go.id}`, bone: b, local: m, state: st, geo, palettes: sgaPalettes(buf, file, go), va: readVertexArrayEx(buf, file.byId.get(geo.va)), ia: geo.ia ? readIndexArrayRaw(buf, file.byId.get(geo.ia)) : null });
      }
    }
    for (const c of n.children) walk(c, b, m, st, p);
  };
  walk(rootId, -1, IDENTITY, {}, []);
  return { meshes, dummies };
}

// Plain IIA2 triangle indices of a mesh (keyed arrays -> throws; no index array = sequential list).
export function plainIndices(mesh) {
  const { ia, geo } = mesh;
  if (!ia) return Uint32Array.from({ length: geo.primCount * 3 }, (_, i) => geo.startIndex + i);
  if (ia.key) throw new Error(`i3IndexArray#${ia.id}: keyed (${ia.key.toString(16)})`);
  const out = new Uint32Array(geo.primCount * 3);
  for (let i = 0; i < out.length; i++) { const j = geo.startIndex + i; out[i] = ia.unit === 4 ? ia.bytes.readUInt32LE(j * 4) : ia.bytes.readUInt16LE(j * 2); }
  return out;
}

// Cooked convex hulls in a pack buffer, in file order: [{ off, verts: [[x,y,z]...] }].
export function scanConvexHulls(buf, from = 0) {
  const out = [];
  for (let p = buf.indexOf('NXS\x01CVXM', from, 'latin1'); p >= 0; p = buf.indexOf('NXS\x01CVXM', p + 8, 'latin1')) {
    const h = buf.indexOf('CVHL', p, 'latin1');
    if (h < 0 || h - p > 64) continue;
    const nv = buf.readUInt32LE(h + 8);
    const verts = [];
    for (let i = 0; i < nv; i++) verts.push([0, 1, 2].map((k) => buf.readFloatLE(h + 32 + i * 12 + k * 4)));
    if (nv > 0 && nv < 4096 && verts.every((v) => v.every((c) => Number.isFinite(c) && Math.abs(c) < 10))) out.push({ off: p, verts });
  }
  return out;
}
