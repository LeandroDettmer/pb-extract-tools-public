#!/usr/bin/env node
// Export the GINS object instances of Point Blank 2017 maps (vending machines, billboards, glass, crates...)
// to out/objects/<id>.glb + out/maps/<map>/props.json. Pure Node ESM, builtins only.
//
//   node web-poc/tools/export-props.mjs [Map ...] [--all] [--pack-dir DIR]
//     Map = pack name (NStation, Luxville...); --all = every map of maps/index.json (source cross).
//     Defaults to NStation Luxville. Pack dir defaults to Clients/PBCross/Pack (--client cross is the default).
//
// Never touches maps/<map>/visual.glb, tex/ or collision.* - only props.json and assets/objects/.
//
// ---- GINS (instance table in <Map>_Scene.i3Pack) ------------------------------------------------------------------
//   'GINS', u32 ver, u32 count, ...
//   v3 (older maps): records at GINS+0x20, variable length:
//     +0x00 u32 md5[0..4]  +0x04 u32 classHash  +0x08 vec3 pos  +0x14 quat(x,y,z,w)  +0x24 vec3 scale
//     +0x3c u32 team (respawns)  +0x4c u32 hasResource  +0x50 md5[4..16] (12 B)  +0x5c u32 extraSize
//     +0x60 u32 nameLen  +0x64 extra[extraSize]  then name[nameLen]
//   v4: u32 layerCount at +0x0c, layerCount x 80 B, then fixed 200-byte records = the v3 fields shifted by +0x10
//     (md5[0..4] @+0x10, classHash @+0x14, pos @+0x18, quat @+0x24, scale @+0x34, md5[4..16] @+0x60), name[92] @+0x6c.
//   The 16-byte md5 is MD5(upper-case resource path), e.g. md5("OBJECT/BREAK/VENDING_01.I3OBJ"): it names the
//   .i3Obj in whichever Object_*.i3Pack holds it. classHash 0xb713f4d9 = i3Object instance (rendered prop);
//   0x4cc77521 = box volume (map sectors / triggers, no visual), 0x4ce77b33 = respawn, 0x5eab4a90 = World,
//   0xd966c30d = light, 0xa4b2bf63 = path. Positions/rotations are i3 world == three.js (tools/AXES.md).
//
// ---- .i3Obj (I3R2) -------------------------------------------------------------------------------------------------
//   i3Object 'GOI1': +0x10 u32 stateCount, +0x14 f32 life. States reference external i3SceneGraphInfo
//   (id 0xffff0000 | stringIndex -> "Object/break/VENDING_01.I3S"), in the order they appear in the i3Object blob:
//   state 0 = intact model (exported), the others = broken/destroyed models (listed, not exported yet).
//   i3ActionBreakObject present = breakable. Cross CObjectTemplate files (Construction_Pilar_02, Column_05...) have no i3Object:
//   ABO1 still names the break, and life = f32 after the 'OTP1' tag (same values as the 2017 GOI1 life) [INFERIDO: field name].
//
// ---- model .I3S ----------------------------------------------------------------------------------------------------
//   Same scene graph as a map (tools/i3r2/scene.mjs), root "AxisRotate" (i3 Z-up -> three Y-up) included, so the GLB
//   is object-local three.js space: node TRS of the GINS instance places it. Materials follow export-visual.mjs
//   (baseColor = diffuse uv0, occlusionTexture uv1 + extras.lightMap = i3LuxMap when the state binds one).
//   Own collision: i3PhysixShapeSet NXUSTREAM, blocks 0xabcdef, u32 type, u32 size, 0x01234567:
//     type 33 NxBoxShapeDesc: vec3 halfExtents, then a nested type 32 NxShapeDesc whose localPose is a 4x4 at
//     +0x0c (u32 index 3..18): rows of [R | t] (column-vector, translation in the 4th column).
//   Boxes are baked through the AxisRotate chain into { center, quat, half } (three.js object space).
//   Other shapes (type 38 convex = cooked CVXM, not decoded) -> collision.kind "visual" [RECRIADO]: the runtime
//   uses the visual triangles as the collider.

import { assetPath, clientPath, webPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent, readI3R2Header } from './i3pack/unpack.mjs';
import { readI3R2, scanI3R2 } from './i3r2/i3r2.mjs';
import { collectMeshes, meshIndices, readNode, readAttr, mul } from './i3r2/scene.mjs';
import { readI3IB, decodeI3IB, encodePNG, stem, normPath, checkGLB } from './i3r2/skin-glb.mjs';

const ASSETS = assetPath();
const MAPS = path.join(ASSETS, 'maps');
const OBJ_OUT = path.join(ASSETS, 'objects');
// Server.Match map data: the matchData.json that src/host/matchCore.ts loads (match-data.mjs builds it from MapStructure.xml)
const MATCH_DATA = webPath('src', 'host', 'data', 'matchData.json');

const CLS = { object: 0xb713f4d9, box: 0x4cc77521, respawn: 0x4ce77b33, world: 0x5eab4a90, light: 0xd966c30d, path: 0xa4b2bf63 };
// Destroy-mode objectives are not CLS.object instances: Breakdown Transformer (blue) 0x3f763d11, helicopter_uh60 (red) 0x94631b06;
// Helispot Helispot_UH60_BLUE / _RED 0x1e32413f: GINS pose identity; the model is already at its start pose (see below).
const OBJECTIVE_CLS = new Set([0x3f763d11, 0x94631b06, 0x1e32413f]);
// Defence (Matches Mode 5, Black Panther 52): the two objectives are plain i3Object instances. normal_Tank = Animation 258 (UltraSync 3,
// life 6000, bar1 = red colour), armerd_Tank = 259 (UltraSync 4, life 9000, bar2 = blue colour). See objectiveAnim.
const DEFENCE_MAP_IDS = new Set([52]);
const OBJECTIVE_ANIMS = new Set([256, 257, 258, 259]);
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const md5 = (s) => crypto.createHash('md5').update(s.toUpperCase(), 'latin1').digest('hex');
const r4 = (v) => +v.toFixed(4);

// ---- OLD nodes (Cross / 2017 leaf tables, no PFN): names only from parsePack -------------------------------------
// Cross keeps most prop models (Object_break, Object_etc, Object_cgame...) in these. The 12-byte slot after each
// name does not decode to offset/size, and unpack.mjs carve() drifts (i3r2Size is only the object table end). So
// the payloads are cut by magic, in table order: a file starts with its magic (I3R2 for .i3s/.i3Obj, I3IB for .i3i,
// RIFF for .wav); an I3R2 file ends at its own table end, the others at the next magic of the kind the next name
// needs. Checked on the 18 Object_* OLD nodes of Cross: every start matches, 0 leftover, 316 models parse. Null = give up.
const OLD_KIND = (nm) => { const x = nm.split('.').pop().toLowerCase(); return x === 'i3i' ? 'I3IB' : /^(i3s|i3obj|i3a|i3r2)$/.test(x) ? 'I3R2' : x === 'wav' ? 'RIFF' : null; };
function i3r2Need(d, o) {
  const h = readI3R2Header(d, o);
  if (!h) return 4;
  let e = h.tabOff + h.tabSize;
  for (const ob of h.objects) e = Math.max(e, ob.off + ob.size);
  return e;
}
function oldNodeFiles(d, n) {
  const out = [];
  let s = n.dataStart;
  for (let k = 0; k < n.files.length; k++) {
    const kind = OLD_KIND(n.files[k].name);
    if (kind && d.toString('latin1', s, s + 4) !== kind) return null;
    let e = n.dataEnd;
    if (k < n.files.length - 1) {
      const nk = OLD_KIND(n.files[k + 1].name);
      if (!nk) return null;
      e = d.indexOf(nk, kind === 'I3R2' ? s + i3r2Need(d, s) : s + 4, 'latin1');
      if (e < 0 || e > n.dataEnd) return null;
    }
    out.push({ name: n.files[k].name, offset: s, size: e - s, attr: 0 });
    s = e;
  }
  return out;
}
// The table names of Object/ OLD nodes do not line up with their geometry: the .i3s entry is often the object's state
// file. Each i3Geometry block names its own source model in its strings (D:\...\Construction_Pilar_00.i3s, and often
// also the Object/... path, same file name), so the blocks are indexed by that file name. Blocks naming two different
// file names are skipped (ambiguous).
const baseName = (p) => p.split(/[\\/]/).pop().toLowerCase();
function oldGeomBlocks(d, n, pack, file, out) {
  for (let p = d.indexOf('I3R2', n.dataStart, 'latin1'); p >= 0 && p < n.dataEnd; p = d.indexOf('I3R2', p + 4, 'latin1')) {
    let h, r;
    try { h = readI3R2Header(d, p); r = readI3R2(d, p); } catch { continue; }
    if (!h || !h.strings.includes('i3Geometry') || !r.objects.some((o) => o.cls === 'i3Geometry')) continue;
    const keys = new Set(h.strings.filter((s) => /\.i3s$/i.test(s)).map(baseName));
    if (keys.size !== 1) continue;
    const key = [...keys][0];
    if (out.has(key)) continue;
    let end = h.tabOff + h.tabSize;
    for (const ob of h.objects) end = Math.max(end, ob.off + ob.size);
    out.set(key, { pack, file, path: key, offset: p, size: end, attr: 0 });
  }
}

