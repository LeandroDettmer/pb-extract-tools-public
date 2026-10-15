// Fingerprints for pbx export all: a step is cached when what it reads and writes is unchanged since its last good run.
// Reads: the script's content (its local imports and the files it names), the stat of client and --server trees, the content of --web src.
// Writes: the content of its output folders, kept in the state file (<extracted>/.pbx-state.json) after each good run.
// Content: sha1 of the bytes, cached per file by size and mtime in <extracted>/.pbx-hashes.json, so a warm run only stats files.
// Exporters rewrite identical bytes, so a stat is not enough. Two outputs also change bytes without a change of content: an .ogg
// (its Ogg serial is random) hashes as its twin .wav, a .json with a top-level `generated` timestamp hashes without that field.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Files under root, memoized for one run. entry.fp caches the fingerprint of a whole tree (treeFp without keep).
const walked = new Map();
function stats(base, dir, list) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full, { throwIfNoEntry: false }); // undefined: a broken link
    if (!st) continue;
    if (st.isDirectory()) stats(base, full, list);
    else list.push({ rel: path.relative(base, full).split(path.sep).join('/'), full, size: st.size, mtimeMs: st.mtimeMs });
  }
}
function tree(root) {
  if (!walked.has(root)) {
    const st = fs.statSync(root, { throwIfNoEntry: false });
    let list = null;
    if (st?.isFile()) list = [{ rel: '', full: root, size: st.size, mtimeMs: st.mtimeMs }];
    else if (st?.isDirectory()) { list = []; stats(root, root, list); }
    walked.set(root, { list, fp: {} });
  }
  return walked.get(root);
}

// Content hash per file path: [size, mtimeMs, sha1]. A file whose size and mtime match keeps its hash without a read.
let hashes = {};
let hashFile = null;
export function loadHashes(file) {
  hashFile = file;
  try { hashes = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { hashes = {}; }
}
// Written with the state: temp file, then rename.
export function saveHashes() {
  if (!hashFile) return;
  fs.mkdirSync(path.dirname(hashFile), { recursive: true });
  fs.writeFileSync(`${hashFile}.tmp`, JSON.stringify(hashes));
  fs.renameSync(`${hashFile}.tmp`, hashFile);
}

// sha1 of the bytes, read in 1 MB chunks (a large .glb or .wav is not held whole).
function readHash(full) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(full, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// Hash of what the file means. .ogg: its twin .wav (convertWavs keeps the wav, and re-encodes it whenever the wav is newer).
// .json with a top-level generated: the JSON without it (exporters stamp the time there).
function contentOf(full) {
  if (/\.ogg$/i.test(full)) {
    const wav = full.replace(/\.ogg$/i, '.wav');
    const st = fs.statSync(wav, { throwIfNoEntry: false });
    if (st?.isFile()) return fileHash(wav, st);
  }
  if (/\.json$/i.test(full)) {
    const buf = fs.readFileSync(full);
    if (buf.includes('"generated"')) {
      try {
        const o = JSON.parse(buf);
        if ('generated' in o) { delete o.generated; return sha(JSON.stringify(o)); }
      } catch { /* not JSON: hashed as bytes */ }
    }
    return sha(buf);
  }
  return readHash(full);
}

// Content hash of one file, from the cache when size and mtime are unchanged.
function fileHash(full, st) {
  const hit = hashes[full];
  if (hit && hit[0] === st.size && hit[1] === st.mtimeMs) return hit[2];
  const h = contentOf(full);
  hashes[full] = [st.size, st.mtimeMs, h];
  return h;
}

// Fingerprint of the files under root; null when root is missing. keep(rel) drops files. content: hash the bytes (outputs, web src);
// otherwise the stat only (client and --server: read-only, and too big to read).
export function treeFp(root, { keep, content = true } = {}) {
  const entry = tree(root);
  if (!entry.list) return null;
  const line = (f) => `${f.rel}\t${content ? fileHash(f.full, f) : `${f.size} ${f.mtimeMs}`}`;
  if (keep) return sha(entry.list.filter((f) => keep(f.rel)).map(line).sort().join('\n'));
  const mode = content ? 'content' : 'stat';
  entry.fp[mode] ??= sha(entry.list.map(line).sort().join('\n'));
  return entry.fp[mode];
}

// Two paths are the same folder, or one holds the other.
export const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

// Drops the memo of root and of the folders that contain or sit in it: call after a step wrote there.
export function forget(root) {
  for (const k of [...walked.keys()]) if (overlaps(k, root)) walked.delete(k);
}

const isFile = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

const CODE = /\.(m?js|ts)$/;
const IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g; // relative import, static or dynamic
const NAMED = /['"]([^'"\s]+\.(?:mjs|js|ts|py|json))['"]/g; // a file named in a string: spawned script, data file

// Every repo file that can be named in a string (the tools folder, without generated and client-output folders, and without
// pbx.config.json: its settings are already in the fingerprint).
const SKIP_DIRS = new Set(['node_modules', 'out', 'extracted', 'snapshots', 'logs']);
let index = null;
function repoIndex(tools) {
  if (index) return index;
  index = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) walk(path.join(dir, d.name)); }
      else if (/\.(m?js|ts|py|json)$/.test(d.name) && d.name !== 'pbx.config.json') index.push(path.relative(tools, path.join(dir, d.name)).split(path.sep).join('/'));
    }
  };
  walk(tools);
  return index;
}

// Local files a step runs: its script and what the script imports or names (a spawned script, a data file).
// Python steps: the script and the .py files next to it (their imports are not parsed).
export function scriptFiles(script, tools) {
  const dir = path.dirname(script);
  if (script.endsWith('.py')) return [script, ...fs.readdirSync(dir).filter((f) => f.endsWith('.py')).map((f) => path.join(dir, f))];
  const seen = new Set();
  const todo = [path.resolve(script)];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const here = path.dirname(file);
    for (const [, spec] of text.matchAll(IMPORT)) {
      const hit = ['', '.mjs', '.ts', '.js', '/index.mjs'].map((x) => path.join(here, spec + x)).find(isFile);
      if (hit) todo.push(hit);
    }
    for (const [, lit] of text.matchAll(NAMED)) {
      if (isFile(path.join(here, lit))) todo.push(path.join(here, lit));
      for (const rel of repoIndex(tools)) if (rel === lit || rel.endsWith('/' + lit)) todo.push(path.join(tools, rel));
    }
  }
  return [...seen].sort();
}

const contentMemo = new Map();
export function contentFp(file) {
  if (!contentMemo.has(file)) contentMemo.set(file, sha(fs.readFileSync(file)));
  return contentMemo.get(file);
}

// State of the last good run per step, and the output fingerprint after it. A missing or unreadable file means no state.
export function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { steps: s.steps ?? {}, outputs: s.outputs ?? {} };
  } catch {
    return { steps: {}, outputs: {} };
  }
}

// Written after each good step: temp file, then rename, so a crash leaves the last whole state.
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}
