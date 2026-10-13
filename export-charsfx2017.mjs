#!/usr/bin/env node
// Character / object / UI sounds of the 2017 client, by real name -> out/sfx/char/<name>.wav.
//
//   node export-charsfx2017.mjs
//
// These packs decode with real WAV names (unlike the 3.123 weapon packs). The game plays them by name:
//   - Footsteps / jump / land: Sound_Character_FootStep.i3Pack (CH_<Terrain>_Left/Right_1/2, CH_<Terrain>_Jump/JumpEnd)
//   - Hit grunt / critical: Sound_Character_Action.i3Pack (CH_Head_Hit_1/2, CH_Critical_Male/Female)
//   - Death / downfall / heartbeat / zoom breath: Sound_voice_Man.i3Pack (MV_Hit_Death, MV_Hit_Downfall, MV_Heart_Beat, MV_Zoom_Breath)
//   - ...and Sound_voice_Woman.i3Pack (WV_ = the same three MINUS the heartbeat: the female pack has NO
//     WV_Heart_Beat, so the concussion loop is shared by both genders — the only voice pair the client does not
//     gender-split. WV_ prefix = female, same convention the radio voices already use (docs/FIDELITY.md)).
//   - Helmet bounce: Sound_Object_Helmet.i3Pack (OB_Helmet_Bound_<Terrain>)
//   - Team win: Sound_voice_Announce.i3Pack (MV_Ann_BlueTeam_Win/RedTeam_Win)
//   - UI: Sound_Interface.i3Pack + Sound_UI.i3Pack (UI_Button_Click_*, UI_Mouse_Over, UI_PopUp_*, UI_MOUSE_CLICK, ...)
//   - Lobby BGM: Sound_UI.i3Pack (PB_BGM_NO*.ogg)
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { convertWavs } from './wav-to-ogg.mjs';
import { fileURLToPath } from 'node:url';
import { carve, decodeContent, parsePack } from './i3pack/unpack.mjs';

const PACKS = clientPath(baseClient('cross'), 'Pack');
const OUT = assetPath('sfx', 'char');

// pack -> regex of file names to keep (null = every file)
const WANT = [
  ['Sound_Character_FootStep.i3Pack', null],
  ['Sound_Character_Action.i3Pack', /^(CH_Head_Hit|CH_Critical)/i],
  ['Sound_voice_Man.i3Pack', null],
  ['Sound_voice_Woman.i3Pack', null],
  ['Sound_Object_Helmet.i3Pack', /^(OB_Helmet_|OB_Beanie_)/i],
  ['Sound_voice_Announce.i3Pack', /Team_Win\.wav$/i],
  ['Sound_Interface.i3Pack', null],
  ['Sound_UI.i3Pack', /^(UI_|PB_BGM)/i],
];

fs.mkdirSync(OUT, { recursive: true });
let n = 0, bytes = 0;
const index = {};
for (const [pack, re] of WANT) {
  const p = path.join(PACKS, pack);
  if (!fs.existsSync(p)) { console.warn('missing', pack); continue; }
  const d = fs.readFileSync(p);
  let nodes;
  try { ({ nodes } = parsePack(d)); } catch (e) { console.warn(pack, 'parse fail', e.message); continue; }
  for (const node of nodes) {
    const names = node.files ?? [];
    if (!names.length) continue;
    // OLD-format packs: parseEntry did not recover offset/size, carve the payload region and zip by index
    const carved = node.indexOk ? names : carve(d, node).files;
    const count = Math.min(names.length, carved.length);
    for (let i = 0; i < count; i++) {
      const nm = names[i].name;
      if (!/\.(wav|ogg)$/i.test(nm)) continue;
      if (re && !re.test(nm)) continue;
      const src = node.indexOk ? names[i] : carved[i];
      const attr = names[i].attr ?? src.attr ?? 0;
      let buf = d.subarray(src.offset, src.offset + src.size);
      if (attr) buf = decodeContent(buf, attr) ?? buf;
      const dst = path.join(OUT, nm);
      fs.writeFileSync(dst, buf);
      index[nm.replace(/\.(wav|ogg)$/i, '').toLowerCase()] = `char/${nm}`;
      n++; bytes += buf.length;
    }
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'),
  JSON.stringify({ source: 'PBCross Pack/Sound_Character_*/Sound_voice_*/Sound_Object_Helmet/Sound_Interface/Sound_UI', files: index }, null, 1));
console.log(`voices: ${Object.keys(index).filter((k) => /^[mw]v_/.test(k)).sort().join(', ')}`);
console.log(`char sfx: ${n} files (${(bytes / 1048576).toFixed(1)} MB) -> ${OUT}`);

convertWavs(OUT);
