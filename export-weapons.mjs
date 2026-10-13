#!/usr/bin/env node
// Weapon data + SFX exporter for the web app.
//
//   node export-weapons.mjs [--all-sfx] [--no-sfx]
//   node export-weapons.mjs --anim-only   (only re-attach changeTime to the existing weapons.json)
//
// 1) server/binary/Debug/Data/Match/ItemStatistics.xml  ->  <out>/weapons/weapons.json
//    Id layout (Plugin.Core ComDiv.GetIdStatics): 6 digits = S CC NNN (slot, ClassType, number),
//    7 digits = S CCC NNN. Slot 1 primary, 2 secondary, 3 melee, 4 explosive, 5 special.
//    Units, as the server reads them (Server.Match AllUtils.ValidateHitData / ValidateGrenadeHit):
//      Range   meters; hit rejected if |StartBullet-EndBullet| > Range (grenade: |FirePos-HitPos|).
//      Damage  base body damage (HP 100). Non-head hits may be up to Damage*1.3 (server cap),
//              head is uncapped. Grenade raw damage is doubled by the server (client sends half).
//      FireDelay seconds between shots. HelmetPenetrate = % of head damage that passes a helmet.
//    Recoil / spread / reload / zoom / move-speed values come per weapon from the Cross Weapon.pef only, see pbBlock.
//    What is still a placeholder is listed in docs/FIDELITY.md.
//
// 2) Sound_Weapon_*.i3Pack (RIFF payloads in clear) -> <out>/weapons/sfx/<key>/NNN.wav + index.json
//    File names inside the pack are encrypted (see tools/i3pack/unpack.mjs RISK), so the role of each
//    clip is guessed: fire = first clip 0.6-4s with a sharp attack (<25ms) and high RMS; reload = the
//    remaining short clips in pack order; explosion (throw packs) = longest clip.
import { assetPath, baseClient, clientPath, extractedPath, generatedPath, rel, serverPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { convertWavs } from './wav-to-ogg.mjs';
import { carve, decodeContent, parsePack } from './i3pack/unpack.mjs';

const XML = serverPath('runtime', 'Data', 'Match', 'ItemStatistics.xml'); // server/binary/Debug was removed by the reorganisation (d593df83)
const PACK_DIR = clientPath(baseClient('br3123'), 'Pack');
const SFX_PACK_DIR = clientPath(baseClient('cross'), 'Pack'); // sounds: PBCross packs only (no 3.123 clip)
const OUT = assetPath('cross', 'weapons'); // new subfolder: <out>/weapons/weapons.json stays the 3.123 output
const args = process.argv.slice(2);

const CLASS_NAMES = {
  0: 'Unknown', 1: 'Knife', 2: 'HandGun', 3: 'Assault', 4: 'SMG', 5: 'Sniper', 6: 'Shotgun', 7: 'ThrowingGrenade',
  8: 'ThrowingSpecial', 9: 'Mission', 10: 'Machinegun', 11: 'GrenadeShell', 12: 'BombTrigger', 13: 'CIC',
  14: 'DualHandGun', 15: 'DualKnife', 16: 'RocketLauncher', 17: 'OnObject', 18: 'DualSMG', 19: 'Dino',
  20: 'DinoLeftScratch', 23: 'Knuckle', 26: 'Bow', 27: 'ThrowingAttack', 28: 'ThrowingHeal', 30: 'Unknown30',
  34: 'Unknown34', 35: 'DualShotgun', 37: 'Shield', 200: 'WoodenArrow',
};
// gameplay family used by the web WeaponSystem
const FAMILY = {
  3: 'AR', 4: 'SMG', 18: 'SMG', 5: 'SR', 6: 'SG', 35: 'SG', 10: 'MG', 2: 'HG', 13: 'HG', 14: 'HG', 26: 'HG',
  1: 'KNIFE', 15: 'KNIFE', 23: 'KNIFE', 7: 'GRENADE', 8: 'GRENADE', 27: 'GRENADE', 28: 'GRENADE',
  11: 'GRENADE', 16: 'GRENADE',
};
const SLOT_NAMES = { 1: 'primary', 2: 'secondary', 3: 'melee', 4: 'explosive', 5: 'special' };

// Per-weapon handling comes from the Cross Weapon.pef only (extracted/pef-cross/br/Weapon.json, tools/pef/export-cross.mjs),
// Cross only ("Cross or nothing"): no 2017 and no 3.123 value. An item the Cross pef
// does not have is not written (the shop hides it, W5). Its match is by _ClassType/_Number + name check (ids were reused
// between builds). A key the Cross entry lacks stays absent: the runtime uses the exe default for it.
// ItemStatistics.xml stays the source of the top-level damage/range/ammo because the server validates hits against it;
// fireDelay comes from the pef (the XML rounds it to 2 decimals). Every weapon in the output gets a `pb` block (pef units:
// angles in degrees, MoveNormal_* in %, times in s) and an `xmlDiff` listing the fields where the XML and the pef disagree.
const PEF_CROSS_WEAPON = extractedPath('pef-cross', 'br', 'Weapon.json'); // tools/pef/export-cross.mjs
const PEF_CROSS_CHARA = extractedPath('pef-cross', 'br', 'Character.json');
/** Cross default soldier: SWAT_Male has the 2017 SWAT_Male values (HP 100, DamageRate Head 35) [INFERIDO: same model]. */
const DEFAULT_CHARA = 'SWAT_Male';
/** Dual-knife alias, [INFERIDO]: Cross Kunai 301107 has no OriginalWeaponID, so its base is named here (dualKnifeAlias reads pb.base). */
const DUAL_KNIFE_BASE = { 301107: 'Dual/Dual_Kunai' };

// Family-level values that have NO pef/exe source yet (listed in docs/FIDELITY.md). Everything else is per weapon.
const CLASS_PARAMS = {
  AR: { fireMode: 'auto' }, SMG: { fireMode: 'auto' }, MG: { fireMode: 'auto' }, SR: { fireMode: 'bolt' },
  SG: { fireMode: 'pump' }, HG: { fireMode: 'semi' }, KNIFE: { fireMode: 'melee' },
  // PLACEHOLDER fuse: not identified in either pef (Explosion_Time 0.9 / EffectiveTime 0.8 are too short for a fuse).
  GRENADE: { fireMode: 'throw', fuse: 2.5 },
};

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const pick = o => {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || (isObj(v) && !Object.keys(v).length)) continue;
    r[k] = v;
  }
  return r;
};

