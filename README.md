# pb-extract-tools

Command line tools (`pbx`) that read **your own copy** of the Point Blank client folders, unpack the `.i3Pack` archives and export models, animations, sounds, textures and UI to open formats (GLB, JSON, OGG, PNG, DDS). It is a private study tool. This repository contains no game files.

Read this in Portuguese: [README.pt-BR.md](README.pt-BR.md).

## What it is

- One entry point, `pbx`, that runs one exporter per command. The exporters are plain Node ESM scripts. Runtime dependencies: `three`, `ffmpeg-static`, and `sharp` (used only by `bloodtex`).
- All paths come from one module, `lib/paths.mjs`. Nothing else hardcodes a client folder, `../..` or the output layout.
- Output goes to `./out` by default. The game folders are read in place and never written to.

## Requirements

| Thing | Version | Needed for |
|---|---|---|
| Node.js | **22.7 or newer** (uses native TypeScript stripping) | everything |
| npm | any recent | install |
| Python 3 + `capstone` (+ `pefile` for `re cross-text`) | optional | `re` and `shopdat` commands |
| ffmpeg | 6.x or newer, bundled via `ffmpeg-static` (ships 6.1.1) | `sound` and OGG export |

Windows is the platform the tools are developed on. The Python `py` launcher is used on Windows, `python3` elsewhere.

## Install

```bash
git clone https://github.com/LeandroDettmer/pb-extract-tools-public.git pb-extract-tools
cd pb-extract-tools
npm install
npm link          # optional: makes `pbx` available everywhere
```

## Quickstart

You need a copy of at least one client (for example the 2017 "Kaybo" client, folder `PBKaybo\GameData\Apps\PB`). Then:

```bash
pbx init --clients "C:\Games\PB\Clients"        # or straight to one client folder
pbx doctor                                       # what works on this machine
pbx re pef-config                                # reads Script.i3Pack -> extracted/pef2017 (needed once)
pbx unpack "C:\Games\PB\Clients\PBKaybo\GameData\Apps\PB\Pack\Weapon_AUG_A3.i3Pack" --out out/unpacked
pbx export batch weapons --only "^aug_a3"        # one weapon family (base + skins); batch reads the PBCross client only
```

Where the output lands:

- `out/weapons/models/<id>.glb` and its textures in `out/weapons/models/tex/<id>/`
- `out/weapons/models/index.json` (one entry per weapon with its source client)
- `out/unpacked/` for `unpack`, `extracted/` for the `re` parsers

Run `pbx doctor` again after each step. It lists which command groups can run on this machine.

