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
| Python 3 + `capstone` | optional | `re pbdis` (needs `capstone`); `re shopdat` (Python 3) |
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

You need a copy of each client that the steps you run read. For example, the 2017 "Kaybo" client (folder `PBKaybo\GameData\Apps\PB`) and Point Blank Cross (folder `PBCross`). The "Needs" column in the [Commands](#commands) table says which client each step reads. Then:

```bash
pbx init --clients "C:\Games\PB\Clients"        # or straight to one client folder
pbx doctor                                       # what works on this machine
pbx re pef-config                                # Kaybo: reads Script.i3Pack -> extracted/pef2017 (needed once)
pbx unpack "C:\Games\PB\Clients\PBKaybo\GameData\Apps\PB\Pack\Weapon_AUG_A3.i3Pack" --out out/unpacked
pbx export batch weapons --only "^aug_a3"        # Cross: one weapon family (base + skins)
```

Where the output lands:

- `out/weapons/models/<id>.glb` and its textures in `out/weapons/models/tex/<id>/`
- `out/weapons/models/index.json` (one entry per weapon with its source client)
- `out/unpacked/` for `unpack`, `extracted/` for the `re` parsers

Run `pbx doctor` again after each step. It lists which command groups can run on this machine.

## Menu and live view

![Terminal recording of the pbx menu: open PB Extract Tools.cmd, set the clients folder, run doctor (Point Blank Cross found), choose the cross client, dry run listing the steps, export all with the live step table, then quit](docs/pbx-menu.gif)

Prefer not to type commands? Open the menu: `pbx menu`, or `npm run menu`, or double-click `PB Extract Tools.cmd` on Windows. On macOS or Linux run `chmod +x "PB Extract Tools.sh"` once, then `"./PB Extract Tools.sh"`. The menu lists doctor, setting the clients folder, choosing a client, export all (dry run, or the real run after a y/N question), export one step, snapshot and restore, and help. Each item runs the same command you would type.

On a terminal, `pbx export all` draws a table of the steps and refreshes it about four times a second:

```
pbx export all --client cross --jobs 4  12:31
 3 run  batch            2:05  [batch] 31/70 chars/...
 4 wait c5-bomb                after: batch
 2 ok   cross-pef        0:41
12 ok · 4 cached · 3 running · 0 failed
```

- `run` shows the last output line of the step. `wait` shows the steps it waits for. `skip` shows why the step cannot run. `cached` is a step whose inputs and outputs did not change (see "Incremental runs" under Recipes).
- Long lists show the running, failed and next waiting steps first, then a `... N more` line.
- Each step writes its full output to `logs/export-all/<step>.log`. The folder comes from `--logs <dir>`, `PB_LOGS`, the `logs` key of `pbx.config.json`, or `./logs`. Each run rewrites the logs of the steps it runs.
- On failure the table stops, the last 30 lines of the failed step's log print, and the `--from` resume line follows.
- Ctrl+C stops the running steps and shows the cursor again.
- `--plain`, a pipe or CI give the plain output: `[step]` lines with `--jobs` above 1, the step's own output with `--jobs 1`. With `--jobs 1` and no terminal the output is not captured, so no log file is written.

## Commands

Each row is one command. "Needs" lists the clients it reads, and whether it needs `--web` (the web app source) or `--server` (server data). "(`--client`)" means the step follows `--client` in `export all`; see [Base client](#base-client---client).

| Command | What it does | Needs | Example |
|---|---|---|---|
| `pbx unpack` | extract `.i3Pack` files to a folder | none | `pbx unpack Pack\Weapon_AUG_A3.i3Pack --out out/unpacked` |
| `pbx snapshot` | copy the assets a mass re-export rewrites, to revert later | none | `pbx snapshot` (revert: `pbx snapshot --restore`) |
| `pbx export batch` | characters and weapon models (+ `--skins`), `models/index.json` | Cross (`--client`) | `pbx export batch chars --only "^swat_male$"` |
| `pbx export model-dds` | DXT `.dds` next to model and character PNGs (after batch) | none | `pbx export model-dds` |
| `pbx export anim3pv` | 3rd-person clip library per character: `chars/<id>/anim3pv` | Cross (`--client`) | `pbx export anim3pv` |
| `pbx export anim1pv` | 1st-person arm clips per character and weapon: `chars/<id>/anim1pv` | Cross | `pbx export anim1pv` |
| `pbx export ui-idle` | showroom idle clips per character family | Cross (`--client`) | `pbx export ui-idle` |
| `pbx export c5-bomb` | C5 brick GLBs and `models/index.json` entries (before weapon-anim) | Cross (`--client`) | `pbx export c5-bomb` |
| `pbx export weapon-anim` | weapon's own animation (magazine, slide, hammer): `weapons/anim/index.json` | Cross (`--client`) | `pbx export weapon-anim` |
| `pbx export weaponfx` | weapon effects: `weapons/fx/weaponfx.json` | Cross | `pbx export weaponfx` |
| `pbx export fxmesh` | mesh effect layers (shell casings) to GLB | Cross (`--client`) | `pbx export fxmesh` |
| `pbx export weapons` | weapon data for the web client (`weapons.json`) and its sound clips | 3.123 (`--client`), `--server` | `pbx --server D:\game-server export weapons` |
| `pbx export weapon-sfx` | weapon sounds only, from the Cross packs: `weapons/sfx/index.json` (roles guessed) | Cross | `pbx export weapon-sfx` |
| `pbx export sfx` | weapon sounds by name: `weapons/sfx/pb2017.json` (needs `export weapons` first) | Cross | `pbx export sfx` |
| `pbx export charsfx` | character, object and UI sounds: `sfx/char` | Cross (`--client`) | `pbx export charsfx` |
| `pbx export announce` | kill-mark announcer voice lines | Cross (`--client`) | `pbx export announce` |
| `pbx export c4-sfx` | C4 (bomb mode) sounds | Cross (`--client`) | `pbx export c4-sfx` |
| `pbx export break-sfx` | breakable object sounds | Cross | `pbx export break-sfx` |
| `pbx export radio-voice` | radio chat voice lines: `sfx/radio` | Cross (`--client`) | `pbx export radio-voice` |
| `pbx export ambient` | map ambient sounds: `maps/<map>/ambient.json` | Cross | `pbx export ambient` |
| `pbx export sound-rsc` | per-sound volume and distance table | Cross (`--client`) | `pbx export sound-rsc` |
| `pbx export headgear` | head accessories (masks, berets, helmets) to GLB | Cross (`--client`), `--web` | `pbx --web D:\web-app export headgear` |
| `pbx export ragdoll` | death ragdoll data: `chars/<id>/ragdoll.json` | none | `pbx export ragdoll` |
| `pbx export maps` | every playable map: visual, collision, `maps/index.json` | Cross | `pbx export maps` |
| `pbx export visual` | one map render scene to `visual.glb` | Cross (`--client`) | `pbx export visual NStation` |
| `pbx export collision` | one map collision to `collision.glb` and `.json` | Cross (`--client`) | `pbx export collision NStation --out out/maps` |
| `pbx export surfaces` | impact surface per shape: `surfaces.json` (needs collision) | Cross (`--client`) | `pbx export surfaces NStation` |
| `pbx export lighting` | per-map `lighting.json` | Cross (`--client`) | `pbx export lighting` |
| `pbx export env-ref` | reflection cubemap `env_ref.dds` (needs lighting) | none | `pbx export env-ref` |
| `pbx export props` | GINS props: `objects/<id>.glb` and `maps/<map>/props.json` | Cross (`--client`) | `pbx export props` |
| `pbx export map-dds` | DXT `tex/<name>.dds` next to map PNGs (after maps) | Cross (`--client`) | `pbx export map-dds` |
| `pbx export bombsites` | bomb sites A/B per stage: `cross/maps/bombsites.json` | Cross | `pbx export bombsites` |
| `pbx export navgraph` | bot navigation graph: `maps/<map>/navgraph.bin` (after maps) | `--web` | `pbx --web D:\web-app export navgraph` |
| `pbx export missions` | mission cards to `missionData.ts` (in `out/generated` without `--web`) | Cross, `--web`, `--server` | `pbx --web D:\web-app --server D:\game-server export missions` |
| `pbx export titles` | designation table to `titleData.ts` (same rule) | Cross, `--server` | `pbx export titles` |
| `pbx export ai` | Cross bot table to `aiCharacter.json` (in `out/generated` without `--web`) | Cross, `--web` | `pbx --web D:\web-app export ai` |
| `pbx export match-data` | server match data to `matchData.json` (same rule) | `--web`, `--server` | `pbx --web D:\web-app --server D:\game-server export match-data` |
| `pbx export bloodtex` | procedural HD blood sprites (deterministic, `sharp` dependency) | none | `pbx export bloodtex` |
| `pbx export lod` | low-resolution mirror of weapon and character GLBs (not in `export all`) | none | `pbx export lod` |
| `pbx ui scenes` | i3UIs scenes to `ui/scenes/<ver>/` | 3.123, 2017 | `pbx ui scenes` |
| `pbx ui templates` | control templates to `ui/templates/<ver>.json` | 3.123, 2017 | `pbx ui templates` |
| `pbx ui strings` | pt-BR strings to `ui/strings/pt-BR.json` | Cross (`--client`) | `pbx ui strings` |
| `pbx ui lua` | scene Lua to `ui/strings/scene-bindings.json` | 2017 | `pbx ui lua` |
| `pbx ui atlas` | atlas sheets per scene (crops of source rectangles) | 2017, 3.123 | `pbx ui atlas` |
| `pbx ui icons` | item id to V12 icon cell | 3.123 | `pbx ui icons` |
| `pbx ui compose` | render a scene to PNG for review (preview, no browser) | `--web` | `pbx --web D:\web-app ui compose` |
| `pbx ui hud-2017` | in-game HUD textures and minimaps (`--check` to validate) | 2017, 3.123 | `pbx ui hud-2017 --check` |
| `pbx ui hud-countdown` | round countdown digits | Portable 3.1 | `pbx ui hud-countdown` |
| `pbx ui respawn-result` | respawn result window to an i3Gui tree and atlases | 2017 | `pbx ui respawn-result` |
| `pbx ui loading` | battle loading screen art | 2017, 3.123 | `pbx ui loading` |
| `pbx ui cross-hud` | battle HUD sheets, kill icons and minimaps from Cross to `ui/cross-hud/` | Cross (`--client`) | `pbx ui cross-hud` |
| `pbx ui cross-scenes` | Cross `UI_Temp` scenes and art (vote HUD...) to `ui/scenes/cross`, `ui/atlas/cross` | Cross | `pbx ui cross-scenes` |
| `pbx ui cross-loading` | Cross battle loading art (per map) to `ui/cross/loading/` | Cross (`--client`) | `pbx ui cross-loading` |
| `pbx ui cross-brand` | Cross exe window icon (`icon.png`, `icon.ico`) and POINT BLANK wordmark to `ui/cross/brand/` | Cross | `pbx ui cross-brand` |
| `pbx ui hyper-rank` | Hyper scoreboard rank icon | Hyper | `pbx ui hyper-rank` |
| `pbx ui classic-ui` | i3Gui windows to `ui/classic` | EpicBlackout | `pbx ui classic-ui` |
| `pbx ui cross-ui` | Cross i3Gui windows to `ui/cross` | Cross | `pbx ui cross-ui` |
| `pbx ui epic-brand` | EpicBlackout branding images | EpicBlackout | `pbx ui epic-brand` |
| `pbx ui clanmark` | clan mark atlas to `ui/clanmark/` | Cross (`--client`) | `pbx ui clanmark` |
| `pbx ui cross-icons` | Cross item, map and card icons to `ui/cross/icons/` (web ids from `cross-icons-web-ids.json`) | Cross (`--client`) | `pbx ui cross-icons` |
| `pbx ui cross-bgm` | Cross lobby BGM to `sfx/cross/*.ogg` | Cross (`--client`) | `pbx ui cross-bgm` |
| `pbx ui cross-showroom` | Cross 3D showroom to `ui/cross/showroom/` | Cross (`--client`) | `pbx ui cross-showroom` |
| `pbx ui fonts` | Cross UI fonts (`Font/Gunplay.ttf`) to `ui/fonts/` | Cross (`--client`) | `pbx ui fonts` |
| `pbx sound convert` | `.ogg` twin for every `.wav` under the assets folder | none | `pbx sound convert` |
| `pbx sound verify` | check each `.wav` against its `.ogg` twin + ambient loops (`--loops`: loops only) | none | `pbx sound verify` |
| `pbx verify assets` | index and GLB regressions against the snapshot (exit 1 on regression) | none | `pbx verify assets` |
| `pbx verify skins` | skinned GLB check: bind pose vs raw mesh, weights, animated stretch (exit 1 on fail) | none | `pbx verify skins` |
| `pbx verify audit-weapons` | which weapons are complete in the Cross export | Cross | `pbx verify audit-weapons` |
| `pbx verify audit-charas` | which characters and equipment parts are complete | Cross, `--web` | `pbx --web D:\web-app verify audit-charas` |
| `pbx verify audit-items-cross` | which item-tab shop items are complete with the Cross export -> `ui/complete-items-cross.json` | Cross (`--client`) | `pbx verify audit-items-cross` |
| `pbx verify audit-items` | which shop items are complete | 2017, `--web` | `pbx --web D:\web-app verify audit-items` |
| `pbx verify audit-weapon-anim` | weapon animation states against the web client (`--all`) | none | `pbx verify audit-weapon-anim --all` |
| `pbx re pbdis` | x86 disassembly of `PointBlank.exe` (needs `capstone`) | 2017 | `pbx re pbdis 0x9d0910 0x2d0` |
| `pbx re pef-json` | `.pef` (i3RegistrySet) to JSON | none | `pbx re pef-json extracted\pef2017\br\Weapon.pef` |
| `pbx re pef-config` | 2017 `Script.i3Pack` to `extracted/pef2017/` | 2017 | `pbx re pef-config` |
| `pbx re cross-pef` | Cross `Script.i3Pack` to `extracted/pef-cross/br` + `cross/config/character.json` (before weapons and bombsites) | Cross | `pbx re cross-pef` |
| `pbx re shopdat` | `Shop.dat` parser (3.123) | 3.123 | `pbx re shopdat "C:\Games\PB\Clients\PointBlank 3.123\Shop.dat"` |
| `pbx re fpscam` | bake the first-person camera pivot | Cross | `pbx re fpscam` |

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
| `--server <dir>` | `PB_SERVER` | `server` | none | server root with `server/` (runtime data), `db/init/001_init.sql` (DB seed, public layout) and optional `old/` (older sources, DB seed of the private layout). Enables steps that read it |
| `--extracted <dir>` | `PB_EXTRACTED` | `extracted` | `./extracted` | parsed JSON that other steps read |
| `--snapshots <dir>` | `PB_SNAPSHOTS` | `snapshots` | `./snapshots` | snapshots for `snapshot` and `verify assets` |
| `--logs <dir>` | `PB_LOGS` | `logs` | `./logs` | one output log per step of `export all` (see [Menu and live view](#menu-and-live-view)) |

Precedence: flag, then environment, then `pbx.config.json`, then the default. Relative paths resolve from the folder you run `pbx` in. `pbx init` writes absolute paths.

Client keys: `kaybo` (2017), `br3123` (3.123), `cross`, `ru`, `portable`, `hyper`, `blackout`.

## Texture PNG level and cache

The model exporters (`export batch`, `export headgear`, `export model-dds`) write each texture as a PNG. Two things affect it:

- `PB_PNG_LEVEL` (environment only, default `9`): zlib level of the PNG stream. `9` writes the same bytes as every earlier run, so a sha of the output does not change. `6` encodes faster but writes different, slightly bigger PNG bytes: compare its output by pixels, not by sha. Measured on `export batch --skins` (Cross): PNG total 586 MB at 9, 590 MB at 6; batch 52 s at 9, 32 s at 6 (cold cache). Values 0-8 are accepted too; any other value stops with one line.
- Texture cache at `<extracted>/cache/tex/*.bin`: each texture is keyed by a hash of its source texels, its max size, its alpha mode and `PB_PNG_LEVEL`. A later step or run copies the stored PNG instead of decoding and encoding it again. Measured: `export batch --skins` 24 s with a warm cache against 52 s cold, same output. The cache is safe to delete at any time (it costs a re-encode). It grows with the number of distinct textures.

## Clients

| Key | Folder under the clients root | Version | What the tools read from it |
|---|---|---|---|
| `kaybo` | `PBKaybo\GameData\Apps\PB` | Point Blank 2017 (Kaybo) | 2017 PEF tables (`re pef-config`), Lua scenes, respawn result, HUD, 2017 shop audit |
| `br3123` | `PointBlank 3.123` | Point Blank 3.123 (BR) | weapon data (`export weapons`), shop data (`re shopdat`), scene and template UI, item icons, loading art |
| `cross` | `PBCross` | Point Blank Cross | the default for most steps: characters, weapons, maps, sounds, Cross UI and icons, showroom, bomb sites, PEF (`re cross-pef`) |
| `ru` | `PB RUSSIA` | Point Blank Russia | no step reads it by default. `--client ru` on a step that follows `--client` (see below) is untested |
| `portable` | `Point-Blank-Portable\3-PointBlank` | Point Blank Portable 3.1 | round countdown HUD (`ui hud-countdown`) |
| `hyper` | `Point Blank Hyper` | Point Blank Hyper | scoreboard rank icon (`ui hyper-rank`) |
| `blackout` | `EpicBlackout` | EpicBlackout (2014) | classic UI windows and branding images (`ui classic-ui`, `ui epic-brand`) |

The version is a guess from the folder. Confirm it in the game before you rely on an export. `pbx doctor` shows which folder each key points to.

**Getting the client.** This repository does not include any client. To get a copy of Point Blank Cross, search YouTube for `PointBlank Cross`. Use only a copy you have the right to use, and place it under the clients root as `PBCross`. No download links are given here.

**Other clients.** The tools were built and tested against Point Blank Cross. Other Point Blank clients use the same i3Engine formats, so they can be supported by adapting the tools. See [Other clients](#other-clients-not-cross) for what works today. AI coding assistants can help a lot: point them at this README, the commands, the pack formats and your client folder.

## Base client (`--client`)

Exporters that read a client's originals get the client from `baseClient(default)` in `lib/paths.mjs`. The default is the client that exporter reads today, so nothing changes unless you ask. To read another client, pass `--client <key>` after the command, or set `PB_BASE_CLIENT=<key>` for the whole run:

```bash
pbx export sfx --client cross
PB_BASE_CLIENT=cross pbx export sfx
```

An unknown key stops with `--client <key>: unknown client key`.

How the switch works:

- **`export all --client <key>`** (or `PB_BASE_CLIENT`) runs one client's pipeline. Each step marked "(`--client`)" in the table below reads that client. Steps that read a fixed client (no mark) are left out, and the dry run lists them. Steps that need two clients are left out too.
- **Single commands.** A script that calls `baseClient` also takes `--client` when you run it alone. For example, `pbx export sfx --client kaybo` reads the 2017 packs. `export all` does not run it for that client.
- **Outputs.** Steps that write per-client folders use the client key in the path (for example `out/<key>/weapons/`). Other steps write to the shared `out/` root or to a literal `cross` folder. See [Other clients](#other-clients-not-cross).
- Provenance text inside the output JSON (`source` fields) still names the original folder, for example `PBCross`.

The table lists every command that reads a client. "Follows `--client`" is the `export all` behavior.

| Command | Reads | Follows `--client` in `export all` |
|---|---|---|
| `export batch` | Cross | yes |
| `export anim3pv` | Cross | yes |
| `export anim1pv` | Cross | no |
| `export ui-idle` | Cross | yes |
| `export c5-bomb` | Cross | yes |
| `export weapon-anim` | Cross | yes |
| `export weaponfx` | Cross | no |
| `export fxmesh` | Cross | yes |
| `export weapons` | 3.123 (data); Cross (sound packs) | yes for the data; the sound packs stay on Cross |
| `export weapon-sfx` | Cross | no |
| `export sfx` | Cross | no |
| `export charsfx` | Cross | yes |
| `export announce` | Cross | yes |
| `export c4-sfx` | Cross | yes |
| `export break-sfx` | Cross | no |
| `export radio-voice` | Cross | yes |
| `export ambient` | Cross | no |
| `export sound-rsc` | Cross | yes |
| `export headgear` | Cross | yes |
| `export maps` | Cross | no |
| `export visual` | Cross | yes |
| `export collision` | Cross | yes |
| `export surfaces` | Cross (default) | yes |
| `export lighting` | Cross | yes |
| `export props` | Cross | yes |
| `export map-dds` | Cross | yes |
| `export bombsites` | Cross | no |
| `export missions` | Cross | no |
| `export titles` | Cross | no |
| `export ai` | Cross | no |
| `ui strings` | Cross | yes |
| `ui cross-hud` | Cross | yes |
| `ui cross-loading` | Cross | yes |
| `ui clanmark` | Cross | yes |
| `ui cross-icons` | Cross | yes |
| `ui cross-bgm` | Cross | yes |
| `ui cross-showroom` | Cross | yes |
| `ui fonts` | Cross | yes |
| `ui cross-scenes` | Cross | no |
| `ui cross-brand` | Cross | no |
| `ui cross-ui` | Cross | no |
| `ui lua` | 2017 | no |
| `ui respawn-result` | 2017 | no |
| `ui hud-countdown` | Portable 3.1 | no |
| `ui hyper-rank` | Hyper | no |
| `ui classic-ui` | EpicBlackout | no |
| `ui epic-brand` | EpicBlackout | no |
| `ui icons` | 3.123 | no |
| `ui scenes`, `ui templates`, `ui atlas`, `ui loading`, `ui hud-2017` | 3.123 and 2017 (both) | no |
| `verify audit-weapons` | Cross | no |
| `verify audit-charas` | Cross | no |
| `verify audit-items-cross` | Cross | yes |
| `verify audit-items` | 2017 | no |
| `re cross-pef` | Cross | no (runs alone with `--client`, see [Other clients](#other-clients-not-cross)) |
| `re fpscam` | Cross | no |
| `re pef-config` | 2017 | no |
| `re pbdis` | 2017 | no |
| `re shopdat` | 3.123 | no |

## Other clients (not Cross)

What works today for a client other than Cross. Stated plainly. Nothing here is tested against another client, and no step is promised to work.

**Output folder.** `export all --client <key>` needs its own `--out` for any key except `cross`. Without it the run stops with an error, so a second client does not overwrite Cross output. Give each client its own `--out` for single commands too. `--dry-run` skips the check, since it writes nothing.

**PEF tables.** `pbx re cross-pef --client <key>` writes `extracted/pef-<key>/br/`. The steps that read PEF tables take that folder from the same key. The reader is the Cross one (`pef/export-cross.mjs`). The 2017 reader (`re pef-config`) uses another layout (PFN3 at offset `0x162`). Nothing checks the output of another client against Cross. Compare it before you use it.

**What still blocks other clients:**

1. **Fixed pack and file names.** Many steps name Cross or Brazil files directly: `Sound_voice_Announce`, `Sound_Weapon_C4`, `UI_Showroom`, `UI_Loading`, `Chara_ClanMark*`, `String_Brazil.lua`, the `*_Brazil` item and quest tables, `Gunplay.ttf`. A client that does not have a file fails with the one-line `missing` message. A client that has the same name with other content exports other data.
2. **Character families.** `SWAT_Male` and `SWAT_Female` are hard-coded in `batch`, `anim3pv` and `ui-idle`. Other clients may use other character sets.
3. **Two-client steps.** `ui scenes`, `ui templates`, `ui atlas`, `ui loading` and `ui hud-2017` read the 3.123 and 2017 folders at the same time. The single-key `needs` check cannot express that, so `export all` never runs them for one client.
4. **Fixed Cross steps.** The steps marked "no" in the table above read Cross, and `export all --client <key>` leaves them out. Run them alone only with a client whose files match Cross.
5. **Keys in `lib/paths.mjs`.** A new key in `CLIENTS` only maps a folder. Each step still needs the checks above. [CLAUDE.md](CLAUDE.md) lists the places to check.

## Output formats

| Output | Format | Written by |
|---|---|---|
| characters and weapon models | GLB (glTF 2.0 binary) + PNG textures + JSON index | `export batch`, `anim3pv`, `anim1pv`, `c5-bomb`, `headgear`, `ui-idle` |
| textures for models | DXT `.dds` next to PNG | `model-dds`, `map-dds`, `env-ref`, `visual`, `cross-showroom` |
| map geometry | `visual.glb`, `collision.glb` + `collision.json`, `surfaces.json`, `lighting.json`, `props.json` | `maps`, `visual`, `collision`, `surfaces`, `lighting`, `props`, `env-ref` |
| clip libraries and data | JSON (`index.json`, `ragdoll.json`, `weaponfx.json`, `ambient.json`) | `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `ragdoll`, `ambient`, `sound-rsc` |
| sounds | `.wav` (source), `.ogg` (Vorbis, what the browser plays) | `sfx`, `weapon-sfx`, `charsfx`, `announce`, `c4-sfx`, `break-sfx`, `radio-voice`, `wav-to-ogg` (`sound convert`) |
| UI | PNG atlases + JSON (scenes, templates, strings, Lua bindings) | `ui *`, `classic-ui`, `clanmark`, `cross-icons` |
| web source | `.ts` / `.json` written into `src/` with `--web`, else into `out/generated/` (said out loud) | `missions`, `titles`, `ai`, `match-data`, `sound-rsc`, `fpscam` |
| raw parsed data | JSON in `extracted/` | `re pef-config`, `re cross-pef`, `pef-json`, `unpack` (into the folder you give) |

## Weapon data and weapon sounds

Three commands make weapon sounds. Use this to pick one:

- **`pbx export weapons`**: the weapon data for the web client (`weapons.json`, from the server's item statistics and the Cross `Weapon.pef`). It also writes sound clips for the default loadout, with guessed roles. `--no-sfx` skips the clips. `--all-sfx` writes every Cross sound pack. Needs `--server`.
- **`pbx export weapon-sfx`**: sound clips only, with no weapon data. Roles are guessed, and the index is `weapons/sfx/index.json`.
- **`pbx export sfx`**: the same weapons, but clips are named from the Cross packs, so no role is guessed. It writes `weapons/sfx/pb2017.json`, which says when each weapon's AI plays each clip. It reads `weapons.json`, so run `export weapons` first.

## Recipes

**Export the whole pipeline (dry run first):**

```bash
pbx export all --client cross --dry-run  # lists the steps; marks the skipped ones and the ones left out
pbx snapshot                             # copy what the mass re-export rewrites
pbx export all                           # runs the steps; stops at the first error and prints --from to resume
pbx verify assets                        # regressions against the snapshot
```

A step whose client is missing, or which needs `--web` without it, is skipped with a line that says why. The run continues and ends with a summary.

**Run steps in parallel:**

```bash
pbx export all --jobs 4                  # default: 4 at most, cores / 3, 2 GB of RAM per step
pbx export all --jobs 1                  # one step at a time, in the order of ALL in pbx.mjs
```

A step starts once the steps it waits for are done (`after` in `ALL`, in `pbx.mjs`). The dry run shows the wait list of each step. With more than one job, each output line starts with `[step]`. After a failure no new step starts. The running steps finish, then the run stops. Each step's own pools (`export maps`, `export batch`, `export headgear`, the verify and ogg steps) run `PB_JOBS` workers: unless `PB_JOBS` is set, `max(2, cores / --jobs)`, so 3 each on a 12-core box with 4 steps.

**Incremental runs:**

```bash
pbx export all --dry-run                 # each step: [cached], or [run: reason]
pbx export all                           # run again with nothing changed: every step cached, seconds
pbx export all --force                   # rerun every step
pbx export all --force-step weapons,maps # rerun these, and the steps that wait for them
```

A step is cached when nothing it reads or writes changed since its last good run: its script and the local files it imports or names, its arguments, the paths and `PB_*` settings, the client folder, the `--server` and `--web` src trees (by stat), its output folders (by stat), and the steps it waits for. The state is `<extracted>/.pbx-state.json`. A failed or interrupted step is not recorded, so it runs again. A step whose output was deleted or edited runs again. `snapshot` runs only when an export step has changed. Verify, audit and ogg steps run when an export step ran. `--jobs` does not change the state.

Limits: a script that reads a file whose name it builds at run time is not tracked. A `--web` reader runs once more after a web step rewrote `src/`.

**Resume after an error:**

```bash
pbx export all --from weapons
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pbx: Point Blank 2017 (Kaybo): missing "...", expected at "..."` | the path under the client is wrong for this client version. Check the folder, or run `pbx init --clients <dir>` |
| `pbx: Point Blank Cross not set (needs ...)` | no clients folder (or no override) configured for that client. Run `pbx init --clients <dir>` |
| `pbx: not produced yet: "...extracted\pef-cross\br\...". Run pbx re cross-pef first` | a parsed input is missing. Run the `re` step the message names: `pbx re cross-pef` (Cross), `pbx re pef-config` (2017), `pbx re cross-pef --client <key>` (other keys) |
| `pbx: --client <key> writes the shared out/ folders: give it its own --out <dir>` | `export all` with a client other than Cross and no `--out`. Pass `--out <dir>` (or set `PB_ASSETS`) |
| `pbx: --client <key>: unknown client key` | the key is not in `CLIENTS` (`lib/paths.mjs`). Use one of the keys in [Client keys](#global-flags) |
| `pbx: needs --web <dir> (web app source)` or `needs --server <dir>` | the step reads or writes web app source or server data. Pass the flag, or skip the step |
| PFN1 packs are skipped | some 2017 packs use a format this tool does not decode (PFN1). Sniper and some sound packs keep fallback values in the export (see the comments in the script) |
| packs with internal `D:\...` paths fail to unpack | the pack records a build path on the developer's disk (e.g. `UI_Main.i3Pack`). Read it in memory with `parsePack` / `readI3R2` from `i3pack/unpack.mjs` instead of unpacking to disk |
| `ffmpeg 5.x refused` / `needs >= 6` | the `ffmpeg` binary is too old (the 2018 build pads the last Vorbis block). Run `npm install` (the bundled 6.1.1 is used), or point `FFMPEG` at a newer binary |
| `re` commands fail with `No module named capstone` | install Python 3 and `pip install capstone`. The `re` tools are optional |
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
