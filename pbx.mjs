#!/usr/bin/env node
// pbx: one entry point for the asset tools (people or scripts). Dispatch, setup and doctor only: each command runs its script.
//
//   pbx init --clients <dir>                      write pbx.config.json (once per machine). <dir> = Clients root or one client folder
//   pbx doctor                                    Node, deps, ffmpeg, Python, clients, what each command group can run
//   pbx [--clients|--out|--web|--server|--extracted|--snapshots|--logs <dir>] <group> <name> [args...]
//   pbx export all [--client <key>] [--dry-run] [--from <step>] [--jobs N] [--plain] [--force] [--force-step <a,b>]   full pipeline; steps run N at a time
//                                                 (default: see DEFAULT_JOBS) once the steps they wait for are done. --jobs 1 = one at a time, in ALL order.
//                                                 A step whose inputs and outputs did not change since its last good run is cached (lib/incremental.mjs).
//                                                 --force reruns all, --force-step reruns the named ones. --dry-run shows [cached] or [run: reason]. Steps whose clients,
//                                                 --web or --server are missing are skipped, say so. --client (or PB_BASE_CLIENT): that client's
//                                                 pipeline, every base-client step reads it and the steps that need another client are left out.
//                                                 Terminal: a live table of the steps. --plain or a pipe: step lines. Each step's output: logs/export-all/<step>.log
//   pbx menu                                      numbered menu over these commands, no typing ("PB Extract Tools.cmd" on Windows, "PB Extract Tools.sh" elsewhere)
//   pbx help
//
// Global flags go BEFORE the group name and are not passed to the script (scripts keep their own --out, e.g. unpack).
// Settings: flag > env (PB_CLIENTS, PB_ASSETS, PB_WEB, PB_SERVER, PB_EXTRACTED, PB_SNAPSHOTS, PB_LOGS, PB_CLIENT_<KEY>) > pbx.config.json > default.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentFp, forget, loadHashes, loadState, overlaps, saveHashes, saveState, scriptFiles, sha, treeFp } from './lib/incremental.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(TOOLS, 'pbx.config.json');
const PY = process.platform === 'win32' ? 'py' : 'python3';
// export all --jobs default: steps at once, at most 4, 3 cores each (a step's inner pools take PB_JOBS = cores / jobs), and 2 GB RAM each
// (the 7.7 GB peak seen with 4 steps at once). On a 12-core, 23 GB box: 4 steps, PB_JOBS 3. Not timed: a guess from the last full run.
const CORES = os.availableParallelism();
const DEFAULT_JOBS = Math.max(1, Math.min(4, Math.floor(CORES / 3), Math.floor(os.totalmem() / 2e9)));
const GLOBAL = { '--clients': 'PB_CLIENTS', '--out': 'PB_ASSETS', '--web': 'PB_WEB', '--server': 'PB_SERVER', '--extracted': 'PB_EXTRACTED', '--snapshots': 'PB_SNAPSHOTS', '--logs': 'PB_LOGS' };
const die = (msg) => { console.error(`pbx: ${msg}`); process.exit(2); };

const argv = process.argv.slice(2);
let at = 0;
while (at < argv.length && Object.hasOwn(GLOBAL, argv[at])) {
  if (argv[at + 1] === undefined) die(`${argv[at]} needs a folder`);
  process.env[GLOBAL[argv[at]]] = path.resolve(argv[at + 1]);
  at += 2;
}
const [group, name, ...rest] = argv.slice(at);

// Imported after the env above is set, so settings see the flags.
const P = await import('./lib/paths.mjs');
const { CLIENTS } = P;

