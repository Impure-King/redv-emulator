// A GNU-as-compatible assembler for RV32IMA + Zicsr, with a C-preprocessor subset for .S files.
// Produces a linked image laid out like the RED-V (FE310-G002) board: code in QSPI flash, data in DTIM.

import { REGS, CSR_NAMES, INSNS, AMO, encR, encI, encS, encB, encU, encJ, disasm } from './isa.js';

export const LAYOUT = {
  boot: 0x20000000,      // emulated boot ROM (stands in for the bootloader + SDK _enter)
  text: 0x20010000,      // user .text (the SDK links programs at 0x20010000)
  ram: 0x80000000,       // DTIM, 16 KiB
  ramSize: 0x4000,
  stackSize: 0x400,      // SDK default __stack_size
};

class AsmError extends Error {
  constructor(msg, hint) { super(msg); this.hint = hint; }
}

// ---------------------------------------------------------------- preprocessor
const PP_DIRECTIVES = new Set(['include', 'define', 'undef', 'if', 'ifdef', 'ifndef', 'elif', 'else',
  'endif', 'error', 'warning', 'pragma', 'line']);

function stripCComments(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"' || c === '\n') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const chunk = end < 0 ? text.slice(i) : text.slice(i, end + 2);
      out += ' ' + chunk.replace(/[^\n]/g, '');
      i += chunk.length; continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Strip a GNU-as '#' comment (outside strings and char literals).
function stripHash(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "'") { i += line[i + 1] === '\\' ? 2 : 1; if (line[i + 1] === "'") i++; }
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function findFile(files, name) {
  if (name in files) return name;
  const base = name.split(/[\\/]/).pop();
  if (base in files) return base;
  const lower = base.toLowerCase();
  return Object.keys(files).find((k) => k.toLowerCase() === lower) || null;
}

function evalCExpr(expr, macros) {
  // Replace defined(X) / defined X, expand macros, then evaluate as a C integer expression.
  let e = expr.replace(/\bdefined\s*\(\s*(\w+)\s*\)|\bdefined\s+(\w+)/g, (_, a, b) => (macros.has(a || b) ? ' 1 ' : ' 0 '));
  e = expandMacros(e, macros, 0);
  e = e.replace(/\b([A-Za-z_]\w*)\b/g, ' 0 ');
  e = e.replace(/\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]+\b/g, '$1');
  const toks = e.match(/0[xX][0-9a-fA-F]+|\d+|'(?:\\.|[^'])'|\|\||&&|==|!=|<=|>=|<<|>>|[-+*/%()<>!~^&|?:]/g) || [];
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const prim = () => {
    const t = next();
    if (t === '(') { const v = cond(); next(); return v; }
    if (t === '-') return -unary();
    if (t === '+') return unary();
    if (t === '!') return unary() ? 0 : 1;
    if (t === '~') return ~unary();
    if (t === undefined) return 0;
    if (t[0] === "'") return t.length === 3 ? t.charCodeAt(1) : 0;
    return t.startsWith('0x') || t.startsWith('0X') ? parseInt(t, 16) : t.length > 1 && t[0] === '0' ? parseInt(t, 8) : parseInt(t, 10);
  };
  const unary = prim;
  const levels = [['*', '/', '%'], ['+', '-'], ['<<', '>>'], ['<', '>', '<=', '>='], ['==', '!='], ['&'], ['^'], ['|'], ['&&'], ['||']];
  const bin = (lvl) => {
    if (lvl < 0) return unary();
    let v = bin(lvl - 1);
    while (levels[lvl].includes(peek())) {
      const op = next(), r = bin(lvl - 1);
      switch (op) {
        case '*': v = Math.imul(v, r); break; case '/': v = r ? Math.trunc(v / r) : 0; break; case '%': v = r ? v % r : 0; break;
        case '+': v = (v + r) | 0; break; case '-': v = (v - r) | 0; break;
        case '<<': v = v << r; break; case '>>': v = v >> r; break;
        case '<': v = +(v < r); break; case '>': v = +(v > r); break; case '<=': v = +(v <= r); break; case '>=': v = +(v >= r); break;
        case '==': v = +(v === r); break; case '!=': v = +(v !== r); break;
        case '&': v = v & r; break; case '^': v = v ^ r; break; case '|': v = v | r; break;
        case '&&': v = +(!!v && !!r); break; case '||': v = +(!!v || !!r); break;
      }
    }
    return v;
  };
  const cond = () => {
    const c = bin(levels.length - 1);
    if (peek() === '?') { next(); const a = cond(); next(); const b = cond(); return c ? a : b; }
    return c;
  };
  return cond();
}

function splitArgs(s) {
  const out = []; let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

function expandMacros(line, macros, depth, hide = new Set()) {
  if (depth > 32 || macros.size === 0) return line;
  let out = '', i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') { // copy string literal
      let j = i + 1; while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++; }
      out += line.slice(i, j + 1); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c) && (i === 0 || !/[\w.$]/.test(line[i - 1]))) {
      let j = i; while (j < line.length && /\w/.test(line[j])) j++;
      const name = line.slice(i, j);
      const m = macros.get(name);
      if (m && !hide.has(name)) {
        if (m.params) {
          let k = j; while (line[k] === ' ' || line[k] === '\t') k++;
          if (line[k] === '(') {
            let d = 0, e = k;
            for (; e < line.length; e++) { if (line[e] === '(') d++; else if (line[e] === ')') { d--; if (d === 0) break; } }
            const args = splitArgs(line.slice(k + 1, e));
            let body = m.body;
            m.params.forEach((p, idx) => { body = body.replace(new RegExp('\\b' + p + '\\b', 'g'), args[idx] ?? ''); });
            const h = new Set(hide); h.add(name);
            out += expandMacros(body, macros, depth + 1, h); i = e + 1; continue;
          }
        } else {
          const h = new Set(hide); h.add(name);
          out += expandMacros(m.body, macros, depth + 1, h); i = j; continue;
        }
      }
      out += name; i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

export function preprocess(files, mainName, diag) {
  const macros = new Map();
  const out = [];
  const visit = (name, stack) => {
    if (stack.length > 20) { diag.error(name, 1, '#include nested too deeply'); return; }
    const text = stripCComments(files[name].replace(/\r\n?/g, '\n'));
    const lines = text.split('\n');
    const cond = []; // {active, taken, parentActive}
    const active = () => cond.every((c) => c.active);
    for (let li = 0; li < lines.length; li++) {
      let line = lines[li];
      const lineNo = li + 1;
      // line continuation
      while (line.endsWith('\\') && li + 1 < lines.length) { line = line.slice(0, -1) + lines[++li]; out.push(null); }
      const m = /^\s*#\s*([A-Za-z]+)\b(.*)$/.exec(line);
      if (m && PP_DIRECTIVES.has(m[1])) {
        const d = m[1], rest = m[2].trim();
        if (d === 'ifdef' || d === 'ifndef') {
          const on = macros.has(rest.split(/\s+/)[0]) === (d === 'ifdef');
          cond.push({ active: on, taken: on }); out.push(null); continue;
        }
        if (d === 'if') { const on = active() ? !!evalCExpr(stripHash(rest), macros) : false; cond.push({ active: on, taken: on }); out.push(null); continue; }
        if (d === 'elif') {
          const c = cond[cond.length - 1];
          if (!c) diag.error(name, lineNo, '#elif without #if');
          else if (c.taken) c.active = false;
          else { const saved = c.active; c.active = true; const on = active() && !!evalCExpr(stripHash(rest), macros); c.active = on; c.taken = on; void saved; }
          out.push(null); continue;
        }
        if (d === 'else') { const c = cond[cond.length - 1]; if (!c) diag.error(name, lineNo, '#else without #if'); else { c.active = !c.taken; c.taken = true; } out.push(null); continue; }
        if (d === 'endif') { if (!cond.pop()) diag.error(name, lineNo, '#endif without #if'); out.push(null); continue; }
        if (!active()) { out.push(null); continue; }
        if (d === 'define') {
          const dm = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
          if (!dm) diag.error(name, lineNo, 'macro names must be identifiers');
          else macros.set(dm[1], { params: dm[2] ? dm[3].split(',').map((s) => s.trim()).filter(Boolean) : null, body: stripHash(dm[4]).trim() });
          out.push(null); continue;
        }
        if (d === 'undef') { macros.delete(rest.split(/\s+/)[0]); out.push(null); continue; }
        if (d === 'include') {
          out.push(null);
          const im = /^"([^"]+)"|^<([^>]+)>/.exec(rest);
          if (!im) { diag.error(name, lineNo, '#include expects "FILENAME" or <FILENAME>'); continue; }
          if (im[2]) { diag.warn(name, lineNo, `#include <${im[2]}> skipped: system headers aren't available here (and aren't needed by assembly code).`); continue; }
          const f = findFile(files, im[1]);
          if (!f) { diag.error(name, lineNo, `${im[1]}: No such file or directory`, 'Add the header to the project (Files ▸ Open) so it can be included.'); continue; }
          if (f !== im[1]) diag.warn(name, lineNo, `#include "${im[1]}" matched file "${f}" only ignoring case.`);
          if (stack.includes(f)) { diag.error(name, lineNo, `#include "${f}" includes itself`); continue; }
          visit(f, [...stack, f]);
          continue;
        }
        if (d === 'error') { diag.error(name, lineNo, '#error ' + rest); out.push(null); continue; }
        if (d === 'warning') { diag.warn(name, lineNo, '#warning ' + rest); out.push(null); continue; }
        out.push(null); continue;
      }
      if (!active()) { out.push(null); continue; }
      let code = stripHash(line);
      if (macros.size) code = expandMacros(code, macros, 0);
      out.push({ text: code, file: name, line: lineNo, src: line });
    }
    if (cond.length) diag.error(name, lines.length, 'unterminated #if');
  };
  visit(mainName, [mainName]);
  return out.filter(Boolean);
}

