// The one place that knows where things live. Tools never hardcode ../.., the client folder layout or the web app location.
// Each setting: CLI flag (pbx --clients ...) > env (PB_CLIENTS, PB_ASSETS, ...) > pbx.config.json > default.
// Paths resolve lazily: a missing client or pack fails only when a tool reads it, with one line (see handler below).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(TOOLS, 'pbx.config.json');

// Client key -> folder under the clients root. label names the client version in messages and doctor.
export const CLIENTS = {
  kaybo: { dir: 'PBKaybo/GameData/Apps/PB', label: 'Point Blank 2017 (Kaybo)' },
  br3123: { dir: 'PointBlank 3.123', label: 'Point Blank 3.123 (BR)' },
  cross: { dir: 'PBCross', label: 'Point Blank Cross' },
  ru: { dir: 'PB RUSSIA', label: 'Point Blank Russia (RU)' },
  portable: { dir: 'Point-Blank-Portable/3-PointBlank', label: 'Point Blank Portable 3.1' },
  hyper: { dir: 'Point Blank Hyper', label: 'Point Blank Hyper' },
  blackout: { dir: 'EpicBlackout', label: 'EpicBlackout (2014)' },
};

// Sentinels for settings that are not set yet. A read under them fails with ENOENT and the handler explains why.
const UNSET_CLIENTS = '(clients not set)';
const UNSET_WEB = '(--web not set)';
const UNSET_SERVER = '(--server not set)';

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* no config yet: pbx init writes it */ }

const abs = (p) => (p ? path.resolve(p) : null);
const pick = (env, fromConfig) => abs(process.env[env] || fromConfig);

export const settings = {
  clients: pick('PB_CLIENTS', config.clients),
  overrides: Object.fromEntries(Object.keys(CLIENTS).flatMap((k) => {
    const p = pick(`PB_CLIENT_${k.toUpperCase()}`, config.overrides?.[k]);
    return p ? [[k, p]] : [];
  })),
  assets: pick('PB_ASSETS', config.assets) ?? path.resolve('out'),
  extracted: pick('PB_EXTRACTED', config.extracted) ?? path.resolve('extracted'),
  snapshots: pick('PB_SNAPSHOTS', config.snapshots) ?? path.resolve('snapshots'),
  web: pick('PB_WEB', config.web),
  server: pick('PB_SERVER', config.server),
};

// Folder of a client: explicit override first, else clients root + dir. null when unset.
export function clientRoot(key) {
  if (settings.overrides[key]) return settings.overrides[key];
  return settings.clients ? path.join(settings.clients, CLIENTS[key].dir) : null;
}

export function clientStatus(key) {
  const dir = clientRoot(key);
  return { key, label: CLIENTS[key].label, dir, found: !!dir && fs.existsSync(dir) };
}

// Base client selector. An exporter passes the client it reads today as the default (e.g. baseClient('kaybo')).
// `--client <key>` in its argv (`pbx export sfx --client cross`) or PB_BASE_CLIENT=<key> switches it. `<key>=<dir>` is pbx init's form, ignored here.
const { env } = process;
export function baseClient(def) {
  const i = process.argv.indexOf('--client');
  const arg = i >= 0 && process.argv[i + 1] && !process.argv[i + 1].includes('=') ? process.argv[i + 1] : null;
  const key = arg || env.PB_BASE_CLIENT || def;
  if (!CLIENTS[key]) fail(`--client ${key}: unknown client key, one of: ${Object.keys(CLIENTS).join(' ')}`);
  return key;
}

// Required file or folder of a client. Not checked here: a missing one fails on read with the one-line message.
export function clientPath(key, ...sub) {
  return path.join(clientRoot(key) ?? path.join(UNSET_CLIENTS, CLIENTS[key].dir), ...sub);
}

// Same lookup, null when missing: for optional sources a tool can do without.
export function clientPathOpt(key, ...sub) {
  const root = clientRoot(key);
  const p = root && path.join(root, ...sub);
  return p && fs.existsSync(p) ? p : null;
}

