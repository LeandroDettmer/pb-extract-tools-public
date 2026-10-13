// Box-filter downscale (area average), no upscale. Same approach as export-model.mjs's own maxTex
// downscale, just applied to an already-decoded RGBA buffer instead of the raw I3IB source.
export function boxDownscale(rgba, w, h, maxSide) {
  if (w <= maxSide && h <= maxSide) return { rgba, w, h };
  const scale = maxSide / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor((y * h) / nh), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor((x * w) / nw), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / nw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const si = (sy * w + sx) * 4;
        r += rgba[si]; g += rgba[si + 1]; b += rgba[si + 2]; a += rgba[si + 3]; n++;
      }
      const di = (y * nw + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
    }
  }
  return { rgba: out, w: nw, h: nh };
}
