# RE coverage map for the Point Blank Cross exe: doldecomp-style progress, not a matching decompilation.
#   py <tools>/re/coverage.py [exe] [game root]    (default root = cwd: run from the game repo root; needs capstone)
#   writes web-poc/docs/re/cross_symbols.tsv + cross_rejected.tsv and prints the summary
#   status: ported (cited) / inferido (every citation [INFERIDO]) / untouched.
#   A VA counts only if it is an exact Cross function start or its comment contains `cross`; others are rejected.
import bisect
import collections
import os
import re
import struct
import sys

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
print(f"wrote {os.path.join(OUT_DIR, 'cross_symbols.tsv')}")
