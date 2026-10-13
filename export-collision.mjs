#!/usr/bin/env node
// Export a map's collision (<Map>_Col.i3Pack) to glTF for three.js / rapier.
//
//   node export-collision.mjs [MapName|path/to/<Map>_Col.i3Pack] [--out MAPS_ROOT]
//                                           [--pack-dir DIR | --root DIR] [--name OUT_DIR_NAME]
//
// MapName defaults to NStation. It's matched case-insensitively against
// "Clients/PBCross/Pack/<Map>_Col.i3Pack" (or --pack-dir);
// a path ending in .i3Pack is used as-is. --name overrides the output folder (e.g. metro_2017).
//
// Output (out/maps/<--name or map lowercased>/):
//   collision.glb    one node+mesh per i3PhysixShapeSet (POSITION + indices),
//                    transforms baked into the vertices (node TRS = identity)
//   collision.json   { tris, verts, meshes, bounds:{min,max}, spawnSuggestion, axes }
//
// Pipeline: i3Pack -> I3R2 scene (i3Transform / i3Transform2 / i3MatrixObject / i3PhysixShapeSet)
//           -> PhysX 2.8 cooked "NXS\x01MESH" triangle meshes -> world matrix chain -> GLB.
// Axis convention: see tools/AXES.md.

import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, readI3R2Header } from './i3pack/unpack.mjs';

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out'); // --out DIR: maps root to write <map>/collision.* into
const OUT_ROOT = outAt >= 0 ? path.resolve(argv.splice(outAt, 2)[1]) : assetPath('maps');
const optArg = (...keys) => { for (const k of keys) { const i = argv.indexOf(k); if (i >= 0) return argv.splice(i, 2)[1]; } };
const packDirArg = optArg('--pack-dir', '--root'), nameArg = optArg('--name');
const arg = argv[0] || 'NStation';
const PACK_DIR = packDirArg ? path.resolve(packDirArg) : clientPath(baseClient('cross'), 'Pack');
const PACK = /\.i3Pack$/i.test(arg) ? path.resolve(arg) : path.join(PACK_DIR, `${arg}_Col.i3Pack`);
const MAP_NAME = /\.i3Pack$/i.test(arg)
  ? path.basename(arg).replace(/_Col\.i3Pack$/i, '')
  : arg;
const OUT_DIR = path.join(OUT_ROOT, nameArg || MAP_NAME.toLowerCase());

// ---- 4x4 row-major matrices, row-vector convention (v' = v * M), as stored by i3/D3D ----
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => { // a * b
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return r;
};
const xform = (m, x, y, z) => [
  x * m[0] + y * m[4] + z * m[8] + m[12],
  x * m[1] + y * m[5] + z * m[9] + m[13],
  x * m[2] + y * m[6] + z * m[10] + m[14],
];
const det3 = m => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);

// i3 world (after the scene's own root matrix) -> three.js. i3 world is already Y-up,
// right-handed, metres (root matrix has det=+1, see AXES.md), so this is identity.
const I3_TO_THREE = IDENT;

// ---- I3R2 scene graph -------------------------------------------------------
function loadScene(d) {
  const H = readI3R2Header(d, 0);
  const objs = H.objects.map((o, i) => ({ ...o, index: i, className: H.strings[o.cls] }));
  const byId = new Map(objs.map(o => [o.id, o]));
  for (const o of objs) {
    const p = o.off;
    if (o.className === 'i3MatrixObject') {
      o.matrix = Array.from({ length: 16 }, (_, k) => d.readFloatLE(p + k * 4));
    } else if (o.className === 'i3Transform' || o.className === 'i3Transform2' || o.className === 'i3Node') {
      // i3Node (e.g. v1.7 "Scene Root" between AxisRotate and the shapes) = a transform without a matrix
      const nl = d[p];
      o.name = d.toString('latin1', p + 1, p + 1 + nl);
      let q = p + 1 + nl;
      if (d.toString('latin1', q, q + 4) !== 'INF2') throw new Error(`transform ${o.id}: no INF2`);
      q += 8; // INF2 + u32 flags
      const nc = d.readUInt32LE(q); q += 8; // childCount + u32 0
      o.children = [];
      for (let k = 0; k < nc; k++, q += 4) o.children.push(d.readUInt32LE(q));
      if (o.className !== 'i3Node') o.matrixId = d.readUInt32LE(q);
    } else if (o.className === 'i3PhysixShapeSet') {
      const nl = d[p];
      o.name = d.toString('latin1', p + 1, p + 1 + nl);
    }
  }
  // world matrices, walking from the roots (transforms nobody lists as a child)
  const isChild = new Set(objs.flatMap(o => o.children || []));
  const world = new Map();
  const walk = (o, parent) => {
    const local = byId.get(o.matrixId)?.matrix || IDENT;
    const w = mul(local, parent);
    world.set(o.id, w);
    for (const c of o.children) { const ch = byId.get(c); if (ch?.children) walk(ch, w); }
  };
  for (const o of objs) if (o.children && !isChild.has(o.id)) walk(o, IDENT);
  return { objs, byId, world };
}

