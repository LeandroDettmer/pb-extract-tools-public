// Server.Match static data -> src/host/data/matchData.json for the P2P match core (src/host/matchCore.ts).
//   node tools/match-data.mjs [server/runtime/Data/Match]
// Reads the same two files Server.Match loads (CharaStructureXML / MapStructureXML): CharaHealth.xml (character HP)
// and MapStructure.xml (per map: destroyable/animated objects, bomb spots). Attribute names as the XML loaders read them.
// Plus the anti-cheat tables (itemStats, weaponGroup, propBlast) from out, see below.
import { assetPath, generatedPath, serverPath, webPath } from './lib/paths.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] ?? serverPath('runtime', 'Data', 'Match'));
const out = generatedPath("host/data/matchData.json");

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
// XmlDocument ignores the ";comment" text between tags; so do we (it never contains a real element here)
const strip = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");

const charaHp = {};
for (const m of strip(readFileSync(resolve(src, "CharaHealth.xml"), "utf8")).matchAll(/<Chara\b([^>]*)\/?>/g)) {
  const a = attrs(m[1]);
  if (a.Id !== undefined && a.HP !== undefined) charaHp[a.Id] = Number(a.HP);
}

const maps = {};
const mapXml = strip(readFileSync(resolve(src, "MapStructure.xml"), "utf8"));
for (const m of mapXml.matchAll(/<Map\b([^>]*)>([\s\S]*?)<\/Map>/g)) {
  const id = attrs(m[1]).Id;
  const body = m[2];
  const bombs = [...body.matchAll(/<Bomb\b([^>]*)\/>/g)].map((b) => { const a = attrs(b[1]); return [Number(a.X), Number(a.Y), Number(a.Z)]; });
  const objects = [];
  // <Obj .../> or <Obj ...> <Anims><Sync/></Anims> <DestroyEffects><Effect/></DestroyEffects> </Obj>
  for (const o of body.matchAll(/<Obj\b([^>]*?)(\/>|>([\s\S]*?)<\/Obj>)/g)) {
    const a = attrs(o[1]);
    const inner = o[3] ?? "";
    const obj = { id: Number(a.Id), life: Number(a.Life), animation: Number(a.Animation), needSync: a.NeedSync === "true" };
    const anims = [...inner.matchAll(/<Sync\b([^>]*)\/>/g)].map((s) => {
      const x = attrs(s[1]);
      return { id: Number(x.Id), duration: Number(x.Date), next: Number(x.Next), otherObj: Number(x.OtherOBJ), otherAnim: Number(x.OtherANIM) };
    });
    const effects = [...inner.matchAll(/<Effect\b([^>]*)\/>/g)].map((e) => { const x = attrs(e[1]); return { id: Number(x.Id), life: Number(x.Percent) }; });
    if (anims.length) obj.anims = anims;
    if (effects.length) obj.effects = effects;
    objects.push(obj);
  }
  maps[id] = { objects, bombs };
}

