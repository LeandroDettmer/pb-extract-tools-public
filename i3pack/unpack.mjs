#!/usr/bin/env node
// i3Pack unpacker (Point Blank / i3Engine), pure Node ESM, builtins only.
//
//   node i3pack/unpack.mjs [MapName | pack.i3Pack ...] [--out DIR] [--raw]
//
// A single bare name with no path separator and no .i3Pack extension (e.g. "Metro")
// is treated as a map prefix: it extracts "Clients/PointBlank 3.123/Pack/<Map>*.i3Pack" into
// extracted/<Map>/<pack>/... With no args it defaults to "NStation".
// Files are written under their real names and decrypted (--raw keeps the stored bytes).
//
// Container layout (an I3R2 resource file whose objects are i3PackNode):
//   header 0xB8: +0x10 strTableOff, +0x18 strTableSize, +0x20 nodeCount,
//                +0x24 nodeTableOff, +0x2C nodeTableSize
//   node table: nodeCount x 28 bytes { u32 classIdx, u32 id, u32 0, u32 off, u32 0, u32 size, u32 0 }
//   node record @off: u8 nameLen, name, 0x4C bytes ("TRN3" tree block),
//                     u32 childId[] (values <= nodeCount),
//                     8 bytes "PFNx"+u32 fileCount   <- BitRotateDecrypt key 3
//                     PFN2: fileCount x 92-byte entries right after, each BitRotateDecrypt key 2
//                     PFN3: 2 bytes, then fileCount x 92-byte entries (= last bytes of the record),
//                           each IIA2-ciphered (see decodePfn3Entries), one 16-byte key per node
//   92-byte entry (plain), from i3BaseDx_Cli.dll i3PackNode::OnLoad (Kaybo 2017 build):
//     +0x00 char name[64] (NUL-terminated)   +0x40 u32 attr
//     size   = u16@0x4A << 16 | u16@0x46     offset = u16@0x48 << 16 | u16@0x50   (absolute)
//   attr 0x08000000 = content encrypted: + 0x00010000 (PFN3 builds) -> IIA2 in 64 KB chunks
//   (decodeContent), otherwise BitRotateDecrypt key 3 per 0x800-byte block.
//   Files of a node are contiguous: offset[i+1] = offset[i] + size[i].
//
// If an index does not decode to a contiguous chain (key recovery failed, e.g. every name of a
// node is > 32 chars) the node falls back to the old heuristic carve with synthesized names
// <index>_<hint>.<ext>; manifest.json records which path was used (node.indexOk).
//
// carve() sizes a payload by its own container when it can: I3R2 via i3r2Size, RIFF/WAV via the
// length field at +4. Only when neither applies does it fall back to "up to the next magic", which
// over-reads the last file of a node (it swallows trailing bytes and can swallow a nested RIFF —
// Sound_voice_{Man,Woman}.i3Pack shipped their Zoom_Breath payload at 10-12x its declared size).

import { clientPath, extractedPath, baseClient } from '../lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPackDir = () => clientPath(baseClient(['br3123']), 'Pack'); // 3.123 Pack, read only when unpack gets a map name
const ENTRY_SIZE = 92;

// i3Engine BitRotateDecrypt: whole buffer as a circular bitstream rotated right by `key` bits.
export function bitRotateDecrypt(buf, key) {
  const n = buf.length, out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const prev = buf[(i - 1 + n) % n];
    out[i] = ((buf[i] >> key) | (prev << (8 - key))) & 0xff;
  }
  return out;
}

