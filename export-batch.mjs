#!/usr/bin/env node
// Batch export of every playable character and every plain weapon model (+ texture skins) of the PBCross client
// to the web client, reusing export-model.mjs / export-anim.mjs. Pure Node ESM, builtins only.
//
//   node web-poc/tools/export-batch.mjs [chars] [weapons] [--skins] [--only <regex>] [--max-tex 1024] [--embed-clips] [--dry]
//   node web-poc/tools/export-model.mjs --check        # re-validate every GLB of both index files
//
// Source: PBCross 'Clients/PBCross/Pack' only (sourceVersion 'Cross'). No fallback to the 2017, 3.123, RU or portable
// packs: a character or weapon PBCross does not ship is not exported (it is listed in the report as skipped or absent).
// A texture missing from the pack is looked up in the other Cross packs, then in the base model pack (_ResName) and
// shorter name prefixes (Weapon_AUG_A3_Carnaval -> Weapon_AUG_A3).
//
// Characters -> public/assets/chars/<id>/model.glb (+ arms_1pv.glb, tex/), chars/index.json
//   itemId / hp: server/runtime/Data/Match/CharaHealth.xml (--server; same file export-cross.mjs reads) (601xxx = red team, 602xxx = blue team),
//   charaResId: server/Server.Match/Data/Enums/CharaResId.cs. Cross ships the animation sets Chara/SWAT_Male and
//   Chara/SWAT_Female; every character shares the bone names of one of the two skeletons
//   ("family", picked by the bind pose), so the clips are embedded once, in swat_male / swat_female, and the
//   other entries carry clipsFrom: '<id>' (three.js: play that GLB's AnimationClips on this model's mixer).
//   --embed-clips embeds the family clips into every character instead (~1.5 MB each).
// Weapons -> public/assets/weapons/models/<id>.glb (+ tex/<id>/), weapons/models/index.json
//   itemId: extracted/pef-cross/br/Weapon.json (PBCross Weapon.pef): (_UsageType + 1) S, _ClassType CC, _Number NNN
//   (same layout as ItemStatistics.xml ids; inServer = present in ItemStatistics.xml); family = LinkedToCharaAI
//   (the character animation set the weapon uses, slugged: ak47_elite, aug_a3, m4a1 ...), used to inherit 1PV/3PV
//   animations. Items whose _ResName_I3S is a texture-only pack are skins: listed in items[] of the base model and,
//   with --skins, exported as <skin id>.glb = base geometry + the skin maps (texture_change_Weapon.json mapping).

import { assetPath, clientPath, extractedPath, rel, oldServerPathOpt, serverPathOpt } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanI3R2 } from './i3r2/i3r2.mjs';
import { readBody, readSkeleton, collectBodyMeshes, plainIndices } from './i3r2/skin.mjs';
import { readI3IB, normPath, stem } from './i3r2/skin-glb.mjs';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { exportChara, exportWeapon, packTextures } from './export-model.mjs';

const OUT = process.env.PB_OUT_ROOT || assetPath(); // PB_OUT_ROOT: tools/export-model-dds.mjs
// the one client this export reads (no fallback chain): a missing PBCross folder stops the run in main
const CROSS = { key: 'cross', version: 'Cross', root: clientPath('cross') };
const CLIENTS = [{ ...CROSS, pack: path.join(CROSS.root, 'Pack'), chara: path.join(CROSS.root, 'Chara') }];
// server/ only keeps runtime data; the C# sources + binary/Debug live in old/ (the .NET server no longer runs)
// Server data (itemId, hp: <server>/server/runtime; charaResId: <server>/old) is optional: read when --server is given, else left empty.
const SERVER = oldServerPathOpt() ?? '(none)';
const readOpt = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const PEF = extractedPath('pef-cross', 'br');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const sharedPrefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- pack inspection ----------------------------------------------------------------------
// { ok, reason, lods, keyed, plain } for the i3Body scene of a pack; ok = every index array it uses is plain.
function inspect(file, { lodSel = 'all' } = {}) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'absent' };
  let d;
  try { d = fs.readFileSync(file); } catch (e) { return { ok: false, reason: e.code }; }
  const sc = scanI3R2(d).find((b) => b.objects.some((o) => o.cls === 'i3Body'));
  if (!sc) return { ok: false, reason: 'no i3Body (stub / texture-only pack)' };
  try {
    const body = readBody(d, sc, sc.objects.find((o) => o.cls === 'i3Body'));
    const lods = lodSel === 'first' ? body.lods.slice(0, 1) : body.lods;
    let keyed = 0, plain = 0;
    const skel = [];
    for (const l of lods) {
      for (const m of collectBodyMeshes(d, sc, l.root).meshes) {
        if (/_Master$/.test(m.name)) continue;
        try { plainIndices(m); plain++; } catch { keyed++; }
      }
      skel.push(readSkeleton(d, sc, sc.byId.get(l.skeleton)).bones);
    }
    if (!plain) return { ok: false, reason: keyed ? `keyed (${keyed} index arrays)` : 'no geometry' };
    return { ok: keyed === 0, reason: keyed ? `partially keyed (${keyed}/${keyed + plain})` : 'plain', keyed, plain, version: sc.version, skel };
  } catch (e) { return { ok: false, reason: 'parse: ' + e.message.slice(0, 90) }; }
}

