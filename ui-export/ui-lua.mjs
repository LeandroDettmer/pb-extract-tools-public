#!/usr/bin/env node
// Scene Lua -> control/string bindings: out/ui/strings/scene-bindings.json (+ lua/*.txt listings)
//
//   node ui-export/ui-lua.mjs
//
// Source: PBKaybo 2017 Pack/UI_Re2_Script.i3Pack -> UIRe/Script/**/*.luab (157 files incl. UIRe/Root.luab).
// Each i3UIs scene names its script (SceneJson.script, e.g. "UIRe\Script\PointBlankRe_Lobby_RoomLis",
// truncated). The .luab are Lua 5.1 bytecode built by the client's patched lua.dll (float numbers, 6 extra
// bitwise opcodes; see lua51.mjs). The scripts set captions on named controls, overwhelmingly as
//   Use("btn01") ... btn01:setTextMB(GAME_STRING("STR_TBL_..."))     (828 call sites)
// and also setText / SetText / SetCaption / SetEditBoxText (text), SetTTMessage (tooltip), SetHeader (list
// columns), SetItems(string.format("%s;%s..", GAME_STRING(..), ..)) (combo items).
//
// Output (per scene, keyed by the i3UIs scene name of BOTH the kaybo and the v12 export whose script basename
// matches; control names are the script's, i.e. the Kaybo scene's control names):
//   { "<Scene>": { script, text: {ctrl: key}, tooltip: {ctrl: key}, header: {ctrl: [key|null]}, items: {ctrl: [key]} } }
// Keys are STBL_IDX_* / STR_* ids of the client string table; resolve them with pt-BR.json (ui-strings.mjs).
// First binding wins when a script sets the same control more than once (state-dependent captions).

import { clientPath, rel, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, writeJSON } from './lib.mjs';
import { parsePack, decodeContent } from '../i3pack/unpack.mjs';
import { parseChunk, decompileAll, listing } from './lua51.mjs';

const PACK = clientPath(baseClient('kaybo'), 'Pack', 'UI_Re2_Script.i3Pack');

export function* iterLuab(pack = PACK) {
  const d = fs.readFileSync(pack);
  for (const n of parsePack(d).nodes) for (const f of n.files) {
    if (!/\.luab$/i.test(f.name)) continue;
    let buf = d.subarray(f.offset, f.offset + f.size);
    if (f.attr) buf = decodeContent(buf, f.attr);
    if (buf) yield { path: `${n.path}/${f.name}`, buf };
  }
}

const TEXT = new Set(['setTextMB', 'setText', 'SetText', 'SetCaption', 'setCaption', 'SetEditBoxText']);
const TOOLTIP = new Set(['SetTTMessage']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const keyOf = a => /^GAME_STRING(?:_U8)?\("((?:STBL_IDX|STR)_[A-Za-z0-9_]+)"\)$/.exec(a)?.[1] ?? null;
const keysIn = a => [...a.matchAll(/GAME_STRING(?:_U8)?\("((?:STBL_IDX|STR)_[A-Za-z0-9_]+)"\)/g)].map(m => m[1]);

export function extractBindings(fns) {
  const used = new Set();
  for (const d of fns) for (const s of d.stmts) if (s.kind === 'call' && s.fn === 'Use' && /^"[^"]*"$/.test(s.args[0] || '')) used.add(JSON.parse(s.args[0]));
  const b = { text: {}, tooltip: {}, header: {}, items: {} };
  let sites = 0, dupes = 0;
  const put = (kind, ctrl, v) => { if (ctrl in b[kind]) { dupes++; return; } b[kind][ctrl] = v; };
  for (const d of fns) {
    // `function Ctrl:method()` -> r0 is the control itself
    const owner = /^([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_]\w*$/.exec(d.name)?.[1];
    for (const s of d.stmts) {
      if (s.kind !== 'call') continue;
      const m = /^(.+):(\w+)$/.exec(s.fn);
      if (!m) continue;
      let [, recv, method] = m;
      if (recv === 'r0' && owner && used.has(owner)) recv = owner;
      if (!IDENT.test(recv) || !used.has(recv)) continue;
      if (TEXT.has(method) || TOOLTIP.has(method)) {
        const k = keyOf(s.args[0] || '');
        if (k) { sites++; put(TEXT.has(method) ? 'text' : 'tooltip', recv, k); }
      } else if (method === 'SetHeader') {
        if (s.args.some(keyOf)) { sites++; put('header', recv, s.args.map(keyOf)); }
      } else if (method === 'SetItems') {
        const ks = keysIn(s.args[0] || '');
        if (ks.length) { sites++; put('items', recv, ks); }
      }
    }
  }
  for (const k of Object.keys(b)) if (!Object.keys(b[k]).length) delete b[k];
  return { bindings: b, sites, dupes, controls: used };
}

// Scene script field = "UIRe\Script\PBRe_X.luaUIRe\P" (garbage after ".lua") or a truncated
// "script\pointblankre_lobby_roomlis" -> { stem: lowercase basename, exact: whether a (partial) ".lua" closed it }.
const sceneStem = p => {
  const m = /(?:^|[\\/])script[\\/](?:\w+[\\/])*?(\w+?)(\.(?:l(?:ua?)?)?|$)/i.exec(p || '');
  return m ? { stem: m[1].toLowerCase(), exact: !!m[2] } : null;
};
const luabStem = p => path.posix.basename(p).replace(/\.luab$/i, '').toLowerCase();

function loadScenes() {
  const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'scenes', 'index.json'), 'utf8'));
  const out = [];
  for (const [ver, list] of Object.entries(idx.versions)) for (const e of list) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, e.file), 'utf8'));
    const st = sceneStem(j.script);
    if (st) out.push({ ver, name: e.name, ...st, controls: new Set(j.controls.map(c => c.name)) });
  }
  return out;
}