// file: relative to the repo root. needs: client keys the step reads. base: the script reads the base client (lib/paths.mjs
// baseClient), so under export all --client <key> it needs <key> instead. web: needs --web (web app source). server: needs --server (server data). py: Python script.
const CMDS = {
  unpack: {
    default: { file: 'i3pack/unpack.mjs', desc: 'extract .i3Pack files: <pack...> --out <dir>', needs: [] },
  },
  snapshot: {
    default: { file: 'assets-snapshot.mjs', desc: 'copy assets the mass re-export rewrites (--restore to revert)', needs: [] },
  },
  export: {
    batch: { file: 'export-batch.mjs', desc: 'chars + weapon models (+ --skins); models/index.json', needs: ['cross'], base: true },
    'model-dds': { file: 'export-model-dds.mjs', desc: 'DXT .dds next to model/char PNGs (after batch)', needs: [] },
    anim3pv: { file: 'export-anim3pv.mjs', desc: '3rd-person clip library per char: chars/<id>/anim3pv', needs: ['cross'], base: true },
    anim1pv: { file: 'export-anim1pv.mjs', desc: '1st-person arm clips per char/weapon: chars/<id>/anim1pv', needs: ['cross'] },
    'ui-idle': { file: 'export-ui-idle.mjs', desc: 'showroom idle clips per character family', needs: ['cross'], base: true },
    'c5-bomb': { file: 'export-c5-bomb.mjs', desc: 'C5 brick GLBs + models/index.json entries (before weapon-anim)', needs: ['cross'], base: true },
    'weapon-anim': { file: 'export-weapon-anim.mjs', desc: 'weapon own anim (mag, slide, hammer): weapons/anim/index.json. --list <ids>', needs: ['cross'], base: true },
    weaponfx: { file: 'export-weaponfx.mjs', desc: 'weapon FX: weapons/fx/weaponfx.json (after weapons and props)', needs: ['cross'] },
    fxmesh: { file: 'export-fxmesh.mjs', desc: 'mesh FX layers (shell casings) -> GLB', needs: ['cross'], base: true },
    weapons: { file: 'export-weapons.mjs', desc: 'weapon data + SFX for the web client (pef + 3.123 packs; server ItemStatistics)', needs: ['br3123'], base: true, server: true },
    'weapon-sfx': { file: 'export-weapons.mjs', desc: 'weapon sounds only, PBCross packs: weapons/sfx/index.json (guessed roles)', needs: ['cross'], defaultArgs: ['--sfx-only'] },
    sfx: { file: 'export-sfx2017.mjs', desc: 'weapon sounds by name: weapons/sfx/pb2017.json (rewrites ai)', needs: ['cross'] },
    charsfx: { file: 'export-charsfx2017.mjs', desc: 'character / object / UI sounds: sfx/char', needs: ['cross'], base: true },
    announce: { file: 'export-announce2017.mjs', desc: 'kill-mark announce voice lines', needs: ['cross'], base: true },
    'c4-sfx': { file: 'export-c4-sfx.mjs', desc: 'C4 (bomb mode) sounds', needs: ['cross'], base: true },
    'break-sfx': { file: 'export-break-sfx.mjs', desc: 'breakable object sounds', needs: ['cross'] },
    'radio-voice': { file: 'export-radio-voice.mjs', desc: 'radio chat voice lines: sfx/radio', needs: ['cross'], base: true },
    ambient: { file: 'export-ambient2017.mjs', desc: 'map ambient sounds: maps/<map>/ambient.json', needs: ['cross'] },
    'sound-rsc': { file: 'export-sound-rsc.mjs', desc: 'per-sound volume/distance table (src write with --web, else out/generated)', needs: ['cross'], base: true },
    headgear: { file: 'export-headgear.mjs', desc: 'head accessories (masks, berets, helmets) GLBs', needs: ['cross'], web: true, base: true },
    ragdoll: { file: 'export-ragdoll.mjs', desc: 'death ragdoll data: chars/<id>/ragdoll.json', needs: [] },
    maps: { file: 'export-maps-2017.mjs', desc: 'all playable maps (PBCross only): visual + collision + maps/index.json', needs: ['cross'] },
    visual: { file: 'export-visual.mjs', desc: 'one map render scene -> visual.glb (+ args: <Map>)', needs: ['cross'], base: true },
    collision: { file: 'export-collision.mjs', desc: 'one map collision -> collision.glb/json (--out DIR)', needs: ['cross'], base: true },
    surfaces: { file: 'export-surfaces.mjs', desc: 'per-shape impact surface -> surfaces.json (needs collision)', needs: [], base: true },
    lighting: { file: 'export-lighting.mjs', desc: 'per-map lighting.json', needs: ['cross'], base: true },
    'env-ref': { file: 'export-env-ref.mjs', desc: 'reflection cubemap env_ref.dds (needs lighting)', needs: [] },
    props: { file: 'export-props.mjs', desc: 'GINS props: objects/<id>.glb + maps/<map>/props.json', needs: ['cross'], base: true },
    'map-dds': { file: 'export-map-dds.mjs', desc: 'DXT tex/<name>.dds next to map PNGs (after maps)', needs: ['cross'], base: true },
    bombsites: { file: 'export-bombsites.mjs', desc: 'bomb mission sites A/B per stage: cross/maps/bombsites.json', needs: ['cross'] },
    navgraph: { file: 'bake-navgraph.mjs', desc: 'bot nav graph: maps/<map>/navgraph.bin (after maps; loads web src)', needs: [], web: true },
    missions: { file: 'export-missions.mjs', desc: 'mission cards -> src/lobby/core/missionData.ts (out/generated without --web)', needs: ['cross'], web: true, server: true },
    titles: { file: 'export-titles.mjs', desc: 'designation table -> src/lobby/core/titleData.ts (out/generated without --web)', needs: ['cross'], server: true },
    ai: { file: 'export-ai.mjs', desc: 'PBCross bot table -> src/game/data/aiCharacter.json (out/generated without --web)', needs: ['cross'], web: true },
    'match-data': { file: 'match-data.mjs', desc: 'server Match data -> src/host/data/matchData.json (out/generated without --web)', needs: [], web: true, server: true },
    bloodtex: { file: 'bloodtex/gen.mjs', desc: 'procedural HD blood sprites (deterministic, sharp)', needs: [] },
    lod: { file: 'asset-lod/build.mjs', desc: 'low-res mirror of weapon/char GLBs (opt-in, not in export all)', needs: [] },
    // export all: see ALL below
  },
  ui: {
    scenes: { file: 'ui-export/ui-scenes.mjs', desc: 'i3UIs scenes -> ui/scenes/<ver>/', needs: ['br3123', 'kaybo'] },
    templates: { file: 'ui-export/ui-templates.mjs', desc: 'control templates -> ui/templates/<ver>.json', needs: ['br3123', 'kaybo'] },
    strings: { file: 'ui-export/ui-strings.mjs', desc: 'pt-BR strings -> ui/strings/pt-BR.json + items.pt-BR.json', needs: ['cross'], base: true },
    lua: { file: 'ui-export/ui-lua.mjs', desc: 'scene Lua -> ui/strings/scene-bindings.json', needs: ['kaybo'] },
    atlas: { file: 'ui-export/ui-atlas.mjs', desc: 'atlas sheets per scene (crops of source rects)', needs: ['kaybo', 'br3123'] },
    icons: { file: 'ui-export/ui-icons.mjs', desc: 'itemId -> V12 icon cell', needs: ['br3123'] },
    compose: { file: 'ui-export/ui-compose.mjs', desc: 'render a scene to PNG for review (preview, no browser)', needs: [], web: true },
    'hud-2017': { file: 'ui-export/hud-2017.mjs', desc: 'in-game HUD textures + minimaps: --check', needs: ['kaybo', 'br3123'] },
    'hud-countdown': { file: 'ui-export/hud-countdown.mjs', desc: 'round countdown digits', needs: ['portable'] },
    'respawn-result': { file: 'ui-export/respawn-result-2017.mjs', desc: 'Respawn_Result.gui -> i3Gui tree + atlases', needs: ['kaybo'] },
    'cross-hud': { file: 'ui-export/cross-hud.mjs', desc: 'battle HUD sheets, kill icons, minimaps from the Cross client only -> ui/cross-hud/', needs: ['cross'], base: true },
    'cross-scenes': { file: 'ui-export/cross-scenes.mjs', desc: 'Cross UI_Temp scenes + art (vote HUD...) -> ui/scenes/cross, ui/atlas/cross', needs: ['cross'] },
    'cross-loading': { file: 'ui-export/cross-loading.mjs', desc: 'Cross battle loading art (per-map load_<Map>_*) -> ui/cross/loading/', needs: ['cross'], base: true },
    'cross-brand': { file: 'ui-export/cross-brand.mjs', desc: 'Cross exe window icon (icon.png/icon.ico) + POINT BLANK wordmark (logo.png) -> ui/cross/brand/', needs: ['cross'] },
    loading: { file: 'ui-export/loading.mjs', desc: 'battle loading screen art', needs: ['kaybo', 'br3123'] },
    'hyper-rank': { file: 'ui-export/hyper-rank.mjs', desc: 'Hyper scoreboard rank icon', needs: ['hyper'] },
    'classic-ui': { file: 'export-classic-ui.mjs', desc: 'i3Gui windows -> ui/classic (EpicBlackout)', needs: ['blackout'] },
    'cross-ui': { file: 'export-classic-ui.mjs', desc: 'Cross i3Gui windows -> ui/cross', needs: ['cross'], defaultArgs: ['--client', 'cross'] },
    'epic-brand': { file: 'export-epic-brand.mjs', desc: 'EpicBlackout branding images -> epic-brand/', needs: ['blackout'] },
    clanmark: { file: 'export-clanmark.mjs', desc: 'clan mark atlas -> ui/clanmark/', needs: ['cross'], base: true },
    'cross-icons': { file: 'export-cross-icons.mjs', desc: 'Cross item/map/card icons -> ui/cross/icons/ (web ids from cross-icons-web-ids.json)', needs: ['cross'], base: true },
    'cross-bgm': { file: 'export-cross-bgm.mjs', desc: 'Cross lobby BGM -> sfx/cross/*.ogg', needs: ['cross'], base: true },
    'cross-showroom': { file: 'export-cross-showroom.mjs', desc: 'Cross 3D showroom -> ui/cross/showroom/', needs: ['cross'], base: true },
    fonts: { file: 'ui-export/cross-fonts.mjs', desc: 'Cross UI fonts (Font/Gunplay.ttf) -> ui/fonts/', needs: ['cross'], base: true },
  },
  sound: {
    convert: { file: 'wav-to-ogg.mjs', desc: 'make x.ogg twin for every wav in --out (convertWavs)', needs: [] },
    verify: { file: 'verify-ogg.mjs', desc: 'check every wav vs its ogg twin + ambient loops (--loops: loops only)', needs: [] },
  },
  verify: {
    assets: { file: 'assets-verify.mjs', desc: 'index + GLB regressions vs snapshot (exit 1 on regression)', needs: [] },
    skins: { file: 'verify-skins.mjs', desc: 'skinned GLB: bind pose vs raw mesh, weights/IBM, animated stretch/spikes (exit 1 on fail)', needs: [] },
    'audit-weapons': { file: 'audit-weapons-cross.mjs', desc: 'which weapons are complete in the PBCross export', needs: ['cross'] },
    'audit-charas': { file: 'audit-charas-cross.mjs', desc: 'which chars / equip parts are complete (Cross export)', needs: ['cross'], web: true },
    'audit-items-cross': { file: 'audit-items-cross.mjs', desc: 'which item-tab shop items are complete (Cross Goods.pef + icon + name) -> ui/complete-items-cross.json', needs: ['cross'], base: true },
    'audit-items': { file: 'audit-items-2017.mjs', desc: 'which shop items are complete', needs: ['kaybo'], web: true },
    'audit-weapon-anim': { file: 'audit-weapon-anim.mjs', desc: 'weapon anim states vs weaponAnim.ts (--all)', needs: [] },
  },
  re: {
    'cross-pef': { file: 'pef/export-cross.mjs', desc: 'PBCross Script.i3Pack -> extracted/pef-cross/br + assets cross/config/character.json (before weapons, bombsites)', needs: ['cross'] },
    fpscam: { file: 'camera/bake-fpscam.mjs', desc: 'bake 1PV camera pivot -> generated pbFpsCam.generated.ts (PBCross chars)', needs: ['cross'] },
    'pef-config': { file: 'pef/extract-config.mjs', desc: '2017 Script.i3Pack -> extracted/pef2017/', needs: ['kaybo'] },
    'pef-json': { file: 'pef/pef2json.mjs', desc: '.pef (i3RegistrySet) -> JSON', needs: [] },
    pbdis: { file: 're/pbdis.py', desc: 'x86 disassembly of PointBlank.exe (needs capstone)', needs: ['kaybo'], py: true },
    shopdat: { file: 'shopdat/parse_shopdat.py', desc: 'Shop.dat parser (3.123)', needs: ['br3123'], py: true },
  },
};