> `export batch`, `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `fxmesh`, `c5-bomb` and `headgear` read the PBCross client only (2026-10-13): no fallback to 2017, 3.123, RU or portable packs. Content PBCross lacks is not exported (the single-client plan, item W3, is not in this repository yet).

## Commands

Each row is one command. "Needs" lists the clients it reads and whether it needs `--web` (the web app source and server data).

| Command | What it does | Needs | Example |
|---|---|---|---|
| `pbx unpack` | extract `.i3Pack` files to a folder | none | `pbx unpack Pack\Weapon_AUG_A3.i3Pack --out out/unpacked` |
| `pbx snapshot` | copy the assets a mass re-export rewrites, to revert later | none | `pbx snapshot` (revert: `pbx snapshot --restore`) |
| `pbx export batch` | characters and weapon models (+ `--skins`), `models/index.json` | PBCross (fixed) | `pbx export batch chars --only "^swat_male$"` |
| `pbx export model-dds` | DXT `.dds` next to model and character PNGs (after batch) | none | `pbx export model-dds` |
| `pbx export anim3pv` | 3rd-person clip library per character: `chars/<id>/anim3pv` | PBCross (fixed) | `pbx export anim3pv` |
| `pbx export anim1pv` | 1st-person arm clips per character and weapon: `chars/<id>/anim1pv` | PBCross (`--client`) | `pbx export anim1pv` |
| `pbx export ui-idle` | showroom idle clips per character family | 2017 | `pbx export ui-idle` |
| `pbx export c5-bomb` | C5 brick GLBs and `models/index.json` entries (before weapon-anim) | PBCross (`--client`) | `pbx export c5-bomb` |
| `pbx export weapon-anim` | weapon's own animation (magazine, slide, hammer): `weapons/anim/index.json` | PBCross (`--client`) | `pbx export weapon-anim` |
| `pbx export weaponfx` | weapon effects: `weapons/fx/weaponfx.json` | PBCross (fixed) | `pbx export weaponfx` |
| `pbx export fxmesh` | mesh effect layers (shell casings) to GLB | PBCross (`--client`) | `pbx export fxmesh` |
| `pbx export weapons` | weapon data and sounds for the web client | 3.123, `--server` | `pbx --server D:\game-server export weapons` |
| `pbx export sfx` | weapon sounds by name: `weapons/sfx/pb2017.json` | 2017 | `pbx export sfx` |
| `pbx export charsfx` | character, object and UI sounds: `sfx/char` | 2017 | `pbx export charsfx` |
| `pbx export announce` | kill-mark announcer voice lines | 2017 | `pbx export announce` |
| `pbx export c4-sfx` | C4 (bomb mode) sounds | 2017 | `pbx export c4-sfx` |
| `pbx export break-sfx` | breakable object sounds | 2017 | `pbx export break-sfx` |
| `pbx export radio-voice` | radio chat voice lines: `sfx/radio` | 3.123 | `pbx export radio-voice` |
| `pbx export ambient` | map ambient sounds: `maps/<map>/ambient.json` | 2017 | `pbx export ambient` |
| `pbx export sound-rsc` | per-sound volume and distance table | 2017 | `pbx export sound-rsc` |
| `pbx export headgear` | head accessories (masks, berets, helmets) to GLB | PBCross (`--client`), `--web` | `pbx --web D:\web-app export headgear` |
| `pbx export ragdoll` | death ragdoll data: `chars/<id>/ragdoll.json` | none | `pbx export ragdoll` |
| `pbx export maps` | every playable map: visual, collision, `maps/index.json` | 2017, 3.123 | `pbx export maps` |
| `pbx export visual` | one map render scene to `visual.glb` | 3.123 | `pbx export visual NStation` |
| `pbx export collision` | one map collision to `collision.glb` and `.json` | 3.123 | `pbx export collision NStation --out out/maps` |
| `pbx export surfaces` | impact surface per shape: `surfaces.json` (needs collision) | none | `pbx export surfaces NStation` |
| `pbx export lighting` | per-map `lighting.json` | 2017, 3.123 | `pbx export lighting` |
| `pbx export env-ref` | reflection cubemap `env_ref.dds` (needs lighting) | none | `pbx export env-ref` |
| `pbx export props` | GINS props: `objects/<id>.glb` and `maps/<map>/props.json` | 2017 | `pbx export props` |
| `pbx export map-dds` | DXT `tex/<name>.dds` next to map PNGs (after maps) | none | `pbx export map-dds` |
| `pbx export bombsites` | bomb sites A/B per stage (Cross stages first, 2017 for the rest): `cross/maps/bombsites.json` | 2017, Cross | `pbx export bombsites` |
| `pbx export navgraph` | bot navigation graph: `maps/<map>/navgraph.bin` (after maps) | `--web` | `pbx --web D:\web-app export navgraph` |
| `pbx export missions` | mission cards to `missionData.ts` (in `out/generated` without `--web`) | 2017, 3.123, `--web`, `--server` | `pbx --web D:\web-app --server D:\game-server export missions` |
| `pbx export titles` | designation table to `titleData.ts` (same rule) | 2017, `--server` | `pbx export titles` |
| `pbx export match-data` | server match data to `matchData.json` (same rule) | `--web`, `--server` | `pbx --web D:\web-app --server D:\game-server export match-data` |
| `pbx export bloodtex` | procedural HD blood sprites (deterministic, `sharp` dependency) | none | `pbx export bloodtex` |
| `pbx export lod` | low-resolution mirror of weapon and character GLBs (not in `export all`) | none | `pbx export lod` |
| `pbx ui scenes` | i3UIs scenes to `ui/scenes/<ver>/` | 3.123, 2017 | `pbx ui scenes` |
| `pbx ui templates` | control templates to `ui/templates/<ver>.json` | 3.123, 2017 | `pbx ui templates` |
| `pbx ui strings` | pt-BR strings to `ui/strings/pt-BR.json` | 3.123 | `pbx ui strings` |
| `pbx ui lua` | scene Lua to `ui/strings/scene-bindings.json` | 2017 | `pbx ui lua` |
| `pbx ui atlas` | atlas sheets per scene (crops of source rectangles) | 2017, 3.123 | `pbx ui atlas` |
| `pbx ui icons` | item id to V12 icon cell | 3.123 | `pbx ui icons` |
| `pbx ui compose` | render a scene to PNG for review, no browser | `--web` | `pbx --web D:\web-app ui compose` |
| `pbx ui hud-2017` | in-game HUD textures and minimaps (`--check` to validate) | 2017 | `pbx ui hud-2017 --check` |
| `pbx ui hud-countdown` | round countdown digits | Portable 3.1 | `pbx ui hud-countdown` |
| `pbx ui respawn-result` | respawn result window to an i3Gui tree and atlases | 2017 | `pbx ui respawn-result` |
| `pbx ui loading` | battle loading screen art | 2017, 3.123 | `pbx ui loading` |
| `pbx ui hyper-rank` | Hyper scoreboard rank icon | Hyper | `pbx ui hyper-rank` |
| `pbx ui classic-ui` | i3Gui windows to `ui/classic` (EpicBlackout) or `ui/cross` | EpicBlackout | `pbx ui classic-ui` |
| `pbx ui epic-brand` | EpicBlackout branding images | EpicBlackout | `pbx ui epic-brand` |
| `pbx sound convert` | `.ogg` twin for every `.wav` under the assets folder | none | `pbx sound convert` |
| `pbx sound verify` | check each `.wav` against its `.ogg` twin + ambient loops (`--loops`: loops only) | none | `pbx sound verify` |
| `pbx verify assets` | index and GLB regressions against the snapshot (exit 1 on regression) | none | `pbx verify assets` |
| `pbx verify audit-weapons` | which weapons are playable with the exported 2017 assets | none | `pbx verify audit-weapons` |
| `pbx verify audit-charas` | which characters and equipment parts are complete | `--web` | `pbx --web D:\web-app verify audit-charas` |
| `pbx verify audit-items-cross` | which item-tab shop items are complete with the Cross export -> `ui/complete-items-cross.json` | Cross | `pbx verify audit-items-cross` |
| `pbx verify audit-items` | which shop items are complete | 2017, `--web` | `pbx --web D:\web-app verify audit-items` |
| `pbx verify audit-weapon-anim` | weapon animation states against the web client (`--all`) | none | `pbx verify audit-weapon-anim --all` |
| `pbx re pbdis` | x86 disassembly of `PointBlank.exe` (needs `capstone`) | 2017 | `pbx re pbdis 0x9d0910 0x2d0` |
| `pbx re pef-json` | `.pef` (i3RegistrySet) to JSON | none | `pbx re pef-json extracted\pef2017\br\Weapon.pef` |
| `pbx re pef-config` | 2017 `Script.i3Pack` to `extracted/pef2017/` | 2017 | `pbx re pef-config` |
| `pbx re cross-pef` | Cross `Script.i3Pack` to `extracted/pef-cross/br` + `cross/config/character.json` (before weapons and bombsites) | Cross | `pbx re cross-pef` |
| `pbx re shopdat` | `Shop.dat` parser (3.123) | 3.123 | `pbx re shopdat "C:\Games\PB\Clients\PointBlank 3.123\Shop.dat"` |
| `pbx re fpscam` | bake the first-person camera pivot | 2017 | `pbx re fpscam` |

Run the commands as shown. `pbx help` lists the same commands, generated from the code.

## Global flags

Put these **before** the group name. They are not passed to the script, so a script's own `--out` (for example `unpack`) keeps working.

```bash
pbx --clients "D:\Clients" --out "D:\pb-assets" export sfx
```

| Flag | Environment variable | `pbx.config.json` key | Default | What it is |
|---|---|---|---|---|
| `--clients <dir>` | `PB_CLIENTS` | `clients` | none (required) | folder that holds the client folders |
| `--client <key>=<dir>` (in `init`) | `PB_CLIENT_<KEY>` | `overrides.<key>` | derived | one client folder, when not all sit under one root |
| `--out <dir>` | `PB_ASSETS` | `assets` | `./out` | assets output (what the web client loads) |
| `--web <dir>` | `PB_WEB` | `web` | none | folder of the web project that consumes the assets (has `src/`). Enables steps that read or write it |
| `--server <dir>` | `PB_SERVER` | `server` | none | server root with `server/` and `old/` (game server data). Enables steps that read it |
| `--extracted <dir>` | `PB_EXTRACTED` | `extracted` | `./extracted` | parsed JSON that other steps read |
| `--snapshots <dir>` | `PB_SNAPSHOTS` | `snapshots` | `./snapshots` | snapshots for `snapshot` and `verify assets` |

Precedence: flag, then environment, then `pbx.config.json`, then the default. Relative paths resolve from the folder you run `pbx` in. `pbx init` writes absolute paths.

Client keys: `kaybo` (2017), `br3123` (3.123), `cross`, `ru`, `portable`, `hyper`, `blackout`.

## Clients

| Key | Folder under the clients root | Version | What the tools read from it |
|---|---|---|---|
| `kaybo` | `PBKaybo\GameData\Apps\PB` | Point Blank 2017 (Kaybo) | the reference for characters, weapons, sounds, maps and HUD. The most exporters use this one |
| `br3123` | `PointBlank 3.123` | Point Blank 3.123 (BR) | animation sets for characters, weapon fallbacks, radio voice, shop data, UI strings, map collision |
| `cross` | `PBCross` | Point Blank Cross | Cross UI, icons, lobby music, showroom, clan marks, bomb sites |
| `ru` | `PB RUSSIA` | Point Blank Russia | fallback packs for `batch` and ragdoll layouts |
| `portable` | `Point-Blank-Portable\3-PointBlank` | Point Blank Portable 3.1 | round countdown HUD, lighting fallback |
| `hyper` | `Point Blank Hyper` | Point Blank Hyper | scoreboard rank icon |
| `blackout` | `EpicBlackout` | EpicBlackout (2014) | classic UI windows and branding images |

The version is a guess from the folder. Confirm it in the game before you rely on an export. `pbx doctor` shows which folder each key points to.

## Base client (`--client`)

Exporters that read a client's originals get the client from `baseClient(default)` in `lib/paths.mjs`. The default is the client that exporter reads today, so nothing changes unless you ask. To read another client, pass `--client <key>` after the command, or set `PB_BASE_CLIENT=<key>` for the whole run:

```bash
pbx export sfx --client cross
PB_BASE_CLIENT=cross pbx export sfx
```

An unknown key stops with `--client <key>: unknown client key`.

Scope:
- **Switched:** exporters that read one client. `--client cross` reads `PBCross` instead.
- **Not switched:** exporters that read several clients as sources or fallbacks (table below). A switch would read one client under two labels, so they keep their fixed keys.
- **Not switched:** exporters that already read Cross (`ui cross-bgm`, `ui cross-showroom`, `ui clanmark`, `re cross-pef`).
- `pbx export all --client <key>` (or `PB_BASE_CLIENT`) runs that client's pipeline: every switched step reads it, and the steps that need another client are left out (the dry run lists them).
- Provenance text inside the output JSON (`source` fields) still names the original folder.
- `surfaces` reads every client folder for impact surfaces: not switched.

"yes" means every literal path the exporter reads exists under `PBCross` (checked by path only, output not verified). Run the step with `--client cross` before you rely on it.

| Command | Script | Default base | `--client cross` |
|---|---|---|---|
| `export sfx` | `export-sfx2017.mjs` | kaybo | yes |
| `export charsfx` | `export-charsfx2017.mjs` | kaybo | yes |
| `export announce` | `export-announce2017.mjs` | kaybo | yes |
| `export ambient` | `export-ambient2017.mjs` | kaybo | yes |
| `export anim1pv` | `export-anim1pv.mjs` | cross | yes |
| `export break-sfx` | `export-break-sfx.mjs` | kaybo | yes |
| `export c4-sfx` | `export-c4-sfx.mjs` | kaybo | yes |
| `export c5-bomb` | `export-c5-bomb.mjs` | cross | yes |
| `export fxmesh` | `export-fxmesh.mjs` | cross | yes |
| `export headgear` | `export-headgear.mjs` | cross | yes |
| `export props` | `export-props.mjs` | kaybo | yes |
| `export sound-rsc` | `export-sound-rsc.mjs` | kaybo | yes |
| `export weapon-anim` | `export-weapon-anim.mjs` | cross | yes |
| `export collision` | `export-collision.mjs` | br3123 | yes |
| `export visual` | `export-visual.mjs` | br3123 | yes |
| `export weapons` | `export-weapons.mjs` | br3123 | yes |
| `unpack` | `i3pack/unpack.mjs` | br3123 | yes |
| `ui icons` | `ui-export/ui-icons.mjs` | br3123 | yes |
| `ui cross-icons` | `export-cross-icons.mjs` | br3123 | yes |
| `ui respawn-result` | `ui-export/respawn-result-2017.mjs` | kaybo | yes |
| `ui hud-countdown` | `ui-export/hud-countdown.mjs` | portable | yes |
| `ui hyper-rank` | `ui-export/hyper-rank.mjs` | hyper | yes |
| `ui blackout` | `export-blackout.mjs` | blackout | yes |
| `ui classic-ui` | `export-classic-ui.mjs` | blackout | yes (its own `--client cross` branch, already there) |
| `verify audit-items` | `audit-items-2017.mjs` | kaybo | yes |
| `export radio-voice` | `export-radio-voice.mjs` | br3123 | no: `Pack/Locale_Brazil_Sound_Radio.i3Pack` not in PBCross |
| `ui lua` | `ui-export/ui-lua.mjs` | kaybo | no: `Pack/UI_Re2_Script.i3Pack` not in PBCross |
| `export batch` | `export-batch.mjs` | cross (fixed, no fallback) | no: fixed to PBCross |
| `export anim3pv` | `export-anim3pv.mjs` | cross (fixed, no fallback) | no: fixed to PBCross |
| `export lighting` | `export-lighting.mjs` | kaybo, br3123, portable | no: several clients, fixed |
| `export map-dds` | `export-map-dds.mjs` | kaybo, br3123 | no: several clients, fixed |
| `export maps` | `export-maps-2017.mjs` | kaybo, br3123 | no: several clients, fixed |
| `export missions` | `export-missions.mjs` | br3123, kaybo | no: several clients, fixed; `MissionCardFix.dat` not in PBCross |
| `export ui-idle` | `export-ui-idle.mjs` | blackout, kaybo | no: several clients, fixed |
| `export weaponfx` | `export-weaponfx.mjs` | cross (fixed, no fallback) | no: fixed to PBCross |
| `ui hud-2017` | `ui-export/hud-2017.mjs` | kaybo, br3123, portable | no: several clients, fixed |
| `ui loading` | `ui-export/loading.mjs` | br3123, kaybo | no: several clients, fixed |
| `ui strings` | `ui-export/ui-strings.mjs` | br3123, kaybo | no: several clients, fixed |
| helpers (no command of their own): `export-anim.mjs`, `export-model.mjs`, `pef/extract-config.mjs`, `ui-export/vtex-kaybo.mjs`, `ui-export/lib.mjs` | | br3123 / kaybo | only when the step that calls them passes `--client` on |

## Output formats

| Output | Format | Written by |
|---|---|---|
| characters and weapon models | GLB (glTF 2.0 binary) + PNG textures + JSON index | `export batch`, `anim3pv`, `anim1pv`, `c5-bomb`, `headgear`, `ui-idle` |
| textures for models | DXT `.dds` next to PNG | `model-dds`, `map-dds`, `env-ref`, `visual`, `cross-showroom` |
| map geometry | `visual.glb`, `collision.glb` + `collision.json`, `surfaces.json`, `lighting.json`, `props.json` | `maps`, `visual`, `collision`, `surfaces`, `lighting`, `props`, `env-ref` |
| clip libraries and data | JSON (`index.json`, `ragdoll.json`, `weaponfx.json`, `ambient.json`) | `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `ragdoll`, `ambient`, `sound-rsc` |
| sounds | `.wav` (source), `.ogg` (Vorbis, what the browser plays) | `sfx`, `charsfx`, `announce`, `c4-sfx`, `break-sfx`, `radio-voice`, `wav-to-ogg` (`sound convert`) |
| UI | PNG atlases + JSON (scenes, templates, strings, Lua bindings) | `ui *`, `classic-ui`, `clanmark`, `cross-icons` |
| web source | `.ts` / `.json` written into `src/` with `--web`, else into `out/generated/` (said out loud) | `missions`, `titles`, `match-data`, `sound-rsc`, `fpscam` |
| raw parsed data | JSON in `extracted/` | `re pef-config`, `pef-json`, `unpack` (into the folder you give) |

