// Checks every out x.wav against its x.ogg twin (tools/wav-to-ogg.mjs): duration diff <= 256 samples (Ogg length = last page granule
// position, what a decoder trims to; ffmpeg's raw decode keeps the padded last Vorbis block, trimmed here the same way). The 256 is
// [INFERIDO] the ffmpeg Vorbis decode shortfall on some 22050 Hz streams (8 of 145, granule exact, decode 256 short, same at q3-q10 and at
// 44.1 kHz with 128); a ms limit would be 5 ms = 110 samples at 22050 Hz and fails them. Loops keep the exact granule check. RMS within 1 dB,
// head cross-correlation lag within 1 ms. Decodes with ffmpeg (same ffmpeg as wav-to-ogg), the decoder family Chrome uses.
// Usage: node tools/verify-ogg.mjs [dir=out] [--sample=N] [--loops (ambient loops only, skips the wav/ogg pairs)]
// Default: every wav pair + the ambient loops. The ALL pipeline (pbx export all) runs the default; --loops was its old default and checked 0 pairs.
// Files are checked PB_JOBS at a time (default min(4, cores)); the log is sorted by file, so it does not depend on finish order.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ffmpegPath, loopWavs, pool, poolJobs, wavs } from "./wav-to-ogg.mjs";

import { assetPath } from './lib/paths.mjs';
const execFileP = promisify(execFile);
const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? assetPath());
const sample = Number(args.find((a) => a.startsWith("--sample="))?.slice(9)) || 0;
const ffmpeg = ffmpegPath();

/** samples of a Vorbis stream = granule position of its last Ogg page (no pre-skip in Vorbis) */
function oggSamples(file) {
  const b = fs.readFileSync(file);
  const i = b.lastIndexOf("OggS", b.length - 1, "latin1");
  return Number(b.readBigInt64LE(i + 6));
}
async function decode(file) {
  let err = "";
  try { await execFileP(ffmpeg, ["-nostdin", "-hide_banner", "-i", file]); } catch (e) { err = String(e.stderr); }
  const rate = Number(/(\d+) Hz/.exec(err)?.[1] ?? 44100);
  const ch = /Hz, (mono|stereo|(\d)\.?\d? channels)/.exec(err);
  const nch = ch ? (ch[1] === "mono" ? 1 : ch[1] === "stereo" ? 2 : Number(ch[2])) : 1;
  const { stdout: raw } = await execFileP(ffmpeg, ["-nostdin", "-v", "error", "-i", file, "-f", "f32le", "-acodec", "pcm_f32le", "-"], { encoding: "buffer", maxBuffer: 1 << 29 });
  const n = raw.length >> 2;
  const f = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 4)); // a copy: a small pooled Buffer is not 4-aligned
  let frames = Math.floor(f.length / nch);
  if (/.ogg$/i.test(file)) { frames = Math.min(frames, oggSamples(file)); }
  return { rate, nch, f: f.subarray(0, frames * nch), frames };
}
const rms = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / Math.max(1, f.length)); };
// start alignment: lag (ms) of the best cross-correlation between the wav and ogg heads (first 0.4 s, +-4 ms), 0 = no encoder delay
const mono = (d, n) => { const m = new Float32Array(Math.min(n, d.frames)); for (let i = 0; i < m.length; i++) { let v = 0; for (let c = 0; c < d.nch; c++) v += d.f[i * d.nch + c]; m[i] = v / d.nch; } return m; };
const onset = (a, b) => {
  const n = Math.round(a.rate * 0.4), x = mono(a, n), y = mono(b, n), L = Math.round(a.rate * 0.004);
  if (x.reduce((e, v) => e + v * v, 0) / x.length < 1e-5) return 0; // head under -50 dBFS RMS: noise floor, correlation is not meaningful
  let best = -Infinity, bl = 0;
  for (let l = -L; l <= L; l++) { let s = 0; for (let i = L; i < x.length - L; i++) s += x[i] * y[i + l]; if (s > best) { best = s; bl = l; } }
  return bl / a.rate;
};