// export all, in order: [name, 'group cmd', args, after]. Order = each script's inputs (CLAUDE.md "Re-export em massa").
// after = the earlier steps this one reads or writes after: --jobs starts a step once its `after` steps are done.
// '*' = every earlier step that does not wait on '*' itself: the verify, audit and ogg steps wait for the whole export, then run together. Entries marked inferred: from the script's
// reads and writes, not from a comment in ALL; when unsure the dep is added.
const ALL = [
  ['cross-pef', 're cross-pef', [], []],
  ['ai', 'export ai', [], ['cross-pef']], // after cross-pef (AICharacter.json)
  ['snapshot', 'snapshot default', [], ['cross-pef', 'ai']], // copies what the writers below rewrite: runs after the two steps above
  ['batch', 'export batch', ['--skins'], ['snapshot']],
  ['c5-bomb', 'export c5-bomb', [], ['batch']], // writes models/index.json (batch writes it too)
  ['model-dds', 'export model-dds', [], ['batch', 'c5-bomb']], // after batch + c5-bomb (their PNGs)
  ['weapons', 'export weapons', [], ['snapshot']], // after cross-pef; anim3pv / anim1pv / sfx / weaponfx read its cross/weapons/weapons.json
  ['anim3pv', 'export anim3pv', [], ['batch', 'weapons']],
  ['anim3pv-female', 'export anim3pv', ['SWAT_Female'], ['anim3pv']], // the lobby / female chars use their own poses (charModel animSkel) [inferred: same output as anim3pv]
  ['anim1pv', 'export anim1pv', [], ['batch', 'weapons']], // reads cross/weapons/weapons.json
  ['fpscam', 're fpscam', [], ['anim3pv', 'anim1pv']], // after anim3pv / anim1pv (chars/<id>/anim3pv, arms_1pv.glb)
  ['weapons-anim', 'export weapons', ['--anim-only'], ['weapons', 'anim1pv', 'fpscam']], // changeTime from the anim1pv index of THIS catalog (re-export is deterministic); fpscam [inferred]
  ['ui-idle', 'export ui-idle', [], ['snapshot', 'batch']], // reads chars/<family>/model.glb (batch) [inferred]
  ['weapon-anim', 'export weapon-anim', [], ['c5-bomb']], // reads models/index.json
  ['fxmesh', 'export fxmesh', [], ['snapshot']],
  ['sfx', 'export sfx', [], ['weapons', 'weapon-anim']], // after weapon-anim (weapons/anim/index.json); weapons writes the sfx folders sfx writes [inferred]
  ['charsfx', 'export charsfx', [], ['snapshot']],
  ['announce', 'export announce', [], ['snapshot']],
  ['c4-sfx', 'export c4-sfx', [], ['snapshot']],
  ['radio-voice', 'export radio-voice', [], ['snapshot']],
  ['sound-rsc', 'export sound-rsc', [], ['sfx', 'charsfx', 'announce', 'c4-sfx', 'radio-voice']], // after the sound group [inferred]
  ['headgear', 'export headgear', [], ['batch']], // after cross-pef (Equipment.json) and batch (chars/index.json)
  ['ragdoll', 'export ragdoll', [], ['batch']], // after batch (chars/index.json)
  ['maps', 'export maps', [], ['snapshot']],
  ['surfaces', 'export surfaces', [], ['maps']],
  ['lighting', 'export lighting', [], ['maps']],
  ['env-ref', 'export env-ref', [], ['lighting']], // writes env_ref.dds into the map folder lighting.json is in
  ['match-data', 'export match-data', [], ['maps']], // reads maps/index.json; writes host/data/matchData.json, which props reads
  ['props', 'export props', ['--all'], ['maps', 'match-data']], // reads maps/index.json; writes maps/<map>/props.json
  ['break-sfx', 'export break-sfx', [], ['props']], // after props (objects/index.json)
  ['ambient', 'export ambient', [], ['maps']], // after maps (maps/index.json)
  ['weaponfx', 'export weaponfx', [], ['weapons', 'props', 'fxmesh', 'c5-bomb']], // after weapons (cross/weapons/weapons.json), props (break effects) and batch + c5-bomb (weapons/models); fxmesh [inferred]
  ['bloodtex', 'export bloodtex', [], ['weaponfx']], // after weaponfx (weapons/fx/tex/hd)
  ['map-dds', 'export map-dds', [], ['maps']], // after maps (their PNGs)
  ['bombsites', 'export bombsites', [], ['maps']], // reads maps/index.json
  ['navgraph', 'export navgraph', ['--all'], ['maps']],
  ['ui-scenes', 'ui scenes', [], ['snapshot']],
  ['ui-templates', 'ui templates', [], ['snapshot']],
  ['ui-strings', 'ui strings', [], ['snapshot']],
  ['missions', 'export missions', [], ['ui-strings', 'headgear']], // after ui-strings (items.pt-BR.json) and headgear (equip/index.json)
  ['titles', 'export titles', [], ['snapshot']],
  ['ui-lua', 'ui lua', [], ['snapshot']],
  ['ui-atlas', 'ui atlas', [], ['ui-scenes']], // atlas sheets per scene [inferred]
  ['ui-icons', 'ui icons', [], ['snapshot']],
  ['hud-2017', 'ui hud-2017', [], ['maps']], // reads maps/index.json
  ['hud-countdown', 'ui hud-countdown', [], ['hud-2017']], // same hud/index.json [inferred]
  ['respawn-result', 'ui respawn-result', [], ['snapshot']],
  ['loading', 'ui loading', [], ['maps']], // reads maps/index.json
  ['hyper-rank', 'ui hyper-rank', [], ['snapshot']],
  ['classic-ui', 'ui classic-ui', [], ['snapshot']],
  ['cross-ui', 'ui cross-ui', [], ['classic-ui']], // same script as classic-ui [inferred]
  ['epic-brand', 'ui epic-brand', [], ['snapshot']],
  ['clanmark', 'ui clanmark', [], ['snapshot']],
  ['cross-icons', 'ui cross-icons', [], ['headgear', 'weapons']], // reads equip/index.json and cross/weapons/weapons.json when they exist
  ['cross-bgm', 'ui cross-bgm', [], ['snapshot']],
  ['cross-showroom', 'ui cross-showroom', [], ['snapshot']],
  ['cross-hud', 'ui cross-hud', [], ['snapshot']],
  ['cross-loading', 'ui cross-loading', [], ['snapshot']],
  ['cross-brand', 'ui cross-brand', [], ['snapshot']],
  ['cross-scenes', 'ui cross-scenes', [], ['ui-scenes', 'ui-atlas']], // ui/scenes and ui/atlas of the steps above [inferred]
  ['fonts', 'ui fonts', [], ['snapshot']],
  ['audit-weapons', 'verify audit-weapons', [], ['*']], // after weapons + weapon-anim; verify, audit and ogg steps: all earlier steps
  ['audit-charas', 'verify audit-charas', [], ['*']], // after batch + headgear
  ['audit-items-cross', 'verify audit-items-cross', [], ['*']], // after cross-icons + ui-strings
  ['ogg-convert', 'sound convert', [], ['*']],
  ['ogg-verify', 'sound verify', [], ['*', 'ogg-convert']], // checks the ogg twins ogg-convert writes
  ['assets-verify', 'verify assets', ['--if-baseline'], ['*', 'ogg-convert']], // file list includes the ogg twins
  ['verify-skins', 'verify skins', [], ['*']],
];

