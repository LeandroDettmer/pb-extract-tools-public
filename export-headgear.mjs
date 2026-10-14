#!/usr/bin/env node
// PB 2017 head accessories (masks, berets, hats, helmets) -> glTF, one GLB per 2017 equipment x character family.
// Pure Node ESM; geometry/material code is tools/export-model.mjs (materialFactory / buildPrimitive / addSkeletonNodes).
//
//   node web-poc/tools/export-headgear.mjs            # sold head/face/beret items + default helmets -> public/assets/equip
//   node web-poc/tools/export-headgear.mjs --all      # every 3.123 ITEMID that maps to a 2017 entry (not only sold ones)
//   node web-poc/tools/export-headgear.mjs --list     # mapping only (no write)
//   node web-poc/tools/export-headgear.mjs --charas   # only re-apply the costume rule to index.json charas (no GLB export)
//
// Source (PBCross Pack, Equip_*.i3Pack; no fallback client):
//   extracted/pef-cross/br/Equipment.json  Equipment.{Mask,Beret,Event,Head}.<key> = { ResLocalPath, ResPostName,
//   DiffuseTexture?, EmblemTexture? }. The client loads  Pack/Equip_<ResLocalPath with / -> _>.i3Pack  and, per
//   character family, the scene  <Family>_Mask_<ResPostName>.I3S (masks) / <Family>_<ResPostName>.I3S (others); each
//   <Family>_*.I3CHR names its I3S (i3SceneGraphInfo). DiffuseTexture / EmblemTexture replace the scene's diffuse map
//   (country / team masks and berets share one mesh). Families: SWAT_Male, SWAT_Female, REBEL_Male (Red Bulls),
//   REBEL_Female (Tarantula), ViperRed, D-Fox, Leopard, Hide, Bella, Chou.
// Attachment (read from the I3S): every accessory scene has a single root bone "HelmetDummy" (origin of the mesh); it
//   snaps to the character's "HelmetPointDummy" (child of bone "Head", chars/index.json attach). Mesh "Model_Helmet"
//   (berets, Event hats) = the accessory IS the helmet: it replaces the default helmet; masks ("*Defense_Mask*",
//   full-head masks too) are worn under the helmet. Default helmet: HelmetDefault (Head _Type 1, ResPostName Helmet),
//   or the character's own Equip_Helmet_<Chara> variant (Hide_Black, Leopard_Bope, *_GRS, *_Madness, ...).
//   Costume characters get none (charas[id].helmet = null): their Character.PartsList.ResDftPartSkin (public/assets/cross/config/character.json) is a
//   full-body Skin (Equipment.Skin F_S_*, e.g. 1403019 NBgirl, 1403046 P1000) whose mesh carries its own head (afro +
//   bandana, hair, cap). [INFERIDO]: the 2017 Character.pef has no entry for these packs and the client has no
//   Equip_Helmet_<costume> pack; the family HelmetDefault on them pokes through the head (Gangster ViperRed's cap brim
//   out of the afro, Android Tarantula under the Tarantula beanie), and every 3.123 Skin says _Equipment.Headgear 0.
// Server itemId -> PBCross entry: the ids are the server's (system_shop item_name, see serverItemKeys: Facegear/Head/Beret
//   ITEMID + key "A_F_Jason_Latin_Bahamas", "A_H_BF_CowboyHat-CTF+CowboyHat-FR", "A_E_Beret_Black"). The PBCross pef has no
//   ITEMID; the id is only identity, the geometry comes from PBCross. Matched by normalised name to the Cross key / ResLocalPath
//   leaf (class 8 -> Mask, class 27 -> Beret, class 7 -> Mask/Event/Head). Items PBCross does not have match nothing (dropped).
//   [INFERIDO] name match: no id table links the two clients.
//
// Output: public/assets/equip/<key>/<Family>.glb (+ <key>/tex/*.png shared by the families) and equip/index.json
//   { charas: { <chars id>: { family, helmet } }, entries: { <key>: { cat, pef, replacesHelmet, files: {Family: path} } },
//     items: { <itemId>: { key, slot: head|face|beret, name3 } } }.
// GLB layout = weapons: AxisRotate (i3 -> three) > HelmetDummy (origin) > meshes; the runtime strips AxisRotate and
// parents HelmetDummy's content to HelmetPointDummy (src/game/charEquip.ts). Never deletes public/assets folders:
// files are overwritten in place.
import { assetPath, clientPath, dbInitPathOpt, extractedPath, oldServerPathOpt, rel, webPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanI3R2 } from './i3r2/i3r2.mjs';
import { IDENTITY, readBody, readSkeleton, collectBodyMeshes, plainIndices } from './i3r2/skin.mjs';
import { GLB, checkGLB, stem } from './i3r2/skin-glb.mjs';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';
import { packTextures, materialFactory, buildPrimitive, addSkeletonNodes } from './export-model.mjs';

