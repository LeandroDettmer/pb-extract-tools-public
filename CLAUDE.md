# CLAUDE.md — pb-extract-tools

`pbx` reads Point Blank client folders the user owns and exports them to open formats (GLB, PNG, DDS, OGG, JSON, TS). The web client in `point-blank-webport` consumes the output. Read `README.md` first: commands, flags, clients, output formats, troubleshooting.

Nothing in this repository is game data. Keep it that way.

## Layout

| Path | What it is |
|---|---|
| `pbx.mjs` | CLI entry. Dispatches the `export`, `re`, `snapshot`, `verify`, `sound`, `unpack` commands |
| `export-*.mjs`, `audit-*.mjs`, `ui-export/` | one exporter per output family |
| `lib/paths.mjs` | the only place that knows where clients, assets, the web app and the server live |
| `pef/`, `pef-cross.mjs`, `re/` | reverse-engineering helpers that parse the client's PEF tables and binaries |
| `i3pack/`, `i3r2/`, `iia2/`, `i3gui/` | readers for the i3Engine container formats |
| `camera/`, `bloodtex/`, `asset-lod/` | helpers for specific exporters |
| `pbx.config.json` | local settings written by `pbx init`. Git-ignored |

## Commands

```sh
npm install
npm run pbx -- doctor                                  # clients found, which steps can run
npm run pbx -- export all --client cross --dry-run     # lists the steps, writes nothing
npm run pbx -- export <name> --client cross            # one step
npm run pbx -- snapshot                                # copy what a mass re-export will rewrite
npm run pbx -- snapshot --restore                      # revert to the last snapshot
npm run pbx -- help
```

Settings: flag, then env (`PB_CLIENTS`, `PB_ASSETS`, `PB_WEB`, `PB_SERVER`, `PB_CLIENT_<KEY>`, `PB_BASE_CLIENT`), then `pbx.config.json`, then default. `--web` points at the web app source (its `src/` receives the generated `.ts`). `--server` points at a server root (`server/runtime`, `db/init/001_init.sql`, or `old/`).

## Safety

- **Dry run first.** `export all --dry-run` before any run that writes many files.
- **Snapshot before a mass re-export.** `pbx snapshot`; revert with `pbx snapshot --restore`.
- **Never run `export all`, or any step that rewrites many files, without the user's go-ahead.**
- **Never delete through links or junctions.** Output folders can be linked to other drives. Remove files by their real path, and check the target first.
- **Never commit** game files, `out/`, `extracted/`, `snapshots/`, `pbx.config.json`, or any copy of a client. They are git-ignored; keep it that way.
- **Only read the client.** Exporters never write into a client folder.
- **Missing client or pack:** let it fail through `lib/paths.mjs` with one line that names the expected path. Do not add stack traces. Do not add `existsSync` guards that hide a broken export.

## Fidelity

- **Export what the original client holds.** Do not invent values, names, ids or layouts.
- **Mark inferred code.** Anything inferred goes in a code comment as `[INFERIDO]`, and in the output's `source` or notes field.
- **Pair data by content, not by position.** Pack blobs are paired by their content. File order or index is not a pairing key.

## Paths

- Keep every path in `lib/paths.mjs`. Do not hardcode `../..`, client folder names, or where a sibling project sits. Add a setting there if one is missing.
- Steps that need the web app source or server data stay gated in `pbx.mjs` (`web: true`, `server: true`).
- The server layouts differ. The public layout has `server/runtime` and `db/init/001_init.sql`. The older private layout also has `old/runtime/db-init/*.sql` and `old/`. A step that reads server data must work with the public layout, and keep working with the older one when `old/` exists.

## Code rules

- **Runtime:** Node ≥ 22.7, ESM `.mjs`. Do not add a runtime dependency without asking.
- **Python tools** (`re` helpers) read client paths from `PB_CLIENT_<KEY>`, which `pbx` sets for them.
- **Comments:** match the density and style of the file you edit.

## Adapting to another client

The tools were built and tested against Point Blank Cross. Other clients use the same i3Engine formats. Add a key to `CLIENTS` in `lib/paths.mjs`, then check each exporter that names a client. Compare the pack names and the PEF tables with the Cross output before you trust a new client's export.