// ---- IIA2 byte cipher (PFN3 entries and 0x0801xxxx file contents) --------
// Same family as tools/iia2/decode.mjs. For byte j of a block of length L, q = j & 15:
//   E = ((P ^ (j + 1)) + K[q] + B_q) ^ C_q            (mod 256)
// with the per-slot [B_q, C_q] forms below. They differ from iia2/decode.mjs FORMS in slot 7
// (B = 0, C = L, not "j + L + c7"; verified on 403 known-plaintext nodes, Kaybo PFN2 <-> 3.123 PFN3)
// and in the +-L terms of slots 3,4,5,6,13,14 (only visible when L mod 256 != 0 and the key is
// shared with a full 64 KB chunk: found on the last partial chunk of every multi-chunk .pef).
const IIA_FORMS = [
  [() => 0, () => 0], [j => j, () => 0], [j => -j, () => 0], [(j, L) => L - j, () => 0],
  [(j, L) => j - L, () => 0], [(j, L) => L, () => 0], [(j, L) => -L, () => 0], [() => 0, (j, L) => L],
  [() => 0, j => j], [() => 0, (j, L) => L - j], [(j, L) => j ^ L, () => 0], [(j, L) => -(j ^ L), () => 0],
  [() => 0, (j, L) => j ^ L], [(j, L) => j + L, () => 0], [(j, L) => -j - L, () => 0], [() => 0, (j, L) => j + L],
];
const iiaKeyByte = (e, p, j, L) => {
  const [B, C] = IIA_FORMS[j & 15];
  return ((((e ^ (C(j, L) & 255)) - (B(j, L) & 255)) & 255) - (p ^ ((j + 1) & 255))) & 255;
};
export function iiaDecode(block, K, out = Buffer.alloc(block.length), o = 0) {
  const L = block.length;
  for (let j = 0; j < L; j++) {
    const [B, C] = IIA_FORMS[j & 15];
    out[o + j] = ((((block[j] ^ (C(j, L) & 255)) - K[j & 15] - (B(j, L) & 255)) & 255) ^ ((j + 1) & 255));
  }
  return out;
}
// Key = majority vote over byte ranges known to be zero in the plaintext.
function iiaKeyFromZeros(blocks, L, from, to) {
  const K = [];
  for (let q = 0; q < 16; q++) {
    const h = new Map();
    for (const b of blocks) for (let j = from + ((q - from) & 15); j < to; j += 16) {
      const k = iiaKeyByte(b[j], 0, j, L); h.set(k, (h.get(k) || 0) + 1);
    }
    K.push([...h].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  }
  return K;
}

// PFN3 entries: bytes 0x20..0x3F are the NUL tail of names (< 32 chars) -> key for all 16 slots.
export function decodePfn3Entries(entries) {
  const K = iiaKeyFromZeros(entries, ENTRY_SIZE, 0x20, 0x40);
  return entries.map(e => iiaDecode(e, K));
}

export function parseEntry(p) {
  return {
    name: p.toString('latin1', 0, 64).replace(/\0[\s\S]*$/, ''),
    attr: p.readUInt32LE(0x40),
    size: p.readUInt16LE(0x4a) * 65536 + p.readUInt16LE(0x46),
    offset: p.readUInt16LE(0x48) * 65536 + p.readUInt16LE(0x50),
  };
}

// File contents. 0x0801xxxx: IIA2 per 64 KB chunk (L = chunk length, j chunk-local), one key per
// file; the key is recovered from the zero bytes 0x40..0xB0 of the I3R2 header, so only I3R2
// payloads (all .pef / .i3* resources) can be decoded -> returns null for anything else.
export const CONTENT_CHUNK = 0x10000;
const ROR_BLOCK = 0x800;
export function decodeContent(buf, attr) {
  if (!(attr & 0x08000000)) return buf;
  const out = Buffer.alloc(buf.length);
  if (!(attr & 0x00010000)) { // BitRotate 3, circular per 0x800-byte block (verified on Kaybo PFN2 .pef)
    for (let c = 0; c < buf.length; c += ROR_BLOCK) bitRotateDecrypt(buf.subarray(c, c + ROR_BLOCK), 3).copy(out, c);
    return out;
  }
  if (buf.length < 0xb8) return null;
  const K = iiaKeyFromZeros([buf.subarray(0, CONTENT_CHUNK)], Math.min(buf.length, CONTENT_CHUNK), 0x40, 0xb0);
  for (let c = 0; c < buf.length; c += CONTENT_CHUNK) iiaDecode(buf.subarray(c, c + CONTENT_CHUNK), K, out, c);
  return out.toString('latin1', 0, 4) === 'I3R2' ? out : null;
}

// ---- I3R2 helpers ---------------------------------------------------------
export function readI3R2Header(d, o = 0) {
  // "AVIX" = I3R2 with another magic (2022+ Portable/TH client packs): same layout, parses unchanged
  const magic = d.toString('latin1', o, o + 4);
  if (magic !== 'I3R2' && magic !== 'AVIX') return null;
  const h = {
    strOff: d.readUInt32LE(o + 0x10), strSize: d.readUInt32LE(o + 0x18),
    count: d.readUInt32LE(o + 0x20), tabOff: d.readUInt32LE(o + 0x24), tabSize: d.readUInt32LE(o + 0x2c),
  };
  if (h.tabOff + h.count * 28 > d.length - o || h.count > 1e6) return null;
  h.strings = d.toString('latin1', o + h.strOff, o + h.strOff + h.strSize).split('\r\n').map(s => s.replace(/\0+$/, ''));
  h.objects = [];
  for (let i = 0; i < h.count; i++) {
    const e = o + h.tabOff + i * 28;
    h.objects.push({ cls: d.readUInt32LE(e), id: d.readUInt32LE(e + 4), off: d.readUInt32LE(e + 12), size: d.readUInt32LE(e + 20) });
  }
  return h;
}
function i3r2Size(d, o) {
  const h = readI3R2Header(d, o);
  if (!h) return 0;
  let end = h.tabOff + h.tabSize;
  for (const ob of h.objects) end = Math.max(end, ob.off + ob.size);
  return end;
}

const MAGICS = [
  ['I3R2', 'i3r2'], ['I3IB', 'i3i'], ['RIFF', 'wav'], ['OggS', 'ogg'], ['DDS ', 'dds'],
  ['NXS\x01', 'nxs'], ['RSC2', 'rsc'], ['GINS', 'gins'], ['\x89PNG', 'png'], ['BM', 'bmp'],
];
function magicAt(d, p) {
  for (const [m, ext] of MAGICS) if (d.toString('latin1', p, p + m.length) === m) return { m, ext };
  return null;
}
function looksText(d, p, n) {
  const m = Math.min(n, 512);
  let bad = 0;
  for (let i = 0; i < m; i++) { const c = d[p + i]; if (c < 9 || (c > 13 && c < 32)) bad++; }
  return m > 0 && bad === 0;
}
function hintFor(d, p, ext) {
  if (ext !== 'i3r2') return { ext, hint: '' };
  const h = readI3R2Header(d, p);
  const s = h ? h.strings.filter(Boolean) : [];
  const has = c => s.includes(c);
  const e = has('i3SceneGraphInfo') ? (has('i3PhysixShapeSet') && !has('i3Geometry') ? 'i3s' : 'i3s')
    : has('i3Animation') || has('i3AnimationPack') ? 'i3a'
    : has('i3Texture') ? 'i3i' : 'i3r2';
  // first non-class-looking string is usually the resource/object name
  const nm = s.find(x => !/^i3[A-Z]/.test(x) && /^[\w .-]{2,40}$/.test(x)) || '';
  return { ext: e, hint: nm.replace(/[^\w.-]+/g, '_') };
}

// ---- pack parsing ---------------------------------------------------------
// Kaybo 2017 (OLD client) leaf-node file table: no "PFNx" magic. 8 bytes (a count, not further
// decoded) right after `p`, then fileCount x 0x4C-byte slots, one name entry (NUL-terminated,
// BitRotateDecrypt key 2, same as PFN2 entries) per file interleaved with a data slot this parser
// does not decode -> offset/size not recovered, only names. The very first slot's leading byte is
// corrupted in its top 2 bits (rotation block seam, same artifact worked around in
// tools/pef/extract-config.mjs): it is repaired, NOT skipped (skipping shifted every name by one). The embedded I3IB texture blobs of these packs carry no
// srcPath (see textureLibrary) and are matched back to these names positionally in
// export-model.mjs's packTextures (files of a node are contiguous, table order == physical order).
const OLD_ENTRY_SIZE = 0x4c, OLD_TABLE_HEADER = 8;
function parseOldNames(d, p, end) {
  p += OLD_TABLE_HEADER;
  const from = Math.max(0, p - 0x10); // decode a bit earlier so the first name's rotation seam falls before p
  const dec = bitRotateDecrypt(d.subarray(from, end), 2).subarray(p - from);
  const names = [];
  for (let o = 0; o + 64 <= dec.length; o += OLD_ENTRY_SIZE) {
    const raw = dec.subarray(o, o + 64);
    const nul = raw.indexOf(0);
    let nm = nul > 0 ? raw.toString('latin1', 0, nul) : '';
    // First slot: only the top 2 bits of byte 0 are wrong (rotation seam). Dropping the slot shifted every
    // name by one against carve() (Sound_Interface: names started at UI_Button_Click_Cancel, payload 0 = Click).
    if (o === 0 && nm.length > 1 && !/^[\x20-\x7e]/.test(nm)) {
      const lo = raw[0] & 0x3f, cand = [0, 1, 2, 3].map(x => (x << 6) | lo).filter(c => c >= 0x20 && c <= 0x7e);
      const sib = dec[OLD_ENTRY_SIZE]; // 1st char of the next name (names of a node usually share a prefix)
      const c = cand.includes(sib) ? sib : cand.find(c => /[A-Z]/.test(String.fromCharCode(c))) ?? cand[0];
      if (c !== undefined) nm = String.fromCharCode(c) + nm.slice(1);
    }
    if (nm.length <= 63 && /^[\x20-\x7e]+$/.test(nm) && /\.[A-Za-z0-9]{1,12}$/.test(nm)) names.push(nm);
  }
  return names;
}

export function parsePack(d) {
  const H = readI3R2Header(d, 0);
  if (!H) throw new Error('not an I3R2/i3Pack file');
  const nodes = H.objects.map((ob, i) => {
    const nl = d[ob.off];
    const name = d.toString('latin1', ob.off + 1, ob.off + 1 + nl);
    let p = ob.off + 1 + nl + 0x4c;
    const children = [];
    while (p + 4 <= ob.off + ob.size) {
      const v = d.readUInt32LE(p);
      if (v > H.count) break;
      children.push(v); p += 4;
    }
    const pfn = bitRotateDecrypt(d.subarray(p, p + 8), 3);
    const pfnVer = pfn.toString('latin1', 0, 4);
    const ok = pfnVer === 'PFN2' || pfnVer === 'PFN3';
    const fileCount = ok ? pfn.readUInt32LE(4) : 0;
    const entries = [];
    const t = pfnVer === 'PFN3' ? ob.off + ob.size - fileCount * ENTRY_SIZE : p + 8;
    for (let k = 0; k < fileCount; k++) entries.push(d.subarray(t + k * ENTRY_SIZE, t + (k + 1) * ENTRY_SIZE));
    const plain = pfnVer === 'PFN3' ? decodePfn3Entries(entries) : entries.map(e => bitRotateDecrypt(e, 2));
    let files = plain.map(parseEntry);
    let pfnVerOut = pfnVer, fileCountOut = fileCount;
    if (!ok) {
      const oldNames = parseOldNames(d, p, ob.off + ob.size);
      if (oldNames.length) { files = oldNames.map((nm) => ({ name: nm })); pfnVerOut = 'OLD'; fileCountOut = oldNames.length; }
    }
    return { index: i, id: ob.id, name, off: ob.off, size: ob.size, children, pfnOk: ok, pfnVer: pfnVerOut, fileCount: fileCountOut, entries, files };
  });
  // parent links / paths (ids are 1-based object ids)
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) for (const c of n.children) { const ch = byId.get(c); if (ch) ch.parent = n; }
  for (const n of nodes) {
    const parts = []; let q = n;
    while (q) { if (q.name !== '/') parts.unshift(q.name); q = q.parent; }
    n.path = parts.join('/');
  }
  // payload region = [end of node record, next node record or EOF)
  const starts = nodes.map(n => n.off).sort((a, b) => a - b);
  for (const n of nodes) {
    n.dataStart = n.off + n.size;
    n.dataEnd = starts.find(s => s >= n.dataStart) ?? d.length;
    n.indexOk = n.files.every((f, k) => f.offset + f.size <= d.length && f.offset >= n.dataStart &&
      (k === 0 || f.offset === n.files[k - 1].offset + n.files[k - 1].size) && /^[\x20-\x7e]+$/.test(f.name));
  }
  return { header: H, nodes };
}