const PACKS = clientPath('cross', 'Pack');
const ASSETS = assetPath();
const OUT = path.join(ASSETS, 'equip');
const MAX_TEX = 512;
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export const FAMILIES = ['SWAT_Male', 'SWAT_Female', 'REBEL_Male', 'REBEL_Female', 'ViperRed', 'D-Fox', 'Leopard', 'Hide', 'Bella', 'Chou'];

/** chars/index.json entry -> accessory family (+ the pack suffix of a variant, for its own helmet). [INFERIDO] by pack name */
export function familyOf(c) {
  const x = String(c.pack ?? c.name).replace(/^Chara_/, '').replace(/\.i3Pack$/i, '');
  const pick = [
    [/^SWAT_Male/i, 'SWAT_Male'], [/^SWAT_Female/i, 'SWAT_Female'], [/^REBEL_ViperRed|^REBEL_Female\(ViperRed/i, 'ViperRed'],
    [/^REBEL_Male/i, 'REBEL_Male'], [/^REBEL_Female|^REBEL_Soccer/i, 'REBEL_Female'], [/^D-Fox/i, 'D-Fox'], [/^Leopard/i, 'Leopard'],
    [/^Hide/i, 'Hide'], [/^Bella/i, 'Bella'], [/^Chou/i, 'Chou'],
  ].find(([re]) => re.test(x));
  return { family: pick?.[1] ?? null, variant: x };
}

/**
 * chars/index.json ids of costume characters (header: own head, no default helmet): one of the entry's item ids is a
 * pef-3.123 Character whose PartsList.ResDftPartSkin is set. `character3` = public/assets/config/character.json.
 */
export function costumeCharas(chars, character3) {
  const skin = new Map();
  for (const v of Object.values(character3?.Character ?? {})) if (v?.ITEMID) skin.set(v.ITEMID, v.PartsList?.ResDftPartSkin ?? 0);
  return new Set(chars.filter((c) => [c.itemId, ...(c.itemIds ?? [])].some((id) => id && skin.get(id))).map((c) => c.id));
}

// ---- pack index: I3S file name (lower) -> packs holding it ----------------------------------------------------------
let PACK_INDEX = null;
function packIndex() {
  if (PACK_INDEX) return PACK_INDEX;
  PACK_INDEX = new Map();
  for (const f of fs.readdirSync(PACKS).filter((n) => /^Equip_.*\.i3Pack$/i.test(n))) {
    let r; try { r = parsePack(fs.readFileSync(path.join(PACKS, f))); } catch { continue; }
    for (const n of r.nodes) for (const e of n.files) if (/\.i3s$/i.test(e.name)) {
      const k = e.name.toLowerCase();
      if (!PACK_INDEX.has(k)) PACK_INDEX.set(k, []);
      PACK_INDEX.get(k).push(f);
    }
  }
  return PACK_INDEX;
}

// ---- scenes of a pack: name (lower) -> { d, scene } --------------------------------------------------------------
const SCENES = new Map();
function packScenes(file) {
  if (SCENES.has(file)) return SCENES.get(file);
  const d = fs.readFileSync(path.join(PACKS, file));
  const out = new Map();
  const add = (name, buf, scene) => { if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { d: buf, scene }); };
  let r = null; try { r = parsePack(d); } catch { /* not a pack */ }
  for (const n of r?.nodes ?? []) for (const e of n.files) {
    if (!/\.i3s$/i.test(e.name) || e.offset == null || e.offset + e.size > d.length) continue;
    let buf = d.subarray(e.offset, e.offset + e.size);
    if (e.attr & 0x08000000) buf = decodeContent(Buffer.from(buf), e.attr);
    const scene = buf && scanI3R2(buf).find((b) => b.objects.some((o) => o.cls === 'i3Body'));
    if (scene) add(e.name, buf, scene);
  }
  // OLD leaf nodes (no offsets): every <X>.I3CHR blob names its I3S and the I3S blob follows it
  let pending = null;
  for (const b of scanI3R2(d)) {
    const cls = new Set(b.objects.map((o) => o.cls));
    if (cls.has('i3Chara')) { const s = b.strings?.find((x) => /\.i3s$/i.test(x)); pending = s ? s.split(/[\\/]/).pop() : null; continue; }
    if (cls.has('i3Body') && pending) { add(pending, d, b); pending = null; }
  }
  const tex = packTextures(d, rel(path.join(PACKS, file)));
  SCENES.set(file, { scenes: out, tex, file });
  return SCENES.get(file);
}

