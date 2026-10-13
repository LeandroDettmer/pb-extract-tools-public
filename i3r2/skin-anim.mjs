// i3AnimPack (APF1 / APF2 / APF3) reader: Point Blank's packed skeletal animation clips (.i3a), pure Node ESM.
//
// File layout (little endian, recovered from the SWAT_Male / SWAT_Female packs):
//   +0x00 'APF3' | 'APF2' | 'APF1'   +0x04 u32 clipCount   (APF1, 2015-2017 packs: same layout, f32 pools only, type-1 clips)
//   +0x08 u32 vec3Count32   +0x0c u32 quatCount32   (f32 pools, used by type-1 clips)
//   +0x14 u32 dataBase (= 0xa4 + clipCount * 284)   +0x1c u32 dataSize (dataBase + dataSize == file size)
//   +0x24 u32 vec3Count16   +0x28 u32 quatCount16   (f16 pools, used by type-2/3 clips)
//   +0xa4 clipCount x 284-byte entries: u32 type (2 | 3), u32 trackCount, u32 0, u32 clipOffset, u32 0,
//         char path[264] ("chara/swat_male/3pv/common/Low_Stand_Idle.i3a")
//   @dataBase: shared key pools, then the clip records
//         vec3Count32 x (3 x f32), quatCount32 x (4 x f32 x,y,z,w), vec3Count16 x (3 x f16), quatCount16 x (4 x f16)
//         (translations bone-local, metres, asset Z-up space; rotations bone-local, same handedness as glTF: use as-is)
//   @dataBase + clipOffset: clip record
//         trackCount x { u32 0, char boneName[32] }
//         trackCount x 72-byte track: u32 flags, u32 keyCount, f32 frameInterval (0 = explicit times),
//                                     u32 ptrT, u32 ptrR, u32 ptrS, u32 ptrTime (runtime pointers, 0 = absent),
//                                     u32 0, f32 duration, u8[4], 32 x 0
//         then per track, in order: T index[keyCount] (u32 -> vec3 pool), R index[keyCount] (u32 -> quat pool),
//                                   S index[keyCount] (u32 -> vec3 pool), time[keyCount] (f32 seconds)
//         (APF2 / type-2 clips: u16 indices and f16 key times, contiguous, record padded to 4 bytes; type-1 clips index the f32 pools)
//   flags: 0x1 translation, 0x2 rotation, 0x4 scale, 0x8 explicit key times,
//          0x10 translation is constant (1 index), 0x20 rotation is constant (1 index), 0x40 the third vec3 channel ("S") is constant (1 index,
//          weapon packs: 870MCS ReloadD_Master); 0x80 unknown (ignored).
// The layout is verified per clip: the index/time arrays must end exactly where the next clip starts.

import fs from 'node:fs';

const f16 = (h) => {
  const s = h >> 15, e = (h >> 10) & 31, m = h & 1023;
  const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15);
  return s ? -v : v;
};

