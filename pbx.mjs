#!/usr/bin/env node
// pbx: one entry point for the asset tools (people or scripts). Dispatch, setup and doctor only: each command runs its script.
//
//   pbx init --clients <dir>                      write pbx.config.json (once per machine). <dir> = Clients root or one client folder
//   pbx doctor                                    Node, deps, ffmpeg, Python, clients, what each command group can run
//   pbx [--clients|--out|--web|--server|--extracted|--snapshots <dir>] <group> <name> [args...]
//   pbx export all [--client <key>] [--dry-run] [--from <step>]   full pipeline; steps whose clients, --web or --server are missing are skipped,
//                                                 say so. --client (or PB_BASE_CLIENT): that client's pipeline, every base-client step reads it and
//                                                 the steps that need another client are left out
//   pbx help
//
// Global flags go BEFORE the group name and are not passed to the script (scripts keep their own --out, e.g. unpack).
// Settings: flag > env (PB_CLIENTS, PB_ASSETS, PB_WEB, PB_SERVER, PB_EXTRACTED, PB_SNAPSHOTS, PB_CLIENT_<KEY>) > pbx.config.json > default.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(TOOLS, 'pbx.config.json');
const PY = process.platform === 'win32' ? 'py' : 'python3';
const GLOBAL = { '--clients': 'PB_CLIENTS', '--out': 'PB_ASSETS', '--web': 'PB_WEB', '--server': 'PB_SERVER', '--extracted': 'PB_EXTRACTED', '--snapshots': 'PB_SNAPSHOTS' };
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
    batch: { file: 'export-batch.mjs', desc: 'chars + weapon models (+ --skins); models/index.json', needs: ['cross'] },
    'model-dds': { file: 'export-model-dds.mjs', desc: 'DXT .dds next to model/char PNGs (after batch)', needs: [] },
    anim3pv: { file: 'export-anim3pv.mjs', desc: '3rd-person clip library per char: chars/<id>/anim3pv', needs: ['cross'] },
    anim1pv: { file: 'export-anim1pv.mjs', desc: '1st-person arm clips per char/weapon: chars/<id>/anim1pv', needs: ['cross'] },
    'ui-idle': { file: 'export-ui-idle.mjs', desc: 'showroom idle clips per character family', needs: ['cross'] },
    'c5-bomb': { file: 'export-c5-bomb.mjs', desc: 'C5 brick GLBs + models/index.json entries (before weapon-anim)', needs: ['cross'] },
    'weapon-anim': { file: 'export-weapon-anim.mjs', desc: 'weapon own anim (mag, slide, hammer): weapons/anim/index.json. --list <ids>', needs: ['cross'] },
    weaponfx: { file: 'export-weaponfx.mjs', desc: 'weapon FX: weapons/fx/weaponfx.json (after weapons and props)', needs: ['cross'] },
    fxmesh: { file: 'export-fxmesh.mjs', desc: 'mesh FX layers (shell casings) -> GLB', needs: ['cross'] },
    weapons: { file: 'export-weapons.mjs', desc: 'weapon data + SFX for the web client (pef + 3.123 packs; server ItemStatistics)', needs: ['br3123'], base: true, server: true },
    'weapon-sfx': { file: 'export-weapons.mjs', desc: 'weapon sounds only, PBCross packs: weapons/sfx/index.json (guessed roles)', needs: ['cross'], defaultArgs: ['--sfx-only'] },
    sfx: { file: 'export-sfx2017.mjs', desc: 'weapon sounds by name: weapons/sfx/pb2017.json (rewrites ai)', needs: ['cross'] },
    charsfx: { file: 'export-charsfx2017.mjs', desc: 'character / object / UI sounds: sfx/char', needs: ['cross'] },
    announce: { file: 'export-announce2017.mjs', desc: 'kill-mark announce voice lines', needs: ['cross'] },
    'c4-sfx': { file: 'export-c4-sfx.mjs', desc: 'C4 (bomb mode) sounds', needs: ['cross'] },
    'break-sfx': { file: 'export-break-sfx.mjs', desc: 'breakable object sounds', needs: ['cross'] },
    'radio-voice': { file: 'export-radio-voice.mjs', desc: 'radio chat voice lines: sfx/radio', needs: ['cross'] },
    ambient: { file: 'export-ambient2017.mjs', desc: 'map ambient sounds: maps/<map>/ambient.json', needs: ['cross'] },
    'sound-rsc': { file: 'export-sound-rsc.mjs', desc: 'per-sound volume/distance table (src write with --web, else out/generated)', needs: ['cross'] },
    headgear: { file: 'export-headgear.mjs', desc: 'head accessories (masks, berets, helmets) GLBs', needs: ['cross'], web: true },
    ragdoll: { file: 'export-ragdoll.mjs', desc: 'death ragdoll data: chars/<id>/ragdoll.json', needs: [] },
    maps: { file: 'export-maps-2017.mjs', desc: 'all playable maps (PBCross only): visual + collision + maps/index.json', needs: ['cross'] },
    visual: { file: 'export-visual.mjs', desc: 'one map render scene -> visual.glb (+ args: <Map>)', needs: ['cross'] },
    collision: { file: 'export-collision.mjs', desc: 'one map collision -> collision.glb/json (--out DIR)', needs: ['cross'] },
    surfaces: { file: 'export-surfaces.mjs', desc: 'per-shape impact surface -> surfaces.json (needs collision)', needs: [] },
    lighting: { file: 'export-lighting.mjs', desc: 'per-map lighting.json', needs: ['cross'] },
    'env-ref': { file: 'export-env-ref.mjs', desc: 'reflection cubemap env_ref.dds (needs lighting)', needs: [] },
    props: { file: 'export-props.mjs', desc: 'GINS props: objects/<id>.glb + maps/<map>/props.json', needs: ['cross'] },
    'map-dds': { file: 'export-map-dds.mjs', desc: 'DXT tex/<name>.dds next to map PNGs (after maps)', needs: ['cross'] },
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
    strings: { file: 'ui-export/ui-strings.mjs', desc: 'pt-BR strings -> ui/strings/pt-BR.json + items.pt-BR.json', needs: ['cross'] },
    lua: { file: 'ui-export/ui-lua.mjs', desc: 'scene Lua -> ui/strings/scene-bindings.json', needs: ['kaybo'] },
    atlas: { file: 'ui-export/ui-atlas.mjs', desc: 'atlas sheets per scene (crops of source rects)', needs: ['kaybo', 'br3123'] },
    icons: { file: 'ui-export/ui-icons.mjs', desc: 'itemId -> V12 icon cell', needs: ['br3123'] },
    compose: { file: 'ui-export/ui-compose.mjs', desc: 'render a scene to PNG for review (preview, no browser)', needs: [], web: true },
    'hud-2017': { file: 'ui-export/hud-2017.mjs', desc: 'in-game HUD textures + minimaps: --check', needs: ['kaybo', 'br3123'] },
    'hud-countdown': { file: 'ui-export/hud-countdown.mjs', desc: 'round countdown digits', needs: ['portable'] },
    'respawn-result': { file: 'ui-export/respawn-result-2017.mjs', desc: 'Respawn_Result.gui -> i3Gui tree + atlases', needs: ['kaybo'], base: true },
    'cross-hud': { file: 'ui-export/cross-hud.mjs', desc: 'battle HUD sheets, kill icons, minimaps from the Cross client only -> ui/cross-hud/', needs: ['cross'] },
    'cross-scenes': { file: 'ui-export/cross-scenes.mjs', desc: 'Cross UI_Temp scenes + art (vote HUD...) -> ui/scenes/cross, ui/atlas/cross', needs: ['cross'] },
    'cross-loading': { file: 'ui-export/cross-loading.mjs', desc: 'Cross battle loading art (per-map load_<Map>_*) -> ui/cross/loading/', needs: ['cross'] },
    'cross-brand': { file: 'ui-export/cross-brand.mjs', desc: 'Cross exe window icon (icon.png/icon.ico) + POINT BLANK wordmark (logo.png) -> ui/cross/brand/', needs: ['cross'] },
    loading: { file: 'ui-export/loading.mjs', desc: 'battle loading screen art', needs: ['kaybo', 'br3123'] },
    'hyper-rank': { file: 'ui-export/hyper-rank.mjs', desc: 'Hyper scoreboard rank icon', needs: ['hyper'] },
    'classic-ui': { file: 'export-classic-ui.mjs', desc: 'i3Gui windows -> ui/classic (EpicBlackout)', needs: ['blackout'] },
    'cross-ui': { file: 'export-classic-ui.mjs', desc: 'Cross i3Gui windows -> ui/cross', needs: ['cross'], defaultArgs: ['--client', 'cross'] },
    'epic-brand': { file: 'export-epic-brand.mjs', desc: 'EpicBlackout branding images -> epic-brand/', needs: ['blackout'] },
    clanmark: { file: 'export-clanmark.mjs', desc: 'clan mark atlas -> ui/clanmark/', needs: ['cross'] },
    'cross-icons': { file: 'export-cross-icons.mjs', desc: 'Cross item/map/card icons -> ui/cross/icons/ (web ids from cross-icons-web-ids.json)', needs: ['cross'] },
    'cross-bgm': { file: 'export-cross-bgm.mjs', desc: 'Cross lobby BGM -> sfx/cross/*.ogg', needs: ['cross'] },
    'cross-showroom': { file: 'export-cross-showroom.mjs', desc: 'Cross 3D showroom -> ui/cross/showroom/', needs: ['cross'] },
    fonts: { file: 'ui-export/cross-fonts.mjs', desc: 'Cross UI fonts (Font/Gunplay.ttf) -> ui/fonts/', needs: ['cross'] },
  },
  sound: {
    convert: { file: 'wav-to-ogg.mjs', desc: 'make x.ogg twin for every wav in --out (convertWavs)', needs: [] },
    verify: { file: 'verify-ogg.mjs', desc: 'check every wav vs its ogg twin + ambient loops (--loops: loops only)', needs: [] },
  },
  verify: {
    assets: { file: 'assets-verify.mjs', desc: 'index + GLB regressions vs snapshot (exit 1 on regression)', needs: [] },
    skins: { file: 'verify-skins.mjs', desc: 'skinned GLB: bind pose vs raw mesh, weights/IBM, animated stretch/spikes (exit 1 on fail)', needs: [] },
    'audit-weapons': { file: 'audit-weapons-cross.mjs', desc: 'which weapons are complete in the PBCross export', needs: [] },
    'audit-charas': { file: 'audit-charas-cross.mjs', desc: 'which chars / equip parts are complete (Cross export)', needs: [], web: true },
    'audit-items-cross': { file: 'audit-items-cross.mjs', desc: 'which item-tab shop items are complete (Cross Goods.pef + icon + name) -> ui/complete-items-cross.json', needs: ['cross'] },
    'audit-items': { file: 'audit-items-2017.mjs', desc: 'which shop items are complete', needs: ['kaybo'], web: true },
    'audit-weapon-anim': { file: 'audit-weapon-anim.mjs', desc: 'weapon anim states vs weaponAnim.ts (--all)', needs: [] },
  },
  re: {
    'cross-pef': { file: 'pef/export-cross.mjs', desc: 'PBCross Script.i3Pack -> extracted/pef-cross/br + assets cross/config/character.json (before weapons, bombsites)', needs: ['cross'] },
    fpscam: { file: 'camera/bake-fpscam.mjs', desc: 'bake 1PV camera pivot -> generated pbFpsCam.generated.ts (PBCross chars)', needs: ['cross'] },
  },
};

