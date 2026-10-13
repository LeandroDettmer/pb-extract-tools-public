#!/usr/bin/env node
// Weapon visual FX of the PBCross client -> web assets. Pure Node ESM, builtins only.
//
//   node web-poc/tools/export-weaponfx.mjs [--pack-dir DIR] [--out DIR]
//   default pack dir: Clients/PBCross/Pack, out: web-poc/public/assets/weapons/fx (no fallback to another client)
//
// Inputs
//   UI_Hud.i3Pack       Gui/Hud/<CROSS_SCOPE_TEX[ScopeType]>.i3i   full-screen scope / dot-sight HUD textures (512x1024 DXT5:
//                       left half of the lens in 512x768, the red dot sprite at SubScopeHudInfo.DotStartPos)
//   Effect.i3Pack       Effect/<tex>.i3i          particle / tracer / laser / bullet-mark textures
//   Effect_High.i3Pack  Effect/H/<name>.i3s       i3 particle effects (I3R2: i3ParticleInfo 'PIV1', i3Particle,
//                       i3KeyframeTable, i3TextureSequence 'STQ1', i3TimeSequenceInfo)
//   Effect_Define.i3Pack Effect/Define/Default.i3FxList  INI: [effect] Count (pool) / Decal Y|N / Priority
//   extracted/pef-cross/br/Weapon.json (PBCross Weapon.pef, joined by ITEMID via lib/cross-weapons.mjs) per-weapon
//                       Extension1 (Type, ScopeType, SubScopeType, MaxScopeLevel, FovOnZoom/FovOnScope/FovOnScope2),
//                       Effect._FireEffect, BulletTracer{}, TracerType; globals Tracer*. PBCross has no SubScopeHudInfo
//                       (the 2017 / 3.123 pef had it): subScope[] = CROSS_SUB_HUD and the index per weapon from CROSS_SUB_OF_SCOPE.
//   public/assets/weapons/weapons.json  (the runtime weapon ids: only those are written)
//
// Output (<out>/):
//   weaponfx.json   { globals, subScope[], weapons{id: {...}}, effects{name: {particles[]}}, fxList{name: {...}} }
//   tex/*.png       mip 0 of every referenced texture (RGBA)
//   scope/*.png     scope HUD textures
//
// i3 particle layout: see the notes above parseEffect() (decoded from the i3MathDx / i3SceneDx 2017 DLLs).

import { assetPath, clientPath, baseClient } from './lib/paths.mjs';
import { crossWeaponPef, crossWeaponBlocks } from './lib/cross-weapons.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parsePack, decodeContent } from './i3pack/unpack.mjs';
import { readI3R2 } from './i3r2/i3r2.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PACK_DIR = opt('--pack-dir', clientPath(baseClient(['cross']), 'Pack')); // Cross only: pef-cross Weapon.pef joins the FX
const OUT = opt('--out', assetPath('weapons', 'fx'));
const WEAPONS = assetPath('weapons', 'weapons.json');

// ---- packs ---------------------------------------------------------------------------------------------------
/** lowercase path inside the pack -> decrypted bytes; files.names = lowercase path -> path in the pack's own case */
function loadPack(name) { return loadPackAt(PACK_DIR, name); }
function loadPackAt(dir, name) {
  const d = fs.readFileSync(path.join(dir, name));
  const files = new Map();
  files.names = new Map();
  for (const n of parsePack(d).nodes) {
    if (!n.indexOk) continue;
    for (const f of n.files) {
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (f.attr) buf = decodeContent(buf, f.attr) ?? buf;
      const full = `${n.path}/${f.name}`.replace(/^\/+/, '');
      files.set(full.toLowerCase(), buf);
      files.names.set(full.toLowerCase(), full);
    }
  }
  return files;
}

