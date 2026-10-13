// Checks every out x.wav against its x.ogg twin (tools/wav-to-ogg.mjs): duration diff < 5 ms (Ogg length = last page granule
// position, what a decoder trims to; ffmpeg's raw decode keeps the padded last Vorbis block, trimmed here the same way), RMS within 1 dB,
// head cross-correlation lag within 1 ms. Decodes with ffmpeg (same ffmpeg as wav-to-ogg), the decoder family Chrome uses.
// Usage: node tools/verify-ogg.mjs [dir=out] [--sample=N] [--loops (ambient loops only)]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffmpegPath, loopWavs, wavs } from "./wav-to-ogg.mjs";

import { assetPath } from './lib/paths.mjs';
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
function decode(file) {
  let err = "";
  try { execFileSync(ffmpeg, ["-hide_banner", "-i", file], { stdio: "pipe" }); } catch (e) { err = String(e.stderr); }
  const rate = Number(/(\d+) Hz/.exec(err)?.[1] ?? 44100);
  const ch = /Hz, (mono|stereo|(\d)\.?\d? channels)/.exec(err);
  const nch = ch ? (ch[1] === "mono" ? 1 : ch[1] === "stereo" ? 2 : Number(ch[2])) : 1;
  const raw = execFileSync(ffmpeg, ["-v", "error", "-i", file, "-f", "f32le", "-acodec", "pcm_f32le", "-"], { maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] });
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length >> 2);
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

const loops = loopWavs(root);
let list = args.includes("--loops") ? [] : [...wavs(root)].filter((w) => !loops.has(w.split(path.sep).join("/").toLowerCase())); // loops: own seam check below
if (sample) list = list.filter((_, i) => i % Math.ceil(list.length / sample) === 0);
let skippedOgg = 0, bad = 0, maxDur = 0, maxDb = 0, maxOn = 0;
for (const wav of list) {
  const ogg = wav.replace(/\.wav$/i, ".ogg");
  const rel = path.relative(root, wav);
  if (!fs.existsSync(ogg)) { console.log("MISSING", rel); bad++; continue; }
  if (fs.readFileSync(wav).subarray(0, 4).toString("latin1") === "OggS") { skippedOgg++; continue; } // an Ogg stored as .wav: the twin is a byte copy
  let a, b;
  try { a = decode(wav); b = decode(ogg); } catch (e) { console.log("DECODE FAIL", rel, String(e.message).slice(0, 80)); bad++; continue; }
  const dDur = Math.abs(a.frames / a.rate - b.frames / b.rate) * 1000;
  const ra = rms(a.f), rb = rms(b.f);
  const dDb = ra > 1e-6 ? Math.abs(20 * Math.log10((rb + 1e-9) / ra)) : 0;
  const dOn = Math.abs(onset(a, b)) * 1000;
  maxDur = Math.max(maxDur, dDur); maxDb = Math.max(maxDb, dDb); maxOn = Math.max(maxOn, dOn);
  if (a.rate !== b.rate || a.nch !== b.nch || dDur >= 5 || dDb > 1 || dOn > 1) { console.log("BAD", rel, { rate: [a.rate, b.rate], nch: [a.nch, b.nch], dDurMs: +dDur.toFixed(2), dDb: +dDb.toFixed(2), dOnMs: +dOn.toFixed(2) }); bad++; }
}
// ambient loops (maps/*/ambient.json "loop": true): the seam must not gap. Exact sample count (granule == wav frames, decoder output trimmed
// to it) and the wrap-around window (last 10 ms + first 10 ms) must match the wav: RMS within 1 dB, and the jump across the seam (last -> first sample)
// no bigger than the wav's own by more than 0.02 FS (no new click).
let loopBad = 0, maxSeamJump = 0, maxSeamDb = 0;
for (const lw of loops) {
  const ogg = lw.replace(/.wav$/i, ".ogg"), rel = path.relative(root, lw);
  if (!fs.existsSync(ogg)) { console.log("LOOP MISSING", rel); loopBad++; continue; }
  const a = decode(lw), b = decode(ogg), gran = oggSamples(ogg);
  const seam = (d) => { const n = Math.round(d.rate * 0.01), w = new Float32Array(2 * n * d.nch); w.set(d.f.subarray(d.f.length - n * d.nch)); w.set(d.f.subarray(0, n * d.nch), n * d.nch); let jump = 0; for (let c = 0; c < d.nch; c++) jump = Math.max(jump, Math.abs(d.f[c] - d.f[d.f.length - d.nch + c])); return { rms: rms(w), jump }; };
  const sa = seam(a), sb = seam(b), dDb = sa.rms > 1e-2 ? Math.abs(20 * Math.log10((sb.rms + 1e-9) / sa.rms)) : (Math.abs(sb.rms - sa.rms) < 4e-3 ? 0 : 99); // seam under -40 dBFS: noise floor, compare absolute RMS
  maxSeamDb = Math.max(maxSeamDb, dDb); maxSeamJump = Math.max(maxSeamJump, sb.jump - sa.jump);
  if (gran !== a.frames || b.frames !== a.frames || a.rate !== b.rate || a.nch !== b.nch || dDb > 1 || sb.jump - sa.jump > 0.02) { console.log("LOOP BAD", rel, { wavFrames: a.frames, oggFrames: b.frames, granule: gran, dDb: +dDb.toFixed(2), jump: [+sa.jump.toFixed(4), +sb.jump.toFixed(4)] }); loopBad++; }
}
console.log(`${loops.size} loops: ${loopBad} bad; sample count exact (granule == wav frames); max seam RMS diff ${maxSeamDb.toFixed(2)} dB, max extra seam jump ${maxSeamJump.toFixed(4)} FS`);
bad += loopBad;
console.log(`${list.length} files, ${bad} bad, ${skippedOgg} byte-copied; max dur diff ${maxDur.toFixed(2)} ms, max RMS diff ${maxDb.toFixed(2)} dB, max head lag ${maxOn.toFixed(2)} ms`);
process.exit(bad ? 1 : 0);
