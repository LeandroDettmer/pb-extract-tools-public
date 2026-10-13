// i3Engine scene-graph objects inside an I3R2 blob (static meshes only), pure Node ESM.
// Layouts cross-checked against the leaked i3Engine sources (i3Node / i3AttrSet /
// i3GeometryAttr / i3VertexArray / i3IndexArray OnSave) and the NStation data.

import { decodeMeshesIIA2 } from '../iia2/decode-kpa.mjs';

// i3NamedElement: u8 length + latin1 chars.
function readName(buf, o) {
  const n = buf[o];
  return { name: buf.toString('latin1', o + 1, o + 1 + n), next: o + 1 + n };
}

// i3Node: name, 'INF2', u32 flag, u32 childCount, u32 boundPtr, u32 childId[childCount],
// then 6 floats (min, max) when boundPtr != 0. Returns the offset after the node part.
export function readNode(buf, obj) {
  const { name, next } = readName(buf, obj.off);
  let o = next;
  if (buf.toString('latin1', o, o + 4) !== 'INF2') throw new Error(`${obj.cls}#${obj.id}: no INF2`);
  const flag = buf.readUInt32LE(o + 4), childCount = buf.readUInt32LE(o + 8), bound = buf.readUInt32LE(o + 12);
  o += 16;
  const children = [];
  for (let i = 0; i < childCount; i++, o += 4) children.push(buf.readUInt32LE(o));
  let bbox = null;
  if (bound) {
    const f = (k) => buf.readFloatLE(o + k * 4);
    bbox = { min: [f(0), f(1), f(2)], max: [f(3), f(4), f(5)] };
    o += 24;
  }
  return { name, flag, children, bbox, end: o };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Row-vector (D3D) matrices: v' = v * M, translation in m[12..14]. World = local * parent.
export function mul(a, b) {
  const r = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
    r[i * 4 + j] = s;
  }
  return r;
}

function readMatrix(buf, obj) {
  const m = [];
  for (let i = 0; i < 16; i++) m.push(buf.readFloatLE(obj.off + i * 4));
  return m;
}

// VA30 header (40 bytes): 'VA30', u32 format, u32 count, u32 usage, u32 types, u32 state,
// vec3 center, f32 radius; then count * stride bytes of interleaved persist data.
export function readVertexArray(buf, obj) {
  const o = obj.off;
  const id = buf.toString('latin1', o, o + 4);
  if (id !== 'VA30') throw new Error(`i3VertexArray#${obj.id}: unsupported ${id}`);
  const format = buf.readUInt32LE(o + 4), count = buf.readUInt32LE(o + 8), types = buf.readUInt32LE(o + 16);
  const stride = (obj.size - 40) / count;
  const hasNormal = (format & 2) !== 0, hasColor = (format & 8) !== 0;
  const tcCount = (format >> 6) & 0xf, tcSets = (format >> 10) & 0xf;
  // persist order: position, normal, color, texcoord sets (REAL32 everywhere in this data)
  let at = 12;
  const normalAt = hasNormal ? at : -1; if (hasNormal) at += 12;
  const colorAt = hasColor ? at : -1; if (hasColor) at += 4;
  const uvAt = [];
  for (let s = 0; s < tcSets; s++) { uvAt.push(at); at += tcCount * 4; }
  // Format bits outside position/normal/color/texcoord (2017 client: 0x4|0x20 -> +24 B, fmt 0x4a7 /
  // 0x8af; skinning 0x4000 / 0x8000|0x40000 -> blend index/weight, fmt 0x4483 / 0x48483) append their
  // data after the texcoords (checked on BattleShip, BlackPanther, DesertCamp); offsets of
  // position/normal/uv are unchanged, so the trailing bytes are skipped.
  if (format & ~0x3fcb && at < stride && stride - at <= 32) at = stride;
  if (at !== stride) throw new Error(`i3VertexArray#${obj.id}: stride ${stride} != layout ${at} (fmt ${format.toString(16)})`);
  const d = o + 40;
  const pos = new Float32Array(count * 3), nrm = hasNormal ? new Float32Array(count * 3) : null;
  const uv = uvAt.map(() => new Float32Array(count * 2));
  for (let i = 0; i < count; i++) {
    const v = d + i * stride;
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = buf.readFloatLE(v + k * 4);
    if (nrm) for (let k = 0; k < 3; k++) nrm[i * 3 + k] = buf.readFloatLE(v + normalAt + k * 4);
    uvAt.forEach((a, s) => { uv[s][i * 2] = buf.readFloatLE(v + a); uv[s][i * 2 + 1] = buf.readFloatLE(v + a + 4); });
  }
  return { id: obj.id, count, stride, format, types, pos, nrm, uv };
}