// What each ALL step writes, for the cache (export all skips a step whose outputs changed). Plain = under --out; ext: = --extracted;
// gen: = generatedPath (web src with --web, else out/generated). Folders, not files, unless a file is named. Unsure = the parent folder.
const OUT = {
  'cross-pef': ['ext:pef-cross', 'cross/config'],
  ai: ['gen:game/data/aiCharacter.json'],
  snapshot: [],
  batch: ['chars', 'weapons/models', 'ext:export-batch-report.json'],
  'c5-bomb': ['weapons/models'],
  'model-dds': ['chars', 'weapons/models', 'ext:export-batch-report.json'], // runs export-batch.mjs chars weapons --skins: its report too
  weapons: ['cross/weapons', 'weapons/sfx', 'chars/swat_male/anim1pv', 'gen:weapons/pbFamilyDefaults.ts'],
  anim3pv: ['chars'],
  'anim3pv-female': ['chars'],
  anim1pv: ['chars'],
  fpscam: ['gen:gameplay/pbFpsCam.generated.ts'],
  'weapons-anim': ['cross/weapons', 'chars/swat_male/anim1pv'],
  'ui-idle': ['chars'],
  'weapon-anim': ['weapons/anim'],
  weaponfx: ['weapons/fx'],
  fxmesh: ['weapons/fx/mesh'],
  sfx: ['weapons/sfx'],
  charsfx: ['sfx/char'],
  announce: ['sfx/announce'],
  'c4-sfx': ['sfx/c4'],
  'break-sfx': ['weapons/sfx/objects', 'objects/index.json'], // rewrites the props index (adds its sfx)
  bloodtex: ['weapons/fx/tex/hd'],
  'radio-voice': ['sfx/radio'],
  ambient: ['sfx/ambient', 'maps'],
  'sound-rsc': ['gen:game/data/soundRsc2017.json'],
  headgear: ['equip'],
  ragdoll: ['chars'],
  maps: ['maps'],
  surfaces: ['maps'],
  lighting: ['maps'],
  'env-ref': ['maps'],
  props: ['objects', 'maps'],
  'map-dds': ['maps'],
  bombsites: ['cross/maps'],
  navgraph: ['maps'],
  'match-data': ['gen:host/data/matchData.json'],
  'ui-scenes': ['ui/scenes'],
  'ui-templates': ['ui/templates'],
  'ui-strings': ['ui/strings'],
  missions: ['gen:lobby/core/missionData.ts'],
  titles: ['gen:lobby/core/titleData.ts'],
  'ui-lua': ['ui/strings'],
  'ui-atlas': ['ui/atlas'],
  'ui-icons': ['ui/icons'],
  'hud-2017': ['ui/hud'],
  'hud-countdown': ['ui/hud'],
  'respawn-result': ['ui/hud/respawn'],
  loading: ['ui/loading'],
  'hyper-rank': ['ui/hyper'],
  'classic-ui': ['ui/classic'],
  'cross-ui': ['ui/cross'],
  'epic-brand': ['epic-brand'],
  clanmark: ['ui/clanmark'],
  'cross-icons': ['ui/cross/icons'],
  'cross-bgm': ['sfx/cross'],
  'cross-showroom': ['ui/cross/showroom'],
  'cross-hud': ['ui/cross-hud'],
  'cross-loading': ['ui/cross/loading'],
  'cross-brand': ['ui/cross/brand'],
  'cross-scenes': ['ui/scenes/cross', 'ui/atlas/cross'],
  fonts: ['ui/fonts'],
  'audit-items-cross': ['ui/complete-items-cross.json'],
};

const stepCmd = (ref) => { const [g, c] = ref.split(' '); return CMDS[g][c]; };

// Children still running: Ctrl+C in export all stops them (killKids).
const kids = new Set();
const killKids = () => {
  for (const c of kids) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
};

// Resolves to the exit code. onLine (export all, a captured step): called with (line, isStderr) for each output line. null: the child
// inherits this terminal.
function run(entry, args, onLine = null) {
  const script = path.join(TOOLS, entry.file);
  const [cmd, cmdArgs] = entry.py ? [PY, [script, ...args]] : [process.execPath, ['--experimental-transform-types', script, ...args]];
  // Resolved folders for scripts that cannot read lib/paths.mjs (Python): same names the JS settings read.
  for (const k of Object.keys(CLIENTS)) { const dir = P.clientRoot(k); if (dir) process.env[`PB_CLIENT_${k.toUpperCase()}`] = dir; }
  Object.assign(process.env, { PB_ASSETS: P.settings.assets, PB_EXTRACTED: P.settings.extracted, PB_SNAPSHOTS: P.settings.snapshots });
  if (P.settings.web) process.env.PB_WEB = P.settings.web;
  if (P.settings.server) process.env.PB_SERVER = P.settings.server;
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: process.cwd(), stdio: onLine ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: process.env });
    kids.add(child);
    if (onLine) for (const [stream, err] of [[child.stdout, false], [child.stderr, true]]) readline.createInterface({ input: stream }).on('line', (l) => onLine(l, err));
    child.on('error', (e) => { kids.delete(child); console.error(`pbx: ${e.message}`); resolve(1); });
    child.on('close', (code) => { kids.delete(child); resolve(code ?? 1); });
  });
}

// Client keys a step reads: a base-client step reads the --client of export all.
const stepNeeds = (entry, client) => (client && entry.base ? [client] : entry.needs);

// Why a step cannot run now, or null.
function blockedBy(entry, client) {
  if (entry.web && !P.settings.web) return 'needs --web <dir> (web app source)';
  if (entry.server && !P.settings.server) return 'needs --server <dir> (server data)';
  const missing = stepNeeds(entry, client).filter((k) => !P.clientStatus(k).found);
  return missing.length ? missing.map((k) => `${CLIENTS[k].label} not found (${P.clientStatus(k).dir ?? 'clients not set'})`).join('; ') : null;
}

