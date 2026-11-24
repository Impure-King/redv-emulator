// RED-V Board Emulator — UI.
import { assemble } from './asm.js';
import { Board, PINS, LED_MASK, SEG_MASK, GPIO_REGS, CAUSES, IRQ_NAMES, PLIC_BASE } from './board.js';
import { ABI, disasm } from './isa.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const hex8 = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
const hex = (v) => '0x' + (v >>> 0).toString(16);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isAsm = (n) => /\.(S|s|asm)$/.test(n);
const SEG_DIGITS = { 0x03f: '0', 0x006: '1', 0x21b: '2', 0x20f: '3', 0x226: '4', 0x22d: '5', 0x23d: '6', 0x007: '7',
  0x23f: '8', 0x22f: '9', 0x237: 'A', 0x23c: 'b', 0x039: 'C', 0x21e: 'd', 0x239: 'E', 0x231: 'F' };
const ledValue = (pins) => { let n = 0; PINS.leds.forEach((p, i) => { if ((pins >>> p) & 1) n |= 1 << i; }); return n; };
const segDigit = (pins) => SEG_DIGITS[pins & SEG_MASK] ?? ((pins & SEG_MASK) ? '?' : '');

// ------------------------------------------------------------------ persistent state
const store = {
  get(k, d) { try { const v = localStorage.getItem('redv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('redv.' + k, JSON.stringify(v)); } catch { /* quota */ } },
};
const DEFAULT_SETTINGS = { hz: 16000000, timing: 'e31', randomizeRegs: true, s2Bounce: true, breakExc: true, iofResetMask: 0x0003023c, ledColor: 'red' };
const S = {
  files: store.get('files', null),
  order: store.get('order', null),
  active: store.get('active', null),
  main: store.get('main', null),
  bps: store.get('bps', {}),
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  speed: store.get('speed', '1'),
  running: false,
  prog: null,          // program loaded on the board
  loadedSig: null,
  build: null,         // latest build (may have errors)
  regSnap: null,
  memSnap: null,
  resumePc: undefined,
  tempBp: null,
  console: [],
  unseen: 0,
  rate: { sim: 0, real: 0, shown: '' },
  disp: new Float32Array(32),
  lastPanel: 0,
  panelDirty: true,
  activeTab: 'regs',
};

const board = new Board(boardOpts());
function boardOpts() {
  const s = S.settings;
  return { hz: +s.hz, timing: s.timing, randomizeRegs: !!s.randomizeRegs, s2Bounce: !!s.s2Bounce, iofResetMask: s.iofResetMask >>> 0 };
}

// ------------------------------------------------------------------ editor
{
  const common = [
    { regex: /\/\*/, token: 'comment', next: 'comment' },
    { regex: /\/\/.*/, token: 'comment' },
    { regex: /#.*/, token: 'comment' },
    { regex: /"(?:[^\\"]|\\.)*"?/, token: 'string' },
    { regex: /'(?:[^\\']|\\.)'/, token: 'string' },
    { regex: /\.[A-Za-z_][\w.]*/, token: 'builtin' },
    { regex: /%(?:hi|lo|pcrel_hi|pcrel_lo)\b/, token: 'atom' },
    { regex: /\b(?:x(?:[12]?\d|3[01])|zero|ra|sp|gp|tp|fp|t[0-6]|s(?:1[01]|\d)|a[0-7])\b/, token: 'variable-2' },
    { regex: /\b(?:mstatus|mie|mip|mtvec|mepc|mcause|mtval|mscratch|mhartid|misa|mcycleh?|minstreth?|cycleh?|instreth?|timeh?)\b/, token: 'atom' },
    { regex: /0[xX][0-9a-fA-F]+\b|0[bB][01]+\b|\d+[bf]?\b/, token: 'number' },
    { regex: /[-+*/%&|^~<>!=()]+/, token: 'operator' },
    { regex: /[A-Za-z_.$][\w.$]*/, token: 'variable' },
  ];
  const sol = [
    { regex: /\s*#\s*(?:include|define|undef|ifdef|ifndef|if|elif|else|endif|error|warning|pragma)\b.*/, token: 'meta', sol: true },
    { regex: /\s*(?:[A-Za-z_.$][\w.$]*|\d+):/, token: 'def', sol: true, next: 'afterLabel' },
    { regex: /\s*\.[A-Za-z_][\w.]*/, token: 'builtin', sol: true, next: 'args' },
    { regex: /\s*[A-Za-z][\w.]*/, token: 'keyword', sol: true, next: 'args' },
  ];
  CodeMirror.defineSimpleMode('rvasm', {
    start: [...sol, ...common],
    afterLabel: [...sol, { regex: /\s*\.[A-Za-z_][\w.]*/, token: 'builtin', next: 'args' }, { regex: /\s*(?:[A-Za-z_.$][\w.$]*|\d+):/, token: 'def' }, { regex: /\s*[A-Za-z][\w.]*/, token: 'keyword', next: 'args' }, ...common],
    args: [...sol, ...common],
    comment: [{ regex: /.*?\*\//, token: 'comment', next: 'start' }, { regex: /.*/, token: 'comment' }],
    meta: { lineComment: '#' },
  });
}

const editor = CodeMirror($('#editorWrap'), {
  mode: 'rvasm', lineNumbers: true, styleActiveLine: true, indentUnit: 4, tabSize: 8, indentWithTabs: false,
  gutters: ['bp-gutter', 'CodeMirror-linenumbers', 'diag-gutter'], extraKeys: {
    Tab: (cm) => cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end'),
    'Shift-Tab': (cm) => cm.indentSelection('subtract'),
    'Ctrl-Enter': () => cmdRun(), 'Cmd-Enter': () => cmdRun(),
  },
});
const docs = new Map();

function defaultFiles() { return { 'led-chaser.S': '' }; }
async function initFiles() {
  if (!S.files || !Object.keys(S.files).length) {
    S.files = {};
    try { S.files['led-chaser.S'] = await (await fetch('examples/led-chaser.S')).text(); }
    catch { S.files = defaultFiles(); }
    S.order = Object.keys(S.files);
    S.active = 'led-chaser.S';
    S.firstVisit = true;
  }
  S.order = (S.order || Object.keys(S.files)).filter((n) => n in S.files);
  for (const n of Object.keys(S.files)) if (!S.order.includes(n)) S.order.push(n);
  for (const n of S.order) makeDoc(n);
  if (!S.active || !(S.active in S.files)) S.active = S.order[0];
  switchFile(S.active);
  saveFiles();
}
function makeDoc(name) {
  const d = CodeMirror.Doc(S.files[name] ?? '', 'rvasm');
  docs.set(name, d);
  for (const ln of S.bps[name] || []) {
    if (ln < d.lineCount()) setBpMarker(d, ln, true);
  }
  return d;
}
function switchFile(name) {
  if (!docs.has(name)) return;
  S.active = name;
  editor.swapDoc(docs.get(name));
  store.set('active', name);
  renderTabs();
  markDiagnostics();
  markPcLine();
}
function saveFiles() {
  for (const [n, d] of docs) S.files[n] = d.getValue();
  store.set('files', S.files);
  store.set('order', S.order);
  saveBps();
}
function renderTabs() {
  const el = $('#fileTabs');
  el.innerHTML = '';
  const main = mainFile();
  for (const n of S.order) {
    const b = document.createElement('button');
    b.className = 'tab' + (n === S.active ? ' active' : '');
    b.innerHTML = `${n === main ? '<span class="main-mark" title="This file is built and run">●</span>' : ''}<span>${esc(n)}</span><span class="x" title="Close">✕</span>`;
    b.onclick = (e) => { if (e.target.classList.contains('x')) closeFile(n); else switchFile(n); };
    el.appendChild(b);
  }
  const plus = document.createElement('button');
  plus.className = 'tab'; plus.textContent = '+'; plus.title = 'New file';
  plus.onclick = cmdNew;
  el.appendChild(plus);
}
function mainFile() {
  if (isAsm(S.active)) return S.active;
  if (S.main && S.main in S.files && isAsm(S.main)) return S.main;
  return S.order.find(isAsm) ?? S.active;
}
function addFile(name, text, activate = true) {
  if (name in S.files) {
    docs.get(name).setValue(text);
  } else {
    S.files[name] = text; S.order.push(name); makeDoc(name);
  }
  if (activate) switchFile(name);
  saveFiles(); renderTabs(); scheduleCheck();
}
function closeFile(name) {
  const text = docs.get(name).getValue();
  if (text.trim() && !confirm(`Close ${name}? Its text is removed from this browser (download it first if you need it).`)) return;
  delete S.files[name]; docs.delete(name); S.order = S.order.filter((n) => n !== name);
  delete S.bps[name];
  if (!S.order.length) { S.files['untitled.S'] = ''; S.order = ['untitled.S']; makeDoc('untitled.S'); }
  if (S.active === name) switchFile(S.order[0]);
  saveFiles(); renderTabs(); scheduleCheck();
}
function cmdNew() {
  let name = prompt('New file name (e.g. Lab_4.S or Lab_4.h):', 'Lab_4.S');
  if (!name) return;
  name = name.trim();
  if (name in S.files) { switchFile(name); return; }
  addFile(name, '');
}
function cmdDownload() {
  const blob = new Blob([docs.get(S.active).getValue()], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = S.active; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function openFiles(list) {
  let first = null;
  for (const f of list) {
    if (f.size > 2_000_000) { toast(`${f.name} is too large`); continue; }
    const text = await f.text();
    addFile(f.name, text, false);
    if (!first || isAsm(f.name)) first = isAsm(f.name) ? f.name : first ?? f.name;
  }
  if (first) { switchFile(first); if (isAsm(first)) { S.main = first; store.set('main', first); } }
  toast(`Opened ${[...list].map((f) => f.name).join(', ')}`);
  logMsg('ok', `Opened ${[...list].map((f) => f.name).join(', ')}. Press <b>Run</b> to build and start it.`);
}

// breakpoints (gutter markers move with edits)
function bpEl() { const e = document.createElement('div'); e.className = 'bp-marker'; e.textContent = '●'; return e; }
function setBpMarker(doc, line, on) { doc.setGutterMarker(line, 'bp-gutter', on ? bpEl() : null); }
function toggleBp(doc, line) {
  const info = doc.lineInfo(line);
  setBpMarker(doc, line, !(info && info.gutterMarkers && info.gutterMarkers['bp-gutter']));
  saveBps(); applyBreakpoints(); S.panelDirty = true;
}
function bpLines(doc) {
  const out = [];
  doc.eachLine((h) => { if (h.gutterMarkers && h.gutterMarkers['bp-gutter']) out.push(doc.getLineNumber(h)); });
  return out;
}
function saveBps() { for (const [n, d] of docs) S.bps[n] = bpLines(d); store.set('bps', S.bps); }
function applyBreakpoints() {
  board.breakpoints.clear();
  const p = S.prog;
  if (!p) return;
  for (const [n, d] of docs) {
    for (const ln of bpLines(d)) {
      for (let k = ln + 1; k < ln + 40; k++) {   // snap to the next line with code
        const a = p.lineToAddr.get(n + ':' + k);
        if (a !== undefined) { board.breakpoints.add(a); break; }
      }
    }
  }
  if (S.tempBp != null) board.breakpoints.add(S.tempBp);
}
editor.on('gutterClick', (cm, line, gutter) => { if (gutter !== 'diag-gutter') toggleBp(cm.getDoc(), line); });

// ------------------------------------------------------------------ build & diagnostics
function sourcesSig() { return JSON.stringify([mainFile(), S.order.map((n) => [n, docs.get(n).getValue()])]); }
function filesObj() { const o = {}; for (const n of S.order) o[n] = docs.get(n).getValue(); return o; }
function doBuild() {
  const main = mainFile();
  const t0 = performance.now();
  let r;
  try { r = assemble(filesObj(), main); }
  catch (e) { r = { ok: false, errors: [{ file: main, line: 1, msg: 'internal error: ' + e.message, hint: 'Please report this.' }], warnings: [] }; console.error(e); }
  r.ms = performance.now() - t0;
  r.sig = sourcesSig();
  r.main = main;
  S.build = r;
  renderProblems();
  markDiagnostics();
  const bi = $('#buildInfo');
  if (r.ok) bi.innerHTML = `<span class="sev-info">✓</span> ${esc(main)} · ${r.image.text.length} B code${r.image.rodata.length ? `, ${r.image.rodata.length} B rodata` : ''}${r.image.data.length ? `, ${r.image.data.length} B data` : ''}`;
  else bi.innerHTML = `<span class="sev-error">✕ ${r.errors.length} error${r.errors.length > 1 ? 's' : ''}</span>`;
  updateBanner();
  return r;
}
let checkTimer = null;
function scheduleCheck() { clearTimeout(checkTimer); checkTimer = setTimeout(() => { doBuild(); }, 350); }
editor.on('changes', () => { saveFiles(); scheduleCheck(); });

function renderProblems() {
  const r = S.build, el = $('#problems');
  const items = [...(r?.errors || []).map((e) => ({ ...e, sev: 'error' })), ...(r?.warnings || []).map((e) => ({ ...e, sev: 'warn' }))];
  if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = items.map((p, i) => `<div class="problem" data-i="${i}"><span class="sev-${p.sev}">${p.sev === 'error' ? '✕' : '⚠'}</span><span class="loc">${esc(p.file)}:${p.line}</span><span>${esc(p.msg)}</span>${p.hint ? `<span class="hint">${esc(p.hint)}</span>` : ''}</div>`).join('');
  $$('.problem', el).forEach((d) => { d.onclick = () => { const p = items[+d.dataset.i]; gotoLine(p.file, p.line); }; });
}
let diagLines = [];
function markDiagnostics() {
  for (const { doc, h } of diagLines) { doc.removeLineClass(h, 'background', 'cm-err-line'); doc.setGutterMarker(h, 'diag-gutter', null); }
  diagLines = [];
  const r = S.build;
  if (!r) return;
  const add = (p, sev) => {
    const doc = docs.get(p.file);
    if (!doc || p.line < 1 || p.line > doc.lineCount()) return;
    const h = doc.getLineHandle(p.line - 1);
    const m = document.createElement('div');
    m.className = sev === 'error' ? 'err-marker' : 'warn-marker';
    m.textContent = sev === 'error' ? '✕' : '⚠';
    m.title = p.msg + (p.hint ? '\n' + p.hint : '');
    doc.setGutterMarker(h, 'diag-gutter', m);
    if (sev === 'error') doc.addLineClass(h, 'background', 'cm-err-line');
    diagLines.push({ doc, h });
  };
  (r.warnings || []).forEach((w) => add(w, 'warn'));
  (r.errors || []).forEach((e) => add(e, 'error'));
}
function gotoLine(file, line) {
  if (file !== S.active && docs.has(file)) switchFile(file);
  editor.setCursor({ line: line - 1, ch: 0 });
  editor.scrollIntoView({ line: line - 1, ch: 0 }, 120);
  editor.focus();
}
function updateBanner() {
  const changed = S.prog && S.loadedSig && S.loadedSig !== sourcesSig() && (S.running || board.cycles > 0);
  $('#changedBanner').hidden = !changed;
}

// ------------------------------------------------------------------ program control
function loadBuild(r) {
  S.prog = r;
  S.loadedSig = r.sig;
  board.opts = { ...board.opts, ...boardOpts() };
  board.loadProgram(r);
  S.tempBp = null;
  applyBreakpoints();
  S.regSnap = null; S.memSnap = null;
  S.disp.fill(0);
  buildListing();
  S.panelDirty = true;
  if (r.warnings?.some((w) => /defines _start|\.data/.test(w.msg))) { /* shown in problems */ }
  if (r.image.data.length && r.entryName === '_start') {
    board.hint('data-init', `Your program defines _start and has a .data section. On the real board, the SDK's C startup (crt0) is skipped when you define _start, so .data is NOT copied into RAM (it starts as garbage) and .bss isn't zeroed. The emulator initializes them anyway; on the board, initialize variables in code or keep constants in .rodata.`, 'warn');
  }
  updateBanner();
}
function ensureLoaded(forceRebuild = false) {
  const sig = sourcesSig();
  if (!forceRebuild && S.prog && S.loadedSig === sig) return true;
  const r = doBuild();
  if (!r.ok) {
    setStatus('error', `Build failed: ${r.errors.length} error${r.errors.length > 1 ? 's' : ''} (see below the editor)`);
    const e = r.errors[0]; if (e) gotoLine(e.file, e.line);
    return false;
  }
  loadBuild(r);
  logMsg('ok', `Built <b>${esc(r.main)}</b> and loaded it onto the board (entry: <code>${esc(r.entryName ?? '.text')}</code>, ${r.image.text.length} bytes of code).`);
  return true;
}
function cmdRun() {
  if (S.running) return;
  const changed = !S.prog || S.loadedSig !== sourcesSig();
  if (changed || board.halted) { if (!ensureLoaded(true)) return; if (board.halted) board.reset(); }
  S.running = true;
  S.resumePc = board.pc;
  S.lastFrame = performance.now();
  S.rate = { sim: 0, real: 0, shown: '' };
  setStatus('running', 'Running');
  markPcLine(true);
  updateButtons();
}
function cmdPause(reason, kind = 'paused') {
  if (!S.running && !reason) return;
  S.running = false;
  if (S.tempBp != null) { board.breakpoints.delete(S.tempBp); S.tempBp = null; applyBreakpoints(); }
  const where = board.locOf(board.pc);
  setStatus(kind, reason ?? `Paused at ${where ? `${where.file}:${where.line}` : hex(board.pc)}`);
  afterStop();
}
function afterStop() {
  updateButtons();
  S.panelDirty = true;
  renderPanels(true);
  markPcLine();
  revealPc();
  snapshot();
}
function snapshot() { S.regSnap = Int32Array.from(board.x); }
function cmdStep() {
  if (S.running) { cmdPause(); return; }
  if (!S.prog || S.loadedSig !== sourcesSig() || board.halted) { if (!ensureLoaded(true)) return; if (board.halted) board.reset(); }
  const prev = Int32Array.from(board.x);
  const prevMem = S.memSnap;
  board.step();
  if (board.ebreakHit !== undefined) board.ebreakHit = undefined;
  if (board.pc === board.bootSyms.returned) board.halt('returned', `Your program returned from ${S.prog.entryName}: on the board, the SDK's startup code then spins forever.`);
  S.regSnap = prev; S.memSnap = prevMem;
  if (board.halted) { setStatus('halt', board.halted.msg); }
  else { const w = board.locOf(board.pc); setStatus('paused', `Stepped to ${w ? `${w.file}:${w.line}` : hex(board.pc)}${board.waiting ? ' (wfi: waiting for an interrupt)' : ''}`); }
  updateButtons(); S.panelDirty = true; renderPanels(true, true); markPcLine(); revealPc();
}
function cmdOver() {
  if (S.running) return;
  if (!S.prog || S.loadedSig !== sourcesSig() || board.halted) { cmdStep(); return; }
  let w;
  try { w = board.load(board.pc, 4, false) >>> 0; } catch { cmdStep(); return; }
  const op = w & 0x7f, rd = (w >>> 7) & 31;
  if ((op === 0x6f || op === 0x67) && (rd === 1 || rd === 5)) {
    S.tempBp = (board.pc + 4) >>> 0;
    board.breakpoints.add(S.tempBp);
    cmdRun();
  } else cmdStep();
}
function cmdReset() {
  S.running = false;
  if (!ensureLoaded(true)) { updateButtons(); return; }
  setStatus('idle', 'Reset: ready to run');
  S.console.push({ kind: 'sep' });
  afterStop();
}
function onBreak(kind) {
  const temp = S.tempBp != null && board.pc === S.tempBp;
  const w = board.locOf(board.pc);
  const at = w ? `${w.file}:${w.line}` : hex(board.pc);
  if (kind === 'ebreak') cmdPause(`ebreak at ${board.srcOf(board.lastEbreak)} — paused`);
  else if (kind === 'exception') cmdPause(`Paused on exception: ${CAUSES[board.mcause] ?? 'mcause ' + board.mcause} (handler at ${at})`, 'halt');
  else cmdPause(temp ? `Stepped over to ${at}` : `Breakpoint at ${at}`);
}
function onHalt() {
  S.running = false;
  setStatus('halt', board.halted.msg);
  logMsg('error', esc(board.halted.msg));
  afterStop();
}
function updateButtons() {
  $('#btnRun').disabled = S.running;
  $('#btnPause').disabled = !S.running;
  $('#btnStep').disabled = false;
  $('#btnOver').disabled = S.running;
  $('#btnRun .lbl').textContent = board.cycles > 0 && !board.halted ? 'Continue' : 'Run';
}
function setStatus(kind, text) {
  const el = $('#status');
  el.className = 'status ' + kind;
  $('#statusText').textContent = text;
  el.title = text;
}

// ------------------------------------------------------------------ main loop
// rAF drives the loop; a timer keeps it going where rAF is throttled (hidden panes, some embedded browsers).
let lastTick = 0;
function rafLoop(now) { tick(performance.now()); requestAnimationFrame(rafLoop); void now; }
setInterval(() => { if (performance.now() - lastTick > 120) tick(performance.now()); }, 40);
function tick(now) {
  lastTick = now;
  const dtReal = Math.min(0.1, Math.max(0, (now - (S.lastFrame ?? now)) / 1000));
  S.lastFrame = now;
  if (S.running) {
    const hz = board.opts.hz;
    const speed = S.speed === 'max' ? Infinity : +S.speed;
    const start = board.cycles;
    const target = speed === Infinity ? Infinity : board.cycles + dtReal * hz * speed;
    const deadline = performance.now() + (speed === Infinity ? 14 : 11);
    let reason = 'limit';
    while (board.cycles < target) {
      const chunkEnd = Math.min(target, board.cycles + 50000);
      reason = board.run(chunkEnd, { skipBreakpointAt: S.resumePc });
      S.resumePc = undefined;
      if (reason !== 'limit') break;
      if (performance.now() > deadline) break;
    }
    S.rate.sim += (board.cycles - start) / hz; S.rate.real += dtReal;
    if (S.rate.real > 0.5) {
      const x = S.rate.sim / S.rate.real;
      S.rate.shown = x > 0.97 && x < 1.03 && speed === 1 ? 'real time' : `${x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2)}× real time`;
      S.rate.sim = 0; S.rate.real = 0;
    }
    board.checkStuck();
    if (reason === 'break' || reason === 'ebreak' || reason === 'exception') onBreak(reason);
    else if (reason === 'halt') onHalt();
    S.panelDirty = true;
  }
  drawBoard();
  $('#simTime').textContent = fmtTime(board.simTime);
  $('#simRate').textContent = S.running ? S.rate.shown : `${board.cycles.toLocaleString()} cycles`;
  if (S.panelDirty && (now - S.lastPanel > (S.running ? 150 : 0))) { renderPanels(); S.lastPanel = now; }
}
function fmtTime(t) {
  const s = t.toFixed(6);
  const [a, b] = s.split('.');
  return `${a}.${b.slice(0, 3)} ${b.slice(3)} s`;
}

// ------------------------------------------------------------------ board drawing
// Traced from the lab manual's photos: Figure 0.2 (the ECE "RISC-V Shield" daughter board) and
// Figure 0.1 (SparkFun RED-V Thing Plus). Shield coordinates are the photo's pixels (808 × 672,
// about 273 per inch); the Thing Plus (2.3" × 0.9") is drawn at the same scale beside it.
const SVGNS = 'http://www.w3.org/2000/svg';
const boardEls = { leds: [], segs: {}, caps: {} };
const LIT_COLORS = {
  red: { core: '#ff2d14', hot: '#ffe1d4', glow: '#ff2a0e' },
  green: { core: '#2ee36a', hot: '#e6ffee', glow: '#1eff62' },
  yellow: { core: '#ffcf1f', hot: '#fff9de', glow: '#ffc400' },
  orange: { core: '#ff7d1a', hot: '#ffeedc', glow: '#ff6a00' },
  blue: { core: '#2f86ff', hot: '#e2eeff', glow: '#2b78ff' },
};
const SILK = '#ecebe6', FONT = 'Arial, Helvetica, sans-serif', HOLE = '#10161d';
function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function silk(parent, x, y, text, size, attrs = {}) {
  const t = svg('text', { x, y, fill: SILK, 'font-size': size, 'font-family': FONT, 'font-weight': 700, ...attrs }, parent);
  t.textContent = text;
  return t;
}
function tip(el, text) { svg('title', {}, el).textContent = text; return el; }
function holdButton(grp, name) {
  const down = (e) => { e.preventDefault(); grp.setPointerCapture?.(e.pointerId); pressBtn(name, true); };
  const up = () => pressBtn(name, false);
  grp.addEventListener('pointerdown', down);
  grp.addEventListener('pointerup', up);
  grp.addEventListener('pointercancel', up);
  grp.addEventListener('lostpointercapture', up);
}
function buildBoard() {
  const lit = LIT_COLORS[S.settings.ledColor] ?? LIT_COLORS.red;
  const root = $('#board');
  boardEls.leds = []; boardEls.segs = {}; boardEls.caps = {};
  root.innerHTML = `
  <defs>
    <linearGradient id="pcbBlack" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1e20"/><stop offset="1" stop-color="#0f0f10"/></linearGradient>
    <linearGradient id="pcbRed" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e4343b"/><stop offset="1" stop-color="#c21e25"/></linearGradient>
    <radialGradient id="litBar" cx="50%" cy="50%" r="65%"><stop offset="0" stop-color="${lit.hot}"/><stop offset=".45" stop-color="${lit.core}"/><stop offset="1" stop-color="${lit.core}"/></radialGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f4f4"/><stop offset=".55" stop-color="#c6c6c6"/><stop offset="1" stop-color="#8f8f8f"/></linearGradient>
    <radialGradient id="capTop" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#4c4c4f"/><stop offset="1" stop-color="#111113"/></radialGradient>
    <radialGradient id="padG" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#f6f6f6"/><stop offset="1" stop-color="#a6a6a6"/></radialGradient>
    <filter id="glowL" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="glowS" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="shadow" x="-10%" y="-10%" width="130%" height="130%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity=".55"/></filter>
  </defs>`;
  buildShield(root, lit);
  buildThingPlus(root);
}
function buildShield(root, lit) {
  const g = svg('g', {}, root);
  svg('rect', { x: 0, y: 0, width: 808, height: 672, rx: 10, fill: 'url(#pcbBlack)', stroke: '#2c2c2f', 'stroke-width': 2, filter: 'url(#shadow)' }, g);
  for (const [cx, cy] of [[40, 160], [42, 513], [770, 166], [775, 512]]) svg('circle', { cx, cy, r: 15, fill: HOLE, stroke: '#2a2a2c', 'stroke-width': 2 }, g);
  silk(g, 538, 50, 'ELECTRICAL &', 25, { 'font-weight': 400, 'letter-spacing': 1 });
  silk(g, 538, 87, 'COMPUTER', 25, { 'font-weight': 400, 'letter-spacing': 1 });
  silk(g, 538, 125, 'ENGINEERING', 25, { 'font-weight': 400, 'letter-spacing': 1 });
  silk(g, 538, 168, 'RISC-V SHIELD', 22, { 'font-weight': 400, 'letter-spacing': .5 });
  silk(g, 418, 650, 'UNIVERSITY OF WATERLOO', 27, { 'font-weight': 400, 'text-anchor': 'middle', 'letter-spacing': 1.5 });
  silk(g, 62, 233, 'PBSW:', 14, { 'text-anchor': 'middle' });
  silk(g, 19, 253, 'S1_GPIO_12', 14);
  silk(g, 19, 271, 'S2_GPIO_13', 14);
  silk(g, 64, 311, 'DIGIT1:', 14, { 'text-anchor': 'middle' });
  ['SEGA-GPIO_0', 'SEGB-GPIO_1', 'SEGC-GPIO_2', 'SEGD-GPIO_3', 'SEGE-GPIO_4', 'SEGF-GPIO_5', 'SEGG-GPIO_9']
    .forEach((t, i) => silk(g, 17, 331 + i * 18.3, t, 14));

  // through-hole pads: the two resistor networks (RP8_1, RP8_2) and the J7/J6 headers
  const pad = (cx, cy, square) => {
    if (square) svg('rect', { x: cx - 8.5, y: cy - 8.5, width: 17, height: 17, rx: 1.5, fill: 'url(#padG)' }, g);
    else svg('circle', { cx, cy, r: 8.5, fill: 'url(#padG)' }, g);
  };
  for (const y0 of [132, 398]) for (let k = 0; k < 8; k++) for (const x of [322, 405]) {
    const cy = y0 + k * 27.3;
    pad(x, cy, x === 405 && k === 0);
    svg('circle', { cx: x, cy, r: 3, fill: '#8a8a8a' }, g);
  }
  const header = (x, y0, n, label, lx, ly) => {
    const hg = tip(svg('g', {}, g), `${label}: ${n}-pin header. J7 and J6 match the 16- and 12-pin rows of the RED-V Thing Plus.`);
    svg('rect', { x: x - 14, y: y0 - 14, width: 28, height: (n - 1) * 27.3 + 28, fill: 'none', stroke: SILK, 'stroke-width': 2.5 }, hg);
    for (let k = 0; k < n; k++) {
      const cy = y0 + k * 27.3;
      if (k === 0) svg('rect', { x: x - 8.5, y: cy - 8.5, width: 17, height: 17, rx: 1.5, fill: 'url(#padG)' }, hg);
      else svg('circle', { cx: x, cy, r: 8.5, fill: 'url(#padG)' }, hg);
      svg('rect', { x: x - 3.5, y: cy - 3.5, width: 7, height: 7, fill: '#e4e4e4', stroke: '#777', 'stroke-width': 1 }, hg);
    }
    silk(g, lx, ly, label, 18, { 'font-weight': 400, 'text-anchor': 'middle', transform: `rotate(90 ${lx} ${ly})` });
  };
  header(488, 90, 16, 'J7', 528, 300);
  header(713, 199, 12, 'J6', 755, 350);

  // LED bar: two 4-segment bar graphs, GPIO 23 … 20 and 19, 18, 11, 10 (LED7 on the left, LED0 on the right)
  const bars = [{ x: 12, pins: [23, 22, 21, 20] }, { x: 248, pins: [19, 18, 11, 10] }];
  for (const bar of bars) {
    svg('rect', { x: bar.x, y: 22, width: 222, height: 68, rx: 2, fill: '#cbc9c2' }, g);
    svg('rect', { x: bar.x, y: 22, width: 222, height: 58, rx: 2, fill: '#f1f0eb' }, g);
    for (let k = 1; k < 4; k++) svg('line', { x1: bar.x + k * 55.5, y1: 25, x2: bar.x + k * 55.5, y2: 77, stroke: '#e0ded7', 'stroke-width': 1.5 }, g);
    bar.pins.forEach((pin, k) => silk(g, bar.x + k * 55.5 + 27.75, 102, String(pin), 15, { 'font-weight': 400, 'text-anchor': 'middle' }));
  }
  silk(g, 242, 119, 'GPIO', 15, { 'font-weight': 400, 'text-anchor': 'middle' });
  for (const bar of bars) bar.pins.forEach((pin, k) => {
    const ledIdx = PINS.leds.indexOf(pin), sx = bar.x + k * 55.5;
    const grp = tip(svg('g', {}, g), `LED${ledIdx} · GPIO ${pin} · bit mask 0x${(1 << pin >>> 0).toString(16).padStart(8, '0')}`);
    const glow = svg('rect', { x: sx + 2, y: 24, width: 51.5, height: 54, rx: 6, fill: lit.glow, filter: 'url(#glowL)', opacity: 0 }, grp);
    const on = svg('rect', { x: sx + 5, y: 27, width: 45.5, height: 48, rx: 3, fill: 'url(#litBar)', opacity: 0 }, grp);
    svg('rect', { x: sx, y: 22, width: 55.5, height: 68, fill: 'transparent' }, grp);
    boardEls.leds[ledIdx] = { on, glow };
  });

  // push buttons: S2 above S1, as on the board
  for (const [name, cy, lx] of [['S2', 168, 127], ['S1', 283, 123]]) {
    const pin = PINS[name];
    silk(g, lx, cy + 7, name, 20, { 'font-weight': 400 });
    const grp = svg('g', { class: 'btn-cap', 'data-btn': name, transform: `translate(183,${cy})` }, g);
    tip(grp, `${name} · GPIO ${pin} · active low · ${name === 'S2' ? 'not debounced' : 'debounced'} · hold key ${name[1]} or click and hold`);
    for (const [dx, dy] of [[-24, -37], [24, -37], [-24, 37], [24, 37]]) svg('rect', { x: dx - 6, y: dy - 5, width: 12, height: 10, rx: 1.5, fill: 'url(#metal)' }, grp);
    svg('rect', { x: -29, y: -30, width: 58, height: 60, rx: 3, fill: '#6c382e', stroke: '#45221c', 'stroke-width': 1.5 }, grp);
    svg('rect', { x: -24, y: -24, width: 48, height: 48, rx: 4, fill: '#86493c' }, grp);
    for (const [dx, dy] of [[-18, -18], [18, -18], [-18, 18], [18, 18]]) svg('circle', { cx: dx, cy: dy, r: 2.6, fill: '#4a271f' }, grp);
    boardEls.caps[name] = svg('circle', { cx: 0, cy: 0, r: 17, fill: 'url(#capTop)', stroke: '#050505', 'stroke-width': 2, class: 'cap-top' }, grp);
    holdButton(grp, name);
  }

  // R1, C1 and U1 (small surface-mount parts between the buttons and the pads)
  svg('rect', { x: 262, y: 152, width: 12, height: 30, rx: 1.5, fill: '#1c1c1c' }, g);
  for (const y of [152, 172]) svg('rect', { x: 262, y, width: 12, height: 10, rx: 1, fill: 'url(#metal)' }, g);
  silk(g, 281, 173, 'R1', 17, { 'font-weight': 400 });
  silk(g, 236, 226, 'C1', 17, { 'font-weight': 400 });
  svg('rect', { x: 241, y: 232, width: 28, height: 11, rx: 1.5, fill: '#8a6c4c' }, g);
  for (const x of [241, 260]) svg('rect', { x, y: 232, width: 9, height: 11, rx: 1, fill: 'url(#metal)' }, g);
  svg('rect', { x: 245, y: 265, width: 24, height: 38, fill: 'none', stroke: SILK, 'stroke-width': 2 }, g);
  svg('rect', { x: 251, y: 271, width: 12, height: 26, rx: 1, fill: '#1e1e1e' }, g);
  for (const [x, y] of [[247, 276], [247, 288], [263, 276], [263, 288]]) svg('rect', { x, y, width: 5, height: 5, fill: 'url(#metal)' }, g);
  silk(g, 291, 284, 'U1', 17, { 'font-weight': 400, 'text-anchor': 'middle', transform: 'rotate(90 291 284)' });

  // DIGIT1: one common-cathode seven-segment digit; the decimal point isn't wired to a GPIO
  const dg = svg('g', { transform: 'translate(143,428)' }, g);
  svg('rect', { x: 0, y: 0, width: 90, height: 150, rx: 2, fill: '#29292b', stroke: '#3a3a3d', 'stroke-width': 2 }, dg);
  svg('rect', { x: 5, y: 5, width: 80, height: 140, rx: 1, fill: '#313134' }, dg);
  const H = (y) => `M27 ${y} L32 ${y - 5} L60 ${y - 5} L65 ${y} L60 ${y + 5} L32 ${y + 5} Z`;
  const V = (x, y1, y2) => `M${x} ${y1} L${x + 5} ${y1 + 5} L${x + 5} ${y2 - 5} L${x} ${y2} L${x - 5} ${y2 - 5} L${x - 5} ${y1 + 5} Z`;
  const segPaths = { a: H(22), b: V(67, 24, 73), c: V(67, 77, 126), d: H(128), e: V(25, 77, 126), f: V(25, 24, 73), g: H(75) };
  const sk = svg('g', { transform: 'translate(14 0) skewX(-8)' }, dg);
  for (const [s, d] of Object.entries(segPaths)) {
    const grp = tip(svg('g', {}, sk), `segment ${s} · GPIO ${PINS.seg[s]}`);
    svg('path', { d, fill: '#cfcfca' }, grp);
    const glow = svg('path', { d, fill: lit.glow, filter: 'url(#glowS)', opacity: 0 }, grp);
    const on = svg('path', { d, fill: lit.core, opacity: 0 }, grp);
    boardEls.segs[s] = { on, glow };
  }
  svg('circle', { cx: 77, cy: 128, r: 5, fill: '#cfcfca' }, dg);
  silk(g, 146, 597, 'DIGIT1', 16, { 'font-weight': 400 });
}
function buildThingPlus(root) {
  // Drawn as in the photo (628 × 246, USB-C on the left), then turned so USB-C points up and the
  // 12-pin row is on the right, matching J7 (16 pins) on the left and J6 (12 pins) on the right.
  svg('rect', { x: 840, y: 22, width: 246, height: 628, rx: 8, fill: '#000', filter: 'url(#shadow)' }, root);
  const g = svg('g', { transform: 'translate(1086 22) rotate(90)' }, root);
  tip(g, 'SparkFun RED-V Thing Plus: the SiFive FE310-G002 runs your program; the NXP MK22FN128 handles USB and debugging.');
  svg('rect', { x: 0, y: 0, width: 628, height: 246, rx: 8, fill: 'url(#pcbRed)', stroke: '#9c151b', 'stroke-width': 2 }, g);
  const white = (x, y, text, size, attrs = {}) => {
    const t = svg('text', { x, y, fill: '#fff', 'font-size': size, 'font-family': FONT, 'font-weight': 700, ...attrs }, g);
    t.textContent = text;
    return t;
  };
  const tpad = (x, y) => {
    svg('rect', { x: x - 10, y: y - 10, width: 20, height: 20, rx: 2, fill: '#e5e5e1' }, g);
    svg('circle', { cx: x, cy: y, r: 5.5, fill: HOLE }, g);
  };
  ['VBAT', 'EN', 'VUSB', 'NC', '11', '10', '9', '2', '1', '0', 'SCL', 'SDA'].forEach((t, k) => {
    const x = 281 + k * 27.3;
    tpad(x, 16);
    white(x, 42, t, 9.5, { 'text-anchor': 'middle' });
  });
  for (let k = 0; k < 16; k++) tpad(581.3 - (15 - k) * 27.3, 230);
  for (const [cx, cy, r] of [[604, 18, 6], [74, 186, 4]]) svg('circle', { cx, cy, r, fill: HOLE }, g);

  // USB-C receptacle (overhangs the edge), Qwiic and battery connectors
  svg('rect', { x: -14, y: 84, width: 86, height: 78, rx: 10, fill: 'url(#metal)', stroke: '#7c7c7c', 'stroke-width': 1.5 }, g);
  svg('rect', { x: -14, y: 94, width: 16, height: 58, rx: 7, fill: '#5a5a5a' }, g);
  for (const y of [100, 146]) svg('line', { x1: 8, y1: y, x2: 66, y2: y, stroke: '#9d9d9d', 'stroke-width': 1.5 }, g);
  svg('rect', { x: 88, y: 6, width: 70, height: 52, rx: 3, fill: '#29292b' }, g);
  svg('rect', { x: 95, y: 12, width: 56, height: 26, rx: 2, fill: '#3b3b3e' }, g);
  for (let k = 0; k < 4; k++) svg('rect', { x: 103 + k * 12, y: 44, width: 5, height: 14, fill: '#cfcfcf' }, g);
  svg('rect', { x: 94, y: 68, width: 54, height: 17, rx: 8.5, fill: '#f6f6f6' }, g);
  svg('text', { x: 121, y: 81, 'text-anchor': 'middle', fill: '#d4232a', 'font-size': 12, 'font-family': FONT, 'font-weight': 700 }, g).textContent = 'Qwiic';
  svg('rect', { x: 168, y: 4, width: 82, height: 104, rx: 3, fill: '#38383b' }, g);
  svg('rect', { x: 176, y: 12, width: 66, height: 62, rx: 2, fill: '#4b4b4f' }, g);
  for (const x of [188, 216]) svg('rect', { x, y: 22, width: 14, height: 46, fill: '#2b2b2e' }, g);
  for (const x of [192, 220]) svg('rect', { x, y: 84, width: 6, height: 26, fill: '#d0d0d0' }, g);

  // SparkFun flame, tantalum capacitor, CHG LED and small parts
  svg('path', { d: 'M150 126 C133 122 129 105 139 96 C140 104 146 107 150 103 C146 92 154 86 163 84 C158 93 166 97 171 105 C177 116 167 128 150 126 Z', fill: '#fff', opacity: .92 }, g);
  svg('rect', { x: 88, y: 156, width: 40, height: 18, rx: 2, fill: '#dba445' }, g);
  svg('rect', { x: 88, y: 156, width: 9, height: 18, rx: 1.5, fill: '#9c6a20' }, g);
  svg('rect', { x: 190, y: 181, width: 12, height: 7, rx: 1, fill: '#f2f1ea' }, g);
  white(196, 204, 'CHG', 11, { 'text-anchor': 'middle' });
  const smd = (x, y, w, h, body = '#262626') => {
    svg('rect', { x, y, width: w, height: h, rx: 1, fill: body }, g);
    if (w >= h) for (const ex of [x, x + w - 4]) svg('rect', { x: ex, y, width: 4, height: h, fill: '#cfcfcf' }, g);
    else for (const ey of [y, y + h - 4]) svg('rect', { x, y: ey, width: w, height: 4, fill: '#cfcfcf' }, g);
  };
  for (const [x, y, w, h, c] of [[92, 108, 16, 9], [92, 128, 16, 9], [96, 186, 16, 9, '#b89a6a'], [176, 128, 9, 16], [268, 48, 16, 9, '#b89a6a'],
    [270, 186, 9, 16], [284, 62, 16, 9], [430, 52, 16, 9], [530, 58, 9, 16], [565, 58, 9, 16], [470, 160, 16, 9, '#b89a6a'],
    [500, 176, 16, 9], [530, 186, 16, 9], [430, 200, 16, 9], [606, 120, 9, 16], [606, 150, 9, 16]]) smd(x, y, w, h, c);
  for (const [x, y, w, h] of [[154, 140, 14, 20], [154, 176, 14, 20], [238, 134, 22, 30], [238, 172, 22, 30]]) {
    svg('rect', { x, y, width: w, height: h, rx: 1, fill: '#1f1f21' }, g);
    for (let k = 0; k < 3; k++) for (const ex of [x - 3, x + w]) svg('rect', { x: ex, y: y + 3 + k * (h - 8) / 2, width: 3, height: 3, fill: '#cfcfcf' }, g);
  }

  // MK22FN128 (QFP-64), FE310-G002 (QFN-48), the crystal and the QSPI flash
  const chip = (cx, cy, size, pins, pinLen) => {
    const h = size / 2;
    for (let k = 0; k < pins; k++) {
      const t = -h + 8 + k * (size - 16) / (pins - 1);
      svg('rect', { x: cx + t - 1.2, y: cy - h - pinLen, width: 2.4, height: pinLen, fill: '#c9c9c9' }, g);
      svg('rect', { x: cx + t - 1.2, y: cy + h, width: 2.4, height: pinLen, fill: '#c9c9c9' }, g);
      svg('rect', { x: cx - h - pinLen, y: cy + t - 1.2, width: pinLen, height: 2.4, fill: '#c9c9c9' }, g);
      svg('rect', { x: cx + h, y: cy + t - 1.2, width: pinLen, height: 2.4, fill: '#c9c9c9' }, g);
    }
    svg('rect', { x: cx - h, y: cy - h, width: size, height: size, rx: 2, fill: '#2a2a2c' }, g);
  };
  chip(362, 131, 104, 16, 8);
  ['MK22FN128', 'VLH10', '0N74X', 'CTAK1921P'].forEach((t, i) => {
    const x = 384 - i * 12, y = 96;
    svg('text', { x, y, fill: '#8e8e8e', 'font-size': 9, 'font-family': FONT, transform: `rotate(90 ${x} ${y})` }, g).textContent = t;
  });
  chip(484, 112, 60, 12, 3);
  svg('polygon', { points: '484,98 497,107 492,122 476,122 471,107', fill: 'none', stroke: '#8a8a8a', 'stroke-width': 2 }, g);
  svg('text', { x: 484, y: 92, 'text-anchor': 'middle', fill: '#8e8e8e', 'font-size': 7, 'font-family': FONT }, g).textContent = 'FE310-G002';
  svg('rect', { x: 543, y: 70, width: 16, height: 44, rx: 3, fill: 'url(#metal)' }, g);
  svg('rect', { x: 558, y: 128, width: 36, height: 46, rx: 1.5, fill: '#222224' }, g);
  for (let k = 0; k < 4; k++) for (const ex of [553, 594]) svg('rect', { x: ex, y: 132 + k * 11, width: 5, height: 4, fill: '#cfcfcf' }, g);

  // WAKE and RESET buttons (RESET resets the emulated board)
  const tact = (cx, cy, label, title, onClick) => {
    const b = tip(svg('g', { class: onClick ? 'btn-cap tp-btn' : '', transform: `translate(${cx} ${cy})` }, g), title);
    svg('rect', { x: -20, y: -15, width: 40, height: 30, rx: 2, fill: 'url(#metal)' }, b);
    svg('rect', { x: -12, y: -9, width: 24, height: 18, rx: 4, fill: '#262628', class: 'cap-top' }, b);
    if (onClick) b.addEventListener('click', onClick);
    const lx = 76, ly = cy;
    white(lx, ly, label, 11, { 'text-anchor': 'middle', transform: `rotate(90 ${lx} ${ly})` });
  };
  tact(41, 31, 'WAKE', 'WAKE (always-on wake-up button): not modelled', null);
  tact(41, 218, 'RESET', 'RESET: rebuild and reset the board (same as ⟲ Reset)', () => cmdReset());
}
function pressBtn(name, down) {
  board.setButton(name, down);
  boardEls.caps[name].setAttribute('fill', down ? '#070708' : 'url(#capTop)');
  boardEls.caps[name].setAttribute('r', down ? 15.5 : 17);
  S.panelDirty = true;
  if (!S.running && S.prog && board.cycles > 0) renderPanels(true);
}
function drawBoard() {
  let br;
  if (S.running) {
    br = board.sampleBrightness();
    for (let i = 0; i < 32; i++) S.disp[i] = Math.max(br[i], S.disp[i] * 0.55 + br[i] * 0.45);
    br = S.disp;
  } else {
    const lit = board.pinLevels & board.pinDriven;
    br = S.disp;
    for (let i = 0; i < 32; i++) br[i] = (lit >>> i) & 1;
    board.sampleBrightness();
  }
  PINS.leds.forEach((pin, i) => {
    const v = br[pin];
    const e = boardEls.leds[i];
    e.on.setAttribute('opacity', Math.min(1, v * 1.1).toFixed(3));
    e.glow.setAttribute('opacity', (v * 0.85).toFixed(3));
  });
  for (const [s, pin] of Object.entries(PINS.seg)) {
    const v = br[pin], e = boardEls.segs[s];
    e.on.setAttribute('opacity', Math.min(1, v * 1.1).toFixed(3));
    e.glow.setAttribute('opacity', (v * 0.8).toFixed(3));
  }
  const lit = board.pinLevels & board.pinDriven;
  const lv = ledValue(lit), d = segDigit(lit);
  $('#ledValText').textContent = S.prog ? `LED bar 0x${lv.toString(16).padStart(2, '0').toUpperCase()} (${lv.toString(2).padStart(8, '0')})${d ? `  ·  7-seg ${d}` : ''}` : '';
  const trapRecent = S.lastTrapCycle !== undefined && board.cycles - S.lastTrapCycle < board.opts.hz * 0.15;
  $('#indRun').classList.toggle('on', S.running);
  $('#indIsr').classList.toggle('on', board.inIsrSince !== undefined);
  $('#indTrap').classList.toggle('on', trapRecent);
}

// ------------------------------------------------------------------ inspector panels
$$('#inspTabs .tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
function selectTab(name) {
  S.activeTab = name;
  $$('#inspTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.insp-body .panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'console') { S.unseen = 0; updateBadge(); }
  renderPanels(true);
  if (name === 'listing') scrollListingToPc();
}
function renderPanels(force = false, stepped = false) {
  S.panelDirty = false;
  const t = S.activeTab;
  if (t === 'regs') renderRegs(stepped);
  else if (t === 'irq') renderIrq();
  else if (t === 'gpio') renderGpio();
  else if (t === 'mem') renderMem();
  else if (t === 'listing') updateListingPc();
  else if (t === 'console') renderConsole();
  else if (t === 'timeline') renderTimeline();
  void force;
}
function locStr(pc) { const l = board.locOf(pc); return l ? `${l.file}:${l.line}` : (S.prog && pc >= 0x20000000 && pc < 0x20010000 ? 'startup code' : ''); }
function labelAt(addr) {
  if (!S.prog) return '';
  for (const [n, s] of S.prog.symbols) if (s.kind === 'label' && s.v >>> 0 === addr >>> 0 && !n.startsWith('__')) return n;
  return '';
}
function renderRegs() {
  const x = board.x, snap = S.regSnap;
  const pcDis = S.prog ? board.disasmAt(board.pc) : '';
  let h = `<div class="pcrow"><span class="lbl">pc</span><b>${hex8(board.pc)}</b><span class="muted">${esc(locStr(board.pc))}</span><span>${esc(pcDis)}</span></div>`;
  h += '<div class="reggrid">';
  const order = [];
  for (let i = 0; i < 16; i++) order.push(i, i + 16);
  for (const i of order) {
    const v = x[i];
    const chg = snap && snap[i] !== v && !S.running;
    const un = !board.xInit[i] && i !== 0;
    h += `<div class="reg${chg ? ' chg' : ''}${un ? ' uninit' : ''}" title="${un ? 'Not written since reset: on a real board this holds a leftover value' : `${ABI[i]} = ${v} (signed) = ${v >>> 0} (unsigned)`}"><span class="n"><b>${ABI[i]}</b> x${i}</span><span class="h">${hex8(v)}</span><span class="d">${v}</span></div>`;
  }
  h += '</div>';
  h += `<h3>Counters</h3><div class="kv"><span class="k">cycles</span><span class="v">${board.cycles.toLocaleString()}</span><span class="note">at ${(board.opts.hz / 1e6).toFixed(1)} MHz · ${board.opts.timing === 'e31' ? 'E31 pipeline timing' : '1 cycle/instruction'}</span>
  <span class="k">instret</span><span class="v">${board.instret.toLocaleString()}</span><span class="note">${board.instret ? `CPI ${(board.cycles / board.instret).toFixed(3)}` : ''}</span>
  <span class="k">time</span><span class="v">${board.simTime.toFixed(6)} s</span><span class="note">mtime = ${board.mtime()} (32.768 kHz)</span></div>`;
  $('#regsView').innerHTML = h;
}
function bitChips(v, defs) { return `<span class="bits">${defs.map(([b, n, w]) => `<span class="bit${(v >>> b) & 1 ? ' on' : ''}${w ? ' warn' : ''}" title="bit ${b}">${n}</span>`).join('')}</span>`; }
function renderIrq() {
  const b = board, p = b.plic, g = b.gpio;
  const mc = b.mcause >>> 0, isIrq = mc >>> 31, code = mc & 0x1f;
  const mcText = b.trapCount ? (isIrq ? IRQ_NAMES[code] ?? `interrupt ${code}` : CAUSES[code] ?? `exception ${code}`) : 'no trap yet';
  const mtv = b.mtvec;
  let h = `<div class="card"><h3>Core (CSRs)</h3><div class="kv">
  <span class="k">mstatus</span><span class="v">${hex8(b.mstatus)}</span><span>${bitChips(b.mstatus, [[3, 'MIE'], [7, 'MPIE']])}</span>
  <span class="k">mie</span><span class="v">${hex8(b.mie)}</span><span>${bitChips(b.mie, [[11, 'MEIE'], [7, 'MTIE'], [3, 'MSIE']])}</span>
  <span class="k">mip</span><span class="v">${hex8(b.mip)}</span><span>${bitChips(b.mip, [[11, 'MEIP', 1], [7, 'MTIP', 1], [3, 'MSIP', 1]])}</span>
  <span class="k">mtvec</span><span class="v">${hex8(mtv)}</span><span class="note">${mtv === b.bootSyms?.earlyTrap ? 'SDK early_trap_vector (not set by your code yet)' : `${mtv & 1 ? 'vectored' : 'direct'} → ${esc(labelAt(mtv & ~3) || locStr(mtv & ~3) || hex(mtv & ~3))}`}</span>
  <span class="k">mepc</span><span class="v">${hex8(b.mepc)}</span><span class="note">${esc(locStr(b.mepc))}</span>
  <span class="k">mcause</span><span class="v">${hex8(mc)}</span><span class="note">${esc(mcText)}</span>
  <span class="k">mtval</span><span class="v">${hex8(b.mtval)}</span><span class="note"></span>
  <span class="k">mscratch</span><span class="v">${hex8(b.mscratch)}</span><span class="note"></span>
  </div><div class="muted small" style="margin-top:6px">${b.inIsrSince !== undefined ? `<b class="sev-info">Inside an interrupt handler</b> since t = ${(b.inIsrSince / b.opts.hz).toFixed(6)} s.` : 'Not inside an interrupt handler.'} Traps taken: ${b.trapCount}.</div></div>`;
  // PLIC
  const ids = new Set([20, 21]);
  for (let i = 1; i < 53; i++) if (p.prio[i] || p.enable[i] || p.pending[i] || p.inflight[i]) ids.add(i);
  const srcName = (i) => i === 3 ? 'UART0' : i === 4 ? 'UART1' : i >= 8 && i <= 39 ? `GPIO ${i - 8}${i === 20 ? ' · S1' : i === 21 ? ' · S2' : ''}` : i === 1 ? 'WDT' : i === 2 ? 'RTC' : '';
  h += `<div class="card"><h3>PLIC (0x0C000000)</h3><div class="kv" style="margin-bottom:6px"><span class="k">threshold</span><span class="v">${p.threshold}</span><span class="note">0x0C200000 · interrupts need priority &gt; threshold</span>
  <span class="k">claimed</span><span class="v">${p.claimed.length ? p.claimed.join(', ') : '—'}</span><span class="note">claimed and not yet completed (0x0C200004)</span></div>
  <table class="t"><tr><th>source</th><th>device</th><th>priority</th><th>enabled</th><th>line</th><th>pending</th><th>in service</th></tr>
  ${[...ids].sort((a, c) => a - c).map((i) => `<tr><td>${i}</td><td style="font-family:var(--sans)">${srcName(i)}</td><td>${p.prio[i]}</td><td>${p.enable[i] ? '✓' : '·'}</td><td>${p.level[i] ? '1' : '0'}</td><td>${p.pending[i] ? '<b class="sev-warn">1</b>' : '0'}</td><td>${p.inflight[i] ? '<b class="sev-info">yes</b>' : ''}</td></tr>`).join('')}</table>
  <div class="muted small" style="margin-top:4px">priority: 0x${(PLIC_BASE + 4 * 20).toString(16)} (S1), 0x${(PLIC_BASE + 4 * 21).toString(16)} (S2) · enable bits: 0x0C002000 · pending: 0x0C001000</div></div>`;
  // GPIO interrupt view for the buttons
  const row = (pin) => {
    const bit = (r) => (g[r] >>> pin) & 1;
    return `<tr><td style="font-family:var(--sans)">${pin === 12 ? 'S1' : 'S2'} (GPIO ${pin})</td><td>${b.pressed[pin === 12 ? 'S1' : 'S2'] ? '<b class="sev-warn">pressed</b>' : 'released'}</td><td>${bit('input_en')}</td><td>${(b.syncIn >>> pin) & 1}</td><td>${bit('fall_ie')}</td><td>${bit('fall_ip') ? '<b class="sev-warn">1</b>' : '0'}</td><td>${bit('rise_ie')}</td><td>${bit('rise_ip')}</td></tr>`;
  };
  h += `<div class="card"><h3>Button interrupt bits (GPIO 0x10012000)</h3><table class="t"><tr><th>button</th><th>state</th><th>input_en</th><th>input_val</th><th>fall_ie</th><th>fall_ip</th><th>rise_ie</th><th>rise_ip</th></tr>${row(12)}${row(13)}</table>
  <div class="muted small" style="margin-top:4px">*_ip bits latch on edges even when *_ie is 0, and stay set until you write a 1 to them.</div></div>`;
  const cmp = b.clint.mtimecmp;
  h += `<div class="card"><h3>CLINT timer (0x02000000)</h3><div class="kv"><span class="k">mtime</span><span class="v">${b.mtime()}</span><span class="note">0x0200BFF8 · 32.768 kHz</span><span class="k">mtimecmp</span><span class="v">${cmp >= 2 ** 63 ? 'max' : cmp}</span><span class="note">0x02004000 · MTIP when mtime ≥ mtimecmp</span><span class="k">msip</span><span class="v">${b.clint.msip}</span><span class="note">0x02000000</span></div></div>`;
  $('#irqView').innerHTML = h;
}
function renderGpio() {
  const g = board.gpio;
  const cls = (i) => ((LED_MASK >>> i) & 1 ? 'led' : (SEG_MASK >>> i) & 1 ? 'seg' : (i === 12 || i === 13) ? 'btn' : 'oth');
  const rows = ['input_val', 'input_en', 'output_en', 'output_val', 'iof_en', 'iof_sel', 'out_xor', 'pue', 'fall_ie', 'fall_ip', 'rise_ie', 'rise_ip', 'high_ie', 'high_ip', 'low_ie', 'low_ip'];
  const val = (r) => (r === 'input_val' ? board.syncIn : g[r]) >>> 0;
  let h = `<div class="legend"><span><i style="background:#c0392b"></i>LED bar</span><span><i style="background:#d35400"></i>7-segment</span><span><i style="background:#2e86de"></i>S1/S2</span><span><i style="background:#4b5563"></i>other</span></div>`;
  h += '<div style="overflow-x:auto"><table class="bitgrid"><thead><tr><th></th>';
  for (let i = 31; i >= 0; i--) h += `<td>${i % 4 === 0 || i === 31 ? i : ''}</td>`;
  h += '<td></td></tr></thead><tbody>';
  for (const r of rows) {
    const v = val(r);
    if ((r.startsWith('high') || r.startsWith('low')) && !g.high_ie && !g.low_ie) continue;
    const off = GPIO_REGS.indexOf(r) * 4;
    h += `<tr><th title="offset 0x${off.toString(16).padStart(2, '0')}">${r} <span class="muted">+0x${off.toString(16).padStart(2, '0')}</span></th>`;
    for (let i = 31; i >= 0; i--) h += `<td class="b ${cls(i)}${(v >>> i) & 1 ? ' on' : ''}" title="GPIO ${i}">${(v >>> i) & 1}</td>`;
    h += `<td class="hex">${hex8(v)}</td></tr>`;
  }
  h += '</tbody></table></div>';
  const lit = board.pinLevels & board.pinDriven;
  h += `<h3>What the pins show</h3><div class="kv"><span class="k">LED bar</span><span class="v">0x${ledValue(lit).toString(16).padStart(2, '0')}</span><span class="note">LED7…LED0 = ${ledValue(lit).toString(2).padStart(8, '0')}</span>
  <span class="k">7-segment</span><span class="v">0x${(lit & SEG_MASK).toString(16).padStart(3, '0')}</span><span class="note">${segDigit(lit) ? `shows “${segDigit(lit)}”` : 'blank'}</span>
  <span class="k">S1 / S2</span><span class="v">${board.pressed.S1 ? 'down' : 'up'} / ${board.pressed.S2 ? 'down' : 'up'}</span><span class="note">pins read ${(board.pinLevels >>> 12) & 1} / ${(board.pinLevels >>> 13) & 1} (active low)</span></div>`;
  $('#gpioView').innerHTML = h;
}
function resolveAddr(s) {
  s = s.trim();
  const ri = ABI.indexOf(s);
  if (ri >= 0) return board.x[ri] >>> 0;
  const xm = /^x(\d+)$/.exec(s); if (xm && +xm[1] < 32) return board.x[+xm[1]] >>> 0;
  if (s === 'pc') return board.pc;
  if (S.prog) {
    if (s === '.data') return S.prog.bases.data; if (s === '.text') return S.prog.bases.text;
    if (s === '.rodata') return S.prog.bases.rodata; if (s === '.bss') return S.prog.bases.bss;
    const sym = S.prog.symbols.get(s); if (sym) return sym.v >>> 0;
  }
  const n = /^0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? +s : NaN;
  return Number.isNaN(n) ? null : n >>> 0;
}
function readable(a) { return (a >= 0x80000000 && a < 0x80004000) || (a >= 0x20000000 && a < 0x20000000 + (board.flashSize || 0)) || (a >= 0x08000000 && a < 0x08002000); }
function renderMem() {
  const inp = $('#memAddr').value;
  let base = resolveAddr(inp);
  const el = $('#memView');
  if (base === null) { el.innerHTML = '<span class="muted">Enter an address (0x…), a register (sp, a0…) or a label.</span>'; return; }
  base = (base & ~15) >>> 0;
  if (/^(sp|s0|fp)$/.test(inp.trim())) base = ((base - 64) & ~15) >>> 0;
  const sp = board.x[2] >>> 0;
  const prev = S.memSnap && S.memSnap.base === base ? S.memSnap.bytes : null;
  const bytes = [];
  let out = `<span class="a">address      +0 +1 +2 +3 +4 +5 +6 +7 +8 +9 +A +B +C +D +E +F   ascii</span>\n`;
  for (let r = 0; r < 24; r++) {
    const a = (base + r * 16) >>> 0;
    let line = `<span class="a">${hex8(a)}</span>  `, asc = '';
    for (let c = 0; c < 16; c++) {
      const ad = (a + c) >>> 0;
      let txt = '··', v = -1;
      if (readable(ad)) { v = board.load(ad, 1, false); txt = v.toString(16).padStart(2, '0'); }
      bytes.push(v);
      const idx = r * 16 + c;
      const changed = prev && prev[idx] !== v && !S.running;
      const isSp = (ad & ~3) === (sp & ~3) && c % 4 === (ad & 3);
      line += `<span class="${changed ? 'chg' : v === 0 ? 'z' : ''}${ad === sp ? ' sp' : ''}">${txt}</span> `;
      void isSp;
      asc += v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '.';
    }
    const tag = a <= sp && sp < a + 16 ? '  <span class="sp">← sp</span>' : '';
    out += line + `  <span class="c">${asc}</span>${tag}\n`;
  }
  if (!readable(base) && !readable(base + 383)) out += '\n<span class="muted">Not RAM/flash. Peripheral registers are shown in the GPIO and Interrupts tabs (reading some of them, like the PLIC claim register, has side effects).</span>';
  el.innerHTML = out;
  if (!S.running) S.memSnap = { base, bytes };
}
$('#memAddr').addEventListener('input', () => renderMem());
$$('[data-mem]').forEach((b) => b.addEventListener('click', () => { $('#memAddr').value = b.dataset.mem; S.memSnap = null; renderMem(); }));

let listingRows = new Map();
function buildListing() {
  const el = $('#listingView');
  const p = S.prog;
  listingRows = new Map();
  if (!p) { el.innerHTML = ''; return; }
  const labels = new Map();
  for (const [n, s] of p.symbols) if (s.kind === 'label' && s.sec === 'text' && !n.startsWith('__')) { const a = s.v >>> 0; if (!labels.has(a)) labels.set(a, []); labels.get(a).push(n); }
  let h = '<table class="lst">';
  for (const l of p.listing) {
    if (!l.isCode) continue;
    l.words.forEach((w, k) => {
      if (labels.has(w.addr)) h += `<tr class="lbl"><td colspan="4">${esc(labels.get(w.addr).join(', '))}:</td></tr>`;
      h += `<tr data-a="${w.addr}" data-f="${esc(l.file)}" data-l="${l.line}"><td class="ad">${w.addr.toString(16)}</td><td class="wd">${w.word.toString(16).padStart(8, '0')}</td><td>${esc(w.text)}</td><td class="src">${k === 0 ? esc(l.src.trim()) : ''}</td></tr>`;
    });
  }
  h += '</table>';
  el.innerHTML = h;
  for (const tr of $$('tr[data-a]', el)) listingRows.set(+tr.dataset.a, tr);
  el.onclick = (e) => {
    const tr = e.target.closest('tr[data-a]'); if (!tr) return;
    const f = tr.dataset.f, ln = +tr.dataset.l;
    if (docs.has(f)) { toggleBp(docs.get(f), ln - 1); gotoLine(f, ln); updateListingPc(); }
  };
  updateListingPc();
}
let lastPcRow = null;
function updateListingPc() {
  if (lastPcRow) lastPcRow.classList.remove('pc');
  const tr = listingRows.get(board.pc >>> 0);
  if (tr) { tr.classList.add('pc'); lastPcRow = tr; }
  for (const [a, row] of listingRows) row.classList.toggle('bp', board.breakpoints.has(a) && a !== S.tempBp);
}
function scrollListingToPc() { const tr = listingRows.get(board.pc >>> 0); if (tr && !S.running) tr.scrollIntoView({ block: 'center' }); }

// console
function logMsg(level, html, extra = {}) {
  S.console.push({ kind: 'msg', level, html, t: board.simTime, ...extra });
  if (S.console.length > 400) S.console.splice(0, 100);
  if ((level === 'error' || level === 'warn') && S.activeTab !== 'console') { S.unseen++; updateBadge(); }
  if (S.activeTab === 'console') renderConsole();
}
function updateBadge() { const b = $('#consoleBadge'); b.hidden = !S.unseen; b.textContent = S.unseen; }
let uartBuf = '';
board.on('uart', (c) => {
  uartBuf += String.fromCharCode(c);
  const last = S.console[S.console.length - 1];
  if (last && last.kind === 'uart') last.text += String.fromCharCode(c);
  else S.console.push({ kind: 'uart', text: String.fromCharCode(c) });
  if (S.activeTab === 'console') S.panelDirty = true;
});
board.on('hint', (h) => {
  const icon = { error: '✕', warn: '⚠', info: 'ℹ' }[h.level] ?? 'ℹ';
  logMsg(h.level, `${esc(h.msg)}`, { icon, where: locStr(h.pc) });
  if (h.level === 'error' && S.activeTab !== 'console') toast('⚠ ' + h.msg.slice(0, 120) + (h.msg.length > 120 ? '…' : ''), 5000);
});
let trapLogCount = 0, trapLogWindow = 0;
board.on('trap', (t) => {
  S.lastTrapCycle = t.cycle;
  const now = board.simTime;
  if (now - trapLogWindow > 1) { trapLogWindow = now; trapLogCount = 0; }
  trapLogCount++;
  if (!t.isIrq && S.settings.breakExc && t.handler !== board.bootSyms.earlyTrap) board.stopRequest = 'exception';
  if (trapLogCount <= 12) {
    const what = t.isIrq ? IRQ_NAMES[t.cause] : CAUSES[t.cause];
    logMsg(t.isIrq ? 'info' : 'error', `${t.isIrq ? 'Interrupt' : 'Exception'}: <b>${esc(what)}</b> (mcause ${t.isIrq ? '0x8000000' + t.cause.toString(16) : t.cause}) at ${esc(locStr(t.epc) || hex(t.epc))} → handler ${esc(labelAt(t.handler) || locStr(t.handler) || hex(t.handler))}${t.isIrq ? '' : `, mtval ${hex(t.tval)}`}`, { icon: t.isIrq ? '↯' : '✕' });
  } else if (trapLogCount === 13) logMsg('info', 'More traps this second aren\'t listed (to keep the console readable).', { icon: '…' });
});
function renderConsole() {
  const el = $('#consoleView');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = S.console.map((m) => {
    if (m.kind === 'sep') return '<div class="muted small" style="text-align:center;margin:6px 0">— reset —</div>';
    if (m.kind === 'uart') return `<div class="uart" title="UART0 output">${esc(m.text)}</div>`;
    return `<div class="msg ${m.level}"><span>${m.icon ?? { ok: '✓', error: '✕', warn: '⚠', info: 'ℹ' }[m.level]}</span><span>${m.html}${m.where ? ` <span class="muted">(${esc(m.where)})</span>` : ''}</span><span class="t">${m.t !== undefined ? m.t.toFixed(4) + ' s' : ''}</span></div>`;
  }).join('') || '<div class="muted">Messages from the board appear here: build results, traps, hints about common mistakes, and UART0 output.</div>';
  if (atBottom) el.scrollTop = el.scrollHeight;
}
$('#btnClearConsole').onclick = () => { S.console = []; renderConsole(); };
$('#uartIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { board.uartInput(e.target.value + '\n'); logMsg('info', `Sent to UART0 rx: <code>${esc(e.target.value)}</code>`); e.target.value = ''; } });

function renderTimeline() {
  const log = board.gpioLog, hz = board.opts.hz;
  const rows = [];
  let prevLed = null, prevLedT = null;
  const intervals = [];
  for (const e of log) {
    const lv = ledValue(e.value), t = e.cycle / hz;
    let dt = '';
    if (prevLed === null || lv !== prevLed) {
      if (prevLedT !== null) { dt = ((t - prevLedT) * 1000).toFixed(2) + ' ms'; intervals.push(t - prevLedT); }
      prevLedT = t;
    }
    prevLed = lv;
    rows.push({ t, v: e.value, lv, dt });
  }
  const last = intervals.slice(-10);
  const avg = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0;
  let h = `<div class="stats"><span>Changes recorded: <b>${log.length}</b></span>${last.length ? `<span>Last LED-bar interval: <b>${(intervals[intervals.length - 1] * 1000).toFixed(3)} ms</b></span><span>Average of last ${last.length}: <b>${(avg * 1000).toFixed(3)} ms</b></span>` : ''}</div>`;
  h += '<table class="tl"><tr><th style="text-align:left">time</th><th style="text-align:left">LED7…LED0</th><th>hex</th><th>7-seg</th><th style="text-align:right">Δ LED bar</th></tr>';
  for (const r of rows.slice(-300).reverse()) {
    const leds = Array.from({ length: 8 }, (_, i) => `<i class="${(r.lv >>> (7 - i)) & 1 ? 'on' : ''}"></i>`).join('');
    h += `<tr><td>${r.t.toFixed(6)} s</td><td><span class="ledrow">${leds}</span></td><td>0x${r.lv.toString(16).padStart(2, '0')}</td><td class="dig" style="text-align:center">${esc(segDigit(r.v))}</td><td style="text-align:right">${r.dt}</td></tr>`;
  }
  h += '</table>';
  if (!log.length) h = '<div class="muted">Every change of the LED bar and seven-segment display is listed here with its simulated time, so you can check timing (e.g. that a counter steps every 100 ms).</div>';
  $('#timelineView').innerHTML = h;
}

// ------------------------------------------------------------------ pc highlighting in the editor
let pcMark = null;
function markPcLine(clear = false) {
  if (pcMark) { pcMark.doc.removeLineClass(pcMark.h, 'background', 'cm-pc-line'); pcMark = null; }
  if (clear || S.running || !S.prog) return;
  const l = board.locOf(board.pc);
  if (!l || !docs.has(l.file)) return;
  const doc = docs.get(l.file);
  if (l.line - 1 >= doc.lineCount()) return;
  const h = doc.getLineHandle(l.line - 1);
  doc.addLineClass(h, 'background', 'cm-pc-line');
  pcMark = { doc, h };
}
function revealPc() {
  if (S.running || !S.prog) return;
  const l = board.locOf(board.pc);
  if (!l) return;
  if (l.file !== S.active && docs.has(l.file)) { switchFile(l.file); }
  editor.scrollIntoView({ line: l.line - 1, ch: 0 }, 140);
  markPcLine();
  if (S.activeTab === 'listing') scrollListingToPc();
}

// ------------------------------------------------------------------ menus, dialogs, keyboard
function toast(msg, ms = 2500) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
$('#btnRun').onclick = () => cmdRun();
$('#btnPause').onclick = () => cmdPause();
$('#btnStep').onclick = () => cmdStep();
$('#btnOver').onclick = () => cmdOver();
$('#btnReset').onclick = () => cmdReset();
$('#btnReload').onclick = () => cmdReset();
$('#speed').value = S.speed;
$('#speed').onchange = (e) => { S.speed = e.target.value; store.set('speed', S.speed); S.rate = { sim: 0, real: 0, shown: '' }; };
$('#btnOpen').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { if (e.target.files.length) openFiles(e.target.files); e.target.value = ''; };
$('#btnNew').onclick = cmdNew;
$('#btnDownload').onclick = cmdDownload;
const EXAMPLES = [
  ['led-chaser.S', 'LED chaser', 'GPIO outputs, a lookup table in .rodata, a delay loop'],
  ['uart-hello.S', 'UART hello', 'Print text to the Console through UART0'],
];
$('#btnExamples').onclick = (e) => {
  const m = $('#examplesMenu');
  if (!m.hidden) { m.hidden = true; return; }
  m.innerHTML = EXAMPLES.map(([f, t, d]) => `<button data-f="${f}">${t}<small>${d}</small></button>`).join('');
  const r = e.currentTarget.getBoundingClientRect();
  m.style.left = r.left + 'px'; m.style.top = r.bottom + 4 + 'px';
  m.hidden = false;
  $$('button', m).forEach((b) => b.onclick = async () => {
    m.hidden = true;
    const f = b.dataset.f;
    if (f in S.files && docs.get(f).getValue().trim() && !confirm(`Replace your edited ${f} with the original example?`)) return;
    const text = await (await fetch('examples/' + f)).text();
    addFile(f, text);
  });
};
document.addEventListener('click', (e) => { if (!e.target.closest('#examplesMenu') && !e.target.closest('#btnExamples')) $('#examplesMenu').hidden = true; });

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dropOverlay').hidden = false; e.preventDefault(); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true; if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });

// keyboard
const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest?.('.CodeMirror'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5' && e.shiftKey) { e.preventDefault(); cmdReset(); return; }
  if (e.key === 'F5') { e.preventDefault(); S.running ? cmdPause() : cmdRun(); return; }
  if (e.key === 'F6') { e.preventDefault(); cmdPause(); return; }
  if (e.key === 'F10') { e.preventDefault(); cmdOver(); return; }
  if (e.key === 'F11') { e.preventDefault(); cmdStep(); return; }
  if (editable(document.activeElement)) return;
  if ((e.key === '1' || e.key === '2') && !e.repeat && !e.metaKey && !e.ctrlKey) { pressBtn('S' + e.key, true); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => { if (e.key === '1' || e.key === '2') pressBtn('S' + e.key, false); });
window.addEventListener('blur', () => { if (board.pressed.S1) pressBtn('S1', false); if (board.pressed.S2) pressBtn('S2', false); });

// settings
$('#btnSettings').onclick = () => {
  const s = S.settings;
  $('#setHz').value = String(s.hz); $('#setTiming').value = s.timing;
  $('#setRandom').checked = s.randomizeRegs; $('#setBounce').checked = s.s2Bounce; $('#setBreakExc').checked = s.breakExc;
  $('#setLedColor').value = s.ledColor;
  $('#setIof').value = '0x' + (s.iofResetMask >>> 0).toString(16).toUpperCase().padStart(8, '0');
  $('#settingsDlg').showModal();
};
$('#settingsSave').onclick = () => {
  const iof = parseInt($('#setIof').value, 16);
  S.settings = { hz: +$('#setHz').value, timing: $('#setTiming').value, randomizeRegs: $('#setRandom').checked, s2Bounce: $('#setBounce').checked, breakExc: $('#setBreakExc').checked, iofResetMask: Number.isNaN(iof) ? DEFAULT_SETTINGS.iofResetMask : iof >>> 0, ledColor: $('#setLedColor').value };
  store.set('settings', S.settings);
  board.opts = { ...board.opts, ...boardOpts() };
  buildBoard(); drawBoard();
  $('.brand-sub').textContent = `SiFive FE310-G002 · RV32IMAC · ${(S.settings.hz / 1e6).toFixed(S.settings.hz % 1e6 ? 1 : 0)} MHz`;
  setTimeout(cmdReset, 0);
};
$('#btnHelp').onclick = () => { $('#helpBody').innerHTML = HELP; $('#helpDlg').showModal(); };

const HELP = `
<h2>RED-V Board Emulator</h2>
<p>Write or open your <code>.S</code> file, press <b>Run</b>, and the program runs on an emulated SparkFun RED-V Thing Plus (SiFive FE310-G002) with the lab daughter board: an 8-LED bar, a seven-segment display and push buttons S1/S2. Everything runs in your browser; files are saved in this browser only (use <b>Download</b> to keep a copy).</p>
<h3>Using it</h3>
<ul>
<li><b>Open…</b> or drag your <code>Lab_N.S</code> (and any <code>.h</code> it includes) onto the page. The file with the <span style="color:var(--warn)">●</span> in its tab is the one that gets built: the active <code>.S</code> tab.</li>
<li><b>Run</b> (F5) builds and starts. <b>Pause</b> (F6), <b>Step</b> (F11) one instruction, <b>Over</b> (F10) runs a whole call, <b>Reset</b> (Shift+F5) rebuilds and resets the board.</li>
<li>Click left of a line number to set a <b>breakpoint</b>. Breakpoints work inside interrupt handlers too.</li>
<li>Press the buttons with the mouse (hold to keep pressed) or hold keys <kbd>1</kbd> / <kbd>2</kbd> (click outside the editor first).</li>
<li>The <b>Timeline</b> tab lists every LED / seven-segment change with its simulated time, which is the easiest way to check a 0.1 s counter.</li>
<li>The <b>Console</b> explains traps and common mistakes (pins not enabled, IOF still on, interrupt not reaching the CPU, missing PLIC complete, …).</li>
</ul>
<h3>The board</h3>
<table><tr><th>Part</th><th>GPIO pins</th><th>Notes</th></tr>
<tr><td>LED bar LED0 … LED7</td><td>10, 11, 18, 19, 20, 21, 22, 23</td><td>mask 0x00FC0C00 · write 1 = on</td></tr>
<tr><td>Seven-segment a, b, c, d, e, f, g</td><td>0, 1, 2, 3, 4, 5, 9</td><td>mask 0x0000023F · write 1 = segment on</td></tr>
<tr><td>S1 / S2</td><td>12 / 13</td><td>active low (read 0 when pressed) · PLIC sources 20 / 21 · S2 bounces</td></tr></table>
<table><tr><th>Block</th><th>Base</th><th>Registers used in the labs</th></tr>
<tr><td>GPIO</td><td>0x10012000</td><td>+0x00 input_val, +0x04 input_en, +0x08 output_en, +0x0C output_val, +0x18/+0x1C rise_ie/ip, +0x20/+0x24 fall_ie/ip, +0x38 iof_en, +0x40 out_xor</td></tr>
<tr><td>PLIC</td><td>0x0C000000</td><td>priority 0x0C000000 + 4×ID, pending 0x0C001000, enable 0x0C002000, threshold 0x0C200000, claim/complete 0x0C200004</td></tr>
<tr><td>CLINT</td><td>0x02000000</td><td>msip +0x0, mtimecmp +0x4000, mtime +0xBFF8 (32.768 kHz)</td></tr>
<tr><td>UART0</td><td>0x10013000</td><td>txdata +0x00 (shown in the Console), rxdata +0x04</td></tr>
<tr><td>Memory</td><td colspan="2">code + .rodata in flash from 0x20010000 (read-only) · .data/.bss/stack in 16 KiB RAM at 0x80000000 · sp starts 1 KiB above the end of .bss</td></tr></table>
<h3>How faithful is it?</h3>
<ul>
<li><b>Assembler:</b> GNU-as syntax with the C preprocessor (<code>#include</code>, <code>#define</code>), all RV32IMA + CSR instructions, the usual pseudo-instructions and directives. Machine code was checked byte-for-byte against GNU binutils, with uncompressed (32-bit) encodings. The real lab build uses compressed instructions too, so addresses on the board can differ, but behaviour doesn't.</li>
<li><b>Startup:</b> like the board, the SDK's <code>_enter</code> sets <code>gp</code>, <code>sp</code> and a temporary <code>mtvec</code>, then calls your <code>_start</code>. The C runtime (and <code>main</code>) don't run when you define <code>_start</code>.</li>
<li><b>Timing:</b> 16 MHz, using the E31 pipeline rules from the FE310 manual (1 instruction/cycle, loads 2–3 cycles to use, mul 5, div up to 33, 3-cycle branch mispredicts, 5-cycle CSR writes). A 2-instruction delay loop takes 2 cycles per iteration, as the lab manual assumes. Flash/cache misses aren't modelled. Settings has a simple 1-cycle-per-instruction mode.</li>
<li><b>GPIO/PLIC/CLINT</b> follow the FE310-G002 manual: input_val is gated by input_en; *_ip bits latch on edges and clear when you write 1; PLIC interrupts need priority &gt; threshold, and a claimed source stays blocked until you complete it.</li>
<li><b>Assumptions</b> (can't be checked without a board): pins 2–5, 9, 16, 17 start with iof_en set (so the seven-segment needs iof_en cleared, as the Lab 4 manual warns); registers and RAM start with random values unless your code sets them; S2 bounce lasts ~0.3–3 ms.</li>
</ul>`;

// ------------------------------------------------------------------ boot
buildBoard();
await initFiles();
renderTabs();
updateButtons();
const first = doBuild();
if (first.ok) {
  loadBuild(first);
  setStatus('idle', 'Ready: press Run (F5)');
} else setStatus('error', 'Build failed: see the problems below the editor');
logMsg('info', S.firstVisit
  ? 'Welcome! An example program is loaded. Press <b>Run</b> to start it, or <b>Open…</b> / drag in your own <code>Lab_N.S</code>. Open <b>?</b> for the board pinout and how it works.'
  : 'Your files were restored from this browser. Press <b>Run</b> to start.');
S.unseen = 0; updateBadge();
renderPanels(true);
requestAnimationFrame(rafLoop);
window.__board = board;
