# Text attributes of the Point Blank Cross i3Gui controls, read from the exe's calls (docs/I3GUI.md "Texto").
#   pbx re cross-text   (needs `pip install pefile capstone`)
# Writes data/cross-ui-text.json, merged into ui/cross/<pack>.json by export-classic-ui.mjs.
#
# The .gui files keep no text attribute (i3GuiControl/ObjBase/EditBox::OnLoad of Clients/PBCross/i3GuiDx.dll read only
# x/y/w/h, the 20 event data ids, the control data id and one u32), so every EditBox gets the i3GuiRoot defaults at load
# (ADDControlByGUI 0x10012b6f: CreateTextEx(root font, 10 pt, FW_NORMAL), align left/top, white, auto wrap on) and every
# Button caption the i3GuiControl defaults (centre/middle). The exe then changes them per control: this script finds every
# call of i3GuiEditBox::SetTextAlign / SetTextColor / ReCreateTextEx / CreateTextEx / SetTextSpace / SetOffsetPos /
# SetTextAutoWrap, i3GuiControl::CreateCaption / SetCaptionColor / SetCaptionTextSpace / SetCaptionTextOffset and of the
# two helpers 0x7d2d50 (caption button: CreateCaption 10 pt FW_NORMAL + colour 14) and 0x7d3b00 (window caption: align
# 1,1 + colour arg + SetText), takes `ecx` = this->member (or this->slot[i].member for the sprintf families) and maps
# the member offset to the control name with tools/data/cross-ui-map.json (the class = the function holding the LinkControl
# call; the nearest ones to the caller, else to its callers). Also followed: local pointer arrays walked by a loop
# (`[ebp + i*4 - N]`, with the `i % 2` split), and `this->slot[i].ctrl` with a stride over named members.
# Colours: index into the GUI colour table filled by 0x791000 (read by 0x7913c0). The value kept per control is the
# first call by address (the init code follows the link function); `alt` counts other values set at runtime.
import collections
import json
import os
import re
import struct

import capstone
import pefile

EXE = os.path.join(os.environ["PB_CLIENT_CROSS"], "PointBlank.exe")
MAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "cross-ui-map.json")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "cross-ui-text.json")
COLOR_FN, FONT_FN, COLOR_TABLE_INIT = 0x7913c0, 0x4ada50, 0x791000
HELPERS = {0x7d2d50: 'INIT_CAPTION_BUTTON', 0x7d3b00: 'INIT_WIN_CAPTION'}

pe = pefile.PE(EXE)
B = pe.OPTIONAL_HEADER.ImageBase
text = [s for s in pe.sections if s.Name.startswith(b'.text')][0]
TD, TVA = text.get_data(), B + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
imp = {i.address: (i.name or b'').decode() for d in pe.DIRECTORY_ENTRY_IMPORT for i in d.imports}
API = re.compile(r'^\?(SetTextAlign|SetTextColor|ReCreateTextEx|CreateTextEx|SetTextSpace|SetOffsetPos|SetTextAutoWrap)@i3GuiEditBox'
                 r'|^\?(CreateCaption|SetCaptionColor|SetCaptionTextOffset|SetCaptionTextSpace)@i3GuiControl')
want = {}
for a, n in imp.items():
    m = API.match(n)
    if m: want[a] = m.group(1) or 'Caption:' + m.group(2)