// OLD leaf nodes, .i3Obj by content: the table walk (oldNodeFiles) pairs names with payloads by order, and one name without
// a payload (or a non-I3R2 file between them) shifts every later .i3Obj onto the next object: Construction_Pilar_02.i3Obj held
// Construction_Pilar_01's blob (state CONSTRUCTION_PILAR_01.I3S), so the OLD 2017 states/life/breakable came out wrong and the
// GINS md5 pointed at the wrong definition. The 12-byte slot after each name is uninitialised fill (0xCC/0x33), no offset.
// So each i3Object blob is matched by its own name: the editor string (D:\...\construction_pilar_02.i3ObjectEditor), else its first state (Object/break/CONSTRUCTION_PILAR_02.I3S -> construction_pilar_02).
// Blobs with the CObjectTemplate twin (same states, no GOI1) are not definitions and are skipped. Unmatched names get no entry.
const stemOf = (p) => p.split(/[\\/]/).pop().replace(/\.i3s$/i, '').toLowerCase();
function oldObjBlobs(d, n) {
  const byStem = new Map();
  for (let p = d.indexOf('I3R2', n.dataStart, 'latin1'); p >= 0 && p < n.dataEnd; p = d.indexOf('I3R2', p + 4, 'latin1')) {
    let r;
    try { r = readI3R2(d, p); } catch { continue; }
    if (!r.objects.some((o) => o.cls === 'i3Object')) continue;
    const end = p + i3r2Need(d, p);
    let info;
    try { info = readI3Obj(d.subarray(p, end)); } catch { continue; }
    // the editor string is the object's own name (helicopter_ch47: states CH47_IDLE.I3S); the first state is the fallback
    const ed = r.strings.find((s) => /\.i3ObjectEditor$/i.test(s));
    const key = ed ? stemOf(ed.replace(/\.i3ObjectEditor$/i, '')) : info.states[0] && stemOf(info.states[0]);
    if (key && !byStem.has(key)) byStem.set(key, { offset: p, size: end - p, attr: 0 });
  }
  return byStem;
}
// OLD leaf .i3i by content, the same drift: the walk pairs the .i3i names with I3IB payloads by order, and one extra payload
// moves every later texture. Object_break2: break_1 got the VentOpening.TGA payload (the 3rd I3IB, between Barricade_Stone_02
// and break_1), so Construction_* had ventopening instead of break_1. Each I3IB names its own source file (srcPath), so a name
// takes the payload with its own stem. A name with no such payload takes the walked payload only when that payload names no
// file (empty srcPath); a walked payload that names another file is not this texture. Unmatched names get no entry (the
// texture lookup then falls back to the stem in other packs).
function oldTexEntries(d, n, walked) {
  const blobs = [];
  for (let p = d.indexOf('I3IB', n.dataStart, 'latin1'); p >= 0 && p < n.dataEnd; p = d.indexOf('I3IB', p + 4, 'latin1')) {
    const t = readI3IB(d, p, n.dataEnd);
    if (t) blobs.push({ offset: p, src: t.srcPath ? stem(t.srcPath).toLowerCase() : '' });
  }
  // a payload ends at the next I3IB / I3R2 of the node (or the node end): raw formats size their mips from it
  const nextStart = (p) => {
    let e = n.dataEnd;
    for (const m of ['I3IB', 'I3R2']) { const i = d.indexOf(m, p + 4, 'latin1'); if (i >= 0 && i < e) e = i; }
    return e;
  };
  const byOffset = new Map(blobs.map((b) => [b.offset, b]));
  const out = [], taken = new Set(), pending = [];
  for (const f of n.files) {
    if (!/\.i3i$/i.test(f.name)) continue;
    const k = stem(f.name).toLowerCase();
    const hit = blobs.find((b) => b.src === k && !taken.has(b.offset));
    if (hit) { taken.add(hit.offset); out.push({ name: f.name, offset: hit.offset, size: nextStart(hit.offset) - hit.offset, attr: 0 }); }
    else pending.push(f);
  }
  for (const f of pending) {
    const w = walked.find((e) => e.name === f.name);
    const b = w && byOffset.get(w.offset);
    if (b && !b.src && !taken.has(b.offset)) { taken.add(b.offset); out.push(w); }
  }
  return out;
}
function oldNodeEntries(d, n) {
  const objs = oldObjBlobs(d, n);
  const walked = oldNodeFiles(d, n) ?? [];
  const isObj = (nm) => /\.i3obj$/i.test(nm);
  const claimed = new Set([...objs.values()].map((e) => e.offset));
  // no i3Object of its own by content (Object_cgame millicloth: i3TransformSequence + i3Animation, Object_moving helicopter_ch47):
  // keep the table-order payload, unless another object's blob already claims it
  const own = [];
  for (const f of n.files) {
    if (!isObj(f.name)) continue;
    const stem = f.name.replace(/\.i3obj$/i, '').toLowerCase();
    if (objs.has(stem)) { own.push({ name: f.name, ...objs.get(stem) }); continue; }
    const w = walked.find((e) => e.name === f.name);
    if (w && !claimed.has(w.offset)) own.push(w);
  }
  const tex = oldTexEntries(d, n, walked);
  return [...walked.filter((e) => !isObj(e.name) && !/\.i3i$/i.test(e.name)), ...own, ...tex];
}

// ---- pack index: every file of every pack, by upper-case path; .i3Obj also by md5 --------------------------------
function buildIndex(packDir) {
  const byPath = new Map(), byMd5 = new Map(), texPacks = [], geomByName = new Map();
  for (const f of fs.readdirSync(packDir)) {
    if (!/\.i3Pack$/i.test(f)) continue;
    const file = path.join(packDir, f);
    let nodes, d;
    try { d = fs.readFileSync(file); nodes = parsePack(d).nodes; } catch { continue; }
    let hasObj = false;
    for (const n of nodes) {
      if (!n.indexOk && n.pfnVer === 'OLD' && /^Object(\/|$)/i.test(n.path)) oldGeomBlocks(d, n, f, file, geomByName);
      const files = n.indexOk ? n.files : n.pfnVer === 'OLD' ? oldNodeEntries(d, n) : null;
      if (!files) continue;
      for (const e of files) {
        const p = (n.path ? n.path + '/' : '') + e.name;
        const ent = { pack: f, file, path: p, offset: e.offset, size: e.size, attr: e.attr };
        if (!byPath.has(p.toUpperCase())) byPath.set(p.toUpperCase(), ent);
        // build paths (D:/PB/TRUNK/ClientExes/BrazilQA/Object/bomb/X.i3s): the models refer to Object/bomb/X.i3s, so also by that part
        const ko = p.search(/(^|[\\/])Object[\\/]/i);
        if (ko > 0) { const kp = p.slice(ko).replace(/^[\\/]/, '').toUpperCase(); if (!byPath.has(kp)) byPath.set(kp, ent); }
        if (/\.i3Obj$/i.test(e.name)) {
          byMd5.set(md5(p), ent); hasObj = true;
          // some packs (Object_Event_CargoShip) keep the .i3Obj under a build path (D:/PointBlank/.../Object/event): the GINS md5 is of Object/<dir>/<name>
          const k = p.search(/(^|[\\/])Object[\\/]/i);
          if (k > 0) byMd5.set(md5(p.slice(k).replace(/^[\\/]/, '')), ent);
        }
      }
    }
    if (hasObj || /^Object_/i.test(f)) texPacks.push(file);
  }
  return { byPath, byMd5, texPacks, geomByName };
}

