# RE coverage map for the Point Blank Cross exe: doldecomp-style progress, not a matching decompilation.
#   py <tools>/re/coverage.py [exe] [game root]    (default root = cwd: run from the game repo root; needs capstone)
#   writes web-poc/docs/re/cross_symbols.tsv + cross_rejected.tsv + coverage.html (treemap, self-contained), web-poc/docs/re-coverage.svg (static treemap for READMEs) and prints the summary
#   status: ported (cited) / inferido (every citation [INFERIDO]) / untouched.
#   A VA counts only if it is an exact Cross function start or its comment contains `cross`; others are rejected.
import bisect
import collections
import datetime
import json
import os
import re
import struct
import sys
from xml.sax.saxutils import escape

import capstone

ROOT = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
EXE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "Clients", "PBCross", "PointBlank.exe")
OUT_DIR = os.path.join(ROOT, "web-poc", "docs", "re")
SCAN_DIRS = [os.path.join(ROOT, "web-poc", "src"), os.path.join(ROOT, "web-poc", "docs")]
SCAN_EXT = (".ts", ".mjs", ".md")
JMP_RE = re.compile(r"^0x[0-9a-f]+$")
CITE_RE = re.compile(r"(?<![0-9A-Za-z_])0x([0-9a-fA-F]{6,8})(?![0-9A-Za-z_])")
TD_RE = re.compile(rb"\.\?A[UV][\x21-\x7e]+?@@\x00")

# ---- PE headers (PE32 only, image base from the optional header) ----
p = open(EXE, "rb").read()
pe = struct.unpack_from("<I", p, 0x3C)[0]
if p[pe:pe + 4] != b"PE\0\0":
    raise SystemExit("not a PE file: " + EXE)
nsec = struct.unpack_from("<H", p, pe + 6)[0]
opt_size = struct.unpack_from("<H", p, pe + 20)[0]
opt = pe + 24
if struct.unpack_from("<H", p, opt)[0] != 0x10B:
    raise SystemExit("not PE32 (x86)")
entry_rva = struct.unpack_from("<I", p, opt + 16)[0]
base = struct.unpack_from("<I", p, opt + 28)[0]
exp_rva, exp_size = struct.unpack_from("<II", p, opt + 96)
secs = []  # (name, rva, rawptr, rawsize, flags)
for i in range(nsec):
    name, _, rva, rawsize, rawptr, _, _, _, _, flags = struct.unpack_from(
        "<8sIIIIIIHHI", p, opt + opt_size + i * 40)
    secs.append((name.rstrip(b"\0").decode(), rva, rawptr, rawsize, flags))
text = next(s for s in secs if s[0] == ".text")
text_lo = base + text[1]
text_hi = text_lo + text[3]
code = p[text[2]:text[2] + text[3]]


def rva_off(r):
    for _, rva, ro, rs, _ in secs:
        if rva <= r < rva + rs:
            return ro + r - rva
    return None


def file_va(off):
    for _, rva, ro, rs, _ in secs:
        if ro <= off < ro + rs:
            return base + rva + off - ro
    return None


def u32(va):
    o = rva_off(va - base)
    return struct.unpack_from("<I", p, o)[0] if o is not None and o + 4 <= len(p) else None


def kind_of(mn):
    if mn == "call":
        return "c"
    if mn == "jmp":
        return "j"
    if mn[:1] == "j":
        return "k"
    if mn.startswith("ret") or mn.startswith("iret") or mn in ("int3", "ud2", "hlt"):
        return "r"
    return ""


# ---- linear sweep of .text (resync by 1 byte on undecodable bytes) ----
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
insns = {}  # va -> (size, kind, direct target or None)
off, CH = 0, 1 << 16
while off < len(code):
    nxt = off
    for i in md.disasm(code[off:off + CH], text_lo + off):
        kd = kind_of(i.mnemonic)
        tgt = int(i.op_str, 16) if kd in ("c", "j", "k") and JMP_RE.match(i.op_str) else None
        insns[i.address] = (i.size, kd, tgt)
        nxt = i.address - text_lo + i.size
    off = nxt if nxt > off else off + 1

