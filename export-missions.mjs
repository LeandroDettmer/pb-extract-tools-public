// Mission card sets of the Perfil / Missão tab -> src/lobby/core/missionData.ts
//   node export-missions.mjs
// Sources:
//  - extracted/pef-cross/br/Quest.json (pef/export-cross.mjs; Quest.pef CardSet: CardSetId, CardBuyPoint, TotalExp, Bonus*).
//  - Clients/PBCross/Pack/String.i3Pack Brazil/Quest_Brazil.txt: Quest\CardSet\<key>\CardSetName = the set's name.
//  - server/runtime/Data/Missions/*.mqf: the files server-ts loads (shared/data.ts MISSION_FILES / loadMissionCards), so the
//    tasks shown are the ones the server counts. Layout (= C# MissionCardRAW, chosen by u32@4 questType, not by file size):
//      header 24 B: u32 'qf' (0x6671), i32 questType, 16 B
//      40 tasks (10 cards x 4): u16 reqType, u8 missionType, u8 map, u8 limit, u8 weaponClass, u16 weaponNumber (8 B)
//        questType 1: + 24 B per task (unknown, skipped)
//      10 card prizes: i32 gold, i32 exp, i32 badge, then 16 B per item (questType 1: 1 item, questType 2: 5 items)
//      questType 2: 12 B + 5 set items (16 B) [+ 92 B tail]; five questType-2 files are 1584 B (Commissioned_o, Company_o,
//      DefconCard, Dino_Basic, Dino_Intensify): only the first 1356 B are read, like the C#.
//    questType 1 stores exp / 10 (server-ts and the C# multiply by 10; Infiltration 16..25 x 10 sums to TotalExp 2050).
//  - PointBlank.exe 2017: CQuestManager template table (_add_template_name_List calls, 0x58d080): set -> card row template
//    (ButtonImageSet_Item_Card<N>_hs) and its shape in ButtonImageSet_Item_Card_hs (GetTemplateIndex 0x58d570, BuyNow image).
//  - final prize items of the Info+ popup (UIPopupMissionCardInfo): CQuestTextDictionary::Create 0x9bc8e0 keeps Quest.pef
//    BonusItemID + BonusItemID_2.._4 per set (count = the non-zero ones); the popup shows one at a time
//    (GetCardSetBonusItemID 0x9bd150). The .mqf item blocks are not read by it. Each 2017 ItemID is resolved to
//    the web item id (icon) and the client's name (PBCross Pack/String.i3Pack Weapon_Brazil / Equipment_Brazil "<pef path>\_Name",
//    what usf::GetItemName 0x809670 shows): type = id / 100000000 (0x80a360: 1-9 weapon, 10-11 character / part); weapon class = id % 1000000 / 1000,
//    number = id % 1000 (0x808f20); part kind = id % 100000000 / 1000000, number (pef _Type) = id % 1000
//    (CharaInfoDataBase 0x69fbc0: 2 head, 3 beret, 4 / 5 the lists at +0x80 / +0x8c).
import { assetPath, generatedPath, pefDir, serverPath, webPath } from './lib/paths.mjs';
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStringTable } from "./ui-export/ui-strings.mjs";

const quest = JSON.parse(readFileSync(pefDir('br', 'Quest.json'), "utf8")).Quest;
const MQF_DIR = serverPath('runtime', 'Data', 'Missions');
const equipPef = JSON.parse(readFileSync(pefDir('br', 'Equipment.json'), "utf8")).Equipment;
const clientItems = JSON.parse(readFileSync(assetPath('ui', 'strings', 'items.pt-BR.json'), "utf8"));
const equipIndex = JSON.parse(readFileSync(assetPath('equip', 'index.json'), "utf8"));
const serverNames = JSON.parse(readFileSync(webPath("src/lobby/state/data/itemNames.json"), "utf8")).names;

// server-ts shared/data.ts MISSION_FILES (file -> CardSetId)
const MISSION_FILES = {
  TutorialCard_Russia: 1, Dino_Tutorial: 2, Human_Tutorial: 3, AssaultCard: 5, BackUpCard: 6, InfiltrationCard: 7, SpecialCard: 8,
  DefconCard: 9, Commissioned_o: 10, Company_o: 11, Field_o: 12, EventCard: 13, Dino_Basic: 14, Human_Basic: 15, Dino_Intensify: 16,
  Human_Intensify: 17,
};
// exe 0x58d080: setId -> [card row template, shape of ButtonImageSet_Item_Card_hs]
const TEMPLATES = {
  0: ["ButtonImageSet_Item_Card1_hs", 0], 1: ["ButtonImageSet_Item_Card1_hs", 0], 4: ["ButtonImageSet_Item_Card2_hs", 1],
  5: ["ButtonImageSet_Item_Card3_hs", 2], 6: ["ButtonImageSet_Item_Card4_hs", 3], 7: ["ButtonImageSet_Item_Card5_hs", 4],
  8: ["ButtonImageSet_Item_Card6_hs", 5], 9: ["ButtonImageSet_Item_Card7_hs", 6], 10: ["ButtonImageSet_Item_Card8_hs", 7],
  11: ["ButtonImageSet_Item_Card9_hs", 8], 12: ["ButtonImageSet_Item_Card10_hs", 9], 13: ["Event_Mission_Card", 18],
  2: ["ButtonImageSet_Item_Card13_hs", 12], 3: ["ButtonImageSet_Item_Card14_hs", 13], 14: ["ButtonImageSet_Item_Card16_hs", 15],
  15: ["ButtonImageSet_Item_Card15_hs", 14], 16: ["ButtonImageSet_Item_Card18_hs", 17], 17: ["ButtonImageSet_Item_Card17_hs", 16],
};