// Model of an i3Obj state: the table entry first, else the geometry block that names this file (see oldGeomBlocks).
// A table entry that holds no i3Geometry (the OLD name/payload drift) falls through to the block too.
// Cross Object/break Construction_*: the state of Construction_Wall00.i3Obj names Construction_Pilar_06.i3s (every
// Construction_* state is one object down). The self-named block Construction_Wall00.i3s is the 2017 model: 18/18 match
// the OLD export (vertex count + bounds). So when the state's file is not the object's own name, the own block goes first.
// A state with no i3Geometry scene (effect, path, animation-only break) is not a model: the error carries noModel, not a failure.
const noModel = (msg) => Object.assign(new Error(msg), { noModel: true });
// Break states: the state file's own 2017 block (self-named) before the Cross file of the same path. Object_break SLOT_SHORT1_BREAK.I3S
// (Cross: intact scene only, 896 v) and Object_moving Stormtube_Subway.i3s (Cross: NPort container, 4068 v) hold the wrong geometry.
function exportModelAny(id, modelPath, IX, texFor, log, ownPath) {
  if (!modelPath) throw new Error('i3Obj has no model state');
  const ownKey = ownPath && baseName(ownPath).replace(/\.i3obj$/, '.i3s');
  const own = ownKey && baseName(modelPath) !== ownKey ? IX.geomByName.get(ownKey) : undefined;
  const cands = [own, IX.geomByName.get(baseName(modelPath)), IX.byPath.get(normPath(modelPath).toUpperCase())].filter(Boolean);
  let err = `model ${modelPath} not found`, models = 0;
  for (const ent of cands) {
    try { return exportModel(id, ent, texFor, { log }); } catch (e) { err = e.message; if (!e.noModel) models++; }
  }
  throw cands.length && !models ? noModel(err) : new Error(err);
}

const packCache = new Map();
const packBuf = (file) => { if (!packCache.has(file)) packCache.set(file, fs.readFileSync(file)); return packCache.get(file); };
function readEntry(ent) {
  let buf = packBuf(ent.file).subarray(ent.offset, ent.offset + ent.size);
  if (ent.attr & 0x08000000) buf = decodeContent(Buffer.from(buf), ent.attr) || buf;
  return buf;
}

// Textures: .i3i entries of the object packs by stem (the model's own pack first, then every object pack).
function textureLookup(IX) {
  const byPackStem = new Map(), byStem = new Map(), anyStem = new Map();
  for (const ent of IX.byPath.values()) {
    if (/\.i3i$/i.test(ent.path)) { const k = stem(ent.path); if (!anyStem.has(k)) anyStem.set(k, []); anyStem.get(k).push(ent); } // map texture packs too (break_1 lives in Construction2_Textures)
    if (!/\.i3i$/i.test(ent.path) || !IX.texPacks.includes(ent.file)) continue;
    const k = stem(ent.path);
    byPackStem.set(ent.pack + ':' + k, ent);
    if (!byStem.has(k)) byStem.set(k, ent);
  }
  const cache = new Map();
  return (pack, extPath, modelId = '') => {
    const k = stem(extPath);
    const pre = modelId.split('_')[0].toLowerCase(); // "construction_wall02" -> Construction2_Textures
    const loose = () => { const l = anyStem.get(k) || []; return l.find((e) => pre && e.pack.toLowerCase().startsWith(pre)) || l[0]; };
    const ent = IX.byPath.get(normPath(extPath).toUpperCase()) || byPackStem.get(pack + ':' + k) || byStem.get(k) || loose();
    if (!ent) return null;
    if (!cache.has(ent)) {
      const buf = readEntry(ent);
      const t = readI3IB(buf, 0, buf.length);
      cache.set(ent, t && t.kind !== 'unsupported' ? { ...t, srcPath: t.srcPath || ent.path, buf, source: ent.pack + ':' + ent.path } : null);
    }
    return cache.get(ent);
  };
}

// ---- GINS ---------------------------------------------------------------------------------------------------------
export function readGINS(d) {
  const g = d.indexOf('GINS', 0, 'latin1');
  if (g < 0) return { ver: null, records: [] };
  const ver = d.readUInt32LE(g + 4), n = d.readUInt32LE(g + 8);
  const out = [];
  const rec = (r, sh, name) => {
    const f = (k) => d.readFloatLE(r + sh + k);
    return {
      cls: d.readUInt32LE(r + sh + 4) >>> 0,
      md5: d.subarray(r + sh, r + sh + 4).toString('hex') + d.subarray(r + sh + 0x50, r + sh + 0x5c).toString('hex'),
      pos: [f(8), f(12), f(16)], quat: [f(0x14), f(0x18), f(0x1c), f(0x20)], scale: [f(0x24), f(0x28), f(0x2c)], name,
    };
  };
  if (ver < 4) {
    let r = g + 0x20;
    for (let i = 0; i < n && r + 0x64 <= d.length; i++) {
      const xs = d.readUInt32LE(r + 0x5c), nl = d.readUInt32LE(r + 0x60);
      if (xs > 0x10000 || nl > 256) throw new Error(`GINS v3 record ${i} @${r.toString(16)}: bad lengths ${xs}/${nl}`);
      out.push(rec(r, 0, d.toString('latin1', r + 0x64 + xs, r + 0x64 + xs + nl)));
      r += 0x64 + xs + nl;
    }
  } else {
    const L = d.readUInt32LE(g + 12), base = g + 0x10 + L * 80;
    for (let i = 0; i < n && base + (i + 1) * 200 <= d.length; i++) {
      const r = base + i * 200;
      out.push(rec(r, 0x10, d.toString('latin1', r + 0x6c, r + 0xc8).replace(/\0[\s\S]*$/, '')));
    }
  }
  return { ver, records: out };
}

