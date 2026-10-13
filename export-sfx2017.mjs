#!/usr/bin/env node
// Weapon sounds of the 2017 client BY NAME, and when the weapon's own AI plays them.
//
//   node export-sfx2017.mjs     # -> out/weapons/sfx/pb2017.json + sfx/2017/<Sound/Weapon path>
//
// The 3.123 packs used by export-weapons.mjs (sfx/index.json) have encrypted file names, so their roles are guessed and
// weapons without a pack of their own (Cheytac M200: "SniperRiffle_CheyTac" is not exported) fall back to the class
// pack (SSG69). The PBCross packs (Clients/PBCross/Pack) decode with real names:
//   Sound_Weapon_SniperRiffle_CheyTac.i3Pack -> Sound/Weapon/SniperRiffle/CheyTac/WM_CheyTac M200_Fire.wav, ..._Remove.wav
//   * weapon.pef _FireSound / _SwapSound (weapons.json pb.fireSound / pb.swapSound) name the fire / swap clip (no .wav);
//   * reload / bolt sounds are not in the pef: the weapon pack's i3AIState (LoadMag1PVMale, LoadBullet1PVMale, ...) has
//     an i3TimeSequence (AIState +18 u16 ref | 0x8000) whose i3TimeSequenceInfo items (+0 start s, +4 duration s,
//     +0xc i3SoundNode id) name the WAV (i3SoundNode: u8 len, name). i3TimeSequence: u8 0, 'INF2', ..., +17 u32 count,
//     u32 ids. Times are state time: the state plays over ReloadTime / LoadBulletTime (scale dur / time), so an event
//     at t lands at t / dur * time.
// Output pb2017.json:
//   files   { "<wav name lower, no ext>": "2017/<path under Sound/Weapon>/<name>.wav" }   (only referenced clips)
//   weapons { "<item id>": { fire?, swap? } }                                              (wav names, lower)
//   ai      { "<weapon pack AI (anim/index.json sets[].ai)>": { "<state>": { dur, ev: [[t, name], ...] } } }
// PFN1 packs (SSG69) do not decode here: those weapons keep sfx/index.json.
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { convertWavs } from './wav-to-ogg.mjs';
import { fileURLToPath } from 'node:url';
import { carve, decodeContent, parsePack } from './i3pack/unpack.mjs';
import { scanI3R2 } from './i3r2/i3r2.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack');
const ASSETS = assetPath('weapons');
const OUT = path.join(ASSETS, 'sfx');
const key = (n) => n.replace(/\.wav$/i, '').toLowerCase();


