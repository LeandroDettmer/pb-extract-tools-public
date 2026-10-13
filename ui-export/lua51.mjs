// Lua 5.1 bytecode ("\x1bLuaQ") reader + light symbolic decompiler. Pure Node, builtins only.
//
// Used by ui-lua.mjs on the Kaybo 2017 scene scripts (UI_Re2_Script.i3Pack: UIRe/Script/*.luab). Header
// seen there: 1b4c7561 51 00 01 04 04 04 04 00 = format 0, little endian, int/size_t/Instruction 4 bytes,
// lua_Number 4-byte float (i3Engine builds Lua with LUA_NUMBER=float); 8-byte double is accepted too. Debug info (line numbers, local names) is stripped.
//
// decompile() is NOT a full decompiler: it runs one linear pass per function, keeping the last expression
// written to each register (control flow ignored, JMP targets don't reset state), and emits one statement per
// CALL / SETTABLE / SETGLOBAL / RETURN. That is enough to read call sites like
//   self:SetText("btn01", GAME_STRING_U8("STR_TBL_GUI_LOBBY_REFRESH_TEXT"))
// with their arguments, which is what the binding extractor needs.

// Opcode order = luaP_opnames in the client's lua.dll (@0xa83ec): stock 5.1 plus six bitwise ops after POW,
// so every opcode from UNM on is shifted by 6 (CALL = 34, CLOSURE = 42).
export const OPS = ['MOVE', 'LOADK', 'LOADBOOL', 'LOADNIL', 'GETUPVAL', 'GETGLOBAL', 'GETTABLE', 'SETGLOBAL',
  'SETUPVAL', 'SETTABLE', 'NEWTABLE', 'SELF', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'POW',
  'BITOR', 'BITAND', 'BITXOR', 'BITLSHIFT', 'BITRSHIFT', 'BITNOT', 'UNM', 'NOT', 'LEN',
  'CONCAT', 'JMP', 'EQ', 'LT', 'LE', 'TEST', 'TESTSET', 'CALL', 'TAILCALL', 'RETURN', 'FORLOOP', 'FORPREP',
  'TFORLOOP', 'SETLIST', 'CLOSE', 'CLOSURE', 'VARARG'];

export function parseChunk(buf) {
  if (buf.toString('latin1', 0, 4) !== '\x1bLua' || buf[4] !== 0x51) throw new Error('not a Lua 5.1 chunk');
  const [fmt, le, szInt, szSize, szIns, szNum, integral] = buf.subarray(5, 12);
  if (fmt !== 0 || le !== 1 || szInt !== 4 || szSize !== 4 || szIns !== 4 || (szNum !== 4 && szNum !== 8) || integral !== 0)
    throw new Error(`unsupported Lua 5.1 header ${buf.subarray(4, 12).toString('hex')}`);
  let p = 12;
  const u8 = () => buf[p++];
  const i32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  const str = () => { const n = buf.readUInt32LE(p); p += 4; if (!n) return null; const s = buf.toString('latin1', p, p + n - 1); p += n; return s; };
  const fn = () => {
    const f = { source: str(), line: i32(), lastLine: i32(), nups: u8(), nparams: u8(), vararg: u8(), maxstack: u8() };
    f.code = Array.from({ length: i32() }, () => { const v = buf.readUInt32LE(p); p += 4; return v; });
    f.k = Array.from({ length: i32() }, () => {
      const t = u8();
      if (t === 0) return null;
      if (t === 1) return !!u8();
      if (t === 3) { const v = szNum === 4 ? buf.readFloatLE(p) : buf.readDoubleLE(p); p += szNum; return v; }
      if (t === 4) return { s: str() };
      throw new Error(`bad constant type ${t} @${p - 1}`);
    });
    f.protos = Array.from({ length: i32() }, fn);
    f.lines = Array.from({ length: i32() }, i32);
    f.locals = Array.from({ length: i32() }, () => ({ name: str(), start: i32(), end: i32() }));
    f.upvals = Array.from({ length: i32() }, str);
    return f;
  };
  return fn();
}

export const decodeIns = i => ({ op: i & 0x3f, A: (i >>> 6) & 0xff, C: (i >>> 14) & 0x1ff, B: (i >>> 23) & 0x1ff, Bx: i >>> 14, sBx: (i >>> 14) - 131071 });

const quote = s => JSON.stringify(s);
const kExpr = k => (k === null ? 'nil' : typeof k === 'object' ? quote(k.s) : String(k));
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const index = (obj, key, k) => (k && typeof k === 'object' && IDENT.test(k.s) ? `${obj}.${k.s}` : `${obj}[${key}]`);