/** one .mqf -> { questType, tasks[40], cards[10] } */
function readMqf(file) {
  const b = readFileSync(file);
  if (b.readUInt16LE(0) !== 0x6671) throw new Error(`${file}: no 'qf' magic`);
  const questType = b.readInt32LE(4);
  if (questType !== 1 && questType !== 2) throw new Error(`${file}: questType ${questType}`);
  let o = 24;
  const tasks = [];
  for (let i = 0; i < 40; i++) {
    tasks.push([b.readUInt16LE(o), b[o + 2], b[o + 3], b[o + 4], b[o + 5], b.readUInt16LE(o + 6)]);
    o += 8 + (questType === 1 ? 24 : 0);
  }
  const per = questType === 2 ? 5 : 1, cards = [];
  for (let c = 0; c < 10; c++) {
    const gold = b.readInt32LE(o), exp = b.readInt32LE(o + 4), badge = b.readInt32LE(o + 8);
    cards.push({ tasks: tasks.slice(c * 4, c * 4 + 4), gold, exp: questType === 1 ? exp * 10 : exp, badge });
    o += 12 + per * 16;
  }
  if (o > (questType === 2 ? 1356 : b.length)) throw new Error(`${file}: prizes end at ${o}`);
  return { questType, tasks, cards, size: b.length };
}

// PBCross names: Weapon_Brazil / Equipment_Brazil ("<pef path>\_Name") and Quest_Brazil (Quest\CardSet\<key>\CardSetName)
const names = new Map([...readStringTable("Weapon_Brazil.txt"), ...readStringTable("Equipment_Brazil.txt")]);
const setNames = readStringTable("Quest_Brazil.txt");
// part kind (0x69fbc0) -> Equipment.pef category. 4 / 5 are the CharaInfoDataBase lists after head / beret (+0x80, +0x8c),
// taken as Mask / Event [INFERIDO: no name in the exe; Dino_Skull (Mask 71) / Bicorne_Hat (Event 12) are the dino / event sets' prizes]
const PART_CAT = { 2: "Head", 3: "Beret", 4: "Mask", 5: "Event" };

/** 2017 ItemID -> { id, webId (0 = none), name (PBCross String.i3Pack) } */
function prizeItem(id) {
  const type = Math.floor(id / 1e8);
  if (type >= 1 && type <= 9) {
    const cn = id % 1e6, hits = Object.keys(clientItems).map(Number).filter((w) => w < 600000 && w % 100000 === cn);
    if (hits.length !== 1) throw new Error(`prize ${id}: weapon ${cn} -> ${hits.length} web ids`);
    const webId = hits[0], name = names.get(`${clientItems[webId].key}\\_Name`) || clientItems[webId].name;
    return { id, webId, name };
  }
  const cat = type === 11 ? PART_CAT[Math.floor((id % 1e8) / 1e6)] : undefined;
  const pefKey = cat && Object.entries(equipPef[cat] ?? {}).find(([, e]) => e._Type === id % 1000)?.[0];
  if (!pefKey) throw new Error(`prize ${id}: no PBCross part`);
  const name = names.get(`Equipment\\${cat}\\${pefKey}\\_Name`) ?? "";
  // web id: out/equip/index.json (Cross Equipment key <-> pef name), else the one server part named A_*_<first word>
  let webId = Number(Object.entries(equipIndex.items).find(([, v]) => equipIndex.entries[v.key]?.pef === pefKey && equipIndex.entries[v.key]?.cat === cat)?.[0] ?? 0);
  if (!webId) {
    const word = pefKey.split("_")[0], re = new RegExp(`^A_[A-Z]_(?:[A-Z]+_)?${word}$`, "i");
    const hits = Object.entries(serverNames).filter(([k, v]) => +k >= 700000 && +k < 900000 && re.test(v[0]));
    if (hits.length === 1) webId = Number(hits[0][0]);
  }
  if (!name) throw new Error(`prize ${id}: ${cat}\\${pefKey} has no name`);
  return { id, webId, name };
}