// ---- I3IB -> PNG (same decoder as export-visual.mjs) -----------------------------------------------------------
function readI3IB(d) {
  if (d.toString('latin1', 0, 4) !== 'I3IB') return null;
  const w = d.readUInt16LE(6), h = d.readUInt16LE(8), format = d.readUInt32LE(10);
  const mips = d.readUInt16LE(24) || 1, pathLen = d.readUInt16LE(26);
  const data = 60 + pathLen, f = format & 0xfff;
  let kind, bpp = 0;
  if (f === 0x680 || f === 0x681) kind = 'dxt1';
  else if (f === 0x602 || f === 0x603) kind = 'dxt3';
  else if (f === 0x604 || f === 0x605) kind = 'dxt5';
  else {
    kind = 'raw';
    let px = 0;
    for (let m = 0; m < mips; m++) px += Math.max(1, w >> m) * Math.max(1, h >> m);
    bpp = Math.floor((d.length - data) / px);
    if (![3, 4].includes(bpp)) bpp = Math.floor((d.length - data) / (w * h));
    if (![3, 4].includes(bpp)) return null;
  }
  return { w, h, kind, bpp, data };
}
const c565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
function decodeI3IB(d, t) {
  const { w, h } = t;
  const out = Buffer.alloc(w * h * 4);
  if (t.kind === 'raw') {
    for (let i = 0; i < w * h; i++) {
      const s = t.data + i * t.bpp;
      out[i * 4] = d[s + 2]; out[i * 4 + 1] = d[s + 1]; out[i * 4 + 2] = d[s];
      out[i * 4 + 3] = t.bpp === 4 ? d[s + 3] : 255;
    }
    return out;
  }
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2), bsz = t.kind === 'dxt1' ? 8 : 16;
  const pal = new Array(4), alpha = new Array(16), av = new Array(8);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let b = t.data + (by * bw + bx) * bsz;
    if (t.kind === 'dxt3') {
      for (let i = 0; i < 16; i++) alpha[i] = ((d[b + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      b += 8;
    } else if (t.kind === 'dxt5') {
      const a0 = d[b], a1 = d[b + 1];
      av[0] = a0; av[1] = a1;
      if (a0 > a1) for (let i = 1; i < 7; i++) av[i + 1] = ((7 - i) * a0 + i * a1) / 7;
      else { for (let i = 1; i < 5; i++) av[i + 1] = ((5 - i) * a0 + i * a1) / 5; av[6] = 0; av[7] = 255; }
      let bits = 0n;
      for (let i = 0; i < 6; i++) bits |= BigInt(d[b + 2 + i]) << BigInt(8 * i);
      for (let i = 0; i < 16; i++) alpha[i] = av[Number((bits >> BigInt(3 * i)) & 7n)];
      b += 8;
    }
    const c0 = d.readUInt16LE(b), c1 = d.readUInt16LE(b + 2), p0 = c565(c0), p1 = c565(c1);
    pal[0] = [...p0, 255]; pal[1] = [...p1, 255];
    if (c0 > c1 || t.kind !== 'dxt1') {
      pal[2] = [0, 1, 2].map((k) => (2 * p0[k] + p1[k]) / 3).concat(255);
      pal[3] = [0, 1, 2].map((k) => (p0[k] + 2 * p1[k]) / 3).concat(255);
    } else {
      pal[2] = [0, 1, 2].map((k) => (p0[k] + p1[k]) / 2).concat(255);
      pal[3] = [0, 0, 0, 0];
    }
    const idx = d.readUInt32LE(b + 4);
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const c = pal[(idx >>> (2 * i)) & 3], o = (y * w + x) * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
      out[o + 3] = t.kind === 'dxt1' ? c[3] : alpha[i];
    }
  }
  return out;
}
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h) {
  const row = w * 4 + 1, raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * row + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}
const written = new Map(); // key -> {file, w, h}
function writeTexture(buf, dir, name) {
  const key = `${dir}/${name}`;
  if (written.has(key)) return written.get(key);
  const t = readI3IB(buf);
  if (!t) { written.set(key, null); return null; }
  fs.mkdirSync(path.join(OUT, dir), { recursive: true });
  const file = `${dir}/${name}.png`;
  fs.writeFileSync(path.join(OUT, file), encodePNG(decodeI3IB(buf, t), t.w, t.h));
  const r = { file, w: t.w, h: t.h };
  written.set(key, r);
  return r;
}
const stem = (p) => path.posix.basename(p.replace(/\\/g, '/')).replace(/\.[^.]*$/, '');