# ---- seeds: entry, exports, E8 call targets (vtable slots added after RTTI) ----
starts = set()
names = collections.defaultdict(list)
if base + entry_rva in insns:
    starts.add(base + entry_rva)
if exp_rva:
    o = rva_off(exp_rva)
    n_fn, n_nm, a_fn, a_nm, a_ord = struct.unpack_from("<IIIII", p, o + 20)
    for i in range(n_fn):
        fn_rva = struct.unpack_from("<I", p, rva_off(a_fn) + 4 * i)[0]
        if fn_rva and not (exp_rva <= fn_rva < exp_rva + exp_size) and base + fn_rva in insns:
            starts.add(base + fn_rva)
    for i in range(n_nm):
        nm_rva = struct.unpack_from("<I", p, rva_off(a_nm) + 4 * i)[0]
        ordi = struct.unpack_from("<H", p, rva_off(a_ord) + 2 * i)[0]
        fn_rva = struct.unpack_from("<I", p, rva_off(a_fn) + 4 * ordi)[0]
        sname = p[rva_off(nm_rva):].split(b"\0", 1)[0].decode("ascii", "replace")
        names[base + fn_rva].append(sname)
for va, (_, kd, tgt) in insns.items():
    if kd == "c" and tgt in insns:
        starts.add(tgt)


# ---- MSVC RTTI (x86: absolute pointers, COL signature 0) ----
def demangle(s):  # ".?AVInner@Outer@@" -> "Outer::Inner"
    return "::".join(reversed(s[4:-2].split("@")))


tds = {}  # TypeDescriptor va -> class name
for m in TD_RE.finditer(p):
    nva = file_va(m.start())
    if nva is not None:
        tds[nva - 8] = demangle(m.group()[:-1].decode("ascii"))
cols = {}  # CompleteObjectLocator va -> class name
for td, cls in tds.items():
    pat = struct.pack("<I", td)
    i = p.find(pat)
    while i != -1:
        col_off = i - 12
        col_va = file_va(col_off) if col_off >= 0 else None
        if col_va is not None and struct.unpack_from("<I", p, col_off)[0] == 0 \
                and struct.unpack_from("<I", p, col_off + 4)[0] < 0x1000:
            cols[col_va] = cls
        i = p.find(pat, i + 1)
vtables = []  # (class, vtable va, slots)
for col_va, cls in cols.items():
    pat = struct.pack("<I", col_va)
    j = p.find(pat)
    while j != -1:
        jva = file_va(j)
        if jva is not None:
            vt, slots = jva + 4, []
            while len(slots) < 2048:
                v = u32(vt + 4 * len(slots))
                if v is None or v not in insns:
                    break
                slots.append(v)
            if slots:
                vtables.append((cls, vt, slots))
        j = p.find(pat, j + 1)
for cls, _, slots in vtables:
    for k, s in enumerate(slots):
        names[s].append(f"{cls}::vf{k}")
        starts.add(s)
rtti_classes = {c for c, _, _ in vtables}


# ---- recursive descent: extent per start, E8 targets found on the way ----
def walk(seed):
    end, calls, seen, work = seed, set(), set(), [seed]
    while work:
        a = work.pop()
        while a in insns and a not in seen:
            seen.add(a)
            sz, kd, tgt = insns[a]
            end = max(end, a + sz)
            if kd == "r":
                break
            if kd == "c" and tgt in insns:
                calls.add(tgt)
            if kd in ("j", "k") and tgt is not None and text_lo <= tgt < text_hi:
                work.append(tgt)
            if kd == "j":
                break
            a += sz
    return end, calls