// ---- .i3Obj -------------------------------------------------------------------------------------------------------
// Sound timeline of the .i3Obj, one entry per i3TimeEventGen in file order = one per object state (state 0 = intact: ambient
// loops; state k = the sound played when the object enters state k, e.g. the break). TEG1 words: [0] 1 = repeats, [1] f32 cycle
// length (s), [6] n, [7..] n i3TimeEventInfo ids. TEI1: [1] f32 time, [2] target id (i3ActionPlaySound 'APS1': [1] = i3SoundNode id;
// its i3SoundPlayInfo is the object just before it, id - 1 [INFERIDO from the id order]). SPI1: [1] style (bits 4-7 = 1: loop),
// [3] low 16 bits = ext i3Sound id, [5] volume, [6] listener volume, [8] f32 min, [9] f32 max. The meaning of TEG[0] = 1 (repeat) is [INFERIDO].
function readStateSounds(buf, F) {
  const inner = new Map(F.objects.filter((o) => !o.ext).map((o) => [o.id, o]));
  const wavs = new Map(F.objects.filter((o) => o.ext && o.cls === 'i3Sound').map((o) => [o.id, o.extPath]));
  const words = (o, tag) => {
    const at = o && buf.indexOf(tag, o.off, 'latin1');
    if (!o || at < 0 || at >= o.off + o.size) return null;
    return { w: (i) => buf.readUInt32LE(at + 4 + i * 4), f: (i) => buf.readFloatLE(at + 4 + i * 4) };
  };
  return F.objects.filter((o) => o.cls === 'i3TimeEventGen').map((g) => {
    const G = words(g, 'TEG1');
    const out = { cycle: G && G.w(0) === 1 ? r4(G.f(1)) : null, sounds: [] };
    for (let k = 0; G && k < Math.min(G.w(6), 32); k++) {
      const tei = inner.get(G.w(7 + k)), T = tei?.cls === 'i3TimeEventInfo' && words(tei, 'TEI1');
      const aps = T && inner.get(T.w(2)), A = aps?.cls === 'i3ActionPlaySound' && words(aps, 'APS1');
      const spi = A && inner.get(A.w(1) - 1), S = spi?.cls === 'i3SoundPlayInfo' && words(spi, 'SPI1');
      const wav = S && wavs.get(S.w(3) & 0xffff);
      if (!wav || !/\.wav$/i.test(wav)) continue;
      out.sounds.push({ clip: wav.split(/[\\/]/).pop().toLowerCase(), path: wav.replace(/\\/g, '/'), t: r4(T.f(1)), loop: ((S.w(1) >>> 4) & 15) === 1, vol: S.w(5), lvol: S.w(6), min: r4(S.f(8)), max: r4(S.f(9)) });
    }
    out.sounds.sort((a, b) => a.t - b.t);
    return out;
  });
}

function readI3Obj(buf) {
  const F = readI3R2(buf, 0);
  const obj = F.objects.find((o) => o.cls === 'i3Object');
  const sgRefs = new Map(F.objects.filter((o) => o.ext && o.cls === 'i3SceneGraphInfo').map((o) => [o.id, o.extPath]));
  const states = [];
  let life = null, stateCount = null;
  if (obj) {
    const g = buf.indexOf('GOI1', obj.off, 'latin1');
    if (g >= 0 && g < obj.off + obj.size) { stateCount = buf.readUInt32LE(g + 0x10); life = r4(buf.readFloatLE(g + 0x14)); }
    for (let p = obj.off; p + 4 <= obj.off + obj.size; p += 1) {
      const v = buf.readUInt32LE(p);
      if (v >>> 16 === 0xffff && sgRefs.has(v & 0xffff) && !states.includes(sgRefs.get(v & 0xffff))) { states.push(sgRefs.get(v & 0xffff)); p += 3; }
    }
  }
  // Cross CObjectTemplate (Construction_Pilar_02, Column_05...: no i3Object, no GOI1): the break action is still there (ABO1).
  // Its life is the f32 after the 'OTP1' tag; the value equals the 2017 GOI1 life of the same prop (80, 100, 40) [INFERIDO: field name]
  const template = !obj && F.objects.some((o) => o.cls === 'CObjectTemplate');
  if (template) { const t = buf.indexOf('OTP1', 0, 'latin1'); if (t >= 0) life = r4(buf.readFloatLE(t + 4)); }
  // fall back to string order when the blob refs were not found
  if (!states.length) for (const s of F.strings) if (/\.i3s$/i.test(s)) states.push(s);
  // i3ActionEmitEffect ('AEE2' + u32 id of an i3MemoryBuffer = u32 len + effect name) and i3ActionPlaySound (i3Sound ext
  // path) are the break feedback: the effect name is an Effect_High .i3s stem, the sound a Sound_Object_* wav.
  const breakEffects = [], breakSounds = [];
  for (const o of F.objects) {
    if (o.cls === 'i3ActionEmitEffect') {
      const at = buf.indexOf('AEE2', o.off, 'latin1');
      const mb = at >= 0 && at < o.off + o.size && F.byId.get(buf.readUInt32LE(at + 4));
      if (mb && mb.cls === 'i3MemoryBuffer') {
        const n = buf.readUInt32LE(mb.off), name = buf.toString('latin1', mb.off + 4, mb.off + 4 + n).replace(/\0[\s\S]*$/, '');
        if (name && !breakEffects.includes(name)) breakEffects.push(name);
      }
    } else if (o.cls === 'i3Sound' && o.ext && /\.wav$/i.test(o.extPath) && !breakSounds.includes(o.extPath)) breakSounds.push(o.extPath);
  }
  // i3ActionExplosion 'AEX1' + 4 f32 (drum 25/20/4/4, taxi + police 25/100/4/4): read as [?, damage, range, ?] [INFERIDO]
  let explosion = null;
  const ex = F.objects.find((o) => o.cls === 'i3ActionExplosion');
  const at = ex ? buf.indexOf('AEX1', ex.off, 'latin1') : -1;
  if (at >= 0 && at < ex.off + ex.size) explosion = { raw: [0, 1, 2, 3].map((k) => r4(buf.readFloatLE(at + 4 + k * 4))) };
  if (explosion) Object.assign(explosion, { damage: explosion.raw[1], range: explosion.raw[2] });
  return { life, stateCount, states, breakEffects, breakSounds, stateSounds: readStateSounds(buf, F), explosion, breakable: F.objects.some((o) => o.cls === 'i3ActionBreakObject'), template, classes: [...new Set(F.objects.map((o) => o.cls))] };
}

// ---- model (.I3S) -> GLB ------------------------------------------------------------------------------------------
class GLBW {
  constructor() { this.chunks = []; this.len = 0; this.json = { asset: { version: '2.0', generator: 'pb export-props.mjs' }, buffers: [], bufferViews: [], accessors: [], images: [], textures: [], materials: [], meshes: [], nodes: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] }; }
  accessor(arr, type, target, minmax) {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.len += pad; }
    this.json.bufferViews.push({ buffer: 0, byteOffset: this.len, byteLength: arr.byteLength, target });
    this.chunks.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); this.len += arr.byteLength;
    const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const acc = { bufferView: this.json.bufferViews.length - 1, componentType: arr instanceof Float32Array ? 5126 : arr instanceof Uint16Array ? 5123 : 5125, count: arr.length / nc, type };
    if (minmax) {
      acc.min = new Array(nc).fill(Infinity); acc.max = new Array(nc).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) { const k = i % nc; acc.min[k] = Math.min(acc.min[k], arr[i]); acc.max[k] = Math.max(acc.max[k], arr[i]); }
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  build() {
    const J = this.json;
    const bin = Buffer.concat(this.chunks), binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    J.buffers = [{ byteLength: binPad.length }];
    for (const k of ['images', 'textures', 'materials']) if (!J[k].length) delete J[k];
    let js = Buffer.from(JSON.stringify(J), 'utf8');
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const hdr = Buffer.alloc(12); hdr.write('glTF', 0, 'latin1'); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8);
    const ch = (b, t) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.write(t, 4, 'latin1'); return Buffer.concat([h, b]); };
    return Buffer.concat([hdr, ch(js, 'JSON'), ch(binPad, 'BIN\0')]);
  }
}

const xformP = (m, x, y, z) => [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];
function normalMatrix(m) { // (A^-1)^T of the upper 3x3, row-vector convention (same as export-visual.mjs)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  return { det, n: [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]] };
}

function stateTex(d, file, a) { // i3TextureBindAttr / i3LuxMapBindAttr -> I3IB descriptor source
  const ao = a && file.byId.get(a.id);
  if (!ao) return null;
  const ref = d.readUInt32LE(ao.off), t = file.byId.get(ref) || file.byId.get(ref & 0xffff);
  if (!t) return null;
  if (t.ext) return { ext: t.extPath };
  const i = t.cls === 'i3Texture' && readI3IB(d, t.off, t.off + t.size);
  return i && i.kind !== 'unsupported' ? { inline: { ...i, srcPath: i.srcPath || `i3Texture_${t.id}`, buf: d, source: 'inline' } } : null;
}