// ---- P2P-3 anti-cheat (docs/SECURITY.md, docs/P2P.md "Anti-cheat no núcleo"): what matchCore checks a hit against.
// The Worker fetches no assets, so the per-weapon numbers come from out/weapons/weapons.json (ItemStatistics.xml
// ids + the pef the client plays with) and the map props. Without the assets the previous tables are kept.
const assets = assetPath();
const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
let itemStats = prev.itemStats ?? {}, weaponGroup = prev.weaponGroup ?? {}, propBlast = prev.propBlast ?? {};
let defaultLoadout = prev.defaultLoadout ?? {};
const weaponsJson = resolve(assets, "cross/weapons/weapons.json");
if (existsSync(weaponsJson)) {
  itemStats = {};
  weaponGroup = {};
  const json = JSON.parse(readFileSync(weaponsJson, "utf8"));
  const weapons = json.weapons;
  // what WeaponSystem.setLoadout puts in a slot the RESPAWN left at 0 (and the knife a spent Ballistic Knife becomes)
  const d = json.defaultLoadout ?? {};
  defaultLoadout = { primary: d.primary, secondary: d.secondary, melee: d.melee, explosive: d.grenade };
  // the client sends a hit's weapon by NAME (src/net/battle.ts weaponIdOfName): WEAPON_IDS first, then the FIRST weapons.json
  // id with that name; the core matches a hit to the slot's own item through the same name group
  const groupByName = new Map();
  for (const w of weapons) if (!groupByName.has(w.name)) groupByName.set(w.name, w.id);
  for (const w of weapons) {
    const pb = w.pb ?? {}, m = pb.melee ?? {};
    const melee = w.fireMode === "melee", thrown = w.fireMode === "throw";
    const blast = /GrenadeShell|RocketLauncher/.test(w.className) || /GrenadeLauncher|ThrowShell/.test(pb.extType ?? "");
    // highest base a hit of this item can carry (WeaponSystem.bulletDamage: pef Damage, or AttackDamageA1/A2/B1/B2 for a blade)
    const damageMax = Math.max(w.damage, pb.damage ?? 0, pb.damageMax ?? 0, ...(melee ? [m.damageA1, m.damageA2, m.damageB1, m.damageB2].map((x) => x ?? 0) : []));
    // shortest time between two shots / swings / throws (WeaponSystem updateGun / updateMelee / startThrow). Bolt / pump
    // LoadBulletTime is left out: a weapon swap drops it (0xa1383c)
    const fireDelay = melee
      ? Math.min(Math.max(w.fireDelay, m.timeA1 ?? 0.1), Math.max(m.fireDelay2 ?? 1, m.timeB1 ?? ((m.timeB2 ?? 0) > 0 ? m.timeB2 : 0.3)))
      : w.fireDelay;
    // most hits one shot lands on one victim: pellets x guns (DualSMG fires both), the 2nd blade of a swing, the head + body
    // lines of a blast (x every round a throwable can have out, C5 / K-413 / extra grenade)
    const hits = melee ? ((m.timeA2 ?? 0) > 0 || (m.timeB2 ?? 0) > 0 ? 2 : 1)
      : thrown ? 2 * (Math.max(1, w.loadedBullet ?? 1) + 1)
      : Math.max(1, pb.fireBulletCount ?? 1) * (w.className === "DualSMG" ? 2 : 1) * (blast ? 2 : 1);
    const s = { damage: w.damage, range: Math.max(w.range, pb.range ?? 0), fireDelay: Math.round(fireDelay * 1e4) / 1e4 };
    if (damageMax !== w.damage) s.damageMax = damageMax;
    if (hits !== 1) s.hits = hits;
    if (w.className === "Sniper" || thrown || blast) s.multi = true; // a sniper bullet goes through every character on its line
    if (w.className === "Mission") s.mission = true;
    // Extension2 "Dual": the extension key swaps the item in hand for its dual one and back (WeaponSystem.toggleDual)
    if (pb.dualId ?? pb.dualOf) s.alt = pb.dualId ?? pb.dualOf;
    itemStats[w.id] = s;
    if (groupByName.get(w.name) !== w.id) weaponGroup[w.id] = groupByName.get(w.name);
  }
  const battle = readFileSync(webPath("src/net/battle.ts"), "utf8");
  for (const [, name, id] of (/WEAPON_IDS[^{]*\{([^}]*)\}/.exec(battle)?.[1] ?? "").matchAll(/"([^"]+)":\s*(\d+)/g)) {
    if (groupByName.has(name)) weaponGroup[id] = groupByName.get(name);
  }
  // breakable props that explode (car / drum, i3ActionExplosion): the web sends their blast as a hit of the breaker's weapon
  // (game.ts propExplosionHurt), so a record that breaks a prop may carry up to this much damage per hit
  propBlast = {};
  for (const map of JSON.parse(readFileSync(resolve(assets, "maps/index.json"), "utf8"))) {
    const props = resolve(assets, "maps", map.id, "props.json");
    if (map.mapId == null || !existsSync(props)) continue;
    const max = Math.max(0, ...Object.values(JSON.parse(readFileSync(props, "utf8")).objects ?? {}).map((o) => o.explosion?.damage ?? 0));
    if (max > 0) propBlast[map.mapId] = Math.max(propBlast[map.mapId] ?? 0, max);
  }
} else console.warn(`${weaponsJson} not found: itemStats / weaponGroup / propBlast kept from the previous ${out}`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ charaHp, maps, itemStats, weaponGroup, propBlast, defaultLoadout }));
console.log(`${out}: ${Object.keys(charaHp).length} charas, ${Object.keys(maps).length} maps, ${Object.values(maps).reduce((n, m) => n + m.objects.length, 0)} objects, ${Object.keys(itemStats).length} item stats, ${Object.keys(weaponGroup).length} weapon aliases, ${Object.keys(propBlast).length} maps with exploding props`);