// ---- PhysX 2.8 cooked triangle mesh ("NXS\x01MESH") --------------------------
function readNxsMeshes(d, start, end) {
  const out = [];
  let i = start;
  while ((i = d.indexOf('NXS\x01MESH', i, 'latin1')) >= 0 && i < end) {
    let o = i + 12;
    const flags = d.readUInt32LE(o); o += 16;
    const nv = d.readUInt32LE(o), nt = d.readUInt32LE(o + 4); o += 8;
    const pos = new Float32Array(nv * 3);
    for (let k = 0; k < nv * 3; k++) pos[k] = d.readFloatLE(o + k * 4);
    o += nv * 12;
    const w = flags & 8 ? 1 : flags & 16 ? 2 : 4;
    const idx = new Uint32Array(nt * 3);
    let bad = 0;
    for (let k = 0; k < nt * 3; k++) {
      const x = w === 1 ? d[o + k] : w === 2 ? d.readUInt16LE(o + k * 2) : d.readUInt32LE(o + k * 4);
      if (x >= nv) bad++;
      idx[k] = x;
    }
    if (bad) throw new Error(`NXS mesh @${i}: ${bad} bad indices`);
    out.push({ pos, idx });
    i += 8;
  }
  return out;
}

// ---- GLB writer (POSITION + indices only) ------------------------------------
function writeGlb(file, meshes) {
  const bufs = []; let byteLen = 0;
  const push = b => { const off = byteLen; bufs.push(b); byteLen += b.byteLength; const pad = (4 - (byteLen % 4)) % 4; if (pad) { bufs.push(Buffer.alloc(pad)); byteLen += pad; } return off; };
  const gltf = { asset: { version: '2.0', generator: 'pbx export-collision.mjs' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [] };
  for (const m of meshes) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < m.pos.length; k++) { const a = k % 3; if (m.pos[k] < min[a]) min[a] = m.pos[k]; if (m.pos[k] > max[a]) max[a] = m.pos[k]; }
    const pOff = push(Buffer.from(m.pos.buffer, m.pos.byteOffset, m.pos.byteLength));
    gltf.bufferViews.push({ buffer: 0, byteOffset: pOff, byteLength: m.pos.byteLength, target: 34962 });
    gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType: 5126, count: m.pos.length / 3, type: 'VEC3', min, max });
    const iOff = push(Buffer.from(m.idx.buffer, m.idx.byteOffset, m.idx.byteLength));
    gltf.bufferViews.push({ buffer: 0, byteOffset: iOff, byteLength: m.idx.byteLength, target: 34963 });
    gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType: 5125, count: m.idx.length, type: 'SCALAR' });
    gltf.meshes.push({ name: m.name, primitives: [{ attributes: { POSITION: gltf.accessors.length - 2 }, indices: gltf.accessors.length - 1, mode: 4 }] });
    gltf.nodes.push({ name: m.name, mesh: gltf.meshes.length - 1, extras: { material: m.material } });
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }
  gltf.buffers.push({ byteLength: byteLen });
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(bufs);
  const hdr = Buffer.alloc(12);
  hdr.write('glTF', 0, 'latin1'); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4, 'latin1'); return b; };
  fs.writeFileSync(file, Buffer.concat([hdr, ch(json.length, 'JSON'), json, ch(bin.length, 'BIN\0'), bin]));
}

// ---- floor probe: heights of up-facing triangles under (x,z) -------------------
function floorsAt(meshes, x, z) {
  const hits = [];
  for (const m of meshes) {
    const P = m.pos, I = m.idx;
    for (let t = 0; t < I.length; t += 3) {
      const a0 = I[t] * 3, b0 = I[t + 1] * 3, c0 = I[t + 2] * 3;
      const ax = P[a0], az = P[a0 + 2], bx = P[b0], bz = P[b0 + 2], qx = P[c0], qz = P[c0 + 2];
      const d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / d;
      const l2 = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      // CCW right-handed normal must point up (walkable)
      const ux = bx - ax, uy = P[b0 + 1] - P[a0 + 1], uz = bz - az, vx = qx - ax, vy = P[c0 + 1] - P[a0 + 1], vz = qz - az;
      const ny = uz * vx - ux * vz, nlen = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
      if (nlen === 0 || ny / nlen < 0.7) continue;
      hits.push(l1 * P[a0 + 1] + l2 * P[b0 + 1] + l3 * P[c0 + 1]);
    }
  }
  return hits.sort((p, q) => p - q);
}

