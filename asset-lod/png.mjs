// Minimal PNG codec for the textures this repo produces (8-bit, color type 2 RGB / 6 RGBA, single IDAT
// or several, filtered per PNG spec). Builtins only (zlib). Not a general-purpose PNG reader: no palette,
// no interlace, no 16-bit support, because tools/i3r2/skin-glb.mjs:encodePNG never emits those.
import zlib from 'node:zlib';

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported color type ${colorType}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 8 + len + 4;
  }
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prevRow = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[off]; off++;
    const row = raw.subarray(off, off + stride); off += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prevRow[x];
      const c = x >= ch ? prevRow[x - ch] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`unsupported filter ${filter}`);
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const si = x * ch, di = (y * w + x) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = ch === 4 ? cur[si + 3] : 255;
    }
    prevRow = cur;
  }
  return { width: w, height: h, hasAlpha: colorType === 6, rgba: out };
}