// First client where the pack is plain: { client, info, tried: {BR: reason, ...} }.
function pickClient(fileName, opts) {
  const tried = {};
  for (const c of CLIENTS) {
    const info = inspect(path.join(c.pack, fileName), opts);
    tried[c.key] = info.reason;
    if (info.ok) return { client: c, info, tried };
  }
  return { client: null, tried };
}

// ---- server tables ------------------------------------------------------------------------
function charaTables() {
  const health = new Map();
  const xml = readOpt(serverPathOpt('runtime', 'Data', 'Match', 'CharaHealth.xml') ?? '');
  for (const m of xml.matchAll(/<Chara Id="(\d+)" HP="(\d+)"\/>\s*;([^\s<]+)/g)) health.set(norm(m[3]), { itemId: +m[1], hp: +m[2], itemName: m[3] });
  const res = new Map();
  const cs = readOpt(path.join(SERVER, 'Server.Match/Data/Enums/CharaResId.cs'));
  for (const m of cs.matchAll(/^\s*(\w+)\s*=\s*(\d+)/gm)) res.set(norm(m[1].replace(/Famele/, 'Female').replace(/NBGril/, 'NBgirl')), { charaResId: +m[2], resName: m[1] });
  return { health, res };
}
// pack name -> CharaHealth item names (first = primary). Unlisted packs are matched by their own name.
const CHARA_ITEMS = {
  SWAT_Male: ['AcidPol', 'SWAT_Male', 'Reinforced_SWAT_Male'], SWAT_Female: ['KeenEyes', 'SWAT_Female', 'Reinforced_SWAT_Female'],
  REBEL_Male: ['RedBulls', 'Reinforced_REBEL_Male'], REBEL_Female: ['Tarantula', 'Reinforced_REBEL_Female'],
  REBEL_ViperRed: ['ViperRed', 'REBEL_ViperRed', 'Reinforced_ViperRed', 'Reinforced_Combo_ViperRed'],
  'D-Fox': ['D-Fox', 'Normal_D-Fox', 'Reinforced_D-Fox', 'Reinforced_Combo_D-Fox'], Leopard: ['Leopard', 'Normal_Leopard', 'Reinforced_Leopard', 'Reinforced_Combo_Leopard'],
  Hide: ['Hide', 'Normal_Hide', 'Reinforced_Hide', 'Reinforced_Combo_Hide'], Chou: ['Chou', 'Reinforced_Chou'], Bella: ['Reinforced_Bella'],
  Hide_Madness: ['Hide_Madness', 'Hide_Madness_Sales'], Leopard_Madness: ['Leopard_Madness', 'Leopard_Madness_Sales'],
  SWAT_Female_Madness: ['SWAT_Female_Madness', 'SWAT_Female_Madness_Sales'], SWAT_Male_Madness: ['SWAT_Male_Madness', 'SWAT_Male_Madness_Sales'],
  Hide_Gign: ['Hide_GIGN'], Hide_NBgirl: ['Hide_NBGirl'], 'REBEL_ViperRed_Kopassus_': ['REBEL_Viper_Kopassus'], 'REBEL_ViperRed_Shadow_': ['REBEL_ViperShadow'],
  'REBEL_Female(Tarantula_P1000)': ['Tarantula_P1000'], 'REBEL_Female(Tarantula_Somalian-Pirate)': ['Tarantula_Pirate'],
  'REBEL_Female(ViperRed_General)': ['ViperRed_General'], 'REBEL_Female(ViperRed_Matilda)': ['ViperRed_Matilda'], 'REBEL_Female(ViperRed_NBgirl)': ['ViperRed_NBGirl'],
  SWAT_Female_P1000: ['KeenEyes_P1000'], 'SWAT_Female_SWAT-Sniper': ['KeenEyes_SWAT-Sniper'],
  'REBEL_Male(Red Bulls_Ninja)': ['RedBulls_Ninja'],
};
const CHARA_RES = { 'D-Fox': 'DFox', 'REBEL_Female(Tarantula_P1000)': 'REBEL_Female_P1000', 'REBEL_Female(Tarantula_Somalian-Pirate)': 'Tarantula_SomalianPirate',
  'REBEL_Female(ViperRed_General)': 'REBEL_ViperRed_General', 'REBEL_Female(ViperRed_Matilda)': 'REBEL_ViperRed_Matilda', 'REBEL_Female(ViperRed_NBgirl)': 'REBEL_ViperRed_NBgirl',
  'REBEL_ViperRed_Kopassus_': 'REBEL_Viper_Kopassus', 'REBEL_ViperRed_Shadow_': 'REBEL_ViperShadow', 'SWAT_Female_SWAT-Sniper': 'SWAT_Female_SWATSniper', Hide_Gign: 'Hide_GIGN',
  'REBEL_Male(Red Bulls_Ninja)': 'Redbulls_Ninja' };