// ---------------------------------------------------------------- expressions
const BIN_PREC = { '*': 4, '/': 4, '%': 4, '<<': 4, '>>': 4, '|': 3, '&': 3, '^': 3, '!': 3,
  '+': 2, '-': 2, '==': 2, '!=': 2, '<>': 2, '<': 2, '>': 2, '<=': 2, '>=': 2, '&&': 1, '||': 1 };

function tokenizeExpr(s) {
  const toks = [];
  const re = /\s*(%(?:hi|lo|pcrel_hi|pcrel_lo|tprel_hi|tprel_lo)\b|0[xX][0-9a-fA-F]+|0[bB][01]+|\d+[bf]\b|\d+|'(?:\\.|[^\\'])'?|[A-Za-z_.$][\w.$]*|<<|>>|<=|>=|==|!=|<>|&&|\|\||[-+*/%()&|^~!<>])/y;
  let m, last = 0;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) { toks.push(m[1]); last = re.lastIndex; }
  if (s.slice(last).trim() !== '') throw new AsmError(`junk at end of expression: \`${s.slice(last).trim()}'`);
  return toks;
}

// ctx: { sym(name) -> {v, rel} | undefined, local(n, dir) -> addr|undefined, pc, pcrelLo(addr) }
function evalExpr(s, ctx) {
  const toks = tokenizeExpr(s);
  let p = 0;
  const undef = [];
  const prim = () => {
    const t = toks[p++];
    if (t === undefined) throw new AsmError('missing operand in expression');
    if (t === '(') { const v = binary(0); if (toks[p++] !== ')') throw new AsmError('missing )'); return v; }
    if (t === '-') { const v = prim(); return { v: -v.v, rel: v.rel }; }
    if (t === '+') return prim();
    if (t === '~') { const v = prim(); return { v: ~v.v, rel: v.rel }; }
    if (t === '!') { const v = prim(); return { v: v.v ? 0 : 1, rel: false }; }
    if (t[0] === '%') {
      if (toks[p++] !== '(') throw new AsmError(`${t} needs parentheses: ${t}(symbol)`);
      const v = binary(0);
      if (toks[p++] !== ')') throw new AsmError('missing )');
      const x = v.v | 0;
      switch (t) {
        case '%hi': return { v: ((x + 0x800) >>> 12) & 0xfffff, rel: false, reloc: 'hi' };
        case '%lo': return { v: ((x & 0xfff) << 20) >> 20, rel: false, reloc: 'lo' };
        case '%pcrel_hi': { const d = (x - ctx.pc) | 0; return { v: ((d + 0x800) >>> 12) & 0xfffff, rel: false, reloc: 'pcrel_hi', target: x }; }
        case '%pcrel_lo': { const tgt = ctx.pcrelLo ? ctx.pcrelLo(x >>> 0) : undefined; if (tgt === undefined) { undef.push('%pcrel_lo'); return { v: 0, rel: false }; } const d = (tgt - x) | 0; return { v: ((d & 0xfff) << 20) >> 20, rel: false, reloc: 'lo' }; }
        default: throw new AsmError(`${t} isn't supported`);
      }
    }
    if (/^0[xX]/.test(t)) return { v: Number(BigInt.asIntN(64, BigInt(t))), rel: false };
    if (/^0[bB]/.test(t)) return { v: parseInt(t.slice(2), 2), rel: false };
    if (/^\d+[bf]$/.test(t)) {
      const a = ctx.local ? ctx.local(t.slice(0, -1), t.slice(-1)) : undefined;
      if (a === undefined) { undef.push(t); return { v: 0, rel: true }; }
      return { v: a, rel: true };
    }
    if (/^\d/.test(t)) return { v: t.length > 1 && t[0] === '0' ? parseInt(t, 8) : Number(t), rel: false };
    if (t[0] === "'") {
      let ch = t.slice(1).replace(/'$/, '');
      if (ch[0] === '\\') ch = unescapeChar(ch.slice(1));
      return { v: ch.charCodeAt(0), rel: false };
    }
    if (t === '.') return { v: ctx.pc, rel: true };
    const sv = ctx.sym(t);
    if (!sv) { undef.push(t); return { v: 0, rel: true }; }
    return sv;
  };
  const binary = (minPrec) => {
    let left = prim();
    for (;;) {
      const op = toks[p];
      const prec = BIN_PREC[op];
      if (prec === undefined || prec < minPrec) break;
      p++;
      const right = binary(prec + 1);
      const a = left.v, b = right.v;
      let v;
      switch (op) {
        case '*': v = a * b; break;
        case '/': if (b === 0) throw new AsmError('division by zero'); v = Math.trunc(a / b); break;
        case '%': if (b === 0) throw new AsmError('division by zero'); v = a % b; break;
        case '<<': v = Number(BigInt.asIntN(64, BigInt(Math.trunc(a)) << BigInt(b & 63))); break;
        case '>>': v = Number(BigInt.asIntN(64, BigInt(Math.trunc(a)) >> BigInt(b & 63))); break;
        case '|': v = Number(BigInt.asIntN(64, BigInt(Math.trunc(a)) | BigInt(Math.trunc(b)))); break;
        case '&': v = Number(BigInt.asIntN(64, BigInt(Math.trunc(a)) & BigInt(Math.trunc(b)))); break;
        case '^': v = Number(BigInt.asIntN(64, BigInt(Math.trunc(a)) ^ BigInt(Math.trunc(b)))); break;
        case '!': v = Number(BigInt.asIntN(64, BigInt(Math.trunc(a)) | ~BigInt(Math.trunc(b)))); break;
        case '+': v = a + b; break;
        case '-': v = a - b; break;
        case '==': v = a === b ? -1 : 0; break;
        case '!=': case '<>': v = a !== b ? -1 : 0; break;
        case '<': v = a < b ? -1 : 0; break;
        case '>': v = a > b ? -1 : 0; break;
        case '<=': v = a <= b ? -1 : 0; break;
        case '>=': v = a >= b ? -1 : 0; break;
        case '&&': v = a && b ? 1 : 0; break;
        case '||': v = a || b ? 1 : 0; break;
      }
      const rel = op === '-' && left.rel && right.rel ? false : (left.rel || right.rel);
      left = { v, rel };
    }
    return left;
  };
  const r = binary(0);
  if (p < toks.length) throw new AsmError(`junk at end of expression: \`${toks.slice(p).join(' ')}'`);
  r.undef = undef;
  return r;
}

function unescapeChar(s) {
  const map = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };
  return map[s[0]] ?? s[0];
}

