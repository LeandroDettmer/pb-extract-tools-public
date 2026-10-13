// i3Gui reader (Point Blank "classic" UI, the pre-i3UIs engine GUI) - pure Node ESM.
//
// The classic clients (EpicBlackout, PB 2013-2016) keep their windows as i3GuiRoot resource files: an I3R2 container
// (tools/i3r2/i3r2.mjs) embedded in Pack/UI_Project_*.i3Pack (the i3Pack "OLD" node parser only extracts the first blob,
// the others start at the next 'I3R2' magic). Layout decoded from the Option window (UI_Project_Popup) [INFERIDO from
// the bytes, cross-checked on tab buttons 82x24 / window 392x525 / atlas rects]:
//
//   control object (i3GuiStatic / Button / EditBox / CheckBox / RadioButton / PopupList / List / Window):
//     u8 nameLen, name, 'GND1', then u32 words w[0..]:
//       w[2]  parent control id (the i3GuiWindow / another control)
//       w[11] x  (f32, relative to the parent)   w[12] y (f32)
//       w[13] width (u32)                        w[14] height (u32)
//       w[17] i3GUI_EVENT_DATA id (buttons: sound + event)      w[55] i3GuiControlData id
//   i3GuiControlData: u8 0, u32 templateElementId, then 0xffffffff filler, tail flags @+405.. (scale floats 1.0)
//   i3GuiTemplateElement: u8 nameLen, name ("Null", "Window", "LongButton"...), 'GTE1', u32 version(1), u32 imageCount,
//     u32 flags, 4 x u32 0, imageCount x u32 i3GuiImage id (one per state: button 0 normal 1 over 2 down 3 disabled;
//     "Window" = 9 pieces already sized for the control)
//   i3GuiImage (81 bytes): u8 0, 'GIM1', u64 texture ref (low u32 0x8000_0000 | stringIdx << 16 | i3Texture object id),
//     i32 dx, dy placement inside the control, then u32 u, v, srcW, srcH (atlas rect), dstW, dstH, flipX, flipY (bool
//     != 0 -> image +0x44 / +0x45, i3GuiImage::OnLoad, PB RUSSIA i3GuiDx 0x1001aed9), 7 x u32 reserved (0). The exe can
//     also flip a shape at run time: i3GuiStatic::SetShapeFlip (i3GuiDx 0x10040d30) writes the same two bytes, the
//     draw passes them to i3Sprite2D::SetFlip (0x10014890).
//   i3Texture: external ref to Gui/Main/UI_Source01.i3i ... (Source01 = UI_Main-SourceA/000.i3i of the EpicBlackout pack)
//
// Texts are not in the file: the exe assigns them by control name (opPlay -> "Jogar" ...).
import { readI3R2, scanI3R2 } from '../i3r2/i3r2.mjs';

const CONTROLS = new Set(['i3GuiStatic', 'i3GuiButton', 'i3GuiEditBox', 'i3GuiCheckBox', 'i3GuiRadioButton', 'i3GuiPopupList',
  'i3GuiPopupListWithScroll', 'i3GuiList', 'i3GuiSlider', 'i3GuiProgressBar', 'i3GuiTextBox', 'i3Gui3DView', 'i3GuiWindow']);

/** Every I3R2 blob of a pack file (the first one is the tool's "000_Null" extraction) parsed as an i3Gui set. */
export function readGuiSets(buf) {
  return scanI3R2(buf).filter((r) => r.objects.some((o) => o.cls === 'i3GuiRoot')).map((r) => parseGui(buf, r));
}

export function parseGui(buf, r) {
  const data = (o) => buf.subarray(o.off, o.off + o.size);
  const u32 = (d, i) => d.readUInt32LE(i);
  const tex = new Map();
  for (const o of r.objects) if (o.cls === 'i3Texture') tex.set(o.id, o.extPath);
  const images = new Map();
  for (const o of r.objects) {
    if (o.cls !== 'i3GuiImage') continue;
    const d = data(o), w = [];
    for (let i = 5; i + 4 <= d.length; i += 4) w.push(u32(d, i));
    images.set(o.id, { tex: w[0] & 0xffff, dx: w[2], dy: w[3], u: w[4], v: w[5], sw: w[6], sh: w[7], dw: w[8], dh: w[9], fx: w[10] !== 0, fy: w[11] !== 0 });
  }
  const templates = new Map();
  for (const o of r.objects) {
    if (o.cls !== 'i3GuiTemplateElement') continue;
    const d = data(o), nl = d[0], name = d.toString('latin1', 1, 1 + nl), w = [];
    for (let i = 1 + nl + 4; i + 4 <= d.length; i += 4) w.push(u32(d, i));
    templates.set(o.id, { name, images: w.slice(7, 7 + w[1]).map((id) => images.get(id)).filter(Boolean) });
  }
  const cdata = new Map();
  for (const o of r.objects) if (o.cls === 'i3GuiControlData') cdata.set(o.id, templates.get(u32(data(o), 1)) ?? null);
  const nodes = new Map();
  for (const o of r.objects) {
    if (!CONTROLS.has(o.cls)) continue;
    // The table size of a control does not count its name (record = u8 nameLen, name, 'GND1', 64 words): a name longer
    // than ~35 chars cut w[55] off and the control came out as an orphan 0x0 (Cross UI_Project_Clan/Popup/Lobby).
    const d = buf.subarray(o.off, Math.min(buf.length, o.off + o.size + 64)), nl = d[0], name = d.toString('latin1', 1, 1 + nl), p = 1 + nl + 4;
    const w = (k) => u32(d, p + 4 * k);
    if (p + 4 * 56 > d.length) { nodes.set(o.id, { id: o.id, cls: o.cls.slice(5), name, parent: 0, x: 0, y: 0, w: 0, h: 0, tpl: null, children: [] }); continue; }
    const f = (k) => d.readFloatLE(p + 4 * k);
    const tpl = cdata.get(w(55)) ?? null;
    nodes.set(o.id, { id: o.id, cls: o.cls.slice(5), name, parent: w(2), x: f(11), y: f(12), w: w(13), h: w(14), tpl, children: [] });
  }
  const roots = [];
  for (const n of nodes.values()) (nodes.get(n.parent) ?? { children: roots }).children.push(n);
  return { base: r.base, version: r.version, textures: Object.fromEntries(tex), roots, nodes };
}

export function walk(n, fn, depth = 0) { fn(n, depth); for (const c of n.children) walk(c, fn, depth + 1); }
