// Skinned GLB checks, no browser: bind pose must give back the raw mesh, animated poses must not stretch or spike.
// node verify-skins.mjs [--assets <dir>] [--report <file.json>] [--only <substr>]
// Exit 1 when any skinned GLB fails. Report JSON to --report, one row per asset on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { cpus } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { assetPath, settings } from './lib/paths.mjs';
import { readGLB } from './i3r2/skin-glb.mjs';

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; };
const ASSETS = isMainThread ? path.resolve(arg('--assets', assetPath())) : workerData.assets;
const REPORT = path.resolve(arg('--report', path.join(settings.extracted, 'verify', `skins-${path.basename(ASSETS)}.json`)));
const ONLY = arg('--only', null);

const BIND_TOL = 0.01;  // m: skinned bind vertex vs raw vertex (1 cm)
const BBOX_MAX = 1.6;   // animated bbox diagonal / bind bbox diagonal (correct chars <= 1.44)
const SPIKE_MAX = 1.2;  // m: vertex distance to its dominant joint, animated minus bind (correct chars <= 0.91)
// m: bind-pose vertex distance to its dominant (highest weight) joint, per mesh. Catches blend indices that point at the
// wrong bone (palette slots read as skeleton ids): the skin stays self-consistent, so the bind test passes, but every
// vertex hangs off a far-away bone. Correct chars: median <= 0.27, p90 <= 0.40; palette bug: median >= 0.46, p90 >= 0.74.
const DOM_MEDIAN_MAX = 0.4, DOM_P90_MAX = 0.7;
const FRAMES = [0.25, 0.5, 0.75]; // fraction of each clip sampled
const SAMPLE_VERTS = 4000; // animated checks read every Nth vertex (about this many per model); bind check reads all

// ---- transforms ---------------------------------------------------------------------------
const trsOf = (n) => {
  if (!n.matrix) return { t: n.translation ?? [0, 0, 0], r: n.rotation ?? [0, 0, 0, 1], s: n.scale ?? [1, 1, 1] };
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  new Matrix4().fromArray(n.matrix).decompose(p, q, s);
  return { t: [p.x, p.y, p.z], r: [q.x, q.y, q.z, q.w], s: [s.x, s.y, s.z] };
};
const composeTRS = (x) => new Matrix4().compose(new Vector3(...x.t), new Quaternion(...x.r), new Vector3(...x.s));

// world matrix of every node (parent chain applied)
function worlds(nodes, locals) {
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parent[c] = i; }));
  const w = new Array(nodes.length);
  const at = (i) => w[i] ?? (w[i] = parent[i] < 0 ? locals[i] : at(parent[i]).clone().multiply(locals[i]));
  return nodes.map((_, i) => at(i));
}

// skinning matrix per joint: jointWorld * inverseBind (glTF: the mesh node's own transform is ignored)
function jointMats(sk, W) {
  const out = new Float64Array(sk.joints.length * 16);
  sk.joints.forEach((j, k) => {
    const ib = sk.ibm ? new Matrix4().fromArray(sk.ibm.subarray(k * 16, k * 16 + 16)) : new Matrix4();
    out.set(W[j].clone().multiply(ib).elements, k * 16);
  });
  return out;
}

// skin one primitive: positions in, skinned positions out
function skinPrim(p, M, stride = 1) {
  const n = p.pos.length / 3, res = new Float64Array(n * 3);
  for (let i = 0; i < n; i += stride) {
    const px = p.pos[3 * i], py = p.pos[3 * i + 1], pz = p.pos[3 * i + 2];
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = p.wgt[4 * i + k];
      if (!w) continue;
      const o = p.jnt[4 * i + k] * 16;
      x += w * (M[o] * px + M[o + 4] * py + M[o + 8] * pz + M[o + 12]);
      y += w * (M[o + 1] * px + M[o + 5] * py + M[o + 9] * pz + M[o + 13]);
      z += w * (M[o + 2] * px + M[o + 6] * py + M[o + 10] * pz + M[o + 14]);
    }
    res[3 * i] = x; res[3 * i + 1] = y; res[3 * i + 2] = z;
  }
  return res;
}

const relOf = (f) => path.relative(ASSETS, f).split(path.sep).join('/');
const dist = (a, ai, b, bi) => Math.hypot(a[ai] - b[bi], a[ai + 1] - b[bi + 1], a[ai + 2] - b[bi + 2]);