function parseString(s) {
  s = s.trim();
  if (s[0] !== '"') throw new AsmError('expected a string in double quotes');
  const bytes = [];
  let i = 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    let c = s[i];
    if (c === '\\') {
      const n = s[++i];
      if (/[0-7]/.test(n)) { let o = ''; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; i--; bytes.push(parseInt(o, 8) & 255); continue; }
      if (n === 'x') { let h = ''; i++; while (/[0-9a-fA-F]/.test(s[i])) h += s[i++]; i--; bytes.push(parseInt(h, 16) & 255); continue; }
      c = unescapeChar(n);
    }
    const code = c.charCodeAt(0);
    if (code < 128) bytes.push(code); else for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  if (s[i] !== '"') throw new AsmError('missing closing quote');
  if (s.slice(i + 1).trim()) throw new AsmError(`junk after string: \`${s.slice(i + 1).trim()}'`);
  return bytes;
}

// ---------------------------------------------------------------- statement parsing
const LABEL_RE = /^\s*([A-Za-z_.$][\w.$]*|\d+)\s*:(?!=)/;

function splitStatements(text) {
  const out = []; let cur = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { cur += c; if (c === '\\') cur += text[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    if (c === "'" && text[i + 2] === "'") { cur += text.slice(i, i + 3); i += 2; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function sectionOf(name) {
  if (/^\.text/.test(name) || /^\.init/.test(name) || /^\.fini/.test(name)) return 'text';
  if (/^\.s?rodata/.test(name) || /^\.rdata/.test(name)) return 'rodata';
  if (/^\.s?bss/.test(name) || /^\.tbss/.test(name)) return 'bss';
  if (/^\.s?data/.test(name) || /^\.tdata/.test(name)) return 'data';
  return null;
}

const IGNORED_DIRECTIVES = new Set(['.type', '.size', '.file', '.ident', '.attribute', '.option', '.local', '.weak',
  '.hidden', '.protected', '.internal', '.func', '.endfunc', '.loc', '.loc_mark_labels', '.addrsig', '.addrsig_sym',
  '.cfi_startproc', '.cfi_endproc', '.cfi_def_cfa', '.cfi_def_cfa_offset', '.cfi_offset', '.cfi_restore',
  '.cfi_sections', '.cfi_undefined', '.cfi_remember_state', '.cfi_restore_state', '.cfi_adjust_cfa_offset',
  '.cfi_def_cfa_register', '.cfi_rel_offset', '.cfi_return_column', '.cfi_signal_frame', '.cfi_escape',
  '.list', '.nolist', '.psize', '.title', '.sbttl', '.eject', '.previous', '.pushsection', '.popsection', '.subsection', '.extern', '.lflags']);

// Expand GNU macros (.macro/.rept/.irp), .include, and .if blocks into a flat statement list.
function expandStatements(lines, files, diag) {
  const stmts = [];
  const macros = new Map();
  const eqSyms = new Map(); // .equ values seen so far (for .if)
  let macroCounter = 0;
  let ended = false;

  const constCtx = { sym: (n) => (eqSyms.has(n) ? { v: eqSyms.get(n), rel: false } : undefined), pc: 0 };

  const process = (items, depth) => {
    if (depth > 40) throw new AsmError('macros nested too deeply');
    const condStack = [];
    const active = () => condStack.every((c) => c.active);
    for (let i = 0; i < items.length && !ended; i++) {
      const it = items[i];
      for (const piece of splitStatements(it.text)) {
        let rest = piece;
        const labels = [];
        let lm;
        while ((lm = LABEL_RE.exec(rest))) { labels.push(lm[1]); rest = rest.slice(lm[0].length); }
        rest = rest.trim();
        const dm = /^(\.[A-Za-z_][\w.]*)\b\s*(.*)$/.exec(rest);
        const dir = dm ? dm[1].toLowerCase() : null;
        const arg = dm ? dm[2] : '';
        // conditionals
        if (dir === '.if' || dir === '.ifdef' || dir === '.ifndef' || dir === '.ifeq' || dir === '.ifne' || dir === '.ifnes' || dir === '.ifc') {
          let on = false;
          if (active()) {
            try {
              if (dir === '.ifdef') on = eqSyms.has(arg.trim()) || stmts.some((s) => s.labels.includes(arg.trim()));
              else if (dir === '.ifndef') on = !(eqSyms.has(arg.trim()) || stmts.some((s) => s.labels.includes(arg.trim())));
              else if (dir === '.ifc') { const [a, b] = splitArgs(arg); on = (a ?? '').trim() === (b ?? '').trim(); }
              else if (dir === '.ifnes') { const [a, b] = splitArgs(arg); on = (a ?? '').trim() !== (b ?? '').trim(); }
              else { const v = evalExpr(arg, constCtx).v; on = dir === '.ifeq' ? v === 0 : v !== 0; }
            } catch (e) { diag.error(it.file, it.line, e.message); }
          }
          condStack.push({ active: on, taken: on });
          continue;
        }
        if (dir === '.elseif') { const c = condStack[condStack.length - 1]; if (c) { if (c.taken) c.active = false; else { c.active = true; const on = active() && evalExpr(arg, constCtx).v !== 0; c.active = on; c.taken = on; } } continue; }
        if (dir === '.else') { const c = condStack[condStack.length - 1]; if (!c) diag.error(it.file, it.line, '.else without .if'); else { c.active = !c.taken; c.taken = true; } continue; }
        if (dir === '.endif') { if (!condStack.pop()) diag.error(it.file, it.line, '.endif without .if'); continue; }
        if (!active()) continue;

        if (dir === '.macro') {
          const parts = arg.trim().split(/[\s,]+/).filter(Boolean);
          const name = parts.shift();
          const params = parts.map((p) => { const [n, d] = p.split('='); return { name: n.replace(/:req$/, ''), def: d }; });
          const body = [];
          let nest = 0, j = i + 1;
          for (; j < items.length; j++) {
            const t = items[j].text.trim().toLowerCase();
            if (/^\.macro\b/.test(t)) nest++;
            if (/^\.endm\b/.test(t)) { if (nest === 0) break; nest--; }
            body.push(items[j]);
          }
          if (j >= items.length) diag.error(it.file, it.line, 'missing .endm');
          macros.set(name.toLowerCase(), { params, body });
          i = j; break;
        }
        if (dir === '.rept' || dir === '.irp' || dir === '.irpc') {
          const body = []; let nest = 0, j = i + 1;
          for (; j < items.length; j++) {
            const t = items[j].text.trim().toLowerCase();
            if (/^\.(rept|irp|irpc)\b/.test(t)) nest++;
            if (/^\.endr\b/.test(t)) { if (nest === 0) break; nest--; }
            body.push(items[j]);
          }
          if (j >= items.length) diag.error(it.file, it.line, 'missing .endr');
          if (dir === '.rept') {
            let n = 0; try { n = evalExpr(arg, constCtx).v; } catch (e) { diag.error(it.file, it.line, e.message); }
            for (let k = 0; k < Math.min(n, 100000); k++) process(body, depth + 1);
          } else {
            const [pname, ...vals] = splitArgs(arg.replace(/^\s*(\w+)\s*,?/, '$1,'));
            const list = dir === '.irpc' ? [...(vals[0] ?? '')] : vals;
            for (const v of list) process(body.map((b) => ({ ...b, text: b.text.replace(new RegExp('\\\\' + pname + '\\b', 'g'), v) })), depth + 1);
          }
          i = j; break;
        }
        if (dir === '.endm' || dir === '.endr') { diag.error(it.file, it.line, `${dir} without matching start`); continue; }
        if (dir === '.include') {
          let fname; try { fname = String.fromCharCode(...parseString(arg)); } catch (e) { diag.error(it.file, it.line, e.message); continue; }
          const f = findFile(files, fname);
          if (!f) { diag.error(it.file, it.line, `can't open ${fname} for reading: No such file or directory`); continue; }
          const sub = stripCComments(files[f].replace(/\r\n?/g, '\n')).split('\n').map((t, k) => ({ text: stripHash(t), file: f, line: k + 1, src: t }));
          if (labels.length) stmts.push({ labels, op: null, args: '', file: it.file, line: it.line, src: it.src });
          process(sub, depth + 1);
          continue;
        }
        if (dir === '.end') {
          if (labels.length) stmts.push({ labels, op: null, args: '', file: it.file, line: it.line, src: it.src });
          ended = true; break;
        }
        if (dir === '.equ' || dir === '.set' || dir === '.equiv' || dir === '.eqv') {
          const [n, e] = splitArgs(arg);
          try { const v = evalExpr(e ?? '', constCtx); if (!v.undef.length && !v.rel) eqSyms.set(n, v.v); } catch { /* resolved later */ }
        }
        // macro invocation
        const om = /^([A-Za-z_.$][\w.$]*)\s*(.*)$/.exec(rest);
        if (!dir && om && macros.has(om[1].toLowerCase()) && !(om[1].toLowerCase() in INSNS)) {
          const mac = macros.get(om[1].toLowerCase());
          let args = om[2].trim() ? splitArgs(om[2]) : [];
          if (args.length === 1 && mac.params.length > 1 && /\s/.test(args[0]) && !/[()]/.test(args[0])) args = args[0].split(/\s+/);
          const named = {};
          args = args.filter((a) => { const nm = /^(\w+)\s*=\s*(.*)$/.exec(a); if (nm && mac.params.some((p) => p.name === nm[1])) { named[nm[1]] = nm[2]; return false; } return true; });
          const id = macroCounter++;
          const body = mac.body.map((b) => {
            let t = b.text;
            mac.params.forEach((p, k) => {
              const val = named[p.name] ?? args[k] ?? p.def ?? '';
              t = t.replace(new RegExp('\\\\' + p.name + '(\\(\\))?(?!\\w)', 'g'), val);
            });
            t = t.replace(/\\@/g, String(id));
            return { ...b, text: t, file: it.file, line: it.line, src: it.src, fromMacro: om[1] };
          });
          if (labels.length) stmts.push({ labels, op: null, args: '', file: it.file, line: it.line, src: it.src });
          process(body, depth + 1);
          continue;
        }
        if (!labels.length && !rest) continue;
        let op = null, args = '';
        if (rest) {
          const am = /^([A-Za-z_.$][\w.$]*)\s*=\s*(.+)$/.exec(rest);
          if (am && !dir) { op = '.set'; args = `${am[1]}, ${am[2]}`; }
          else { const m2 = /^(\S+)\s*(.*)$/.exec(rest); op = m2[1].toLowerCase(); args = m2[2].trim(); }
        }
        stmts.push({ labels, op, args, file: it.file, line: it.line, src: it.src, fromMacro: it.fromMacro });
      }
    }
    if (condStack.length && depth === 0) diag.error(items[items.length - 1]?.file ?? '', items[items.length - 1]?.line ?? 0, 'end of file inside conditional (.if without .endif)');
  };
  process(lines, 0);
  return stmts;
}

// ---------------------------------------------------------------- assembler core
function reg(s) {
  const r = REGS.get(s.trim());
  if (r === undefined) {
    const hint = REGS.has(s.trim().toLowerCase()) ? `Register names are lowercase in GNU as: write \`${s.trim().toLowerCase()}'.`
      : `\`${s.trim()}' isn't a register name (x0–x31, zero, ra, sp, gp, tp, t0–t6, s0–s11, a0–a7, fp).`;
    throw new AsmError(`illegal operands`, hint);
  }
  return r;
}
const isReg = (s) => REGS.has(s.trim());
// GNU as on RV32 accepts 32-bit constants for 12-bit fields and reads them as signed (0xFFFFF800 = -2048).
const wrap32 = (v) => (v >= 0x80000000 && v <= 0xffffffff ? v | 0 : v);

function memOperand(s) {
  const m = /^(.*)\(\s*([A-Za-z0-9]+)\s*\)\s*$/.exec(s.trim());
  if (m && (isReg(m[2]) || REGS.has(m[2].toLowerCase()))) return { off: m[1].trim() || '0', base: reg(m[2]) };
  return null;
}

function fits(v, bits) { return v >= -(2 ** (bits - 1)) && v < 2 ** (bits - 1); }
function rangeErr(what, v, lo, hi) {
  return new AsmError(`illegal operands`, `${what} ${v} is out of range: it must be ${lo}…${hi}.`);
}

const BRANCH_PSEUDO = {
  beqz: ['beq', (a) => [a[0], 'zero', a[1]]], bnez: ['bne', (a) => [a[0], 'zero', a[1]]],
  blez: ['bge', (a) => ['zero', a[0], a[1]]], bgez: ['bge', (a) => [a[0], 'zero', a[1]]],
  bltz: ['blt', (a) => [a[0], 'zero', a[1]]], bgtz: ['blt', (a) => ['zero', a[0], a[1]]],
  bgt: ['blt', (a) => [a[1], a[0], a[2]]], ble: ['bge', (a) => [a[1], a[0], a[2]]],
  bgtu: ['bltu', (a) => [a[1], a[0], a[2]]], bleu: ['bgeu', (a) => [a[1], a[0], a[2]]],
};
const LOADS = new Set(['lb', 'lh', 'lw', 'lbu', 'lhu']);
const STORES = new Set(['sb', 'sh', 'sw']);

export function assemble(files, mainName, opts = {}) {
  const errors = [], warnings = [];
  const diag = {
    error: (file, line, msg, hint) => { if (errors.length < 100) errors.push({ file, line, msg, hint }); },
    warn: (file, line, msg, hint) => { if (warnings.length < 100) warnings.push({ file, line, msg, hint }); },
  };
  const result = { ok: false, errors, warnings };
  if (!(mainName in files)) { diag.error(mainName, 1, `can't open ${mainName}`); return result; }
  const lines = preprocess(files, mainName, diag);
  let stmts;
  try { stmts = expandStatements(lines, files, diag); } catch (e) { diag.error(mainName, 1, e.message); return result; }
  if (errors.length) return result;

  const symbols = new Map();      // name -> { v, rel, sec, kind: 'label'|'equ', file, line }
  const globals = new Set();
  let localDefs = new Map();      // number -> [{idx, addr}]
  let sizes = new Array(stmts.length).fill(0);
  let secSize = { text: 0, rodata: 0, data: 0, bss: 0 };
  let bases = null;
  const computeBases = () => {
    const text = opts.textBase ?? LAYOUT.text;
    const rodata = (text + secSize.text + 7) & ~7;
    const data = LAYOUT.ram;
    const bss = (data + secSize.data + 7) & ~7;
    return { text, rodata, data, bss };
  };

  const pcrelHi = new Map(); // auipc addr -> target
  let finalPass = false;
  let listing = [];
  let image = null;

  const runPass = () => {
    bases = computeBases();
    const offs = { text: 0, rodata: 0, data: 0, bss: 0 };
    const newLocal = new Map();
    const definedThisPass = new Set();
    let sec = 'text';
    const maxAlign = { text: 4, rodata: 1, data: 1, bss: 1 };
    if (finalPass) {
      image = {
        text: new Uint8Array(secSize.text), rodata: new Uint8Array(secSize.rodata),
        data: new Uint8Array(secSize.data), bss: new Uint8Array(0),
      };
      listing = [];
    }
    let changed = false;

    for (let idx = 0; idx < stmts.length; idx++) {
      const st = stmts[idx];
      const pc = () => (bases[sec] + offs[sec]) >>> 0;
      const ctx = {
        pc: pc(),
        sym: (n) => symbols.get(n),
        local: (num, dir) => {
          if (dir === 'b') { const defs = newLocal.get(num) || []; return defs.length ? defs[defs.length - 1].addr : undefined; }
          for (const d of (localDefs.get(num) || [])) if (d.idx > idx) return d.addr;
          return undefined;
        },
        pcrelLo: (a) => pcrelHi.get(a),
      };
      const E = (s, allowUndef = !finalPass) => {
        ctx.pc = pc();
        const r = evalExpr(s, ctx);
        if (r.undef.length && !allowUndef) {
          const n = r.undef[0];
          throw new AsmError(/^\d+[bf]$/.test(n) ? `undefined local label \`${n}'` : `undefined reference to \`${n}'`,
            /^\d+[bf]$/.test(n) ? undefined : `No label or .equ named \`${n}' exists. Symbol names are case-sensitive.`);
        }
        return r;
      };
      // labels
      for (const lb of st.labels) {
        const addr = pc();
        if (/^\d+$/.test(lb)) {
          if (!newLocal.has(lb)) newLocal.set(lb, []);
          newLocal.get(lb).push({ idx, addr });
          continue;
        }
        if (definedThisPass.has(lb)) { if (finalPass) diag.error(st.file, st.line, `symbol \`${lb}' is already defined`); continue; }
        definedThisPass.add(lb);
        const old = symbols.get(lb);
        if (!old || old.v !== addr) changed = true;
        symbols.set(lb, { v: addr, rel: true, sec, kind: 'label', file: st.file, line: st.line });
      }
      if (!st.op) continue;
      const startOff = offs[sec], startSec = sec, startPc = pc();
      let words = []; // [{addr, word, text}] for listing (code); data bytes go straight to image
      const emitBytes = (bytes) => {
        if (finalPass && sec !== 'bss') {
          const arr = image[sec];
          for (let k = 0; k < bytes.length; k++) arr[offs[sec] + k] = bytes[k];
        } else if (finalPass && sec === 'bss' && bytes.some((b) => b !== 0)) {
          diag.warn(st.file, st.line, 'non-zero data in .bss is ignored (.bss is zero-filled)');
        }
        offs[sec] += bytes.length;
      };
      const emitWord = (w, text) => {
        if (sec === 'bss') throw new AsmError('instructions can\'t go in .bss', 'Put code in .text (use `.text` or `.section .text`).');
        if (finalPass) words.push({ addr: pc(), word: w >>> 0, text: text ?? disasm(w, pc()) });
        emitBytes([w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255]);
      };
      const reserve = (n) => { offs[sec] += n; };
      try {
        const op = st.op;
        if (op[0] === '.') {
          doDirective(op, st, sec, E, emitBytes, offs, (s) => { sec = s; }, symbols, globals, diag, finalPass, pc, idx, definedThisPass, () => { changed = true; }, maxAlign);
          const ns = op === '.section' || op === '.text' || op === '.data' || op === '.bss' || op === '.rodata';
          if (!ns) { /* nothing */ }
        } else {
          if (sec !== 'text' && finalPass && !st._warnedSec) { diag.warn(st.file, st.line, `instruction in ${sec === 'rodata' ? '.rodata' : '.' + sec} section`, 'Code normally goes in .text.'); st._warnedSec = true; }
          if (finalPass) {
            assembleInsn(op, st.args, E, emitWord, pc, pcrelHi, diag, st);
          } else {
            const n = sizeInsn(op, st.args, E);
            reserve(n);
          }
        }
      } catch (e) {
        if (!(e instanceof AsmError)) throw e;
        if (finalPass) {
          const shown = `${st.op}${st.args ? ' ' + st.args.replace(/\s*,\s*/g, ',') : ''}`;
          const msg = e.message === 'illegal operands' ? `illegal operands \`${shown}'` : e.message;
          diag.error(st.file, st.line, msg, e.hint);
        }
        // keep sizes consistent with layout pass
        if (finalPass && offs[startSec] - startOff < sizes[idx]) offs[startSec] = startOff + sizes[idx];
      }
      const size = offs[startSec] - startOff + (sec !== startSec ? 0 : 0);
      if (!finalPass) {
        if (sizes[idx] !== size) changed = true;
        sizes[idx] = size;
      } else if (size !== sizes[idx] && !errors.length) {
        diag.error(st.file, st.line, `internal assembler error: size of this statement changed between passes (${sizes[idx]} → ${size})`, 'Please report this with your file.');
      }
      if (finalPass && (words.length || size)) {
        listing.push({ sec: startSec, addr: startPc, size, words, file: st.file, line: st.line, src: st.src, fromMacro: st.fromMacro, isCode: words.length > 0 });
      }
    }
    localDefs = newLocal;
    // GNU as rounds each section's size up to the section's alignment (code is padded with nops).
    for (const s of Object.keys(offs)) {
      const end = s === 'text' ? Math.ceil(offs[s] / maxAlign[s]) * maxAlign[s] : offs[s];
      if (finalPass && s === 'text') for (let k = offs[s] + ((4 - offs[s] % 4) % 4); k + 4 <= end; k += 4) image.text[k] = 0x13;
      offs[s] = end;
    }
    const newSize = { ...offs };
    for (const k of Object.keys(newSize)) if (newSize[k] !== secSize[k]) changed = true;
    secSize = newSize;
    return changed;
  };

  let pass = 0;
  for (; pass < 12; pass++) {
    const changed = runPass();
    if (errors.length) return result;
    if (!changed && pass > 0) break;
  }
  finalPass = true;
  runPass();
  if (errors.length) return result;

  // entry point, mirroring the SDK: _enter calls _start; with no _start, crt0 calls main.
  const entryName = ['_start', 'main'].find((n) => symbols.get(n)?.kind === 'label' && symbols.get(n).sec === 'text')
    || [...globals].find((n) => symbols.get(n)?.kind === 'label' && symbols.get(n).sec === 'text')
    || null;
  const entry = entryName ? symbols.get(entryName).v : LAYOUT.text;
  if (!entryName) diag.warn(mainName, 1, 'no _start or main label: execution starts at the first instruction of .text');
  else if (entryName !== '_start' && entryName !== 'main') diag.warn(mainName, 1, `no _start or main label: entering at global label \`${entryName}' (as if called from C)`);

  const ramEnd = bases.bss + secSize.bss;
  const sp = (((ramEnd + 15) & ~15) + LAYOUT.stackSize) >>> 0;
  if (sp > LAYOUT.ram + LAYOUT.ramSize) diag.error(mainName, 1, `.data + .bss + stack (${sp - LAYOUT.ram} bytes) don't fit in the 16 KiB DTIM`);
  const gp = (bases.data + 0x800) >>> 0;
  symbols.set('__global_pointer$', { v: gp, rel: true, sec: 'data', kind: 'label' });

  // address <-> source line maps
  const addrToLoc = new Map();
  const lineToAddr = new Map();
  for (const l of listing) {
    if (!l.isCode) continue;
    for (const w of l.words) addrToLoc.set(w.addr, { file: l.file, line: l.line });
    const key = l.file + ':' + l.line;
    if (!lineToAddr.has(key)) lineToAddr.set(key, l.words[0].addr);
  }

  Object.assign(result, {
    ok: errors.length === 0,
    image, bases, sizes: secSize, symbols, globals, listing, entry, entryName,
    sp, gp, addrToLoc, lineToAddr, passes: pass + 2,
  });
  return result;
}

function doDirective(op, st, sec, E, emitBytes, offs, setSec, symbols, globals, diag, finalPass, pc, idx, definedThisPass, markChanged, maxAlign) {
  const a = st.args;
  switch (op) {
    case '.text': setSec('text'); return;
    case '.data': setSec('data'); return;
    case '.bss': setSec('bss'); return;
    case '.rodata': setSec('rodata'); return;
    case '.section': {
      const name = splitArgs(a)[0] || '';
      const s = sectionOf(name);
      if (!s) {
        if (finalPass) diag.warn(st.file, st.line, `section ${name} isn't one this board image uses; treating it as .text`);
        setSec('text');
      } else setSec(s);
      return;
    }
    case '.globl': case '.global': for (const n of splitArgs(a)) globals.add(n.trim()); return;
    case '.equ': case '.set': case '.equiv': case '.eqv': {
      const [n, e] = splitArgs(a);
      if (!n || e === undefined) throw new AsmError(`expected comma after name in ${op}`);
      if (!/^[A-Za-z_.$][\w.$]*$/.test(n)) throw new AsmError(`bad symbol name \`${n}'`);
      const old = symbols.get(n);
      if (old && old.kind === 'label') throw new AsmError(`symbol \`${n}' is already defined`);
      if (finalPass && op === '.equiv' && definedThisPass.has(n)) throw new AsmError(`symbol \`${n}' is already defined`);
      const v = E(e);
      definedThisPass.add(n);
      if (!old || old.v !== v.v) markChanged();
      symbols.set(n, { v: v.v, rel: v.rel, sec: null, kind: 'equ', file: st.file, line: st.line });
      return;
    }
    case '.align': case '.p2align': case '.balign': {
      const [n, fill, max] = splitArgs(a);
      let align = E(n || '0', false).v;
      if (op !== '.balign') align = 2 ** align;
      if (align <= 0 || (align & (align - 1))) throw new AsmError(`alignment not a power of 2`);
      if (align > maxAlign[sec]) maxAlign[sec] = align;
      const cur = offs[sec];
      let pad = (align - (cur % align)) % align;
      if (max !== undefined && pad > E(max, false).v) pad = 0;
      const bytes = [];
      if (sec === 'text' && fill === undefined) {
        while (pad % 4 && pad) { bytes.push(0); pad--; }
        for (let k = 0; k < pad; k += 4) bytes.push(0x13, 0, 0, 0);
      } else { const f = fill !== undefined ? E(fill, false).v & 255 : 0; for (let k = 0; k < pad; k++) bytes.push(f); }
      emitBytes(bytes);
      return;
    }
    case '.byte': case '.half': case '.short': case '.2byte': case '.hword': case '.word': case '.long':
    case '.4byte': case '.int': case '.dword': case '.quad': case '.8byte': {
      const size = { '.byte': 1, '.half': 2, '.short': 2, '.2byte': 2, '.hword': 2, '.word': 4, '.long': 4, '.4byte': 4, '.int': 4 }[op] ?? 8;
      if (!a.trim()) return;
      const bytes = [];
      for (const item of splitArgs(a)) {
        if (item[0] === '"' && size === 1) { bytes.push(...parseString(item)); continue; }
        const v = E(item);
        const lim = 2 ** (size * 8);
        if (finalPass && size < 8 && (v.v >= lim || v.v < -(lim / 2))) diag.warn(st.file, st.line, `value 0x${(v.v >>> 0).toString(16)} truncated to ${size * 8} bits`);
        let big = BigInt.asUintN(64, BigInt(Math.trunc(v.v)));
        for (let k = 0; k < size; k++) { bytes.push(Number(big & 255n)); big >>= 8n; }
      }
      emitBytes(bytes);
      return;
    }
    case '.ascii': case '.asciz': case '.string': case '.string8': {
      const bytes = [];
      for (const s of splitArgs(a)) { bytes.push(...parseString(s)); if (op !== '.ascii') bytes.push(0); }
      emitBytes(bytes);
      return;
    }
    case '.space': case '.skip': case '.zero': {
      const [n, f] = splitArgs(a);
      const cnt = E(n, false).v;
      if (cnt < 0 || cnt > 1 << 20) throw new AsmError(`.space size ${cnt} is out of range`);
      const fill = op === '.zero' ? 0 : f !== undefined ? E(f, false).v & 255 : 0;
      emitBytes(new Array(cnt).fill(fill));
      return;
    }
    case '.fill': {
      const [r, s, v] = splitArgs(a);
      const rep = E(r, false).v, size = s !== undefined ? E(s, false).v : 1, val = v !== undefined ? E(v, false).v : 0;
      const bytes = [];
      for (let k = 0; k < rep; k++) for (let b = 0; b < Math.min(size, 8); b++) bytes.push(b < 4 ? (val >>> (8 * b)) & 255 : 0);
      emitBytes(bytes);
      return;
    }
    case '.comm': case '.lcomm':
      throw new AsmError(`${op} isn't supported`, 'Reserve space with a label in .bss and `.space N` instead.');
    default:
      if (IGNORED_DIRECTIVES.has(op) || op.startsWith('.cfi_')) return;
      throw new AsmError(`unknown pseudo-op: \`${op}'`);
  }
}

function operands(args) { return args.trim() ? splitArgs(args) : []; }
function need(ops, n) { if (ops.length !== n) throw new AsmError('illegal operands'); }

function liSize(v) {
  if (v.rel) return 8;
  const x = v.v;
  if (x > 0xffffffff || x < -0x80000000) return 8;
  const s = x | 0;
  if (fits(s, 12)) return 4;
  return (s & 0xfff) === 0 ? 4 : 8;
}

function sizeInsn(op, args, E) {
  const ops = operands(args);
  const val = (s) => { try { return E(s); } catch { return { v: 0, rel: true, undef: ['?'] }; } };
  switch (op) {
    case 'li': { if (ops.length !== 2) return 4; const v = val(ops[1]); return v.undef?.length ? 8 : liSize(v); }
    case 'la': case 'lla': { if (ops.length !== 2) return 8; const v = val(ops[1]); return !v.undef?.length && !v.rel ? liSize(v) : 8; }
    case 'call': case 'tail': return 8;
    default:
      if (LOADS.has(op) && ops.length === 2 && !memOperand(ops[1])) return 8;
      if (STORES.has(op) && ops.length === 3) return 8;
      return 4;
  }
}

function assembleInsn(op, args, E, emitWord, pc, pcrelHi, diag, st) {
  const ops = operands(args);
  const imm = (s) => { const v = E(s); return v; };
  const I = (name, rd, rs1, im) => { const d = INSNS[name]; return encI(d[1], d[2], rd, rs1, im); };
  const checkI = (v, what = 'immediate') => { v = wrap32(v); if (!fits(v, 12)) throw rangeErr(what, v, -2048, 2047); return v; };
  const to32 = (v) => {
    if (v > 0xffffffff || v < -0x80000000) throw new AsmError('illegal operands', `${v} doesn't fit in 32 bits`);
    return v | 0;
  };

  const emitLi = (rd, v) => {
    if (!v.rel) {
      const x = to32(v.v);
      if (fits(x, 12)) { emitWord(I('addi', rd, 0, x)); return; }
      const hi = ((x + 0x800) >>> 12) & 0xfffff, lo = (x << 20) >> 20;
      emitWord(encU(0x37, rd, hi));
      if (lo !== 0) emitWord(I('addi', rd, rd, lo));
      return;
    }
    const x = v.v | 0;
    emitWord(encU(0x37, rd, ((x + 0x800) >>> 12) & 0xfffff));
    emitWord(I('addi', rd, rd, (x << 20) >> 20));
  };
  const emitPcrel = (rd, target, second) => {
    const here = pc();
    const d = (target - here) | 0;
    pcrelHi.set(here >>> 0, target >>> 0);
    emitWord(encU(0x17, rd, ((d + 0x800) >>> 12) & 0xfffff));
    second((d << 20) >> 20);
  };

  // pseudo-instructions first
  switch (op) {
    case 'nop': need(ops, 0); emitWord(I('addi', 0, 0, 0)); return;
    case 'li': need(ops, 2); emitLi(reg(ops[0]), imm(ops[1])); return;
    case 'la': case 'lla': {
      need(ops, 2);
      const rd = reg(ops[0]); const v = imm(ops[1]);
      if (!v.rel) { emitLi(rd, v); return; }
      emitPcrel(rd, v.v >>> 0, (lo) => emitWord(I('addi', rd, rd, lo)));
      return;
    }
    case 'call': case 'tail': {
      let rd = op === 'call' ? 1 : 0, tmp = op === 'call' ? 1 : 6, target;
      if (ops.length === 2 && op === 'call') { rd = reg(ops[0]); tmp = rd; target = ops[1]; }
      else { need(ops, 1); target = ops[0]; }
      const v = imm(target);
      emitPcrel(tmp, v.v >>> 0, (lo) => emitWord(I('jalr', rd, tmp, lo)));
      return;
    }
    case 'mv': need(ops, 2); emitWord(I('addi', reg(ops[0]), reg(ops[1]), 0)); return;
    case 'not': need(ops, 2); emitWord(I('xori', reg(ops[0]), reg(ops[1]), -1)); return;
    case 'neg': need(ops, 2); emitWord(encR(0x33, 0, 0x20, reg(ops[0]), 0, reg(ops[1]))); return;
    case 'seqz': need(ops, 2); emitWord(I('sltiu', reg(ops[0]), reg(ops[1]), 1)); return;
    case 'snez': need(ops, 2); emitWord(encR(0x33, 3, 0, reg(ops[0]), 0, reg(ops[1]))); return;
    case 'sltz': need(ops, 2); emitWord(encR(0x33, 2, 0, reg(ops[0]), reg(ops[1]), 0)); return;
    case 'sgtz': need(ops, 2); emitWord(encR(0x33, 2, 0, reg(ops[0]), 0, reg(ops[1]))); return;
    case 'zext.b': need(ops, 2); emitWord(I('andi', reg(ops[0]), reg(ops[1]), 255)); return;
    case 'j': need(ops, 1); return encodeJal(0, ops[0]);
    case 'jr': need(ops, 1); emitWord(I('jalr', 0, reg(ops[0]), 0)); return;
    case 'ret': need(ops, 0); emitWord(I('jalr', 0, 1, 0)); return;
    case 'csrr': need(ops, 2); emitWord(encI(0x73, 2, reg(ops[0]), 0, csr(ops[1]))); return;
    case 'csrw': case 'csrs': case 'csrc': {
      need(ops, 2);
      const f3 = { csrw: 1, csrs: 2, csrc: 3 }[op];
      if (isReg(ops[1])) emitWord(encI(0x73, f3, 0, reg(ops[1]), csr(ops[0])));
      else emitWord(encI(0x73, f3 + 4, 0, uimm5(ops[1]), csr(ops[0])));
      return;
    }
    case 'csrwi': case 'csrsi': case 'csrci': need(ops, 2); emitWord(encI(0x73, { csrwi: 5, csrsi: 6, csrci: 7 }[op], 0, uimm5(ops[1]), csr(ops[0]))); return;
    case 'rdcycle': case 'rdcycleh': case 'rdinstret': case 'rdinstreth': case 'rdtime': case 'rdtimeh': {
      need(ops, 1);
      const c = { rdcycle: 0xc00, rdtime: 0xc01, rdinstret: 0xc02, rdcycleh: 0xc80, rdtimeh: 0xc81, rdinstreth: 0xc82 }[op];
      emitWord(encI(0x73, 2, reg(ops[0]), 0, c)); return;
    }
    case 'fence': emitWord(ops.length ? encodeFence(ops) : 0x0ff0000f); return;
    case 'jal': {
      if (ops.length === 1) return encodeJal(1, ops[0]);
      need(ops, 2); return encodeJal(reg(ops[0]), ops[1]);
    }
    case 'jalr': {
      if (ops.length === 1) {
        const m = memOperand(ops[0]);
        if (m) { emitWord(I('jalr', 1, m.base, checkI(imm(m.off).v))); return; }
        emitWord(I('jalr', 1, reg(ops[0]), 0)); return;
      }
      if (ops.length === 2) {
        const m = memOperand(ops[1]);
        if (m) { emitWord(I('jalr', reg(ops[0]), m.base, checkI(imm(m.off).v))); return; }
        emitWord(I('jalr', reg(ops[0]), reg(ops[1]), 0)); return;
      }
      need(ops, 3); emitWord(I('jalr', reg(ops[0]), reg(ops[1]), checkI(imm(ops[2]).v))); return;
    }
  }
  if (op in BRANCH_PSEUDO) {
    const [real, f] = BRANCH_PSEUDO[op];
    need(ops, op.endsWith('z') ? 2 : 3);
    return encodeBranch(real, f(ops));
  }
  if (op in AMO) {
    const f5 = AMO[op];
    const aq = 0;
    if (op === 'lr.w') { need(ops, 2); const m = memOperand(ops[1]); if (!m) throw new AsmError('illegal operands'); emitWord(encR(0x2f, 2, (f5 << 2) | aq, reg(ops[0]), m.base, 0)); return; }
    need(ops, 3); const m = memOperand(ops[2]); if (!m) throw new AsmError('illegal operands');
    emitWord(encR(0x2f, 2, (f5 << 2) | aq, reg(ops[0]), m.base, reg(ops[1]))); return;
  }
  const d = INSNS[op];
  if (!d) {
    const suggestion = closeMnemonic(op);
    throw new AsmError(`unrecognized opcode \`${op}${args ? ' ' + args.replace(/\s*,\s*/g, ',') : ''}'`, suggestion ? `Did you mean \`${suggestion}'?` : undefined);
  }
  const [fmt, opc, f3, f7] = d;
  switch (fmt) {
    case 'R': need(ops, 3); emitWord(encR(opc, f3, f7, reg(ops[0]), reg(ops[1]), reg(ops[2]))); return;
    case 'I': {
      if (LOADS.has(op)) {
        need(ops, 2);
        const rd = reg(ops[0]);
        const m = memOperand(ops[1]);
        if (m) { const v = imm(m.off); emitWord(encI(opc, f3, rd, m.base, checkI(v.v, 'offset'))); return; }
        const v = imm(ops[1]);
        if (!v.rel) throw new AsmError('illegal operands', `A load needs a base register: write \`${op} ${ops[0]}, ${ops[1]}(reg)' — or a label to load from.`);
        emitPcrel(rd, v.v >>> 0, (lo) => emitWord(encI(opc, f3, rd, rd, lo)));
        return;
      }
      need(ops, 3);
      if (isReg(ops[2]) && !['jalr'].includes(op)) throw new AsmError('illegal operands', `\`${op}' takes an immediate as its last operand, not a register. Did you mean \`${op.replace(/i$/, '').replace('sltu', 'sltu')}'?`);
      const v = imm(ops[2]);
      let x = wrap32(v.v);
      if (op === 'andi' || op === 'ori' || op === 'xori' || op === 'addi' || op === 'slti' || op === 'sltiu') {
        if (!fits(x, 12)) throw rangeErr('immediate', x, -2048, 2047);
      }
      emitWord(encI(opc, f3, reg(ops[0]), reg(ops[1]), x)); return;
    }
    case 'SH': {
      need(ops, 3);
      const sh = imm(ops[2]).v;
      if (sh < 0 || sh > 31) throw new AsmError(`improper shift amount (${sh})`, 'RV32 shift amounts are 0…31.');
      emitWord(encR(opc, f3, f7, reg(ops[0]), reg(ops[1]), sh)); return;
    }
    case 'S': {
      if (ops.length === 3) { // sw rs2, symbol, rt
        const rs2 = reg(ops[0]), rt = reg(ops[2]);
        const v = imm(ops[1]);
        emitPcrel(rt, v.v >>> 0, (lo) => emitWord(encS(opc, f3, rt, rs2, lo)));
        return;
      }
      need(ops, 2);
      const m = memOperand(ops[1]);
      if (!m) {
        const v = imm(ops[1]);
        if (!v.rel && fits(v.v, 12)) { emitWord(encS(opc, f3, 0, reg(ops[0]), v.v)); return; }
        throw new AsmError('illegal operands', `To store to a label write \`${op} ${ops[0]}, ${ops[1]}, t0' (a temporary register is needed) or use \`la t0, ${ops[1]}' then \`${op} ${ops[0]}, 0(t0)'.`);
      }
      const v = imm(m.off);
      emitWord(encS(opc, f3, m.base, reg(ops[0]), checkI(v.v, 'offset'))); return;

    }
    case 'B': need(ops, 3); return encodeBranch(op, ops);
    case 'U': {
      need(ops, 2);
      const v = imm(ops[1]);
      let x = v.v;
      if (v.reloc === 'pcrel_hi') pcrelHi.set(pc() >>> 0, v.target >>> 0);
      if (x < 0 || x > 0xfffff) throw new AsmError(`${op} expression not in range 0..1048575`, `The ${op} immediate is the upper 20 bits (0…0xFFFFF). For a full 32-bit constant use \`li'.`);
      emitWord(encU(opc, reg(ops[0]), x)); return;
    }
    case 'J': return;
    case 'CSR': {
      need(ops, 3);
      if (!isReg(ops[2])) { emitWord(encI(opc, f3 + 4, reg(ops[0]), uimm5(ops[2]), csr(ops[1]))); return; }
      emitWord(encI(opc, f3, reg(ops[0]), reg(ops[2]), csr(ops[1]))); return;
    }
    case 'CSRI': need(ops, 3); emitWord(encI(opc, f3, reg(ops[0]), uimm5(ops[2]), csr(ops[1]))); return;
    case 'FIX': need(ops, 0); emitWord(opc); return;
  }
  throw new AsmError(`unrecognized opcode \`${op}'`);

  function csr(s) {
    const n = CSR_NAMES[s.trim().toLowerCase()];
    if (n !== undefined) return n;
    const v = imm(s).v;
    if (v < 0 || v > 4095) throw new AsmError('illegal operands', `unknown CSR \`${s.trim()}'`);
    return v;
  }
  function uimm5(s) {
    const v = imm(s).v;
    if (v < 0 || v > 31) throw rangeErr('CSR immediate', v, 0, 31);
    return v;
  }
  function encodeBranch(name, o) {
    const [, opc2, f32] = INSNS[name];
    const rs1 = reg(o[0]), rs2 = reg(o[1]);
    const v = imm(o[2]);
    const off = ((v.v >>> 0) - pc()) | 0;
    if (off & 1) throw new AsmError('illegal operands', 'branch target must be 2-byte aligned');
    if (off < -4096 || off > 4094) throw new AsmError(`branch target out of range (offset ${off})`, 'Conditional branches reach ±4 KiB. Branch around a `j` instead.');
    emitWord(encB(opc2, f32, rs1, rs2, off));
  }
  function encodeJal(rd, target) {
    const v = imm(target);
    const off = ((v.v >>> 0) - pc()) | 0;
    if (off & 1) throw new AsmError('illegal operands', 'jump target must be 2-byte aligned');
    if (off < -1048576 || off > 1048574) throw new AsmError(`jump target out of range (offset ${off})`);
    emitWord(encJ(0x6f, rd, off));
  }
  function encodeFence(o) {
    const bits = (s) => { let b = 0; for (const c of s.trim()) b |= { i: 8, o: 4, r: 2, w: 1 }[c] ?? 0; return b; };
    return (((bits(o[0]) << 4 | bits(o[1] ?? 'iorw')) << 20) | 0x0f) >>> 0;
  }
}

const ALL_MNEMONICS = [...Object.keys(INSNS), ...Object.keys(AMO), 'li', 'la', 'lla', 'call', 'tail', 'mv', 'not', 'neg', 'seqz', 'snez',
  'sltz', 'sgtz', 'j', 'jr', 'ret', 'nop', 'csrr', 'csrw', 'csrs', 'csrc', 'csrwi', 'csrsi', 'csrci', 'fence',
  ...Object.keys(BRANCH_PSEUDO), 'rdcycle', 'rdtime', 'rdinstret', 'zext.b'];
function closeMnemonic(op) {
  let best = null, bd = 3;
  for (const m of ALL_MNEMONICS) {
    const d = lev(op, m);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}
function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