// ---- respawn points: GINS instance table in <map>_Scene.i3Pack -------------------
// GINS: 'GINS', u32 ver, u32 count, u32 layerCount, layerCount x 80 B, then 200-byte records:
//   +0x14 u32 classHash, +0x18 vec3 pos, +0x24 quat(x,y,z,w), +0x34 vec3 scale, +0x6c char name[92]
// Positions are i3 world = the same space as the exported collision.
// Respawn records have classHash 0x4ce77b33 and a team u32 at +0x4c (0 = red, 1 = blue).
// GINS v3 (2017 client, older maps): no layer table, variable-length records
//   (u32 hash, u32 classHash, vec3 pos, quat, vec3 scale, +0x2c team, ..., +0x50 u32 nameLen, name);
//   respawns are unnamed, so they're found by classHash and named Respawn<n> in file order.
const RESPAWN_CLASS = 0x4ce77b33;
const TEAMS = ['red', 'blue'];
const quatYawDeg = (qx, qy, qz, qw) => +(Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx)) * 180 / Math.PI).toFixed(1);
function readRespawnsV3(d, g) {
  const out = [];
  const pat = Buffer.alloc(4); pat.writeUInt32LE(RESPAWN_CLASS);
  for (let i = d.indexOf(pat, g); i >= 0; i = d.indexOf(pat, i + 4)) {
    const P = i - 4, f = k => d.readFloatLE(P + k);
    if (Math.abs(Math.hypot(f(0x14), f(0x18), f(0x1c), f(0x20)) - 1) > 0.01 || Math.abs(f(0x28) - 1) > 0.01) continue;
    const team = d.readUInt32LE(P + 0x3c);
    out.push({ name: `Respawn${out.length}`, pos: [f(0x08), f(0x0c), f(0x10)].map(v => +v.toFixed(3)), yawDeg: quatYawDeg(f(0x14), f(0x18), f(0x1c), f(0x20)), ...(TEAMS[team] && { team: TEAMS[team] }) });
  }
  return out;
}
function readRespawns(scenePack) {
  if (!fs.existsSync(scenePack)) return [];
  const d = fs.readFileSync(scenePack);
  const g = d.indexOf('GINS', 0, 'latin1');
  if (g < 0) return [];
  if (d.readUInt32LE(g + 4) < 4) return readRespawnsV3(d, g);
  const n = d.readUInt32LE(g + 8), L = d.readUInt32LE(g + 12), base = g + 0x10 + L * 80;
  const out = [];
  for (let i = 0; i < n && base + (i + 1) * 200 <= d.length; i++) {
    const r = base + i * 200;
    const name = d.toString('latin1', r + 0x6c, r + 0xc8).replace(/\0[\s\S]*$/, '');
    if (!/^[\w .-]+$/.test(name)) break; // end of the instance records
    if (!/^Respawn/i.test(name)) continue;
    const f = k => d.readFloatLE(r + k);
    const [qx, qy, qz, qw] = [f(0x24), f(0x28), f(0x2c), f(0x30)];
    const team = d.readUInt32LE(r + 0x14) === RESPAWN_CLASS ? TEAMS[d.readUInt32LE(r + 0x4c)] : undefined;
    out.push({ name, pos: [f(0x18), f(0x1c), f(0x20)].map(v => +v.toFixed(3)), yawDeg: quatYawDeg(qx, qy, qz, qw), ...(team && { team }) });
  }
  return out;
}

