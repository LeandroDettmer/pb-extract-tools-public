#!/usr/bin/env node
// Scenes (.i3UIs layouts) -> out/ui/scenes/<ver>/<Scene>.json + scenes/index.json
//
//   node ui-export/ui-scenes.mjs [v12 v11 kaybo cross]
//
// v12  : PointBlank 3.123 Pack/UI_V12.i3Pack (237 scenes, real names via tools/i3pack/unpack.mjs)
// v11  : Pack/UI_V11.i3Pack is empty in 3.123 (313 bytes) -> no scenes, only templates/atlases
// kaybo: PBKaybo Pack/UI_Re2.i3Pack (187) + loose UI_Temp/*.i3UIs (12)
// cross: PBCross loose UI_Temp/*.i3UIs (13: PBRe_ForceExitVote, _Result, GhostMode, PopUp_Report...), templates UI_Temp/PBRe.i3Uil
//
// Each scene JSON (format "pb-ui-scene/1") carries the controls in object order plus the templates it
// uses (resolved by MD5(UPPER(name)) against the same version's template set), so a screen needs a single
// fetch. Captions are the design-time texts stored in the file (runtime labels come from String_Brazil.lua).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS, OUT, iterFiles, loadTemplates, md5Upper, parseScene, writeJSON } from './lib.mjs';

function collectImages(t, set) {
  if (!t) return;
  for (const s of t.shapes) if (s.img) set.add(s.img);
  for (const c of t.sub || []) collectImages(c, set);
}

// PointBlankRe_Lobby_RoomList.lua InitListBox: column 2 lock, 3 mode card (60x21, level_icon), 4 mode tag (29x18), 7 ping, 8 state icon
const SCRIPT_TEMPLATES = {
  PointBlankRe_Lobby_RoomList: ['ButtonImageSet_Lock', 'ButtonImageSet_GameMode_2', 'ButtonImageSet_GameMode', 'ButtonImageSet_Ping_B', 'BtImgSet_LobbyIcon'],
  // the 10-card row of the Missão tab takes the card set's own template (exe CQuestManager::GetTemplateName, table filled by
  // _add_template_name_List 0x58d080: set 1 -> Card1_hs ... 13 -> Event_Mission_Card); the scene only binds Card10_hs
  PointBlankRe_MyInfomation_MissionCard: [...Array.from({ length: 18 }, (_, i) => `ButtonImageSet_Item_Card${i + 1}_hs`), 'Event_Mission_Card'],
  // PointBlankRe_ReadyRoom_TeamSelect.lua _InitListBox: cells 4 / 5 = slot badges (READY, SHOP, INVEN, PLAY... UIPhaseReadyRoom 0x8f1810)
  PointBlankRe_ReadyRoom_TeamSelect: ['ButtonImageSet_Ready'],
};

export function exportScenes(ver) {
  const T = loadTemplates(ver);
  const byHash = new Map([...T.keys()].map(n => [md5Upper(n), n]));
  const index = [];
  const seen = new Map();
  for (const f of iterFiles(ver, 'scene', /\.i3UIs$/i)) {
    let s;
    try { s = parseScene(f.buf); } catch (e) { index.push({ file: f.path, error: e.message }); continue; }
    const stem = f.name.replace(/\.i3UIs$/i, '');
    const n = seen.get(stem.toLowerCase()) || 0;
    seen.set(stem.toLowerCase(), n + 1);
    const key = n ? `${stem}~${n}` : stem;
    const templates = {}, images = new Set();
    let unresolved = 0;
    for (const c of s.controls) {
      if (!c.tplHash) continue;
      const name = byHash.get(c.tplHash);
      if (!name) { unresolved++; c.template = null; continue; }
      c.template = name;
      if (!templates[name]) { const { src, ...t } = T.get(name); templates[name] = t; collectImages(t, images); }
    }
    // templates a scene's Lua script picks at run time (ListView setTemplateName), not bound to any control
    for (const name of SCRIPT_TEMPLATES[stem] || []) {
      if (templates[name] || !T.get(name)) continue;
      const { src, ...t } = T.get(name); templates[name] = t; collectImages(t, images);
    }
    const out = {
      format: 'pb-ui-scene/1', version: ver, name: key, sceneName: s.name, source: f.path,
      design: s.design, script: s.script, unresolvedTemplates: unresolved,
      images: [...images].sort(), controls: s.controls, templates,
    };
    const file = path.join(OUT, 'scenes', ver, `${key}.json`);
    writeJSON(file, out);
    index.push({ name: key, file: `scenes/${ver}/${key}.json`, source: f.path, controls: s.controls.length, unresolvedTemplates: unresolved, images: out.images.length });
  }
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const vers = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VERSIONS);
  const all = {};
  for (const v of vers) {
    all[v] = exportScenes(v);
    const unr = all[v].reduce((a, s) => a + (s.unresolvedTemplates || 0), 0);
    console.log(`${v}: ${all[v].length} scenes (${unr} controls with unresolved template)`);
  }
  const idxFile = path.join(OUT, 'scenes', 'index.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(idxFile, 'utf8')).versions || {}; } catch { prev = {}; }
  writeJSON(idxFile, { format: 'pb-ui-scene-index/1', versions: { ...prev, ...all } });
}