// Names a step waits for, within this run: deps before --from or on another client are not in the run, so they are already done.
const waitFor = (list, i) => {
  const names = list.map(([n]) => n);
  const after = list[i][3] ?? [];
  const star = (j) => (list[j][3] ?? []).includes('*');
  const deps = after.includes('*') ? [...names.slice(0, i).filter((_, j) => !star(j)), ...after.filter((d) => d !== '*')] : after;
  return [...new Set(deps)].filter((n) => names.includes(n));
};

// Terminal text of a child's output line: no colour codes, control characters or tabs.
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, ' ').trim();
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const waitText = (list, i) => {
  const after = list[i][3] ?? [];
  return after.includes('*') ? ['all export steps', ...after.filter((d) => d !== '*')].join(' + ') : waitFor(list, i).join(', ');
};

// One step's output: log file under logs/export-all, the command line on top.
function openLog(name, header) {
  const dir = P.logsPath('export-all');
  fs.mkdirSync(dir, { recursive: true });
  const s = fs.createWriteStream(path.join(dir, `${name}.log`));
  s.write(`# ${header}\n`);
  return { write: (l) => s.write(`${l}\n`), end: () => new Promise((r) => s.end(r)) };
}
const tailLog = (file, n = 30) => fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n');

// One row per step: status, number, name, time, then the step's waits (wait), its last output line (run) or its skip reason.
function rowText(r, now) {
  const time = r.state === 'run' ? fmt(now - r.t0) : r.state === 'ok' || r.state === 'FAIL' ? fmt(r.ms) : '';
  const detail = r.state === 'wait' ? (r.waits ? `after: ${r.waits}` : '') : r.state === 'run' ? r.last : r.state === 'skip' ? r.why : '';
  return `${String(r.i + 1).padStart(2)} ${r.state.padEnd(6)} ${r.name.padEnd(17)} ${time.padStart(5)}  ${detail}`.trimEnd();
}

// Step table on a terminal, redrawn in place about 4 times a second. Rows that fit the height: running, failed, waiting, then done.
function liveTable(rows, title, t0) {
  let drawn = 0;
  process.stdout.write('\x1b[?25l'); // cursor hidden while the table moves
  const draw = () => {
    const cols = (process.stdout.columns || 100) - 1;
    const budget = Math.max(3, (process.stdout.rows || 30) - 3); // header, footer and one spare line: the redraw stays on screen
    const now = Date.now();
    const cut = (s) => (s.length > cols ? `${s.slice(0, cols - 3)}...` : s);
    const pick = (...st) => rows.filter((r) => st.includes(r.state));
    const prio = [...pick('run', 'FAIL'), ...pick('wait'), ...pick('ok', 'cached', 'skip')];
    const shown = prio.length <= budget ? prio : prio.slice(0, budget - 1);
    const body = rows.filter((r) => shown.includes(r)).map((r) => cut(rowText(r, now)));
    if (shown.length < prio.length) body.push(`    ... ${prio.length - shown.length} more`);
    const n = (...st) => pick(...st).length;
    const skipped = n('skip') ? ` · ${n('skip')} skipped` : '';
    const lines = [cut(`${title}  ${fmt(now - t0)}`), ...body, cut(`${n('ok')} ok · ${n('cached')} cached · ${n('run')} running · ${n('FAIL')} failed${skipped}`)];
    process.stdout.write((drawn ? `\x1b[${drawn}A\r` : '') + lines.map((l) => `\x1b[2K${l}\n`).join(''));
    drawn = lines.length;
  };
  const timer = setInterval(draw, 250);
  draw();
  return { stop: () => { clearInterval(timer); draw(); process.stdout.write('\x1b[?25h'); } };
}

// Starts each step once its waitFor steps are done, at most `jobs` at once. After a failure it starts nothing new, waits for the
// running steps, then resolves { failed, skipped }. live (export all on a terminal): the step table instead of the step lines.
// A captured step (live, or --jobs > 1) writes its output to logs/export-all/<name>.log.
function runSteps(list, jobs, client, live, reasons, record) {
  return new Promise((resolve) => {
    const pending = list.map((s, i) => ({ s, i, waits: waitFor(list, i) }));
    const rows = list.map(([name], i) => ({ name, i, state: 'wait', t0: 0, ms: 0, last: '', waits: waitText(list, i), why: '', closed: null }));
    const done = new Set(), skipped = [];
    const say = (msg) => { if (!live) console.log(msg); };
    const view = live ? liveTable(rows, live.title, live.t0) : null;
    let active = 0, failed = null;
    const pump = () => {
      while (!failed && active < jobs) {
        const k = pending.findIndex((p) => p.waits.every((n) => done.has(n)));
        if (k < 0) break;
        const [{ s: [name, ref, a], i }] = pending.splice(k, 1);
        const row = rows[i];
        const meta = stepCmd(ref);
        const sa = [...(meta.defaultArgs ?? []), ...a];
        const line = `${String(i + 1).padStart(2)}. ${name.padEnd(17)} ${meta.file} ${sa.join(' ')}`.trimEnd();
        const why = blockedBy(meta, client);
        if (why) { skipped.push(`${name} (${why})`); done.add(name); row.state = 'skip'; row.why = why; say(`skip ${name}: ${why}`); continue; }
        if (!reasons[i]) { row.state = 'cached'; done.add(name); say(`cached ${name}`); continue; }
        active++;
        say(`\n== ${line}`);
        row.state = 'run';
        row.t0 = Date.now();
        const log = live || jobs > 1 ? openLog(name, `${meta.file} ${sa.join(' ')}`.trimEnd()) : null;
        const onLine = !log ? null : live ? (l) => { log.write(l); row.last = clean(l) || row.last; }
          : (l, err) => { log.write(l); (err ? console.error : console.log)(`[${name}] ${l}`); };
        run(meta, sa, onLine).then((st) => {
          active--;
          row.ms = Date.now() - row.t0;
          const secs = (row.ms / 1000).toFixed(1);
          row.closed = log?.end();
          if (st === 0) { row.state = 'ok'; done.add(name); record(i); say(`== ${name}: ${secs} s`); }
          else { row.state = 'FAIL'; failed ??= { name, st }; say(`== ${name}: FAILED after ${secs} s (exit ${st})`); }
          pump();
        });
      }
      if (active > 0) return;
      if (failed || pending.length === 0) {
        view?.stop();
        // logs are flushed before the caller reads the failed step's
        return Promise.all(rows.map((r) => r.closed)).then(() => resolve({ failed, skipped, cached: rows.filter((r) => r.state === 'cached').length }));
      }
      die(`steps never ready (dependency cycle?): ${pending.map((p) => p.s[0]).join(', ')}`);
    };
    pump();
  });
}

// Incremental runs (lib/incremental.mjs). LABEL: what changed, in the order a reason is reported.
const LABEL = { script: 'script changed', args: 'args changed', settings: 'settings changed', client: 'client changed', server: 'server changed', web: 'web src changed' };

// Absolute path of an OUT entry (see OUT).
const outPath = (o) => {
  if (o.startsWith('ext:')) return P.extractedPath(o.slice(4));
  if (o.startsWith('gen:')) return P.settings.web ? path.join(P.settings.web, 'src', o.slice(4)) : P.assetPath('generated', o.slice(4));
  return P.assetPath(o);
};