// ---- characters ---------------------------------------------------------------------------
const NOT_PLAYABLE = /^Chara(_Clan.*|_Equip|_NPC|_Dino.*)?$/;
// animation families: the model that embeds the clips + the 3.123 anim folder
const FAMILIES = {
  male: { id: 'swat_male', name: 'SWAT_Male', animDir: clientPath('cross', 'Chara', 'SWAT_Male') },
  female: { id: 'swat_female', name: 'SWAT_Female', animDir: clientPath('cross', 'Chara', 'SWAT_Female') },
};

function familyOf(bones, refs) {
  let best = null;
  for (const [k, ref] of Object.entries(refs)) {
    const byName = new Map(ref.map((b) => [b.name, b]));
    let d = 0, miss = 0;
    for (const b of bones) {
      const r = byName.get(b.name);
      if (!r) { miss++; continue; }
      d = Math.max(d, Math.hypot(b.local[12] - r.local[12], b.local[13] - r.local[13], b.local[14] - r.local[14]));
    }
    const shared = bones.length - miss;
    if (shared < ref.length * 0.9) continue; // different skeleton
    if (!best || d < best.d) best = { family: k, d: +d.toFixed(4), extraBones: bones.filter((b) => !byName.has(b.name)).map((b) => b.name) };
  }
  return best;
}

function exportChars({ only, maxTex, embedClips, dry, log }) {
  const names = new Set();
  for (const c of CLIENTS) for (const f of fs.existsSync(c.pack) ? fs.readdirSync(c.pack) : []) {
    const m = f.match(/^(Chara_.+)\.i3Pack$/i);
    if (m && !NOT_PLAYABLE.test(m[1])) names.add(m[1].slice(6));
  }
  const { health, res } = charaTables();
  const picks = [...names].sort().map((name) => ({ name, ...pickClient(`Chara_${name}.i3Pack`) }));
  // reference skeletons = 3PV body LOD (index 1) of the family models
  const refSkel = {};
  for (const [k, f] of Object.entries(FAMILIES)) {
    const p = picks.find((x) => x.name === f.name);
    if (!p?.client) throw new Error(`family model ${f.name} has no plain source`);
    refSkel[k] = p.info.skel[1] || p.info.skel[0];
  }
  const entries = [], skipped = [];
  for (const p of picks) {
    if (only && !only.test(p.name)) continue;
    if (!p.client) { skipped.push({ name: p.name, why: p.tried }); log(`chara ${p.name}: SKIP ${JSON.stringify(p.tried)}`); continue; }
    const fam = familyOf(p.info.skel[1] || p.info.skel[0], refSkel);
    const famDef = fam && FAMILIES[fam.family];
    const id = slug(p.name);
    const items = (CHARA_ITEMS[p.name] || [p.name]).map((n) => health.get(norm(n))).filter(Boolean);
    const r = res.get(norm(CHARA_RES[p.name] || p.name));
    const itemId = items[0]?.itemId ?? null;
    const team = itemId ? (String(itemId).startsWith('601') ? 'red' : 'blue') : /^REBEL|Bella/i.test(p.name) ? 'red' : 'blue';
    const isBase = famDef?.id === id;
    const extra = {
      id, pack: `Chara_${p.name}.i3Pack`, client: p.client.key, sourceVersion: p.client.version, itemId, itemName: items[0]?.itemName ?? null, hp: items[0]?.hp ?? null,
      itemIds: items.map((i) => i.itemId), charaResId: r?.charaResId ?? null, family: fam?.family ?? null,
      clipsFrom: famDef && !isBase && !embedClips ? famDef.id : null, extraBones: fam?.extraBones?.length ? fam.extraBones : undefined,
      sourceStatus: p.tried,
    };
    if (!itemId) extra.note = 'no CharaHealth.xml item for this pack';
    if (dry) { log(`chara ${p.name} <- ${p.client.key} id=${id} team=${team} item=${itemId} res=${extra.charaResId} family=${fam?.family}`); entries.push({ name: id, ...extra, team }); continue; }
    // same pack in the other clients, the shared equipment / clan maps, then every other character pack (skins reuse maps)
    const others = [...CLIENTS.filter((c) => c !== p.client).map((c) => path.join(c.pack, `Chara_${p.name}.i3Pack`)),
      ...['Chara_Equip', 'Chara_Clan', 'Chara_ClanMarkContents'].flatMap((n) => CLIENTS.map((c) => path.join(c.pack, n + '.i3Pack'))),
      ...[...names].filter((n) => n !== p.name).sort((a, b) => sharedPrefix(b, p.name) - sharedPrefix(a, p.name)).flatMap((n) => [...CLIENTS].reverse().map((c) => path.join(c.pack, `Chara_${n}.i3Pack`)))];
    try {
      const e = exportChara({ name: p.name, team, id, packDir: p.client.pack, animDir: famDef && (isBase || embedClips) ? famDef.animDir : null, texFallback: others, extra }, { log, maxTex });
      entries.push(e);
    } catch (err) { skipped.push({ name: p.name, why: err.message }); log(`chara ${p.name}: FAILED ${err.stack}`); }
  }
  return { entries, skipped };
}

