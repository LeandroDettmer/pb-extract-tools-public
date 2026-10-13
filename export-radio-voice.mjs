#!/usr/bin/env node
// Radio chat voice lines (src/gameplay/pbRadio.ts radioSoundFile: sfx/radio/<Man|Women>/<MV|WV>_<stem>K<index>.wav).
//
// Cross ships the radio lines in Sound_voice_Radio_Man.i3Pack / Sound_voice_Radio_Women.i3Pack (PBCross only).
// Each line has TWO takes, "_K<n>" and "_E<n>". The "_E<n>" take is the one the running code requests as "_K<n>"
// (src/gameplay/pbRadio.ts radioSoundFile), so it is written under that name. Checked 2026-10-13: all 58 Cross
// radio files are byte-identical (SHA1) to the same names in the 3.123 Locale_Brazil_Sound_Radio.i3Pack, so the
// audio is the PT-BR set the 3.123 export used; the Cross UI strings are PT-BR too.
// The Cross packs have no readable index: their names come from the OLD node, payloads are carved in name order.
//
//   node export-radio-voice.mjs
//
// Output: out/sfx/radio/<Man|Women>/<MV|WV>_<stem>K<n>.wav (content = the pack's "_E<n>" take).
import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { convertWavs } from './wav-to-ogg.mjs';
import { carve, decodeContent, parsePack } from './i3pack/unpack.mjs';

const PACKS = ['Sound_voice_Radio_Man.i3Pack', 'Sound_voice_Radio_Women.i3Pack'].map((f) => clientPath(baseClient('cross'), 'Pack', f));
const OUT = assetPath('sfx', 'radio');

/** every named file of a pack: { name, buf } (indexed nodes by offset, OLD nodes by carve in name order) */
function* namedFiles(d) {
  for (const n of parsePack(d).nodes) {
    if (n.indexOk) {
      for (const e of n.files) {
        let buf = d.subarray(e.offset, e.offset + e.size);
        if (e.attr) buf = decodeContent(buf, e.attr) ?? buf;
        yield { name: e.name, buf };
      }
      continue;
    }
    if (!n.files.length) continue;
    const names = n.files.map((e) => e.name), carved = carve(d, { ...n, fileCount: names.length }).files;
    if (carved.length !== names.length) { yield { name: null, buf: null }; continue; }
    for (let i = 0; i < names.length; i++) yield { name: names[i], buf: d.subarray(carved[i].offset, carved[i].offset + carved[i].size) };
  }
}

function main() {
  let written = 0, skipped = 0;
  for (const PACK of PACKS) {
    const d = fs.readFileSync(PACK);
    for (const { name, buf } of namedFiles(d)) {
      if (!name) { skipped++; continue; }
      const m = /^(MV|WV)_((?:Radio_Group|Radio_Answer|Radio|Auto))_E(\d+)\.wav$/i.exec(name);
      if (!m) continue;
      const outName = `${m[1]}_${m[2]}_K${m[3]}.wav`; // -> the name radioSoundFile() builds
      const voice = m[1].toUpperCase() === 'WV' ? 'Women' : 'Man';
      const dst = path.join(OUT, voice, outName);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
      written++;
    }
  }
  console.log(`radio voice (PBCross Sound_voice_Radio_*, "_E" take -> "_K" names): wrote ${written} wav${skipped ? `, skipped ${skipped} undecoded node(s)` : ''}`);
}

main();

convertWavs(OUT);
