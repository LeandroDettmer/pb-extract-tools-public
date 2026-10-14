#!/usr/bin/env node
// PBCross bot table -> src/game/data/aiCharacter.json (bots.ts aiRowFor: skill level -> one row per AI slot)
//   node export-ai.mjs
// Source: extracted/pef-cross/br/AICharacter.json (pef/export-cross.mjs): AICharacter.Level_<N>.AI_<k> = the bot's values.
// Output: { "<N>": [ { hp, dev, atk, pre, tot, ang, rng, resp }, ... ] }, the AI_<k> rows of each level in k order.
import { extractedPath, generatedPath, rel } from './lib/paths.mjs';
import { readFileSync, writeFileSync } from "node:fs";

const cross = JSON.parse(readFileSync(extractedPath('pef-cross', 'br', 'AICharacter.json'), "utf8")).AICharacter;
const FIELDS = { hp: 'Hp', dev: 'Deviation', atk: 'AttackTime', pre: 'AttackTime_Pre', tot: 'AttackTime_Total', ang: 'SeeSight_Angle', rng: 'SeeSight_Range', resp: 'RespawnTime' };

const out = {};
for (const [levelKey, level] of Object.entries(cross)) {
  const lv = levelKey.match(/^Level_(\d+)$/);
  if (!lv) throw new Error(`unexpected AICharacter key ${levelKey}`);
  const rows = Object.entries(level).filter(([k]) => /^AI_\d+$/.test(k)).sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3)));
  out[lv[1]] = rows.map(([k, ai]) => {
    const row = {};
    for (const [out_, src] of Object.entries(FIELDS)) {
      if (typeof ai[src] !== 'number') throw new Error(`${levelKey}.${k}.${src} is not a number`);
      row[out_] = ai[src];
    }
    return row;
  });
}
if (!Object.keys(out).length) throw new Error('no Level_<N> in AICharacter.json');

const file = generatedPath('game/data/aiCharacter.json');
writeFileSync(file, JSON.stringify(out));
console.log(`aiCharacter.json: ${Object.keys(out).length} levels (${Object.values(out).map((r) => r.length).join(',')} rows) -> ${rel(file)}`);