/** Cross entry -> flat (guns keep Damage{} as a group, knives store it under "Damage"). */
function flatCross(e) {
  const r = {};
  for (const [k, v] of Object.entries(e)) if (!isObj(v)) r[k] = v;
  for (const g of ['Damage{}', 'Damage']) if (isObj(e[g])) for (const [k, v] of Object.entries(e[g])) if (r[k] === undefined) r[k] = v;
  // _Extension = the Extension1 Type: same names except Scope2 -> Scope (2017 joins, 252 of 1386) [INFERIDO].
  // Four scope guns (G36C Elite, Walther wa2000, XM2010...) have no _Extension but a top-level Type "Scope2" instead.
  const ext = typeof e._Extension === 'string' && e._Extension ? e._Extension : typeof e.Type === 'string' ? e.Type : '';
  if (ext) r.ExtType = ext === 'Scope2' ? 'Scope' : ext;
  return r;
}

// Cross ids were reused (103025 is "AK-47 Silver" in the XML, AK-47_Point15 in the pef), so an id match is only
// kept when every token of the XML name appears in the pef name; otherwise the entry of the same class whose name
// normalises to the XML name is used.
// ItemStatistics.xml has two rows with Id 103313 (Cane Gun 30 dmg, Cane Shotgun 100 dmg): the shotgun's id is 106087
// (shop row 006_migration_shop_faithful_port_20260629.sql:2786; 3.123 ITEMID 106087 = Shotgun/Christmas2016_CaneShotgun;
// 2017 pef class 6 number 87 = Gun/Christmas2016_CaneShotgun). Without this the row joins the Cane Gun entries.
const XML_ID_FIX = { '103313 Cane Shotgun': 106087 };
const tokens = s => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const pefNames = h => [h.src.slice(h.src.indexOf('/') + 1), String(h.f._ResName ?? '')].map(norm);
const nameOk = (xmlName, h) => { const ns = pefNames(h); return tokens(xmlName).every(t => ns.some(n => n.includes(t))); };
// name fallback, two maps per class: pef entry key (Gun/MK46_SteadyAim) first, then _ResName. A name held by two entries
// of the class is no join (null): M-7 is the _ResName of 26 dino entries, and the first one in file order (DinoAcidBite)
// took 119027, which has no 19:27 entry of its own. Before, one map with first-wins decided these by file order.
function loadCrossWeapons(file = PEF_CROSS_WEAPON) {
  const idx = new Map(), byKey = new Map(), byRes = new Map();
  if (!fs.existsSync(file)) throw new Error(`no ${file}: run pbx re cross-pef first`);
  const wl = JSON.parse(fs.readFileSync(file, 'utf8')).WeaponList.Weapon;
  for (const [cat, group] of Object.entries(wl)) {
    if (!isObj(group)) continue;
    for (const [name, e] of Object.entries(group))
      if (isObj(e) && e._ClassType !== undefined) idx.set(`${e._ClassType}:${e._Number}`, { src: `${cat}/${name}`, f: flatCross(e) });
  }
  const addName = (m, k, h) => { if (!k.endsWith(':')) m.set(k, m.has(k) && m.get(k) !== h ? null : h); };
  // throwables: the XML's special-slot ids (FlashBang 508002, SmokeGrenade 508001) are class 8 / 27 / 28 while the Cross pef
  // has the same item as class 7 (FlashBang 7:3). Name match across the grenade classes only.
  const byGren = new Map();
  for (const h of idx.values()) {
    addName(byKey, `${h.f._ClassType}:${norm(h.src.slice(h.src.indexOf('/') + 1))}`, h);
    addName(byRes, `${h.f._ClassType}:${norm(String(h.f._ResName ?? ''))}`, h);
    if (FAMILY[h.f._ClassType] === 'GRENADE') addName(byGren, norm(h.src.slice(h.src.indexOf('/') + 1)), h);
  }
  return { idx, byKey, byRes, byGren };
}
function matchCross(pCross, classType, number, name) {
  const h = pCross.idx.get(`${classType}:${number}`);
  if (h && nameOk(name, h)) return h;
  const k = `${classType}:${norm(name)}`;
  const same = pCross.byKey.get(k) ?? pCross.byRes.get(k) ?? null;
  if (same || FAMILY[classType] !== 'GRENADE') return same;
  return pCross.byGren.get(norm(name)) ?? null;
}