// GEO2: 'GEO2', u8 primType, u32 primCount, u32 startIndex, u32 vaRef, u32 iaRef,
// u32 primLengthSz, vec3 boundMin, vec3 boundMax, ...
// I3R2 v1.7 (untagged, 21 bytes): u8 primType, u32 primCount, u32 startIndex, u32 vaRef, u32 iaRef,
// u32 primLengthSz — the GEO2 fields without the tag and without bounds.
// i3SkinGeometryAttr (character bodies, 1.8, 49 bytes): the same 21 leading bytes, then skin data (SGA); the vertex
// array carries the joints / weights (VA30), so only the leading fields are read here. Cross: Chara_D-Fox, Hide, Leopard...
export function readGeometryAttr(buf, obj) {
  const o = obj.off;
  if (buf.toString('latin1', o, o + 4) !== 'GEO2') {
    if (obj.size !== 21 && obj.cls !== 'i3SkinGeometryAttr') throw new Error(`i3GeometryAttr#${obj.id}: not GEO2 and not v1.7 (size ${obj.size})`);
    return {
      id: obj.id, primType: buf[o], primCount: buf.readUInt32LE(o + 1), startIndex: buf.readUInt32LE(o + 5),
      va: buf.readUInt32LE(o + 9), ia: buf.readUInt32LE(o + 13), bbox: null,
    };
  }
  const f = (k) => buf.readFloatLE(o + 25 + k * 4);
  return {
    id: obj.id, primType: buf[o + 4], primCount: buf.readUInt32LE(o + 5), startIndex: buf.readUInt32LE(o + 9),
    va: buf.readUInt32LE(o + 13), ia: buf.readUInt32LE(o + 17),
    bbox: { min: [f(0), f(1), f(2)], max: [f(3), f(4), f(5)] },
  };
}

// IIA2: 'IIA2', u32 count, u32 usage, i32 mode (0 = u16, 1 = u32), u32 state, u32 key, u32 pad[2].
// key != 0 means the index bytes are obfuscated (newer clients), see iia2/decode-kpa.mjs.
// I3R2 v1.7 (untagged): u32 count, u32 0, then plain indices; u16 or u32 inferred from the size.
export function readIndexArrayRaw(buf, obj) {
  const o = obj.off;
  if (buf.toString('latin1', o, o + 4) !== 'IIA2') {
    const count = buf.readUInt32LE(o);
    const unit = obj.size - 8 === count * 2 ? 2 : obj.size - 8 === count * 4 ? 4 : 0;
    if (!unit) throw new Error(`i3IndexArray#${obj.id}: not IIA2 and size ${obj.size} != 8 + ${count} * (2|4)`);
    return { id: obj.id, count, unit, key: 0, bytes: buf.subarray(o + 8, o + 8 + count * unit) };
  }
  const count = buf.readUInt32LE(o + 4), mode = buf.readInt32LE(o + 12), key = buf.readUInt32LE(o + 20);
  const unit = mode === 1 ? 4 : 2;
  return { id: obj.id, count, unit, key, bytes: buf.subarray(o + 32, o + 32 + count * unit) };
}

// Non-indexed draw (iaRef 0, e.g. 2017 TrainingCamp): triangle list over consecutive vertices.
function nonIndexed(geo, va) {
  const bytes = Buffer.alloc(va.count * 4);
  for (let i = 0; i < va.count; i++) bytes.writeUInt32LE(i, i * 4);
  return { id: -geo.id, count: va.count, unit: 4, key: 0, bytes };
}