// What a step reads (hashes per LABEL key, '' when unused) and writes (outs, and the stat of each now). Not for a blocked step.
function stepInfo(name, ref, a, client) {
  const meta = stepCmd(ref);
  const sa = [...(meta.defaultArgs ?? []), ...a];
  const outs = (OUT[name] ?? []).map(outPath);
  const files = [...scriptFiles(path.join(TOOLS, meta.file), TOOLS), path.join(TOOLS, 'package.json'), path.join(TOOLS, 'package-lock.json')];
  // PB_* settings that change output (not PB_JOBS: same output at any job count; not PB_LOGS; PB_CLIENT_* is in the client part)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PB_') && !['PB_JOBS', 'PB_LOGS'].includes(k) && !k.startsWith('PB_CLIENT_')));
  const clients = stepNeeds(meta, client).map((k) => [k, P.clientRoot(k), treeFp(P.clientRoot(k), { content: false })]);
  const parts = {
    script: sha(files.map((f) => `${path.relative(TOOLS, f)} ${contentFp(f)}`).join('\n')),
    args: sha(JSON.stringify(sa)),
    settings: sha(JSON.stringify([P.settings.assets, P.settings.extracted, P.settings.web, P.settings.server, env])),
    client: sha(JSON.stringify(clients)),
    // server/ (runtime, Data), old/ and db/ (the layouts of lib/paths.mjs): not the whole --server root, which may hold a client
    server: meta.server ? sha(['server', 'old', 'db'].map((d) => String(treeFp(path.join(P.settings.server, d), { content: false }))).join('\n')) : '',
    web: '',
  };
  if (meta.web) {
    // generated files (every step's gen: output) are not inputs: a step that writes one is upstream of its readers (after), not a src change.
    // Otherwise a step rewriting its file with the same bytes would rerun every web step.
    const src = path.join(P.settings.web, 'src');
    const generated = new Set(Object.values(OUT).flat().filter((o) => o.startsWith('gen:')).map(outPath));
    parts.web = String(treeFp(src, { keep: (rel) => !generated.has(path.resolve(src, rel)) }));
  }
  return { parts, outs, outFp: Object.fromEntries(outs.map((p) => [p, treeFp(p)])), sa };
}

// Per step of list: the reason it runs, or null when cached. info null (blocked): null, runSteps reports the skip.
// A step runs on its own change, or when a step it waits for runs (not snapshot: it only orders). Derived steps (wait on '*': verify,
// audit, ogg) run then too. snapshot runs only when an export step has its own change, so a fully cached run copies nothing.
function planRun(list, info, state, forced, forceSteps) {
  const names = list.map(([n]) => n);
  const kind = (i) => (names[i] === 'snapshot' ? 'snapshot' : (list[i][3] ?? []).includes('*') ? 'derived' : 'export');
  const own = list.map(([name], i) => {
    if (!info[i] || kind(i) === 'snapshot') return null;
    if (forced) return 'forced (--force)';
    if (forceSteps.has(name)) return 'forced (--force-step)';
    const prev = state.steps[name];
    if (!prev) return 'no state';
    for (const k of Object.keys(LABEL)) if (prev.parts?.[k] !== info[i].parts[k]) return LABEL[k];
    for (const p of info[i].outs) {
      if (info[i].outFp[p] === null) return `output missing: ${p}`;
      if (state.outputs[p] !== info[i].outFp[p]) return `output changed: ${p}`;
    }
    return null;
  });
  const why = list.map(() => null);
  list.forEach((_, i) => {
    if (!info[i]) return;
    if (kind(i) === 'snapshot') {
      const j = names.findIndex((_, k) => own[k] && kind(k) === 'export');
      why[i] = j >= 0 ? `${names[j]}: ${own[j]}` : null;
      return;
    }
    const up = waitFor(list, i).find((n) => why[names.indexOf(n)] && kind(names.indexOf(n)) !== 'snapshot');
    why[i] = own[i] ?? (up ? `upstream ran: ${up}` : null);
  });
  return why;
}

async function exportAll(args) {
  const dry = args.includes('--dry-run');
  const plain = args.includes('--plain');
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? die(`${k} needs a value`) : null; };
  const from = opt('--from');
  // --client <key>: the children read it through PB_BASE_CLIENT (lib/paths.mjs baseClient)
  const client = opt('--client') ?? process.env.PB_BASE_CLIENT ?? null;
  if (client && !CLIENTS[client]) die(`--client ${client}: unknown client key, one of: ${Object.keys(CLIENTS).join(' ')}`);
  if (client) process.env.PB_BASE_CLIENT = client;
  // base-client steps write the shared out/ folders (chars, maps, sfx, ui/...): another client needs its own --out, or it overwrites Cross output
  if (client && client !== 'cross' && !dry && !(process.env.PB_ASSETS || readConfig().assets)) die(`--client ${client} writes the shared out/ folders: give it its own --out <dir>`);
  // --jobs N: steps at once. PB_JOBS (the inner pools of the children: maps, batch, headgear...) unless set in the environment: cores / N
  const jobsArg = opt('--jobs');
  const jobs = jobsArg === null ? DEFAULT_JOBS : Number(jobsArg);
  if (!Number.isInteger(jobs) || jobs < 1) die(`--jobs needs a whole number >= 1, got "${jobsArg}"`);
  process.env.PB_JOBS ??= String(Math.max(2, Math.floor(CORES / jobs)));
  const again = `pbx export all${client ? ` --client ${client}` : ''}`;
  // a client's pipeline leaves out the steps that read another client (they cannot come from that client)
  const out = client ? ALL.filter(([, ref]) => stepNeeds(stepCmd(ref), client).some((k) => k !== client)) : [];
  const steps = ALL.filter((s) => !out.includes(s));
  const start = from ? steps.findIndex(([n]) => n === from) : 0;
  if (start < 0) die(`unknown step "${from}" (names: ${again} --dry-run)`);
  if (out.length) console.log(`${CLIENTS[client].label} pipeline, left out (need another client): ${out.map(([n, ref]) => `${n} [${stepCmd(ref).needs.join(',')}]`).join(', ')}\n`);
  ALL.forEach(([n, , , after = []], i) => {
    for (const d of after) if (d !== '*' && !ALL.slice(0, i).some(([m]) => m === d)) die(`ALL ${n}: after "${d}" is not an earlier step`);
  });
  const list = steps.slice(start);
  // --force reruns every step, --force-step a,b reruns the named ones (and what waits for them)
  const forced = args.includes('--force');
  const forceSteps = new Set((opt('--force-step') ?? '').split(',').filter(Boolean));
  for (const n of forceSteps) if (!ALL.some(([m]) => m === n)) die(`--force-step: unknown step "${n}"`);
  const stateFile = P.extractedPath('.pbx-state.json');
  const state = loadState(stateFile);
  loadHashes(P.extractedPath('.pbx-hashes.json'));
  const info = list.map(([name, ref, a]) => (blockedBy(stepCmd(ref), client) ? null : stepInfo(name, ref, a, client)));
  const why = planRun(list, info, state, forced, forceSteps);
  saveHashes();
  if (dry) {
    list.forEach(([name, ref, a], i) => {
      const meta = stepCmd(ref);
      const sa = [...(meta.defaultArgs ?? []), ...a];
      const line = `${String(i + 1).padStart(2)}. ${name.padEnd(17)} ${meta.file} ${sa.join(' ')}`.trimEnd();
      const blocked = blockedBy(meta, client);
      const waits = waitText(list, i) || '-';
      const verdict = blocked ? `[skip: ${blocked}]` : why[i] ? `[run: ${why[i]}]` : '[cached]';
      console.log(`${line}   [after: ${waits}]   ${verdict}`);
    });
    const cached = list.filter((_, i) => info[i] && !why[i]).length;
    const blocked = info.filter((x) => !x).length;
    console.log(`\n${list.length} steps: ${list.length - cached - blocked} would run, ${cached} cached, ${blocked} skipped. Nothing run. Snapshot first: pbx snapshot --restore to revert.`);
    return;
  }
  // live table on a terminal (PBX_FORCE_TTY=1 forces it, for a test through a pipe). Ctrl+C stops the steps; the cursor comes back on any exit
  const t0 = Date.now();
  const live = !plain && (process.stdout.isTTY || process.env.PBX_FORCE_TTY === '1') ? { title: `pbx export all${client ? ` --client ${client}` : ''} --jobs ${jobs}`, t0 } : null;
  if (live) {
    process.on('exit', () => fs.writeSync(1, '\x1b[?25h'));
    process.once('SIGINT', () => { killKids(); process.exit(130); });
  }
  // assets-verify (--if-baseline) compares against the snapshot step's copy of the assets: an empty folder has nothing to compare
  const hadBaseline = fs.existsSync(P.settings.assets) && fs.readdirSync(P.settings.assets).length > 0;
  // a good step is recorded at once: its parts, and the stat of its outputs now (the state file is the cache)
  const record = (i) => {
    const [name] = list[i];
    const { parts, outs } = info[i];
    state.steps[name] = { parts, outs, at: new Date().toISOString() };
    // a write also changes the outputs around it (a parent folder of another step's output): refresh those too
    const touched = [...new Set([...Object.keys(state.outputs).filter((k) => outs.some((p) => overlaps(k, p))), ...outs])];
    for (const p of touched) { forget(p); state.outputs[p] = treeFp(p); }
    saveState(stateFile, state);
    saveHashes();
  };
  const { failed, skipped, cached } = await runSteps(list, jobs, client, live, why, record);
  if (failed) {
    if (live) console.error(`\nlast 30 lines of ${P.logsPath('export-all', `${failed.name}.log`)}:\n${tailLog(P.logsPath('export-all', `${failed.name}.log`))}\n`);
    die(`step "${failed.name}" failed (exit ${failed.st}). Fix it, then resume: ${again} --from ${failed.name}`);
  }
  const n = list.length;
  console.log(`\nexport all: ${n - skipped.length - cached} run OK, ${cached} cached${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}. ${((Date.now() - t0) / 1000).toFixed(1)} s wall, --jobs ${jobs}, PB_JOBS ${process.env.PB_JOBS}.`);
  if (!hadBaseline) console.log('assets-verify: no baseline (assets folder was empty before the export): nothing was compared. Run again to get the regression gate.');
}