def colors():
    """GUI colour table: 0x791000 = 32 x i3Color::Set(&tbl[i], r, g, b, a)."""
    out, st = {}, []
    for ins in md.disasm(TD[COLOR_TABLE_INIT - TVA:COLOR_TABLE_INIT - TVA + 0x3c0], COLOR_TABLE_INIT):
        if ins.mnemonic == 'push' and re.fullmatch(r'0x[0-9a-f]+|\d+', ins.op_str): st.append(int(ins.op_str, 0))
        elif ins.mnemonic == 'call':
            if len(st) >= 5: out[(st[-1] - 0xd894d8) // 4] = '#%02x%02x%02x' % (st[-2], st[-3], st[-4])
            st = []
        if ins.mnemonic == 'ret': break
    return [out.get(i) for i in range(32)]


def fstart(va):
    o = va - TVA
    while o > 0:
        o -= 1
        if TD[o:o + 3] == b'\x55\x8b\xec' and (TD[o - 1] in (0xcc, 0xc3, 0x90) or TD[o - 3] == 0xc2): return TVA + o
    return None


def f32(va):
    b = pe.get_data(va - B, 4)
    return round(struct.unpack('<f', b)[0], 3) if len(b) == 4 else None


def scan():
    sites = []
    for a in want:
        pat, i = b'\xff\x15' + struct.pack('<I', a), -1
        while (i := TD.find(pat, i + 1)) >= 0: sites.append(TVA + i)
    for i in range(len(TD) - 5):
        if TD[i] == 0xe8 and TVA + i + 5 + struct.unpack_from('<i', TD, i + 1)[0] in HELPERS: sites.append(TVA + i)
    funcs = collections.defaultdict(list)
    for s in sites:
        f = fstart(s)
        if f: funcs[f].append(s)
    out = []
    num = r'(0x[0-9a-f]+|\d+)'
    for f, ss in funcs.items():
        reg, stack, fpu, lastcol, local = {}, [], [], None, {}
        is_this = lambda r: reg.get(r, ('',))[0] == 'this'
        code = list(md.disasm(TD[f - TVA:max(ss) + 0x400 - TVA], f))
        # loop bounds: `cmp dword ptr [ebp - i], N` on the index local of a `for (i = 0; i < N; i++)`
        bound = {}
        for ins in code:
            if ins.mnemonic == 'cmp' and (mm := re.fullmatch(r'dword ptr \[ebp - ' + num + r'\], ' + num, ins.op_str)):
                bound.setdefault(int(mm.group(1), 0), int(mm.group(2), 0))
        # `if (i % 2 == 0) {...} else {...}` inside the loop (lbInfoWin lb*Key / lb*Value pairs): div by 2, test edx, jne
        odd_from = None
        for k, ins in enumerate(code[:-3]):
            if (ins.mnemonic, ins.op_str) == ('div', 'ecx') and code[k - 1].op_str == 'ecx, 2'                     and code[k + 1].op_str == 'edx, edx' and code[k + 2].mnemonic == 'jne':
                jne, odd = code[k + 2].address, int(code[k + 2].op_str, 16)
                end = next((c.address for c in code[k:] if c.mnemonic == 'jmp' and c.address > odd
                            and re.fullmatch(r'0x[0-9a-f]+', c.op_str) and int(c.op_str, 16) < c.address), odd)
                odd_from = (jne, odd, end)
        for ins in code:
            if ins.address > max(ss): break
            m, op = ins.mnemonic, ins.op_str
            parity = None if not odd_from or not odd_from[0] < ins.address <= odd_from[2] else int(ins.address >= odd_from[1])
            if m == 'push':
                stack.append(int(op, 0) if re.fullmatch(r'-?' + num, op) else reg.get(op, ('?', op)))
            elif m == 'fld':
                mm = re.fullmatch(r'dword ptr \[(0x[0-9a-f]+)\]', op)
                fpu.append(f32(int(mm.group(1), 16)) if mm else None)
            elif m in ('fldz', 'fld1'): fpu.append(0.0 if m == 'fldz' else 1.0)
            elif m == 'fstp' and op == 'dword ptr [esp]':
                if stack: stack[-1] = fpu.pop() if fpu else None
            elif m == 'imul' and (mm := re.fullmatch(r'(\w+), (\w+), ' + num, op)):
                # i * sizeof(slot): remember the stride and the index local (for its loop bound)
                idx = reg.get(mm.group(2), ('',))
                reg[mm.group(1)] = ('idx', int(mm.group(3), 0), idx[1] if idx[0] == 'this' else None)
            elif m == 'mov':
                dst, _, src = op.partition(', ')
                if mm := re.fullmatch(r'dword ptr \[ebp - ' + num + r'\]', dst):
                    # local copies of control pointers (`CTRL* arr[] = {this->a, this->b, ...}`)
                    local[int(mm.group(1), 0)] = reg.get(src, ('?',))
                    continue
                v = ('?', src)
                if mm := re.fullmatch(r'dword ptr \[ebp - ' + num + r'\]', src):
                    x = int(mm.group(1), 0)
                    v = local[x] if local.get(x, ('',))[0] == 'member' else ('this', x)
                elif mm := re.fullmatch(r'dword ptr \[ebp \+ (\w+)\*4 - ' + num + r'\]', src):
                    x, i = int(mm.group(2), 0), reg.get(mm.group(1), ('',))
                    n = bound.get(i[1]) if i[0] == 'this' else None
                    offs = []
                    for k in range(n or 64):
                        e = local.get(x - 4 * k, ('',))
                        if e[0] != 'member': break
                        offs.append(e[1])
                    v = ('locarr', offs if parity is None else offs[parity::2])
                elif mm := re.fullmatch(r'dword ptr \[(\w+) \+ ' + num + r'\]', src):
                    if is_this(mm.group(1)): v = ('member', int(mm.group(2), 0))
                elif mm := re.fullmatch(r'dword ptr \[(\w+) \+ (\w+)(\*4)? \+ ' + num + r'\]', src):
                    a, b = reg.get(mm.group(1), ('',)), reg.get(mm.group(2), ('',))
                    if a[0] == 'this' or b[0] == 'this':
                        i = b if a[0] == 'this' else a
                        if mm.group(3): stride, n = 4, bound.get(i[1]) if i[0] == 'this' else None
                        elif i[0] == 'idx': stride, n = i[1], bound.get(i[2])
                        else: stride = n = None
                        v = ('slot', int(mm.group(4), 0), stride, n)
                reg[dst] = v
            elif m == 'lea': reg[op.split(',')[0]] = ('?',)
            elif m == 'call':
                mm = re.fullmatch(r'dword ptr \[(0x[0-9a-f]+)\]', op)
                tgt = int(op, 16) if re.fullmatch(r'0x[0-9a-f]+', op) else None
                if mm and int(mm.group(1), 16) in want:
                    out.append((f, ins.address, want[int(mm.group(1), 16)], reg.get('ecx'), list(reversed(stack)), None))
                    stack, lastcol, reg['eax'] = [], None, ('?',)
                elif tgt in HELPERS:
                    out.append((f, ins.address, HELPERS[tgt], stack[-1] if stack else None, list(reversed(stack))[1:], lastcol))
                    stack, lastcol = [], None
                elif tgt == COLOR_FN:
                    lastcol = stack.pop() if stack else None
                    reg['eax'] = ('color', lastcol)
                elif tgt == FONT_FN: reg['eax'] = ('font',)
                else: stack, reg['eax'] = [], ('?',)
            elif m == 'add' and op.startswith('esp, '):
                n = int(op[5:], 0) // 4
                stack = stack[:-n] if n <= len(stack) else []
    return out


def main():
    cmap = json.load(open(MAP, encoding='utf8'))
    cls = collections.defaultdict(dict)
    for win, ents in cmap.items():
        lf = ents.get('_window', {}).get('linkFn') if isinstance(ents, dict) else None
        if not lf: continue
        for name, e in ents.items():
            if not name.startswith('_') and isinstance(e.get('member'), str):
                # group by the function that really holds the LinkControl call: the shop/profile/clan tabs are their own
                # classes (this = the tab), linked in their own functions (0xa5f080, 0xa666e0, 0x865290...), not in the
                # window's linkFn
                f = fstart(int(e['link'], 16)) if e.get('link') else None
                cls[f or int(lf, 16)][int(e['member'], 16)] = (win, name, e)
    lfs = sorted(cls)

    def resolve(fns, ecx, api):
        """ecx = ('member', off) | ('slot', off, stride, n) | ('locarr', [off...]) -> [(win, name, entry)]"""
        edit = not api.startswith(('Caption:', 'INIT_CAPTION'))
        ok = lambda hit, member: hit and member == ('%' not in hit[1]) and (hit[2].get('cls') == 'EditBox') == edit
        near = lambda fn: [lf for lf in sorted(lfs, key=lambda l: abs(l - fn))[:3] if abs(lf - fn) <= 0x30000]
        for lf in [lf for fn in fns for lf in near(fn)]:
            c = cls[lf]
            if ecx[0] == 'member' and ok(c.get(ecx[1]), True): return [c[ecx[1]]]
            if ecx[0] == 'slot':
                if ok(c.get(ecx[1]), False): return [c[ecx[1]]]
                # this->slot[i].ctrl over named members (lbSpecialWar*Description, stride 0x14): needs the loop bound
                _, off, stride, n = ecx
                hits = [c.get(off + k * stride) for k in range(n or 0)] if stride else []
                if hits and all(ok(h, True) for h in hits): return hits
            if ecx[0] == 'locarr' and ecx[1]:
                hits = [c.get(o) for o in ecx[1]]
                if all(ok(h, True) for h in hits): return hits
        return []

    pal = colors()
    col = lambda v: pal[v[1]] if isinstance(v, tuple) and v[0] == 'color' and isinstance(v[1], int) and 0 <= v[1] < 32 else None
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    res = collections.defaultdict(lambda: collections.defaultdict(list))
    stats = collections.Counter()
    # methods compiled far from their class (CPopupOption video/capacity tabs at 0xa78760/0xa7bbc0, CPopupCommunity
    # 0x88c550...) are looked up again from their callers: `mov ecx, [ebp - this]; call fn`, up to 2 levels
    calls = collections.defaultdict(list)
    for i in range(6, len(TD) - 5):
        if TD[i] == 0xe8 and (TD[i - 3:i - 1] == bytes([0x8b, 0x4d]) or TD[i - 6:i - 4] == bytes([0x8b, 0x8d])):
            calls[TVA + i + 5 + struct.unpack_from('<i', TD, i + 1)[0]].append(TVA + i)
    up = lambda fn: list(dict.fromkeys(f for c in calls.get(fn, []) if (f := fstart(c)) and f != fn))
    for fn, site, api, ecx, a, lastcol in sorted(scan(), key=lambda x: x[1]):
        fns = [fn] + up(fn)
        fns += [g for f in fns[1:] for g in up(f)]
        hits = resolve(fns, ecx, api) if isinstance(ecx, tuple) and ecx[0] in ('member', 'slot', 'locarr') else []
        stats['resolved' if hits else 'unresolved'] += 1
        for win, name, ent in hits:
            put = lambda k, v, name=name: v is not None and res[name][k].append((hex(site), v))
            if api == 'SetTextAlign' and all(num(v) for v in a[:2]): put('align', a[:2])
            elif api == 'SetTextColor': put('color', col(a[0]) if a else None)
            elif api in ('ReCreateTextEx', 'CreateTextEx') and len(a) > 5 and num(a[2]) and num(a[5]): put('font', [a[2], a[5]])
            if api in ('ReCreateTextEx', 'CreateTextEx') and len(a) > 7 and num(a[6]) and num(a[7]): put('shadow', [a[6], a[7]])
            elif api == 'SetTextSpace' and all(num(v) for v in a[:2]): put('space', a[:2])
            elif api == 'SetOffsetPos' and all(num(v) for v in a[:2]): put('offset', a[:2])
            elif api == 'SetTextAutoWrap' and a and num(a[0]): put('wrap', a[0])
            elif api == 'Caption:CreateCaption' and len(a) > 3 and num(a[2]): put('font', [a[2], a[3]])
            elif api == 'Caption:SetCaptionColor': put('color', col(a[0]) if a else None)
            elif api == 'Caption:SetCaptionTextSpace' and all(num(v) for v in a[:2]): put('space', a[:2])
            elif api == 'Caption:SetCaptionTextOffset' and all(num(v) for v in a[:2]): put('offset', a[:2])
            elif api == 'INIT_CAPTION_BUTTON': put('font', [10, 400]); put('color', pal[14]); put('caption', 1)
            elif api == 'INIT_WIN_CAPTION':
                put('align', [1, 1])
                put('color', (col(a[1]) if len(a) > 1 else None) or col(('color', lastcol)))
            res[name]['_win'] = win
            if ent.get('instances'): res[name]['_inst'] = ent['instances']
    out = {}
    for name, attrs in sorted(res.items()):
        o = {}
        for k, v in attrs.items():
            if k.startswith('_'): o[k[1:]] = v; continue
            o[k] = v[0][1]
            o.setdefault('va', {})[k] = v[0][0]
            alt = len({json.dumps(x[1]) for x in v}) - 1
            if alt: o.setdefault('alt', {})[k] = alt
        if any(k in o for k in ('align', 'color', 'font', 'space', 'offset', 'wrap', 'caption', 'shadow')): out[name] = o
    meta = {
        'exe': 'Point Blank Cross V-37 PointBlank.exe', 'tool': 're/cross-text-attrs.py',
        'align': '[h, v]: h 0 left 1 centre 2 right, v 0 top 1 middle 2 bottom (i3TextAttrDX2::_ArrangeText i3SceneDx 0x101041d0)',
        'font': '[point size, weight]: pixel cell height = round(pt * dpi / 72) (i3Gfx::FontPointToPixel, lfHeight > 0)',
        'shadow': '[enable, FONT_SHADOW_QUALITY] = CreateTextEx/ReCreateTextEx args 7/8 -> i3TextAttrDX2 state 0x20000 (i3SceneDx'
                  ' CreateEx 0x10105ba7); quality 1/2 = 4 copies at (-1,-1) (1,-1) (-1,1) (1,1), else 1 copy at (1,1), colour'
                  ' black alpha 255 (ctor 0x1010478a), drawn under the glyph (docs/I3GUI.md "Sombra")',
        'defaults': {'EditBox': {'align': [0, 0], 'font': [10, 400], 'color': '#ffffff', 'wrap': 1, 'shadow': [0, 0]},
                     'Caption': {'align': [1, 1], 'wrap': 1, 'shadow': [0, 0]}},
        'palette': pal, 'stats': dict(stats),
    }
    json.dump({'_meta': meta, **out}, open(OUT, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(OUT, len(out), 'controls', dict(stats))


main()