const ATTR_BOOL = new Set(['i3LightingEnableAttr', 'i3LuxMapEnableAttr', 'i3TextureEnableAttr',
  'i3AlphaTestEnableAttr', 'i3BlendEnableAttr', 'i3ZWriteEnableAttr', 'i3ZTestEnableAttr', 'i3FogEnableAttr']);

export function readAttr(buf, obj, file) {
  const a = { cls: obj.cls, id: obj.id };
  if (ATTR_BOOL.has(obj.cls)) a.value = buf[obj.off] !== 0;
  else if (obj.cls === 'i3TextureBindAttr' || obj.cls === 'i3LuxMapBindAttr') {
    const ref = buf.readUInt32LE(obj.off), tex = file.byId.get(ref) || file.byId.get(ref & 0xffff);
    a.texture = tex && tex.ext ? tex.extPath : null;
    a.stage = buf.readUInt32LE(obj.off + 4);
  } else if (obj.cls === 'i3FaceCullModeAttr') a.mode = buf.readUInt32LE(obj.off);
  else if (obj.cls === 'i3AlphaFuncAttr') { a.func = buf.readUInt32LE(obj.off); a.ref = buf[obj.off + 4]; }
  else if (obj.cls === 'i3MaterialAttr') {
    const c = (k) => [0, 1, 2, 3].map((i) => buf.readFloatLE(obj.off + k * 16 + i * 4));
    a.colors = [c(0), c(1), c(2), c(3)]; // 4 RGBA blocks (emissive?, ambient?, specular?, diffuse?) — unverified order
  }
  return a;
}

