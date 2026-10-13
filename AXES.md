# Axis convention: i3Engine (Point Blank) → three.js

**TL;DR: apply the scene's own matrix chain, root matrix included. The result is already
three.js space (Y-up, right-handed, metres, CCW front faces). Don't mirror Z and don't flip the winding.**

## i3 matrices
- `i3MatrixObject` = 16 × f32, **row-major, row-vector** (D3D style): `v' = v · M`, translation in `m[12..14]`.
- Hierarchy: `i3Transform` / `i3Transform2` store `name, "INF2", u32 flags, u32 childCount, u32 0,
  u32 childId[childCount], u32 matrixId` (ids are 1-based object ids in the I3R2 object table).
- World of a node: `W = M_local · M_parent · … · M_root` (row vectors, so the local matrix is on the left).

## Root matrix (the axis conversion)
Every NStation scene has the same root `i3Transform` (unnamed) → `i3MatrixObject`:

```
[-1 0 0 0]
[ 0 0 1 0]      (x, y, z)_asset  →  (-x, z, y)_world
[ 0 1 0 0]      det = +1 (a proper rotation, no mirror)
[ 0 0 0 1]
```
Seen in `NStation_Col.i3Pack` (collision) and in `NStation.i3Pack`, both
`002_Scene_Root.i3s` and `003_Scene_Root.i3s` (visual). Below it, "Scene Root" is identity,
and each mesh node (`i3Transform2`) carries its own pivot translation in asset (Z-up) space.

## i3 world = three.js world
- Y-up, right-handed, **metres** (map bounds ≈ 52 × 8.3 × 115 m).
- Winding: with the right-hand cross product, floor triangles face +Y (up area 9404 m² vs down 3303 m²)
  → CCW front faces, the same as glTF/three.js. **Don't flip.**
- Verified independently: the 16 respawn points in `NStation_Scene.i3Pack` (GINS instance table,
  native i3 world coordinates) sit on the exported collision floor to within 1 cm
  (Respawn y=-0.755 vs floor -0.746, Respawn0 y=0.267 vs floor 0.269).
- So `I3_TO_THREE = identity` (`tools/export-collision.mjs`). If a loader skips the root node,
  apply `(x, y, z) → (-x, z, y)` to the asset-space data by hand. That is equivalent, and it's still no mirror.

## GINS placement data (respawns, props)
`<map>_Scene.i3Pack` → `GINS` file: `'GINS', u32 ver, u32 count, u32 layerCount`, `layerCount × 80 B`,
then 200-byte records: `+0x18 vec3 pos`, `+0x24 quat (x,y,z,w)`, `+0x34 vec3 scale`, `+0x6c name`.
Already in i3 world = three.js space. Yaw = rotation about +Y (quat `(0, sin θ/2, 0, cos θ/2)`).