// ---- weapons ------------------------------------------------------------------------------
const KIND = { 1: 'knife', 2: 'pistol', 3: 'rifle', 4: 'smg', 5: 'sniper', 6: 'shotgun', 7: 'grenade', 8: 'grenade', 9: 'mission', 10: 'mg', 11: 'grenade_shell',
  12: 'bomb', 13: 'pistol', 14: 'dual_pistol', 15: 'dual_knife', 16: 'launcher', 17: 'object', 18: 'dual_smg', 19: 'dino', 23: 'knuckle', 26: 'bow', 27: 'grenade', 28: 'grenade', 34: 'shield', 35: 'dual_shotgun' };
// ids kept from the first hand-picked export (web-poc/src may reference them)
const LEGACY_IDS = { 'Weapon_AK-47_PBIC2013': 'ak47_pbic2013', Weapon_SPAS_15_PBSC2013_NonLogo: 'spas15_pbsc2013', 'Weapon_AK-47_SOPMOD_R': 'ak47_sopmod_r', Weapon_870MCS_SL: '870mcs_sl' };

function weaponTables() {
  const W = JSON.parse(fs.readFileSync(path.join(PEF, 'Weapon.json'), 'utf8'));
  const list = [];
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return;
    if (o._ResName !== undefined) { list.push({ key: p.split('/').pop(), group: p, ...o }); return; }
    for (const k of Object.keys(o)) walk(o[k], p + '/' + k);
  };
  walk(W.WeaponList, '');
  const stats = new Map();
  const xml = readOpt(serverPathOpt('runtime', 'Data', 'Match', 'ItemStatistics.xml') ?? '');
  for (const m of xml.matchAll(/<Statistic Id="(\d+)"\s+Name="([^"]*)"/g)) stats.set(+m[1], m[2]);
  const items = list.filter((w) => w._ResName && w._ClassType !== undefined && w._Number !== undefined).map((w) => {
    const S = (w._UsageType ?? 0) + 1, C = w._ClassType, N = w._Number;
    const itemId = C < 100 ? S * 100000 + C * 1000 + N : S * 1000000 + C * 1000 + N;
    return { itemId, key: w.key, res: w._ResName, skin: w._ResName_I3S || w._ResName_i3S || null, classType: C, family: w.LinkedToCharaAI || null, inServer: stats.has(itemId), serverName: stats.get(itemId) || null };
  });
  let tc = {};
  try { tc = JSON.parse(fs.readFileSync(path.join(PEF, 'texture_change_Weapon.json'), 'utf8'))['i3s reference']?.Weapon || {}; } catch { /* no skins */ }
  // Champion Claymore (3.123 ITEMID 407113 + its texture-only skin pack) is not in PBCross: no entry, nothing to export.
  return { items, stats, tc };
}

