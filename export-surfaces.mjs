#!/usr/bin/env node
// Per-shape impact surface for a map's collision, from the i3PhysixShapeSet names tools/export-collision.mjs
// already writes to <map>/collision.json (`shapes[]`, same order as collision.glb's nodes: one entry per
// PhysX-cooked mesh). Those names ARE the map author's own material tags (CCR/MET/GLASS/WOOD/PLASTIC/MARB/
// PAP/RUB/CLOTH/GND/GRASS/WATER/CLAY/LEAF, some TH_<X> "thin" variants) - real 2017 authoring data, not guessed.
//
// The exe's per-triangle material index inside the cooked PhysX 2.8 "NXS\x01MESH" blob (which would give
// mixed-material meshes finer granularity than one code per shape) was NOT decoded: export-collision.mjs's
// readNxsMeshes() only reads POSITION + index arrays. This tool is shape-level only. [RECRIADO/INFERIDO]
//
//   node export-surfaces.mjs [MapName] [--maps-root DIR]
//
// Output: <map>/surfaces.json { source, byIndex: string[] (parallel to collision.json shapes[] / collision.glb
// nodes), byName: Record<shapeBaseName, code> }. Codes match the suffix actually present in
// out/weapons/fx/weaponfx.json's Hit_<cat>_<code> / Hmk_<cat>_<code> effect names (Cm/Co/Gl/Mb/Me/Pa/
// Pl/So/Wo + the Hmk-only "Water"), NOT the docs-side placeholder Mt/Wd/Wt/Dt letters - see FIDELITY.md.

//
// `terrain` (parallel to byIndex): [I3_TERRAIN_TYPE, thickness] of each shape, read from the _Col pack itself: every
// i3PhysixShapeSet points (header "PXA3" +16 / "PXA4" +20) at an i3MemoryBuffer of 24-byte _tagi3PhysixTerrainInfo
// entries (u16 type at +0, int thickness at +8; all entries of one shape agree in the 80 maps). The bullet wall test
// 0x60a950 reads both (src/weapons/penetration.ts). The pack is looked up by collision.json `source` in Clients/<client>/Pack
// and kept only when its shape list matches collision.json shapes[] (same order / NXS part split as export-collision.mjs).

import { assetPath, sourcePath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, readI3R2Header } from './i3pack/unpack.mjs';

// export-collision.mjs reads the Cross Pack (the only map client)
const PACK_DIRS = [sourcePath('PBCross/Pack')].filter(Boolean);
const argv = process.argv.slice(2);
const rootAt = argv.indexOf('--maps-root');
const MAPS_ROOT = rootAt >= 0 ? path.resolve(argv.splice(rootAt, 2)[1]) : assetPath('maps');
const only = argv[0];

/** shape base name (strip trailing _\d+ / trailing underscore) -> weaponfx.json surface suffix. */
export function surfaceForShapeName(name) {
  const n = (name || '').toUpperCase().replace(/^TH_/, '').replace(/[_\d]+$/, '');
  switch (n) {
    case 'CCR': return 'Cm'; // concrete/masonry -> cement (Hit_*_Cm, the exe's default column)
    case 'GLASS': return 'Gl';
    case 'MARB': return 'Mb';
    case 'MET': return 'Me';
    case 'PAP': return 'Pa';
    case 'PLASTIC': return 'Pl';
    case 'WOOD': return 'Wo';
    case 'WATER': return 'Water'; // Hmk_Sg_Water only; no Hit_*_Water -> impact() falls back to Cm for the blow FX
    case 'CLOTH': case 'RUB': case 'GND': case 'GRASS': case 'CLAY': case 'LEAF': return 'So';
    default: return 'Cm';
  }
}

/**
 * Shapes of a _Col pack in export-collision.mjs order ({ name, terrain: [type, thickness] | null } per NXS mesh part), or
 * null when the pack has no shape-set scene.
 */
