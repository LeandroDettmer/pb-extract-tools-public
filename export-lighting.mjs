#!/usr/bin/env node
// Per-map i3Engine lighting parameters -> out/maps/<map>/lighting.json. Pure Node ESM.
//
//   node export-lighting.mjs [mapDir ...] [--out DIR]   (default: every maps/<dir> with a visual.glb)
//
// Every value is read from the original client data; the layouts come from the clean 2017 DLLs/exe
// (Clients/PBCross, the only map client). See docs/LIGHTING.md for the full derivation.
//
//  stage     Stage.pef (decoded: extracted/pef-cross/br/Stage.json) "Ambient" / "DefaultDiffuse" (I3COLOR, /255).
//            CStageBattle::LoadProperties (exe 0x764080): Ambient -> i3SceneGraphContext::setAmbient -> g_vAmbient;
//            DefaultDiffuse -> fallback material diffuse of characters (CGameCharaMaterialContext, exe 0x821e50).
//  light     <Map>_SubData.i3Pack  Light/<Map>_Light0.i3Light : i3LightAttr persist block (i3Light::OnLoad,
//            i3GfxDx 0x100bcd30, 0x62 bytes): u16 type @0, diffuse RGBA @0x12, specular RGBA @0x22,
//            angles @0x3e/0x42, shadow-map size @0x46, range @0x4a.
//  transform <Map>_Scene.i3Pack game-instance list (GINS / .i3INS): the i3LightObject record (class hash
//            0xd966c30d) = u32 hash, vec3 pos, quat (x,y,z,w), vec3 scale. i3Light::GetWorldSpaceDirection
//            returns row 2 (the Z axis) of the world matrix; i3ShaderContext::UpdateParams (i3GfxDx 0x100d9eb5)
//            sends it untouched (view space, normalised) as g_vLightDir0 and the shaders use dot(N, g_vLightDir0),
//            so it is the direction *towards* the light.
//  fog       <Map>.i3Pack i3World 'WRD2' block (i3World::OnLoad2, i3FrameworkDx 0x1010fc80): 2 fog blocks of 0x1c
//            bytes at +0x2c: u8 enable, u8 mode (D3DFOGMODE: 3 = LINEAR, sent to D3DRS_FOGTABLEMODE), I3COLOR,
//            f32 density, f32 near, f32 far. Index 0 = world root, index 1 = sky root (i3World::CreateFogAttr).
//  material  <Map>.i3Pack i3MaterialAttr (i3MaterialAttr::OnLoad: ambient, diffuse, specular, emissive, shininess).
//  lightVolume <Map>_SubData.i3Pack <Map>_Light.i3s (i3World "LightVolumeCollision"): i3CollideeMesh triangles
//            with an RGBA colour per triangle. Characters query it with a sphere every 0.033 s and use
//            avg(rgb * 2 / 255) as their material diffuse (exe 0x821e50 -> 0x821ae0 i3MaterialAttr::GetDiffuse).

import { assetPath, clientPath, extractedPath, rel } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readI3R2, scanI3R2 } from './i3r2/i3r2.mjs';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';

const CROSS = clientPath('cross', 'Pack');
const MAPS_DIR = assetPath('maps');

// Stage.pef key when it differs from the pack name beyond case.
// [NÃO CONFIRMADO] A_Blowcity has no own Stage.pef entry in the decoded Cross table; "Blowcity" is the base stage.
const STAGE_ALIAS = { a_blowcity: 'Blowcity' };

/**
 * web map dir -> { pack, dir, stage }. Same source as tools/export-maps-2017.mjs: maps/<dir>/visual.json "source" is the
 * pack tools/export-visual.mjs read (Cross Pack). Stage key = Stage.pef key equal to the pack
 * name ignoring case.
 */
export function resolveMap(mapId, stageAll) {
  const vjFile = path.join(MAPS_DIR, mapId, 'visual.json');
  if (!fs.existsSync(vjFile)) throw new Error(`no maps/${mapId}/visual.json`);
  const pack = JSON.parse(fs.readFileSync(vjFile, 'utf8')).source.replace(/\.i3Pack$/i, '');
  if (!fs.existsSync(path.join(CROSS, `${pack}.i3Pack`))) throw new Error(`${pack}.i3Pack not found in Cross Pack`);
  const dir = CROSS;
  const stage = STAGE_ALIAS[mapId] ?? Object.keys(stageAll).find((k) => k.toLowerCase() === pack.toLowerCase());
  return { pack, dir, stage };
}