// ---- i3 particle effects (.i3s) --------------------------------------------------------------------------------
// Layouts from the 2017 DLLs (i3MathDx.dll i3ParticleInfo getters / OnLoad 0x1001feb0, i3SceneDx.dll
// i3Particle::OnLoad 0x10176220 / Drive 0x10174a70 / _Emit 0x10173100, i3KeyframeTable::OnLoad 0x1000d460,
// i3TextureSequence::OnLoad 0x101097c0, i3TimeSequenceInfo 0x100dd8e0):
//   PIV1 (offsets from the magic): +04 type (0 QUAD, 0x80000001 SPRITE, 3 MESH, 4 BILLBOARD strip spawn->pos,
//   0x60000002 velocity strip, 5 DECAL); +0c emitter life s (0 = forever); +10 particle life s; +14/+18 mass min/max;
//   +1c init count, +20 max count, +24 emit count per interval, +28 one-shot; +2c emit type (0 cone, 1 sphere, 2 cone
//   around up, 3 square, 4 disc); +30 pos, +3c dir, +48 angle deg, +4c interval, +50 up; +5c/+60 jitter; +6c posStyle
//   (bit0 jitter, bit1 linear tables, bit2 clamp speed [b4,b8], bit4 gravity); +70/+80/+90/+a4 [i] func/init/factor/table
//   of speed (i=0) and acceleration (i=1); +bc scaleStyle, +c0/+d0/+e0/+f0 scale & growth; +108.. rotation style/func/
//   init/factor/table; +128 colorStyle (bit0 random t at spawn, bit1 linear), +12c RGB func, +130 RGB init, +134..+140
//   R/G/B/A table ids, +144 alpha func, +148 alpha init; +168 rot random, +16c speed random 1+-k/2, +170 scale random,
//   +174 billboard factor, +17c capacity. Funcs: 1 const, 2 factor*sin(t*pi/2), 3 factor*cos(t*pi/2), 4 rand[-1,1],
//   5 table(t) * per-particle random factor. For alpha, 2/3 = 255*sin/cos; any other non-table/non-const = white.
//   i3KeyframeTable: u32 count, u8 hasTimes, pad to 12, f32 v[count], (hasTimes) f32 t[count]. Without times the
//   samples sit at i/count (last held); linear only with style bit1, else step.
//   PTC3 (i3Particle, after name + 'INF2'): +00 info, +04 tex, +08 texSeq, +0c mesh refs; +10 u8 blend on, +11 src,
//   +12 dst, +13 op (D3DBLEND / D3DBLENDOP); +18 u8 0 = face camera; +1c z-bias; +28 u8 decal; +29 z-write; +2a z-test
//   (2 = off). Refs 0xffff00nn / 0x8xxx00nn (bit 31) = external object nn.
//   TSQ1: +04 flags (1 loop, 2 fixed interval, 4 random frame, 8 frame chosen at spawn), +08/+0c frame w/h px,
//   +10 s per frame, +14 frame count, +18 start frame, +1c texture ref. Atlas row-major from the top-left.
//   i3TimeSequenceInfo: +0 start s, +4 duration s, +8 style (bit1 loop), +c particle ref, +10 max loops.
const FUNC = ['none', 'const', 'sin', 'cos', 'rand', 'table'];
const TYPE = { 0: 'quad', 0x80000001: 'sprite', 3: 'mesh', 4: 'billboard', 0x60000002: 'stretch', 5: 'decal' };
const r6 = (x) => (Number.isFinite(x) ? +x.toPrecision(6) : x > 0 ? 1e9 : -1e9);