// ---- fallback: generate spawns when the GINS table has none (old-client scene packs
// whose instance names don't decode with the BR record layout) -------------------
// 8 points per team at each end of the map's long axis, snapped to the nearest
// walkable floor under them (floorsAt) with >=1.9 m of vertical clearance for a
// r=0.35 capsule, facing the map centre.
function generateFallbackSpawns(meshes, bounds) {
  const dx = bounds.max[0] - bounds.min[0], dz = bounds.max[2] - bounds.min[2];
  const longAxis = dx >= dz ? 0 : 2, crossAxis = longAxis === 0 ? 2 : 0;
  const axisMin = bounds.min[longAxis], axisMax = bounds.max[longAxis];
  const crossMin = bounds.min[crossAxis], crossMax = bounds.max[crossAxis];
  const axisLen = axisMax - axisMin;
  const centre = [(bounds.min[0] + bounds.max[0]) / 2, 0, (bounds.min[2] + bounds.max[2]) / 2];
  const out = [];
  const MIN_SPACING = 1.2; // metres between chosen points, so 8 don't stack on one narrow platform
  for (const [team, atMax] of [['red', false], ['blue', true]]) {
    const chosen = [];
    // Scan a grid of depths (10-30% of axis length from this end) x dense cross-axis
    // lanes, since the walkable footprint (a station platform/room) rarely spans the
    // full bounding-box width - a single depth/lane row mostly misses the floor.
    for (let di = 0; di < 5 && chosen.length < 8; di++) {
      const depthT = 0.10 + di * 0.05;
      const axisPos = atMax ? axisMax - axisLen * depthT : axisMin + axisLen * depthT;
      for (let ci = 0; ci <= 20 && chosen.length < 8; ci++) {
        const crossPos = crossMin + (crossMax - crossMin) * (ci / 20);
        const x = longAxis === 0 ? axisPos : crossPos;
        const z = longAxis === 0 ? crossPos : axisPos;
        if (chosen.some(p => Math.hypot(p.x - x, p.z - z) < MIN_SPACING)) continue;
        const hits = floorsAt(meshes, x, z);
        if (!hits.length) continue;
        // pick the highest floor that leaves >=1.9 m of clearance to the next hit above it
        let floorY = null;
        for (let h = hits.length - 1; h >= 0; h--) {
          const above = hits.find(v => v > hits[h] + 0.01);
          if (above === undefined || above - hits[h] >= 1.9) { floorY = hits[h]; break; }
        }
        if (floorY === null) continue;
        chosen.push({ x, z, floorY });
      }
    }
    chosen.forEach((p, i) => {
      // spawns.ts reads *_generated points as three.js yaw = -radians(yawDeg) (GINS ones as radians(yawDeg) + PI),
      // forward = (-sin(yaw), -cos(yaw)); solve for yawDeg so forward points from (x,z) toward the map centre.
      const dirX = centre[0] - p.x, dirZ = centre[2] - p.z;
      const yawDeg = +(-(Math.atan2(-dirX, -dirZ) * 180 / Math.PI)).toFixed(1);
      out.push({
        name: `Respawn_${team}_${i}_generated`,
        pos: [+p.x.toFixed(3), +p.floorY.toFixed(3), +p.z.toFixed(3)],
        yawDeg,
        floorY: +p.floorY.toFixed(3),
        team,
      });
    });
  }
  return out;
}

// ---- main ----------------------------------------------------------------------
const pack = fs.readFileSync(PACK);
const { nodes } = parsePack(pack);
// PFN3 file-entry decode isn't reliable across all pack builds (e.g. some maps' node
// records don't decrypt to a valid PFN3 marker), so pick the node whose payload is
// itself the I3R2 physics scene rather than trusting fileCount.
const colNode = nodes.find(n => {
  if (pack.toString('latin1', n.dataStart, n.dataStart + 4) !== 'I3R2') return false;
  const h = readI3R2Header(pack, n.dataStart);
  return !!h && h.strings.includes('i3PhysixShapeSet');
});
if (!colNode) throw new Error(`no node in ${path.basename(PACK)} holds an i3PhysixShapeSet scene`);
const d = pack.subarray(colNode.dataStart, colNode.dataEnd);
const { objs, world } = loadScene(d);
// Shape sets and transforms share names and names repeat inside one map (DesertCamp: two GND_, two CLOTH_, MET_...):
// pair the k-th shape set called X with the k-th transform called X (file order), not the last transform called X.
const transformsByName = new Map();
for (const o of objs.filter(o => o.className === 'i3Transform2' || o.className === 'i3Transform')) {
  if (!transformsByName.has(o.name)) transformsByName.set(o.name, []);
  transformsByName.get(o.name).push(o);
}
const shapeSeen = new Map();
// Some pack builds give i3PhysixShapeSet a header-only `size` that excludes its
// trailing NXS mesh data (the actual resource runs up to the next object's offset),
// so bound the scan by whichever is larger: the declared size or the next object.
const sortedOffs = objs.map(o => o.off).sort((a, b) => a - b);
const nextOffAfter = off => sortedOffs.find(o => o > off) ?? d.length;