/** one wav/ogg pair: console lines (printed later, sorted), bad flag, skipped-as-Ogg flag, max diffs */
async function checkPair(wav) {
  const ogg = wav.replace(/\.wav$/i, ".ogg");
  const rel = path.relative(root, wav);
  const r = { rel, logs: [], bad: 0, skippedOgg: 0, dDur: 0, dDb: 0, dOn: 0 };
  if (!fs.existsSync(ogg)) { r.logs.push(["MISSING", rel]); r.bad++; return r; }
  if (fs.readFileSync(wav).subarray(0, 4).toString("latin1") === "OggS") { r.skippedOgg++; return r; } // an Ogg stored as .wav: the twin is a byte copy
  let a, b;
  try { a = await decode(wav); b = await decode(ogg); } catch (e) { r.logs.push(["DECODE FAIL", rel, String(e.message).slice(0, 80)]); r.bad++; return r; }
  r.dDur = Math.abs(a.frames / a.rate - b.frames / b.rate) * 1000;
  const ra = rms(a.f), rb = rms(b.f);
  r.dDb = ra > 1e-6 ? Math.abs(20 * Math.log10((rb + 1e-9) / ra)) : 0;
  r.dOn = Math.abs(onset(a, b)) * 1000;
  if (a.rate !== b.rate || a.nch !== b.nch || Math.abs(a.frames - b.frames) > 256 || r.dDb > 1 || r.dOn > 1) { r.logs.push(["BAD", rel, { rate: [a.rate, b.rate], nch: [a.nch, b.nch], dDurMs: +r.dDur.toFixed(2), dDb: +r.dDb.toFixed(2), dOnMs: +r.dOn.toFixed(2) }]); r.bad++; }
  return r;
}
// ambient loops (maps/*/ambient.json "loop": true): the seam must not gap. Exact sample count (granule == wav frames, decoder output trimmed
// to it) and the wrap-around window (last 10 ms + first 10 ms) must match the wav: RMS within 1 dB, and the jump across the seam (last -> first sample)
// no bigger than the wav's own by more than 0.02 FS (no new click).
async function checkLoop(lw) {
  const ogg = lw.replace(/.wav$/i, ".ogg"), rel = path.relative(root, lw);
  const r = { logs: [], bad: 0, dDb: 0, jump: 0 };
  if (!fs.existsSync(ogg)) { r.logs.push(["LOOP MISSING", rel]); r.bad++; return r; }
  const a = await decode(lw), b = await decode(ogg), gran = oggSamples(ogg);
  const seam = (d) => { const n = Math.round(d.rate * 0.01), w = new Float32Array(2 * n * d.nch); w.set(d.f.subarray(d.f.length - n * d.nch)); w.set(d.f.subarray(0, n * d.nch), n * d.nch); let jump = 0; for (let c = 0; c < d.nch; c++) jump = Math.max(jump, Math.abs(d.f[c] - d.f[d.f.length - d.nch + c])); return { rms: rms(w), jump }; };
  const sa = seam(a), sb = seam(b), dDb = sa.rms > 1e-2 ? Math.abs(20 * Math.log10((sb.rms + 1e-9) / sa.rms)) : (Math.abs(sb.rms - sa.rms) < 4e-3 ? 0 : 99); // seam under -40 dBFS: noise floor, compare absolute RMS
  r.dDb = dDb; r.jump = sb.jump - sa.jump;
  if (gran !== a.frames || b.frames !== a.frames || a.rate !== b.rate || a.nch !== b.nch || dDb > 1 || sb.jump - sa.jump > 0.02) { r.logs.push(["LOOP BAD", rel, { wavFrames: a.frames, oggFrames: b.frames, granule: gran, dDb: +dDb.toFixed(2), jump: [+sa.jump.toFixed(4), +sb.jump.toFixed(4)] }]); r.bad++; }
  return r;
}
const printSorted = (rs) => { for (const r of rs.slice().sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0))) for (const l of r.logs) console.log(...l); };
const jobs = poolJobs();

const loops = loopWavs(root);
let list = args.includes("--loops") ? [] : [...wavs(root)].filter((w) => !loops.has(w.split(path.sep).join("/").toLowerCase())); // loops: own seam check below
if (sample) list = list.filter((_, i) => i % Math.ceil(list.length / sample) === 0);
const pairs = await pool(list, jobs, checkPair);
printSorted(pairs);
let skippedOgg = 0, bad = 0, maxDur = 0, maxDb = 0, maxOn = 0;
for (const r of pairs) { skippedOgg += r.skippedOgg; bad += r.bad; maxDur = Math.max(maxDur, r.dDur); maxDb = Math.max(maxDb, r.dDb); maxOn = Math.max(maxOn, r.dOn); }
const seams = await pool([...loops], jobs, checkLoop);
printSorted(seams);
let loopBad = 0, maxSeamJump = 0, maxSeamDb = 0;
for (const r of seams) { loopBad += r.bad; maxSeamDb = Math.max(maxSeamDb, r.dDb); maxSeamJump = Math.max(maxSeamJump, r.jump); }
console.log(`${loops.size} loops: ${loopBad} bad; sample count exact (granule == wav frames); max seam RMS diff ${maxSeamDb.toFixed(2)} dB, max extra seam jump ${maxSeamJump.toFixed(4)} FS`);
bad += loopBad;
console.log(`${list.length} files, ${bad} bad, ${skippedOgg} byte-copied; max dur diff ${maxDur.toFixed(2)} ms, max RMS diff ${maxDb.toFixed(2)} dB, max head lag ${maxOn.toFixed(2)} ms`);
process.exit(bad ? 1 : 0);