// Walk the scene graph from its root(s) and collect static triangle meshes.
// Each mesh: { name, world (row-major 4x4), state (inherited attrs), geo, va, indices }.
export function collectMeshes(buf, file, { log = () => {} } = {}) {
  // i3UserNode (plain INF2 node): without it the geometry under it is detached and loses the parent transforms, e.g. the
  // Z-up -> Y-up root of Construction_Pilar_00 / Wall*.I3S (the pillars lay on their side)
  const nodeClasses = new Set(['i3Node', 'i3UserNode', 'i3Transform', 'i3Transform2', 'i3AttrSet', 'i3Geometry', 'i3LOD', 'i3Switch']);
  const parented = new Set();
  const nodes = new Map();
  for (const o of file.objects) {
    if (o.ext || !nodeClasses.has(o.cls)) continue;
    // 2017 skinned props: i3Body -> i3LOD 'BLD1' (skeleton ref + node ref) is a descriptor, not a scene
    // node; its i3Node child is then walked as a root (bind pose)
    if (o.cls === 'i3LOD' && buf.toString('latin1', o.off, o.off + 4) === 'BLD1') continue;
    const n = readNode(buf, o);
    n.obj = o;
    if (o.cls === 'i3Transform' || o.cls === 'i3Transform2') n.matrixRef = buf.readUInt32LE(n.end);
    if (o.cls === 'i3AttrSet') {
      n.attrs = [];
      if (buf.toString('latin1', n.end, n.end + 4) === 'ATS1') {
        const cnt = buf.readUInt32LE(n.end + 4);
        for (let i = 0; i < cnt; i++) n.attrs.push(buf.readUInt32LE(n.end + 16 + i * 4));
      } else { // I3R2 v1.7 (untagged): u16 count, u32 attrId[count], exactly filling the object
        const cnt = buf.readUInt16LE(n.end);
        if (n.end + 2 + cnt * 4 !== o.off + o.size) throw new Error(`i3AttrSet#${o.id}: no ATS1 and not v1.7 layout`);
        for (let i = 0; i < cnt; i++) n.attrs.push(buf.readUInt32LE(n.end + 2 + i * 4));
      }
    }
    if (o.cls === 'i3Geometry') {
      const cnt = buf.readUInt32LE(n.end);
      n.geoAttrs = [];
      for (let i = 0; i < cnt; i++) n.geoAttrs.push(buf.readUInt32LE(n.end + 4 + i * 4));
    }
    nodes.set(o.id, n);
    n.children.forEach((c) => parented.add(c));
  }
  // i3Body -> i3LOD 'BLD1' (u32 node ref at +16) -> mesh node: the skinned mesh is not listed as a child of anything, so it
  // would be walked as a root with an identity world and miss the scene's AxisRotate (Crane_OutPost sat 26 m under the map,
  // unrotated). Hang the LOD's node under whatever node lists the i3Body as a child.
  const extraChildren = new Map();
  const bodies = file.objects.filter((o) => !o.ext && o.cls === 'i3Body');
  for (const lod of file.objects.filter((o) => !o.ext && o.cls === 'i3LOD' && buf.toString('latin1', o.off, o.off + 4) === 'BLD1')) {
    const ref = buf.readUInt32LE(lod.off + 16);
    if (!nodes.has(ref) || parented.has(ref)) continue;
    const body = bodies.find((b) => { for (let p = b.off; p + 4 <= b.off + b.size; p++) if (buf.readUInt32LE(p) === lod.id) return true; return false; });
    const parent = body && [...nodes.values()].find((n) => n.children.includes(body.id));
    if (!parent) continue;
    if (!extraChildren.has(parent.obj.id)) extraChildren.set(parent.obj.id, []);
    extraChildren.get(parent.obj.id).push(ref);
    parented.add(ref);
  }
  const roots = [...nodes.values()].filter((n) => !parented.has(n.obj.id));
  const vaCache = new Map();
  const getVA = (id) => {
    if (!vaCache.has(id)) vaCache.set(id, readVertexArray(buf, file.byId.get(id)));
    return vaCache.get(id);
  };
  const meshes = [];
  const walk = (n, parentWorld, state, path) => {
    let world = parentWorld;
    if (n.matrixRef) {
      const mo = file.byId.get(n.matrixRef);
      if (mo && mo.cls === 'i3MatrixObject') world = mul(readMatrix(buf, mo), parentWorld);
    }
    let st = state;
    if (n.attrs) {
      st = { ...state };
      for (const id of n.attrs) {
        const ao = file.byId.get(id);
        if (!ao) continue;
        const a = readAttr(buf, ao, file);
        st[a.cls] = a;
      }
    }
    const p = n.name ? [...path, n.name] : path;
    if (n.geoAttrs) {
      for (const gid of n.geoAttrs) {
        const go = file.byId.get(gid);
        if (!go || go.cls !== 'i3GeometryAttr') continue;
        const geo = readGeometryAttr(buf, go);
        if (geo.primType !== 4) { log(`skip geo#${gid}: primType ${geo.primType}`); continue; }
        const va = getVA(geo.va);
        const iaObj = file.byId.get(geo.ia);
        const ia = iaObj ? readIndexArrayRaw(buf, iaObj) : nonIndexed(geo, va);
        meshes.push({ name: p.join('/') || `geo${gid}`, world, state: st, geo, va, ia });
      }
    }
    for (const c of [...n.children, ...(extraChildren.get(n.obj.id) || [])]) { const cn = nodes.get(c); if (cn) walk(cn, world, st, p); }
  };
  for (const r of roots) walk(r, IDENTITY, {}, []);
  for (const m of meshes) Object.defineProperty(m, 'scene', { value: meshes }); // keyed IIA2 decoding needs the siblings
  return meshes;
}

// Resolve the triangle indices of a mesh. Keyed IIA2 arrays go through iia2/decode-kpa.mjs (whole scene at once).
const keyedCache = new WeakMap();
export function meshIndices(mesh, opts = {}) {
  const { ia, geo, va } = mesh;
  const n = geo.primCount * 3;
  if (!ia.key) {
    const out = new Uint32Array(ia.count);
    for (let i = 0; i < ia.count; i++) out[i] = ia.unit === 4 ? ia.bytes.readUInt32LE(i * 4) : ia.bytes.readUInt16LE(i * 2);
    return { indices: out.subarray(geo.startIndex, geo.startIndex + n), quality: 1, method: 'plain' };
  }
  const scene = mesh.scene || [mesh];
  if (!keyedCache.has(scene)) keyedCache.set(scene, decodeMeshesIIA2(scene.filter((m) => m.ia.key)));
  const r = keyedCache.get(scene).get(ia.id);
  return { indices: r.indices.subarray(geo.startIndex, geo.startIndex + n), quality: r.trusted ? 1 : r.quality.nrm, method: 'iia2-' + r.method };
}