const meshes = []; let totalTris = 0, totalVerts = 0, flipped = 0;
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const ss of objs.filter(o => o.className === 'i3PhysixShapeSet')) {
  const nth = shapeSeen.get(ss.name) ?? 0;
  shapeSeen.set(ss.name, nth + 1);
  const trs = transformsByName.get(ss.name);
  const tr = trs && (trs[nth] ?? trs[trs.length - 1]);
  if (!tr) console.warn(`shape ${ss.name}: no transform with same name, using identity`);
  const M = mul(tr ? world.get(tr.id) : IDENT, I3_TO_THREE);
  const flip = det3(M) < 0; // mirrored chain -> reverse winding to keep CCW front faces
  // size <= ~32 means the table only covers the name header, no mesh payload
  const end = ss.size <= 32 ? nextOffAfter(ss.off) : ss.off + ss.size;
  const parts = readNxsMeshes(d, ss.off, end);
  parts.forEach((p, k) => {
    const pos = new Float32Array(p.pos.length);
    for (let v = 0; v < p.pos.length; v += 3) {
      const w = xform(M, p.pos[v], p.pos[v + 1], p.pos[v + 2]);
      for (let a = 0; a < 3; a++) {
        pos[v + a] = w[a];
        if (w[a] < bounds.min[a]) bounds.min[a] = w[a];
        if (w[a] > bounds.max[a]) bounds.max[a] = w[a];
      }
    }
    const idx = p.idx;
    if (flip) { for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; } flipped++; }
    meshes.push({ name: parts.length > 1 ? `${ss.name}_${k}` : ss.name, material: ss.name.replace(/_\d+$/, ''), pos, idx });
    totalTris += idx.length / 3; totalVerts += pos.length / 3;
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
writeGlb(path.join(OUT_DIR, 'collision.glb'), meshes);
const round = a => a.map(v => +v.toFixed(3));
let respawns = readRespawns(PACK.replace(/_Col\.i3Pack$/i, '_Scene.i3Pack'));
for (const r of respawns) {
  const fl = floorsAt(meshes, r.pos[0], r.pos[2]).filter(h => h <= r.pos[1] + 0.5);
  r.floorY = fl.length ? +fl[fl.length - 1].toFixed(3) : null; // collision floor right under the point
}
let respawnSource = null;
if (!respawns.length) {
  // Old-client scene packs (e.g. NStation 2017 GINS v3) don't decode with the BR
  // record layout above (garbled instance names past the first few records) -
  // fall back to 8 generated spawns per team at each end of the map's long axis.
  respawns = generateFallbackSpawns(meshes, { min: round(bounds.min), max: round(bounds.max) });
  if (respawns.length) respawnSource = 'generated: 8/team at map long-axis ends, snapped to collision floor (no usable GINS respawn data)';
}
const cx = (bounds.min[0] + bounds.max[0]) / 2, cz = (bounds.min[2] + bounds.max[2]) / 2;
const centreFloor = floorsAt(meshes, cx, cz)[0];
const first = respawns.find(r => r.floorY !== null);
const spawnSuggestion = first
  ? [first.pos[0], +(first.pos[1] + 0.1).toFixed(3), first.pos[2]]
  : [+cx.toFixed(3), +((centreFloor ?? bounds.max[1]) + 1).toFixed(3), +cz.toFixed(3)];
const info = {
  source: path.basename(PACK),
  meshes: meshes.length, tris: totalTris, verts: totalVerts,
  bounds: { min: round(bounds.min), max: round(bounds.max) },
  spawnSuggestion,
  spawnSource: respawnSource ?? (first ? `GINS ${first.name} (feet pos) + 0.1 m up, from ${path.basename(PACK).replace(/_Col/i, '_Scene')}` : 'computed: floor under map XZ centre + 1 m'),
  respawnSource: respawnSource ?? undefined,
  respawns,
  axes: 'three.js: Y-up, right-handed, metres, CCW front faces; = i3 world after the scene root matrix (see tools/AXES.md)',
  shapes: meshes.map(m => ({ name: m.name, tris: m.idx.length / 3 })),
};
fs.writeFileSync(path.join(OUT_DIR, 'collision.json'), JSON.stringify(info, null, 1));
console.log(`meshes=${meshes.length} tris=${totalTris} verts=${totalVerts} flippedWinding=${flipped}`);
console.log('bounds', JSON.stringify(info.bounds), 'spawn', JSON.stringify(info.spawnSuggestion));