// export all, in order: [name, 'group cmd', args]. Order = each script's inputs (CLAUDE.md "Re-export em massa").
const ALL = [
  ['cross-pef', 're cross-pef', []],
  ['ai', 'export ai', []], // after cross-pef (AICharacter.json)
  ['snapshot', 'snapshot default', []],
  ['batch', 'export batch', ['--skins']],
  ['c5-bomb', 'export c5-bomb', []],
  ['model-dds', 'export model-dds', []], // after batch + c5-bomb (their PNGs)
  ['weapons', 'export weapons', []], // after cross-pef; anim3pv / anim1pv / sfx / weaponfx read its cross/weapons/weapons.json
  ['anim3pv', 'export anim3pv', []],
  ['anim3pv-female', 'export anim3pv', ['SWAT_Female']], // the lobby / female chars use their own poses (charModel animSkel)
  ['anim1pv', 'export anim1pv', []],
  ['fpscam', 're fpscam', []], // after anim3pv / anim1pv (chars/<id>/anim3pv, arms_1pv.glb)
  ['weapons-anim', 'export weapons', ['--anim-only']], // changeTime from the anim1pv index of THIS catalog (re-export is deterministic)
  ['ui-idle', 'export ui-idle', []],
  ['weapon-anim', 'export weapon-anim', []],
  ['fxmesh', 'export fxmesh', []],
  ['sfx', 'export sfx', []], // after weapon-anim (weapons/anim/index.json)
  ['charsfx', 'export charsfx', []],
  ['announce', 'export announce', []],
  ['c4-sfx', 'export c4-sfx', []],
  ['radio-voice', 'export radio-voice', []],
  ['sound-rsc', 'export sound-rsc', []],
  ['headgear', 'export headgear', []], // after cross-pef (Equipment.json)
  ['ragdoll', 'export ragdoll', []], // after batch (chars/index.json)
  ['maps', 'export maps', []],
  ['surfaces', 'export surfaces', []],
  ['lighting', 'export lighting', []],
  ['env-ref', 'export env-ref', []],
  ['props', 'export props', ['--all']],
  ['break-sfx', 'export break-sfx', []], // after props (objects/index.json)
  ['ambient', 'export ambient', []], // after maps (maps/index.json)
  ['weaponfx', 'export weaponfx', []], // after weapons (cross/weapons/weapons.json) and props (break effects)
  ['bloodtex', 'export bloodtex', []], // after weaponfx (weapons/fx/tex/hd)
  ['map-dds', 'export map-dds', []],
  ['bombsites', 'export bombsites', []],
  ['navgraph', 'export navgraph', ['--all']],
  ['match-data', 'export match-data', []],
  ['ui-scenes', 'ui scenes', []],
  ['ui-templates', 'ui templates', []],
  ['ui-strings', 'ui strings', []],
  ['missions', 'export missions', []], // after ui-strings (items.pt-BR.json) and headgear (equip/index.json)
  ['titles', 'export titles', []],
  ['ui-lua', 'ui lua', []],
  ['ui-atlas', 'ui atlas', []],
  ['ui-icons', 'ui icons', []],
  ['hud-2017', 'ui hud-2017', []],
  ['hud-countdown', 'ui hud-countdown', []],
  ['respawn-result', 'ui respawn-result', []],
  ['loading', 'ui loading', []],
  ['hyper-rank', 'ui hyper-rank', []],
  ['classic-ui', 'ui classic-ui', []],
  ['cross-ui', 'ui cross-ui', []],
  ['epic-brand', 'ui epic-brand', []],
  ['clanmark', 'ui clanmark', []],
  ['cross-icons', 'ui cross-icons', []],
  ['cross-bgm', 'ui cross-bgm', []],
  ['cross-showroom', 'ui cross-showroom', []],
  ['cross-hud', 'ui cross-hud', []],
  ['cross-loading', 'ui cross-loading', []],
  ['cross-brand', 'ui cross-brand', []],
  ['cross-scenes', 'ui cross-scenes', []],
  ['fonts', 'ui fonts', []],
  ['audit-weapons', 'verify audit-weapons', []], // after weapons + weapon-anim
  ['audit-charas', 'verify audit-charas', []], // after batch + headgear
  ['audit-items-cross', 'verify audit-items-cross', []], // after cross-icons + ui-strings
  ['ogg-convert', 'sound convert', []],
  ['ogg-verify', 'sound verify', []],
  ['assets-verify', 'verify assets', ['--if-baseline']],
  ['verify-skins', 'verify skins', []],
];