// textures: own pack, then Equip_Common, then any Equip pack (lazily, cached)
const TEX_ALL = { built: false, map: new Map() };
function texAnywhere(p) {
  if (!TEX_ALL.built) {
    TEX_ALL.built = true;
    for (const f of fs.readdirSync(PACKS).filter((n) => /^Equip_.*\.i3Pack$/i.test(n))) {
      const t = packScenes(f).tex;
      for (const s of t.stems) if (!TEX_ALL.map.has(s)) TEX_ALL.map.set(s, t.get(s));
    }
  }
  return TEX_ALL.map.get(stem(p)) ?? null;
}

function findScene(names, preferPack) {
  const ix = packIndex();
  for (const nm of names) {
    const packs = ix.get(nm.toLowerCase()) ?? [];
    const order = [...packs.filter((p) => p.toLowerCase() === preferPack.toLowerCase()), ...packs.filter((p) => p.toLowerCase() !== preferPack.toLowerCase())];
    for (const p of order) {
      const ps = packScenes(p);
      const s = ps.scenes.get(nm.toLowerCase());
      if (s) return { ...s, pack: p, tex: ps.tex, name: nm };
    }
  }
  return null;
}

// ---- export one scene -----------------------------------------------------------------------------------------------
function exportScene(hit, { key, family, overrides }) {
  const lod = readBody(hit.d, hit.scene, hit.scene.objects.find((o) => o.cls === 'i3Body')).lods[0];
  const sk = readSkeleton(hit.d, hit.scene, hit.scene.byId.get(lod.skeleton));
  const { meshes } = collectBodyMeshes(hit.d, hit.scene, lod.root);
  const P = { d: hit.d, scene: hit.scene, maxTex: MAX_TEX, source: rel(path.join(PACKS, hit.pack)),
    tex: { get: (p) => overrides.get(stem(p)) ?? hit.tex.get(p) ?? texAnywhere(p) } };
  const outDir = path.join(OUT, key);
  const G = new GLB('pb export-headgear.mjs');
  const J = G.json;
  const mats = materialFactory(G, P, path.join(outDir, 'tex'), 'tex');
  const { nodeOf } = addSkeletonNodes(G, sk.bones, J.scenes[0].nodes);
  let keyed = 0;
  const meshNames = [];
  for (const m of meshes) {
    let idx;
    try { idx = plainIndices(m); } catch { keyed++; continue; }
    const prim = buildPrimitive(G, m, idx, { matrix: m.local === IDENTITY ? null : m.local });
    prim.material = mats.get(m.state);
    delete prim.tris; delete prim.verts;
    const leaf = m.name.split('/').pop();
    meshNames.push(leaf);
    J.meshes.push({ name: leaf, primitives: [prim] });
    const bn = J.nodes[nodeOf[Math.max(0, m.bone)]];
    (bn.children ||= []).push(G.node({ name: leaf, mesh: J.meshes.length - 1 }));
  }
  if (!J.meshes.length) return { error: `no plain geometry (keyed ${keyed})` };
  J.scenes[0].name = `${key}/${family}`;
  J.extras = { source: `${P.source}:${hit.name}`, axes: 'AxisRotate (i3 -> three) > HelmetDummy = origin, snaps to the chara HelmetPointDummy', attach: 'HelmetPointDummy', root: sk.bones[0]?.name };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${family}.glb`);
  fs.writeFileSync(file, G.build());
  const check = checkGLB(file);
  if (!check.ok) return { error: `GLB check: ${check.errors.join('; ')}` };
  return { file: `${key}/${family}.glb`, source: P.source + ':' + hit.name, tris: check.tris, textures: check.images, missing: [...mats.missing], meshes: meshNames, root: sk.bones[0]?.name ?? null };
}

// ---- server itemId -> 2017 entry ------------------------------------------------------------------------------------
const n3 = (k) => k.replace(/^A_[FHE]_/, '').replace(/^[A-Z]{2}_/, '').split('+')[0].replace(/-(CTF|FR)$/, '').replace(/^Jason_/, '').replace(/^Beret_/, '');
const nn = (s) => String(s).toLowerCase().replace(/^mask_/, '').replace(/_mask$/, '').replace(/^beret/, '').replace(/mask$/, '').replace(/[^a-z0-9]/g, '');
const SLOT = { 7: 'head', 8: 'face', 27: 'beret' };
const CATS = { 7: ['Event', 'Head', 'Mask'], 8: ['Mask'], 27: ['Beret'] };

// Server item key per id: the system_shop rows of the server DB seed (--server: old/runtime/db-init/*.sql, or the pg_dump
// COPY block of db/init/001_init.sql in the public layout; item_name = the equipment key "A_F_Jason_Latin_Trinidad" where the seed kept it), then itemNames.json (the same table's snapshot,
// keys or display names). Keys first: a display name ("Skull Mask") can match another Cross entry than the key.
function serverItemKeys() {
  const pairs = [];
  const dir = oldServerPathOpt('runtime', 'db-init');
  if (dir && fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort())
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\((\d{6,7}), '(A_[FHE]_[^']+)'/g)) pairs.push([+m[1], m[2]]);
  const pub = dbInitPathOpt('001_init.sql');
  if (pub && fs.existsSync(pub)) for (const m of fs.readFileSync(pub, 'utf8').matchAll(/^(\d{6,7})\t(A_[FHE]_[^\t]+)\t/gm)) pairs.push([+m[1], m[2]]);
  for (const [id, [n]] of Object.entries(rj(webPath('src/lobby/state/data/itemNames.json')).names)) pairs.push([+id, n]);
  return pairs;
}

export function mapItems(e17) {
  const idx = {};
  for (const [cat, o] of Object.entries(e17)) {
    const m = (idx[cat] = new Map());
    for (const [k, v] of Object.entries(o)) for (const n of [k, (v.ResLocalPath || '').split('/').pop()]) { const x = nn(n); if (x && !m.has(x)) m.set(x, k); }
  }
  const items = {};
  for (const [id, k3] of serverItemKeys()) {
    const cls = Math.floor(id / 100000);
    if (!SLOT[cls] || items[id]) continue;
    const want = nn(n3(k3));
    for (const cat of CATS[cls]) {
      const k17 = idx[cat]?.get(want);
      if (k17) { items[id] = { cat, k17, slot: SLOT[cls], name3: k3 }; break; }
    }
  }
  return items;
}

function soldIds() {
  try {
    const out = execFileSync('docker', ['exec', 'pb-postgres-local', 'psql', '-U', 'postgres', '-d', 'pb', '-At', '-c',
      'select item_id from system_shop where item_visible and item_id/100000 in (7,8,27)'], { encoding: 'utf8' });
    const ids = new Set(out.split(/\r?\n/).filter(Boolean).map(Number));
    if (ids.size) return { ids, source: 'system_shop (item_visible)' };
  } catch { /* no DB */ }
  const names = rj(webPath('src/lobby/state/data/itemNames.json')).names;
  return { ids: new Set(Object.keys(names).map(Number).filter((i) => SLOT[Math.floor(i / 100000)])), source: 'itemNames.json (no DB)' };
}

const sceneNames = (cat, post, fam) => (cat === 'Mask' ? [`${fam}_Mask_${post}.I3S`, `${fam}_${post}.I3S`] : [`${fam}_${post}.I3S`, `${post}_${fam}_Beret.I3S`]);

function main() {
  const args = process.argv.slice(2);
  const chars = rj(path.join(ASSETS, 'chars/index.json')).chars;
  const costumes = costumeCharas(chars, rj(path.join(ASSETS, 'cross/config/character.json')));
  if (args.includes('--charas')) {
    const file = path.join(OUT, 'index.json'), index = rj(file);
    for (const id of costumes) if (index.charas[id]) index.charas[id].helmet = null;
    fs.writeFileSync(file, JSON.stringify(index, null, 1));
    console.log(`costume charas (no default helmet): ${[...costumes].join(', ')} -> ${rel(file)}`);
    return;
  }
  const e17 = rj(extractedPath('pef-cross', 'br', 'Equipment.json')).Equipment;
  const mapped = mapItems(e17);
  const sold = soldIds();
  const want = Object.entries(mapped).filter(([id]) => args.includes('--all') || sold.ids.has(Number(id)));
  if (args.includes('--list')) { for (const [id, m] of want) console.log(`${id}\t${m.slot}\t${m.name3}\t-> ${m.cat}:${m.k17}`); console.log(`${want.length} mapped (${sold.source})`); return; }

  const charas = {};
  const entries = {};
  const log = [];
  const doEntry = (key, cat, k17, famList, overrideNames = null) => {
    if (entries[key]) return entries[key];
    const v = e17[cat][k17];
    const post = v.ResPostName;
    const prefer = `Equip_${String(v.ResLocalPath).replace(/[\\/]/g, '_')}.i3Pack`;
    const e = (entries[key] = { cat, pef: k17, pack: prefer, replacesHelmet: cat !== 'Mask', files: {}, missing: {} });
    for (const fam of famList) {
      const hit = findScene(overrideNames?.(fam) ?? sceneNames(cat, post, fam), prefer);
      if (!hit) { e.missing[fam] = 'no I3S in a readable pack'; continue; }
      const overrides = new Map();
      const ov = (p) => (p ? texAnywhere(p) ?? hit.tex.get(p) : null);
      const diff = ov(v.DiffuseTexture), emb = ov(v.EmblemTexture);
      if (diff || emb) {
        // replace the diffuse map of the scene's materials: emblem meshes get EmblemTexture, the rest DiffuseTexture
        const lod = readBody(hit.d, hit.scene, hit.scene.objects.find((o) => o.cls === 'i3Body')).lods[0];
        for (const m of collectBodyMeshes(hit.d, hit.scene, lod.root).meshes) {
          const ao = m.state.i3TextureBindAttr;
          if (!ao) continue;
          const ref = hit.d.readUInt32LE(ao.off), t = hit.scene.byId.get(ref) || hit.scene.byId.get(ref & 0xffff);
          const p = t?.extPath;
          if (!p) continue;
          const repl = /emblem/i.test(m.name) ? emb : diff;
          if (repl && !overrides.has(stem(p))) overrides.set(stem(p), repl);
        }
      }
      const r = exportScene(hit, { key, family: fam, overrides });
      if (r.error) { e.missing[fam] = r.error; continue; }
      e.files[fam] = r.file;
      e.source ??= r.source;
      e.meshes ??= r.meshes;
      e.root ??= r.root;
      if (r.missing.length) e.missingTextures = [...new Set([...(e.missingTextures ?? []), ...r.missing])];
      if (r.meshes.some((n) => /^Model_Helmet$/i.test(n))) e.replacesHelmet = true;
    }
    log.push(`${key}: ${Object.keys(e.files).length}/${famList.length} families${Object.keys(e.missing).length ? ` (missing ${Object.keys(e.missing).join(',')})` : ''}`);
    return e;
  };

  // default helmets: the family helmet (HelmetDefault) + the variant's own helmet when the client has one
  doEntry('helmet_default', 'Head', 'HelmetDefault', FAMILIES);
  for (const c of chars) {
    const { family, variant } = familyOf(c);
    if (!family) continue;
    const suffix = variant.replace(/^(SWAT_Male|SWAT_Female|REBEL_Male|REBEL_Female|REBEL_ViperRed|REBEL|D-Fox|Leopard|Hide|Bella|Chou)_?/i, '').replace(/[()]/g, '').replace(/_+$/, '');
    let helmet = costumes.has(c.id) ? null : 'helmet_default';
    if (suffix && helmet) {
      const names = [`${variant.replace(/^REBEL_/, '')}_Helmet.I3S`, `${family}_${suffix}_Helmet.I3S`, `${family}_Helmet_${suffix}.I3S`];
      if (findScene(names, 'Equip_Helmet.i3Pack')) {
        const key = `helmet_${c.id}`;
        const e = doEntry(key, 'Head', 'HelmetDefault', [family], () => names);
        if (e.files[family]) helmet = key;
      }
    }
    charas[c.id] = { family, helmet };
  }
  const items = {};
  for (const [id, m] of want) {
    const key = m.k17.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const e = doEntry(key, m.cat, m.k17, FAMILIES);
    if (Object.keys(e.files).length) items[id] = { key, slot: m.slot, name3: m.name3 };
  }
  const index = {
    generated: new Date().toISOString(), tool: 'web-poc/tools/export-headgear.mjs', sold: sold.source,
    note: 'Head accessories of the PB 2017 client per character family. entries[key].files[family] = GLB (AxisRotate > HelmetDummy > meshes), attached at the chara HelmetPointDummy. replacesHelmet = beret / hat / helmet (drawn instead of the default helmet); masks are worn under it. charas[id].helmet = the default helmet entry, null = costume with its own head (none). items = server itemId -> entry ([INFERIDO] 3.123 key <-> 2017 name match).',
    attach: 'HelmetPointDummy', charas, entries, items,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  for (const l of log) console.log(l);
  const nf = Object.values(entries).reduce((a, e) => a + Object.keys(e.files).length, 0);
  console.log(`${Object.keys(items).length}/${want.length} items exported (${sold.source}), ${Object.keys(entries).length} entries, ${nf} GLBs -> ${rel(OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
