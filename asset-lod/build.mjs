#!/usr/bin/env node
// W6 (Assets 3D leves): generates a low-resolution mirror of the weapon/character GLBs for the lobby/preview,
// alongside the existing full-res assets (never touched). Owner-exclusive: tools/asset-lod/*,
// out/{weapons,chars}/models_lod/**.
//
// Why textures only, not geometry: every GLB produced by tools/export-model.mjs stores its skin/skeleton/
// animations in the binary chunk, but its material textures are separate PNG files referenced by a relative
// `images[].uri` (see tools/i3r2/skin-glb.mjs, checkGLB). So a LOD variant needs the *same* .glb bytes (joints,
// clips, FXDummy/GunDummy nodes all untouched) copied verbatim, next to a re-encoded, downscaled `tex/` folder.
// This is also why validation is meaningful but simple: checkGLB() on the LOD file proves the images it expects
// actually exist and decode, and a joints/clips diff against the original proves nothing was altered.
//
//   node tools/asset-lod/build.mjs [--max-tex 256] [--only id1,id2,...] [--weapons-only|--chars-only] [--dry]
//   node tools/asset-lod/build.mjs --check     # validate an existing models_lod/ output, no (re)generation
import { assetPath } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkGLB } from '../i3r2/skin-glb.mjs';
import { decodePNG } from './png.mjs';
import { boxDownscale } from './resize.mjs';
import { encodePNG } from '../i3r2/skin-glb.mjs';

const ASSETS = assetPath();

function parseArgs(argv) {
  const a = { maxTex: 256, only: null, weapons: true, chars: true, dry: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--max-tex') a.maxTex = Number(argv[++i]);
    else if (t === '--only') a.only = new Set(argv[++i].split(',').map((s) => s.trim().toLowerCase()));
    else if (t === '--weapons-only') a.chars = false;
    else if (t === '--chars-only') a.weapons = false;
    else if (t === '--dry') a.dry = true;
    else if (t === '--check') a.check = true;
  }
  return a;
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

// content-addressed dedup: identical re-encoded texture bytes (common across weapon skins that share most
// maps and only swap one or two) are hardlinked instead of duplicated on disk.
const hashToPath = new Map();
function writeDedup(destFile, buf) {
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const prior = hashToPath.get(hash);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (prior && prior !== destFile) {
    try { fs.linkSync(prior, destFile); return { hash, linked: true }; } catch { /* cross-device etc: fall through to a real copy */ }
  }
  fs.writeFileSync(destFile, buf);
  hashToPath.set(hash, destFile);
  return { hash, linked: false };
}

function lodTexture(srcFile, destFile, maxTex, stats) {
  const src = fs.readFileSync(srcFile);
  stats.before += src.length;
  const { width, height, rgba, hasAlpha } = decodePNG(src);
  const { rgba: small, w, h } = boxDownscale(rgba, width, height, maxTex);
  let realAlpha = false;
  if (hasAlpha) for (let i = 3; i < small.length; i += 4) if (small[i] !== 255) { realAlpha = true; break; }
  const out = encodePNG(small, w, h, realAlpha);
  const { linked } = writeDedup(destFile, out);
  stats.after += linked ? 0 : out.length; // linked bytes cost ~0 extra disk (NTFS hardlink)
  stats.afterLogical += out.length; // logical size, ignoring hardlink sharing (for an apples-to-apples ratio)
  return out.length;
}

function copyGLB(srcFile, destFile, stats) {
  const buf = fs.readFileSync(srcFile);
  stats.before += buf.length; stats.after += buf.length; stats.afterLogical += buf.length;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, buf);
}