// ---- every decodable WAV of the Sound_Weapon_* packs, by name ------------------------------------------------------
const nameless = []; // { pack, rel, d, e } of nodes whose file names are encrypted (000.wav, ...)
function soundFiles() {
  const out = new Map(); // key -> { rel, pack, file }
  for (const f of fs.readdirSync(PACKS).filter((x) => /^Sound_Weapon_.+\.i3Pack$/i.test(x)).sort()) {
    const d = fs.readFileSync(path.join(PACKS, f));
    let nodes;
    try { ({ nodes } = parsePack(d)); } catch { continue; }
    for (const n of nodes) {
      if (!n.indexOk) {
        const np = n.path.replace(/\\/g, '/'), at = np.search(/(^|\/)Sound\/Weapon\//i);
        if (at < 0) continue;
        const carved = carve(d, n).files;
        // "OLD" nodes (Sound_Weapon_SMG_Spectre / _K-1 / ...): parsePack reads the name list (parseOldNames, first slot's
        // corrupted leading byte repaired there) but has no offsets; payloads follow in the same order, so name i = carved file i.
        if (n.pfnVer === 'OLD') {
          const names = n.files.map((nf) => nf.name);
          const all = carve(d, { ...n, fileCount: names.length }).files;
          if (all.length === names.length && all.every((e) => e.magic === 'RIFF')) {
            names.forEach((nm, i) => {
              if (/\.wav$/i.test(nm) && !out.has(key(nm))) out.set(key(nm), { rel: `${np.slice(at).replace(/^\/?Sound\/Weapon\//i, '')}/${nm}`, d, e: all[i] });
            });
            continue;
          }
        }
        for (const e of carved) if (e.magic === 'RIFF')
          nameless.push({ pack: f.replace(/^Sound_Weapon_|\.i3Pack$/gi, ''), rel: np.slice(at).replace(/^\/?Sound\/Weapon\//i, ''), d, e });
        continue;
      }
      for (const e of n.files) {
        if (!/\.wav$/i.test(e.name)) continue;
        // node paths are "Sound/Weapon/..." or the author's absolute path ("D:\Project\...\Sound\Weapon\...")
        const full = `${n.path}/${e.name}`.replace(/\\/g, '/'), at = full.search(/(^|\/)Sound\/Weapon\//i);
        if (at < 0) continue;
        const rel = full.slice(at).replace(/^\/?Sound\/Weapon\//i, '');
        if (!out.has(key(e.name))) out.set(key(e.name), { rel, d, e });
      }
    }
  }
  return out;
}

// ---- weapon pack AI: state -> sound events --------------------------------------------------------------------------
const low = (p) => p.replace(/\\/g, '/').toLowerCase();
const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
/** per scene block: [{ name, clip (i3a path | null), snd: { dur, ev } | undefined }] (every i3AIState, file order) */
function aiScenes(d, needCtx) {
  const scenes = [];
  for (const b of scanI3R2(d)) {
    if (!b.objects.some((o) => o.cls === (needCtx ? 'i3AIContext' : 'i3AIState'))) continue;
    const obj = (id) => b.byId.get(id);
    // the state's own objects (i3SoundPlayInfo, i3SoundNode, i3TimeSequenceInfo, i3TimeSequence) follow it in the
    // object table; the AIState +18 field is flagged 0x8000 when it has a sequence but is not a plain object id
    let name = null, dur = 0, cur = null;
    const list = [];
    for (const o of b.objects) {
      if (o.ext) continue;
      if (o.cls === 'i3AIState') {
        const nl = d[o.off], p = o.off + 1 + nl, full = d.toString('latin1', o.off + 1, o.off + 1 + nl);
        const a = b.byId.get(d.readUInt16LE(p + 16));
        cur = { name: full, clip: a?.cls === 'i3Animation' && a.extPath ? a.extPath : null };
        list.push(cur);
        name = d.readUInt16LE(p + 18) & 0x8000 ? full : null;
        let q = p + 20;
        while (q + 12 <= o.off + o.size && !(d.readUInt32LE(q) === 0xffffffff && d.readUInt32LE(q + 4) === 0xffffffff)) q++;
        dur = q + 12 <= o.off + o.size ? d.readFloatLE(q + 8) : 0;
        continue;
      }
      if (o.cls !== 'i3TimeSequence' || !name) continue;
      const ts = o;
      const n = d.readUInt32LE(ts.off + 17), ev = [];
      for (let i = 0; i < n; i++) {
        const tsi = obj(d.readUInt32LE(ts.off + 21 + i * 4));
        if (!tsi || tsi.cls !== 'i3TimeSequenceInfo') continue;
        const node = obj(d.readUInt32LE(tsi.off + 0xc));
        if (!node || node.cls !== 'i3SoundNode') continue;
        const wav = d.toString('latin1', node.off + 1, node.off + 1 + d[node.off]);
        ev.push([+d.readFloatLE(tsi.off).toFixed(4), key(wav)]);
      }
      if (ev.length && cur) cur.snd = { dur: +dur.toFixed(4), ev: ev.sort((a, b) => a[0] - b[0]) };
      name = null;
    }
    scenes.push(list);
  }
  return scenes;
}
/** own pack: state -> sound events (every scene, a later scene overwrites: unchanged behaviour) */
function aiSounds(d) {
  const states = {};
  for (const sc of aiScenes(d, false)) for (const s of sc) if (s.snd) states[s.name] = s.snd;
  return states;
}
/** same merge as export-weapon-anim mergeAI: first wins, a later scene fills absent states and states with no clip */
function mergeScenes(list) {
  const out = list[0].map((x) => ({ ...x }));
  for (const sc of list.slice(1)) for (const s of sc) {
    const cur = out.find((x) => x.name === s.name);
    if (!cur) out.push({ ...s });
    else if (!cur.clip && s.clip) { cur.clip = s.clip; cur.snd = s.snd; }
  }
  return out;
}
/**
 * Aggregated packs (Weapon_Weapon, Weapon_Weapon Piercing Blow) indexed by the clip folder of each AI, exactly like
 * export-weapon-anim.mjs (readAggregatedAI + aggByFolder): norm(folder) -> merged states. [INFERIDO]: Weapon_Weapon first.
 */
const AGG_PACKS = ['Weapon_Weapon', 'Weapon_Weapon Piercing Blow'];
function aggregated() {
  const by = new Map();
  for (const pk of AGG_PACKS) {
    const f = path.join(PACKS, `${pk}.i3Pack`);
    if (!fs.existsSync(f)) continue;
    const mine = new Map();
    for (const sc of aiScenes(fs.readFileSync(f), true)) {
      const count = new Map();
      for (const x of sc) { const fo = (x.clip && low(x.clip).match(/^weapon\/([^/]+)\//) || [])[1]; if (fo) count.set(fo, (count.get(fo) || 0) + 1); }
      const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!top) continue;
      const k = normKey(top);
      mine.set(k, mine.has(k) ? mergeScenes([mine.get(k), sc]) : sc);
    }
    for (const [k, v] of mine) by.set(k, by.has(k) ? mergeScenes([by.get(k), v]) : v);
  }
  return by;
}


const files = soundFiles();
// Sound_Weapon_Throw_WP_Smoke: its node index lists no file, the pack is one plain RIFF at the data start; the name is the sound
// node of Effect_High Exp_WPSm_01 / _02 (WM_WP_Smoke_Explosion.wav)
try {
  const wpd = fs.readFileSync(path.join(PACKS, 'Sound_Weapon_Throw_WP_Smoke.i3Pack')), at = wpd.indexOf('RIFF');
  if (at >= 0 && !files.has('wm_wp_smoke_explosion')) files.set('wm_wp_smoke_explosion', { rel: 'Throw/WP_Smoke/WM_WP_Smoke_Explosion.wav', d: wpd, e: { offset: at, size: wpd.readUInt32LE(at + 4) + 8 } });
} catch { /* no pack */ }
const used = new Set();
const res = { source: 'PBCross Pack/Sound_Weapon_*.i3Pack (named WAVs) + Weapon_*.i3Pack i3AIState sound events', files: {}, weapons: {}, ai: {} };

const anim = JSON.parse(fs.readFileSync(path.join(ASSETS, 'anim', 'index.json'), 'utf8'));
let aiN = 0, aggN = 0;
const agg = aggregated();
for (const ai of [...new Set(anim.sets.map((s) => s.ai))].sort()) {
  const f = path.join(PACKS, `${ai}.i3Pack`);
  const d = fs.existsSync(f) ? fs.readFileSync(f) : null;
  const st = d ? aiSounds(d) : {};
  // own AI states (merged over scenes like export-weapon-anim readWeaponAI)
  const ownScenes = d ? aiScenes(d, true).filter((x) => x.length) : [];
  const own = ownScenes.length ? mergeScenes(ownScenes) : [];
  // aggregated AI of the clip folder == pack suffix: fills the states export-weapon-anim fills (absent or no clip), or gives the
  // whole AI when the pack has none. The pack's own events win. [INFERIDO]: which AI the exe prefers when both define a state.
  const fill = agg.get(normKey(ai.replace(/^weapon_/i, '')));
  let added = 0;
  if (fill) for (const s of fill) {
    if (!s.snd) continue;
    const cur = own.find((x) => x.name === s.name);
    if (cur && cur.clip) continue;
    if (!st[s.name]) { st[s.name] = s.snd; added++; }
  }
  const keep = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { dur: v.dur, ev: v.ev.filter(([, w]) => files.has(w)) }])
    .filter(([, v]) => v.ev.length));
  if (!Object.keys(keep).length) continue;
  res.ai[ai] = keep;
  aiN++;
  if (added) aggN++;
  for (const v of Object.values(keep)) for (const [, w] of v.ev) used.add(w);
}
// Weapon names come from the Cross catalog (pef-cross, W6): its pb.fireSound / pb.swapSound are the Cross pef's clip names
const weapons = JSON.parse(fs.readFileSync(assetPath('cross', 'weapons', 'weapons.json'), 'utf8')).weapons;

// ---- fire clips of packs whose file names are encrypted (Sound_Weapon_HandGun_Colt45: Colt/000.wav 001 002) -----------
// The Colt45 (default pistol 202022, _FireSound WM_COLT_FIRE) had no named clip and HG fell back to a class pack that
// does not exist -> silent. The pack whose name / folder holds the _FireSound token ("colt") gives the fire clip: the
// longest WAV that starts loud (a shot + tail; Load/Remove/Reload clicks are short or start quiet). The entry order
// is alphabetical in the named packs (WM_X_Fire < _Load < _Reload < _Remove), and the pick agrees with it for Colt45.
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function wavStats(buf) {
  let o = 12, data = null, sr = 44100, ch = 1;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), sz = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(o + 10); sr = buf.readUInt32LE(o + 12); }
    if (id === 'data') { data = buf.subarray(o + 8, Math.min(buf.length, o + 8 + sz)); break; }
    o += 8 + sz + (sz & 1);
  }
  if (!data) return { dur: 0, onset: 0 };
  const n = data.length >> 1, win = Math.min(n, Math.round(sr * ch * 0.05));
  let e = 0;
  for (let i = 0; i < win; i++) { const v = data.readInt16LE(i * 2); e += v * v; }
  return { dur: n / (sr * ch), onset: Math.sqrt(e / Math.max(1, win)) };
}
function namelessFire(fireKey) {
  if (!/_fire$/.test(fireKey)) return null; // melee _Attack swings do not follow the loud-and-long rule
  const tok = norm(fireKey.replace(/^wm_/, '').replace(/_(dual_)?fire$/, ''));
  if (tok.length < 3) return null;
  // folder == token (HandGun_Colt45: Colt) beats pack-name hit beats a loose folder hit (HandGun: ColtPython)
  const groups = new Map();
  for (const x of nameless) {
    const last = norm(x.rel.split('/').pop());
    const score = last === tok ? 3 : norm(x.pack).endsWith(tok) || norm(x.pack).includes(tok) ? 2
      : last.includes(tok) || (last.length >= 3 && tok.includes(last)) ? 1 : 0;
    if (!score) continue;
    const g = `${x.pack}|${x.rel}`;
    if (!groups.has(g)) groups.set(g, { score, list: [] });
    groups.get(g).list.push(x);
  }
  const top = Math.max(0, ...[...groups.values()].map((g) => g.score));
  let best = null;
  for (const g of groups.values()) if (g.score === top) for (const x of g.list) {
    let buf = x.d.subarray(x.e.offset, x.e.offset + x.e.size);
    if (x.e.attr) buf = decodeContent(buf, x.e.attr) ?? buf;
    const st = wavStats(buf);
    if (st.onset < 8000 || st.dur < 0.6) continue;
    if (!best || st.dur > best.st.dur) best = { x, st };
  }
  return best && { rel: `${best.x.rel}/${fireKey}.wav`, d: best.x.d, e: best.x.e,
    from: `${best.x.pack}:${best.x.rel}#${best.x.e.index} ${best.st.dur.toFixed(2)}s score ${top}` };
}
for (const w of weapons) {
  const k = w.pb?.fireSound && key(w.pb.fireSound);
  if (!k || files.has(k)) continue;
  const hit = namelessFire(k);
  if (hit) { files.set(k, hit); console.log(`nameless fire ${k} <- ${hit.from}`); }
}

// _FireSound names the pef gives that no pack has, while the pack carries the weapon's own clip under another name
// [INFERIDO: same weapon, same pack, only candidate]: OA-93 dual (118xxx) asks WM_OA-93_Dual_Fire, the pack has WM_OA-93_Dual_Attack.
// Without it the 11 OA-93 variants fell to the single OA-93 clip of the class guess.
const FIRE_ALIAS = { 'wm_oa-93_dual_fire': 'wm_oa-93_dual_attack' };
for (const [from, to] of Object.entries(FIRE_ALIAS)) if (!files.has(from) && files.has(to)) files.set(from, files.get(to));

for (const w of weapons) {
  const fire = w.pb?.fireSound && files.has(key(w.pb.fireSound)) ? key(w.pb.fireSound) : undefined;
  const swap = w.pb?.swapSound && files.has(key(w.pb.swapSound)) ? key(w.pb.swapSound) : undefined;
  if (!fire && !swap) continue;
  res.weapons[w.id] = { ...(fire && { fire }), ...(swap && { swap }) };
  if (fire) used.add(fire);
  if (swap) used.add(swap);
}

// terrain sounds by I3_TERRAIN_TYPE (CGameSoundManager defaults at exe 0xbaae40: WM_Hit_<T>_1/2, WM_Knife_Hit_<T>,
// WM_Throw_Bound_<T>, ...): the knife's wall hit and the grenade bounce come from Melee_Common / Throw_Common by name
for (const k of files.keys()) if (/^wm_(knife_hit|throw_bound)(_|$)/.test(k)) used.add(k);
// the heavy (RMB) knife swing WM_<Knife>_Attack_Secondary (audio.ts swing) and the medical kit zone loop WM_MedicKit_Recovery: named in no pef
for (const k of files.keys()) if (/_attack_secondary$|^wm_medickit_recovery$/.test(k)) used.add(k);
// the other _LoadFireSound slots (0x605150) of a _FireSound name: _Muffler (silencer on), "Zoom_Fire" (the last 4 chars of the name replaced:
// WM_AUG_Fire -> WM_AUG_Zoom_Fire; HK417 spells it ...ZoomFire, SMG / PDW "Zoom_Attack") and _3pv (SVU)
for (const k of files.keys()) if (/_fire_muffler$|_zoom_?fire$|_zoom_attack$|_fire_3pv$/.test(k)) used.add(k);
// throwable blasts and the hit-by-explosion clip, by name: WM_K400_Explosion / WM_K400_Explosion_Damage /
// WM_Flash_Explosion_Damage sit in the exe sound tables (0xd5ad3c / 0xd5ac84 / 0xd5ad34); K-413, smoke, WP smoke and C5
// blasts are the sound nodes of their Effect_High explosion effects; WM_Throw_Hold / Take = pin pull / grenade in hand
for (const k of files.keys()) if (/^wm_(k400|k413|flash|smoke|wp_smoke|c5)_explosion|^wm_throw_(hold|take)$|^wm_c5_(stick|count_a)$|^wm_recovery_candy_(boom|throw_bound_\d)$|^wm_k201_explosion$|^wm_m14_explosion$|^wm_waterbomb_fire$/.test(k)) used.add(k);
// WM_C5_Stick / WM_C5_Count_A: exe string table (0x7b4eec / 0x7b4a64); candy bound clips: exe strings WM_Recovery_Candy_Throw_Bound_1..4; Candy_Boom, K201_Explosion
// (Snowman Grenade) and WaterBomb_Fire: the sound nodes of Exp_Gr_CandyGrenade / Exp_Snowman_Grenade / Exp_Water_Bomb

let bytes = 0;
for (const k of [...used].sort()) {
  const { rel, d, e } = files.get(k);
  let buf = d.subarray(e.offset, e.offset + e.size);
  if (e.attr) buf = decodeContent(buf, e.attr) ?? buf;
  const dst = path.join(OUT, '2017', ...rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // Windows keeps the old spelling when a file is overwritten (wm_colt_fire.wav stayed lower case after the name became
  // WM_COLT_Fire.wav), and Vite's public-dir lookup is case sensitive: drop a stale spelling first or the clip 404s.
  for (const n of fs.readdirSync(path.dirname(dst))) if (n !== path.basename(dst) && n.toLowerCase() === path.basename(dst).toLowerCase()) fs.unlinkSync(path.join(path.dirname(dst), n));
  fs.writeFileSync(dst, buf);
  bytes += buf.length;
  res.files[k] = `2017/${rel}`;
}
fs.writeFileSync(path.join(OUT, 'pb2017.json'), JSON.stringify(res, null, 1));
console.log(`pb2017.json: ${Object.keys(res.files).length} wav (${(bytes / 1048576).toFixed(1)} MB), ${Object.keys(res.weapons).length} weapons, ${aiN} weapon AIs with sounds (${aggN} with aggregated-pack events), ${Object.keys(res.ai).length} kept`);

convertWavs(OUT);