/** End offset of the Ogg stream whose BOS page is at p: walk pages until the EOS page (or the next bytes are not a page) */
export function oggEnd(d, p, end) {
  for (;;) {
    const flags = d[p + 5], nseg = d[p + 26];
    let len = 27 + nseg;
    for (let i = 0; i < nseg; i++) len += d[p + 27 + i];
    p += len;
    if (flags & 4 || p >= end || d.toString('latin1', p, p + 4) !== 'OggS') return Math.min(p, end);
  }
}

/** Ogg streams (BOS page .. EOS page) in [start, end) */
export function oggStreams(d, start, end) {
  const out = [];
  let p = start;
  while ((p = d.indexOf('OggS', p, 'latin1')) >= 0 && p < end) {
    if (!(d[p + 5] & 2)) { p += 4; continue; } // not a BOS page
    const q = oggEnd(d, p, end);
    out.push(d.subarray(p, q));
    p = q;
  }
  return out;
}

export function carve(d, node) {
  const files = [];
  let p = node.dataStart;
  const end = node.dataEnd;
  const nextMagic = from => {
    let best = end;
    for (const [m] of MAGICS) {
      if (m.length < 4) continue; // 2-byte magics are too noisy to use as boundaries
      const i = d.indexOf(m, from, 'latin1');
      if (i >= 0 && i < best) best = i;
    }
    return best;
  };
  for (let k = 0; k < node.fileCount && p < end; k++) {
    const mg = magicAt(d, p);
    let size = mg?.ext === 'i3r2' ? i3r2Size(d, p) : 0;
    // RIFF/WAV: trust the container's own length (+8 for the "RIFF"+size fields). Without this the last file of a
    // node is over-read to the next magic / node end, swallowing trailing bytes and sometimes a nested RIFF
    // (Sound_voice_{Man,Woman} .i3Pack: their Zoom_Breath payload came out 10x its declared size).
    if (mg?.ext === 'wav' && p + 12 <= d.length) {
      const l = d.readUInt32LE(p + 4) + 8;
      if (l > 12 && p + l <= end) size = l;
    }
    // Ogg: every page starts with "OggS", so the next-magic fallback cut each stream after its first page
    if (mg?.ext === 'ogg' && d[p + 5] & 2) size = oggEnd(d, p, end) - p;
    if (!size || p + size > end) size = (k === node.fileCount - 1 ? end : nextMagic(p + 4)) - p;
    // zero padding between payloads belongs to the preceding file
    let z = p + size;
    while (z < end && z - (p + size) < 64 && d[z] === 0) z++;
    if (z > p + size && (z === end || magicAt(d, z))) size = z - p;
    const { ext, hint } = hintFor(d, p, mg?.ext || (looksText(d, p, size) ? 'txt' : 'bin'));
    files.push({ index: k, offset: p, size, magic: mg?.m?.replace(/[^\x20-\x7e]/g, '.') || null, ext, hint });
    p += size;
  }
  return { files, leftover: end - p };
}