starts = {s for s in starts if s in insns}
done, pending = {}, list(starts)
while pending:
    s = pending.pop()
    if s in done:
        continue
    done[s], calls = walk(s)
    for c in calls:
        if c not in starts:
            starts.add(c)
            pending.append(c)

S = sorted(starts)
Sset = set(S)
size = {}
for k, s in enumerate(S):
    nxt = S[k + 1] if k + 1 < len(S) else text_hi
    size[s] = max(1, min(done[s], nxt) - s)

# ---- names ----
funcs = []  # dicts: va, size, name, primary, cls, status, refs
for s in S:
    nm = sorted(set(names.get(s, [])))
    if nm:
        name = nm[0] + (f" [shared x{len(nm)}]" if len(nm) > 1 else "")
    else:
        name = f"sub_{s:08x}"
    prim = nm[0] if nm else ""
    if "::vf" in prim:
        cls = prim.rsplit("::vf", 1)[0]
    elif prim:
        cls = "(export)"
    else:
        cls = "(sub_)"
    funcs.append({"va": s, "size": size[s], "name": name, "cls": cls})


# ---- status: scan web-poc/src + docs for hex VAs inside .text ----
def comment_of(line, fn):
    if fn.endswith(".md"):
        return line
    cands = [k for k in (line.find("//"), line.find("/*")) if k >= 0]
    if cands:
        return line[min(cands):]
    return line if line.lstrip().startswith("*") else ""


cites = collections.defaultdict(dict)  # function va -> {"file:line": inferido?}
rejected = []  # (va, ref, reason, text)
for d in SCAN_DIRS:
    for dp, _, fns in os.walk(d):
        for fn in fns:
            if not fn.endswith(SCAN_EXT):
                continue
            path = os.path.join(dp, fn)
            rel = os.path.relpath(path, ROOT).replace("\\", "/")
            with open(path, encoding="utf-8", errors="replace") as fh:
                for ln, line in enumerate(fh, 1):
                    for m in CITE_RE.finditer(line):
                        va = int(m.group(1), 16)
                        if not (text_lo <= va < text_hi):
                            continue
                        ref = f"{rel}:{ln}"
                        inf = "[INFERIDO]" in line
                        tagged = "cross" in comment_of(line, fn).lower()
                        if va in Sset:
                            cites[va][ref] = inf
                            continue
                        k = bisect.bisect_right(S, va) - 1
                        if tagged and k >= 0 and va < S[k] + size[S[k]]:
                            cites[S[k]][ref] = inf
                        else:
                            reason = "cross tag outside a function body" if tagged else "2017 VA: not a Cross start, no cross tag"
                            rejected.append((va, ref, reason, line.strip()[:120]))

by_va = {f["va"]: f for f in funcs}
for f in funcs:
    c = cites.get(f["va"], {})
    if not c:
        f["status"] = "untouched"
    elif all(c.values()):
        f["status"] = "inferido"
    else:
        f["status"] = "ported"
    refs = sorted(c, key=lambda r: (r.rsplit(":", 1)[0], int(r.rsplit(":", 1)[1])))
    f["refs"] = ";".join(refs[:3])

# ---- output ----
os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "cross_symbols.tsv"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("va\tsize\tname\tstatus\trefs\n")
    for f in funcs:
        fh.write(f"0x{f['va']:08x}\t{f['size']}\t{f['name']}\t{f['status']}\t{f['refs']}\n")