export function exportLua() {
  const scenes = loadScenes();
  const stems = [...iterLuab()].map(x => luabStem(x.path));
  // exact name if the scene path kept ".lua", else the script named like the scene when it extends the truncated stem
  // ("UIRe\Script\PointBlankRe_MyInfomation_" -> _MissionCard / _Designation), else the shortest script extending it
  const bestScript = s => (s.exact ? stems.find(t => t === s.stem)
    : stems.find(t => t === s.name.replace(/~\d+$/, '').toLowerCase() && t.startsWith(s.stem))
      ?? stems.filter(t => t.startsWith(s.stem)).sort((a, b) => a.length - b.length)[0]) ?? null;
  const result = {};
  const report = [];
  const allKeys = new Set();
  const collisions = [];
  let files = 0;
  for (const { path: p, buf } of iterLuab()) {
    files++;
    const fns = decompileAll(parseChunk(buf));
    const lst = path.join(OUT, 'lua', p.replace(/\.luab$/i, '.lua.txt'));
    fs.mkdirSync(path.dirname(lst), { recursive: true });
    fs.writeFileSync(lst, `-- ${path.basename(PACK)}:${p} (Lua 5.1 bytecode, linear symbolic listing by lua51.mjs)\n\n${listing(fns)}`);
    const { bindings, sites, dupes } = extractBindings(fns);
    if (!sites) continue;
    const stem = luabStem(p);
    const matched = scenes.filter(s => bestScript(s) === stem);
    for (const v of Object.values(bindings)) for (const x of Object.values(v)) for (const k of [x].flat()) if (k) allKeys.add(k);
    // Scenes reusing a script path by mistake (e.g. PBRe_UserInfomation -> Lobby_RoomList) share no control
    // names with it: skip those; otherwise keep only the controls that exist in that scene.
    for (const s of matched) {
      const own = {};
      for (const [kind, m] of Object.entries(bindings)) {
        const e = Object.entries(m).filter(([c]) => s.controls.has(c));
        if (e.length) own[kind] = Object.fromEntries(e);
      }
      if (!Object.keys(own).length) continue;
      if (result[s.name] && result[s.name].script !== p) { collisions.push(`${s.ver}:${s.name}`); continue; } // v12/kaybo share names
      if (result[s.name]) for (const [kind, m] of Object.entries(own)) result[s.name][kind] = { ...m, ...result[s.name][kind] };
      else result[s.name] = { script: p, ...own };
    }
    const ctrls = new Set(Object.values(bindings).flatMap(Object.keys));
    report.push({
      script: p, sites, dupes, controls: ctrls.size,
      scenes: matched.map(s => `${s.ver}:${s.name}(${[...ctrls].filter(c => s.controls.has(c)).length}/${ctrls.size})`),
    });
  }
  const file = path.join(OUT, 'strings', 'scene-bindings.json');
  writeJSON(file, result, true);
  return { file, files, report, scenes: Object.keys(result).length, keys: allKeys, collisions };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = exportLua();
  const ptFile = path.join(OUT, 'strings', 'pt-BR.json');
  const pt = fs.existsSync(ptFile) ? JSON.parse(fs.readFileSync(ptFile, 'utf8')) : {};
  const hit = [...r.keys].filter(k => k in pt).length;
  for (const x of r.report) console.log(`${x.script}: ${x.sites} sites, ${x.controls} controls${x.dupes ? `, ${x.dupes} re-sets` : ''} -> ${x.scenes.join(' ') || '(no scene)'}`);
  if (r.collisions.length) console.log(`name collisions (other version bound to a different script, kept first): ${r.collisions.join(' ')}`);
  console.log(`${r.files} scripts, ${r.report.length} with bindings, ${r.scenes} scene entries; keys ${hit}/${r.keys.size} in pt-BR.json -> ${rel(r.file)}`);
}