// pbx menu: numbered actions. Each one runs this file with the matching args, so it behaves like the command line.
const ITEMS = [
  ['doctor', 'check the machine, clients and command groups'],
  ['clients', 'set the clients folder (pbx init --clients)'],
  ['client', 'choose the client for export'],
  ['dry', 'export all, dry run (lists the steps, writes nothing)'],
  ['all', 'export all (rewrites many files)'],
  ['one', 'export one step'],
  ['snapshot', 'snapshot (copy what a mass re-export rewrites)'],
  ['restore', 'snapshot --restore (revert to the last snapshot)'],
  ['help', 'help'],
];

// One question. Null on Ctrl+C or end of input. The prompt closes after each answer, so a command runs on a normal terminal.
const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const done = (v) => { resolve(v); rl.close(); }; // resolve first: close fires the 'close' listener below
  rl.question(q, (a) => done(a.trim()));
  rl.once('SIGINT', () => done(null));
  rl.once('close', () => resolve(null));
});
const yes = async (q) => /^y(es)?$/i.test((await ask(q)) ?? '');

// Runs this file with args. Ctrl+C stops the command, not the menu.
function runPbx(args) {
  const self = fileURLToPath(import.meta.url);
  const ignore = () => {};
  process.on('SIGINT', ignore);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [self, ...args], { stdio: 'inherit' });
    child.on('close', (code) => { process.off('SIGINT', ignore); resolve(code ?? 1); });
  });
}

// Resolves to 'reload' after pbx init: the settings are read at startup, so the caller starts the menu again.
async function menu() {
  let client = null;
  const clientArgs = () => (client ? ['--client', client] : []);
  for (;;) {
    console.log(`\npbx menu (client: ${client ?? 'none'})`);
    ITEMS.forEach(([, label], i) => console.log(`  ${i + 1}. ${label}`));
    console.log('  q. quit');
    const a = await ask('> ');
    if (a === null || a === 'q') return 'quit';
    const item = ITEMS[Number(a) - 1]?.[0];
    if (item === 'doctor') await runPbx(['doctor']);
    else if (item === 'clients') {
      const dir = await ask('Clients folder (the Clients dir, or one client folder): ');
      if (dir) { await runPbx(['init', '--clients', dir]); return 'reload'; }
    } else if (item === 'client') {
      const keys = Object.keys(CLIENTS);
      keys.forEach((k, i) => console.log(`  ${i + 1}. ${k.padEnd(9)} ${P.clientStatus(k).found ? 'found  ' : 'missing'}  ${CLIENTS[k].label}`));
      const pick = (await ask('number or key (none = no client, empty = keep): ')) ?? '';
      if (pick === 'none') client = null;
      else if (keys[Number(pick) - 1]) client = keys[Number(pick) - 1];
      else if (keys.includes(pick)) client = pick;
    } else if (item === 'dry') await runPbx(['export', 'all', ...clientArgs(), '--dry-run']);
    else if (item === 'all') {
      console.log('export all rewrites many files in out/ (and in src/ with --web). Take a snapshot first (menu 7).');
      if (await yes('Run export all now? [y/N] ')) await runPbx(['export', 'all', ...clientArgs()]);
    } else if (item === 'one') {
      const groups = Object.keys(CMDS);
      groups.forEach((g, i) => console.log(`  ${i + 1}. ${g}`));
      const g = groups[Number(await ask('group number: ')) - 1];
      if (g) {
        const names = Object.keys(CMDS[g]);
        names.forEach((n, i) => console.log(`  ${i + 1}. ${(n === 'default' ? g : n).padEnd(16)} ${CMDS[g][n].desc}`));
        const n = names[Number(await ask('command number: ')) - 1];
        if (n) {
          const extra = ((await ask('extra args (empty = none): ')) ?? '').split(/\s+/).filter(Boolean);
          await runPbx([g, ...(n === 'default' ? [] : [n]), ...(CMDS[g][n].base ? clientArgs() : []), ...extra]);
        }
      }
    } else if (item === 'snapshot') await runPbx(['snapshot']);
    else if (item === 'restore') {
      if (await yes('Copy the last snapshot back over out/ (files changed since are overwritten)? [y/N] ')) await runPbx(['snapshot', '--restore']);
    } else if (item === 'help') await runPbx(['help']);
    else console.log('pick a number from the list, or q');
  }
}