export function unpack(packFile, outRoot, { raw = false } = {}) {
  const d = fs.readFileSync(packFile);
  const base = path.basename(packFile).replace(/\.i3Pack$/i, '');
  const { header, nodes } = parsePack(d);
  const outDir = path.join(outRoot, base);
  const manifest = { pack: path.basename(packFile), size: d.length, strings: header.strings, nodes: [] };
  let total = 0, warn = 0;
  for (const n of nodes) {
    const dir = path.join(outDir, ...n.path.split('/').filter(Boolean));
    let files, leftover = 0;
    if (n.indexOk) {
      files = n.files.map((f, index) => ({ index, ...f }));
      const last = files[files.length - 1];
      if (last) leftover = n.dataEnd - (last.offset + last.size);
    } else {
      ({ files, leftover } = carve(d, n));
      for (const f of files) f.name = `${String(f.index).padStart(3, '0')}${f.hint ? '_' + f.hint : ''}.${f.ext}`;
    }
    if (files.length) fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      f.path = path.relative(outDir, path.join(dir, f.name)).split(path.sep).join('/');
      let buf = d.subarray(f.offset, f.offset + f.size);
      if (!raw && f.attr) {
        const dec = decodeContent(buf, f.attr);
        f.decrypted = !!dec;
        if (dec) buf = dec; else warn++;
      }
      fs.writeFileSync(path.join(dir, f.name), buf);
    }
    if (files.length !== n.fileCount || leftover !== 0 || !n.indexOk) warn++;
    total += files.length;
    manifest.nodes.push({
      name: n.name, path: n.path, id: n.id, children: n.children, pfnOk: n.pfnOk, pfnVer: n.pfnVer,
      fileCount: n.fileCount, indexOk: n.indexOk, leftoverBytes: leftover,
      files: files.map((f, i) => ({ ...f, entryEnc: n.indexOk ? undefined : n.entries[i]?.toString('hex') })),
    });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { base, nodes: nodes.length, files: total, expected: nodes.reduce((a, n) => a + n.fileCount, 0), warn };
}