// Character.<DEFAULT_CHARA>.DamageRate of the Cross pef: plain per-part multipliers (the same table holds Dino heads
// 1.5-3.9, Mode.SuddenDeath 3 on every part; CCharaInfo::ReadDamageRateInfo is not disassembled).
function loadDamageRate() {
  const d = JSON.parse(fs.readFileSync(PEF_CROSS_CHARA, 'utf8')).Character[DEFAULT_CHARA]?.DamageRate;
  return d && Object.fromEntries(Object.entries(d).map(([k, v]) => [k.toLowerCase(), v]));
}

/** pef block from a flat key getter (every key read goes through get, so provenance can be tracked). */
function pbBlock(get, src, family) {
  const n = k => num(get(k));
  return pick({
    src,
    damage: n('Damage'), damageMax: n('DamageMax'), fireDelay: n('FireDelay'), range: n('Range'), dpdRate: n('DPD_Rate'),
    helmetPenetrate: n('HelmetPenetrate'), helmetPenetrateStr: n('HelmetPenetrate_Str'), bulletWeight: n('BulletWeight'),
    loadBullet: n('LoadBullet'), maxBullet: n('MaxBullet'),
    fireBulletCount: n('FireBulletCount'), fireDecBulletCount: n('FireDecBulletCount'),
    autoFireCount: n('AutoFireCount'), autoFireDelay: n('AutoFireDelay'),
    triggerType: n('_TriggerType'), fireType: n('_FireType'), zoomType: n('_ZoomType'),
    extType: typeof get('ExtType') === 'string' ? get('ExtType') : undefined,
    swapSound: typeof get('_SwapSound') === 'string' ? get('_SwapSound') : undefined, // Common/change/<name>.wav
    fireSound: typeof get('_FireSound') === 'string' ? get('_FireSound') : undefined, // <name>.wav (export-sfx2017.mjs)
    reloadTime: n('ReloadTime'), reloadBulletCount: n('ReloadBulletCount'),
    needToLoadBullet: n('NeedToLoadBullet'), loadBulletTime: n('LoadBulletTime'), pumpAction: n('PumpAction'),
    fovOnZoom: n('FovOnZoom'), fovOnScope: n('FovOnScope'), fovOnScope2: n('FovOnScope2'), maxScopeLevel: n('MaxScopeLevel'), fastZoom: n('FastZoom'),
    deviation: n('Deviation'), deviationMax: n('Deviation_Max'), deviationDecrement: n('Deviation_Decrement'),
    deviationDiminutionDistance: n('Deviation_DiminutionDistance'),
    recoil: pick({ vertAngle: n('RecoilVertAngle'), vertMax: n('RecoilVertMax'), horzAngle: n('RecoilHorzAngle'),
      horzMax: n('RecoilHorzMax'), horzCount: n('RecoilHorzCount'), camSyncRate: n('CamSyncRate'),
      vertCount: n('RecoilVertCount'), oneVert: n('OneVertEnable'), oneHorz: n('OneHorzEnable'),
      vertRecoverTime: n('RecoilVertAngle_Recovertime'), horzRecoverTime: n('RecoilHorzAngle_Recovertime') }),
    crosshair: pick({ stand: n('CrossHair_Size_Stand'), walk: n('Crosshair_Size_Walk') ?? n('CrossHair_Size_Walk'),
      move: n('CrossHair_Size_Move'), jump: n('CrossHair_Size_Jump'), fire: n('CrossHair_Size_Fire'), zoom: n('CrossHair_Size_Zoom'),
      noZoom: n('Crosshair_Size_NoZoom') ?? n('CrossHair_Size_NoZoom'), sit: n('CrossHair_Size_Sit'),
      moveSit: n('CrossHair_Size_MoveSit'), walkSit: n('Crosshair_Size_WalkSit') ?? n('CrossHair_Size_WalkSit'),
      damage: n('CrossHair_Size_Damage'), min: n('CrossHair_Min'), max: n('CrossHair_Max'), expand: n('CrossHair_Expand'),
      speedFactor: n('CrossHair_SpeedFactor'), expandTime: n('CrossHair_ExpandTime'),
      contractTime: n('Crosshair_Contracttime') ?? n('CrossHair_ContractTime') ?? n('CrossHair_Contracttime'),
      type: n('CrossHair_Type'), invisible: n('CrossHair_Invisible') }),
    moveNormal: pick({ stand: n('MoveNormal_Stand'), fire: n('MoveNormal_Fire'), sit: n('MoveNormal_Sit'),
      zoom: n('MoveNormal_Zoom'), scope: n('MoveNormal_Scope') }),
    ext: pick({ deviationFactor: n('Ext_DeviationFactor'), recoilVertFactor: n('Ext_RecoilVertFactor'),
      recoilHorzFactor: n('Ext_RecoilHorzFactor'), recoilHorzCount: n('Ext_RecoilHorzCount'), recoilVertCount: n('Ext_RecoilVertCount'),
      autoFireCount: n('Ext_AutoFireCount'), fireDelay: n('Ext_FireDelay'), damage: n('Ext_Damage') }),
    melee: family === 'KNIFE' ? pick({ damageA1: n('AttackDamageA1'), damageA2: n('AttackDamageA2'),
      damageB1: n('AttackDamageB1'), damageB2: n('AttackDamageB2'), timeA1: n('AttackTimeA1'), timeA2: n('AttackTimeA2'),
      timeB1: n('AttackTimeB1'), timeB2: n('AttackTimeB2'), fireDelay2: n('FireDelay2'),
      autoFireCount2: n('AutoFireCount2') }) : undefined,
    grenade: family === 'GRENADE' ? pick({ explosionRange: n('Explosion_Range'), explosionNearRange: n('Explosion_NearRange'),
      explosionSlope: n('Explosion_EffectiveSlope'), explosionTime: n('Explosion_Time'), effectiveTime: n('EffectiveTime'),
      throwSpeed: n('Throw_Speed'), throwDelay: n('AttackTimeA1') }) : undefined,
  });
}

