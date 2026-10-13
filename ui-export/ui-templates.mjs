#!/usr/bin/env node
// Templates (skins of controls) -> out/ui/templates/<ver>.json
//
//   node ui-export/ui-templates.mjs [v12 v11 kaybo]
//
// Source: V12/V11 `.i3UITemplate` XML inside UI_V1x_VTexList_Template.i3Pack (names from the PFN index,
// KeyObject Name wins over truncated file names), Kaybo `.i3Uil` libraries (i3UILTreeNode_Template names).
// Output record per template (format "pb-ui-templates/1", see out/ui/README.md):
//   { cls, name, shapes:[{img, x,y,w,h, u,v,uw,vh, path}], sub:[template...], src }
// Everything is copied from the original XML; nothing is inferred here.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS, OUT, loadTemplates, md5Upper, writeJSON } from './lib.mjs';

export function exportTemplates(ver) {
  const T = loadTemplates(ver);
  const templates = {};
  for (const [name, t] of [...T].sort((a, b) => a[0].localeCompare(b[0]))) templates[name] = { ...t, hash: md5Upper(name) };
  const file = path.join(OUT, 'templates', `${ver}.json`);
  writeJSON(file, { format: 'pb-ui-templates/1', version: ver, source: VERSIONS[ver].label, count: T.size, templates });
  return { ver, count: T.size, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const vers = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VERSIONS);
  for (const v of vers) { const r = exportTemplates(v); console.log(`${v}: ${r.count} templates -> ${path.relative(process.cwd(), r.file)}`); }
}