// ---- load a skinned model -----------------------------------------------------------------
const normWeights = (g, ai) => {
  const a = g.J.accessors[ai], w = g.read(ai);
  if (!a.normalized) return w;
  const d = a.componentType === 5121 ? 255 : 65535;
  return Float32Array.from(w, (v) => v / d);
};

function loadModel(file) {
  const g = readGLB(file), nodes = g.J.nodes;
  const base = nodes.map(trsOf);
  const locals = base.map(composeTRS);
  const skins = [];
  nodes.forEach((n, ni) => {
    if (n.mesh === undefined || n.skin === undefined) return;
    const sk = g.J.skins[n.skin], mesh = g.J.meshes[n.mesh];
    const prims = mesh.primitives.filter((p) => p.attributes.POSITION !== undefined && p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined)
      .map((p) => ({ pos: g.read(p.attributes.POSITION), jnt: g.read(p.attributes.JOINTS_0), wgt: normWeights(g, p.attributes.WEIGHTS_0) }));
    const ibm = sk.inverseBindMatrices !== undefined ? g.read(sk.inverseBindMatrices) : null;
    skins.push({ name: mesh.name ?? `node${ni}`, joints: sk.joints, ibm, prims });
  });
  return { file, g, nodes, base, locals, skins };
}

// structural checks: indices, weights, NaN, inverse bind matrices
function structure(model) {
  const err = {};
  const add = (k, n = 1) => { if (n) err[k] = (err[k] ?? 0) + n; };
  for (const sk of model.skins) {
    const nJ = sk.joints.length;
    if (sk.ibm && sk.ibm.length !== nJ * 16) add('ibm count');
    for (const j of sk.joints) if (!model.nodes[j]) add('joint node missing');
    for (let k = 0; sk.ibm && k < nJ; k++) {
      const det = new Matrix4().fromArray(sk.ibm.subarray(k * 16, k * 16 + 16)).determinant();
      if (!Number.isFinite(det)) add('ibm NaN');
      else if (Math.abs(det) < 1e-9) add('ibm singular');
    }
    for (const p of sk.prims) {
      for (const v of p.pos) if (!Number.isFinite(v)) { add('NaN position'); break; }
      for (const v of p.wgt) if (!Number.isFinite(v)) { add('NaN weight'); break; }
      for (let i = 0; i < p.wgt.length; i += 4) {
        const s = p.wgt[i] + p.wgt[i + 1] + p.wgt[i + 2] + p.wgt[i + 3];
        if (Math.abs(s - 1) > 1e-3) add('weight sum != 1');
      }
      for (let i = 0; i < p.jnt.length; i++) if (p.jnt[i] >= nJ) { add('joint index >= joints.length'); break; }
    }
  }
  return err;
}

// ---- bind pose ------------------------------------------------------------------------------
// fills prim.bindDist (per-vertex distance to dominant joint in bind pose) and prim.dom (dominant node)
function bindTest(model) {
  const W = worlds(model.nodes, model.locals);
  const errs = [], ibmOff = [];
  let bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  let verts = 0;
  const dom = []; // per mesh: median/p90 of bindDist
  for (const sk of model.skins) {
    const M = jointMats(sk, W), dd = [];
    sk.joints.forEach((j, k) => {
      let e = 0;
      for (let c = 0; c < 16; c++) e = Math.max(e, Math.abs(M[k * 16 + c] - (c % 5 === 0 ? 1 : 0)));
      if (e > BIND_TOL) ibmOff.push(j);
    });
    for (const p of sk.prims) {
      const S = skinPrim(p, M), n = p.pos.length / 3;
      p.dom = new Int32Array(n); p.bindDist = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        errs.push(dist(S, 3 * i, p.pos, 3 * i));
        let best = 0; for (let k = 1; k < 4; k++) if (p.wgt[4 * i + k] > p.wgt[4 * i + best]) best = k;
        p.dom[i] = sk.joints[p.jnt[4 * i + best]];
        const jp = W[p.dom[i]].elements;
        p.bindDist[i] = Math.hypot(S[3 * i] - jp[12], S[3 * i + 1] - jp[13], S[3 * i + 2] - jp[14]);
        for (let a = 0; a < 3; a++) { bmin[a] = Math.min(bmin[a], S[3 * i + a]); bmax[a] = Math.max(bmax[a], S[3 * i + a]); }
      }
      verts += n;
      for (const d of p.bindDist) dd.push(d);
    }
    if (dd.length) {
      dd.sort((a, b) => a - b);
      const q = (f) => dd[Math.min(dd.length - 1, Math.floor(f * dd.length))];
      dom.push({ mesh: sk.name, median: q(0.5), p90: q(0.9) });
    }
  }
  errs.sort((a, b) => a - b);
  const pick = (q) => errs.length ? errs[Math.min(errs.length - 1, Math.floor(q * errs.length))] : 0;
  const diag = bmin[0] === Infinity ? 0 : Math.hypot(...bmax.map((v, a) => v - bmin[a]));
  return { max: pick(1), p99: pick(0.99), verts, ibmOff: ibmOff.length, bindDiag: diag, dom };
}