const stepCmd = (ref) => { const [g, c] = ref.split(' '); return CMDS[g][c]; };

function run(entry, args) {
  const script = path.join(TOOLS, entry.file);
  const [cmd, cmdArgs] = entry.py ? [PY, [script, ...args]] : [process.execPath, ['--experimental-transform-types', script, ...args]];
  // Resolved folders for scripts that cannot read lib/paths.mjs (Python): same names the JS settings read.
  for (const k of Object.keys(CLIENTS)) { const dir = P.clientRoot(k); if (dir) process.env[`PB_CLIENT_${k.toUpperCase()}`] = dir; }
  Object.assign(process.env, { PB_ASSETS: P.settings.assets, PB_EXTRACTED: P.settings.extracted, PB_SNAPSHOTS: P.settings.snapshots });
  if (P.settings.web) process.env.PB_WEB = P.settings.web;
  if (P.settings.server) process.env.PB_SERVER = P.settings.server;
  return spawnSync(cmd, cmdArgs, { cwd: process.cwd(), stdio: 'inherit', env: process.env }).status ?? 1;
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

function exportAll(args) {
  const dry = args.includes('--dry-run');
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? die(`${k} needs a value`) : null; };
  const from = opt('--from');
  // --client <key>: the children read it through PB_BASE_CLIENT (lib/paths.mjs baseClient)
  const client = opt('--client') ?? process.env.PB_BASE_CLIENT ?? null;
  if (client && !CLIENTS[client]) die(`--client ${client}: unknown client key, one of: ${Object.keys(CLIENTS).join(' ')}`);
  if (client) process.env.PB_BASE_CLIENT = client;
  const again = `pbx export all${client ? ` --client ${client}` : ''}`;
  // a client's pipeline leaves out the steps that read another client (they cannot come from that client)
  const out = client ? ALL.filter(([, ref]) => stepNeeds(stepCmd(ref), client).some((k) => k !== client)) : [];
  const steps = ALL.filter((s) => !out.includes(s));
  const start = from ? steps.findIndex(([n]) => n === from) : 0;
  if (start < 0) die(`unknown step "${from}" (names: ${again} --dry-run)`);
  if (out.length) console.log(`${CLIENTS[client].label} pipeline, left out (need another client): ${out.map(([n, ref]) => `${n} [${stepCmd(ref).needs.join(',')}]`).join(', ')}\n`);
  const skipped = [];
  // assets-verify (--if-baseline) compares against the snapshot step's copy of the assets: an empty folder has nothing to compare
  const hadBaseline = fs.existsSync(P.settings.assets) && fs.readdirSync(P.settings.assets).length > 0;
  steps.slice(start).forEach(([name, ref, a], i) => {
    const meta = stepCmd(ref);
    const sa = [...(meta.defaultArgs ?? []), ...a];
    const line = `${String(i + 1).padStart(2)}. ${name.padEnd(17)} ${meta.file} ${sa.join(' ')}`.trimEnd();
    const why = blockedBy(meta, client);
    if (dry) return console.log(why ? `${line}   [skip: ${why}]` : line);
    if (why) { skipped.push(`${name} (${why})`); return console.log(`skip ${name}: ${why}`); }
    console.log(`\n== ${line}`);
    const st = run(meta, sa);
    if (st !== 0) die(`step "${name}" failed (exit ${st}). Fix it, then resume: ${again} --from ${name}`);
  });
  const n = steps.length - start;
  if (dry) console.log(`\n${n} steps. Nothing run. Snapshot first: pbx snapshot --restore to revert.`);
  else console.log(`\nexport all: ${n - skipped.length} of ${n} steps OK${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}.`);
  if (!dry && !hadBaseline) console.log('assets-verify: no baseline (assets folder was empty before the export): nothing was compared. Run again to get the regression gate.');
}

