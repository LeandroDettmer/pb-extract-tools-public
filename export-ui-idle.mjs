#!/usr/bin/env node
// Lobby/inventory showroom idle clips (3PV <weapon>/UI/UI_IdleA + UI_IdleB) of each character FAMILY, pure Node ESM.
//
//   node export-ui-idle.mjs [family ...]     # -> out/chars/<family>/ui_idle/<weapon folder>.glb
//
// Every character family has its own UI clips in the original clients (REBEL_Female(ViperRed) parks the weapon on her
// back and turns sideways, SWAT_Female holds it low at the hip, SWAT_Male across the chest...). 3.123 dropped these
// families' packs; EpicBlackout (2014) and Kaybo 2017 still carry them. One small GLB per weapon folder (fetched on demand), clips named by the lower-cased key
// "<weapon folder>/ui/ui_idlea" (path under Chara/<Folder>/3PV/), the same key src/lobby/screens/preview3d.ts derives
// from the swat_male / swat_female anim3pv index. Bone names = the shared 63-bone skeleton.
import { assetPath, clientPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAnimPack } from './i3r2/skin-anim.mjs';
import { GLB, readGLB } from './i3r2/skin-glb.mjs';
import { addClips } from './export-anim.mjs';

const ASSETS = assetPath();
/** clients, best first for the lobby: the oldest that has the family (Epic 2014, then Kaybo 2017) */
const CLIENTS = [clientPath('blackout'), clientPath('kaybo')];
/** assets/chars/<family> -> Chara/<Folder> of the original clients (src/lobby/screens/preview3d.ts uiFamilyOf keeps the skins -> family map) */
const FAMILIES = {
  rebel_viperred: 'REBEL_Female(ViperRed)', rebel_female: 'REBEL_Female', rebel_male: 'REBEL_Male',
  hide: 'Hide', leopard: 'Leopard', d_fox: 'D-Fox',
};
/** weapon folder key -> file name (same rule as src/lobby/screens/preview3d.ts) */
const uiFile = (folder) => folder.replace(/[^a-z0-9_.-]/g, '_');
const UI_RE = /3pv\/(.+\/ui\/ui_idle[ab])\.i3a$/i;

function build(family, folder) {
  const clips = new Map(); // lower key -> clip
  for (const client of CLIENTS) {
    const dir = path.join(client, 'Chara', folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /\.i3AnimPack$/i.test(x))) {
      let P;
      try { P = readAnimPack(path.join(dir, f)); } catch { continue; }
      for (const i of P.find(UI_RE)) {
        const key = P.entries[i].path.replace(/\\/g, '/').match(UI_RE)[1].toLowerCase();
        if (clips.has(key)) continue;
        try { const c = P.clip(i); clips.set(key, { name: key, duration: c.duration, tracks: c.tracks, source: `${path.basename(client)}:${f}` }); } catch { /* unreadable clip */ }
      }
    }
  }
  if (!clips.size) return console.log(`${family}: no UI clips`);
  const { J } = readGLB(path.join(ASSETS, 'chars', family, 'model.glb'));
  const bones = J.skins[0].joints.map((j) => ({ name: J.nodes[j].name }));
  const byFolder = new Map();
  for (const c of clips.values()) {
    const f = c.name.replace(/\/ui\/ui_idle[ab]$/, '');
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(c);
  }
  const outDir = path.join(ASSETS, 'chars', family, 'ui_idle');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let bytes = 0;
  for (const [f, list] of byFolder) {
    const G = new GLB('pb export-ui-idle.mjs');
    const nodeOf = bones.map((b) => G.node({ name: b.name }));
    G.json.scenes[0].nodes = nodeOf.slice();
    addClips(G, nodeOf, bones, list);
    const buf = G.build();
    bytes += buf.length;
    fs.writeFileSync(path.join(outDir, `${uiFile(f)}.glb`), buf);
  }
  console.log(`${family} (${folder}): ${clips.size} clips in ${byFolder.size} files, ${(bytes / 1048576).toFixed(1)} MB`);
}

const want = process.argv.slice(2);
for (const [family, folder] of Object.entries(FAMILIES)) if (!want.length || want.includes(family)) build(family, folder);