/** pb block of one Cross entry. baseSrc = the Cross entry named by OriginalWeaponID (a skin points at its base item). */
function buildPb(h, family, baseSrc) {
  const pb = pbBlock(k => h.f[k], `pef-cross:${h.src}`, family);
  if (baseSrc) pb.base = baseSrc;
  return pb;
}

// fire mode from the pef: AutoFireCount 0 = full auto, 1 = semi, n>1 = burst of n; NeedToLoadBullet+LoadBulletTime =
// bolt (sniper) / pump (PumpAction) cycle after every shot.
function pefFireMode(family, pb) {
  if (family === 'KNIFE') return 'melee';
  if (family === 'GRENADE') return 'throw';
  if (pb.pumpAction) return 'pump';
  if (pb.needToLoadBullet && family === 'SR') return 'bolt';
  if (pb.autoFireCount === 0) return 'auto';
  if (pb.autoFireCount > 1) return 'burst';
  if (pb.autoFireCount === 1) return 'semi';
  return undefined;
}

function xmlDiff(w, pb) {
  const d = {};
  const cmp = (k, xml, pef, tol = 1e-6) => { if (pef !== undefined && Math.abs(xml - pef) > tol) d[k] = [xml, pef]; };
  cmp('damage', w.damage, pb.damage);
  cmp('range', w.range, pb.range);
  cmp('loadedBullet', w.loadedBullet, pb.loadBullet);
  cmp('totalBullet', w.totalBullet, pb.maxBullet);
  cmp('fireDelay', w.fireDelayXml, pb.fireDelay, 0.0051); // XML is rounded to 2 decimals
  if (pb.helmetPenetrate !== undefined) cmp('helmetPenetrate', w.helmetPenetrate, Math.round(pb.helmetPenetrate * 100), 0.51);
  return Object.keys(d).length ? d : undefined;
}

