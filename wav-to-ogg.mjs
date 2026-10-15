// Writes an Ogg Vorbis twin (x.ogg) next to every out/**/x.wav (the wavs stay: src/audioUrl.ts falls back to them).
// Usage: node tools/wav-to-ogg.mjs [dir=out] [--force]    (npm run assets:ogg also verifies the loops)
// Every exporter that writes wavs calls convertWavs(dir) at its end, so there is nothing to run by hand.
// The command line runs the encodes PB_JOBS at a time (default min(4, cores)); the exporters' convertWavs stays serial (sync).
// ffmpeg: FFMPEG env > the ffmpeg-static devDependency > PATH. Needs >= 6 with libvorbis (the 2018 build padded the last Vorbis block:
// +295..630 samples, a gap at ambient loop seams; 6.x writes the exact final granule); older builds are refused.
// Idempotent: skips a wav whose twin is newer.
// -q:a 5 keeps the source rate/channels (~160 kbps stereo, ~90 mono). Vorbis has no encoder delay / pre-skip, so the decoded clip
// has the wav's exact length and onset (tools/verify-ogg.mjs checks it). A few exported "wav"s are really Ogg already: copied as is.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { assetPath } from './lib/paths.mjs';
const execFileP = promisify(execFile);
let cached;
/** FFMPEG env > ffmpeg-static > PATH; throws when the binary is < 6 */
export function ffmpegPath() {
  if (cached) return cached;
  let bin = process.env.FFMPEG;
  if (!bin) { try { bin = createRequire(import.meta.url)("ffmpeg-static"); } catch { /* not installed */ } }
  bin ||= "ffmpeg";
  let major;
  try { major = Number(/version n?(\d+)/.exec(execFileSync(bin, ["-version"], { encoding: "utf8" }))?.[1]); }
  catch { throw new Error(`ffmpeg not runnable (${bin}): run npm install (ffmpeg-static) or set FFMPEG`); }
  if (!(major >= 6)) throw new Error(`ffmpeg at ${bin} is too old (major ${major}, need >= 6: older builds pad the last Vorbis block and open a gap at loop seams): run npm install (ffmpeg-static) or set FFMPEG`);
  return (cached = bin);
}

/** parallel jobs for the command-line steps: PB_JOBS (pbx sets it) > min(4, cores) */
export const poolJobs = () => Number(process.env.PB_JOBS) || Math.min(4, os.availableParallelism());

/** fn over items, n at a time; results in input order */
export async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

/** absolute paths (lowercase, forward slashes) of the ambient loop wavs under root/sfx */
export function loopWavs(root) {
  const out = new Set();
  const maps = path.join(root, "maps");
  if (!fs.existsSync(maps)) return out;
  for (const d of fs.readdirSync(maps)) {
    const j = path.join(maps, d, "ambient.json");
    if (!fs.existsSync(j)) continue;
    for (const t of (JSON.parse(fs.readFileSync(j, "utf8")).emitters ?? []).flatMap((e) => e.layers ?? [])) if (t.loop) out.add(path.resolve(root, "sfx", t.file).split(path.sep).join("/").toLowerCase());
  }
  return out;
}

export function* wavs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* wavs(p);
    else if (/\.wav$/i.test(e.name)) yield p;
  }
}

/** the wavs that need an encode: Ogg-as-wav files are copied here, up to date twins are counted and skipped */
function plan(dir, force) {
  const todo = [];
  let copied = 0, skipped = 0;
  for (const wav of wavs(path.resolve(dir))) {
    const ogg = wav.replace(/\.wav$/i, ".ogg");
    if (!force && fs.existsSync(ogg) && fs.statSync(ogg).mtimeMs >= fs.statSync(wav).mtimeMs) { skipped++; continue; }
    const head = Buffer.alloc(4);
    const fd = fs.openSync(wav, "r"); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (head.toString("latin1") === "OggS") { fs.copyFileSync(wav, ogg); copied++; continue; }
    todo.push(wav);
  }
  return { todo, copied, skipped };
}

function report({ done, copied, skipped, before, after }) {
  console.log(`ogg twins: ${done} encoded (${(before / 1048576).toFixed(1)} -> ${(after / 1048576).toFixed(1)} MB), ${copied} copied (already Ogg), ${skipped} up to date`);
}

/** Writes x.ogg next to every x.wav under dir (idempotent). Serial: exporters call it and do not await. */
export function convertWavs(dir, { force = false } = {}) {
  const ffmpeg = ffmpegPath();
  const p = plan(dir, force);
  let before = 0, after = 0;
  for (const wav of p.todo) {
    const ogg = wav.replace(/\.wav$/i, ".ogg");
    execFileSync(ffmpeg, ["-y", "-v", "error", "-i", wav, "-vn", "-c:a", "libvorbis", "-q:a", "5", ogg]);
    before += fs.statSync(wav).size; after += fs.statSync(ogg).size;
  }
  report({ done: p.todo.length, copied: p.copied, skipped: p.skipped, before, after });
}

/** convertWavs with the encodes PB_JOBS at a time (the command line). Same skip / copy rules, same log line. */
export async function convertWavsPool(dir, { force = false, jobs = poolJobs() } = {}) {
  const ffmpeg = ffmpegPath();
  const p = plan(dir, force);
  let before = 0, after = 0;
  await pool(p.todo, jobs, async (wav) => {
    const ogg = wav.replace(/\.wav$/i, ".ogg");
    await execFileP(ffmpeg, ["-nostdin", "-y", "-v", "error", "-i", wav, "-vn", "-c:a", "libvorbis", "-q:a", "5", ogg]);
    before += fs.statSync(wav).size; after += fs.statSync(ogg).size;
  });
  report({ done: p.todo.length, copied: p.copied, skipped: p.skipped, before, after });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  await convertWavsPool(args.find((a) => !a.startsWith("--")) ?? assetPath(), { force: args.includes("--force") });
}