/** Every map dir that has a visual.glb. */
export const listMapIds = () => fs.readdirSync(MAPS_DIR).filter((d) => fs.existsSync(path.join(MAPS_DIR, d, 'visual.glb'))).sort();

const I3LIGHTOBJECT_CLASS_HASH = 0xd966c30d;

/** Files of an i3Pack (decrypted when the index decodes) + the raw pack bytes as a last resort. */
function packFiles(file) {
  if (!fs.existsSync(file)) return [];
  const d = fs.readFileSync(file);
  const out = [];
  try {
    for (const n of parsePack(d).nodes) {
      if (!n.indexOk) continue;
      for (const f of n.files) {
        let buf = d.subarray(f.offset, f.offset + f.size);
        if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
        out.push({ name: `${n.path}/${f.name}`, buf });
      }
    }
  } catch { /* not a PFN2/3 pack: raw scan only */ }
  out.push({ name: `<raw ${path.basename(file)}>`, buf: d });
  return out;
}

const f32 = (b, o) => +b.readFloatLE(o).toFixed(6);
const rgba = (b, o) => [f32(b, o), f32(b, o + 4), f32(b, o + 8), f32(b, o + 12)];

function readLight(files) {
  const hit = files.find((f) => /\/Light\/[^/]*\.i3Light$/i.test(f.name) || /Light\/\d+\.i3r2$/i.test(f.name));
  if (!hit) return null;
  const r = readI3R2(hit.buf);
  const la = r.objects.find((o) => o.cls === 'i3LightAttr');
  const lo = r.objects.find((o) => o.cls === 'i3LightObject');
  if (!la) return null;
  const b = hit.buf, o = la.off;
  // i3LightObject name (1.9 files keep it in the object; 1.7 files only in the file name)
  let name = path.basename(hit.name).replace(/\.i3Light$/i, '');
  if (lo && b[lo.off] > 0 && b[lo.off] < 64) {
    const n = b.toString('latin1', lo.off + 1, lo.off + 1 + b[lo.off]);
    if (/^[\x20-\x7e]+$/.test(n)) name = n;
  }
  return {
    file: hit.name, name,
    persistType: b.readUInt16LE(o), // I3G_PERSIST_LIGHT_TYPE (i3Gfx::Convert -> 3 = directional in CStageBattle::OnCreate)
    diffuse: rgba(b, o + 0x12),
    specular: rgba(b, o + 0x22),
    innerAngle: f32(b, o + 0x3e), outerAngle: f32(b, o + 0x42),
    shadowMapSize: b.readUInt32LE(o + 0x46),
    range: f32(b, o + 0x4a),
  };
}

function readLightTransform(files, lightName) {
  const cands = [];
  for (const f of files) {
    const b = f.buf;
    for (let p = 4; p + 44 <= b.length; p += 1) {
      if (b.readUInt32LE(p) !== I3LIGHTOBJECT_CLASS_HASH) continue;
      const pos = [f32(b, p + 4), f32(b, p + 8), f32(b, p + 12)];
      const q = [f32(b, p + 16), f32(b, p + 20), f32(b, p + 24), f32(b, p + 28)];
      const s = [f32(b, p + 32), f32(b, p + 36), f32(b, p + 40)];
      const qn = Math.hypot(...q);
      if (![...pos, ...q, ...s].every(Number.isFinite) || Math.abs(qn - 1) > 1e-3) continue;
      const tail = b.toString('latin1', p + 44, Math.min(b.length, p + 140));
      const m = tail.match(/[A-Za-z0-9_]*Light[A-Za-z0-9_]*/);
      cands.push({ file: f.name, offset: p - 4, name: m ? m[0] : null, pos, quat: q, scale: s });
    }
    if (cands.length) break; // first file that has instances (decrypted file before the raw pack)
  }
  return cands.find((c) => c.name === lightName) ?? cands.find((c) => c.name && lightName && c.name.startsWith(lightName)) ?? cands[0] ?? null;
}