function exportData(packKeys) {
  const rows = parseXml();
  const pCross = loadCrossWeapons();
  const hitzone = loadDamageRate();
  const stat = { cross: 0, absent: 0, diverging: 0 };
  const diffCount = {};
  const entries = [];
  for (const a of rows) {
    const id = XML_ID_FIX[`${a.Id} ${a.Name.trim()}`] ?? Number(a.Id);
    const big = id >= 1_000_000;
    const slot = big ? Math.floor(id / 1_000_000) : Math.floor(id / 100_000);
    const classType = big ? Math.floor(id / 1000) % 1000 : Math.floor(id / 1000) % 100;
    const number = id % 1000;
    const family = FAMILY[classType] || 'OTHER';
    const name = a.Name.trim();
    const fireDelayXml = Number(a.FireDelay);
    const w = {
      id, name, slot, slotName: SLOT_NAMES[slot] || 'other', classType, className: CLASS_NAMES[classType] || `Class${classType}`,
      family, loadedBullet: Number(a.LoadedBullet), totalBullet: Number(a.TotalBullet), damage: Number(a.Damage),
      fireDelay: fireDelayXml, fireDelayXml, rpm: 0, helmetPenetrate: Number(a.HelmetPenetrate),
      range: Number(a.Range), sfx: sfxKeyFor(name, family, packKeys) || GENERIC[family] || null,
    };
    const cross = matchCross(pCross, classType, number, name);
    if (!cross) { stat.absent++; continue; } // not in the Cross pef: not written (no 2017 / 3.123 fallback)
    entries.push({ w, cross });
  }
  // a skin's OriginalWeaponID names its base item (pb.base, read by dualKnifeAlias and the skin code)
  const crossOf = new Map(entries.map(e => [e.w.id, e.cross]));
  for (const { w, cross } of entries) {
    const ow = num(cross.f.OriginalWeaponID);
    const baseSrc = DUAL_KNIFE_BASE[w.id] ?? (ow !== undefined && ow !== w.id ? crossOf.get(ow)?.src : undefined);
    const pb = buildPb(cross, w.family, baseSrc);
    w.pb = pb;
    stat.cross++;
    if (pb.fireDelay > 0) w.fireDelay = pb.fireDelay;
    const fm = pefFireMode(w.family, pb);
    if (fm) w.fireMode = fm;
    const d = xmlDiff(w, pb);
    if (d) { w.xmlDiff = d; stat.diverging++; for (const k of Object.keys(d)) diffCount[k] = (diffCount[k] || 0) + 1; }
    w.rpm = w.fireDelay > 0 ? Math.round(60 / w.fireDelay) : 0;
  }
  const weapons = entries.map(e => e.w);
  const byId = new Map(weapons.map(w => [w.id, w]));
  // dual link, Cross form (no Extension2 in the Cross pef): a Dual item's OriginalWeaponID is the single it came from
  // (KrissSuperV_Dual 118001 -> 104013). Both ways: the single gets dualId, the dual gets dualOf; the extension key toggles.
  // Several duals can name one single (KrissSuperV_Dual 118001 and _GRS2 118048 both name 104013): the lowest id wins,
  // the plain dual is the lowest one [INFERIDO].
  for (const { w, cross } of entries.sort((a, b) => a.w.id - b.w.id)) {
    const single = num(cross.f.OriginalWeaponID);
    if (cross.src.startsWith('Dual/') && single !== undefined && byId.has(single) && byId.get(single).pb.dualId === undefined) {
      byId.get(single).pb.dualId = w.id; w.pb.dualOf = single;
    }
  }
  const animN = attachAnimTimes(weapons);
  const json = {
    source: 'ItemStatistics.xml (id, name, damage, range, ammo) + pb.* from extracted/pef-cross/br/Weapon.json (PBCross, pb.src pef-cross:) only; '
      + 'items the Cross pef lacks are not written',
    generated: new Date().toISOString(),
    units: {
      range: 'meters (server rejects hits farther than Range)', damage: 'HP; non-head capped by server at damage*1.3',
      fireDelay: 'seconds between shots (pef value; fireDelayXml = rounded XML value)',
      helmetPenetrate: 'XML percent; pb.helmetPenetrate 0..1 = chance a head hit gets through (CalcHelmetPenetrate 0x5425e0)',
      grenade: 'server doubles grenade RawDamage (client packet carries damage/2); Range = max throw->hit distance',
      pb: 'raw Weapon.pef values: angles in degrees, moveNormal in % of the character speed, times in seconds',
    },
    hitzone,
    charaDamageRate: { [DEFAULT_CHARA]: hitzone },
    placeholder: 'classes.GRENADE.fuse has no pef source; see docs/FIDELITY.md',
    classes: CLASS_PARAMS,
    defaultLoadout: DEFAULT_LOADOUT,
    count: weapons.length,
    pefStats: stat,
    changeTime: `1PV Change i3AIState duration (s), SWAT_Male anim1pv, ${animN} weapons`,
    xmlDivergences: { weapons: stat.diverging, byField: diffCount },
    weapons,
  };
  for (const [k, id] of Object.entries(DEFAULT_LOADOUT)) if (!byId.has(id)) console.warn(`default ${k} ${id} missing`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'weapons.json'), JSON.stringify(json));
  const reps = {};
  for (const [fam, id] of Object.entries(FAMILY_REP)) {
    const w = byId.get(id);
    if (w?.pb) reps[fam] = w.pb; else console.warn(`family rep ${fam} ${id} has no pef block`);
  }
  fs.writeFileSync(FAMILY_TS, `// GENERATED by tools/export-weapons.mjs - do not edit. Weapon.pef blocks (PBCross only) of one weapon per family,
// used for weapons.json items without a pef entry and before weapons.json is loaded.
import type { PbWeaponBlock } from "./types";

export const FAMILY_PB: Record<string, PbWeaponBlock> = ${JSON.stringify(reps, null, 1)};
`);
  console.log(`weapons.json: ${weapons.length} weapons ${JSON.stringify(stat)} xmlDiff ${JSON.stringify(diffCount)}`);
  return weapons;
}

