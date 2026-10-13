// Audit of every weapon's animation set vs what weaponAnim.ts / WeaponSystem actually ask for.
// Usage: node tools/audit-weapon-anim.mjs [--all]   (default: only problems)
// Catches: states that exist in the pack but stateKey() never resolves (naming mismatch, e.g. LoadBullet_1PV),
// weapons whose fire mode needs a state that is missing, loose meshes that would hang in the air, AI sound events.
import fs from "node:fs";
import { assetPath } from "./lib/paths.mjs";
const R = assetPath("weapons");
const ix = JSON.parse(fs.readFileSync(`${R}/anim/index.json`, "utf8"));
const mi = JSON.parse(fs.readFileSync(`${R}/models/index.json`, "utf8")).weapons;
const wj = JSON.parse(fs.readFileSync(`${R}/weapons.json`, "utf8")).weapons;
const sfx = JSON.parse(fs.readFileSync(`${R}/sfx/pb2017.json`, "utf8"));
const byId = new Map(wj.map((w) => [w.id, w]));

const STATE = { fire: "Fire", reload: "LoadMag", loadBullet: "LoadBullet", change: "Change", idle: "Idle" };
// same candidate order as WeaponAnimator.stateKey (weaponAnim.ts), without the _Ext branch
function stateKey(st, kind, v, g, h = "Right") {
  const s = STATE[kind];
  for (const k of [s + v + g, `${s}${v}_${g}`, `${s}_${g}`, s + v, `${s}_${v}`, `${s}${v}_DualGun_${h}`, s, `${s}_${g}_${v}`, `${s}_${g}_${h}`, `${s}_${h}`]) if (st[k]) return k;
  const L = kind === "reload" ? "B" : kind === "loadBullet" ? "C" : "";
  if (L && st[`LoadMag${L}_${g}`]) return `LoadMag${L}_${g}`;
  return null;
}

const problems = [];
const add = (model, sev, msg) => problems.push({ model, sev, msg });
const glbNodes = (id) => {
  try {
    const b = fs.readFileSync(`${R}/models/${id}.glb`);
    return JSON.parse(b.slice(20, 20 + b.readUInt32LE(12))).nodes.map((n) => n.name);
  } catch { return null; }
};
const hiddenByWorldModel = (n) => n === "Model_Vol" || n === "Vol_AniDummy" || /^Model_VOL\d*$/.test(n) || /_Dummy$/.test(n);

let checked = 0, noAi = 0;
for (const e of mi) {
  const mid = e.id ?? e.file?.replace(/\.glb$/, "");
  const si = ix.models[mid];
  const items = (e.itemIds ?? []).map((i) => byId.get(i)).filter(Boolean);
  const w = items[0];
  if (si === undefined) { noAi++; continue; }
  checked++;
  const set = ix.sets[si], st = set.states;
  const fam = w?.family, mode = w?.fireMode, p = w?.pb ?? {};
  if (fam === "KNIFE" || fam === "GRENADE") continue;

  // 1. orphan states: prefix matches a kind but no candidate resolves to it
  for (const [kind, pre] of Object.entries(STATE)) {
    const names = Object.keys(st).filter((k) => k.startsWith(pre) && !/_Ext/.test(k) && !(pre === "Load" && false));
    const reach = new Set();
    for (const v of ["1PV", "3PV"]) for (const g of ["Male", "Female"]) for (const h of ["Left", "Right"]) { const k = stateKey(st, kind, v, g, h); if (k) reach.add(k); }
    // "LoadMag" prefix also matches LoadMag_Ready etc. (used elsewhere); only flag exact-variant names
    for (const n of names) if (!reach.has(n) && /^(Fire|LoadMag|LoadBullet|Change|Idle)(_?(1PV|3PV|Male|Female)){1,3}$/.test(n)) add(mid, "BUG", `state ${n} unreachable (kind ${kind})`);
  }
  // 2. needs
  const need1 = (kind, why) => { if (!stateKey(st, kind, "1PV", "Male")) add(mid, "MISSING", `${kind} 1PV not resolved (${why}); states: ${Object.keys(st).filter((k) => !/^UI_/.test(k)).join(",")}`); };
  if (fam && fam !== "GRENADE") {
    need1("idle", "all"); need1("fire", "all");
    if ((p.reloadTime ?? 0) > 0 || w?.loadedBullet > 1) need1("reload", `reloadTime ${p.reloadTime}`);
    if (p.needToLoadBullet) need1("loadBullet", `${mode} NeedToLoadBullet`);
  }
  if (p.needToLoadBullet && mode !== "pump" && mode !== "bolt" && fam) add(mid, "INFO", `NeedToLoadBullet but fireMode ${mode} (WeaponSystem runs loadBullet only for pump/bolt)`);
  // 3. loose meshes
  const nodes = glbNodes(mid);
  if (nodes) for (const n of nodes) if (/^Model_Vol/i.test(n) && !hiddenByWorldModel(n)) add(mid, "WARN", `mesh ${n} may hang parked (not handled)`);
  // 4. sounds: states with clips but no AI sound events for the key WeaponSystem asks
  const ev = sfx.ai?.[set.ai];
  if (!ev && fam) add(mid, "SND", `no AI sound events for ${set.ai}`);
  else if (ev) {
    const k = stateKey(st, "reload", "1PV", "Male");
    if (k && !ev[k] && (p.reloadTime ?? 0) > 0) add(mid, "SND", `reload state ${k} has no sound events`);
    const kb = p.needToLoadBullet ? stateKey(st, "loadBullet", "1PV", "Male") : null;
    if (kb && !ev[kb]) add(mid, "SND", `loadBullet state ${kb} has no sound events`);
  }
}

// group identical messages across skins
const groups = new Map();
for (const p of problems) {
  const key = `${p.sev}|${p.msg.replace(/states: .*/, "").replace(/\b\d+\.\d+\b/, "")}`;
  (groups.get(key) ?? groups.set(key, []).get(key)).push(p);
}
console.log(`models with anim set: ${checked}, without: ${noAi}`);
const order = { BUG: 0, MISSING: 1, WARN: 2, SND: 3, INFO: 4 };
for (const [k, l] of [...groups].sort((a, b) => order[a[0].split("|")[0]] - order[b[0].split("|")[0]] || b[1].length - a[1].length)) {
  console.log(`\n[${k.split("|")[0]}] ${l[0].msg.slice(0, 200)}  x${l.length}`);
  console.log("   " + l.slice(0, 12).map((x) => x.model).join(", ") + (l.length > 12 ? ", ..." : ""));
}
console.log(`\n${problems.length} findings`);