function help() {
  const lines = [
    'pbx: asset tools entry point. Full docs: README.md',
    '',
    'pbx init --clients <dir> [--out <dir>] [--web <dir>] [--server <dir>] [--client <key>=<dir>]   write pbx.config.json',
    'pbx doctor                                  check the machine and what each command group can run',
    'pbx [--clients|--out|--web|--server|--extracted|--snapshots <dir>] <group> <name> [args]',
    'pbx export all [--client <key>] [--dry-run] [--from <step>]  full pipeline in order (skips steps with missing clients, --web or --server)',
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
  for (const [flag, field] of [['--out', 'assets'], ['--web', 'web'], ['--server', 'server'], ['--extracted', 'extracted'], ['--snapshots', 'snapshots']]) {
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
if (group === 'export' && name === 'all') { exportAll(argv.slice(at + 2)); process.exit(0); }
const table = CMDS[group];
if (!table) die(`unknown group "${group}". Run: pbx help`);
let cmd = table[name];
let args = rest;
if (!cmd && table.default) { cmd = table.default; args = [name, ...rest].filter((a) => a !== undefined); }
if (!cmd) die(`unknown command "${group} ${name ?? ''}". Run: pbx help`);
process.exit(run(cmd, [...(cmd.defaultArgs ?? []), ...args]));
