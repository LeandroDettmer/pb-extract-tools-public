#!/usr/bin/env node
// C4 (Bomb Mission) sounds of the 2017 client.
//
//   node export-c4-sfx.mjs   # -> out/sfx/c4/*.wav + c4.json
//
// Sound_Weapon_C4.i3Pack has encrypted file names (PFN index does not decode: 000.wav ... 008.wav), so the roles are
// [INFERIDO] from the audio. The names come from the exe string table (WM_C4_Button / _Installed / _Count_A.._E /
// _Explosion / _Take, 9 names). 10 carved files (000..009).
//   c6  0.94 s, 6 quick clicks               -> Button   (keypad taps while planting)
//   c8  0.50 s                                -> Installed (c8 role in roles below)
//   c9  7.3 s, loud, long tail                -> Disarmed (defuse hold)
//   c0  4.9 s, clipping, irregular onsets     -> Take     (state 8, the install / defuse hold)
//   c1 / c4 single beeps, c2 2 beeps, c3 3 beeps (0.5 s period), c5 9 accelerating beeps -> Count_A..E (order [INFERIDO])
//   c7  6.8 s, loud                           -> unassigned (second explosion variant?)
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { convertWavs } from './wav-to-ogg.mjs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = clientPath(baseClient('cross'), 'Pack', 'Sound_Weapon_C4.i3Pack');
const OUT = assetPath('sfx', 'c4');

// unpack.mjs carves the nameless files (000.wav ...) into a temp dir
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c4sfx-'));
try { execFileSync(process.execPath, [path.join(HERE, 'i3pack/unpack.mjs'), PACK, '--out', tmp], { stdio: 'ignore' }); } catch { /* exits non-zero on the "names not decoded" WARN; the files are still carved */ }
const dir = path.join(tmp, 'Sound_Weapon_C4/Sound/Weapon/C4');
const clips = {};
// one RIFF per carved file (the current unpack.mjs carve): 008.wav = 0.5 s, 009.wav = 7.3 s. Older carves merged them into one
// file with two RIFFs, which this loop used to split into c8a / c8b; the roles below use the current names.
for (const name of fs.readdirSync(dir).filter((x) => /^\d+\.wav$/.test(x)).sort()) {
  clips[`c${Number(name.slice(0, 3))}`] = fs.readFileSync(path.join(dir, name));
}
fs.rmSync(tmp, { recursive: true, force: true });

fs.mkdirSync(OUT, { recursive: true });
for (const [k, b] of Object.entries(clips)) fs.writeFileSync(path.join(OUT, `${k}.wav`), b);

// exe 2017: 10 states (GTFW_C4_*, table 0xd5b038): 0 Button 1 Installed 2-6 Count_A..E 7 Explosion 8 Take 9 Disarmed. StartWeapon_C4StateSnd
// 0x6996d0 callers: 0x585470 (state 8 while someone is installing / defusing: the sound of the hold), WeaponC4 0x6371d0 (state 1 when the
// install ends), 0x637150 (state 9, defused), WeaponC4::Explosion (state 7).
// Audio check: c0 (4.9 s typing) = the install hold (plant 5.5 s), c9 (7.3 s typing) = the defuse (7.1 s), c7 (loud, boom at 0) = the blast,
// c5 (9 accelerating beeps) = the final count.
const roles = {
  button: 'c6', take: 'c0', installed: 'c8', disarmed: 'c9', explosion: 'c7',
  countA: 'c1', countB: 'c4', countC: 'c2', countD: 'c3', countE: 'c5',
};
fs.writeFileSync(path.join(OUT, 'c4.json'), JSON.stringify({
  note: '[INFERIDO] roles from the audio: the pack file names are encrypted (tools/export-c4-sfx.mjs)',
  roles: Object.fromEntries(Object.entries(roles).map(([r, c]) => [r, `c4/${c}.wav`])),

}, null, 1));
console.log(`c4: ${Object.keys(clips).length} clips`);

convertWavs(OUT);
