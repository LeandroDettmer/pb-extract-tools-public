# CLAUDE.md — pb-extract-tools

Tools (`pbx`) that read the user's own game client folders and export to open formats. Read `README.md` first: commands, flags, clients, output formats, troubleshooting, and the section for AI agents.

## Rules

- **Fidelity.** Export what the original client holds. Do not invent values, names or layouts. Anything inferred goes in a code comment as `[INFERIDO]` and in the output's `source` or notes field.
- **Snapshot before a mass re-export.** `pbx snapshot`; revert with `pbx snapshot --restore`.
- **Never run `pbx export all`, or any step that rewrites many files, without asking the user.** Dry run first: `pbx export all --dry-run`.
- **Paths live in `lib/paths.mjs` only.** Do not hardcode `../..`, client folder layouts, or where any other project sits. Add a setting there if one is missing.
- **Missing client or pack:** let it fail through `lib/paths.mjs` (one line, names the expected path). Do not add stack traces, and do not add `existsSync` guards that hide a broken export.
- **Steps that need the web app source (`--web`) or server data (`--server`)** stay gated in `pbx.mjs` (`web: true`, `server: true`).
- **Never commit** game files, `out/`, `extracted/`, `snapshots/` or `pbx.config.json`. They are gitignored; keep it that way.
- **Runtime:** Node ≥ 22.7, ESM `.mjs`. Do not add a runtime dependency without asking.
- Python `re` tools read client paths from `PB_CLIENT_<KEY>`, which `pbx` sets for them.
