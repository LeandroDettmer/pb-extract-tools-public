// I3R2 resource container (i3Engine / Point Blank), pure Node ESM.
//
// Header (0xB8 bytes, little endian):
//   +0x00 'I3R2'   +0x08 u16 major, u16 minor (1.7 / 1.9)
//   +0x0C u32 stringCount   +0x10 u64 stringTableOff   +0x18 u64 stringTableSize
//   +0x20 u32 objectCount   +0x24 u64 objectTableOff   +0x2C u64 objectTableSize
// String table: CRLF separated (class names + external resource paths).
// Object entry (28 bytes): u32 classStringIdx, u32 id, u32 0, u64 offset, u64 size
//   (offsets are relative to the start of the I3R2 blob; ids are 1-based).
// An id with bit 31 set is an external reference: (id >> 16) & 0x7fff = string index of the
// referenced file, id & 0xffff = the object id used by the references in this file.
// I3R2 1.7 external refs are 0xffff0000 | stringIndex: the low half is the string index (it can collide with
// a real object id), so they are keyed by the full raw id (resolve refs with byId.get(ref) first).

export function readI3R2(buf, base = 0) {
  if (buf.toString('latin1', base, base + 4) !== 'I3R2') throw new Error('not I3R2 @' + base);
  const u64 = (o) => Number(buf.readBigUInt64LE(base + o));
  const version = buf.readUInt16LE(base + 8) + '.' + buf.readUInt16LE(base + 10);
  const strOff = u64(0x10), strSize = u64(0x18);
  const objCount = buf.readUInt32LE(base + 0x20), objOff = u64(0x24);
  const strings = buf.toString('latin1', base + strOff, base + strOff + strSize).replace(/\0+$/, '').split('\r\n');
  const objects = [];
  const byId = new Map();
  for (let i = 0; i < objCount; i++) {
    const e = base + objOff + i * 28;
    const cls = strings[buf.readUInt32LE(e)];
    const rawId = buf.readUInt32LE(e + 4);
    const off = base + Number(buf.readBigUInt64LE(e + 12));
    const size = Number(buf.readBigUInt64LE(e + 20));
    const ext = (rawId & 0x80000000) !== 0;
    const v17 = ext && rawId >>> 16 === 0xffff;
    const id = ext ? rawId & 0xffff : rawId;
    const o = { index: i, cls, id, off, size, ext, extPath: ext ? strings[v17 ? id : (rawId >>> 16) & 0x7fff] : null };
    objects.push(o);
    if (v17) byId.set(rawId, o);
    else byId.set(id, o);
  }
  for (const o of objects) if (o.ext && !byId.has(o.id)) byId.set(o.id, o); // 1.7: the low id too, when no real object has it
  let end = objOff + objCount * 28;
  for (const o of objects) end = Math.max(end, o.off - base + o.size);
  return { base, version, strings, objects, byId, end };
}

// Every I3R2 blob embedded in a buffer (scan by magic, keep the ones that parse).
export function scanI3R2(buf) {
  const out = [];
  const magic = Buffer.from('I3R2');
  for (let p = buf.indexOf(magic); p >= 0; p = buf.indexOf(magic, p + 1)) {
    try { out.push(readI3R2(buf, p)); } catch { /* false positive */ }
  }
  return out;
}