function processOne(kind, id, srcDir, srcGlbRel, texDirRel, destDir, args, stats, report, { skipTex = false } = {}) {
  const srcGlb = path.join(srcDir, srcGlbRel);
  const destGlb = path.join(destDir, srcGlbRel);
  if (!fs.existsSync(srcGlb)) { report.push({ kind, id, error: `missing source ${srcGlbRel}` }); return; }
  if (args.dry) { stats.before += fs.statSync(srcGlb).size; return; }
  if (args.check) {
    if (!fs.existsSync(destGlb)) { report.push({ kind, id, error: `missing LOD output ${srcGlbRel} (run without --check first)` }); return; }
  } else {
    copyGLB(srcGlb, destGlb, stats);
  }

  if (!skipTex && !args.check) {
    const srcTex = path.join(srcDir, texDirRel);
    if (fs.existsSync(srcTex)) {
      for (const f of fs.readdirSync(srcTex)) {
        if (!f.toLowerCase().endsWith('.png')) continue;
        lodTexture(path.join(srcTex, f), path.join(destDir, texDirRel, f), args.maxTex, stats);
      }
    }
  }

  const before = checkGLB(srcGlb), after = checkGLB(destGlb);
  const mismatch = before.joints !== after.joints
    || JSON.stringify(before.clips.map((c) => [c.name, c.duration])) !== JSON.stringify(after.clips.map((c) => [c.name, c.duration]))
    || !after.ok;
  report.push({ kind, id, ok: !mismatch, joints: after.joints, clips: after.clips.length, errors: after.errors });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const stats = { weapons: { before: 0, after: 0, afterLogical: 0 }, chars: { before: 0, after: 0, afterLogical: 0 } };
  const report = [];

  if (args.weapons) {
    const srcDir = path.join(ASSETS, 'weapons', 'models');
    const destDir = path.join(ASSETS, 'weapons', 'models_lod');
    const idx = JSON.parse(fs.readFileSync(path.join(srcDir, 'index.json'), 'utf8'));
    const lodWeapons = [];
    for (const w of idx.weapons) {
      if (args.only && !args.only.has(w.id.toLowerCase())) continue;
      processOne('weapon', w.id, srcDir, w.file, path.join('tex', w.id), destDir, args, stats.weapons, report);
      lodWeapons.push({ id: w.id, file: w.file, itemId: w.itemId, itemIds: w.itemIds, kind: w.kind, family: w.family, skinOf: w.skinOf });
    }
    if (!args.dry) fs.writeFileSync(path.join(destDir, 'index.json'), JSON.stringify({
      generated: new Date().toISOString(), tool: 'tools/asset-lod/build.mjs', maxTex: args.maxTex, weapons: lodWeapons,
    }, null, 1));
  }

  if (args.chars) {
    const srcDir = path.join(ASSETS, 'chars');
    const destDir = path.join(ASSETS, 'chars', 'models_lod');
    const idx = JSON.parse(fs.readFileSync(path.join(srcDir, 'index.json'), 'utf8'));
    const lodChars = [];
    for (const c of idx.chars) {
      if (args.only && !args.only.has(c.id.toLowerCase()) && !args.only.has(c.name.toLowerCase())) continue;
      const texDirRel = path.join(path.dirname(c.model), 'tex');
      processOne('chara', c.name, srcDir, c.model, texDirRel, destDir, args, stats.chars, report);
      if (c.arms1pv?.model) processOne('chara-arms', c.name, srcDir, c.arms1pv.model, texDirRel, destDir, args, stats.chars, report, { skipTex: true });
      lodChars.push({ name: c.name, id: c.id, model: c.model, arms1pv: c.arms1pv?.model, itemId: c.itemId, itemIds: c.itemIds, team: c.team });
    }
    if (!args.dry) fs.writeFileSync(path.join(destDir, 'index.json'), JSON.stringify({
      generated: new Date().toISOString(), tool: 'tools/asset-lod/build.mjs', maxTex: args.maxTex, chars: lodChars,
    }, null, 1));
  }

  const bad = report.filter((r) => r.error || r.ok === false);
  console.log(`processed ${report.length} models, ${bad.length} problems`);
  for (const b of bad.slice(0, 20)) console.log(' -', JSON.stringify(b));

  for (const k of ['weapons', 'chars']) {
    const s = stats[k];
    if (!s.before) continue;
    console.log(`${k}: before=${(s.before / 1e6).toFixed(1)}MB after(disk,dedup)=${(s.after / 1e6).toFixed(1)}MB after(logical)=${(s.afterLogical / 1e6).toFixed(1)}MB ratio=${(s.after / s.before * 100).toFixed(1)}%`);
  }
  if (bad.length) process.exitCode = 1;
}

main();