// One linear pass -> [{pc, line, kind: 'call'|'set'|'global'|'return', text, fn?, args?}] plus nested protos.
export function decompile(f, name = 'main') {
  const R = [];
  const localAt = (r, pc) => {
    let n = -1;
    for (const l of f.locals) if (l.start <= pc && pc < l.end) { n++; if (n === r) return l.name; }
    return null;
  };
  // Known value first (inlines `local s = GAME_STRING(..)`), else the local's name (params: self, ...).
  // Locals are allocated in order, so the r-th active local lives in register r.
  const reg = (r, pc) => R[r] ?? localAt(r, pc) ?? `r${r}`;
  const rk = (x, pc) => (x & 0x100 ? kExpr(f.k[x & 0xff]) : reg(x, pc));
  const out = [];
  let top = 0;
  f.code.forEach((ins, pc) => {
    const { op, A, B, C, Bx, sBx } = decodeIns(ins);
    const line = f.lines[pc];
    const set = (r, e) => { R[r] = e; };
    switch (OPS[op]) {
      case 'MOVE': set(A, reg(B, pc)); break;
      case 'LOADK': set(A, kExpr(f.k[Bx])); break;
      case 'LOADBOOL': set(A, B ? 'true' : 'false'); break;
      case 'LOADNIL': for (let r = A; r <= B; r++) set(r, 'nil'); break;
      case 'GETUPVAL': set(A, f.upvals[B] ?? `upval${B}`); break;
      case 'GETGLOBAL': set(A, f.k[Bx].s); break;
      case 'GETTABLE': set(A, index(reg(B, pc), rk(C, pc), C & 0x100 ? f.k[C & 0xff] : null)); break;
      case 'SETGLOBAL': out.push({ pc, line, kind: 'global', text: `${f.k[Bx].s} = ${reg(A, pc)}`, target: f.k[Bx].s, value: reg(A, pc) }); break;
      case 'SETUPVAL': out.push({ pc, line, kind: 'set', text: `${f.upvals[B]} = ${reg(A, pc)}` }); break;
      case 'SETTABLE': {
        const t = index(reg(A, pc), rk(B, pc), B & 0x100 ? f.k[B & 0xff] : null);
        out.push({ pc, line, kind: 'set', text: `${t} = ${rk(C, pc)}`, target: t, value: rk(C, pc) });
        break;
      }
      case 'NEWTABLE': set(A, '{}'); break;
      case 'SELF': { const o = reg(B, pc); const m = C & 0x100 ? f.k[C & 0xff].s : rk(C, pc); set(A + 1, o); set(A, `${o}:${m}`); break; }
      case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'MOD': case 'POW':
      case 'BITOR': case 'BITAND': case 'BITXOR': case 'BITLSHIFT': case 'BITRSHIFT': {
        const sym = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%', POW: '^', BITOR: '|', BITAND: '&', BITXOR: '~', BITLSHIFT: '<<', BITRSHIFT: '>>' }[OPS[op]];
        set(A, `(${rk(B, pc)} ${sym} ${rk(C, pc)})`); break;
      }
      case 'UNM': set(A, `-${reg(B, pc)}`); break;
      case 'BITNOT': set(A, `~${reg(B, pc)}`); break;
      case 'NOT': set(A, `not ${reg(B, pc)}`); break;
      case 'LEN': set(A, `#${reg(B, pc)}`); break;
      case 'CONCAT': { const parts = []; for (let r = B; r <= C; r++) parts.push(reg(r, pc)); set(A, parts.join(' .. ')); break; }
      case 'CALL': case 'TAILCALL': {
        const fnE = reg(A, pc);
        const isSelf = /:/.test(fnE.split('(')[0]);
        const last = B ? A + B - 1 : top;
        const args = [];
        for (let r = A + 1 + (isSelf ? 1 : 0); r <= last; r++) args.push(reg(r, pc));
        const text = `${fnE}(${args.join(', ')})`;
        out.push({ pc, line, kind: 'call', text, fn: fnE, args });
        if (C === 0) { top = A; R[A] = text; } else for (let r = A; r < A + C - 1; r++) R[r] = C === 2 ? text : `${text}[${r - A + 1}]`;
        break;
      }
      case 'RETURN': {
        const vals = []; const last = B ? A + B - 2 : top;
        for (let r = A; r <= last; r++) vals.push(reg(r, pc));
        out.push({ pc, line, kind: 'return', text: `return ${vals.join(', ')}` });
        break;
      }
      case 'VARARG': set(A, '...'); if (!B) top = A; break;
      case 'CLOSURE': {
        const sub = f.protos[Bx];
        set(A, `function<${sub.line}>`);
        break;
      }
      case 'SETLIST': case 'JMP': case 'EQ': case 'LT': case 'LE': case 'TEST': case 'TESTSET':
      case 'FORLOOP': case 'FORPREP': case 'TFORLOOP': case 'CLOSE': break;
    }
    if (OPS[op] === 'CALL' && C === 0) top = A;
  });
  return { name, line: f.line, params: f.nparams, stmts: out, protos: f.protos.map((p, i) => ({ proto: p, i })) };
}

// Walks the whole chunk; names nested functions by how the parent stores them (`Class.method = function<..>`).
export function decompileAll(chunk) {
  const fns = [];
  const walk = (f, name) => {
    const d = decompile(f, name);
    fns.push(d);
    const names = new Map();
    for (const s of d.stmts) {
      const m = /^function<(\d+)>$/.exec(s.value || '');
      if (m && s.target) names.set(Number(m[1]), s.target);
    }
    f.protos.forEach(p => walk(p, names.get(p.line) || `${name}/fn@${p.line}`));
  };
  walk(chunk, 'main');
  return fns;
}

// Calls whose value is consumed by one of the next statements (nested args) are folded away. Line info is
// stripped in these chunks, so statements are tagged with their pc.
export function listing(fns) {
  const nested = (st, i) => st[i].kind === 'call' && st.slice(i + 1, i + 16).some(n => n.text.includes(st[i].text));
  return fns.map(d => [`-- function ${d.name} (line ${d.line}, ${d.params} params)`,
    ...d.stmts.filter((s, i) => !nested(d.stmts, i)).map(s => `  [pc ${String(s.pc).padStart(4)}] ${s.text}`)].join('\n')).join('\n\n') + '\n';
}