function help() {
  const lines = [
    'pbx: asset tools entry point. Full docs: README.md',
    '',
    'pbx init --clients <dir> [--out <dir>] [--web <dir>] [--server <dir>] [--client <key>=<dir>]   write pbx.config.json',
    'pbx doctor                                  check the machine and what each command group can run',
    'pbx [--clients|--out|--web|--server|--extracted|--snapshots|--logs <dir>] <group> <name> [args]',
    'pbx export all [--client <key>] [--dry-run] [--from <step>] [--jobs N] [--plain] [--force] [--force-step a,b]  full pipeline (N steps at once, deps in ALL; --jobs 1 = in order; skips steps with missing clients, --web or --server; unchanged steps are [cached]; terminal: live table; logs/export-all/)',
    'pbx menu                                    numbered menu over these commands (PB Extract Tools.cmd / .sh, npm run menu)',
    '',
  ];
  for (const [group, cmds] of Object.entries(CMDS)) {
    lines.push(`${group}:`);
    for (const [name, c] of Object.entries(cmds)) {
      const sub = name === 'default' ? '' : ` ${name}`;
      const who = [...c.needs.map((k) => CLIENTS[k].label.split(' (')[0]), ...(c.web ? ['--web'] : []), ...(c.server ? ['--server'] : [])].join(', ') || 'none';
      lines.push(`  pbx ${group}${sub}`.padEnd(34) + c.desc + `  [${who}]`);
    }
    lines.push('');
  }
  console.log(lines.join('\n'));
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

// `--clients` may be the Clients root or one client folder (ends with a known client dir): the latter sets that client's override.
function init(args) {
  const cfg = readConfig();
  cfg.overrides ??= {};
  const want = (flag) => { const i = args.indexOf(flag); return i >= 0 ? path.resolve(args[i + 1] ?? die(`${flag} needs a folder`)) : null; };
  const clients = want('--clients');
  if (clients) {
    const norm = clients.replace(/\\/g, '/').toLowerCase();
    const key = Object.keys(CLIENTS).find((k) => norm.endsWith('/' + CLIENTS[k].dir.toLowerCase()));
    if (key) { cfg.overrides[key] = clients; console.log(`pbx: ${clients} is the ${CLIENTS[key].label} client folder (set as ${key})`); }
    else cfg.clients = clients;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--client') continue;
    const [key, dir] = (args[i + 1] ?? '').split('=');
    if (!CLIENTS[key] || !dir) die(`--client needs <key>=<dir>, key one of: ${Object.keys(CLIENTS).join(' ')}`);
    cfg.overrides[key] = path.resolve(dir);
  }
  for (const [flag, field] of [['--out', 'assets'], ['--web', 'web'], ['--server', 'server'], ['--extracted', 'extracted'], ['--snapshots', 'snapshots'], ['--logs', 'logs']]) {
    const v = want(flag);
    if (v) cfg[field] = v;
  }
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`pbx: wrote ${CONFIG}`);
  // settings were read at startup: a child process shows the config just written
  process.exit(spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'doctor'], { stdio: 'inherit' }).status ?? 1);
}

// Version of the ffmpeg binary behind ffmpeg-static (or system ffmpeg), or null.
function ffmpegVersion() {
  const req = createRequire(path.join(TOOLS, 'package.json'));
  let bin = null;
  try { bin = req('ffmpeg-static'); } catch { /* not installed: fall back to PATH */ }
  for (const b of [bin, 'ffmpeg'].filter(Boolean)) {
    try {
      const out = execFileSync(b, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /ffmpeg version (\S+)/.exec(out);
      if (m) return { bin: b, version: m[1], major: Number(/^(\d+)/.exec(m[1])?.[1] ?? 0) };
    } catch { /* try next */ }
  }
  return null;
}

function doctor() {
  const ok = (s) => `ok      ${s}`;
  const bad = (s) => `MISSING ${s}`;
  const out = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 7); // --experimental-transform-types
  out.push(`node ${process.version}: ${nodeOk ? ok('>= 22.7') : 'TOO OLD: need Node >= 22.7'}`);
  for (const dep of ['three', 'ffmpeg-static']) {
    let v = null;
    try { v = JSON.parse(fs.readFileSync(path.join(TOOLS, 'node_modules', dep, 'package.json'), 'utf8')).version; } catch { /* missing */ }
    out.push(`npm dep ${dep}: ${v ? ok(v) : bad('run: npm install (in ' + TOOLS + ')')}`);
  }
  const ff = ffmpegVersion();
  out.push(`ffmpeg: ${!ff ? bad('no ffmpeg: npm install') : ff.major >= 6 ? ok(`${ff.version} (${ff.bin})`) : `TOO OLD ${ff.version}: need major >= 6 (${ff.bin})`}`);
  const py = spawnSync(PY, ['--version'], { encoding: 'utf8' });
  out.push(`python (optional, re/ tools): ${py.status === 0 ? ok(`${(py.stdout || py.stderr).trim()}`) : 'not found (re/ tools unavailable)'}`);
  const cap = py.status === 0 ? spawnSync(PY, ['-c', 'import capstone;print(capstone.__version__)'], { encoding: 'utf8' }) : { status: 1 };
  out.push(`capstone (optional, re/pbdis): ${cap.status === 0 ? ok(cap.stdout.trim()) : 'not installed (pip install capstone)'}`);
  out.push('');
  out.push('clients (version = folder guess, confirm in-game):');
  for (const k of Object.keys(CLIENTS)) {
    const s = P.clientStatus(k);
    const where = s.dir ?? 'not set';
    out.push(`  ${k.padEnd(9)} ${s.found ? ok(s.label) : bad(s.label)}  ${where}`);
  }
  out.push(`web (--web):   ${P.settings.web ? ok(P.settings.web) : 'not set (steps that need it are skipped in export all)'}`);
  out.push(`server (--server): ${P.settings.server ? ok(P.settings.server) : 'not set (steps that need it are skipped in export all)'}`);
  out.push(`assets out:    ${P.settings.assets}`);
  out.push(`extracted:     ${P.settings.extracted}`);
  out.push(`snapshots:     ${P.settings.snapshots}`);
  out.push(`logs:          ${P.settings.logs}`);
  out.push('');
  out.push('command groups (what each can run now):');
  for (const [group, cmds] of Object.entries(CMDS)) {
    const needs = [...new Set(Object.values(cmds).flatMap((c) => c.needs))];
    const parts = needs.map((k) => `${k}:${P.clientStatus(k).found ? 'ok' : 'missing'}`);
    if (Object.values(cmds).some((c) => c.web)) parts.push(`web:${P.settings.web ? 'ok' : 'missing'}`);
    if (Object.values(cmds).some((c) => c.server)) parts.push(`server:${P.settings.server ? 'ok' : 'missing'}`);
    out.push(`  ${group.padEnd(8)} ${parts.join('  ') || '-'}`);
  }
  console.log(out.join('\n'));
}

if (!group || group === 'help' || group === '--help') { help(); process.exit(0); }
if (group === 'init') { init(argv.slice(at + 1)); process.exit(0); }
if (group === 'doctor') { doctor(); process.exit(0); }
if (group === 'menu') {
  if ((await menu()) !== 'reload') process.exit(0);
  process.exit(spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'menu'], { stdio: 'inherit' }).status ?? 1);
}
if (group === 'export' && name === 'all') { await exportAll(argv.slice(at + 2)); process.exit(0); }
const table = CMDS[group];
if (!table) die(`unknown group "${group}". Run: pbx help`);
let cmd = table[name];
let args = rest;
if (!cmd && table.default) { cmd = table.default; args = [name, ...rest].filter((a) => a !== undefined); }
if (!cmd) die(`unknown command "${group} ${name ?? ''}". Run: pbx help`);
process.exit(await run(cmd, [...(cmd.defaultArgs ?? []), ...args]));