const sets = [];
for (const [key, s] of Object.entries(quest.CardSet)) {
  const id = s.CardSetId;
  const file = Object.keys(MISSION_FILES).find((f) => MISSION_FILES[f] === id);
  if (!file || !existsSync(join(MQF_DIR, `${file}.mqf`))) throw new Error(`set ${id} (${key}): no server .mqf`);
  const m = readMqf(join(MQF_DIR, `${file}.mqf`));
  const name = setNames.get(`Quest\\CardSet\\${key}\\CardSetName`) ?? "";
  const slots = [s.BonusItemID, s.BonusItemID_2, s.BonusItemID_3, s.BonusItemID_4].map((x) => x ?? 0);
  const bonusItems = slots.filter((x) => x > 0);
  // 0x9bc8e0: slot i keeps its own key, count = the non-zero ones; 0x9bd150 reads slots 0..count-1 (a 0 there hides the item box)
  const prizes = slots.slice(0, bonusItems.length).map((x) => (x ? prizeItem(x) : { id: 0, webId: 0, name: "" }));
  const [tpl, cover] = TEMPLATES[id] ?? TEMPLATES[0];
  const exp = m.cards.reduce((a, c) => a + c.exp, 0);
  if (exp !== s.TotalExp) console.warn(`set ${id} ${key}: card exp ${exp} != TotalExp ${s.TotalExp}`);
  sets.push({
    id, key, name, price: s.CardBuyPoint ?? 0, totalExp: s.TotalExp ?? 0, totalPoint: s.TotalPoint ?? 0, bonusExp: s.BonusExp ?? 0,
    bonusPoint: s.BonusPoint ?? 0, bonusMaster: s.BonusBadgeMaster ?? 0, bonusItems, prizes, file, questType: m.questType, tpl, cover, cards: m.cards,
  });
}
sets.sort((a, b) => a.id - b.id);
if (sets.length !== 16) throw new Error(`expected 16 card sets, got ${sets.length}`);

const card = (c) => `{ gold: ${c.gold}, exp: ${c.exp}, badge: ${c.badge}, tasks: [${c.tasks.map((t) => `[${t.join(", ")}]`).join(", ")}] }`;
const out = `// GENERATED by tools/export-missions.mjs (do not edit). Mission card sets of the Perfil / Missão tab.
// id = CardSetId (Quest.pef; the wire id of 2364 / the 89-byte questing block); price / totals / bonus = Quest.pef CardSet;
// name = PBCross Quest_Brazil CardSetName ("" = none);
// cards = the server's .mqf (server/runtime/Data/Missions, file = its name): tasks [reqType, missionType, map, limit, weaponClass,
// weaponNumber] (reqType: 1 CQuestBase_Map_Count_Accm_Team, 2 _Weapon_Accm, 3 _Weapon_Cont, exe factory 0x589790), gold / exp of
// the finished card (exp already x10 for questType 1, as the server pays it), badge 1-50 ribbon, 51-100 ensign, 101-116 medal;
// tpl / cover = exe template table 0x58d080 (card row template, BuyNow shape of ButtonImageSet_Item_Card_hs);
// prizes = the Info+ popup's final items (Quest.pef BonusItemID.._4, CQuestTextDictionary 0x9bc8e0): 2017 ItemID, web item id
// (icon; 0 = none) and the PBCross name (String.i3Pack).
export type MissionTaskDef = readonly [req: number, type: number, map: number, limit: number, weaponClass: number, weaponNumber: number];
export interface MissionCardDef { gold: number; exp: number; badge: number; tasks: readonly MissionTaskDef[] }
export interface MissionPrizeDef { id: number; webId: number; name: string }
export interface MissionSetDef {
  id: number; key: string; name: string; price: number; totalExp: number; totalPoint: number; bonusExp: number; bonusPoint: number;
  bonusMaster: number; bonusItems: number[]; prizes: readonly MissionPrizeDef[]; file: string; questType: number; tpl: string; cover: number;
  cards: readonly MissionCardDef[];
}
export const MISSION_SETS: readonly MissionSetDef[] = [
${sets.map((s) => `  {
    id: ${s.id}, key: ${JSON.stringify(s.key)}, name: ${JSON.stringify(s.name)}, price: ${s.price}, totalExp: ${s.totalExp}, totalPoint: ${s.totalPoint}, bonusExp: ${s.bonusExp}, bonusPoint: ${s.bonusPoint},
    bonusMaster: ${s.bonusMaster}, bonusItems: [${s.bonusItems.join(", ")}], file: ${JSON.stringify(s.file)}, questType: ${s.questType}, tpl: ${JSON.stringify(s.tpl)}, cover: ${s.cover},
    prizes: [${s.prizes.map((p) => `{ id: ${p.id}, webId: ${p.webId}, name: ${JSON.stringify(p.name)} }`).join(", ")}],
    cards: [
${s.cards.map((c) => `      ${card(c)},`).join("\n")}
    ],
  },`).join("\n")}
];
`;
writeFileSync(generatedPath("lobby/core/missionData.ts"), out);
console.log(`missionData.ts: ${sets.length} sets: ${sets.map((s) => `${s.id} ${s.key} q${s.questType} "${s.name}"`).join(", ")}`);
console.log(`prizes: ${sets.filter((s) => s.prizes.length).map((s) => `${s.id} ${s.prizes.map((p) => `${p.id}->${p.webId} "${p.name}"`).join(" + ")}`).join(", ")}`);