// stem -> [pack files] over every Weapon_* pack of the three clients (attachment maps such as dotsight / silencer /
// psg-1 live in other packs). Cached in the OS temp dir, keyed by the pack count.
function weaponTextureIndex(log) {
  const files = CLIENTS.flatMap((c) => (fs.existsSync(c.pack) ? fs.readdirSync(c.pack) : []).filter((f) => /^Weapon_.*.i3Pack$/i.test(f)).map((f) => path.join(c.pack, f)));
  // the index stores absolute pack paths: key the cache on the repo root too (after the repo moved, a stale cache pointed at the old root)
  const cache = path.join(os.tmpdir(), `pb-weapon-tex-index-${files.length}-${createHash('md5').update(OUT).digest('hex').slice(0, 8)}.json`);
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(cache, 'utf8')))); } catch { /* build */ }
  log(`indexing textures of ${files.length} weapon packs ...`);
  const idx = {};
  for (const f of files) {
    let lib; try { lib = packTextures(fs.readFileSync(f), f); } catch { continue; }
    for (const st of lib.stems) (idx[st] ||= []).push(f);
  }
  fs.writeFileSync(cache, JSON.stringify(idx));
  return new Map(Object.entries(idx));
}

// Texture-only skin pack -> Map(stem -> I3IB entry): each map from the first client (CLIENTS order, 2017 first) that
// carries it, so a 2017 map always wins over the 3.123 one. `client` = the client that gave most maps, `from` = per map.
function skinTextures(skin, wanted) {
  const map = new Map(), from = {};
  for (const c of CLIENTS) {
    const f = path.join(c.pack, `Weapon_${skin}.i3Pack`);
    if (!fs.existsSync(f)) continue;
    const lib = packTextures(fs.readFileSync(f), `${c.key}:Weapon_${skin}`);
    for (const st of wanted) {
      const t = !map.has(st) && lib.get(st + '.i3i');
      if (t) { map.set(st, t); from[st] = c.key; }
    }
  }
  if (!map.size) return null;
  const n = (k) => Object.values(from).filter((v) => v === k).length;
  return { map, client: CLIENTS.map((c) => c.key).sort((a, b) => n(b) - n(a))[0], from };
}

