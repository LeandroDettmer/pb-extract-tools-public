#!/usr/bin/env python3
"""Parse the client Shop.dat (PointBlank 3.123 BR) = the server catalog in wire format, uncompressed.
Layout (checked: 52 + 1171*210 + 4933*11 + 30*16 + 1171*16 + 8*11 == 319529):
  header 52 bytes: 5 x u32 (magic, nGoods, nItems, nRepairs, nMatching), u32 nTags(8), 8 x u32
  goods    nGoods    x 210  D goodId, C 1, C visibility, 12 x {D gold, D cash, D 0, D period, C code}   (ShopManager.WriteGoodsRecord210)
  items    nItems    x 11   D itemId, C authType, C buyType2, C buyType3, C title, C titleFlag
  repairs  nRepairs  x 16   D itemId, D point/qty, D cash/qty, D qty
  matching nMatching x 16   D goodId, D itemId, D count, D 0
Usage: parse_shopdat.py [Shop.dat] > out.json
"""
import os, struct, sys, json
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ["PB_CLIENT_BR3123"], "Shop.dat")
d = open(path, "rb").read()
magic, ng, ni, nr, nm, ntag = struct.unpack_from("<6I", d, 0)
# header is 5 dwords; the 6th read above is the first tag word, only used for the size check
o = 52  # 20 byte header + 32 bytes (8 x u32) before the first goods record
goods = []
for i in range(ng):
    r = d[o + i * 210:o + (i + 1) * 210]
    gid = struct.unpack_from("<I", r, 0)[0]
    opts = []
    for k in range(12):
        b = 6 + k * 17
        gold, cash, d2, period, code = struct.unpack_from("<IIIIB", r, b)
        if gold or cash or period or code:
            opts.append({"k": k, "gold": gold, "cash": cash, "period": period, "code": code})
    goods.append({"goodId": gid, "vis": r[5], "opts": opts})
o += ng * 210
items = []
for i in range(ni):
    r = d[o + i * 11:o + (i + 1) * 11]
    items.append(dict(zip(("itemId", "auth", "b2", "b3", "title", "titleFlag"), struct.unpack("<IBBBBB2x", r))))
o += ni * 11
repairs = []
for i in range(nr):
    repairs.append(dict(zip(("itemId", "point", "cash", "qty"), struct.unpack_from("<IiiI", d, o + i * 16))))
o += nr * 16
matching = []
for i in range(nm):
    g, it, c, _ = struct.unpack_from("<IIII", d, o + i * 16)
    matching.append({"goodId": g, "itemId": it, "count": c})
o += nm * 16
print(json.dumps({"header": [magic, ng, ni, nr, nm], "tail": len(d) - o, "goods": goods, "items": items, "repairs": repairs, "matching": matching}))