// ---- animation clips that target this skeleton -----------------------------------------------
// clip = { src, name, dur, channels: [{ node, path, times, vals, interp }] }; node = index in the model
// Library clips are read once (libCache) and keyed by node NAME: the runtime plays swat_male clips on every skeleton.
const libCache = new Map();

function chanOf(g, anim, c) {
  const s = anim.samplers[c.sampler];
  return { path: c.target.path, times: g.read(s.input), vals: g.read(s.output), interp: s.interpolation ?? 'LINEAR' };
}

// every animation of a library file, channels keyed by node name (cached per file)
function libClips(lib) {
  if (libCache.has(lib)) return libCache.get(lib);
  const g = readGLB(lib), out = [];
  for (const a of g.J.animations ?? []) {
    const chans = a.channels.filter((c) => c.target.path !== 'weights' && g.J.nodes[c.target.node]?.name !== undefined)
      .map((c) => ({ name: g.J.nodes[c.target.node].name, ...chanOf(g, a, c) }));
    if (chans.length) out.push({ src: path.relative(ASSETS, lib).split(path.sep).join('/'), name: a.name ?? '', dur: Math.max(...chans.map((c) => c.times.at(-1))), chans });
  }
  libCache.set(lib, out);
  return out;
}

function clipsFor(model) {
  const nameToNode = new Map();
  model.nodes.forEach((n, i) => { if (n.name && !nameToNode.has(n.name)) nameToNode.set(n.name, i); });
  const out = [];
  for (const a of model.g.J.animations ?? []) {
    const chans = a.channels.filter((c) => c.target.path !== 'weights').map((c) => ({ node: c.target.node, ...chanOf(model.g, a, c) }));
    if (chans.length) out.push({ src: 'embedded', name: a.name ?? '', dur: Math.max(...chans.map((c) => c.times.at(-1))), channels: chans });
  }
  for (const lib of libsFor(model.file)) {
    for (const c of libClips(lib)) {
      const chans = c.chans.filter((ch) => nameToNode.has(ch.name)).map((ch) => ({ ...ch, node: nameToNode.get(ch.name) }));
      if (chans.length) out.push({ src: c.src, name: c.name, dur: c.dur, channels: chans });
    }
  }
  return out;
}

// JSON chunk only (libraries can be large)
function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(20); fs.readSync(fd, h, 0, 20, 0);
    const jl = h.readUInt32LE(12), jb = Buffer.alloc(jl); fs.readSync(fd, jb, 0, jl, 20);
    return jb.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// anim libraries: the char's own anim1pv/anim3pv, else the swat_male set the runtime plays on every skeleton
// (charAnimLib.ts / viewmodel.ts read chars/swat_male/anim*). *_1pv -> anim1pv, else anim3pv.
const CLIP_SOURCE = path.join(ASSETS, 'chars', 'swat_male');
function libsFor(file) {
  const sub = path.basename(file).includes('_1pv') ? 'anim1pv' : 'anim3pv';
  const own = path.join(path.dirname(file), sub);
  const dir = fs.existsSync(own) ? own : path.join(CLIP_SOURCE, sub);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort().map((f) => path.join(dir, f)) : [];
}