// Rotation matrix (row-vector rows = images of the basis) -> three.js quaternion [x,y,z,w].
function quatFromRows(m) {
  // column-convention matrix C = transpose(rows)
  const m11 = m[0], m12 = m[3], m13 = m[6], m21 = m[1], m22 = m[4], m23 = m[7], m31 = m[2], m32 = m[5], m33 = m[8];
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s; }
  else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s; }
  else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s; }
  else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s; }
  return [x, y, z, w].map(r4);
}

// i3PhysixShapeSet -> box colliders in object (three.js) space; the shape set's world = its parent transform chain.
function readCollision(d, file) {
  const sets = file.objects.filter((o) => o.cls === 'i3PhysixShapeSet');
  if (!sets.length) return { kind: 'none' };
  // transform worlds (row-vector, world = local * parent)
  const tr = new Map();
  for (const o of file.objects) {
    if (o.ext || !['i3Node', 'i3Transform', 'i3Transform2', 'i3AttrSet'].includes(o.cls)) continue;
    try {
      const n = readNode(d, o);
      if (o.cls === 'i3Transform' || o.cls === 'i3Transform2') n.matrixRef = d.readUInt32LE(n.end);
      tr.set(o.id, n);
    } catch { /* not a node layout */ }
  }
  const parent = new Map();
  for (const [id, n] of tr) for (const c of n.children) parent.set(c, id);
  const matOf = (id) => {
    const mo = file.byId.get(tr.get(id)?.matrixRef);
    return mo?.cls === 'i3MatrixObject' ? Array.from({ length: 16 }, (_, k) => d.readFloatLE(mo.off + k * 4)) : IDENT;
  };
  // Object models keep the shape set outside the node tree (no transform lists it): its NX poses are in the raw
  // model space (Vending_01: box half-height 1.17 on z, the Z-up mesh), i.e. under the root "AxisRotate" transform.
  const roots = [...tr.keys()].filter((id) => !parent.has(id) && tr.get(id).matrixRef);
  const worldOf = (id) => {
    if (!parent.has(id)) return roots.length === 1 ? matOf(roots[0]) : IDENT;
    let m = IDENT;
    for (let p = parent.get(id); p !== undefined; p = parent.get(p)) m = mul(m, matOf(p));
    return m;
  };
  const boxes = [], other = [];
  const MARK = Buffer.from([0xef, 0xcd, 0xab, 0x00]);
  const sorted = file.objects.map((o) => o.off).sort((a, b) => a - b);
  for (const s of sets) {
    const W = worldOf(s.id);
    const end = s.size > 32 ? s.off + s.size : sorted.find((o) => o > s.off) ?? d.length;
    for (let p = d.indexOf(MARK, s.off); p >= 0 && p < end; p = d.indexOf(MARK, p + 4)) {
      const type = d.readUInt32LE(p + 4);
      if (type === 33) {
        const half = [0, 1, 2].map((k) => d.readFloatLE(p + 16 + k * 4));
        const q = d.indexOf(MARK, p + 28);
        if (q < 0 || d.readUInt32LE(q + 4) !== 32) { other.push('box-without-pose'); continue; }
        const P = (k) => d.readFloatLE(q + 12 + k * 4); // localPose 4x4 at u32 index 3..18: rows [R | t]
        const R = [P(3), P(4), P(5), P(7), P(8), P(9), P(11), P(12), P(13)], t = [P(6), P(10), P(14)];
        // column-vector [R|t] -> row-vector matrix, then through the i3 chain (AxisRotate)
        const L = [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
        const M = mul(L, W);
        const rows = [0, 1, 2].map((i) => [M[i * 4], M[i * 4 + 1], M[i * 4 + 2]]);
        const len = rows.map((v) => Math.hypot(...v) || 1);
        const rot = rows.flatMap((v, i) => v.map((x) => x / len[i]));
        boxes.push({ center: [M[12], M[13], M[14]].map(r4), quat: quatFromRows(rot), half: half.map((h, i) => r4(h * len[i])) });
      } else if ([34, 35, 36, 37, 38, 39, 40].includes(type)) other.push(`nxShape${type}`);
    }
  }
  if (boxes.length && !other.length) return { kind: 'boxes', boxes };
  if (boxes.length) return { kind: 'boxes', boxes, unsupported: [...new Set(other)] };
  return { kind: 'visual', source: 'visual triangles [RECRIADO]: NX ' + ([...new Set(other)].join(',') || 'shape') + ' not decoded' };
}

// Embedded i3Animation of a model (.I3S): one i3TransformSequence per bone = name, 6 flag bytes, u32 0, u32 keyCount, u32 0,
// f32 duration, then T[n] vec3, R[n] quat xyzw, S[n] vec3, time[n]. Returns the bones whose pose really moves.
// CH47_Idle: Root hovers (z bob 0.15 + ~1.7 deg wobble), Bone_Back / Bone_Front spin about their local Z (40 deg per key,
// 91 keys over 3 s, key 90 = 3600 deg = loop).
function readAnimBones(d, file) {
  const bones = {};
  for (const o of file.objects) {
    if (o.ext || o.cls !== 'i3TransformSequence') continue;
    const nl = d[o.off], name = d.toString('latin1', o.off + 1, o.off + 1 + nl), q = o.off + 1 + nl + 6;
    const n = d.readUInt32LE(q + 4), base = q + 16;
    if (!(n > 1) || base + n * 14 * 4 > d.length) continue;
    const f = (i) => d.readFloatLE(base + i * 4);
    const T = [], R = [], times = [];
    for (let k = 0; k < n; k++) { T.push([0, 1, 2].map((c) => f(k * 3 + c))); R.push([0, 1, 2, 3].map((c) => f(n * 3 + k * 4 + c))); times.push(f(n * 10 + k)); }
    const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
    if (T.some((t) => dist(t, T[0]) > 1e-4) || R.some((r) => dist(r, R[0]) > 1e-3)) bones[name] = { T, R, times };
  }
  return bones;
}

// named i3Transform -> { W: world (row-vector, local * parent), P: parent world } by name
function transformWorlds(d, file) {
  const tr = new Map();
  for (const o of file.objects) {
    if (o.ext || !['i3Transform', 'i3Transform2'].includes(o.cls)) continue;
    try { const n = readNode(d, o); n.matrixRef = d.readUInt32LE(n.end); tr.set(o.id, n); } catch { /* not a node layout */ }
  }
  const parent = new Map();
  for (const o of file.objects) { if (o.ext) continue; try { for (const c of readNode(d, o).children) parent.set(c, o.id); } catch { /* not a node */ } }
  const matOf = (id) => {
    const mo = file.byId.get(tr.get(id)?.matrixRef);
    return mo?.cls === 'i3MatrixObject' ? Array.from({ length: 16 }, (_, k) => d.readFloatLE(mo.off + k * 4)) : IDENT;
  };
  const out = new Map();
  for (const [id, n] of tr) {
    let P = IDENT;
    for (let p = parent.get(id); p !== undefined; p = parent.get(p)) P = mul(P, matOf(p));
    out.set(n.name, { W: mul(matOf(id), P), P });
  }
  return out;
}

// 3x3 row-vector rotation of a quaternion xyzw (= the transpose of the column matrix, D3DX style)
function rowMat3(q) {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
}
const m3mul = (a, b) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]); return r; };
const m3t = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const vm3 = (v, m) => [v[0] * m[0] + v[1] * m[3] + v[2] * m[6], v[0] * m[1] + v[1] * m[4] + v[2] * m[7], v[0] * m[2] + v[1] * m[5] + v[2] * m[8]];