function parseEffect(buf, resolveTex) {
  const r = readI3R2(buf, 0);
  const own = new Map(), ext = new Map();
  for (const o of r.objects) (o.ext ? ext : own).set(o.id, o);
  const D = (o) => buf.subarray(o.off, o.off + o.size);
  // external refs: 0xffff00nn, or bit 31 set with the object id in the low 16 bits (0x80030007, 0x800a0023:
  // Fir_Smg_Silence_Common's texture sequences; reading only 0xffff lost them -> untextured square sprites)
  const extPath = (v) => ((v & 0x80000000) !== 0 ? ext.get(v & 0xffff)?.extPath ?? null : null);
  const kft = (id) => {
    const o = id && own.get(id);
    if (!o || o.cls !== 'i3KeyframeTable') return null;
    const d = D(o), n = d.readUInt32LE(0), timed = d[4] !== 0, v = [], t = [];
    for (let i = 0; i < n; i++) v.push(r6(d.readFloatLE(12 + i * 4)));
    if (timed) for (let i = 0; i < n; i++) t.push(r6(d.readFloatLE(12 + n * 4 + i * 4)));
    return timed ? { v, t } : { v };
  };
  const F = (d, o) => r6(d.readFloatLE(o)), U = (d, o) => d.readUInt32LE(o), V3 = (d, o) => [F(d, o), F(d, o + 4), F(d, o + 8)];
  const fn = (d, fo, io, xo, to) => ({ func: FUNC[U(d, fo)] ?? U(d, fo), init: F(d, io), factor: F(d, xo), table: kft(U(d, to)) });
  const info = (d) => ({
    type: TYPE[U(d, 4)] ?? `0x${U(d, 4).toString(16)}`,
    emitterLife: F(d, 0xc), life: F(d, 0x10), mass: [F(d, 0x14), F(d, 0x18)],
    initCount: U(d, 0x1c), maxCount: U(d, 0x20), emitCount: U(d, 0x24), oneShot: U(d, 0x28) !== 0,
    emitType: U(d, 0x2c), emitPos: V3(d, 0x30), emitDir: V3(d, 0x3c), emitAngle: F(d, 0x48), emitInterval: F(d, 0x4c),
    up: V3(d, 0x50), jitterInterval: F(d, 0x5c), jitter: V3(d, 0x60),
    posStyle: U(d, 0x6c), speed: fn(d, 0x70, 0x80, 0x90, 0xa4), accel: fn(d, 0x74, 0x84, 0x94, 0xa8), speedMinMax: [F(d, 0xb4), F(d, 0xb8)],
    scaleStyle: U(d, 0xbc), scale: fn(d, 0xc0, 0xd0, 0xe0, 0xf0), grow: fn(d, 0xc4, 0xd4, 0xe4, 0xf4), scaleMinMax: [F(d, 0x100), F(d, 0x104)],
    rotStyle: U(d, 0x108), rot: fn(d, 0x10c, 0x110, 0x114, 0x118),
    colorStyle: U(d, 0x128), rgbFunc: FUNC[U(d, 0x12c)] ?? U(d, 0x12c), rgbInit: U(d, 0x130),
    R: kft(U(d, 0x134)), G: kft(U(d, 0x138)), B: kft(U(d, 0x13c)), A: kft(U(d, 0x140)),
    alphaFunc: FUNC[U(d, 0x144)] ?? U(d, 0x144), alphaInit: U(d, 0x148),
    scaleMask: V3(d, 0x15c), rotRandom: F(d, 0x168), speedRandom: F(d, 0x16c), scaleRandom: F(d, 0x170), billboardFactor: F(d, 0x174),
  });
  // texture ref: external (pack Effect/<name>.i3i) or an i3Texture stored inside the .i3s (I3IB, path at +60)
  const texRef = (v) => {
    const p = extPath(v);
    if (p) return resolveTex(p);
    const o = own.get(v);
    if (o?.cls !== 'i3Texture') return null;
    const d = D(o);
    if (d.toString('latin1', 0, 4) !== 'I3IB') return null;
    const n = d.readUInt16LE(26), ip = d.toString('latin1', 60, 60 + n).replace(/ .*$/, '');
    return resolveTex(ip, d);
  };
  const seq = (d) => {
    const fl = U(d, 4);
    return { loop: !!(fl & 1), random: !!(fl & 4), atSpawn: !!(fl & 8), fw: F(d, 8), fh: F(d, 0xc), frameTime: F(d, 0x10),
      count: U(d, 0x14), start: U(d, 0x18), tex: texRef(U(d, 0x1c)) };
  };
  const timeline = new Map();
  for (const o of r.objects) {
    if (o.ext || o.cls !== 'i3TimeSequenceInfo') continue;
    const d = D(o);
    timeline.set(U(d, 0xc), { start: F(d, 0), duration: F(d, 4), loop: !!(U(d, 8) & 2) });
  }
  const particles = [];
  for (const o of r.objects) {
    if (o.ext || o.cls !== 'i3Particle') continue;
    const d = D(o), s = d.indexOf('PTC3', 0, 'latin1') + 4;
    const name = d.toString('latin1', 1, 1 + d[0]);
    const io = own.get(U(d, s)), so = own.get(U(d, s + 8));
    if (!io) continue;
    const p = { name, ...info(D(io)) };
    const q = so ? seq(D(so)) : null;
    p.tex = texRef(U(d, s + 4)) ?? q?.tex ?? null;
    if (q) { delete q.tex; p.seq = q; }
    if (U(d, s + 12)) p.mesh = extPath(U(d, s + 12)) ?? own.get(U(d, s + 12))?.cls ?? true;
    p.blend = d[s + 0x10] ? [d[s + 0x11], d[s + 0x12]] : null;
    p.faceCamera = d[s + 0x18] === 0;
    p.decal = d[s + 0x28] !== 0;
    p.zwrite = d[s + 0x29] === 1;
    p.ztest = d[s + 0x2a] <= 1;
    p.time = timeline.get(o.id) ?? { start: 0, duration: 0, loop: false };
    particles.push(p);
  }
  return { particles };
}