function exportWeapons({ only, maxTex, skins, dry, log }) {
  const names = new Set();
  for (const c of CLIENTS) for (const f of fs.existsSync(c.pack) ? fs.readdirSync(c.pack) : []) {
    const m = f.match(/^Weapon_(.+)\.i3Pack$/i);
    if (m) names.add(m[1]);
  }
  const byNorm = new Map([...names].map((n) => [norm(n), n]));
  const { items, tc, stats } = weaponTables();
  // texture-change skins with no pack of their own: Medical_Kit_PBNC6 (_ResName MedicalKit_PBNC6, no _ResName_I3S) exists only
  // as a skin key under Medical_Kit/Medical_Kit.I3S in texture_change_Weapon.pef, so its model is that base .I3S
  for (const it of items) {
    if (it.skin || byNorm.has(norm(it.res))) continue;
    const base = Object.keys(tc).find((k) => Object.keys(tc[k]).some((x) => norm(x) === norm(it.res)));
    if (base) { it.skin = it.res; it.res = base.split('/')[0]; it.packless = true; }
  }
  // packs unknown to the 2017 Weapon.pef (newer weapons): match the ItemStatistics.xml display name
  const statsByName = new Map();
  for (const [id, nm] of stats) (statsByName.get(norm(nm)) || statsByName.set(norm(nm), []).get(norm(nm))).push(id);
  const DUAL = new Set([14, 15, 18, 35]);
  const famClass = new Map();
  for (const it of items) for (const f of [it.family, it.res]) if (f && !famClass.has(slug(f))) famClass.set(slug(f), it.classType);
  const classOfId = (id) => (id >= 1000000 ? Math.floor(id / 1000) % 1000 : Math.floor(id / 1000) % 100);
  const resOf = new Map();
  for (const it of items) for (const r of [it.res, it.skin]) if (r) (resOf.get(norm(r)) || resOf.set(norm(r), []).get(norm(r))).push(it);
  const familyNames = [...new Set(items.map((i) => i.res))].sort((a, b) => b.length - a.length);
  // which packs have a plain body (probe lazily: only names in --only / all)
  const bodyCache = new Map();
  const body = (name) => {
    // an exact pack name wins over the normalised lookup: AUG-A3 / AUG_A3 (24 such pairs) share one key, and the lookup alone
    // always inspected the same file (the 313-byte AUG_A3 stub), never the real Weapon_AUG-A3 body
    const n = names.has(name) ? name : byNorm.get(norm(name));
    if (!n) return null;
    if (!bodyCache.has(n)) bodyCache.set(n, { name: n, ...pickClient(`Weapon_${n}.i3Pack`, { lodSel: 'first' }) });
    return bodyCache.get(n);
  };
  const fallbackFiles = (name, res, exclude) => {
    const cands = [name];
    if (res && res !== name) cands.push(res);
    const parts = name.split(/[_]/);
    for (let k = parts.length - 1; k >= 1; k--) cands.push(parts.slice(0, k).join('_'));
    const out = [];
    for (const n of cands) for (const c of CLIENTS) { const f = path.join(c.pack, `Weapon_${names.has(n) ? n : byNorm.get(norm(n)) || n}.i3Pack`); if (f !== exclude && fs.existsSync(f) && !out.includes(f)) out.push(f); }
    return out;
  };
  let texIndex = null;
  const skinJobs = [];
  // Packs whose item name does not match ItemStatistics.xml by name (checked by hand).
  const PACK_ITEM_OVERRIDES = { "Weapon_M-7Knife": 301001 /* ItemStatistics 301001 Name="M-7" */, "Weapon_L115A1_Gold": 105015 /* Name="L115A1 G" */ };
  const entries = [], skipped = [], skinStats = { listed: 0, exported: 0, noTextures: [], shadowed: [] };
  const targets = [...names].filter((n) => !only || only.test(n) || only.test('Weapon_' + n)).sort();
  for (const n of targets) {
    const b = body(n);
    if (!b.client) { if (!/no i3Body/.test(b.tried.cross || '') || Object.values(b.tried).some((r) => /keyed|parse/.test(r))) skipped.push({ pack: `Weapon_${n}`, why: b.tried }); continue; }
    // items whose model is this pack: own res name, or a skin name that is this (bodied) pack
    const own = (resOf.get(norm(n)) || []).filter((it) => (it.skin && norm(it.skin) === norm(n)) || (!it.skin || it.skin === it.res || !body(it.skin)?.client) && norm(it.res) === norm(n));
    const main = own.find((it) => norm(it.key) === norm(n) && (!it.skin || norm(it.skin) === norm(n))) || own.find((it) => !it.skin || norm(it.skin) === norm(n)) || own[0];
    const statIds = !main ? (PACK_ITEM_OVERRIDES[`Weapon_${n}`] ? [PACK_ITEM_OVERRIDES[`Weapon_${n}`]] : statsByName.get(norm(n)) || []) : [];
    const statId = statIds.find((i) => DUAL.has(classOfId(i)) === /dual/i.test(n)) ?? statIds[0] ?? null;
    const famRaw = main?.family || familyNames.find((f) => norm(n).startsWith(norm(f))) || n.split('_')[0];
    const pack = `Weapon_${n}`, id = LEGACY_IDS[pack] || slug(n);
    const skinItems = own.filter((it) => it.skin && norm(it.skin) !== norm(n) && norm(it.res) === norm(n));
    const extra = {
      client: b.client.key, sourceVersion: b.client.version, itemId: main?.itemId ?? statId, itemSource: main ? 'Weapon.pef' : statId ? 'ItemStatistics.xml name' : null, itemIds: [...new Set([...own.filter((it) => !skinItems.includes(it)).map((it) => it.itemId), ...statIds])],
      inServer: own.some((it) => it.inServer) || !!statId, classType: main?.classType ?? (statId ? classOfId(statId) : null), family: slug(famRaw), animSet: main?.family ?? null,
      items: own.map((it) => ({ itemId: it.itemId, key: it.key, skin: skinItems.includes(it) ? it.skin : null, inServer: it.inServer })), sourceStatus: b.tried,
    };
    if (extra.classType == null && famClass.has(extra.family)) { extra.classType = famClass.get(extra.family); extra.classFrom = 'family'; }
    const kind = KIND[extra.classType] || 'unknown';
    skinStats.listed += skinItems.length;
    if (dry) { log(`weapon ${pack} <- ${b.client.key} id=${id} kind=${kind} item=${extra.itemId} family=${extra.family} skins=${skinItems.length}`); entries.push({ id, kind, ...extra }); continue; }
    // two packs can slug to the same id (AUG-A3_Blue / AUG_A3_Blue): keep the one with an item, then the preferred client
    // ... then the pack whose exact name is the item's _ResName / _ResName_I3S (AUG-A3_Blue vs AUG_A3_Blue), then the preferred client
    const rank = (extra.itemId ? 0 : 10) + (own.some((it) => it.res === n || it.skin === n) ? 0 : 5) + CLIENTS.indexOf(b.client);
    const prev = entries.findIndex((e) => e.id === id);
    if (prev >= 0 && entries[prev].rank <= rank) { (entries[prev].aliases ||= []).push(pack); continue; }
    let texFallback = fallbackFiles(n, main?.res, path.join(b.client.pack, `${pack}.i3Pack`));
    let e;
    try {
      e = exportWeapon({ pack, id, kind, packDir: b.client.pack, texFallback, extra }, { log, maxTex });
      if (e.missingTextures.length) { // second pass: any weapon pack that carries the missing maps
        const tidx = (texIndex ||= weaponTextureIndex(log));
        const more = [...new Set(e.missingTextures.flatMap((st) => tidx.get(st) || []))].filter((f) => !texFallback.includes(f))
          .sort((x, y) => CLIENTS.findIndex((c) => x.startsWith(c.pack)) - CLIENTS.findIndex((c) => y.startsWith(c.pack)));
        if (more.length) { texFallback = [...texFallback, ...more]; e = exportWeapon({ pack, id, kind, packDir: b.client.pack, texFallback, extra }, { log, maxTex }); }
      }
    } catch (err) { skipped.push({ pack, why: err.message }); log(`weapon ${pack}: FAILED ${err.message}`); continue; }
    Object.defineProperty(e, 'rank', { value: rank, enumerable: false });
    if (prev >= 0) { e.aliases = [...(entries[prev].aliases || []), entries[prev].pack]; entries.splice(prev, 1); }
    entries.push(e);
    if (skins) skinJobs.push({ n, pack, id, kind, b, texFallback, extra, skinItems });
  }
  // texture skins (after every model, so a model id always wins over a skin id): base geometry + the maps named by
  // texture_change_Weapon.json
  for (const { n, pack, id, kind, b, texFallback, extra, skinItems } of skinJobs) {
    if (!entries.some((x) => x.id === id && x.pack === pack)) continue; // base lost an id clash
    const tcKey = Object.keys(tc).find((k) => norm(k.split('/')[0]) === norm(n));
    for (const s of [...new Map(skinItems.map((it) => [norm(it.skin), it])).values()]) {
      // mapping lives under the base .I3S (named after the res, or another base such as Cheytac_M200 for Cheytac)
      const skinOf = (k) => tc[k] && Object.keys(tc[k]).find((x) => norm(x) === norm(s.skin));
      const baseKey = skinOf(tcKey) ? tcKey : Object.keys(tc).find(skinOf);
      const lod0 = baseKey && tc[baseKey][skinOf(baseKey)]?.['LOD 0'];
      const wanted = lod0 ? Object.values(lod0).filter((v) => v && v !== '(null)').map((v) => stem(v)) : [];
      // a packless skin (s.packless): no client ships its maps (no MedicalKit_PBNC6_*.i3i in any Cross pack), so it is the base
      // model with the base maps [INFERIDO: the engine keeps the base texture when the changed .i3i is missing]
      const lib = lod0 && (skinTextures(s.skin, wanted) || (s.packless ? { map: new Map(), client: b.client.key, from: {} } : null));
      if (!lib) { skinStats.noTextures.push(s.skin); continue; }
      const swap = new Map(Object.entries(lod0).filter(([, v]) => v && v !== '(null)').map(([k, v]) => [stem(k), lib.map.get(stem(v))]).filter(([, t]) => t));
      if (![...swap.keys()].length && !s.packless) { skinStats.noTextures.push(s.skin); continue; }
      const sid = slug(s.skin);
      // a bodied pack slugs to the same id (AUG-A3_Blue skin vs Weapon_AUG_A3_Blue model): the real model wins
      if (entries.some((x) => x.id === sid)) { skinStats.shadowed.push(s.skin); continue; }
      const sItems = skinItems.filter((it) => norm(it.skin) === norm(s.skin));
      try {
        const e = exportWeapon({ pack, id: sid, kind, packDir: b.client.pack, texFallback, texOverride: (p) => swap.get(stem(normPath(p))) || null,
          extra: { ...extra, itemId: sItems[0].itemId, itemIds: sItems.map((it) => it.itemId), inServer: sItems.some((it) => it.inServer), items: undefined,
            skinOf: id, skin: s.skin, skinClient: lib.client, skinVersion: CLIENTS.find((c) => c.key === lib.client)?.version, skinMapsFrom: new Set(Object.values(lib.from)).size > 1 ? lib.from : undefined, skinMaps: [...swap.keys()], skinMapsMissing: s.packless ? wanted : undefined } }, { log: () => {}, maxTex });
        entries.push(e); skinStats.exported++;
      } catch (err) { skinStats.noTextures.push(`${s.skin} (${err.message})`); }
    }
  }
  return { entries, skipped, skinStats };
}