// weapons whose pef block stands in for items without a pef entry (and for the pre-weapons.json fallback)
const FAMILY_REP = { AR: 103015, SMG: 104033, MG: 110005, SR: 105003, SG: 106001, HG: 202022, KNIFE: 301001, GRENADE: 407001 };
const FAMILY_TS = generatedPath('weapons/pbFamilyDefaults.ts');
const DEFAULT_LOADOUT = { primary: 103037, primaryAlt: 104033, secondary: 202022, melee: 301001, grenade: 407001,
  sniper: 105003, shotgun: 106001 };

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const packKeyFamily = k =>
  /^AssaultRifle/.test(k) ? 'AR' : /^SMG/.test(k) ? 'SMG' : /^SniperRiffle|^LSS/.test(k) ? 'SR'
  : /^ShotGun/.test(k) ? 'SG' : /^MachineGun|^L86|^M197/.test(k) ? 'MG'
  : /^(Dual)?HandGun|^DualHK45/.test(k) ? 'HG' : /^Melee|^DualKnife/.test(k) ? 'KNIFE'
  : /^Throw|^CandyGrenade|^C4|^C5|^GrenadeLauncher|^LocketLauncher/.test(k) ? 'GRENADE' : 'OTHER';
const GENERIC = { AR: 'AssaultRifle_AK-47', SMG: 'SMG_MP7', MG: 'MachineGun_MK46', SR: 'SniperRiffle_SSG69',
  SG: 'ShotGun_870MCS', HG: 'HandGun_Colt45', KNIFE: 'Melee_M-7', GRENADE: 'Throw_K-400' };

function parseXml() {
  const txt = fs.readFileSync(XML, 'utf8');
  const out = [];
  for (const m of txt.matchAll(/<Statistic\s+([^>]*?)\/>/g)) {
    const a = {};
    for (const kv of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[kv[1]] = kv[2];
    out.push(a);
  }
  return out;
}

function sfxKeyFor(name, family, packKeys) {
  const n = norm(name);
  let best = null, bestLen = 0;
  for (const k of packKeys) {
    const tail = k.includes('_') ? k.slice(k.indexOf('_') + 1) : k;
    const t = norm(tail);
    if (!t || !n.startsWith(t)) continue;
    const score = t.length + (packKeyFamily(k) === family ? 100 : 0);
    if (score > bestLen) { best = k; bestLen = score; }
  }
  return best && (packKeyFamily(best) === family || bestLen >= 4) ? best : null;
}

// ---- SFX --------------------------------------------------------------------
function wavInfo(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let p = 12, fmt = null, ds = 0, dl = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4), n = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(p + 8), ch: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bps: buf.readUInt16LE(p + 22) };
    if (id === 'data') { ds = p + 8; dl = Math.min(n, buf.length - ds); }
    p += 8 + n + (n & 1);
  }
  if (!fmt || !ds) return null;
  const bytes = fmt.bps / 8, N = Math.floor(dl / bytes / fmt.ch);
  const sample = i => bytes === 2 ? buf.readInt16LE(ds + i * 2 * fmt.ch) / 32768 : (buf[ds + i * fmt.ch] - 128) / 128;
  let pk = 0, e = 0;
  for (let i = 0; i < N; i++) { const v = Math.abs(sample(i)); e += v * v; if (v > pk) pk = v; }
  let atk = 0;
  for (let i = 0; i < N; i++) if (Math.abs(sample(i)) > pk * 0.5) { atk = i; break; }
  return { dur: +(N / fmt.rate).toFixed(3), atk: +(atk / fmt.rate).toFixed(3), rms: +Math.sqrt(e / Math.max(1, N)).toFixed(3) };
}