/** Default.i3FxList: INI of [effect] Count= (pool size), Decal=Y|N, Priority=, Attach=, WorldCoord= */
function parseFxList(text) {
  const out = {};
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const l = line.replace(/;.*$/, '').replace(/\/\/.*$/, '').trim();
    if (!l) continue;
    const m = l.match(/^\[(.+)\]$/);
    if (m) { cur = out[m[1]] = {}; continue; }
    const kv = l.match(/^(\w+)\s*=\s*(\S+)/);
    if (cur && kv) cur[kv[1].toLowerCase()] = /^-?\d+(\.\d+)?$/.test(kv[2]) ? +kv[2] : kv[2] === 'Y' ? true : kv[2] === 'N' ? false : kv[2];
  }
  return out;
}


/** node names of a .glb (to find FXLaserSightDummy) */
function glbNodeNames(file) {
  try {
    const g = fs.readFileSync(file), jl = g.readUInt32LE(12);
    return (JSON.parse(g.toString('utf8', 20, 20 + jl)).nodes ?? []).map((n) => n.name ?? '');
  } catch { return []; }
}

export async function main() {
  const t0 = Date.now();
  const packs = {
    hud: loadPack('UI_Hud.i3Pack'),
    fxTex: loadPack('Effect.i3Pack'),
    fxHigh: loadPack('Effect_High.i3Pack'),
    fxDef: loadPack('Effect_Define.i3Pack'),
  };
  // basename (lowercase, no ext) -> bytes over the loaded packs (effects reference textures as Effect/<NAME>.i3i)
  const texByStem = new Map();
  for (const files of [packs.hud, packs.fxHigh, packs.fxTex]) for (const [k, v] of files) if (k.endsWith('.i3i')) texByStem.set(stem(k).toLowerCase(), v);
  const i3sByStem = new Map();
  for (const [k, v] of packs.fxHigh) if (k.endsWith('.i3s')) i3sByStem.set(stem(k), { name: stem(packs.fxHigh.names.get(k)), buf: v });
  const hudByName = new Map();
  for (const [k, v] of packs.hud) hudByName.set(path.posix.basename(k), v);

  const missingTex = new Set();
  // embedded: the I3IB inside the .i3s (used when the pack has no texture of that name)
  const resolveTex = (p, embedded = null) => {
    const s = stem(p).toLowerCase(), buf = texByStem.get(s) ?? embedded;
    if (!buf) { missingTex.add(p); return null; }
    return writeTexture(buf, 'tex', s.replace(/[^a-z0-9_.-]+/g, '_'))?.file ?? null;
  };

  const cfg = crossWeaponPef();
  const runtime = JSON.parse(fs.readFileSync(WEAPONS, 'utf8')).weapons;
  const models = JSON.parse(fs.readFileSync(path.join(path.dirname(WEAPONS), 'models', 'index.json'), 'utf8')).weapons ?? [];
  const pef = crossWeaponBlocks(cfg);

  // effects: fire effects of the runtime weapons (+ _1st variants), terrain hits / bullet marks, shells, blood, laser dot
  // Medical_Kit_Medic_01: the heal effect of Weapon_Medical_Kit (the pef _FireEffect "buff" is the one PBCross names)
  const want = new Set(['Env_TargetLaser_01', 'Fir_Ar_M4A1', 'Medical_Kit_Medic_01', 'Bomb', 'Bomb_Light', 'Bomb_Light_Red']); // Bomb* = C4 (Bomb Mission)
  // break effects of the map objects (tools/export-props.mjs -> objects/index.json breakEffects): glass / wall / vending / crates
  try {
    const oi = JSON.parse(fs.readFileSync(assetPath('objects', 'index.json'), 'utf8')).objects;
    for (const d of Object.values(oi)) if (d.breakable) for (const n of d.breakEffects || []) {
      const e = i3sByStem.get(n.toLowerCase());
      if (e) want.add(e.name); else console.log('  break fx not found:', n);
    }
  } catch { /* no objects/index.json yet */ }
  for (const [s, e] of i3sByStem) if (/^(hit|hmk)_(ar|sg|m9)_|^bul_|^exphu01_[012]$|^bmk_(ar|sg|sr|smg|hg)_(wa|fl)$/.test(s)) want.add(e.name);
  // PBCross ScopeType enum (0..28) -> Gui/Hud texture. [INFERIDO]: built from the Cross pef joined to the 2017 pef by Group/Key
  // (the 2017 pef names the texture; 661 weapons, 0 enum values with two names). The 22 names are exactly the Gui/Hud/*.i3i
  // strings of PointBlank.exe (rdata 0xbd1ce4..0xbd29dc, preloaded in .text 0x763e45..0x764683 into 0xd89380..0xd893e0).
  // The code that picks the global per enum was not located. Enum 0 = scope.i3i, the 2017 default.
  const CROSS_SCOPE_TEX = [
    'scope.i3i', 'scope_M4A1.i3i', 'Scope_F2000.i3i', 'Scope_G36C.i3i', 'Scope_G36C.i3i', 'scope_dotsight_sg550.i3i',
    'scope_dotsight_sg550.i3i', 'Scope_P90.i3i', 'Scope_RPG7.i3i', 'Scope_M197.i3i', 'scope_dotsight_PBTC2015.i3i', 'Scope_M14EBR.i3i',
    'Scope_Kobra.i3i', 'scope_dotsight_GRS.i3i', 'scope_dotsight_GRS.i3i', 'scope_dotsight_Demonic.i3i', 'scope_Demonic.i3i',
    'Scope_P90_Demonic.i3i', 'scope_dotsight_Demonic.i3i', 'scope_dolphin.i3i', 'scope_dotsight_dolphin.i3i', 'scope_dotsight_dolphin.i3i',
    'scope_G36C_dolphin.i3i', 'scope_P90_dolphin.i3i', 'scope_dotsight_GSL2016.i3i', 'scope_dotsight_GSL2016.i3i', 'scope_dotsight_MB2.i3i',
    'scope_dotsight_MB2.i3i', 'scope_dotsight_PBTC2016.i3i',
  ];
  // ScopeType enum -> SubScopeHudInfo idx (dot sub-rect). Cross has no SubScopeType and no SubScopeHudInfo: the index is the majority
  // 2017 SubScopeType of the same weapons (ties -> the dot one) [INFERIDO]. CROSS_SUB_HUD = the 2017 SubScopeHudInfo rows used here.
  // The dot sprite is inside its rect in the Cross texture: scope_dotsight_sg550 dot at x 12..43, y 780..811 (rect 4,773 46x46);
  // scope_g36c dot at x 11..21, y 778..788 (rect 0,768 32x32). Per-weapon exceptions (AUG DOTFREE, Kriss dot) are not in Cross data.
  const CROSS_SUB_OF_SCOPE = [0, 1, 1, 2, 3, 4, 5, 7, 8, 9, 4, 10, 10, 5, 4, 5, 0, 7, 4, 0, 5, 4, 2, 7, 5, 4, 5, 4, 4];
  const CROSS_SUB_HUD = [
    { idx: 0, dot: null, offDotLaser: true, scopeSound: true },
    { idx: 1, dot: null, offDotLaser: true, scopeSound: false },
    { idx: 2, dot: [0, 768, 32, 32], offDotLaser: true, scopeSound: false },
    { idx: 3, dot: null, offDotLaser: false, scopeSound: false },
    { idx: 4, dot: [4, 773, 46, 46], offDotLaser: true, scopeSound: false },
    { idx: 5, dot: null, offDotLaser: false, scopeSound: false },
    { idx: 7, dot: null, offDotLaser: false, scopeSound: false },
    { idx: 8, dot: null, offDotLaser: true, scopeSound: false },
    { idx: 9, dot: null, offDotLaser: true, scopeSound: false },
    { idx: 10, dot: [0, 768, 34, 34], offDotLaser: true, scopeSound: false },
  ];
  const weapons = {};
  const laserModels = new Map();
  for (const rw of runtime) {
    const e = pef.get(rw.id);
    if (!e) continue;
    // PBCross blocks are flat (no Extension1 / Effect / BulletTracer objects): Extension1.Type = _Extension, or the top-level
    // Type on the four scope guns (export-weapons.mjs does the same join); the Extension1 and BulletTracer fields sit on the block
    const w = e.w, x = { ...w, Type: w._Extension ?? (typeof w.Type === 'string' ? w.Type : undefined) };
    const o = {};
    const fire = w._FireEffect;
    if (fire) {
      o.fire = fire;
      want.add(fire);
      if (i3sByStem.has(`${fire}_1st`.toLowerCase())) { o.fire1st = `${fire}_1st`; want.add(o.fire1st); }
    }
    // Scope2 = Scope (same join as export-weapons.mjs ExtType; the four scope guns with a top-level Type "Scope2")
    if (x.Type) o.ext = x.Type === 'Scope2' ? 'Scope' : x.Type;
    if (w._ZoomType !== undefined) o.zoomType = w._ZoomType;
    for (const [k, kk] of [['FovOnZoom', 'fovZoom'], ['FovOnScope', 'fovScope'], ['FovOnScope2', 'fovScope2'], ['MaxScopeLevel', 'maxScopeLevel'], ['SubScopeType', 'subScope']]) {
      if (x[k] !== undefined) o[kk] = x[k];
    }
    // PBCross ScopeType is an enum number (0..28), see CROSS_SCOPE_TEX. A zoom-3 block without the key (the 67 KrissSuperV_*_Dummy
    // blocks; the 2017 pef has no key there either) reads as the default 0 = scope.i3i, as the 2017 exe default [INFERIDO]
    const scopeEnum = x.ScopeType ?? (w._ZoomType === 3 ? 0 : undefined);
    if (typeof scopeEnum === 'number' && CROSS_SCOPE_TEX[scopeEnum]) {
      o.scopeTex = CROSS_SCOPE_TEX[scopeEnum];
      const buf = hudByName.get(o.scopeTex.toLowerCase());
      if (buf) o.scopePng = writeTexture(buf, 'scope', stem(o.scopeTex).toLowerCase())?.file;
      else missingTex.add(`Gui/Hud/${o.scopeTex}`);
      if (o.scopePng) o.subScope = CROSS_SUB_OF_SCOPE[scopeEnum];
    }
    if (w.BulletTracer || w.BulletSmokeColor !== undefined) {
      const b = w.BulletTracer ?? w;
      o.smoke = { color: b.BulletSmokeColor, life: b.BulletSmokeLifeTime, thickness: b.BulletSmokeThickness, grow: b.BulletSmokeGrowThickness,
        startSpeed: b.BulletSmokeStartSpeed, endSpeed: b.BulletSmokeEndSpeed, repeat: b.BulletSmokeRepeatTexSize };
    }
    if (w.TracerType !== undefined) o.tracerType = w.TracerType;
    // laser sight: pef ClassMeta picks the weapon class (registered by name 0xb26e60; CDotLazer at weapon +0xa540)
    if (/^Weapon(DotLaser|GrenadeLauncherWithLaser|ShotGunLauncherWithLaser)$/.test(w.ClassMeta ?? '')) o.laser = w.ClassMeta;
    const m = models.find((mm) => (mm.itemIds ?? []).includes(rw.id));
    if (m) {
      if (!laserModels.has(m.file)) laserModels.set(m.file, glbNodeNames(path.join(path.dirname(WEAPONS), 'models', m.file)).includes('FXLaserSightDummy'));
      if (laserModels.get(m.file)) o.laserDummy = true;
    }
    weapons[rw.id] = o;
  }

  const effects = {}, missingFx = [];
  for (const n of [...want].sort()) {
    const e = i3sByStem.get(n.toLowerCase());
    if (!e) { missingFx.push(n); continue; }
    effects[e.name] = parseEffect(e.buf, resolveTex);
  }
  // tracer / bullet smoke / laser beam textures are loaded by name in the exe (Effect/%s.i3i, CTracerBulletManager::Create 0x5b0e80)
  const tex = {};
  for (const t of ['TracerBullet', 'TracerBulletSmoke', 'TracerGrenade', 'Tex_LaserBeam01', 'Tex_LaserGlow01']) tex[t] = resolveTex(`Effect/${t}.i3i`);
  const globals = { tex };
  const W = cfg.WeaponList.Weapon;
  for (const k of Object.keys(W)) if (/^Tracer/.test(k)) globals[k] = W[k];
  const fxKey = [...packs.fxDef.keys()].find((k) => k.endsWith('default.i3fxlist'));
  const fxListAll = fxKey ? parseFxList(packs.fxDef.get(fxKey).toString('latin1')) : {};
  const fxList = {};
  for (const n of Object.keys(effects)) if (fxListAll[n]) fxList[n] = fxListAll[n];

  const subScope = CROSS_SUB_HUD;

  const out = {
    source: 'PBCross client packs (UI_Hud, Effect, Effect_High, Effect_Define) + Weapon.pef PBCross (extracted/pef-cross); tools/export-weaponfx.mjs',
    generated: new Date().toISOString(),
    globals, subScope, weapons, effects, fxList,
    missing: { textures: [...missingTex].sort(), effects: missingFx },
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'weaponfx.json'), JSON.stringify(out));
  console.log(`weapons ${Object.keys(weapons).length}, effects ${Object.keys(effects).length}, textures ${[...written.values()].filter(Boolean).length}` +
    `, missing tex ${missingTex.size} fx ${missingFx.length} (${((Date.now() - t0) / 1000).toFixed(1)} s) -> ${OUT}`);
  if (missingTex.size) console.log('  missing textures:', [...missingTex].slice(0, 20).join(', '));
  if (missingFx.length) console.log('  missing effects:', missingFx.join(', '));
}

export { loadPack, readI3IB, decodeI3IB, encodePNG, parseEffect, parseFxList };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