export function readAnimPack(file) { // file: path, or a Buffer holding the APF block (weapon packs embed one)
  const d = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  const magic = d.toString('latin1', 0, 4);
  if (!['APF1', 'APF2', 'APF3'].includes(magic)) throw new Error(`${file}: unsupported anim pack ${JSON.stringify(magic)}`);
  const count = d.readUInt32LE(4), base = d.readUInt32LE(0x14);
  const nV32 = d.readUInt32LE(8), nQ32 = d.readUInt32LE(12), nV = d.readUInt32LE(0x24), nQ = d.readUInt32LE(0x28);
  if (base !== 0xa4 + count * 284) throw new Error(`${file}: data base ${base.toString(16)} != entry table end`);
  const q32Base = base + nV32 * 12, v16Base = q32Base + nQ32 * 16, q16Base = v16Base + nV * 6;
  const pools = {
    f32: {
      vec: (i) => { if (i >= nV32) throw new Error(`vec3/f32 index ${i} >= ${nV32}`); const o = base + i * 12; return [d.readFloatLE(o), d.readFloatLE(o + 4), d.readFloatLE(o + 8)]; },
      quat: (i) => { if (i >= nQ32) throw new Error(`quat/f32 index ${i} >= ${nQ32}`); const o = q32Base + i * 16; return [0, 4, 8, 12].map((k) => d.readFloatLE(o + k)); },
    },
    f16: {
      vec: (i) => { if (i >= nV) throw new Error(`vec3/f16 index ${i} >= ${nV}`); const o = v16Base + i * 6; return [f16(d.readUInt16LE(o)), f16(d.readUInt16LE(o + 2)), f16(d.readUInt16LE(o + 4))]; },
      quat: (i) => { if (i >= nQ) throw new Error(`quat/f16 index ${i} >= ${nQ}`); const o = q16Base + i * 8; return [0, 2, 4, 6].map((k) => f16(d.readUInt16LE(o + k))); },
    },
  };
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 0xa4 + i * 284;
    entries.push({ type: d.readUInt32LE(e), tracks: d.readUInt32LE(e + 4), off: base + d.readUInt32LE(e + 12), path: d.toString('latin1', e + 20, e + 284).replace(/\0.*$/s, '') });
  }
  const ends = entries.map((e) => e.off).sort((a, b) => a - b);
  const endOf = (off) => ends.find((o) => o > off) ?? d.length;

  const readClip = (E) => {
    if (![1, 2, 3].includes(E.type)) throw new Error(`${E.path}: unknown clip type ${E.type}`);
    const { vec, quat } = E.type === 1 ? pools.f32 : pools.f16;
    let p = E.off;
    const names = [];
    for (let t = 0; t < E.tracks; t++, p += 36) names.push(d.toString('latin1', p + 4, p + 36).replace(/\0.*$/s, ''));
    const desc = [];
    for (let t = 0; t < E.tracks; t++, p += 72) {
      desc.push({ bone: names[t], flags: d.readUInt32LE(p), n: d.readUInt32LE(p + 4), dt: d.readFloatLE(p + 8), duration: d.readFloatLE(p + 32),
        ptr: [12, 16, 20, 24].map((k) => d.readUInt32LE(p + k) !== 0) });
    }
    const idx = E.type === 2 // APF2 clips store u16 key indices, the others u32
      ? (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = d.readUInt16LE(p + i * 2); p += n * 2; return a; }
      : (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = d.readUInt32LE(p + i * 4); p += n * 4; return a; };
    const f32s = E.type === 2 // APF2: key times are f16 too
      ? (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = f16(d.readUInt16LE(p + i * 2)); p += n * 2; return a; }
      : (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = d.readFloatLE(p + i * 4); p += n * 4; return a; };
    let duration = 0;
    const tracks = desc.map((t) => {
      const has = [t.flags & 1, t.flags & 2, t.flags & 4, t.flags & 8].map(Boolean);
      has.forEach((h, k) => { if (h !== t.ptr[k]) throw new Error(`${E.path}/${t.bone}: flags ${t.flags.toString(16)} disagree with pointers`); });
      const nT = t.flags & 0x10 ? 1 : t.n, nR = t.flags & 0x20 ? 1 : t.n; // constant translation / rotation: one key
      const nS = t.flags & 0x40 ? 1 : t.n;
      const T = has[0] ? idx(nT).map(vec) : null, R = has[1] ? idx(nR).map(quat) : null, S = has[2] ? idx(nS).map(vec) : null;
      const times = has[3] ? f32s(t.n) : Array.from({ length: t.n }, (_, i) => i * t.dt);
      duration = Math.max(duration, t.duration);
      return { bone: t.bone, flags: t.flags, times, T, R, S, duration: t.duration };
    });
    const end = endOf(E.off);
    if (p !== end && ((p + 3) & ~3) !== end) throw new Error(`${E.path}: clip layout mismatch, parsed to ${p.toString(16)}, next record at ${end.toString(16)}`);
    const name = E.path.replace(/^.*\//, '').replace(/\.i3a$/i, '');
    return { path: E.path, name, duration, tracks };
  };
  return { file, magic, entries, clip: (i) => readClip(entries[i]), find: (re) => entries.map((e, i) => [e, i]).filter(([e]) => re.test(e.path)).map(([, i]) => i) };
}

// Sample a track (linear T, nlerp/slerp R) at time t; returns { T, R } (either may be null).
export function sampleTrack(tr, t) {
  const n = tr.times.length;
  const at = (arr, k) => arr[Math.min(k, arr.length - 1)]; // constant channels hold a single key
  let i = 0;
  while (i + 1 < n && tr.times[i + 1] <= t) i++;
  const j = Math.min(i + 1, n - 1);
  const span = tr.times[j] - tr.times[i];
  const a = span > 0 ? Math.min(1, Math.max(0, (t - tr.times[i]) / span)) : 0;
  const lerp = (x, y) => x.map((v, k) => v + (y[k] - v) * a);
  let R = null;
  if (tr.R) {
    const q0 = at(tr.R, i), q1 = at(tr.R, j);
    const dot = q0.reduce((s, v, k) => s + v * q1[k], 0);
    const q = q0.map((v, k) => v + ((dot < 0 ? -q1[k] : q1[k]) - v) * a);
    const l = Math.hypot(...q) || 1;
    R = q.map((v) => v / l);
  }
  return { T: tr.T ? lerp(at(tr.T, i), at(tr.T, j)) : null, R, S: tr.S ? lerp(at(tr.S, i), at(tr.S, j)) : null };
}