// wavs of a PBCross sound pack: { dir, name, buf }, dir = node path below Sound/Weapon ("Common/Change", "SniperRiffle/DSR_1").
// Read here, not with unpack(): the SniperRiffle packs have "D:/PointBlank/..." node paths that unpack cannot write.
// OLD nodes (no offsets) carve their RIFFs and zip them with the names in file order (as export-break-sfx.mjs packWavs)
function packWavs(file) {
  const d = fs.readFileSync(file), out = [];
  for (const n of parsePack(d).nodes) {
    const np = n.path.replace(/\\/g, '/'), at = np.search(/(^|\/)Sound\/Weapon\//i);
    if (at < 0) continue;
    const dir = np.slice(at).replace(/^\/?Sound\/Weapon\/?/i, '');
    const carved = n.indexOk ? null : carve(d, { ...n, fileCount: n.files.length }).files;
    if (carved && carved.length !== n.files.length) continue;
    n.files.forEach((e, i) => {
      if (!/\.wav$/i.test(e.name)) return;
      let buf = carved ? d.subarray(carved[i].offset, carved[i].offset + carved[i].size) : d.subarray(e.offset, e.offset + e.size);
      if (!carved && e.attr) buf = decodeContent(buf, e.attr) ?? buf;
      out.push({ dir, name: e.name, buf });
    });
  }
  return out;
}

function exportSfx(keys) {
  const sfxDir = assetPath('weapons', 'sfx'); // runtime path (sfx stays in weapons/, only weapons.json moved)
  fs.mkdirSync(sfxDir, { recursive: true });
  const index = { note: 'roles guessed from clip length/attack (pack file names are encrypted)', packs: {}, common: {} };
  let bytes = 0;
  for (const key of keys) {
    const pack = path.join(SFX_PACK_DIR, `Sound_Weapon_${key}.i3Pack`);
    if (!fs.existsSync(pack)) { console.warn(`missing pack ${key}`); continue; }
    const files = packWavs(pack);
    if (key === 'Common') {
      for (const f of files) {
        const sub = f.dir.replace(/^Common\/?/i, '').split('/');
        const group = (sub[0] || 'misc').toLowerCase();
        if (!['change', 'emptybullet', 'emptycatridge', 'hit', 'zoom'].includes(group)) continue;
        const info = wavInfo(f.buf);
        if (!info || info.dur > 2.5) continue;
        const dst = path.join(sfxDir, 'Common', group, f.name);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, f.buf); bytes += f.buf.length;
        (index.common[group] ||= []).push(`Common/${group}/${f.name}`);
      }
      continue;
    }
    const fam = packKeyFamily(key);
    const clips = [];
    for (const [i, f] of files.entries()) {
      const buf = f.buf, info = wavInfo(buf);
      if (!info) continue;
      const nm = `${String(i).padStart(3, '0')}.wav`;
      fs.mkdirSync(path.join(sfxDir, key), { recursive: true });
      fs.writeFileSync(path.join(sfxDir, key, nm), buf); bytes += buf.length;
      clips.push({ file: `${key}/${nm}`, ...info });
    }
    if (!clips.length) continue;
    const entry = { family: fam, clips: clips.map(c => c.file), fire: [], reload: [], swing: [], explode: [], other: [] };
    if (fam === 'KNIFE') entry.swing = clips.map(c => c.file);
    else if (fam === 'GRENADE') {
      const longest = clips.reduce((a, b) => (b.dur > a.dur ? b : a));
      entry.explode = [longest.file];
      entry.other = clips.filter(c => c !== longest).map(c => c.file);
    } else {
      const isFire = c => c.dur >= 0.6 && c.dur <= 4.5 && c.atk <= 0.025 && c.rms >= 0.12;
      const fire = clips.filter(isFire);
      if (!fire.length) fire.push(clips.reduce((a, b) => (b.rms * (b.atk < 0.03 ? 2 : 1) > a.rms * (a.atk < 0.03 ? 2 : 1) ? b : a)));
      entry.fire = fire.map(c => c.file);
      entry.reload = clips.filter(c => !fire.includes(c) && c.dur < 1.6).map(c => c.file);
      entry.other = clips.filter(c => !fire.includes(c) && c.dur >= 1.6).map(c => c.file);
    }
    index.packs[key] = entry;
  }
  fs.writeFileSync(path.join(sfxDir, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`sfx: ${Object.keys(index.packs).length} packs + common, ${(bytes / 1048576).toFixed(1)} MB -> ${rel(sfxDir)}`);
  convertWavs(sfxDir);
}

// ---- 1PV animation timing ----------------------------------------------------------------------------------------
// The swap time is not in Weapon.pef: PB plays the upper-body Change state (the draw) of the weapon's 1PV AI and the
// weapon can fire when that state ends (exe-2017 CGameCharaActionControl 0xa0c3d0 -> _Animation_Upper(9, 0, scale);
// the weapon's own i3AI Change1PV state is 0.033 s). changeTime = that state's i3AIState duration in
// chars/swat_male/anim1pv/index.json (tools/export-anim1pv.mjs, 2017 SWAT_Male.I3CHR). 35 items with no 1PV AI keep
// the runtime default. SWAT_Female differs on 46 items; the web 1PV arms are SWAT_Male.
const ANIM1PV = assetPath('chars', 'swat_male', 'anim1pv', 'index.json'); // 3.123-independent: OUT is cross/weapons
function attachAnimTimes(weapons) {
  if (!fs.existsSync(ANIM1PV)) { console.warn(`no ${rel(ANIM1PV)}: changeTime not set`); return 0; }
  const ix = JSON.parse(fs.readFileSync(ANIM1PV, 'utf8'));
  let n = 0;
  for (const w of weapons) {
    const ai = ix.weapons[String(w.id)];
    const d = ai && ix.ai[ai]?.stances?.AttackIdle?.Change?.dur;
    if (d > 0) { w.changeTime = +d.toFixed(4); n++; } else delete w.changeTime;
    // NeedToLoadBullet without a LoadBulletTime key (Taurus 454SS, Cerberus...: 121 pistols in the 3.123 pef, 31 in 2017):
    // the LoadBullet state lasts its i3AIState duration (the cock clip) and the next shot waits for it
    const lb = ai && ix.ai[ai]?.stances?.AttackIdle?.LoadBullet?.dur;
    if (w.family !== 'KNIFE' && w.pb?.needToLoadBullet && w.pb.loadBulletTime === undefined && lb > 0) w.loadBulletClip = +lb.toFixed(4); else delete w.loadBulletClip;
  }
  return n;
}

// ---- main -------------------------------------------------------------------
const allPackKeys = fs.existsSync(PACK_DIR) ? fs.readdirSync(PACK_DIR)
  .filter(f => /^Sound_Weapon_.+\.i3Pack$/i.test(f)).map(f => f.replace(/^Sound_Weapon_/, '').replace(/\.i3Pack$/i, '')) : [];
const allSfxKeys = fs.existsSync(SFX_PACK_DIR) ? fs.readdirSync(SFX_PACK_DIR)
  .filter(f => /^Sound_Weapon_.+\.i3Pack$/i.test(f)).map(f => f.replace(/^Sound_Weapon_/, '').replace(/\.i3Pack$/i, '')) : [];
if (args.includes('--anim-only')) {
  const file = path.join(OUT, 'weapons.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const n = attachAnimTimes(json.weapons);
  json.changeTime = `1PV Change i3AIState duration (s), SWAT_Male anim1pv, ${n} weapons`;
  fs.writeFileSync(file, JSON.stringify(json));
  console.log(`weapons.json: changeTime on ${n}/${json.weapons.length} weapons`);
  process.exit(0);
}
// sfx keys to export: every Cross sound pack (--all-sfx), else the loadout / class set below
function sfxKeys(weapons, loadoutIds) {
  if (args.includes('--all-sfx')) return allSfxKeys;
  const keys = new Set(['Common', ...Object.values(GENERIC), 'Throw_Common', 'Throw_Smoke', 'Throw_Flash', 'Throw_K-413',
    'AssaultRifle_M4A1', 'AssaultRifle_SG550', 'AssaultRifle_K2', 'AssaultRifle_AKSOP', 'AssaultRifle_G36C',
    'SMG_AKS74U', 'SMG_P90', 'SMG_Spectre', 'SMG_MP5K', 'SMG_KrissSuperV', 'HandGun_DesertEagle', 'HandGun_Glock18',
    'HandGun_MK23', 'HandGun_K5', 'Melee_M-9', 'SniperRiffle_SVD_Dragunov', 'SniperRiffle_L115A1', 'ShotGun_M1887',
    ...weapons.filter(w => loadoutIds.has(w.id)).map(w => w.sfx).filter(Boolean),
    // every sniper pack: the class fallback (SSG69) is wrong for a sniper whose 2017 pack does not decode (PFN1)
    ...allSfxKeys.filter(k => /^SniperRiffle_/.test(k))]);
  return [...keys].filter(k => allSfxKeys.includes(k));
}
if (args.includes('--sfx-only')) {
  // sounds only, PBCross packs; weapon ids and sfx keys from the Cross catalog (cross/weapons/weapons.json)
  const cross = JSON.parse(fs.readFileSync(path.join(OUT, 'weapons.json'), 'utf8')).weapons;
  exportSfx(sfxKeys(cross, new Set(Object.values(DEFAULT_LOADOUT))));
  process.exit(0);
}
const weapons = exportData(allPackKeys);
if (!args.includes('--no-sfx')) exportSfx(sfxKeys(weapons, new Set(Object.values(DEFAULT_LOADOUT))));
