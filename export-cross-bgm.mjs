// Point Blank Cross lobby BGM -> out/sfx/cross/PB_BGM_NO*.ogg (used by src/lobby/screensCross/app.ts syncBgm).
//   node tools/export-cross-bgm.mjs
// The Cross exe (Clients/PBCross/PointBlank.exe) loads "Sound/UI/PB_BGM_NO*.ogg" (strings 0xbddc08..0xbddc8c, UIMainFrame
// table 0x799392; login 0xc2d550). They live in the OLD-format node Sound/UI of Pack/Sound_UI.i3Pack, already Ogg Vorbis.
// The node index has names but no offsets, and the next-magic split of carve() would stop at the 2nd "OggS" page,
// so each Ogg is walked page by page (oggStreams, i3pack/unpack.mjs) from its BOS page to its EOS page; the k-th Ogg name of the node is the k-th stream.
// Sound/BackGround/Menu_BGM.ogg is loose in the client but no string in the exe names it: not exported.
import { assetPath, baseClient, clientPath } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oggStreams, parsePack } from './i3pack/unpack.mjs';

const PACK = clientPath(baseClient('cross'), 'Pack', 'Sound_UI.i3Pack');
const OUT = assetPath('sfx', baseClient('cross'));

fs.mkdirSync(OUT, { recursive: true });
const d = fs.readFileSync(PACK);
const found = [];
for (const node of parsePack(d).nodes) {
  const oggs = (node.files ?? []).map((f) => f.name).filter((n) => /\.ogg$/i.test(n));
  if (!oggs.length) continue;
  const streams = oggStreams(d, node.dataStart, node.dataEnd);
  if (streams.length !== oggs.length) throw new Error(`${node.path}: ${oggs.length} ogg names, ${streams.length} streams`);
  oggs.forEach((nm, k) => {
    if (!/^PB_BGM_NO/i.test(nm)) return;
    fs.writeFileSync(path.join(OUT, nm), streams[k]);
    found.push(`${nm} (${(streams[k].length / 1048576).toFixed(2)} MB)`);
  });
}
if (!found.length) throw new Error(`no PB_BGM_NO*.ogg in ${PACK}`);
// Sound/BackGround/Menu_BGM.ogg: the loose 1:08 menu track (same file in Cross / 3.123 / RUSSIA), user-confirmed lobby music
fs.copyFileSync(clientPath(baseClient('cross'), 'Sound', 'BackGround', 'Menu_BGM.ogg'), path.join(OUT, 'Menu_BGM.ogg'));
found.push('Menu_BGM.ogg');
console.log(`cross bgm: ${found.join(', ')} -> ${OUT}`);