// sample one channel at time t. Returns array (3 for translation/scale, 4 for rotation)
function sample(c, t) {
  const T = c.times, n = T.length, nc = c.path === 'rotation' ? 4 : 3;
  const cub = c.interp === 'CUBICSPLINE', stride = cub ? 3 * nc : nc;
  const val = (k) => Array.from({ length: nc }, (_, o) => c.vals[k * stride + (cub ? nc : 0) + o]);
  if (t <= T[0]) return val(0);
  if (t >= T[n - 1]) return val(n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  if (c.interp === 'STEP') return val(lo);
  const a = (t - T[lo]) / (T[hi] - T[lo]);
  const A = val(lo), B = val(hi);
  if (nc === 4) {
    const dot = A.reduce((s, v, i) => s + v * B[i], 0), sg = dot < 0 ? -1 : 1;
    const q = A.map((v, i) => v * (1 - a) + sg * B[i] * a), len = Math.hypot(...q);
    return q.map((v) => v / len);
  }
  return A.map((v, i) => v * (1 - a) + B[i] * a);
}

// node locals at time t: clip channels override TRS of the nodes they target
function poseAt(model, clip, t) {
  const trs = new Map();
  for (const c of clip.channels) {
    const x = trs.get(c.node) ?? { ...model.base[c.node], t: [...model.base[c.node].t], r: [...model.base[c.node].r], s: [...model.base[c.node].s] };
    x[c.path === 'translation' ? 't' : c.path === 'rotation' ? 'r' : 's'] = sample(c, t);
    trs.set(c.node, x);
  }
  const locals = model.locals.slice();
  for (const [n, x] of trs) locals[n] = composeTRS(x);
  return locals;
}

// one sampled frame: bbox ratio vs bind, worst spike (vertex distance to dominant joint, minus its bind distance)
function frameMetrics(model, locals, bindDiag, stride) {
  const W = worlds(model.nodes, locals);
  let bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity], spike = 0;
  for (const sk of model.skins) {
    const M = jointMats(sk, W);
    for (const p of sk.prims) {
      const S = skinPrim(p, M, stride), n = p.pos.length / 3;
      for (let i = 0; i < n; i += stride) {
        for (let a = 0; a < 3; a++) { bmin[a] = Math.min(bmin[a], S[3 * i + a]); bmax[a] = Math.max(bmax[a], S[3 * i + a]); }
        const jp = W[p.dom[i]].elements;
        const d = Math.hypot(S[3 * i] - jp[12], S[3 * i + 1] - jp[13], S[3 * i + 2] - jp[14]);
        spike = Math.max(spike, Math.abs(d - p.bindDist[i]));
      }
    }
  }
  const diag = Math.hypot(...bmax.map((v, a) => v - bmin[a]));
  return { ratio: bindDiag > 0 ? diag / bindDiag : 1, spike };
}