function exportModel(id, ent, texFor, { log }) {
  const d = readEntry(ent);
  const scenes = scanI3R2(d).filter((b) => b.objects.some((o) => o.cls === 'i3Geometry'));
  if (!scenes.length) throw noModel(`${ent.path}: no i3Geometry scene`);
  // a break file (vending, tank) holds the intact scene first, named after the intact file, then its own scene named after
  // itself: the state's model is the self-named one, else the first [INFERIDO: exe not checked]
  const own = baseName(ent.path);
  const file = scenes.find((s) => s.strings.some((x) => /\.i3s$/i.test(x) && baseName(x) === own)) ?? scenes[0];
  const meshes = collectMeshes(d, file);
  // i3SceneGraphInfo 'SGI1' +8 = the scene's common i3AttrSet (glass: texture/blend state live only there, the set is
  // not a parent of any node), applied under every mesh's own state
  const base = {};
  const sgi = file.objects.find((o) => o.cls === 'i3SceneGraphInfo' && !o.ext);
  const sg1 = sgi ? d.indexOf('SGI1', sgi.off, 'latin1') : -1;
  const common = sg1 >= 0 && sg1 < sgi.off + sgi.size ? file.byId.get(d.readUInt32LE(sg1 + 8)) : null;
  if (common?.cls === 'i3AttrSet') {
    const n = readNode(d, common);
    const ids = [];
    if (d.toString('latin1', n.end, n.end + 4) === 'ATS1') { const c = d.readUInt32LE(n.end + 4); for (let i = 0; i < c; i++) ids.push(d.readUInt32LE(n.end + 16 + i * 4)); }
    else { const c = d.readUInt16LE(n.end); for (let i = 0; i < c; i++) ids.push(d.readUInt32LE(n.end + 2 + i * 4)); }
    for (const id of ids) { const ao = file.byId.get(id); if (ao) { const a = readAttr(d, ao, file); base[a.cls] = a; } }
  }
  for (const m of meshes) m.state = { ...base, ...m.state };
  const G = new GLBW(), J = G.json;
  const texDir = path.join(OBJ_OUT, 'tex');
  fs.mkdirSync(texDir, { recursive: true });
  const texIdx = new Map(), missing = new Set();
  const texture = (src) => {
    const t = src?.inline || (src?.ext && texFor(ent.pack, src.ext, id));
    if (!t) { if (src?.ext) missing.add(stem(src.ext)); return null; }
    const key = t.source + ':' + t.data;
    if (texIdx.has(key)) return texIdx.get(key);
    const rgba = decodeI3IB(t.buf, t);
    let minA = 255;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < minA) minA = rgba[i];
    const hasAlpha = minA < 250;
    const name = stem(t.srcPath).replace(/[^\w.-]+/g, '_');
    fs.writeFileSync(path.join(texDir, name + '.png'), encodePNG(rgba, t.w, t.h, hasAlpha)); // shared by stem across objects
    J.images.push({ uri: `tex/${encodeURIComponent(name)}.png`, name });
    J.textures.push({ source: J.images.length - 1, sampler: 0 });
    const r = { index: J.textures.length - 1, hasAlpha };
    texIdx.set(key, r);
    return r;
  };
  const matIdx = new Map();
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  let tris = 0, keyed = 0;
  const colTris = [], meshPath = [];
  for (const m of meshes) {
    const st = m.state;
    const texOn = st.i3TextureEnableAttr?.value !== false, luxOn = st.i3LuxMapEnableAttr?.value !== false;
    const bt = texOn ? texture(stateTex(d, file, st.i3TextureBindAttr)) : null;
    const lt = luxOn ? texture(stateTex(d, file, st.i3LuxMapBindAttr)) : null;
    const cull = st.i3FaceCullModeAttr ? d[file.byId.get(st.i3FaceCullModeAttr.id).off] : null; // D3DCULL 1 = none
    const blend = st.i3BlendEnableAttr?.value === true, alphaTest = st.i3AlphaTestEnableAttr?.value === true;
    // blending wins: alpha test without an i3AlphaFuncAttr is D3D's default ALPHAFUNC ALWAYS (glass: blend + test on,
    // ZWrite off); MASK only for alpha test alone or test with an explicit AlphaFunc and no blend
    const alphaMode = bt?.hasAlpha ? (blend ? 'BLEND' : 'MASK') : 'OPAQUE';
    void alphaTest;
    const cutoff = st.i3AlphaFuncAttr ? Math.max(0.05, Math.min(0.95, (st.i3AlphaFuncAttr.ref || 128) / 255)) : 0.5;
    const key = [bt?.index, lt?.index, alphaMode, cull === 1, cutoff].join('|');
    if (!matIdx.has(key)) {
      const mat = { name: (bt ? J.images[J.textures[bt.index].source].name : 'untextured') + (lt ? '+lm' : ''), pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } };
      if (bt) mat.pbrMetallicRoughness.baseColorTexture = { index: bt.index, texCoord: 0 };
      if (lt) { mat.occlusionTexture = { index: lt.index, texCoord: 1 }; mat.extras = { lightMap: { index: lt.index, texCoord: 1 } }; }
      if (alphaMode !== 'OPAQUE') mat.alphaMode = alphaMode;
      if (alphaMode === 'MASK') mat.alphaCutoff = cutoff;
      if (cull === 1) mat.doubleSided = true;
      J.materials.push(mat);
      matIdx.set(key, J.materials.length - 1);
    }
    let idx;
    try { idx = meshIndices(m).indices; } catch { keyed++; continue; }
    const remap = new Map(), order = [], local = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i++) {
      let r = remap.get(idx[i]);
      if (r === undefined) { r = order.length; remap.set(idx[i], r); order.push(idx[i]); }
      local[i] = r;
    }
    const { det, n: N } = normalMatrix(m.world);
    if (det < 0) for (let i = 0; i < local.length; i += 3) { const t = local[i + 1]; local[i + 1] = local[i + 2]; local[i + 2] = t; }
    const va = m.va, W = m.world, nv = order.length;
    const pos = new Float32Array(nv * 3), nrm = va.nrm ? new Float32Array(nv * 3) : null;
    const uv0 = va.uv[0] ? new Float32Array(nv * 2) : null, uv1 = va.uv[1] && lt ? new Float32Array(nv * 2) : null;
    order.forEach((s, i) => {
      const p = xformP(W, va.pos[s * 3], va.pos[s * 3 + 1], va.pos[s * 3 + 2]);
      pos.set(p, i * 3);
      for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], p[k]); bmax[k] = Math.max(bmax[k], p[k]); }
      if (nrm) {
        const x = va.nrm[s * 3], y = va.nrm[s * 3 + 1], z = va.nrm[s * 3 + 2];
        const nx = x * N[0] + y * N[3] + z * N[6], ny = x * N[1] + y * N[4] + z * N[7], nz = x * N[2] + y * N[5] + z * N[8];
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
      }
      if (uv0) { uv0[i * 2] = va.uv[0][s * 2]; uv0[i * 2 + 1] = va.uv[0][s * 2 + 1]; }
      if (uv1) { uv1[i * 2] = va.uv[1][s * 2]; uv1[i * 2 + 1] = va.uv[1][s * 2 + 1]; }
    });
    const attributes = { POSITION: G.accessor(pos, 'VEC3', 34962, true) };
    if (nrm) attributes.NORMAL = G.accessor(nrm, 'VEC3', 34962);
    if (uv0) attributes.TEXCOORD_0 = G.accessor(uv0, 'VEC2', 34962);
    if (uv1) attributes.TEXCOORD_1 = G.accessor(uv1, 'VEC2', 34962);
    const ind = nv < 65536 ? Uint16Array.from(local) : local;
    J.meshes.push({ name: m.name, primitives: [{ attributes, indices: G.accessor(ind, 'SCALAR', 34963), material: matIdx.get(key), mode: 4 }] });
    J.nodes.push({ name: m.name.split('/').pop(), mesh: J.meshes.length - 1 });
    meshPath.push(m.name.split('/'));
    tris += local.length / 3;
    colTris.push(local.length / 3);
  }
  // animated bones: mesh nodes hang under one gltf node per animated bone (vertices stay baked in object space). The node
  // animates the DELTA of the bone pose from key 0, conjugated into object space by the bone's parent world P = [A | tp]:
  // v' = ((v - tp) A^-1 Rd + td) A + tp with Rd = R0^-1 Rk, td = Tk - T0 Rd  =>  node rotation Rd_obj, translation
  // tp - Rd_obj tp + td A. Spin direction [INFERIDO]: key quaternions used as-is in the i3 (= three) world.
  const anim = readAnimBones(d, file);
  let animated = null;
  if (Object.keys(anim).length) {
    const worlds = transformWorlds(d, file);
    const sceneNodes = [], channels = [], samplers = [], boneNode = new Map();
    const attach = (child, chain) => {
      let parent = null;
      for (const bone of chain) {
        if (!boneNode.has(bone)) {
          const { P } = worlds.get(bone), { T, R, times } = anim[bone];
          const A = [P[0], P[1], P[2], P[4], P[5], P[6], P[8], P[9], P[10]], tp = [P[12], P[13], P[14]];
          const Ai = m3t(A); // rigid parent frame: inverse = transpose
          const R0i = m3t(rowMat3(R[0]));
          const tr = new Float32Array(T.length * 3), rot = new Float32Array(R.length * 4);
          for (let k = 0; k < R.length; k++) {
            const Rd = m3mul(R0i, rowMat3(R[k]));
            const Ro = m3mul(m3mul(Ai, Rd), A); // row-vector rotation in object space
            const q = quatFromRows(Ro); // quatFromRows takes the row matrix and builds the column one
            rot.set(q, k * 4);
            const T0Rd = vm3(T[0], Rd), td = [T[k][0] - T0Rd[0], T[k][1] - T0Rd[1], T[k][2] - T0Rd[2]], tdA = vm3(td, A);
            const Rc = m3t(Ro); // column matrix
            const Rtp = [Rc[0] * tp[0] + Rc[1] * tp[1] + Rc[2] * tp[2], Rc[3] * tp[0] + Rc[4] * tp[1] + Rc[5] * tp[2], Rc[6] * tp[0] + Rc[7] * tp[1] + Rc[8] * tp[2]];
            tr.set([tp[0] - Rtp[0] + tdA[0], tp[1] - Rtp[1] + tdA[1], tp[2] - Rtp[2] + tdA[2]], k * 3);
          }
          J.nodes.push({ name: bone, children: [] });
          boneNode.set(bone, J.nodes.length - 1);
          const inp = G.accessor(Float32Array.from(times), 'SCALAR', undefined, true);
          samplers.push({ input: inp, output: G.accessor(rot, 'VEC4'), interpolation: 'LINEAR' });
          channels.push({ sampler: samplers.length - 1, target: { node: boneNode.get(bone), path: 'rotation' } });
          samplers.push({ input: inp, output: G.accessor(tr, 'VEC3'), interpolation: 'LINEAR' });
          channels.push({ sampler: samplers.length - 1, target: { node: boneNode.get(bone), path: 'translation' } });
          if (parent === null) sceneNodes.push(boneNode.get(bone)); else J.nodes[parent].children.push(boneNode.get(bone));
        }
        parent = boneNode.get(bone);
      }
      if (parent === null) sceneNodes.push(child); else J.nodes[parent].children.push(child);
    };
    const nMesh = meshPath.length;
    for (let i = 0; i < nMesh; i++) attach(i, meshPath[i].filter((seg) => anim[seg] && worlds.has(seg)));
    J.animations = [{ name: 'idle', samplers, channels }];
    animated = { clip: 'idle', loop: true, bones: Object.keys(anim) };
    J.scenes = [{ name: id, nodes: sceneNodes }];
  } else J.scenes = [{ name: id, nodes: J.nodes.map((_, i) => i) }];
  J.scene = 0;
  J.extras = { source: `${ent.pack}:${ent.path}`, axes: 'object-local three.js space (AxisRotate baked); place with the GINS instance TRS' };
  const glb = path.join(OBJ_OUT, id + '.glb');
  fs.writeFileSync(glb, G.build());
  const chk = checkGLB(glb);
  if (!chk.ok) log(`  ${id}: GLB check FAIL ${chk.errors.join('; ')}`);
  return {
    glb: `/assets/objects/${id}.glb`, source: `${ent.pack}:${ent.path}`, tris, keyedSkipped: keyed,
    bounds: { min: bmin.map(r4), max: bmax.map(r4) },
    lightmapped: J.materials.some((m) => m.occlusionTexture), alpha: J.materials.some((m) => m.alphaMode && m.alphaMode !== 'OPAQUE'),
    missingTextures: [...missing], collision: readCollision(d, file), ...(animated ? { animated } : {}),
  };
}

