#!/usr/bin/env node
// Kill-mark announce voice lines of the 2017 client (Sound_voice_Announce.i3Pack, named WAVs, PFN3 index decodes).
//
//   node export-announce2017.mjs   # -> out/sfx/announce/2017/*.wav + announce.json
//
// Names come straight off the exe string table (bb6e24.. block, CGameSoundManager::StartAnnounceMessage): only the
// kill/streak-related clips are kept (round start/end, mission, holiday clips stay out of scope for kill marks).
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { convertWavs } from './wav-to-ogg.mjs';
import { fileURLToPath } from 'node:url';
import { decodeContent, parsePack } from './i3pack/unpack.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack');
const OUT = assetPath('sfx', 'announce');

// key = kill-mark id used by src/game/pbHud/killmarks.ts; value = source wav (Sound/voice/Announce/<name>)
const WANTED = {
  kill: 'MV_Ann_Kill.wav',
  headshot: 'MV_Ann_HeadShot.wav',
  piercing: 'MV_Ann_Piercing.wav',
  doubleKill: 'MV_Ann_Double_Kill.wav',
  tripleKill: 'MV_Ann_Triple_Kill.wav',
  massKill: 'MV_Ann_MassKill.wav',
  chainKiller: 'MV_Ann_Chain_Killer.wav',
  chainHeadshot: 'MV_Ann_Chain_HeadShot.wav',
  chainSlugger: 'MV_Ann_Chain_Slugger.wav',
  chainStopper: 'MV_Ann_Chain_Stopper.wav',
  helmetProtection: 'MV_Ann_HelmetProtection.wav',
  revenge: 'UI_HUD_Revenge_Effect.wav',
  // match flow: MISSION START / SUCCESS / GAME OVER banners (kill_message1.i3i), team win calls, pre-start countdown
  missionStart: 'MV_Ann_Start_Mission_1.wav',
  missionStart2: 'MV_Ann_Start_Mission_2.wav',
  missionStart3: 'MV_Ann_Start_Mission_3.wav',
  missionSuccess: 'MV_Ann_Mission_Success.wav',
  gameOver: 'MV_Ann_Mission_Fail.wav',
  redTeamWin: 'MV_Ann_RedTeam_Win.wav',
  blueTeamWin: 'MV_Ann_BlueTeam_Win.wav',
  countdown1: 'UI_Mission_CountDown.wav',
  countdown2: 'UI_Mission_CountDown_2.wav',
  countdown3: 'UI_Mission_CountDown_3.wav',
  // Bomb Mission (exe string table, CGameSoundManager announce block)
  bombPlanted: 'MV_Ann_Bomb_Plated.wav',
  bombExploded: 'MV_Ann_Bomb_Exploded.wav',
  bombRemoved: 'MV_Ann_Bomb_Removed.wav',
};

const f = path.join(PACKS, 'Sound_voice_Announce.i3Pack');
if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }
const d = fs.readFileSync(f);
const { nodes } = parsePack(d);
const node = nodes.find((n) => n.path.replace(/\\/g, '/').toLowerCase() === 'sound/voice/announce');
if (!node || !node.indexOk) { console.error('Sound/voice/Announce node not found or index not decoded'); process.exit(1); }

fs.mkdirSync(path.join(OUT, '2017'), { recursive: true });
const files = {};
let missing = 0;
for (const [id, wav] of Object.entries(WANTED)) {
  const e = node.files.find((x) => x.name.toLowerCase() === wav.toLowerCase());
  if (!e) { console.warn(`not found: ${wav}`); missing++; continue; }
  let buf = d.subarray(e.offset, e.offset + e.size);
  if (e.attr) buf = decodeContent(buf, e.attr) ?? buf;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') { console.warn(`not RIFF: ${wav}`); missing++; continue; }
  fs.writeFileSync(path.join(OUT, '2017', wav), buf);
  files[id] = `2017/${wav}`;
}
fs.writeFileSync(path.join(OUT, 'announce.json'), JSON.stringify({ source: 'PBCross Pack/Sound_voice_Announce.i3Pack', files }, null, 1));
console.log(`announce.json: ${Object.keys(files).length}/${Object.keys(WANTED).length} clips${missing ? ` (${missing} missing)` : ''}`);

convertWavs(OUT);