// Path from a provenance string ('Clients/PB RUSSIA/Pack/x.i3Pack' or 'PointBlank 3.123/Pack'). null if unknown or missing.
export function sourcePath(src) {
  const s = src.replace(/\\/g, '/').replace(/^Clients\//, '');
  const key = Object.keys(CLIENTS).find((k) => s === CLIENTS[k].dir || s.startsWith(CLIENTS[k].dir + '/'));
  return key ? clientPathOpt(key, s.slice(CLIENTS[key].dir.length).replace(/^\//, '')) : null;
}

export const assetPath = (...sub) => path.join(settings.assets, ...sub);
export const extractedPath = (...sub) => path.join(settings.extracted, ...sub);
export const snapshotPath = (...sub) => path.join(settings.snapshots, ...sub);

// Web app source: the folder of the project that consumes the assets (it has src/). Only steps that read or write it need --web.
export const webPath = (...sub) => path.join(settings.web ?? UNSET_WEB, ...sub);
export const webPathOpt = (...sub) => (settings.web ? path.join(settings.web, ...sub) : null);

// Game server data (server/runtime/Data/...). Needs --server: the server root that holds server/ and old/.
export const serverPath = (...sub) => path.join(settings.server ?? UNSET_SERVER, 'server', ...sub);
export const serverPathOpt = (...sub) => (settings.server ? path.join(settings.server, 'server', ...sub) : null);

// Older server sources and binaries (old/...). Same --server root.
export const oldServerPath = (...sub) => path.join(settings.server ?? UNSET_SERVER, 'old', ...sub);
export const oldServerPathOpt = (...sub) => (settings.server ? path.join(settings.server, 'old', ...sub) : null);

// Server DB seed of the public layout (pg_dump: db/init/001_init.sql, COPY blocks). Same --server root.
export const dbInitPath = (...sub) => path.join(settings.server ?? UNSET_SERVER, 'db', 'init', ...sub);
export const dbInitPathOpt = (...sub) => (settings.server ? path.join(settings.server, 'db', 'init', ...sub) : null);

// Generated source the web app imports. --web set: written into its src/. Otherwise out/generated/, said out loud.
export function generatedPath(rel) {
  let p;
  if (settings.web) p = path.join(settings.web, 'src', rel);
  else {
    p = path.join(settings.assets, 'generated', rel);
    console.log(`pbx: --web not set, writing ${rel} to ${p} (not in a web app src/)`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

// Provenance string: path relative to the clients root, else the assets root, else the tools root (always '/').
export function rel(p) {
  for (const base of [settings.clients, settings.assets, TOOLS]) {
    if (!base) continue;
    const r = path.relative(base, p);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
  }
  return p;
}

export function fail(msg) { console.error(`pbx: ${msg}`); process.exit(2); }

// One line instead of a stack trace when a tool reads something that is not there.
function missingMessage(p) {
  // sentinels can come back absolute (path.resolve inside a reader), so match them anywhere in the string
  const after = (s) => p.slice(p.indexOf(s) + s.length + 1);
  if (p.includes(UNSET_CLIENTS)) {
    const sub = after(UNSET_CLIENTS);
    const key = Object.keys(CLIENTS).find((k) => sub.toLowerCase().startsWith(CLIENTS[k].dir.replaceAll('/', path.sep).toLowerCase()));
    return `${key ? CLIENTS[key].label : 'client'} not set (needs ${sub}). Run: pbx init --clients <Clients dir>`;
  }
  if (p.includes(UNSET_WEB)) return `needs --web <dir> (web app source) for ${after(UNSET_WEB)}. Not set`;
  if (p.includes(UNSET_SERVER)) return `needs --server <dir> (server root) for ${after(UNSET_SERVER)}. Not set`;
  const full = path.resolve(p);
  if (settings.extracted && full.startsWith(path.resolve(settings.extracted) + path.sep)) {
    const step = /pef-cross/.test(full) ? 'pbx re cross-pef' : 'pbx re pef-config';
    return `not produced yet: "${full}". Run ${step} first (needs the client it reads, see pbx doctor)`;
  }
  const hit = Object.keys(CLIENTS).find((k) => {
    const root = clientRoot(k);
    return root && full.startsWith(path.resolve(root) + path.sep);
  });
  if (hit) {
    const root = path.resolve(clientRoot(hit));
    return `${CLIENTS[hit].label}: missing "${full.slice(root.length + 1)}", expected at "${full}". Check the client version, or fix the path: pbx init --clients <dir>`;
  }
  return `not found: "${full}"`;
}

process.on('uncaughtException', (err) => {
  if (err.code === 'ENOENT' && err.path) fail(missingMessage(err.path));
  console.error(err);
  process.exit(1);
});