// ---- server map objects (MapStructure.xml via matchData.json): Map Id -> [{ id, needSync, animation, life }] ----------
function readMapStructure() {
  if (!fs.existsSync(MATCH_DATA)) return new Map();
  const maps = new Map();
  for (const [id, m] of Object.entries(JSON.parse(fs.readFileSync(MATCH_DATA, 'utf8')).maps))
    maps.set(+id, m.objects.map((o) => ({ id: o.id, needSync: o.needSync, animation: o.animation, life: o.life })));
  return maps;
}

// ---- main ---------------------------------------------------------------------------------------------------------
function exportMapProps(pack, dir, mapId, IX, texFor, defs, serverMaps, log) {
  const scene = path.join(IX.packDir, `${pack}_Scene.i3Pack`);
  if (!fs.existsSync(scene)) return { dir, error: 'no _Scene pack' };
  const { ver, records } = readGINS(fs.readFileSync(scene));
  const props = [], unresolved = [], volumes = [];
  let errors = 0; // def / broken-state failures (not no-model states) created by this map
  for (const r of records) {
    if (r.cls === CLS.box) { volumes.push({ name: r.name, pos: r.pos.map(r4), quat: r.quat.map(r4), size: r.scale.map(r4) }); continue; }
    if (r.cls !== CLS.object && !OBJECTIVE_CLS.has(r.cls)) continue;
    const ent = IX.byMd5.get(r.md5);
    if (!ent) { unresolved.push({ name: r.name, md5: r.md5 }); continue; }
    const id = stem(ent.path).replace(/[^\w.-]+/g, '_');
    // Destroy objectives: blue = Transformer / *_BLUE, red = helicopter_uh60 / *_RED (the server's Obj with Animation 257 / 256)
    const defence = mapId != null && DEFENCE_MAP_IDS.has(mapId);
    const team = OBJECTIVE_CLS.has(r.cls) ? (/transformer|_blue\.i3obj$/i.test(ent.path) ? 'blue' : /helicopter_uh60|_red\.i3obj$/i.test(ent.path) ? 'red' : null)
      : defence ? (/normal_tank\.i3obj$/i.test(ent.path) ? 'red' : /armerd_tank\.i3obj$/i.test(ent.path) ? 'blue' : null) : null;
    if (!defs.has(id)) {
      const info = readI3Obj(readEntry(ent));
      // Helispot_UH60_RED.i3Obj has no i3SceneGraphInfo ref (its model is an i3Animation 'Model_UH60'): the model is the sibling .i3s
      if (!info.states.length && team) info.states = [ent.path.replace(/\.i3obj$/i, '.i3s')];
      // Cross Object_cgame millicloth.i3Obj: no model state (i3TransformSequence + i3Animation only); its model is the sibling
      // MilliCloth_Ani.i3s, the 2017 state [INFERIDO: from the name, the Cross i3Obj does not name it]
      if (!info.states.length) { const ani = ent.path.replace(/\.i3obj$/i, '_Ani.i3s'); if (IX.byPath.has(ani.toUpperCase())) info.states = [ani]; }
      const def = { id, i3Obj: `${ent.pack}:${ent.path}`, life: info.life, stateCount: info.stateCount, breakable: info.breakable && (info.stateCount > 1 || info.template), states: info.states, breakEffects: info.breakEffects, breakSounds: info.breakSounds, stateSounds: info.stateSounds, explosion: info.explosion };
      try { Object.assign(def, exportModelAny(id, info.states[0], IX, texFor, log, ent.path)); } catch (e) { if (e.noModel) def.noModel = e.message; else { def.error = e.message; errors++; } }
      // states 1.. = broken models (same GLB space): <id>_s1.glb. Objects with a single model just vanish when broken.
      if (def.breakable && !def.error) {
        def.brokenStates = [];
        for (let k = 1; k < info.states.length; k++) {
          try { const r = exportModelAny(`${id}_s${k}`, info.states[k], IX, texFor, log); def.brokenStates.push({ state: k, ...r }); }
          catch (e) { if (e.noModel) log(`  ${id}: state ${k} no model (${e.message})`); else { errors++; log(`  ${id}: state ${k} ERROR ${e.message}`); } }
        }
      }
      defs.set(id, def);
      log(`  object ${id}: ${def.error ? 'ERROR ' + def.error : def.noModel ? 'no model ' + def.noModel : `tris=${def.tris} col=${def.collision.kind}${def.collision.boxes ? 'x' + def.collision.boxes.length : ''} life=${def.life} breakable=${def.breakable}${def.missingTextures?.length ? ' missingTex=' + def.missingTextures.join(',') : ''}`}`);
    }
    const prop = { name: r.name, object: id, pos: r.pos.map(r4), quat: r.quat.map(r4), scale: r.scale.map(r4), ...(team ? { objective: team } : {}) };
    // Helispot helicopters: GINS pos 0,0,0 identity. Their start pose is the animation's key 0 (Model_UH60 idle, Root 0), and that
    // equals the i3s rest matrices (Root, Bone01-03, Model_ProF/B, WeaponPointDummy, Model_UH60, checked 2026-10-13): nothing to add.
    props.push(prop);
  }
  // server objects (MapStructure.xml, by MapId): index them onto the i3Object instances only when the counts match
  // The server list = the i3Object instances with >= 2 states (intact + broken), in GINS order: NStation 5/5,
  // Luxville 28/28 (its 42 Glass_Building_02_Exp_01 have one state, the broken glass, and are not listed).
  // Objectives (props.objective) are matched by their server Animation (blue 257, red 256) and left out of the order match.
  const server = mapId != null ? serverMaps.get(mapId) : undefined;
  const objectives = props.filter((p) => p.objective);
  const defence = mapId != null && DEFENCE_MAP_IDS.has(mapId);
  const objectiveAnim = (p) => (p.objective === 'blue' ? 257 : 256) + (defence ? 2 : 0);
  const serverObjectives = (server ?? []).filter((o) => OBJECTIVE_ANIMS.has(o.animation));
  const serverRest = (server ?? []).filter((o) => !OBJECTIVE_ANIMS.has(o.animation));
  for (const p of objectives) {
    const s = serverObjectives.find((o) => o.animation === objectiveAnim(p));
    if (s) p.net = { index: s.id, needSync: s.needSync, animation: s.animation, life: s.life };
  }
  // multi-state props first (NStation, Luxville); when the server list has every non-objective prop (Breakdown: 2..21 = 20 props) use all of them
  const nonObjective = props.filter((p) => !p.objective);
  const multiState = nonObjective.filter((p) => defs.get(p.object).stateCount > 1);
  const netProps = server && serverRest.length !== multiState.length && serverRest.length === nonObjective.length ? nonObjective : multiState;
  const netMatch = !!server && serverRest.length === netProps.length;
  if (netMatch) netProps.forEach((p, i) => { const s = serverRest[i]; p.net = { index: s.id, needSync: s.needSync, animation: s.animation, life: s.life }; });
  const used = [...new Set(props.map((p) => p.object))].map((id) => defs.get(id));
  const out = {
    source: `${pack}_Scene.i3Pack GINS v${ver}`,
    axes: 'three.js world (= i3 world); instance TRS applies to the object GLB (object-local three space)',
    objects: Object.fromEntries(used.map((d) => [d.id, d])),
    props,
    unresolved,
    volumes: { count: volumes.length, note: 'GINS box volumes (class 0x4cc77521: map sectors / trigger areas), no visual, not collision', list: volumes },
    server: server
      ? { mapId, source: 'web-poc/src/host/data/matchData.json (MapStructure.xml)', objects: server, matchedByOrder: netMatch, rule: 'i3Object instances with stateCount >= 2, GINS order', ...(netMatch ? {} : { note: `server lists ${server.length} objects, GINS has ${netProps.length} multi-state i3Object instances: not mapped` }) }
      : { mapId, note: 'no MapStructure entry' },
  };
  fs.writeFileSync(path.join(MAPS, dir, 'props.json'), JSON.stringify(out, null, 1));
  return { dir, ver, props: props.length, netProps: netProps.length, objects: used.length, unresolved: unresolved.length, volumes: volumes.length, server: server?.length ?? null, netMatch, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const packDir = path.resolve(opt('--pack-dir') ?? clientPath(baseClient('cross'), 'Pack'));
  const all = args.includes('--all'); if (all) args.splice(args.indexOf('--all'), 1);
  const index = JSON.parse(fs.readFileSync(path.join(MAPS, 'index.json'), 'utf8'));
  const wanted = all ? index.filter((m) => m.source === 'cross') : (args.length ? args : ['NStation', 'Luxville'])
    .map((a) => index.find((m) => m.pack.toLowerCase() === a.toLowerCase() || m.id === a.toLowerCase()) || { id: a.toLowerCase(), pack: a, mapId: null });
  const t0 = Date.now();
  const IX = { ...buildIndex(packDir), packDir };
  console.log(`index: ${IX.byMd5.size} .i3Obj, ${IX.byPath.size} files (${Date.now() - t0} ms)`);
  if (args.includes('--sounds')) {
    // only refresh stateSounds (+ breakSounds) of the defs already in objects/index.json: no model / texture re-export
    const f = path.join(OBJ_OUT, 'index.json'), cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    let n = 0;
    for (const ent of new Set(IX.byMd5.values())) {
      const d = cur.objects[stem(ent.path).replace(/[^\w.-]+/g, '_')];
      if (!d) continue;
      const info = readI3Obj(readEntry(ent));
      d.breakSounds = info.breakSounds; d.stateSounds = info.stateSounds; n++;
    }
    fs.writeFileSync(f, JSON.stringify(cur, null, 1));
    console.log(`sounds: ${n} defs patched`);
    process.exit(0);
  }
  const texFor = textureLookup(IX);
  const serverMaps = readMapStructure();
  const defs = new Map();
  fs.mkdirSync(OBJ_OUT, { recursive: true });
  const report = [];
  for (const m of wanted) {
    if (!fs.existsSync(path.join(MAPS, m.id))) { console.log(`${m.id}: no maps/${m.id} dir, skipped`); continue; }
    console.log(`${m.pack} -> maps/${m.id}/props.json`);
    try {
      const r = exportMapProps(m.pack, m.id, m.mapId, IX, texFor, defs, serverMaps, console.log);
      report.push(r);
      console.log(`  ${JSON.stringify(r)}`);
    } catch (e) { report.push({ dir: m.id, error: e.message }); console.log(`  ERROR ${e.stack}`); }
  }
  // objects/index.json accumulates across runs
  const idxFile = path.join(OBJ_OUT, 'index.json');
  const prev = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { objects: {} };
  for (const [id, d] of defs) prev.objects[id] = d;
  prev.generator = 'tools/export-props.mjs';
  fs.writeFileSync(idxFile, JSON.stringify(prev, null, 1));
  const bad = report.filter((r) => r.error).length + report.reduce((a, r) => a + (r.errors || 0), 0);
  const noModel = [...defs.values()].filter((d) => d.noModel).length;
  console.log(`done: ${report.length} maps, ${defs.size} objects, ${bad} errors, ${noModel} objects with no model (effect/path/animation), ${report.reduce((a, r) => a + (r.unresolved || 0), 0)} unresolved instances (${Date.now() - t0} ms)`);
  process.exitCode = bad ? 1 : 0;
}
export { buildIndex, readI3Obj, readEntry, readCollision };
