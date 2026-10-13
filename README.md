# pb-extract-tools

Command line tools (`pbx`) that read **your own copy** of the Point Blank client folders, unpack the `.i3Pack` archives and export models, animations, sounds, textures and UI to open formats (GLB, JSON, OGG, PNG, DDS). It is a private study tool. This repository contains no game files.

> **Português:** veja a [seção em português](#português) mais abaixo.

---

## English

### What it is

- One entry point, `pbx`, that runs one exporter per command. The exporters are plain Node ESM scripts with no runtime dependencies beyond `three` and `ffmpeg-static`.
- All paths come from one module, `lib/paths.mjs`. Nothing else hardcodes a client folder, `../..` or the output layout.
- Output goes to `./out` by default. The game folders are read in place and never written to.

### Requirements

| Thing | Version | Needed for |
|---|---|---|
| Node.js | **22.7 or newer** (uses native TypeScript stripping) | everything |
| npm | any recent | install |
| Python 3 + `capstone` | optional | the Python helpers in `re/` (`pbdis.py` needs `capstone`) |
| ffmpeg | 6.x or newer, bundled via `ffmpeg-static` (ships 6.1.1) | `sound` and OGG export |

Windows is the platform the tools are developed on. The Python `py` launcher is used on Windows, `python3` elsewhere.

### Install

```bash
git clone <repository-url>
cd pb-extract-tools
npm install
npm link          # optional: makes `pbx` available everywhere
```

### Quickstart

You need a copy of at least one client. The tools read these client versions (folder names are in the [Clients](#clients) table):

- **Point Blank 2017 "Kaybo"** (`PBKaybo\GameData\Apps\PB`): the reference for most exporters.
- **Point Blank Cross** (`PBCross`): the source for the 3D character and weapon exports, the 3PV/1PV animation libraries and the Cross UI.

```bash
pbx init --clients "C:\Games\PB\Clients"        # or straight to one client folder
pbx doctor                                       # what works on this machine
pbx re pef-config                                # Kaybo only: Script.i3Pack -> extracted/pef2017 (once)
pbx unpack "C:\Games\PB\Clients\PBKaybo\GameData\Apps\PB\Pack\Weapon_AUG_A3.i3Pack" --out out/unpacked
pbx export batch weapons --only "^aug_a3"        # one weapon family (base + skins); Cross or Kaybo
```

`export batch` reads the client that is configured (see [Client selection](#client-selection---client)). With Cross, run `pbx re cross-pef` once before `batch weapons` (the Cross weapon table, see the table of commands).

Where the output lands:

- `out/weapons/models/<id>.glb` and its textures in `out/weapons/models/tex/<id>/`
- `out/weapons/models/index.json` (one entry per weapon with its source client)
- `out/unpacked/` for `unpack`, `extracted/` for the `re` parsers

Run `pbx doctor` again after each step. It lists which command groups can run on this machine.

### Character with skeleton and animations in Blender

This is the path for a rigged character (mesh, skeleton, skin, textures) with its animation clips, plus its weapons. Checked on the Kaybo and Cross clients: the GLB JSON has one skin with 63 joints and the clips listed below. Blender itself was not run in that check; the import steps are the glTF standard, so verify them once in your Blender version.

**1. Configure and export the character**

```bash
pbx init --clients "C:\Games\PB\Clients"        # once (or the single client folder)
pbx doctor                                       # check the client is found
pbx export batch chars --only "^swat_male$"      # -> out/chars/swat_male/
```

`--only` takes a regular expression on the character name (`"^swat_male$"`, `"^hide"`). Without it, every character of the client is exported.

What lands in `out/chars/swat_male/`:

| File | What it is |
|---|---|
| `model.glb` | body mesh, skeleton (63 joints, one skin) and the animation clips of the SWAT_Male family, embedded as glTF animations (70 clips on Kaybo, 50 on Cross) |
| `arms_1pv.glb` | first-person arms: own skin and its 1PV clips embedded (30 clips on Kaybo, 13 on Cross) |
| `tex/` | the PNG maps the GLBs point to by relative path. Keep `tex/` next to the GLBs; the textures are not inside the GLB |

Other characters (for example `--only "^hide$"`) share the bone names of one of the two SWAT skeletons. Their GLB has its own skin and mesh, and its entry in `out/chars/index.json` has `clipsFrom: "swat_male"` (or `swat_female`): the clips are in that character's GLB. Add `--embed-clips` to embed the family clips into every character GLB (about 1.5 MB each).

**2. Load the character in Blender**

1. `File > Import > glTF 2.0 (.glb)` and choose `out/chars/swat_male/model.glb`. Blender creates an armature with the skinned mesh and one Action per embedded clip, named as in the GLB (for example `Low_Stand_Idle`, `Low_Stand_WalkFront`).
2. Pick an Action in the Action Editor (or the Animation workspace) to play it on the armature.
3. For the first-person arms, import `arms_1pv.glb` the same way.

**3. Weapons**

```bash
pbx export batch weapons --only "^aug_a3"        # -> out/weapons/models/<id>.glb
pbx export batch weapons --only "^aug_a3" --skins   # also the texture skins (<skin id>.glb)
```

- Each weapon is a static mesh: no skin, no animation. Import `out/weapons/models/<id>.glb` and attach it to the hand bone yourself. Its textures are PNGs in `out/weapons/models/tex/<id>/`.
- `pbx export weapon-anim` (Cross only) writes the weapon's own animation (magazine, slide, hammer) as JSON in `weapons/anim/` for the web app. There is no GLB clip to load in Blender.

**4. Animation libraries (Cross only)**

`anim3pv` and `anim1pv` write one animation-only GLB per clip group, plus an `index.json`. They are not embedded in `model.glb`.

```bash
pbx export batch chars --only "^swat_male$"      # first: the rig they bind to
pbx export anim3pv                               # -> out/chars/swat_male/anim3pv/
pbx export anim1pv                               # -> out/chars/swat_male/anim1pv/
```

| Output | Content |
|---|---|
| `anim3pv/index.json` | state -> clip key -> GLB file (`bundles`), weapon -> 3rd-person AI (`weapons`), blend and duration per state |
| `anim3pv/<Folder>_<Sub>.glb` | one GLB per clip folder, for example `AssultRifle5_Common.glb` (277 files, 1486 clips for SWAT_Male on Cross) |
| `anim1pv/index.json` | same layout for the first-person arm clips |
| `anim1pv/<Weapon>_<Sub>.glb` | one GLB per weapon AI, for example `Brass_Knuckle_Common.glb` |

Each clip GLB has no mesh and no skin. Its nodes are named after the bones of `model.glb`, so the clips bind by bone name. Blender imports them as plain nodes, not as an armature, so you bind them to the rig yourself (copy the keys onto the matching bone names). The web app does this at run time; there is no one-click Blender import for these libraries.

Both steps need `out/cross/weapons/weapons.json`, written by `pbx export weapons` (needs the 3.123 client and `--server`). `export all` runs `anim3pv` before `weapons`, so on a fresh `out/` run `weapons` first.

### Commands

Each row is one command. "Needs" lists the clients it reads and whether it needs `--web` (the web app source) or `--server` (game server data). Client keys are in [Clients](#clients). Where a step takes `--client`, see [Client selection](#client-selection---client).

| Command | What it does | Needs | Example |
|---|---|---|---|
| `pbx unpack` | extract `.i3Pack` files to a folder | 3.123 (only for a map name) | `pbx unpack Pack\Weapon_AUG_A3.i3Pack --out out/unpacked` |
| `pbx snapshot` | copy the assets a mass re-export rewrites, to revert later | none | `pbx snapshot` (revert: `pbx snapshot --restore`) |
| `pbx export batch` | characters and weapon models (+ `--skins`), `models/index.json` | Cross or Kaybo (`--client`) | `pbx export batch chars --only "^swat_male$"` |
| `pbx export model-dds` | DXT `.dds` next to model and character PNGs (after batch) | none | `pbx export model-dds` |
| `pbx export anim3pv` | 3rd-person clip library per character: `chars/<id>/anim3pv` | Cross; `weapons.json` from `export weapons` | `pbx export anim3pv` |
| `pbx export anim1pv` | 1st-person arm clips per character and weapon: `chars/<id>/anim1pv` | Cross; `weapons.json` from `export weapons` | `pbx export anim1pv` |
| `pbx export ui-idle` | showroom idle clips per character family | 2017 | `pbx export ui-idle` |
| `pbx export c5-bomb` | C5 brick GLBs and `models/index.json` entries (before weapon-anim) | Cross | `pbx export c5-bomb` |
| `pbx export weapon-anim` | weapon's own animation (magazine, slide, hammer): `weapons/anim/index.json` | Cross | `pbx export weapon-anim` |
| `pbx export weaponfx` | weapon effects: `weapons/fx/weaponfx.json` | Cross | `pbx export weaponfx` |
| `pbx export fxmesh` | mesh effect layers (shell casings) to GLB | Cross | `pbx export fxmesh` |
| `pbx export weapons` | weapon data and sounds for the web app | 3.123, `--server` | `pbx --server D:\game-server export weapons` |
| `pbx export weapon-sfx` | weapon sounds only: `weapons/sfx/index.json` (guessed roles) | Cross, 3.123 | `pbx export weapon-sfx` |
| `pbx export sfx` | weapon sounds by name: `weapons/sfx/pb2017.json` | Cross | `pbx export sfx` |
| `pbx export charsfx` | character, object and UI sounds: `sfx/char` | Cross | `pbx export charsfx` |
| `pbx export announce` | kill-mark announcer voice lines | Cross | `pbx export announce` |
| `pbx export c4-sfx` | C4 (bomb mode) sounds | Cross | `pbx export c4-sfx` |
| `pbx export break-sfx` | breakable object sounds | Cross | `pbx export break-sfx` |
| `pbx export radio-voice` | radio chat voice lines: `sfx/radio` | Cross | `pbx export radio-voice` |
| `pbx export ambient` | map ambient sounds: `maps/<map>/ambient.json` | Cross | `pbx export ambient` |
| `pbx export sound-rsc` | per-sound volume and distance table | Cross | `pbx export sound-rsc` |
| `pbx export headgear` | head accessories (masks, berets, helmets) to GLB | Cross, `--web` | `pbx --web D:\web-app export headgear` |
| `pbx export ragdoll` | death ragdoll data: `chars/<id>/ragdoll.json` | Cross (from the character packs) | `pbx export ragdoll` |
| `pbx export maps` | every playable map: visual, collision, `maps/index.json` | Cross | `pbx export maps` |
| `pbx export visual` | one map render scene to `visual.glb` | Cross | `pbx export visual NStation` |
| `pbx export collision` | one map collision to `collision.glb` and `.json` | Cross | `pbx export collision NStation --out out/maps` |
| `pbx export surfaces` | impact surface per shape: `surfaces.json` (needs collision) | every client folder it finds | `pbx export surfaces NStation` |
| `pbx export lighting` | per-map `lighting.json` | Cross | `pbx export lighting` |
| `pbx export env-ref` | reflection cubemap `env_ref.dds` (needs lighting) | none | `pbx export env-ref` |
| `pbx export props` | GINS props: `objects/<id>.glb` and `maps/<map>/props.json` | Cross | `pbx export props` |
| `pbx export map-dds` | DXT `tex/<name>.dds` next to map PNGs (after maps) | Cross | `pbx export map-dds` |
| `pbx export bombsites` | bomb sites A/B per stage (Cross stages first, 2017 for the rest): `cross/maps/bombsites.json` | 2017, Cross | `pbx export bombsites` |
| `pbx export navgraph` | bot navigation graph: `maps/<map>/navgraph.bin` (after maps) | `--web` | `pbx --web D:\web-app export navgraph` |
| `pbx export missions` | mission cards to `missionData.ts` (in `out/generated` without `--web`) | 2017, 3.123, `--web`, `--server` | `pbx --web D:\web-app --server D:\game-server export missions` |
| `pbx export titles` | designation table to `titleData.ts` (same rule) | 2017, `--server` | `pbx export titles` |
| `pbx export match-data` | server match data to `matchData.json` (same rule) | `--web`, `--server` | `pbx --web D:\web-app --server D:\game-server export match-data` |
| `pbx export bloodtex` | procedural HD blood sprites (deterministic; needs `SHARP_FROM`) | none | `SHARP_FROM=D:\tools\package.json pbx export bloodtex` |
| `pbx export lod` | low-resolution mirror of weapon and character GLBs (not in `export all`) | none | `pbx export lod` |
| `pbx ui scenes` | i3UIs scenes to `ui/scenes/<ver>/` | 3.123, 2017 | `pbx ui scenes` |
| `pbx ui templates` | control templates to `ui/templates/<ver>.json` | 3.123, 2017 | `pbx ui templates` |
| `pbx ui strings` | pt-BR strings to `ui/strings/pt-BR.json` | 3.123 | `pbx ui strings` |
| `pbx ui lua` | scene Lua to `ui/strings/scene-bindings.json` | 2017 | `pbx ui lua` |
| `pbx ui atlas` | atlas sheets per scene (crops of source rectangles) | 2017, 3.123 | `pbx ui atlas` |
| `pbx ui icons` | item id to V12 icon cell | 3.123 | `pbx ui icons` |
| `pbx ui compose` | render a scene to PNG for review, no browser | `--web` | `pbx --web D:\web-app ui compose` |
| `pbx ui hud-2017` | in-game HUD textures and minimaps (`--check` to validate) | 2017, 3.123, Portable, Cross | `pbx ui hud-2017 --check` |
| `pbx ui hud-countdown` | round countdown digits | Portable 3.1 | `pbx ui hud-countdown` |
| `pbx ui respawn-result` | respawn result window to an i3Gui tree and atlases | 2017 | `pbx ui respawn-result` |
| `pbx ui loading` | battle loading screen art | 2017, 3.123 | `pbx ui loading` |
| `pbx ui hyper-rank` | Hyper scoreboard rank icon | Hyper | `pbx ui hyper-rank` |
| `pbx ui classic-ui` | i3Gui windows to `ui/classic` (EpicBlackout) or `ui/cross` (`--client cross`) | EpicBlackout | `pbx ui classic-ui` |
| `pbx ui epic-brand` | EpicBlackout branding images | EpicBlackout | `pbx ui epic-brand` |
| `pbx ui cross-hud` | battle HUD sheets, kill icons and minimaps to `ui/cross-hud/` | Cross | `pbx ui cross-hud` |
| `pbx ui clanmark` | clan mark atlas to `ui/clanmark/` | Cross | `pbx ui clanmark` |
| `pbx ui cross-icons` | Cross item, map and card icons to `ui/cross/icons/` | Cross, 3.123 | `pbx ui cross-icons` |
| `pbx ui cross-bgm` | Cross lobby music to `sfx/cross/*.ogg` | Cross | `pbx ui cross-bgm` |
| `pbx ui cross-showroom` | Cross 3D showroom to `ui/cross/showroom/` | Cross | `pbx ui cross-showroom` |
| `pbx sound convert` | `.ogg` twin for every `.wav` under the assets folder | none | `pbx sound convert` |
| `pbx sound verify` | check each `.wav` against its `.ogg` twin (`--loops` by default) | none | `pbx sound verify` |
| `pbx verify assets` | index and GLB regressions against the snapshot (exit 1 on regression) | none | `pbx verify assets` |
| `pbx verify audit-weapons` | which weapons are playable with the exported 2017 assets | none | `pbx verify audit-weapons` |
| `pbx verify audit-charas` | which characters and equipment parts are complete | `--web` | `pbx --web D:\web-app verify audit-charas` |
| `pbx verify audit-items` | which shop items are complete | 2017, `--web` | `pbx --web D:\web-app verify audit-items` |
| `pbx verify audit-weapon-anim` | weapon animation states against the web app (`--all`) | none | `pbx verify audit-weapon-anim --all` |
| `pbx re pef-config` | 2017 `Script.i3Pack` to `extracted/pef2017/` (weapon and config tables) | 2017 | `pbx re pef-config` |
| `pbx re cross-pef` | Cross `Script.i3Pack` to `extracted/pef-cross/br` (Cross weapon table, before weapons and bombsites) | Cross; also reads `re pef-config` output and `out/config/character.json` (3.123 table; no pbx step writes it yet) | `pbx re cross-pef` |
| `pbx re fpscam` | bake the first-person camera pivot | 2017 | `pbx re fpscam` |

`pbx help` prints the same table from the code, with the same "Needs" column.

### Global flags

Put these **before** the group name. They are not passed to the script, so a script's own `--out` (for example `unpack`) keeps working.

```bash
pbx --clients "D:\Clients" --out "D:\pb-assets" export sfx
```

| Flag | Environment variable | `pbx.config.json` key | Default | What it is |
|---|---|---|---|---|
| `--clients <dir>` | `PB_CLIENTS` | `clients` | none (required) | folder that holds the client folders |
| `--client <key>=<dir>` (in `init`) | `PB_CLIENT_<KEY>` | `overrides.<key>` | derived | one client folder, when not all sit under one root |
| `--out <dir>` | `PB_ASSETS` | `assets` | `./out` | assets output (what the web app loads) |
| `--web <dir>` | `PB_WEB` | `web` | none | folder of the web project that consumes the assets (has `src/`). Enables steps that read or write it |
| `--server <dir>` | `PB_SERVER` | `server` | none | server root with `server/` and `old/` (game server data). Enables steps that read it |
| `--extracted <dir>` | `PB_EXTRACTED` | `extracted` | `./extracted` | parsed JSON that other steps read |
| `--snapshots <dir>` | `PB_SNAPSHOTS` | `snapshots` | `./snapshots` | snapshots for `snapshot` and `verify assets` |

Precedence: flag, then environment, then `pbx.config.json`, then the default. Relative paths resolve from the folder you run `pbx` in. `pbx init` writes absolute paths.

Client keys: `kaybo` (2017), `br3123` (3.123), `cross`, `ru`, `portable`, `hyper`, `blackout`.

### Clients

| Key | Folder under the clients root | Version | What the tools read from it |
|---|---|---|---|
| `kaybo` | `PBKaybo\GameData\Apps\PB` | Point Blank 2017 (Kaybo) | the reference for most exporters: sounds, maps, HUD, UI scenes, the 2017 weapon and config tables (`pef-config`) |
| `br3123` | `PointBlank 3.123` | Point Blank 3.123 (BR) | weapon data for the web app (`export weapons`), `unpack` default, UI strings and icons, HUD and loading art |
| `cross` | `PBCross` | Point Blank Cross | characters and weapon models (`batch`), 3PV and 1PV animations, weapon FX and animation, Cross UI, icons, lobby music, showroom, clan marks, bomb sites, maps |
| `ru` | `PB RUSSIA` | Point Blank Russia | not read by any step yet |
| `portable` | `Point-Blank-Portable\3-PointBlank` | Point Blank Portable 3.1 | round countdown HUD, HUD textures (`ui hud-2017`) |
| `hyper` | `Point Blank Hyper` | Point Blank Hyper | scoreboard rank icon |
| `blackout` | `EpicBlackout` | EpicBlackout (2014) | classic UI windows and branding images |

The version is a guess from the folder. Confirm it in the game before you rely on an export. `pbx doctor` shows which folder each key points to.

### Client selection (`--client`)

A step that reads a client's originals takes the client from `baseClient()` in `lib/paths.mjs`:

1. `--client <key>` after the step name, or `PB_BASE_CLIENT=<key>` for the whole run.
2. Without either, the first configured client the step supports, in this order: `cross`, `kaybo`, `br3123`, `ru`, `portable`, `hyper`, `blackout`. If only one client is configured, that one is used.

```bash
pbx export batch chars --client kaybo
PB_BASE_CLIENT=cross pbx export batch weapons
```

Most steps read one client's file format, so each accepts one key. `--client` with another key stops with a message that names the client the step reads (`Point Blank Cross format only, not ...`). An unknown key stops with `--client <key>: unknown client key`.

| Command | Reads | `--client` |
|---|---|---|
| `export batch` | Cross or Kaybo, one client per run | `cross`, `kaybo` |
| `export anim3pv`, `anim1pv`, `c5-bomb`, `weapon-anim`, `weaponfx`, `fxmesh`, `headgear`, `sfx`, `charsfx`, `announce`, `c4-sfx`, `break-sfx`, `ambient`, `radio-voice`, `sound-rsc`, `props`, `visual`, `collision` | Cross | `cross` only |
| `export weapons`, `ui icons`, `unpack` (map name) | 3.123 | `br3123` only |
| `ui respawn-result`, `ui lua`, `verify audit-items`, `re pef-config` | 2017 (Kaybo) | `kaybo` only |
| `ui hud-countdown` | Portable 3.1 | `portable` only |
| `ui hyper-rank` | Hyper | `hyper` only |
| `ui classic-ui`, `ui epic-brand` | EpicBlackout (`ui classic-ui --client cross` writes the Cross windows) | `blackout` (`cross` for `classic-ui`) |
| `export maps`, `lighting`, `map-dds`, `ui cross-hud`, `ui clanmark`, `ui cross-bgm`, `ui cross-showroom`, `ui cross-icons`, `re cross-pef` | Cross folder, fixed | ignored |
| `export ui-idle`, `export missions`, `export titles`, `export surfaces`, `export bombsites`, `ui hud-2017`, `ui loading`, `ui strings` | several client folders, fixed | ignored |

`pbx export all` still checks the configured clients when it skips steps. `--client` applies per step, not to `export all` as a whole.

Provenance text inside the output JSON (`source` fields) still names the original folder.

### Output formats

| Output | Format | Written by |
|---|---|---|
| characters and weapon models | GLB (glTF 2.0 binary); textures as PNG beside it in `tex/` | `export batch`, `anim3pv`, `anim1pv`, `c5-bomb`, `headgear`, `ui-idle` |
| character clips | embedded in `model.glb` (family clips); animation-only GLB bundles for the libraries | `export batch` (embedded), `anim3pv`, `anim1pv` (bundles) |
| textures for models | DXT `.dds` next to PNG | `model-dds`, `map-dds`, `env-ref`, `visual`, `cross-showroom` |
| map geometry | `visual.glb`, `collision.glb` + `collision.json`, `surfaces.json`, `lighting.json`, `props.json` | `maps`, `visual`, `collision`, `surfaces`, `lighting`, `props`, `env-ref` |
| clip indexes and data | JSON (`index.json`, `ragdoll.json`, `weaponfx.json`, `ambient.json`, weapon-anim `lib/*.json`) | `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `ragdoll`, `ambient`, `sound-rsc` |
| sounds | `.wav` (source), `.ogg` (Vorbis, what the browser plays) | `sfx`, `charsfx`, `announce`, `c4-sfx`, `break-sfx`, `radio-voice`, `wav-to-ogg` (`sound convert`) |
| UI | PNG atlases + JSON (scenes, templates, strings, Lua bindings) | `ui *`, `classic-ui`, `clanmark`, `cross-icons` |
| web source | `.ts` / `.json` written into `src/` with `--web`, else into `out/generated/` (said out loud) | `missions`, `titles`, `match-data`, `sound-rsc`, `fpscam` |
| raw parsed data | JSON in `extracted/` | `re pef-config`, `re cross-pef`, `unpack` (into the folder you give) |

### Recipes

**Export the whole pipeline (dry run first):**

```bash
pbx export all --dry-run                 # lists the 54 steps; marks the ones that will be skipped
pbx snapshot                             # copy what the mass re-export rewrites
pbx export all                           # runs in order; stops at the first error and prints --from to resume
pbx verify assets                        # regressions against the snapshot
```

A step whose client is missing, or which needs `--web` or `--server` without it, is skipped with a line that says why. The run continues and ends with a summary.

**Resume after an error:**

```bash
pbx export all --from weapons
```

**Two clients, two outputs:** `export batch` writes `chars/<id>` and `weapons/models/<id>` and replaces the `index.json` of each part. Use one `--out` folder per client (`pbx --out D:\pb-cross export batch`, `pbx --out D:\pb-kaybo export batch`) so the two do not overwrite each other.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pbx: Point Blank 2017 (Kaybo): missing "...", expected at "..."` | the path under the client is wrong for this client version. Check the folder, or run `pbx init --clients <dir>` |
| `pbx: client not set (needs ...)` | no clients folder configured. Run `pbx init --clients <dir>` |
| `pbx: this step reads Point Blank Cross only, and that folder is not configured ...` | the step reads one client's format and that client is not configured. Add it with `pbx init --client cross=<dir>`, or skip the step |
| `pbx: --client <key>: unknown client key` / `... format only, not ...` | the key is not valid for this step. Use one of the keys the message lists |
| `pbx: not produced yet: "...extracted\pef-cross\br\Weapon.json"` | a parsed input is missing. Run the named `re` step once (`pbx re cross-pef` for Cross, `pbx re pef-config` for Kaybo) |
| `pbx: not found: "...cross\weapons\weapons.json"` | `anim3pv` and `anim1pv` need the Cross weapon list. Run `pbx --server <dir> export weapons` first |
| `pbx: needs --web <dir> (web app source)` or `needs --server <dir>` | the step reads or writes web app source or server data. Pass the flag, or skip the step |
| PFN1 packs are skipped | some 2017 packs use a format this tool does not decode (PFN1). Sniper and some sound packs keep fallback values in the export (see the comments in the script) |
| packs with internal `D:\...` paths fail to unpack | the pack records a build path on the developer's disk (e.g. `UI_Main.i3Pack`). Read it in memory with `parsePack` / `readI3R2` from `i3pack/unpack.mjs` instead of unpacking to disk |
| `ffmpeg 5.x refused` / `needs >= 6` | the `ffmpeg` binary is too old (the 2018 build pads the last Vorbis block). Run `npm install` (the bundled 6.1.1 is used), or point `FFMPEG` at a newer binary |
| `re/pbdis.py` fails with `No module named capstone` | install Python 3 and `pip install capstone`. The Python tools are optional |
| `bloodtex` fails with `needs sharp` | set `SHARP_FROM` to a `package.json` whose `node_modules` contain `sharp` |
| `Node 22.7` or older errors on `.mjs` | update Node. The tools use native TypeScript stripping for the `--experimental-transform-types` flag |

### For AI agents

- Read `pbx help` and `pbx doctor` before anything else. Only run commands whose "Needs" column is satisfied.
- Dry run first: `pbx export all --dry-run`. Show the list before a mass export.
- Snapshot before any mass re-export: `pbx snapshot`. Revert with `pbx snapshot --restore`.
- Never run `pbx export all` without asking the user. It rewrites many files in `out/`.
- One asset: `pbx export <name>` (for example `pbx export sfx`). Check the "Needs" column first.
- After an export: `pbx verify assets`. Exit code 1 means a regression against the snapshot.
- Do not accept a recreated sound or effect until you have checked the original in the 2017 client's `Pack` folder (see `CLAUDE.md`).
- Most exported JSON records its source (`source`, `tool`, `generated`). Keep those fields.

### Legal

This repository contains **no game assets, no game executables and no decompiled game code**. The tools only read copies of the game folders that you own. Point Blank, its formats and its assets belong to their rights holders (Zepetto). Use the output for private study and testing. Do not redistribute exported assets.

---

## Português

### O que é

- Uma só entrada, `pbx`, que roda um exportador por comando. Os exportadores são scripts Node ESM simples, com dependências de runtime apenas `three` e `ffmpeg-static`.
- Todos os caminhos vêm de um módulo, `lib/paths.mjs`. Nenhum outro arquivo fixa pasta de cliente, `../..` ou o layout de saída.
- A saída vai para `./out` por padrão. As pastas do jogo são lidas no lugar e nunca são escritas.

### Requisitos

| Item | Versão | Para quê |
|---|---|---|
| Node.js | **22.7 ou mais novo** (usa remoção nativa de tipos TypeScript) | tudo |
| npm | qualquer recente | instalar |
| Python 3 + `capstone` | opcional | os auxiliares Python em `re/` (`pbdis.py` precisa de `capstone`) |
| ffmpeg | 6.x ou mais novo, trazido por `ffmpeg-static` (vem com 6.1.1) | `sound` e exportação OGG |

As ferramentas são desenvolvidas no Windows. Usa-se o lançador `py` no Windows e `python3` nos demais.

### Instalação

```bash
git clone <url-do-repositorio>
cd pb-extract-tools
npm install
npm link          # opcional: deixa `pbx` disponível em qualquer pasta
```

### Início rápido

Você precisa de uma cópia de pelo menos um cliente. As ferramentas leem estas versões (os nomes das pastas estão na tabela [Clientes](#clientes)):

- **Point Blank 2017 "Kaybo"** (`PBKaybo\GameData\Apps\PB`): a referência da maioria dos exportadores.
- **Point Blank Cross** (`PBCross`): a fonte dos modelos 3D de personagens e armas, das bibliotecas de animação 3PV/1PV e da UI do Cross.

```bash
pbx init --clients "C:\Games\PB\Clients"        # ou direto na pasta de um cliente
pbx doctor                                       # o que funciona nesta máquina
pbx re pef-config                                # só Kaybo: Script.i3Pack -> extracted/pef2017 (uma vez)
pbx unpack "C:\Games\PB\Clients\PBKaybo\GameData\Apps\PB\Pack\Weapon_AUG_A3.i3Pack" --out out/unpacked
pbx export batch weapons --only "^aug_a3"        # uma família de arma (base + skins); Cross ou Kaybo
```

O `export batch` lê o cliente configurado (veja [Seleção de cliente](#seleção-de-cliente---client)). Com o Cross, rode `pbx re cross-pef` uma vez antes de `batch weapons` (a tabela de armas do Cross; veja a tabela de comandos).

Onde a saída cai:

- `out/weapons/models/<id>.glb` e as texturas em `out/weapons/models/tex/<id>/`
- `out/weapons/models/index.json` (uma entrada por arma, com o cliente de origem)
- `out/unpacked/` para `unpack`; `extracted/` para os leitores `re`

Rode `pbx doctor` de novo depois de cada passo. Ele mostra quais grupos de comando funcionam nesta máquina.

### Personagem com esqueleto e animações no Blender

Este é o caminho para um personagem com rig (malha, esqueleto, skin, texturas) e seus clipes de animação, além das armas. Verificado nos clientes Kaybo e Cross: o JSON do GLB tem um skin com 63 juntas e os clipes listados abaixo. O Blender em si não foi executado nessa verificação; os passos de importação são o padrão glTF, então confirme uma vez na sua versão do Blender.

**1. Configurar e exportar o personagem**

```bash
pbx init --clients "C:\Games\PB\Clients"        # uma vez (ou a pasta do cliente único)
pbx doctor                                       # confirme que o cliente é achado
pbx export batch chars --only "^swat_male$"      # -> out/chars/swat_male/
```

`--only` aceita uma expressão regular sobre o nome do personagem (`"^swat_male$"`, `"^hide"`). Sem ele, exporta todos os personagens do cliente.

O que cai em `out/chars/swat_male/`:

| Arquivo | O que é |
|---|---|
| `model.glb` | malha do corpo, esqueleto (63 juntas, um skin) e os clipes de animação da família SWAT_Male, embutidos como animações glTF (70 clipes no Kaybo, 50 no Cross) |
| `arms_1pv.glb` | braços em primeira pessoa: skin próprio e seus clipes 1PV embutidos (30 no Kaybo, 13 no Cross) |
| `tex/` | os mapas PNG que os GLB apontam por caminho relativo. Mantenha `tex/` junto dos GLB; as texturas não ficam dentro do GLB |

Outros personagens (por exemplo `--only "^hide$"`) compartilham os nomes de osso de um dos dois esqueletos SWAT. O GLB deles tem skin e malha próprios, e a entrada em `out/chars/index.json` tem `clipsFrom: "swat_male"` (ou `swat_female`): os clipes estão no GLB desse personagem. Use `--embed-clips` para embutir os clipes da família em cada GLB de personagem (cerca de 1,5 MB cada).

**2. Carregar o personagem no Blender**

1. `File > Import > glTF 2.0 (.glb)` e escolha `out/chars/swat_male/model.glb`. O Blender cria um armature com a malha com skin e uma Action por clipe embutido, com o nome do GLB (por exemplo `Low_Stand_Idle`, `Low_Stand_WalkFront`).
2. Escolha uma Action no Action Editor (ou no workspace Animation) para tocar no armature.
3. Para os braços em primeira pessoa, importe `arms_1pv.glb` do mesmo jeito.

**3. Armas**

```bash
pbx export batch weapons --only "^aug_a3"        # -> out/weapons/models/<id>.glb
pbx export batch weapons --only "^aug_a3" --skins   # também os skins de textura (<id do skin>.glb)
```

- Cada arma é uma malha estática: sem skin, sem animação. Importe `out/weapons/models/<id>.glb` e prenda na junta da mão por conta própria. As texturas são PNG em `out/weapons/models/tex/<id>/`.
- `pbx export weapon-anim` (só Cross) grava a animação própria da arma (carregador, corrediça, martelo) em JSON, em `weapons/anim/`, para o cliente web. Não há clipe GLB para carregar no Blender.

**4. Bibliotecas de animação (só Cross)**

`anim3pv` e `anim1pv` gravam um GLB só de animação por grupo de clipes, mais um `index.json`. Não ficam embutidos no `model.glb`.

```bash
pbx export batch chars --only "^swat_male$"      # antes: o rig onde elas se prendem
pbx export anim3pv                               # -> out/chars/swat_male/anim3pv/
pbx export anim1pv                               # -> out/chars/swat_male/anim1pv/
```

| Saída | Conteúdo |
|---|---|
| `anim3pv/index.json` | estado -> chave do clipe -> arquivo GLB (`bundles`), arma -> IA em terceira pessoa (`weapons`), mistura e duração por estado |
| `anim3pv/<Pasta>_<Sub>.glb` | um GLB por pasta de clipes, por exemplo `AssultRifle5_Common.glb` (277 arquivos, 1486 clipes do SWAT_Male no Cross) |
| `anim1pv/index.json` | mesmo layout para os clipes de braço em primeira pessoa |
| `anim1pv/<Arma>_<Sub>.glb` | um GLB por IA de arma, por exemplo `Brass_Knuckle_Common.glb` |

Cada GLB de clipe não tem malha nem skin. Os nós têm o nome dos ossos do `model.glb`, então os clipes se prendem pelo nome do osso. O Blender importa como nós simples, não como armature, então você prende ao rig (copie as chaves para os ossos de mesmo nome). O cliente web faz isso em tempo de execução; não há importação de um clique no Blender para essas bibliotecas.

As duas etapas precisam de `out/cross/weapons/weapons.json`, gravado por `pbx export weapons` (precisa do cliente 3.123 e de `--server`). O `export all` roda `anim3pv` antes de `weapons`, então numa `out/` nova rode `weapons` primeiro.

### Comandos

A tabela de comandos está na seção em inglês acima (mesmos comandos, mesma coluna "Needs"). `pbx help` imprime a mesma tabela a partir do código.

### Flags globais

Coloque estas flags **antes** do nome do grupo. Elas não são repassadas ao script, então o `--out` próprio de um script (por exemplo `unpack`) continua funcionando.

| Flag | Variável de ambiente | Chave no `pbx.config.json` | Padrão | O que é |
|---|---|---|---|---|
| `--clients <dir>` | `PB_CLIENTS` | `clients` | nenhum (obrigatório) | pasta que contém as pastas dos clientes |
| `--client <chave>=<dir>` (no `init`) | `PB_CLIENT_<CHAVE>` | `overrides.<chave>` | derivado | uma pasta de cliente, quando não estão todas sob uma raiz |
| `--out <dir>` | `PB_ASSETS` | `assets` | `./out` | saída dos assets (o que o cliente web carrega) |
| `--web <dir>` | `PB_WEB` | `web` | nenhum | pasta do projeto web que consome os assets (tem `src/`). Habilita os passos que leem ou escrevem nela |
| `--server <dir>` | `PB_SERVER` | `server` | nenhum | raiz do servidor com `server/` e `old/` (dados do servidor do jogo). Habilita os passos que leem nela |
| `--extracted <dir>` | `PB_EXTRACTED` | `extracted` | `./extracted` | JSON parseado que outros passos leem |
| `--snapshots <dir>` | `PB_SNAPSHOTS` | `snapshots` | `./snapshots` | snapshots para `snapshot` e `verify assets` |

Ordem: flag, depois variável de ambiente, depois `pbx.config.json`, depois o padrão. Caminhos relativos saem da pasta onde você roda o `pbx`. O `pbx init` grava caminhos absolutos.

Chaves de cliente: `kaybo` (2017), `br3123` (3.123), `cross`, `ru`, `portable`, `hyper`, `blackout`.

### Clientes

| Chave | Pasta sob a raiz de clientes | Versão | O que as ferramentas leem |
|---|---|---|---|
| `kaybo` | `PBKaybo\GameData\Apps\PB` | Point Blank 2017 (Kaybo) | referência da maioria dos exportadores: sons, mapas, HUD, cenas de UI, as tabelas de arma e configuração de 2017 (`pef-config`) |
| `br3123` | `PointBlank 3.123` | Point Blank 3.123 (BR) | dados de arma para o cliente web (`export weapons`), padrão do `unpack`, textos e ícones de UI, arte de HUD e carregamento |
| `cross` | `PBCross` | Point Blank Cross | modelos de personagem e arma (`batch`), animações 3PV e 1PV, FX e animação de arma, UI do Cross, ícones, música do lobby, showroom, marcas de clã, locais de bomba, mapas |
| `ru` | `PB RUSSIA` | Point Blank Russia | nenhum passo lê ainda |
| `portable` | `Point-Blank-Portable\3-PointBlank` | Point Blank Portable 3.1 | HUD de contagem regressiva, texturas de HUD (`ui hud-2017`) |
| `hyper` | `Point Blank Hyper` | Point Blank Hyper | ícone de patente do placar |
| `blackout` | `EpicBlackout` | EpicBlackout (2014) | janelas de UI clássica e imagens de marca |

A versão é um palpite pela pasta. Confirme no jogo antes de confiar numa exportação. `pbx doctor` mostra para qual pasta cada chave aponta.

### Seleção de cliente (`--client`)

Um passo que lê os originais de um cliente pega o cliente de `baseClient()` em `lib/paths.mjs`:

1. `--client <chave>` depois do nome do passo, ou `PB_BASE_CLIENT=<chave>` para a execução toda.
2. Sem nenhum dos dois, o primeiro cliente configurado que o passo suporta, nesta ordem: `cross`, `kaybo`, `br3123`, `ru`, `portable`, `hyper`, `blackout`. Se só um cliente estiver configurado, ele é usado.

```bash
pbx export batch chars --client kaybo
PB_BASE_CLIENT=cross pbx export batch weapons
```

A maioria dos passos lê o formato de arquivo de um cliente só, então cada um aceita uma chave. `--client` com outra chave para com uma mensagem que diz qual cliente o passo lê (`Point Blank Cross format only, not ...`). Chave desconhecida para o erro `--client <chave>: unknown client key`.

A tabela de quais passos aceitam `--client` está na seção em inglês. Nos passos de pasta fixa, `--client` é ignorado.

### Formatos de saída

| Saída | Formato | Quem grava |
|---|---|---|
| personagens e modelos de arma | GLB (glTF 2.0 binário); texturas PNG ao lado, em `tex/` | `export batch`, `anim3pv`, `anim1pv`, `c5-bomb`, `headgear`, `ui-idle` |
| clipes de personagem | embutidos no `model.glb` (família); GLB só de animação nas bibliotecas | `export batch` (embutido), `anim3pv`, `anim1pv` (pacotes) |
| texturas de modelo | DXT `.dds` ao lado do PNG | `model-dds`, `map-dds`, `env-ref`, `visual`, `cross-showroom` |
| geometria de mapa | `visual.glb`, `collision.glb` + `collision.json`, `surfaces.json`, `lighting.json`, `props.json` | `maps`, `visual`, `collision`, `surfaces`, `lighting`, `props`, `env-ref` |
| índices e dados de clipe | JSON (`index.json`, `ragdoll.json`, `weaponfx.json`, `ambient.json`, `lib/*.json` do weapon-anim) | `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `ragdoll`, `ambient`, `sound-rsc` |
| sons | `.wav` (origem), `.ogg` (Vorbis, o que o navegador toca) | `sfx`, `charsfx`, `announce`, `c4-sfx`, `break-sfx`, `radio-voice`, `wav-to-ogg` (`sound convert`) |
| UI | atlas PNG + JSON (cenas, templates, textos, ligações Lua) | `ui *`, `classic-ui`, `clanmark`, `cross-icons` |
| código do web | `.ts` / `.json` gravados em `src/` com `--web`, senão em `out/generated/` (avisado) | `missions`, `titles`, `match-data`, `sound-rsc`, `fpscam` |
| dados brutos parseados | JSON em `extracted/` | `re pef-config`, `re cross-pef`, `unpack` (na pasta que você der) |

### Receitas

**Exportar o pipeline inteiro (primeiro simulação):**

```bash
pbx export all --dry-run                 # lista os 54 passos; marca os que serão pulados
pbx snapshot                             # copia o que a re-exportação em massa reescreve
pbx export all                           # roda em ordem; para no primeiro erro e mostra --from para retomar
pbx verify assets                        # regressões contra o snapshot
```

Um passo cujo cliente falta, ou que precisa de `--web` ou `--server` sem ele, é pulado com uma linha dizendo o motivo. A execução continua e termina com um resumo.

**Dois clientes, duas saídas:** o `export batch` grava `chars/<id>` e `weapons/models/<id>` e troca o `index.json` de cada parte. Use uma pasta `--out` por cliente (`pbx --out D:\pb-cross export batch`, `pbx --out D:\pb-kaybo export batch`) para um não sobrescrever o outro.

**Retomar depois de um erro:**

```bash
pbx export all --from weapons
```

### Solução de problemas

| Sintoma | Causa e correção |
|---|---|
| `pbx: Point Blank 2017 (Kaybo): missing "...", expected at "..."` | o caminho dentro do cliente está errado para esta versão. Confira a pasta ou rode `pbx init --clients <dir>` |
| `pbx: client not set (needs ...)` | nenhuma pasta de clientes configurada. Rode `pbx init --clients <dir>` |
| `pbx: this step reads Point Blank Cross only, and that folder is not configured ...` | o passo lê o formato de um cliente e esse cliente não está configurado. Adicione com `pbx init --client cross=<dir>`, ou pule o passo |
| `pbx: --client <chave>: unknown client key` / `... format only, not ...` | a chave não vale para este passo. Use uma das chaves que a mensagem lista |
| `pbx: not produced yet: "...extracted\pef-cross\br\Weapon.json"` | falta uma entrada parseada. Rode o passo `re` indicado (`pbx re cross-pef` para Cross, `pbx re pef-config` para Kaybo) |
| `pbx: not found: "...weapons.json"` em `anim3pv` ou `anim1pv` | essas etapas precisam da lista de armas do Cross. Rode antes `pbx --server <dir> export weapons` |
| `pbx: needs --web <dir>` ou `needs --server <dir>` | o passo lê ou escreve código-fonte do app web ou dados do servidor. Passe a flag ou pule o passo |
| packs PFN1 são pulados | alguns packs de 2017 usam um formato que esta ferramenta não decodifica (PFN1). Packs de sniper e de alguns sons mantêm valores de reserva. Veja os comentários do script |
| packs com caminhos internos `D:\...` falham ao descompactar | o pack guarda um caminho de build do disco do desenvolvedor (ex.: `UI_Main.i3Pack`). Leia em memória com `parsePack` / `readI3R2` de `i3pack/unpack.mjs`, em vez de descompactar no disco |
| `ffmpeg 5.x refused` / `needs >= 6` | o binário `ffmpeg` é antigo (o build de 2018 preenche o último bloco Vorbis). Rode `npm install` (usa o 6.1.1 incluído), ou aponte `FFMPEG` para um binário mais novo |
| `re/pbdis.py` falha com `No module named capstone` | instale Python 3 e `pip install capstone`. As ferramentas Python são opcionais |
| `bloodtex` falha com `needs sharp` | defina `SHARP_FROM` com um `package.json` cujo `node_modules` tenha `sharp` |
| erro em `.mjs` com Node 22.7 ou mais antigo | atualize o Node. As ferramentas usam remoção nativa de TypeScript (flag `--experimental-transform-types`) |

### Para agentes de IA

- Leia `pbx help` e `pbx doctor` antes de tudo. Rode só comandos cuja coluna "Needs" esteja atendida.
- Simulação primeiro: `pbx export all --dry-run`. Mostre a lista antes de uma exportação em massa.
- Snapshot antes de qualquer re-exportação em massa: `pbx snapshot`. Reverter: `pbx snapshot --restore`.
- Nunca rode `pbx export all` sem perguntar ao usuário. Ele reescreve muitos arquivos em `out/`.
- Um asset só: `pbx export <nome>` (ex.: `pbx export sfx`). Confira antes a coluna "Needs".
- Depois de exportar: `pbx verify assets`. Código de saída 1 significa regressão contra o snapshot.
- Não aceite um som ou efeito recriado antes de conferir o original na pasta `Pack` do cliente 2017 (ver `CLAUDE.md`).
- A maioria dos JSON exportados grava a origem (`source`, `tool`, `generated`). Mantenha esses campos.

### Legal

Este repositório **não contém assets do jogo, executáveis do jogo nem código decompilado**. As ferramentas só leem cópias das pastas do jogo que você possui. Point Blank, seus formatos e seus assets pertencem aos respectivos titulares (Zepetto). Use a saída para estudo privado e testes. Não redistribua os assets exportados.