// ---- CLI ------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = null;
  const oi = args.indexOf('--out');
  if (oi >= 0) { out = path.resolve(args[oi + 1]); args.splice(oi, 2); }
  const ri = args.indexOf('--raw');
  const raw = ri >= 0;
  if (raw) args.splice(ri, 1);
  const isMapName = args.length === 1 && !/[\\/]/.test(args[0]) && !/\.i3Pack$/i.test(args[0]);
  const mapName = isMapName ? args[0] : 'NStation';
  if (out === null) out = extractedPath(mapName);
  const packs = args.length && !isMapName ? args : fs.readdirSync(defaultPackDir())
    .filter(f => new RegExp(`^${mapName}.*\\.i3Pack$`, 'i').test(f)).map(f => path.join(defaultPackDir(), f));
  let bad = 0;
  for (const p of packs) {
    try {
      const r = unpack(p, out, { raw });
      if (r.warn || r.files !== r.expected) bad++;
      console.log(`${r.base}: nodes=${r.nodes} files=${r.files}/${r.expected}${r.warn ? ' WARN(see manifest)' : ''}`);
    } catch (e) { bad++; console.error(`${path.basename(p)}: ERROR ${e.message}`); }
  }
  console.log(`out: ${out}`);
  process.exitCode = bad ? 1 : 0;
}