export function packShapeTerrain(pack) {
  const { nodes } = parsePack(pack);
  const col = nodes.find((n) => {
    if (pack.toString('latin1', n.dataStart, n.dataStart + 4) !== 'I3R2') return false;
    const h = readI3R2Header(pack, n.dataStart);
    return !!h && h.strings.includes('i3PhysixShapeSet');
  });
  if (!col) return null;
  const d = pack.subarray(col.dataStart, col.dataEnd);
  const H = readI3R2Header(d, 0);
  const byId = new Map(H.objects.map((o) => [o.id, o]));
  const sortedOffs = H.objects.map((o) => o.off).sort((a, b) => a - b);
  const nextOffAfter = (off) => sortedOffs.find((o) => o > off) ?? d.length;
  const out = [];
  for (const o of H.objects) {
    if (H.strings[o.cls] !== 'i3PhysixShapeSet') continue;
    const nl = d[o.off];
    const name = d.toString('latin1', o.off + 1, o.off + 1 + nl);
    const h = o.off + 1 + nl;
    const sig = d.toString('latin1', h, h + 4);
    const buf = byId.get(sig === 'PXA4' ? d.readUInt32LE(h + 20) : sig === 'PXA3' ? d.readUInt32LE(h + 16) : -1);
    let terrain = null;
    if (buf && H.strings[buf.cls] === 'i3MemoryBuffer' && d.readUInt32LE(buf.off) >= 24) {
      terrain = [d.readUInt16LE(buf.off + 4), d.readInt32LE(buf.off + 12)];
    }
    // the NXS mesh / convex hull parts, counted like export-collision.mjs readNxsMeshes + readNxsHulls
    const end = o.size <= 32 ? nextOffAfter(o.off) : o.off + o.size;
    let parts = 0;
    for (const tag of ['NXS\x01MESH', 'NXS\x01CVXM']) for (let i = o.off; (i = d.indexOf(tag, i, 'latin1')) >= 0 && i < end; i += 8) parts++;
    for (let k = 0; k < parts; k++) out.push({ name: parts > 1 ? `${name}_${k}` : name, terrain });
  }
  return out;
}

/** terrain per collision.json shape from the first client pack whose shape list matches; null when none does */
function terrainFor(info) {
  const names = (info.shapes ?? []).map((s) => s.name);
  if (!info.source || !names.length) return null;
  for (const dir of PACK_DIRS) {
    const file = path.join(dir, info.source);
    if (!fs.existsSync(file)) continue;
    let list;
    try { list = packShapeTerrain(fs.readFileSync(file)); } catch { continue; }
    if (list && list.length === names.length && list.every((s, i) => s.name === names[i])) return list.map((s) => s.terrain);
  }
  return null;
}

function exportOne(mapDir) {
  const colJson = path.join(mapDir, 'collision.json');
  if (!fs.existsSync(colJson)) return null;
  const info = JSON.parse(fs.readFileSync(colJson, 'utf8'));
  const shapes = info.shapes ?? [];
  const byIndex = shapes.map((s) => surfaceForShapeName(s.name));
  const byName = {};
  for (const s of shapes) byName[s.name] = surfaceForShapeName(s.name);
  const out = { source: 'collision.json shapes[] (i3PhysixShapeSet names)', byIndex, byName };
  const terrain = terrainFor(info);
  if (terrain) out.terrain = terrain;
  fs.writeFileSync(path.join(mapDir, 'surfaces.json'), JSON.stringify(out, null, 1));
  return { map: path.basename(mapDir), shapes: shapes.length, codes: [...new Set(byIndex)].sort(), terrain: !!terrain };
}

const dirs = only
  ? [path.join(MAPS_ROOT, only.toLowerCase())]
  : fs.readdirSync(MAPS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(MAPS_ROOT, d.name));

let done = 0;
for (const dir of dirs) {
  const r = exportOne(dir);
  if (r) { done++; console.log(`${r.map}: ${r.shapes} shapes -> [${r.codes.join(', ')}]${r.terrain ? '' : ' (no terrain: pack not matched)'}`); }
}
console.log(`surfaces.json written for ${done}/${dirs.length} map(s)`);
