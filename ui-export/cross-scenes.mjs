#!/usr/bin/env node
// Point Blank Cross UI_Temp scenes with their art -> ui/scenes/cross/<Scene>.json + ui/atlas/cross/<Scene>.{png,json}.
//   pbx ui cross-scenes
// The 13 loose UI_Temp/*.i3UIs of PBCross (PBRe_ForceExitVote + _Result = the in-battle vote HUD,
// GhostMode, PopUp_Report...), templates UI_Temp/PBRe.i3Uil, pixels UI_Temp/PBRe.i3VTex. Same formats as `ui scenes` / `ui atlas`
// (pb-ui-scene/1, pb-ui-sheet/1), Cross client only.
import { exportScenes } from './ui-scenes.mjs';
import { buildSheet } from './ui-atlas.mjs';

const scenes = exportScenes('cross');
for (const s of scenes) {
  if (s.error) { console.log(`${s.file}: ${s.error}`); continue; }
  const r = await buildSheet('cross', s.name);
  console.log(`${r.sheet}: ${r.w}x${r.h} frames=${r.frames} packed=${r.packed} missing=${r.missing}`);
}
if (!scenes.some((s) => s.name === 'PBRe_ForceExitVote')) throw new Error('UI_Temp/PBRe_ForceExitVote.i3UIs not exported');
