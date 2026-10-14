#!/usr/bin/env node
// UI fonts of the Point Blank Cross client (Clients/PBCross/Font) -> out/ui/fonts/:
//   Gunplay.ttf   byte copy (face "Gunplay")
//
//   node ui-export/cross-fonts.mjs
//
// What the Cross exe (PointBlank.exe, image base 0x400000) does with Font/:
//   0x6c91b0 AddFontResourceExA(<cwd>\Font\Gunplay.ttf, FR_PRIVATE) and the same for \Font\YGO240.ttf.
//   "Gunplay" is the face of every number text node: 20 i3TextNodeDX2::Create("Gunplay", n, height 15..32, FW_NORMAL)
//   calls (0x709e72, 0x722829, 0x7340d0, 0x73a836, 0x7b00cd, 0xa47c84, 0xa48b1f...).
//   YGO240.ttf (face "YGO240", Korean name 윤고딕240) is registered but no face string, pack or script names it: unused in
//   this build, not exported. Font/Hud_Small_Font (2010 i3Font bitmap, Gulim 19 bold) is never opened by the exe or the
//   DLLs: not exported.
// Every other text uses the default font "Arial" (0x4ada40, set by 0x69e830 -> SetDefaultFont 0x4ada60; i3Gui:
// i3Language::GetDefaultFontName(1252) = "Arial", i3BaseDx_Cli 0x10019ad9): a Windows system font, not a client file.
import fs from 'node:fs';
import { assetPath, clientPath, rel } from '../lib/paths.mjs';

const FILES = [{ file: 'Gunplay.ttf', face: 'Gunplay' }];

/** family name (name id 1) of a TrueType file, from the Windows/Unicode or Mac record */
function familyName(buf) {
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    if (buf.toString('latin1', o, o + 4) !== 'name') continue;
    const t = buf.readUInt32BE(o + 8), cnt = buf.readUInt16BE(t + 2), str = t + buf.readUInt16BE(t + 4);
    for (let j = 0; j < cnt; j++) {
      const r = t + 6 + j * 12, pid = buf.readUInt16BE(r), nid = buf.readUInt16BE(r + 6);
      if (nid !== 1) continue;
      const s = buf.subarray(str + buf.readUInt16BE(r + 10), str + buf.readUInt16BE(r + 10) + buf.readUInt16BE(r + 8));
      return pid === 3 ? Buffer.from(s).swap16().toString('utf16le') : s.toString('latin1');
    }
  }
  return null;
}

const out = assetPath('ui', 'fonts');
fs.mkdirSync(out, { recursive: true });
for (const { file, face } of FILES) {
  const src = clientPath('cross', 'Font', file), buf = fs.readFileSync(src), fam = familyName(buf);
  if (fam !== face) throw new Error(`${file}: family "${fam}", expected "${face}"`);
  fs.writeFileSync(`${out}/${file}`, buf);
  console.log(`${rel(src)} -> ${rel(`${out}/${file}`)} (${buf.length} B, face ${fam})`);
}