## Recipes

**Export the whole pipeline (dry run first):**

```bash
pbx export all --client cross --dry-run  # lists the steps; marks the skipped ones and the ones left out
pbx snapshot                             # copy what the mass re-export rewrites
pbx export all                           # runs in order; stops at the first error and prints --from to resume
pbx verify assets                        # regressions against the snapshot
```

A step whose client is missing, or which needs `--web` without it, is skipped with a line that says why. The run continues and ends with a summary.

**Resume after an error:**

```bash
pbx export all --from weapons
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pbx: Point Blank 2017 (Kaybo): missing "...", expected at "..."` | the path under the client is wrong for this client version. Check the folder, or run `pbx init --clients <dir>` |
| `pbx: client not set (needs ...)` | no clients folder configured. Run `pbx init --clients <dir>` |
| `pbx: not produced yet: "...extracted\pef2017...". Run pbx re pef-config first` | a parsed input is missing. Run the named `re` step once |
| `pbx: needs --web <dir> (web app source)` or `needs --server <dir>` | the step reads or writes web app source or server data. Pass the flag, or skip the step |
| PFN1 packs are skipped | some 2017 packs use a format this tool does not decode (PFN1). Sniper and some sound packs keep fallback values in the export (see the comments in the script) |
| packs with internal `D:\...` paths fail to unpack | the pack records a build path on the developer's disk (e.g. `UI_Main.i3Pack`). Read it in memory with `parsePack` / `readI3R2` from `i3pack/unpack.mjs` instead of unpacking to disk |
| `ffmpeg 5.x refused` / `needs >= 6` | the `ffmpeg` binary is too old (the 2018 build pads the last Vorbis block). Run `npm install` (the bundled 6.1.1 is used), or point `FFMPEG` at a newer binary |
| `re` commands fail with `No module named capstone` | install Python 3 and `pip install capstone pefile`. The `re` tools are optional |
| `bloodtex` fails with `Cannot find package 'sharp'` | run `npm install` |
| `Node 22.7` or older errors on `.mjs` | update Node. The tools use native TypeScript stripping for the `--experimental-transform-types` flag |

## Safe-use checklist

- Read `pbx help` and `pbx doctor` before anything else. Only run commands whose "Needs" column is satisfied.
- Dry run first: `pbx export all --dry-run`. Show the list before a mass export.
- Snapshot before any mass re-export: `pbx snapshot`. Revert with `pbx snapshot --restore`.
- Never run `pbx export all` without asking first. It rewrites many files in `out/`.
- One asset: `pbx export <name>` (for example `pbx export sfx`). Check the "Needs" column first.
- After an export: `pbx verify assets`. Exit code 1 means a regression against the snapshot.
- Do not accept a recreated sound or effect until you have checked the original in `PBKaybo\GameData\Apps\PB\Pack`.
- Most exported JSON records its source (`source`, `tool`, `generated`). Keep those fields.

## Legal

This repository contains **no game assets, no game executables and no decompiled game code**. The tools only read copies of the game folders that you own. Point Blank, its formats and its assets belong to their rights holders (Zepetto). Use the output for private study and testing. Do not redistribute exported assets.