with open(os.path.join(OUT_DIR, "cross_rejected.tsv"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("va\tref\treason\ttext\n")
    for va, ref, reason, text in rejected:
        fh.write(f"0x{va:08x}\t{ref}\t{reason}\t{text}\n")

N = len(funcs)
TB = sum(f["size"] for f in funcs)
cov = [f for f in funcs if f["status"] in ("ported", "inferido")]
CB = sum(f["size"] for f in cov)
shared = sum(1 for f in funcs if " [shared" in f["name"])
print(f"exe {EXE}")
print(f"image base 0x{base:08x}  .text 0x{text_lo:08x}-0x{text_hi:08x}  entry 0x{base + entry_rva:08x}")
print(f"functions {N}  bytes {TB}")
print(f"RTTI: TypeDescriptors {len(tds)}  COLs {len(cols)}  vtables {len(vtables)}  classes {len(rtti_classes)}  shared functions {shared}")
print(f"covered (ported+inferido): functions {len(cov)}/{N} = {100 * len(cov) / N:.2f}%  bytes {CB}/{TB} = {100 * CB / TB:.2f}%")
print(f"inferido only: {sum(1 for f in funcs if f['status'] == 'inferido')}")
print(f"rejected VAs: {len({r[0] for r in rejected})} unique, {len(rejected)} citations (see cross_rejected.tsv)")
print("top 20 classes by size:")
print(f"  {'class':<40} {'funcs':>6} {'bytes':>9} {'cov funcs':>10} {'cov bytes':>10}")
per = collections.defaultdict(lambda: [0, 0, 0, 0])  # funcs, bytes, cov funcs, cov bytes
for f in funcs:
    if f["cls"] in ("(sub_)",):
        continue
    v = per[f["cls"]]
    v[0] += 1
    v[1] += f["size"]
    if f["status"] in ("ported", "inferido"):
        v[2] += 1
        v[3] += f["size"]
for cls, (nf, nb, cf, cb) in sorted(per.items(), key=lambda kv: -kv[1][1])[:20]:
    print(f"  {cls:<40} {nf:>6} {nb:>9} {100 * cf / nf:>9.1f}% {100 * cb / nb:>9.1f}%")
un = [f for f in funcs if f["cls"] == "(sub_)"]
print(f"unnamed sub_ functions: {len(un)}  bytes {sum(f['size'] for f in un)}")
# ---- treemap page: template only, __DATA__ is replaced by the JSON below (no CDN, no deps) ----
HTML_TMPL = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Point Blank Cross RE coverage</title>
<style>
:root{--bg:#f5f6f8;--fg:#1b1f24;--muted:#5b6470;--card:#ffffff;--line:#d6dbe1}
@media (prefers-color-scheme: dark){:root{--bg:#0f1115;--fg:#e4e7ec;--muted:#98a1ab;--card:#171b21;--line:#2b3139}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1280px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}
.sub{color:var(--muted);margin:0 0 12px;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
.stat b{display:block;font-size:20px;overflow-wrap:anywhere}
.stat span{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:8px 0;font-size:13px}
.sw{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin-right:6px;border:1px solid var(--line)}
.note{color:var(--muted);font-size:12px;margin:6px 0}
#map{width:100%;overflow:hidden;border-radius:6px}
#map svg{display:block}
rect.u{stroke:var(--bg);stroke-width:1}
rect.u:hover{stroke:var(--fg);stroke-width:2}
text.lbl{font:11px system-ui,sans-serif;fill:var(--fg);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round;pointer-events:none}
text.lbl2{font:10px system-ui,sans-serif;fill:var(--fg);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round;pointer-events:none}
#tip{position:fixed;display:none;z-index:9;max-width:min(460px,calc(100vw - 16px));background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none}
#tip.on{display:block}
#tip .title{font-size:13px;font-weight:600}
#tip .dim{color:var(--muted)}
#tip .sec{margin-top:6px;font-weight:600}
#tip .ref{color:var(--muted);word-break:break-all;padding-left:12px}
</style>
</head>
<body>
<main>
<h1>Point Blank Cross exe: RE coverage</h1>
<p class="sub">Function map of PointBlank.exe (Cross). Coverage = VAs cited by the web port (docs/RE_COVERAGE.md). Not a matching decompilation.</p>
<div class="stats" id="stats"></div>
<div class="legend" id="legend"></div>
<p class="note">Tile area = unit bytes. Unit = RTTI class; unnamed code grouped by 64 KB block; exports as one unit. Hover (or tap) a tile for its cited functions.</p>
<div id="map"></div>
</main>
<div id="tip"></div>
<script>
const D = __DATA__;
const T = D.totals;
const UNITS = D.units.map(u => ({ name: u[0], kind: u[1], nf: u[2], nb: u[3], pb: u[4], ib: u[5], ncf: u[6], cited: [] }));
for (const c of D.covered) UNITS[c[0]].cited.push({ va: c[1], size: c[2], status: c[3], name: c[4], refs: c[5] });
for (const u of UNITS) u.cited.sort((a, b) => b.size - a.size);

const PAL = {
  light: { grey: [221, 225, 231], green: [46, 158, 79], yellow: [232, 196, 60] },
  dark: { grey: [52, 58, 66], green: [63, 185, 96], yellow: [214, 176, 52] },
};
const KIND = { class: 'RTTI class', sub: 'unnamed code (no RTTI, not exported)', export: 'exported functions' };
const NS = 'http://www.w3.org/2000/svg';
const mq = matchMedia('(prefers-color-scheme: dark)');
const mapEl = document.getElementById('map');
const tip = document.getElementById('tip');
const fmt = n => n.toLocaleString('en-US');
const pct = (x, d = 2) => (100 * x).toFixed(d) + '%';
const hex = va => '0x' + va.toString(16).padStart(8, '0');
const covOf = u => (u.pb + u.ib) / u.nb;
const rgb = c => 'rgb(' + c.map(Math.round).join(',') + ')';

// fill = stacked byte share: green = ported, yellow = inferido, rest grey
function fillOf(u, P) {
  const p = u.pb / u.nb, i = u.ib / u.nb, g = Math.max(0, 1 - p - i);
  return rgb([0, 1, 2].map(k => P.grey[k] * g + P.green[k] * p + P.yellow[k] * i));
}

// squarify (Bruls, Huijbregts, van Wijk): vals sorted desc, returns [x, y, w, h] per val
function worst(row, s) {
  const sum = row.reduce((a, b) => a + b, 0);
  return Math.max((s * s * Math.max(...row)) / (sum * sum), (sum * sum) / (s * s * Math.min(...row)));
}
function squarify(vals, x, y, w, h) {
  const tot = vals.reduce((a, b) => a + b, 0);
  const k = (w * h) / tot;
  const area = vals.map(v => v * k);
  const out = [];
  let i = 0;
  while (i < area.length) {
    const s = Math.min(w, h);
    const row = [area[i++]];
    while (i < area.length && worst(row.concat(area[i]), s) <= worst(row, s)) row.push(area[i++]);
    const sum = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const cw = sum / h;
      let yy = y;
      for (const a of row) { const ch = a / cw; out.push([x, yy, cw, ch]); yy += ch; }
      x += cw; w -= cw;
    } else {
      const rh = sum / w;
      let xx = x;
      for (const a of row) { const rw = a / rh; out.push([xx, y, rw, rh]); xx += rw; }
      y += rh; h -= rh;
    }
  }
  return out;
}

function stats() {
  const el = document.getElementById('stats');
  const cards = [
    [pct(T.coveredFunctions / T.functions), 'functions covered', `${fmt(T.coveredFunctions)} of ${fmt(T.functions)}`],
    [pct(T.coveredBytes / T.bytes), 'bytes covered', `${fmt(T.coveredBytes)} of ${fmt(T.bytes)}; inferido ${pct(T.inferidoBytes / T.bytes)}`],
    [fmt(T.rejectedVAs), 'rejected VAs (unique)', `${fmt(T.rejectedCitations)} citations; ${fmt(T.classes)} RTTI classes`],
    [D.generated, 'generated', D.exe],
  ];
  el.replaceChildren();
  for (const [big, label, small] of cards) {
    const d = document.createElement('div');
    d.className = 'stat';
    const b = document.createElement('b'); b.textContent = big;
    const l = document.createElement('span'); l.textContent = label;
    const s = document.createElement('span'); s.textContent = small;
    d.append(b, l, s);
    el.append(d);
  }
}

function legend(P) {
  const el = document.getElementById('legend');
  el.replaceChildren();
  const items = [
    ['untouched', P.grey],
    ['ported (cited, not tagged [INFERIDO])', P.green],
    ['inferido (every citation tagged [INFERIDO])', P.yellow],
  ];
  for (const [txt, c] of items) {
    const s = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.background = rgb(c);
    s.append(sw, txt);
    el.append(s);
  }
}

function place(e) {
  const pad = 14;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + tw > innerWidth - 8) x = e.clientX - tw - pad;
  if (y + th > innerHeight - 8) y = e.clientY - th - pad;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

function show(u, e) {
  tip.replaceChildren();
  const line = (text, cls) => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = text;
    tip.append(d);
  };
  line(u.name, 'title');
  line(KIND[u.kind], 'dim');
  line(`${fmt(u.nf)} functions, ${fmt(u.nb)} bytes`);
  line(`covered ${pct(covOf(u), 1)} (ported ${pct(u.pb / u.nb, 1)}, inferido ${pct(u.ib / u.nb, 1)})`);
  if (!u.cited.length) {
    line('no cited functions', 'dim');
  } else {
    line(`cited functions (${fmt(u.ncf)} covered):`, 'sec');
    for (const c of u.cited.slice(0, 5)) {
      line(`${hex(c.va)} ${c.name}, ${fmt(c.size)} B, ${c.status}`);
      for (const r of c.refs.split(';')) line(r, 'ref');
    }
    if (u.cited.length > 5) line(`+ ${fmt(u.cited.length - 5)} more`, 'dim');
  }
  tip.classList.add('on');
  place(e);
}

function render() {
  const P = mq.matches ? PAL.dark : PAL.light;
  tip.classList.remove('on');
  legend(P);
  const W = Math.floor(mapEl.clientWidth);
  const H = Math.round(Math.min(900, Math.max(360, W * 0.6)));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Treemap of RE coverage per unit');
  const boxes = squarify(UNITS.map(u => u.nb), 0, 0, W, H);
  UNITS.forEach((u, i) => {
    const [x, y, w, h] = boxes[i];
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('class', 'u');
    r.setAttribute('x', x); r.setAttribute('y', y);
    r.setAttribute('width', w); r.setAttribute('height', h);
    r.setAttribute('fill', fillOf(u, P));
    r.addEventListener('pointerenter', e => show(u, e));
    r.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') place(e); });
    r.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') tip.classList.remove('on'); });
    r.addEventListener('pointerdown', e => show(u, e));
    svg.append(r);
    const maxc = Math.floor((w - 8) / 6.4);
    if (w >= 56 && h >= 16 && maxc >= 4) {
      const name = u.name.length > maxc ? u.name.slice(0, maxc - 1) + '…' : u.name;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'lbl');
      t.setAttribute('x', x + 4); t.setAttribute('y', y + 13);
      t.textContent = name;
      svg.append(t);
      if (w >= 80 && h >= 32) {
        const t2 = document.createElementNS(NS, 'text');
        t2.setAttribute('class', 'lbl2');
        t2.setAttribute('x', x + 4); t2.setAttribute('y', y + 26);
        t2.textContent = `${(100 * covOf(u)).toFixed(1)}% covered`;
        svg.append(t2);
      }
    }
  });
  mapEl.replaceChildren(svg);
}

document.addEventListener('pointerdown', e => {
  if (!(e.target instanceof SVGRectElement)) tip.classList.remove('on');
});
let rt = 0;
addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });
mq.addEventListener('change', render);
stats();
render();
</script>
</body>
</html>
'''

# ---- treemap: one tile per unit (RTTI class / 64 KB block of unnamed code / exports), data inline ----
ustat = {}
keys = []  # unit key per function, same order as funcs
for f in funcs:
    if f["cls"] == "(sub_)":
        key = ("sub", f["va"] & 0xFFFF0000)
        uname, kind = f"sub_ 0x{key[1]:08x}", "sub"
    elif f["cls"] == "(export)":
        key, uname, kind = ("export",), "(exports)", "export"
    else:
        key, uname, kind = ("class", f["cls"]), f["cls"], "class"
    u = ustat.setdefault(key, {"name": uname, "kind": kind, "nf": 0, "nb": 0, "pb": 0, "ib": 0, "ncf": 0})
    u["nf"] += 1
    u["nb"] += f["size"]
    if f["status"] == "ported":
        u["pb"] += f["size"]
    elif f["status"] == "inferido":
        u["ib"] += f["size"]
    if f["status"] != "untouched":
        u["ncf"] += 1
    keys.append(key)
order = sorted(ustat, key=lambda k: (-ustat[k]["nb"], ustat[k]["name"]))
uidx = {k: i for i, k in enumerate(order)}
units_js = [[ustat[k]["name"], ustat[k]["kind"], ustat[k]["nf"], ustat[k]["nb"],
             ustat[k]["pb"], ustat[k]["ib"], ustat[k]["ncf"]] for k in order]
covered_js = [[uidx[k], f["va"], f["size"], f["status"], f["name"], f["refs"]]
              for f, k in zip(funcs, keys) if f["status"] != "untouched"]
IB = sum(f["size"] for f in funcs if f["status"] == "inferido")
totals = {"functions": N, "bytes": TB, "coveredFunctions": len(cov), "coveredBytes": CB,
          "portedBytes": CB - IB, "inferidoBytes": IB,
          "inferidoFunctions": sum(1 for f in funcs if f["status"] == "inferido"),
          "classes": len(rtti_classes), "rttiTypeDescriptors": len(tds),
          "rejectedVAs": len({r[0] for r in rejected}), "rejectedCitations": len(rejected)}
data = {"exe": os.path.basename(EXE), "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "totals": totals, "units": units_js, "covered": covered_js}
# units: [name, kind, funcs, bytes, portedBytes, inferidoBytes, coveredFuncs]; covered: [unitIdx, va, size, status, name, refs]
html = HTML_TMPL.replace("__DATA__", json.dumps(data, separators=(",", ":")).replace("</", "<\\/"))
html_path = os.path.join(OUT_DIR, "coverage.html")
with open(html_path, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(html)

print(f"wrote {os.path.join(OUT_DIR, 'cross_symbols.tsv')}")
print(f"wrote {html_path} ({os.path.getsize(html_path)} bytes)")

# ---- static SVG treemap: GitHub does not run the HTML JS, so README <img> gets this file ----
# same units, order and stacked green/yellow/grey fill as the HTML; fixed hex colours, no CSS media queries
SVG_GREY, SVG_GREEN, SVG_YELLOW = (221, 225, 231), (46, 158, 79), (232, 196, 60)
SVG_BG, SVG_INK, SVG_MUTED, SVG_LINE = "#f6f8fa", "#1f2328", "#57606a", "#d0d7de"
MAP_X, MAP_Y, MAP_W, MAP_H = 8, 80, 1184, 512


def svg_hex(c):
    return "#" + "".join(f"{round(v):02x}" for v in c)


def svg_fill(u):
    p, i = u["pb"] / u["nb"], u["ib"] / u["nb"]
    g = max(0.0, 1 - p - i)
    return svg_hex(SVG_GREY[k] * g + SVG_GREEN[k] * p + SVG_YELLOW[k] * i for k in range(3))


def squarify(vals, x, y, w, h):
    # Bruls, Huijbregts, van Wijk: same algorithm as squarify() in the HTML page; vals sorted desc
    def worst(row, s):
        tot = sum(row)
        return max((s * s * max(row)) / (tot * tot), (tot * tot) / (s * s * min(row)))

    k = (w * h) / sum(vals)
    area = [v * k for v in vals]
    out = []
    i = 0
    while i < len(area):
        s = min(w, h)
        row = [area[i]]
        i += 1
        while i < len(area) and worst(row + [area[i]], s) <= worst(row, s):
            row.append(area[i])
            i += 1
        sm = sum(row)
        if w >= h:
            cw = sm / h
            yy = y
            for a in row:
                ch = a / cw
                out.append((x, yy, cw, ch))
                yy += ch
            x += cw
            w -= cw
        else:
            rh = sm / w
            xx = x
            for a in row:
                rw = a / rh
                out.append((xx, y, rw, rh))
                xx += rw
            y += rh
            h -= rh
    return out


pb_pct = 100 * CB / TB
fn_pct = 100 * len(cov) / N
title = f"Cross exe RE coverage — {pb_pct:.2f}% bytes, {fn_pct:.2f}% functions ({len(cov)}/{N})"
body, labels = [], []
for key, (x, y, w, h) in zip(order, squarify([ustat[k]["nb"] for k in order], MAP_X, MAP_Y, MAP_W, MAP_H)):
    u = ustat[key]
    cov_u = (u["pb"] + u["ib"]) / u["nb"]
    tip = f"{u['name']}: {100 * cov_u:.1f}% covered, {u['nf']} functions, {u['nb']} bytes"
    body.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{svg_fill(u)}">'
                f"<title>{escape(tip)}</title></rect>")
    maxc = int((w - 8) / 6.4)
    if w >= 56 and h >= 16 and maxc >= 4:
        name = u["name"] if len(u["name"]) <= maxc else u["name"][: maxc - 1] + "..."
        labels.append(f'<text x="{x + 4:.1f}" y="{y + 13:.1f}">{escape(name)}</text>')
        if w >= 80 and h >= 32:
            labels.append(f'<text x="{x + 4:.1f}" y="{y + 26:.1f}">{100 * cov_u:.1f}%</text>')

legend, lx = [], 700
for txt, c in (("untouched", SVG_GREY), ("ported", SVG_GREEN), ("inferido", SVG_YELLOW)):
    legend.append(f'<rect x="{lx}" y="40" width="10" height="10" rx="2" fill="{svg_hex(c)}"/>'
                  f'<text x="{lx + 14}" y="49">{txt}</text>')
    lx += 14 + 6.4 * len(txt) + 18

svg_doc = "\n".join([
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">',
    f"<title>{escape(title)}</title>",
    '<g font-family="system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif">',
    f'<rect width="1200" height="600" rx="6" fill="{SVG_BG}" stroke="{SVG_LINE}"/>',
    f'<text x="16" y="30" font-size="17" font-weight="600" fill="{SVG_INK}">{escape(title)}</text>',
    f'<text x="16" y="50" font-size="11" fill="{SVG_MUTED}">tile area = unit bytes · generated {data["generated"]} · {escape(data["exe"])}</text>',
    f'<g font-size="11" fill="{SVG_INK}">', *legend, "</g>",
    f'<line x1="0" y1="72" x2="1200" y2="72" stroke="{SVG_LINE}"/>',
    f'<g stroke="{SVG_BG}" stroke-width="1">', *body, "</g>",
    f'<g font-size="11" fill="{SVG_INK}">', *labels, "</g>",
    "</g>",
    "</svg>",
    "",
])
svg_path = os.path.join(ROOT, "web-poc", "docs", "re-coverage.svg")
with open(svg_path, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(svg_doc)
print(f"wrote {svg_path} ({os.path.getsize(svg_path)} bytes)")
