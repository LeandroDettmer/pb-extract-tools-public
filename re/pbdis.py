# x86 disassembly of a PointBlank.exe range by VA (the 2017 exe is not packed; image base 0x400000).
#   pbx re pbdis <va hex> <length hex> [exe]
#   pbx re pbdis 0x9d0910 0x2d0
#   pbx re pbdis 0x101391c0 0x40 "<path>/i3SceneDx.dll" 0x10000000   (DLL: 4th arg = image base)
# Default exe: the kaybo client (pbx init). Needs `pip install capstone`.
# The REA MCP tools open the exe but cannot disassemble x86 here (Ghidra provider is x64-only): use this instead.
# Do not name this file dis.py: it shadows the stdlib `dis` module that capstone imports.
import os
import struct
import sys

import capstone

exe = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.environ["PB_CLIENT_KAYBO"], "PointBlank.exe")
p = open(exe, "rb").read()
pe = struct.unpack_from("<I", p, 0x3C)[0]
n = struct.unpack_from("<H", p, pe + 6)[0]
opt = struct.unpack_from("<H", p, pe + 20)[0]
secs = [struct.unpack_from("<8sIIII", p, pe + 24 + opt + i * 40) for i in range(n)]


base = int(sys.argv[4], 16) if len(sys.argv) > 4 else 0x400000


def off(va):
    rva = va - base
    for _, vs, va2, rs, ro in secs:
        if va2 <= rva < va2 + max(vs, rs):
            return rva - va2 + ro
    raise SystemExit(f"VA {va:#x} is outside every section")


a, ln = int(sys.argv[1], 16), int(sys.argv[2], 16)
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
o = off(a)
for i in md.disasm(p[o : o + ln], a):
    print(hex(i.address), i.mnemonic, i.op_str)