// ---- index + report -----------------------------------------------------------------------
function writeIndex(file, key, entries, replaceAll) {
  let prev = { [key]: [] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new index */ }
  const byId = new Map(replaceAll ? [] : (prev[key] || []).map((e) => [e.id || e.name, e]));
  for (const e of entries) byId.set(e.id || e.name, e);
  const dir = path.dirname(file);
  const list = [...byId.values()].filter((e) => fs.existsSync(path.join(dir, e.file || e.model))).sort((a, b) => (a.id || a.name).localeCompare(b.id || b.name));
  fs.writeFileSync(file, JSON.stringify({ generated: new Date().toISOString(), tool: 'web-poc/tools/export-batch.mjs', [key]: list }, null, 1));
  return list;
}
const dirBytes = (p) => !fs.existsSync(p) ? 0 : fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((s, f) => s + dirBytes(path.join(p, f)), 0) : fs.statSync(p).size;
const mb = (b) => +(b / 1048576).toFixed(1);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const only = opt('--only') ? new RegExp(opt('--only'), 'i') : null;
  const maxTex = +opt('--max-tex', 1024);
  const dry = args.includes('--dry');
  let doChars = args.includes('chars'), doWeapons = args.includes('weapons');
  if (!doChars && !doWeapons) doChars = doWeapons = true;
  const log = console.log;
  if (!fs.existsSync(CLIENTS[0].pack)) { console.error(`pbx: PBCross Pack folder not found: ${CROSS.root}`); process.exit(2); }
  const repFile = extractedPath('export-batch-report.json');
  let prevReport = {};
  try { prevReport = JSON.parse(fs.readFileSync(repFile, 'utf8')); } catch { /* first run */ }
  const report = { ...prevReport, generated: new Date().toISOString(), maxTex, only: only?.source || null }; // chars / weapons sections kept from the last run of each
  if (doChars) {
    const r = exportChars({ only, maxTex, embedClips: args.includes('--embed-clips'), dry, log });
    if (only && !r.entries.length) log(`no character matches --only ${only.source}`);
    const idx = path.join(OUT, 'chars', 'index.json');
    const list = dry ? r.entries : writeIndex(idx, 'chars', r.entries, !only);
    report.chars = { exported: r.entries.length, indexed: list.length, red: list.filter((e) => e.team === 'red').length, blue: list.filter((e) => e.team === 'blue').length,
      withItemId: list.filter((e) => e.itemId).length, bytesMB: dry ? 0 : mb(dirBytes(path.join(OUT, 'chars'))), byClient: Object.fromEntries(CLIENTS.map((c) => [c.key, list.filter((e) => e.client === c.key).length])), skipped: r.skipped };
  }
  if (doWeapons) {
    const r = exportWeapons({ only, maxTex, skins: args.includes('--skins'), dry, log });
    if (only && !r.entries.length) log(`no weapon matches --only ${only.source}`);
    const idx = path.join(OUT, 'weapons', 'models', 'index.json');
    const list = dry ? r.entries : writeIndex(idx, 'weapons', r.entries, !only);
    report.weapons = { exported: r.entries.length, indexed: list.length, models: list.filter((e) => !e.skinOf).length, skins: list.filter((e) => e.skinOf).length,
      textured: list.filter((e) => e.textured).length, untextured: list.filter((e) => !e.textured).map((e) => e.id), withItemId: list.filter((e) => e.itemId).length,
      inServer: list.filter((e) => e.inServer).length, byClient: Object.fromEntries(CLIENTS.map((c) => [c.key, list.filter((e) => e.client === c.key).length])),
      bytesMB: dry ? 0 : mb(dirBytes(path.join(OUT, 'weapons', 'models'))), skinItemsListed: r.skinStats.listed, skinsWithoutTextures: r.skinStats.noTextures, skinsShadowedByModel: r.skinStats.shadowed.length, skipped: r.skipped };
  }
  if (!dry) { fs.mkdirSync(path.dirname(repFile), { recursive: true }); fs.writeFileSync(repFile, JSON.stringify(report, null, 1)); }
  const brief = JSON.parse(JSON.stringify(report, (k, v) => (['skipped', 'untextured', 'skinsWithoutTextures'].includes(k) && Array.isArray(v) ? `${v.length} (see report)` : v)));
  console.log(JSON.stringify(brief, null, 1), dry ? '' : `\nreport: ${rel(repFile)}`);
}