// ---- one asset ------------------------------------------------------------------------------
function checkAsset(file) {
  const rel = relOf(file);
  const reasons = [];
  let model;
  try { model = loadModel(file); } catch (e) {
    const none = { maxCm: null, p99Cm: null, verts: 0, ibmOffJoints: 0, domMedianM: null, domP90M: null, domMeshes: [] };
    return { file: rel, status: 'FAIL', reasons: [`unreadable: ${e.message}`], bind: none, clips: { tested: 0, embedded: 0, worstBBoxRatio: 0, worstSpikeM: 0 }, worstClip: '-', failingClips: [], failingClipCount: 0 };
  }
  const st = structure(model);
  for (const [k, v] of Object.entries(st)) reasons.push(`${k} x${v}`);
  const bind = bindTest(model);
  const stride = Math.max(1, Math.floor(bind.verts / SAMPLE_VERTS));
  if (bind.max > BIND_TOL) reasons.push(`bind max ${(bind.max * 100).toFixed(1)} cm`);
  for (const d of bind.dom) if (d.median > DOM_MEDIAN_MAX || d.p90 > DOM_P90_MAX) reasons.push(`vertex far from its bone (${d.mesh}: median ${d.median.toFixed(2)} m, p90 ${d.p90.toFixed(2)} m)`);
  const domWorst = bind.dom.reduce((a, b) => (b.median > a.median ? b : a), { median: 0, p90: 0 });
  const clips = clipsFor(model);
  let worst = { ratio: 0, clip: null }, worstSpike = { spike: 0, clip: null };
  const failing = [];
  for (const clip of clips) {
    let r = 0, s = 0;
    for (const f of FRAMES) {
      const m = frameMetrics(model, poseAt(model, clip, f * clip.dur), bind.bindDiag, stride);
      r = Math.max(r, m.ratio); s = Math.max(s, m.spike);
    }
    if (r > worst.ratio) worst = { ratio: r, clip: `${clip.src}:${clip.name}` };
    if (s > worstSpike.spike) worstSpike = { spike: s, clip: `${clip.src}:${clip.name}` };
    if (r > BBOX_MAX || s > SPIKE_MAX) failing.push({ clip: `${clip.src}:${clip.name}`, bboxRatio: +r.toFixed(2), spikeM: +s.toFixed(2) });
  }
  if (worst.ratio > BBOX_MAX) reasons.push(`anim bbox x${worst.ratio.toFixed(2)} (${worst.clip})`);
  if (worstSpike.spike > SPIKE_MAX) reasons.push(`anim spike ${worstSpike.spike.toFixed(2)} m (${worstSpike.clip})`);
  const worstClip = failing.length
    ? failing.reduce((a, b) => (b.spikeM > a.spikeM || b.bboxRatio > a.bboxRatio ? b : a)).clip
    : (worst.clip ?? worstSpike.clip ?? '-');
  return {
    file: rel, status: reasons.length ? 'FAIL' : 'PASS', reasons,
    bind: { maxCm: +(bind.max * 100).toFixed(3), p99Cm: +(bind.p99 * 100).toFixed(3), verts: bind.verts, ibmOffJoints: bind.ibmOff, domMedianM: +domWorst.median.toFixed(3), domP90M: +domWorst.p90.toFixed(3), domMeshes: bind.dom.map((d) => ({ mesh: d.mesh, medianM: +d.median.toFixed(3), p90M: +d.p90.toFixed(3) })) },
    clips: { tested: clips.length, embedded: model.g.J.animations?.length ?? 0, worstBBoxRatio: +worst.ratio.toFixed(3), worstSpikeM: +worstSpike.spike.toFixed(3) },
    worstClip, failingClips: failing.slice(0, 50), failingClipCount: failing.length,
  };
}

// ---- main -----------------------------------------------------------------------------------
function walkGlb(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkGlb(p, out);
    else if (e.name.endsWith('.glb')) out.push(p);
  }
  return out;
}

// worker: checks its share of the files, posts the rows back
if (!isMainThread) {
  parentPort.postMessage(workerData.files.map(checkAsset));
} else {
  const files = walkGlb(ASSETS).filter((f) => {
    try { return !!JSON.parse(readHead(f)).skins; } catch { return false; }
  }).filter((f) => !ONLY || relOf(f).includes(ONLY));
  // one worker per core (max 8), files dealt round-robin
  const n = Math.max(1, Math.min(files.length, cpus().length, 8));
  const shares = Array.from({ length: n }, (_, i) => files.filter((_, j) => j % n === i));
  const runShare = (list) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { assets: ASSETS, files: list } });
    w.once('message', resolve);
    w.once('error', reject);
  });
  const t0 = Date.now();
  const rows = (await Promise.all(shares.map(runShare))).flat().sort((a, b) => a.file.localeCompare(b.file));
  const failed = rows.filter((r) => r.status === 'FAIL');
  const report = {
    generated: new Date().toISOString(), assets: ASSETS,
    thresholds: { bindCm: BIND_TOL * 100, domMedianM: DOM_MEDIAN_MAX, domP90M: DOM_P90_MAX, bboxRatio: BBOX_MAX, spikeM: SPIKE_MAX, frames: FRAMES, sampleVerts: SAMPLE_VERTS },
    summary: { skinned: rows.length, failed: failed.length, seconds: +((Date.now() - t0) / 1000).toFixed(1) },
    files: rows,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('asset', 44)}${pad('bind max cm', 13)}${pad('bind p99 cm', 13)}${pad('bone med/p90 m', 16)}${pad('clips', 7)}${pad('worst clip', 60)}verdict`);
  for (const r of rows) {
    console.log(`${pad(r.file, 44)}${pad(r.bind.maxCm, 13)}${pad(r.bind.p99Cm, 13)}${pad(`${r.bind.domMedianM}/${r.bind.domP90M}`, 16)}${pad(r.clips.tested, 7)}${pad(r.worstClip, 60)}${r.status}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}`);
  }
  console.log(`\nverify skins: ${rows.length} skinned GLB, ${failed.length} failed. report: ${REPORT} (${report.summary.seconds}s, ${n} workers)`);
  process.exitCode = failed.length ? 1 : 0;
}