// Row 2 of D3DXMatrixRotationQuaternion (row-vector convention, v' = v * M) = the rotated +Z axis.
function zAxis([x, y, z, w]) {
  const v = [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
  const l = Math.hypot(...v) || 1;
  return v.map((c) => +(c / l).toFixed(6));
}

function readWorld(files) {
  for (const f of files) {
    let blobs;
    try { blobs = scanI3R2(f.buf); } catch { continue; }
    for (const r of blobs) {
      const w = r.objects.find((o) => o.cls === 'i3World');
      if (!w) continue;
      const b = f.buf;
      const at = b.indexOf('WRD2', w.off, 'latin1');
      if (at < 0 || at > w.off + w.size) continue;
      const fog = [0, 1].map((i) => {
        const o = at + 0x2c + i * 0x1c;
        return {
          index: i, target: i === 0 ? 'world' : 'sky',
          enable: b[o] !== 0, mode: b[o + 1], modeName: ['NONE', 'EXP', 'EXP2', 'LINEAR'][b[o + 1]] ?? String(b[o + 1]),
          color: [b[o + 4], b[o + 5], b[o + 6], b[o + 7]],
          density: f32(b, o + 8), near: f32(b, o + 12), far: f32(b, o + 16),
        };
      });
      const mats = r.objects.filter((o) => o.cls === 'i3MaterialAttr' && o.size >= 68).map((o) => ({
        ambient: rgba(b, o.off), diffuse: rgba(b, o.off + 16), specular: rgba(b, o.off + 32), emissive: rgba(b, o.off + 48), shininess: f32(b, o.off + 64),
      }));
      const af = r.objects.find((o) => o.cls === 'i3AlphaFuncAttr');
      return { file: f.name, fog, materials: mats, alphaFunc: af ? { ref: b[af.off], func: b[af.off + 4] } : null };
    }
  }
  return null;
}

function readLightVolume(files, pack) {
  const hit = files.find((f) => new RegExp(`${pack}(_Col)?_Light\\.i3s$`, 'i').test(f.name));
  if (!hit) return null;
  const b = hit.buf, r = readI3R2(b);
  const positions = [], tris = [], colors = [];
  const vecCache = new Map();
  const vec3Array = (id) => {
    if (vecCache.has(id)) return vecCache.get(id);
    const o = r.byId.get(id);
    if (!o || o.cls !== 'i3Vector3Array') return null;
    const n = b.readUInt32LE(o.off), base = positions.length / 3;
    for (let i = 0; i < n; i++) positions.push(+b.readFloatLE(o.off + 4 + i * 12).toFixed(4), +b.readFloatLE(o.off + 8 + i * 12).toFixed(4), +b.readFloatLE(o.off + 12 + i * 12).toFixed(4));
    const v = { base, n };
    vecCache.set(id, v);
    return v;
  };
  let meshes = 0, bad = 0;
  for (const o of r.objects) {
    if (o.cls !== 'i3CollideeMesh') continue;
    // i3CollideeMesh::OnLoad (i3SceneDx 0x10121ec0): u16 version, u32 posArrayId, u32 normalArrayId, u32 triCount,
    // version >= 4: 0x20 more bytes, then triCount records of 0x18 bytes (v5): u32 i0,i1,i2, u32 normalIdx, 4 bytes, RGBA.
    const ver = b.readUInt16LE(o.off), posId = b.readUInt32LE(o.off + 2), triCount = b.readUInt32LE(o.off + 10);
    if (ver !== 5) { bad++; continue; }
    const va = vec3Array(posId);
    if (!va) { bad++; continue; }
    let p = o.off + 14 + 0x20;
    for (let t = 0; t < triCount; t++, p += 0x18) {
      const i0 = b.readUInt32LE(p), i1 = b.readUInt32LE(p + 4), i2 = b.readUInt32LE(p + 8);
      if (i0 >= va.n || i1 >= va.n || i2 >= va.n) { bad++; continue; }
      tris.push(va.base + i0, va.base + i1, va.base + i2);
      colors.push(b[p + 0x14], b[p + 0x15], b[p + 0x16]);
    }
    meshes++;
  }
  return { file: hit.name, meshes, skipped: bad, positions, tris, colors };
}

export function exportLighting(mapId, { outRoot = assetPath('maps'), log = console.log } = {}) {
  const stageAll = JSON.parse(fs.readFileSync(extractedPath('pef-cross', 'br', 'Stage.json'), 'utf8')).Stage;
  const m = resolveMap(mapId, stageAll);
  const st = m.stage && stageAll[m.stage];
  // DeadTown has a map pack but no Cross Stage.pef entry. Cross exe (PointBlank.exe, CStageBattle::LoadProperties 0x759920):
  // FindKey("Stage") -> FindKey(stage name) returns NULL -> `je 0x759ca7` skips every Stage read (Ambient, DefaultDiffuse,
  // TopViewCameraPos, BombPosition_*) and the setAmbient (0x759ab7) on the found path. So the client applies no Stage lighting here;
  // the web skips the fetch (render/pbLighting.ts NO_LIGHTING). [INFERIDO] the scene ambient keeps its prior value, not reset by this code.
  if (!st) { log(`${mapId}: skip (Stage.pef has no entry for ${m.pack}, no lighting.json)`); return null; }
  const P = (s) => path.join(m.dir, `${m.pack}${s}.i3Pack`);
  const sub = packFiles(P('_SubData')), scene = packFiles(P('_Scene')), world = packFiles(P(''));

  const light = readLight(sub);
  const xf = light ? readLightTransform(scene, light.name) : null;
  const w = readWorld(world);
  const lv = readLightVolume([...sub, ...packFiles(P('_Col'))], m.pack);
  const c255 = (c) => c.slice(0, 3).map((v) => +(v / 255).toFixed(6));

  const J = {
    map: mapId,
    sources: {
      packDir: rel(m.dir),
      stage: `Stage.pef [${m.stage}] (extracted/pef-cross/br/Stage.json)`,
      light: light?.file ?? null, transform: xf ? `${xf.file} @${xf.offset}` : null,
      world: w?.file ?? null, lightVolume: lv?.file ?? null,
    },
    // g_vAmbient: characters/weapons/unlit-by-lux world shaders add diffuse * ambient.
    ambient: c255(st.Ambient),
    ambientI3Color: st.Ambient,
    // character/weapon i3MaterialAttr diffuse when the light volume has no triangle under them.
    defaultDiffuse: c255(st.DefaultDiffuse),
    defaultDiffuseI3Color: st.DefaultDiffuse,
    camFar: st.CamFar ?? null,
    light: light && {
      name: light.name, persistType: light.persistType,
      diffuse: light.diffuse, specular: light.specular, range: light.range, shadowMapSize: light.shadowMapSize,
      position: xf?.pos ?? null, quat: xf?.quat ?? null,
      // [NÃO CONFIRMADO] without the GINS record the i3Light world matrix is identity -> +Z.
      dirToLight: xf ? zAxis(xf.quat) : [0, 0, 1],
    },
    fog: w?.fog ?? [],
    worldMaterials: w?.materials ?? [],
    alphaFunc: w?.alphaFunc ?? null,
    lightVolume: lv && { meshes: lv.meshes, triangles: lv.tris.length / 3, skipped: lv.skipped, positions: lv.positions, tris: lv.tris, colors: lv.colors },
  };
  const dir = path.join(outRoot, mapId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lighting.json'), JSON.stringify(J));
  log(`${mapId}: ambient=${J.ambient} defDiff=${J.defaultDiffuse} light=${light ? light.diffuse.slice(0, 3) : '-'} dir=${J.light?.dirToLight} ` +
    `fog0=${J.fog[0] ? `${J.fog[0].enable ? 'on' : 'off'} ${J.fog[0].modeName} ${J.fog[0].color} ${J.fog[0].near}-${J.fog[0].far}` : '-'} ` +
    `lightVolume=${lv ? `${lv.meshes} meshes ${lv.tris.length / 3} tris` : 'none'}`);
  return J;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out'), outRoot = oi >= 0 ? path.resolve(args.splice(oi, 2)[1]) : null;
  for (const id of args.length ? args : listMapIds()) {
    try { exportLighting(id.toLowerCase(), outRoot ? { outRoot } : {}); } catch (e) { process.exitCode = 1; console.error(`${id}: ERROR ${e.stack}`); }
  }
}
