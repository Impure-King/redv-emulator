// SparkFun RED-V Thing Plus (SiFive FE310-G002, E31 core) + the ECE 222 lab daughter board.
// CPU: RV32IMA + Zicsr, machine mode. Devices: GPIO, PLIC, CLINT, UART0 (others are register stubs).
// Register-level behaviour follows the FE310-G002 Manual v1p5; timing follows its E31 pipeline notes (§3).

import { assemble, LAYOUT } from './asm.js';
import { disasm, immI, immS, immB, immJ, ABI } from './isa.js';

export const PINS = {
  leds: [10, 11, 18, 19, 20, 21, 22, 23],               // LED0 … LED7 on the LED bar
  seg: { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 9 },    // seven-segment display
  S1: 12, S2: 13,                                        // push buttons (active low, pulled up)
};
export const LED_MASK = 0x00fc0c00, SEG_MASK = 0x0000023f, BTN_MASK = 0x00003000;
export const GPIO_BASE = 0x10012000, PLIC_BASE = 0x0c000000, CLINT_BASE = 0x02000000, UART0_BASE = 0x10013000;
export const GPIO_REGS = ['input_val', 'input_en', 'output_en', 'output_val', 'pue', 'ds', 'rise_ie', 'rise_ip',
  'fall_ie', 'fall_ip', 'high_ie', 'high_ip', 'low_ie', 'low_ip', 'iof_en', 'iof_sel', 'out_xor',
  'passthru_high_ie', 'passthru_low_ie'];
export const CAUSES = {
  0: 'instruction address misaligned', 1: 'instruction access fault', 2: 'illegal instruction', 3: 'breakpoint',
  4: 'load address misaligned', 5: 'load access fault', 6: 'store address misaligned', 7: 'store access fault',
  8: 'environment call from U-mode', 11: 'environment call from M-mode',
};
export const IRQ_NAMES = { 3: 'machine software interrupt', 7: 'machine timer interrupt', 11: 'machine external interrupt' };

class Trap extends Error { constructor(cause, tval) { super("trap " + cause); this.cause = cause; this.tval = tval >>> 0; } }

// ------------------------------------------------------------------ decode
const K = {
  ILLEGAL: 0, LUI: 1, AUIPC: 2, JAL: 3, JALR: 4, BEQ: 5, BNE: 6, BLT: 7, BGE: 8, BLTU: 9, BGEU: 10,
  LB: 11, LH: 12, LW: 13, LBU: 14, LHU: 15, SB: 16, SH: 17, SW: 18,
  ADDI: 19, SLTI: 20, SLTIU: 21, XORI: 22, ORI: 23, ANDI: 24, SLLI: 25, SRLI: 26, SRAI: 27,
  ADD: 28, SUB: 29, SLL: 30, SLT: 31, SLTU: 32, XOR: 33, SRL: 34, SRA: 35, OR: 36, AND: 37,
  MUL: 38, MULH: 39, MULHSU: 40, MULHU: 41, DIV: 42, DIVU: 43, REM: 44, REMU: 45,
  CSRRW: 46, CSRRS: 47, CSRRC: 48, CSRRWI: 49, CSRRSI: 50, CSRRCI: 51,
  ECALL: 52, EBREAK: 53, MRET: 54, WFI: 55, FENCE: 56, LR: 57, SC: 58, AMO: 59,
};

function decode(w) {
  const d = { k: K.ILLEGAL, rd: 0, rs1: 0, rs2: 0, imm: 0, f: 0, w: w >>> 0 };
  if ((w & 3) !== 3) return d;
  const op = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, f7 = w >>> 25;
  d.rd = rd; d.rs1 = rs1; d.rs2 = rs2;
  // which source registers are really read (for the pipeline scoreboard)
  d.s1 = (op === 0x37 || op === 0x17 || op === 0x6f || (op === 0x73 && f3 >= 5) || op === 0x0f) ? 0 : rs1;
  d.s2 = (op === 0x33 || op === 0x63 || op === 0x23 || op === 0x2f) ? rs2 : 0;
  switch (op) {
    case 0x37: d.k = K.LUI; d.imm = w & 0xfffff000; break;
    case 0x17: d.k = K.AUIPC; d.imm = w & 0xfffff000; break;
    case 0x6f: d.k = K.JAL; d.imm = immJ(w); break;
    case 0x67: if (f3 === 0) { d.k = K.JALR; d.imm = immI(w); } break;
    case 0x63: { const t = [K.BEQ, K.BNE, 0, 0, K.BLT, K.BGE, K.BLTU, K.BGEU][f3]; if (t) { d.k = t; d.imm = immB(w); } break; }
    case 0x03: { const t = [K.LB, K.LH, K.LW, 0, K.LBU, K.LHU, 0, 0][f3]; if (t) { d.k = t; d.imm = immI(w); } break; }
    case 0x23: { const t = [K.SB, K.SH, K.SW][f3]; if (t) { d.k = t; d.imm = immS(w); } break; }
    case 0x13: {
      d.imm = immI(w);
      if (f3 === 1) { if (f7 === 0) { d.k = K.SLLI; d.imm = rs2; } }
      else if (f3 === 5) { if (f7 === 0) { d.k = K.SRLI; d.imm = rs2; } else if (f7 === 0x20) { d.k = K.SRAI; d.imm = rs2; } }
      else d.k = [K.ADDI, 0, K.SLTI, K.SLTIU, K.XORI, 0, K.ORI, K.ANDI][f3];
      break;
    }
    case 0x33:
      if (f7 === 0) d.k = [K.ADD, K.SLL, K.SLT, K.SLTU, K.XOR, K.SRL, K.OR, K.AND][f3];
      else if (f7 === 0x20) { if (f3 === 0) d.k = K.SUB; else if (f3 === 5) d.k = K.SRA; }
      else if (f7 === 1) d.k = [K.MUL, K.MULH, K.MULHSU, K.MULHU, K.DIV, K.DIVU, K.REM, K.REMU][f3];
      break;
    case 0x0f: if (f3 === 0 || f3 === 1) d.k = K.FENCE; break;
    case 0x2f:
      if (f3 === 2) {
        const f5 = f7 >>> 2;
        if (f5 === 2) { if (rs2 === 0) d.k = K.LR; }
        else if (f5 === 3) d.k = K.SC;
        else if ([0, 1, 4, 8, 12, 16, 20, 24, 28].includes(f5)) { d.k = K.AMO; d.f = f5; }
      }
      break;
    case 0x73:
      if (f3 === 0) {
        if (w === 0x00000073) d.k = K.ECALL;
        else if (w === 0x00100073) d.k = K.EBREAK;
        else if (w === 0x30200073) d.k = K.MRET;
        else if (w === 0x10500073) d.k = K.WFI;
      } else if (f3 !== 4) {
        d.k = [0, K.CSRRW, K.CSRRS, K.CSRRC, 0, K.CSRRWI, K.CSRRSI, K.CSRRCI][f3];
        d.imm = w >>> 20; // csr number
      }
      break;
  }
  return d;
}

function mulhu(a, b) {
  a >>>= 0; b >>>= 0;
  const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16;
  const ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (hh + (lh >>> 16) + (hl >>> 16) + Math.floor(mid / 65536)) >>> 0;
}
const mulh = (a, b) => (mulhu(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0)) | 0;
const mulhsu = (a, b) => (mulhu(a, b) - (a < 0 ? b >>> 0 : 0)) | 0;

// ------------------------------------------------------------------ the board
export class Board {
  constructor(opts = {}) {
    this.opts = {
      hz: 16_000_000,          // hfclk: 16 MHz (lab manual; SDK PLL setting for this board)
      rtcHz: 32_768,           // mtime ticks from the 32.768 kHz RTC
      timing: 'e31',           // 'e31' (pipeline model from the manual) or 'simple' (1 cycle per instruction)
      randomizeRegs: true,     // registers the boot code doesn't set hold leftover values on a real board
      iofResetMask: 0x0003023c,// assumed: bootloader leaves SPI1 (GPIO 2–5, 9) and UART0 (16–17) on their IOFs
      s2Bounce: true,          // S2 isn't debounced on the real board; S1 is
      ...opts,
    };
    this.listeners = { hint: [], trap: [], uart: [], halt: [], change: [] };
    this.breakpoints = new Set();
    this.program = null;
  }
  on(ev, fn) { this.listeners[ev].push(fn); }
  emit(ev, ...a) { for (const f of this.listeners[ev]) f(...a); }

  // -------------------------------------------------------------- loading
  loadProgram(prog) {
    this.program = prog;
    // boot ROM: stands in for the bootloader + freedom-metal _enter (entry.S), which call _start
    const bootSrc = `
      .equ ENTRY, ${prog.entry}
      .equ SP, ${prog.sp}
      .equ GP, ${prog.gp}
      .equ STACK_SIZE, ${LAYOUT.stackSize}
      .globl _enter
      _enter:
        li gp, GP
        la t0, early_trap_vector
        csrw mtvec, t0
        li sp, SP
        csrr a0, mhartid
        li t1, STACK_SIZE
        li a1, 0
        li a2, 0
        li t2, ENTRY
        jalr ra, 0(t2)
      __metal_after_main:
        j __metal_after_main
        .align 6
      early_trap_vector:
        j early_trap_vector
    `;
    const boot = assemble({ 'boot.S': bootSrc }, 'boot.S', { textBase: LAYOUT.boot });
    if (!boot.ok) throw new Error('boot ROM failed to assemble: ' + boot.errors.map((e) => e.msg).join('; '));
    this.bootSyms = { returned: boot.symbols.get('__metal_after_main').v, earlyTrap: boot.symbols.get('early_trap_vector').v };
    this.bootImage = boot.image.text;
    // flash image
    const textEnd = prog.bases.text + prog.image.text.length;
    const roEnd = prog.bases.rodata + prog.image.rodata.length;
    this.flashSize = Math.max(textEnd, roEnd, LAYOUT.text) - 0x20000000 + 16;
    this.flash = new Uint8Array(this.flashSize).fill(0xff);
    this.flash.set(this.bootImage, 0);
    this.flash.set(prog.image.text, prog.bases.text - 0x20000000);
    this.flash.set(prog.image.rodata, prog.bases.rodata - 0x20000000);
    this.flashDV = new DataView(this.flash.buffer);
    this.decoded = new Array(this.flashSize >> 1);
    this.reset();
  }

  reset() {
    const o = this.opts;
    this.ram = new Uint8Array(LAYOUT.ramSize);
    this.ramDV = new DataView(this.ram.buffer);
    this.itim = new Uint8Array(0x2000);
    this.itimDV = new DataView(this.itim.buffer);
    // On the real board, crt0 never runs when you define _start, so .data isn't copied and .bss isn't zeroed.
    // The emulator copies .data anyway (and warns), because that's what you'd expect when reading the code.
    const p = this.program;
    if (o.randomizeRegs) for (let i = 0; i < this.ram.length; i++) this.ram[i] = (Math.random() * 256) | 0;
    if (p) {
      this.ram.set(p.image.data, p.bases.data - LAYOUT.ram);
      this.ram.fill(0, p.bases.bss - LAYOUT.ram, p.bases.bss - LAYOUT.ram + p.sizes.bss);
    }
    this.x = new Int32Array(33);
    this.xInit = new Uint8Array(32);  // 1 = written since reset
    if (o.randomizeRegs) for (let i = 1; i < 32; i++) this.x[i] = (Math.random() * 0x100000000) | 0;
    this.xInit[0] = 1;
    this.pc = LAYOUT.boot;
    this.cycles = 0; this.instret = 0;
    this.mstatus = 0x1800; this.mie = 0; this.mtvec = 0; this.mscratch = 0; this.mepc = 0; this.mcause = 0; this.mtval = 0;
    this.mcycleOff = 0; this.minstretOff = 0;
    this.resv = -1;
    this.waiting = false;
    this.halted = null;
    this.irqDirty = true;
    this.ready = new Float64Array(33);
    this.bht = new Map(); this.btb = new Map(); this.ras = [];
    this.lastStore = { addr: -1, cycle: -10 };
    this.events = [];
    this.hintsShown = new Set();
    this.trapCount = 0;
    this.isrDepthLog = [];
    // devices
    const g = {};
    for (const r of GPIO_REGS) g[r] = 0;
    g.iof_en = o.iofResetMask >>> 0;
    this.gpio = g;
    this.ext = { level: 0xffffffff, driven: BTN_MASK };   // buttons: pulled up (1) unless pressed
    this.pressed = { S1: false, S2: false };
    this.syncIn = 0;
    this.pinLevels = 0; this.pinDriven = 0;
    this.pinHighCycles = new Float64Array(32); this.pinLastChange = 0;
    this.gpioLog = [];
    this.plic = { prio: new Uint8Array(53), pending: new Uint8Array(53), enable: new Uint8Array(53), level: new Uint8Array(53), inflight: new Uint8Array(53), threshold: 0, claimed: [] };
    this.clint = { msip: 0, mtimecmp: 2 ** 64 - 1, mtimeOff: 0 };
    this.uart = { rx: [], txctrl: 0, rxctrl: 0, ie: 0, div: 138 };
    this.stubRegs = new Map();
    this.updatePins();
    this.emit('change');
  }

  // -------------------------------------------------------------- helpers
  hint(key, msg, level = 'warn') {
    if (this.hintsShown.has(key)) return;
    this.hintsShown.add(key);
    this.emit('hint', { key, msg, level, cycle: this.cycles, pc: this.curPc ?? this.pc });
  }
  get simTime() { return this.cycles / this.opts.hz; }
  mtime() { return Math.floor(this.cycles * this.opts.rtcHz / this.opts.hz) + this.clint.mtimeOff; }
  timerCycle() {
    const cmp = this.clint.mtimecmp;
    if (cmp >= 2 ** 53) return Infinity;
    return Math.ceil((cmp - this.clint.mtimeOff) * this.opts.hz / this.opts.rtcHz);
  }
  schedule(cycle, fn) {
    this.events.push({ cycle, fn });
    this.events.sort((a, b) => a.cycle - b.cycle);
    this.replan = true;
  }
  locOf(pc) { return this.program?.addrToLoc.get(pc >>> 0); }
  srcOf(pc) {
    const l = this.locOf(pc);
    return l ? `${l.file}:${l.line}` : `0x${(pc >>> 0).toString(16)}`;
  }
  get mip() {
    let v = 0;
    if (this.plicMeip()) v |= 1 << 11;
    if (this.mtime() >= this.clint.mtimecmp) v |= 1 << 7;
    if (this.clint.msip & 1) v |= 1 << 3;
    return v;
  }

  // -------------------------------------------------------------- buttons
  setButton(name, down) {
    if (this.pressed[name] === down) return;
    this.pressed[name] = down;
    if (down) { this.lastPress = { name, cycle: this.cycles }; this.trapCountAtPress = this.trapCount; }
    const pin = PINS[name];
    const apply = (lvl) => {
      this.ext.level = lvl ? (this.ext.level | (1 << pin)) : (this.ext.level & ~(1 << pin));
      this.updatePins();
    };
    if (name === 'S2' && this.opts.s2Bounce) {
      // contact bounce: a burst of edges over ~0.3–3 ms, settling on the final level
      let t = this.cycles;
      const n = 2 + ((Math.random() * 4) | 0);
      let lvl = down ? 0 : 1;
      for (let i = 0; i < n * 2; i++) {
        const l = lvl;
        this.schedule(t, () => apply(l));
        t += Math.round((0.05e-3 + Math.random() * 0.4e-3) * this.opts.hz);
        lvl ^= 1;
      }
      this.schedule(t, () => apply(down ? 0 : 1));
    } else apply(down ? 0 : 1);
    this.irqDirty = true;
  }

  // -------------------------------------------------------------- GPIO
  iofDrive(pin) {
    // A pin with its iof_en bit set is controlled by the hardware function (SPI1, UART0, PWM…), not by
    // output_val. Those peripherals are idle here, so the pin isn't driven and its LED stays dark.
    return 2;
  }
  updatePins() {
    const g = this.gpio;
    let level = 0, driven = 0;
    for (let i = 0; i < 32; i++) {
      const bit = 1 << i;
      let lv = 0, dr = false;
      const iof = (g.iof_en & bit) ? this.iofDrive(i) : -1;
      if (iof === 0 || iof === 1) { lv = iof ^ ((g.out_xor >>> i) & 1); dr = true; }
      else if (iof === -1 && (g.output_en & bit)) { lv = ((g.output_val ^ g.out_xor) >>> i) & 1; dr = true; }
      else if (this.ext.driven & bit) { lv = (this.ext.level >>> i) & 1; }
      else if (g.pue & bit) lv = 1;
      if (lv) level |= bit;
      if (dr) driven |= bit;
    }
    // a pressed button shorts its pin to ground even if the pin is driven high
    level &= ~(BTN_MASK & ~this.ext.level);
    level >>>= 0; driven >>>= 0;
    // LED brightness accounting (persistence of vision)
    if (level !== this.pinLevels || driven !== this.pinDriven) {
      const dt = this.cycles - this.pinLastChange;
      const lit = this.pinLevels & this.pinDriven;
      if (dt > 0) for (let i = 0; i < 32; i++) if (lit & (1 << i)) this.pinHighCycles[i] += dt;
      this.pinLastChange = this.cycles;
      const oldVis = this.pinLevels & this.pinDriven & (LED_MASK | SEG_MASK);
      const newVis = level & driven & (LED_MASK | SEG_MASK);
      if (oldVis !== newVis) {
        this.gpioLog.push({ cycle: this.cycles, value: newVis >>> 0 });
        if (this.gpioLog.length > 5000) this.gpioLog.splice(0, 1000);
      }
      this.pinLevels = level; this.pinDriven = driven;
    }
    // synchronized inputs, gated by input_en (FE310 manual §17.3)
    const inp = (level & g.input_en) >>> 0;
    const rise = (inp & ~this.syncIn) >>> 0, fall = (~inp & this.syncIn) >>> 0;
    this.syncIn = inp;
    g.rise_ip = (g.rise_ip | rise) >>> 0;
    g.fall_ip = (g.fall_ip | fall) >>> 0;
    g.high_ip = (g.high_ip | inp) >>> 0;
    g.low_ip = (g.low_ip | ~inp) >>> 0;
    this.updateGpioIrq();
  }
  updateGpioIrq() {
    const g = this.gpio;
    const lines = ((g.rise_ip & g.rise_ie) | (g.fall_ip & g.fall_ie) | (g.high_ip & g.high_ie) | (g.low_ip & g.low_ie)) >>> 0;
    let changed = false;
    for (let i = 0; i < 32; i++) {
      const l = (lines >>> i) & 1;
      if (this.plic.level[8 + i] !== l) { this.plic.level[8 + i] = l; changed = true; }
    }
    if (changed) this.plicGateway();
  }
  gpioRead(off) {
    const name = GPIO_REGS[off >> 2];
    if (!name) return 0;
    if (name === 'input_val') {
      if ((this.gpio.input_en & BTN_MASK) !== BTN_MASK && !this.hintsShown.has('inen-btn')) {
        const missing = [12, 13].filter((p) => !((this.gpio.input_en >>> p) & 1)).map((p) => (p === 12 ? 'S1 (GPIO 12)' : 'S2 (GPIO 13)'));
        this.hint('inen-btn', `Read GPIO input_val, but input_en is 0 for ${missing.join(' and ')}. input_val reads 0 for any pin whose input_en bit is 0 (FE310 manual §17.3), so the button looks pressed (active low). Set those bits in input_en (offset 0x04).`, 'info');
      }
      return this.syncIn | 0;
    }
    return this.gpio[name] | 0;
  }
  gpioWrite(off, v) {
    const name = GPIO_REGS[off >> 2];
    if (!name || name === 'input_val') return;
    const g = this.gpio;
    v >>>= 0;
    if (name.endsWith('_ip')) g[name] = (g[name] & ~v) >>> 0;     // write 1 to clear
    else g[name] = v;
    if (name === 'output_val' || name === 'output_en') {
      const visible = (g.output_val & (LED_MASK | SEG_MASK)) >>> 0;
      const notEn = (visible & ~g.output_en & (LED_MASK | SEG_MASK)) >>> 0;
      if (name === 'output_val' && notEn) this.hint('outen', `Wrote GPIO output_val bits 0x${notEn.toString(16)}, but output_en is 0 for those pins, so they aren't driven and those LEDs stay dark. Set the same bits in output_en (offset 0x08) first.`);
      const iofOut = (visible & g.output_en & g.iof_en) >>> 0;
      if (iofOut) {
        const pins = [...Array(32).keys()].filter((i) => (iofOut >>> i) & 1);
        this.hint('iof', `GPIO ${pins.join(', ')} ${pins.length > 1 ? 'are' : 'is'} still under hardware I/O-function control (iof_en = 0x${g.iof_en.toString(16)}), so output_val doesn't reach ${pins.length > 1 ? 'those pins' : 'that pin'}. Clear those bits in iof_en (offset 0x38) — FE310 manual §17.8.`);
      }
    }
    if ((name === 'rise_ie' || name === 'fall_ie') && v) {
      const stale = (v & (name === 'rise_ie' ? g.rise_ip : g.fall_ip)) >>> 0;
      if (stale) this.hint('stale-ip-' + name, `Enabled ${name} while ${name.replace('ie', 'ip')} already has bits 0x${stale.toString(16)} set from earlier edges, so the interrupt fires straight away. Pending bits latch even while the interrupt is disabled; clear them (write 1s to ${name.replace('ie', 'ip')}) before enabling.`, 'info');
    }
    if (name === 'high_ip' || name === 'low_ip') {
      g.high_ip = (g.high_ip | this.syncIn) >>> 0;   // level-type pending bits re-set while the level holds
      g.low_ip = (g.low_ip | ~this.syncIn) >>> 0;
    }
    this.updatePins();
  }

  // -------------------------------------------------------------- PLIC
  plicGateway() {
    const p = this.plic;
    for (let i = 1; i < 53; i++) if (p.level[i] && !p.inflight[i]) p.pending[i] = 1;
    this.irqDirty = true;
  }
  plicBest() {
    const p = this.plic;
    let best = 0, bp = 0;
    for (let i = 1; i < 53; i++) if (p.pending[i] && p.enable[i] && p.prio[i] > bp) { bp = p.prio[i]; best = i; }
    return { id: best, prio: bp };
  }
  plicMeip() { const b = this.plicBest(); return b.id !== 0 && b.prio > this.plic.threshold; }
  plicRead(off) {
    const p = this.plic;
    if (off >= 4 && off < 0xd4 && off % 4 === 0) return p.prio[off >> 2];
    if (off === 0x1000 || off === 0x1004) { let v = 0; const b = off === 0x1000 ? 0 : 32; for (let i = 0; i < 32; i++) if (b + i < 53 && p.pending[b + i]) v |= 1 << i; return v; }
    if (off === 0x2000 || off === 0x2004) { let v = 0; const b = off === 0x2000 ? 0 : 32; for (let i = 0; i < 32; i++) if (b + i < 53 && p.enable[b + i]) v |= 1 << i; return v; }
    if (off === 0x200000) return p.threshold;
    if (off === 0x200004) { // claim
      const { id } = this.plicBest();
      if (id) { p.pending[id] = 0; p.inflight[id] = 1; p.claimed.push(id); }
      this.irqDirty = true;
      return id;
    }
    return 0;
  }
  plicWrite(off, v) {
    const p = this.plic;
    if (off >= 4 && off < 0xd4 && off % 4 === 0) { p.prio[off >> 2] = v & 7; this.checkPlicConfig(); this.irqDirty = true; return; }
    if (off === 0x2000 || off === 0x2004) {
      const b = off === 0x2000 ? 0 : 32;
      for (let i = 0; i < 32; i++) if (b + i < 53) p.enable[b + i] = (v >>> i) & 1;
      p.enable[0] = 0;
      this.checkPlicConfig(); this.irqDirty = true; return;
    }
    if (off === 0x200000) { p.threshold = v & 7; this.checkPlicConfig(); this.irqDirty = true; return; }
    if (off === 0x200004) { // complete
      const id = v >>> 0;
      if (id > 0 && id < 53 && p.enable[id]) {
        p.inflight[id] = 0;
        const k = p.claimed.indexOf(id); if (k >= 0) p.claimed.splice(k, 1);
        this.plicGateway();
      } else if (id > 0 && id < 53) {
        this.hint('complete-disabled', `Wrote ${id} to the PLIC claim/complete register, but source ${id} isn't enabled, so the PLIC ignores the completion.`);
      }
      return;
    }
  }
  checkPlicConfig() {
    const p = this.plic;
    for (const pin of [12, 13]) {
      const id = 8 + pin;
      if (p.enable[id] && p.prio[id] !== 0 && p.prio[id] <= p.threshold && this.mie & (1 << 11))
        this.hint('prio-thresh-' + id, `PLIC source ${id} (GPIO ${pin}, ${pin === 12 ? 'S1' : 'S2'}) has priority ${p.prio[id]}, which isn't above the threshold ${p.threshold}. An interrupt is only delivered when priority > threshold.`, 'info');
    }
  }

  // -------------------------------------------------------------- bus
  load(addr, size, signed, isFetch = false) {
    addr >>>= 0;
    if (addr & (size - 1)) throw new Trap(4, addr);
    const r = addr - LAYOUT.ram;
    if (r >= 0 && r < LAYOUT.ramSize) {
      if (size === 4) return this.ramDV.getInt32(r, true);
      if (size === 2) return signed ? this.ramDV.getInt16(r, true) : this.ramDV.getUint16(r, true);
      return signed ? this.ramDV.getInt8(r) : this.ram[r];
    }
    const f = addr - 0x20000000;
    if (f >= 0 && f < 0x20000000) {
      if (f + size > this.flashSize) return size === 4 ? -1 : signed ? -1 : size === 2 ? 0xffff : 0xff;
      if (size === 4) return this.flashDV.getInt32(f, true);
      if (size === 2) return signed ? this.flashDV.getInt16(f, true) : this.flashDV.getUint16(f, true);
      return signed ? this.flashDV.getInt8(f) : this.flash[f];
    }
    const it = addr - 0x08000000;
    if (it >= 0 && it < 0x2000) {
      if (size === 4) return this.itimDV.getInt32(it, true);
      if (size === 2) return signed ? this.itimDV.getInt16(it, true) : this.itimDV.getUint16(it, true);
      return signed ? this.itimDV.getInt8(it) : this.itim[it];
    }
    const v = this.mmioRead(addr & ~3, addr);
    if (v === undefined) throw new Trap(5, addr);
    if (size === 4) return v | 0;
    const sh = (addr & 3) * 8;
    const part = (v >>> sh) & (size === 2 ? 0xffff : 0xff);
    return signed ? (size === 2 ? (part << 16) >> 16 : (part << 24) >> 24) : part;
  }
  store(addr, size, val) {
    addr >>>= 0;
    if (addr & (size - 1)) throw new Trap(6, addr);
    const r = addr - LAYOUT.ram;
    if (r >= 0 && r < LAYOUT.ramSize) {
      if (size === 4) this.ramDV.setInt32(r, val, true);
      else if (size === 2) this.ramDV.setInt16(r, val, true);
      else this.ram[r] = val;
      if (this.resv === (addr & ~3)) this.resv = -1;
      return;
    }
    const it = addr - 0x08000000;
    if (it >= 0 && it < 0x2000) {
      if (size === 4) this.itimDV.setInt32(it, val, true); else if (size === 2) this.itimDV.setInt16(it, val, true); else this.itim[it] = val;
      return;
    }
    const f = addr - 0x20000000;
    if (f >= 0 && f < 0x20000000) {
      this.hint('flash-write', `Store to 0x${addr.toString(16)} faulted: that's QSPI flash (code and .rodata), which is read-only while running. Writable variables go in .data or .bss (RAM at 0x80000000).`, 'error');
      throw new Trap(7, addr);
    }
    let v = val;
    if (size !== 4) {
      const old = this.mmioRead(addr & ~3, addr, true);
      if (old === undefined) throw new Trap(7, addr);
      const sh = (addr & 3) * 8, mask = (size === 2 ? 0xffff : 0xff) << sh;
      v = (old & ~mask) | ((val << sh) & mask);
      if ((addr & ~0xfff) === GPIO_BASE) this.hint('gpio-subword', `A ${size === 1 ? 'byte' : 'halfword'} store to GPIO register 0x${addr.toString(16)}: the GPIO block only supports naturally aligned 32-bit accesses (FE310 manual Table 50). Use sw.`);
    }
    if (!this.mmioWrite(addr & ~3, v >>> 0)) throw new Trap(7, addr);
  }
  mmioRead(a, orig, quiet) {
    if (a >= GPIO_BASE && a < GPIO_BASE + 0x1000) {
      if (!quiet && orig !== a) this.hint('gpio-subword-r', `A sub-word load from GPIO register 0x${(orig >>> 0).toString(16)}: the GPIO block only supports aligned 32-bit accesses. Use lw.`);
      return this.gpioRead(a - GPIO_BASE);
    }
    if (a >= PLIC_BASE && a < PLIC_BASE + 0x4000000) return this.plicRead(a - PLIC_BASE);
    if (a >= CLINT_BASE && a < CLINT_BASE + 0x10000) {
      const o = a - CLINT_BASE;
      if (o === 0) return this.clint.msip & 1;
      if (o === 0x4000) return Number(BigInt.asUintN(32, BigInt(Math.min(this.clint.mtimecmp, 2 ** 64 - 1)))) | 0;
      if (o === 0x4004) return Number(BigInt.asUintN(64, BigInt(Math.min(this.clint.mtimecmp, 2 ** 64 - 1))) >> 32n) | 0;
      if (o === 0xbff8) return this.mtime() | 0;
      if (o === 0xbffc) return Math.floor(this.mtime() / 2 ** 32) | 0;
      return 0;
    }
    if (a >= UART0_BASE && a < UART0_BASE + 0x1000) {
      const o = a - UART0_BASE, u = this.uart;
      if (o === 0x00) return 0;                                  // txdata: never full
      if (o === 0x04) { if (u.rx.length) { this.irqDirty = true; const c = u.rx.shift(); this.updateUartIrq(); return c; } return 0x80000000 | 0; }
      if (o === 0x08) return u.txctrl; if (o === 0x0c) return u.rxctrl; if (o === 0x10) return u.ie;
      if (o === 0x14) return 1 | (u.rx.length > ((u.rxctrl >>> 16) & 7) ? 2 : 0);
      if (o === 0x18) return u.div;
      return 0;
    }
    if (a >= 0x10000000 && a < 0x20000000) {
      this.hint('stub-' + (a & ~0xfff), `Accessed peripheral register 0x${a.toString(16)}. This peripheral isn't modelled: it reads back what was last written (0 at reset).`, 'info');
      return this.stubRegs.get(a) ?? 0;
    }
    return undefined;
  }
  mmioWrite(a, v) {
    if (a >= GPIO_BASE && a < GPIO_BASE + 0x1000) { this.gpioWrite(a - GPIO_BASE, v); return true; }
    if (a >= PLIC_BASE && a < PLIC_BASE + 0x4000000) { this.plicWrite(a - PLIC_BASE, v); return true; }
    if (a >= CLINT_BASE && a < CLINT_BASE + 0x10000) {
      const o = a - CLINT_BASE, c = this.clint;
      const big = BigInt.asUintN(64, BigInt(Math.min(c.mtimecmp, 2 ** 64 - 1)));
      if (o === 0) c.msip = v & 1;
      else if (o === 0x4000) c.mtimecmp = Number((big & 0xffffffff00000000n) | BigInt(v >>> 0));
      else if (o === 0x4004) c.mtimecmp = Number((big & 0xffffffffn) | (BigInt(v >>> 0) << 32n));
      else if (o === 0xbff8) c.mtimeOff += (v >>> 0) - (this.mtime() % 2 ** 32);
      else if (o === 0xbffc) c.mtimeOff += ((v >>> 0) - Math.floor(this.mtime() / 2 ** 32)) * 2 ** 32;
      this.irqDirty = true;
      this.replan = true;   // the timer deadline moved: run() must recompute where to stop
      return true;
    }
    if (a >= UART0_BASE && a < UART0_BASE + 0x1000) {
      const o = a - UART0_BASE, u = this.uart;
      if (o === 0x00) this.emit('uart', v & 0xff);
      else if (o === 0x08) u.txctrl = v; else if (o === 0x0c) u.rxctrl = v; else if (o === 0x10) { u.ie = v & 3; this.updateUartIrq(); } else if (o === 0x18) u.div = v;
      return true;
    }
    if (a >= 0x10000000 && a < 0x20000000) {
      this.hint('stub-' + (a & ~0xfff), `Wrote peripheral register 0x${a.toString(16)}. This peripheral isn't modelled: the write is stored but has no effect.`, 'info');
      this.stubRegs.set(a, v | 0);
      return true;
    }
    return false;
  }
  uartInput(str) { for (const b of new TextEncoder().encode(str)) this.uart.rx.push(b); this.updateUartIrq(); }
  updateUartIrq() {
    const u = this.uart;
    const ip = 1 | (u.rx.length > ((u.rxctrl >>> 16) & 7) ? 2 : 0);
    const l = (u.ie & ip) ? 1 : 0;
    if (this.plic.level[3] !== l) { this.plic.level[3] = l; this.plicGateway(); }
  }

  // -------------------------------------------------------------- CSRs
  csrRead(n) {
    switch (n) {
      case 0x300: return this.mstatus;
      case 0x301: return 0x40101105;           // RV32 IMAC + U
      case 0x304: return this.mie;
      case 0x305: return this.mtvec;
      case 0x340: return this.mscratch;
      case 0x341: return this.mepc;
      case 0x342: return this.mcause;
      case 0x343: return this.mtval;
      case 0x344: return this.mip;
      case 0xb00: case 0xc00: return (this.cycles + this.mcycleOff) | 0;
      case 0xb80: case 0xc80: return Math.floor((this.cycles + this.mcycleOff) / 2 ** 32) | 0;
      case 0xb02: case 0xc02: return (this.instret + this.minstretOff) | 0;
      case 0xb82: case 0xc82: return Math.floor((this.instret + this.minstretOff) / 2 ** 32) | 0;
      case 0xf11: return 0x489;
      case 0xf12: return 0x80000007 | 0;
      case 0xf13: return 0x20181004;
      case 0xf14: return 0;
      case 0x306: case 0x320: return 0;
    }
    if (n >= 0x3a0 && n <= 0x3bf) return this.stubRegs.get(-n) ?? 0;   // PMP: stored, not enforced
    if ((n >= 0xb03 && n <= 0xb1f) || (n >= 0xb83 && n <= 0xb9f) || (n >= 0x323 && n <= 0x33f)) return 0;
    return undefined;
  }
  csrWrite(n, v) {
    v >>>= 0;
    switch (n) {
      case 0x300: this.mstatus = (v & 0x88) | 0x1800; this.irqDirty = true; return true;   // MIE, MPIE; MPP fixed to M
      case 0x301: return true;
      case 0x304: this.mie = v & 0x888; this.irqDirty = true; return true;
      case 0x305: {
        const mode = v & 3;
        if (mode >= 2) this.hint('mtvec-mode', `Wrote 0x${v.toString(16)} to mtvec. Its low 2 bits are the MODE field (0 = direct, 1 = vectored), so the handler address must be 4-byte aligned. Put .align 2 before the handler label.`);
        else if (mode === 1 && (v & 0x3c)) this.hint('mtvec-vec', `mtvec is in vectored mode, which needs a 64-byte-aligned base (FE310 manual Table 16).`, 'info');
        this.mtvec = (v & ~2) >>> 0;
        return true;
      }
      case 0x340: this.mscratch = v; return true;
      case 0x341: this.mepc = (v & ~1) >>> 0; return true;
      case 0x342: this.mcause = v & 0x8000001f; return true;
      case 0x343: this.mtval = v; return true;
      case 0x344: return true;   // MEIP/MTIP/MSIP are read-only here
      case 0xb00: this.mcycleOff += v - ((this.cycles + this.mcycleOff) % 2 ** 32); return true;
      case 0xb80: return true;
      case 0xb02: this.minstretOff += v - ((this.instret + this.minstretOff) % 2 ** 32); return true;
      case 0xb82: case 0x306: case 0x320: return true;
    }
    if (n >= 0x3a0 && n <= 0x3bf) { this.stubRegs.set(-n, v | 0); return true; }
    if ((n >= 0xb03 && n <= 0xb1f) || (n >= 0xb83 && n <= 0xb9f) || (n >= 0x323 && n <= 0x33f)) return true;
    return false;
  }

  // -------------------------------------------------------------- traps
  takeTrap(cause, tval, isIrq, pc) {
    this.mepc = pc >>> 0;
    this.mcause = isIrq ? (0x80000000 | cause) >>> 0 : cause;
    this.mtval = isIrq ? 0 : tval >>> 0;
    const mie = (this.mstatus >>> 3) & 1;
    this.mstatus = (this.mstatus & ~0x88) | (mie << 7) | 0x1800;
    const base = this.mtvec & ~3;
    this.pc = (base + ((this.mtvec & 1) && isIrq ? 4 * cause : 0)) >>> 0;
    this.trapCount++;
    if (this.opts.timing === 'e31') this.cycles += 3;
    this.irqDirty = true;
    this.emit('trap', { cause, isIrq, tval, epc: pc, handler: this.pc, cycle: this.cycles });
    if (this.pc === this.bootSyms.earlyTrap) {
      const what = isIrq ? IRQ_NAMES[cause] ?? `interrupt ${cause}` : CAUSES[cause] ?? `exception ${cause}`;
      this.halt('trap', `${what} at ${this.srcOf(pc)} (mepc=0x${(pc >>> 0).toString(16)}${isIrq ? '' : `, mtval=0x${(tval >>> 0).toString(16)}`}) before your program set mtvec. On the board this lands in the SDK's early_trap_vector and the program stops.` + this.trapAdvice(cause, tval, isIrq));
      return;
    }
    if (base === 0 || this.mtvec === 0) {
      this.halt('trap', `Trap (${isIrq ? IRQ_NAMES[cause] : CAUSES[cause]}) with mtvec = 0: the CPU jumped to address 0 and stopped.`);
      return;
    }
    if (!isIrq) {
      const isUserHandler = !!this.program?.addrToLoc.get(this.pc);
      this.hint('exc-' + cause, `Exception: ${CAUSES[cause]} at ${this.srcOf(pc)} (mtval=0x${(tval >>> 0).toString(16)}). The CPU jumped to the mtvec handler${isUserHandler ? ` at ${this.srcOf(this.pc)}` : ''} with mcause=${cause}.` + this.trapAdvice(cause, tval, isIrq), 'error');
    }
  }
  trapAdvice(cause, tval, isIrq) {
    if (isIrq) return '';
    tval >>>= 0;
    if ((cause === 5 || cause === 7) && tval < LAYOUT.ram && tval >= LAYOUT.ram - 0x1000) return ' The address is just below RAM: the stack probably overflowed (sp went below 0x80000000).';
    if (cause === 4 || cause === 6) return ' Loads and stores must be aligned: lw/sw need addresses that are multiples of 4, lh/sh multiples of 2.';
    if ((cause === 5 || cause === 7) && tval < 0x1000) return ' The address is near 0: a base register probably held 0 or a small number instead of an address.';
    if (cause === 2) return ' The CPU fetched something that isn\'t an instruction — often execution ran past the end of your code into data or padding.';
    if (cause === 1) return ' Execution jumped to an address with no code (check jr/jalr/ret targets and saved ra values).';
    return '';
  }
  halt(kind, msg) { this.halted = { kind, msg, pc: this.pc, cycle: this.cycles }; this.emit('halt', this.halted); }

  checkInterrupts() {
    this.irqDirty = false;
    const pend = this.mip & this.mie;
    if (!pend) return false;
    if (this.waiting) this.waiting = false;
    if (!((this.mstatus >>> 3) & 1)) {
      if (pend & (1 << 11)) this.notedPendingMasked = this.notedPendingMasked ?? this.cycles;
      return false;
    }
    const cause = pend & (1 << 11) ? 11 : pend & (1 << 3) ? 3 : 7;
    this.isrEntries = (this.isrEntries ?? []);
    this.isrEntries.push(this.cycles);
    if (this.isrEntries.length > 64) this.isrEntries.shift();
    if (this.isrEntries.length === 64 && this.cycles - this.isrEntries[0] < this.opts.hz * 0.001) {
      const g = this.gpio, stuck = (g.fall_ip & g.fall_ie) | (g.rise_ip & g.rise_ie);
      this.hint('storm', `Interrupt storm: the handler was entered 64 times in under 1 ms. ` + (stuck ? `GPIO interrupt pending bits are still set (fall_ip & fall_ie = 0x${(g.fall_ip & g.fall_ie).toString(16)}), so the interrupt re-fires as soon as the ISR returns. Clear the pending bit by writing a 1 to it (fall_ip, offset 0x24).` : `Something keeps the interrupt line asserted.`), 'error');
    }
    this.takeTrap(cause, 0, true, this.pc);
    this.inIsrSince = this.cycles;
    return true;
  }

  // -------------------------------------------------------------- execution
  fetch(pc) {
    const f = pc - 0x20000000;
    if (f >= 0 && f + 4 <= this.flashSize) {
      if (pc & 1) throw new Trap(0, pc);
      let d = this.decoded[f >> 1];
      if (d === undefined) d = this.decoded[f >> 1] = decode(this.flashDV.getInt32(f, true));
      return d;
    }
    const it = pc - 0x08000000;
    if (it >= 0 && it + 4 <= 0x2000) return decode(this.itimDV.getInt32(it, true));
    throw new Trap(1, pc);
  }

  step() {
    if (this.halted) return false;
    if (this.irqDirty && this.checkInterrupts()) return !this.halted;   // stop at the handler's first instruction
    if (this.waiting) return true;
    const pc = this.pc;
    this.curPc = pc;
    let d;
    try {
      d = this.fetch(pc);
      this.exec(d, pc);
    } catch (e) {
      if (e instanceof Trap) { this.cycles += 1; this.takeTrap(e.cause, e.tval, false, pc); return !this.halted; }
      throw e;
    }
    return !this.halted;
  }

  // read register with E31 scoreboard stall accounting
  exec(d, pc) {
    const x = this.x;
    const e31 = this.opts.timing === 'e31';
    let next = (pc + 4) >>> 0;
    let cyc = 1;
    if (e31) {
      const r1 = this.ready[d.s1], r2 = this.ready[d.s2];
      const need = Math.max(r1, r2);
      if (need > this.cycles) cyc += need - this.cycles;
    }
    const a = x[d.rs1], b = x[d.rs2];
    let rd = d.rd, val = 0, write = true, lat = 1;
    switch (d.k) {
      case K.LUI: val = d.imm; break;
      case K.AUIPC: val = (pc + d.imm) | 0; break;
      case K.JAL: val = next; next = (pc + d.imm) >>> 0; if (e31) cyc += this.predictJump(pc, next, rd === 1 || rd === 5, false); break;
      case K.JALR: {
        val = next; next = ((a + d.imm) & ~1) >>> 0;
        if (e31) cyc += this.predictJump(pc, next, rd === 1 || rd === 5, (d.rs1 === 1 || d.rs1 === 5) && rd === 0);
        break;
      }
      case K.BEQ: case K.BNE: case K.BLT: case K.BGE: case K.BLTU: case K.BGEU: {
        write = false;
        let t;
        switch (d.k) {
          case K.BEQ: t = a === b; break; case K.BNE: t = a !== b; break;
          case K.BLT: t = a < b; break; case K.BGE: t = a >= b; break;
          case K.BLTU: t = (a >>> 0) < (b >>> 0); break; default: t = (a >>> 0) >= (b >>> 0);
        }
        if (t) next = (pc + d.imm) >>> 0;
        if (e31) cyc += this.predictBranch(pc, t);
        break;
      }
      case K.LB: case K.LH: case K.LW: case K.LBU: case K.LHU: {
        const addr = (a + d.imm) >>> 0;
        const size = d.k === K.LW ? 4 : (d.k === K.LH || d.k === K.LHU) ? 2 : 1;
        val = this.load(addr, size, d.k === K.LB || d.k === K.LH);
        lat = size === 4 ? 2 : 3;
        if (e31 && (addr & ~3) === this.lastStore.addr && this.cycles - this.lastStore.cycle < 3) cyc += 5;
        break;
      }
      case K.SB: case K.SH: case K.SW: {
        write = false;
        const addr = (a + d.imm) >>> 0;
        this.store(addr, d.k === K.SW ? 4 : d.k === K.SH ? 2 : 1, b);
        this.lastStore.addr = addr & ~3; this.lastStore.cycle = this.cycles;
        break;
      }
      case K.ADDI: val = (a + d.imm) | 0; break;
      case K.SLTI: val = a < d.imm ? 1 : 0; break;
      case K.SLTIU: val = (a >>> 0) < (d.imm >>> 0) ? 1 : 0; break;
      case K.XORI: val = a ^ d.imm; break;
      case K.ORI: val = a | d.imm; break;
      case K.ANDI: val = a & d.imm; break;
      case K.SLLI: val = a << d.imm; break;
      case K.SRLI: val = (a >>> d.imm) | 0; break;
      case K.SRAI: val = a >> d.imm; break;
      case K.ADD: val = (a + b) | 0; break;
      case K.SUB: val = (a - b) | 0; break;
      case K.SLL: val = a << (b & 31); break;
      case K.SLT: val = a < b ? 1 : 0; break;
      case K.SLTU: val = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
      case K.XOR: val = a ^ b; break;
      case K.SRL: val = (a >>> (b & 31)) | 0; break;
      case K.SRA: val = a >> (b & 31); break;
      case K.OR: val = a | b; break;
      case K.AND: val = a & b; break;
      case K.MUL: val = Math.imul(a, b); lat = 5; break;
      case K.MULH: val = mulh(a, b); lat = 5; break;
      case K.MULHSU: val = mulhsu(a, b); lat = 5; break;
      case K.MULHU: val = mulhu(a, b) | 0; lat = 5; break;
      case K.DIV: val = b === 0 ? -1 : (a === -0x80000000 && b === -1) ? a : (a / b) | 0; lat = divLat(a); break;
      case K.DIVU: val = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0; lat = divLat(a >>> 0); break;
      case K.REM: val = b === 0 ? a : (a === -0x80000000 && b === -1) ? 0 : a % b; lat = divLat(a); break;
      case K.REMU: val = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0; lat = divLat(a >>> 0); break;
      case K.CSRRW: case K.CSRRS: case K.CSRRC: case K.CSRRWI: case K.CSRRSI: case K.CSRRCI: {
        const n = d.imm;
        const src = d.k >= K.CSRRWI ? d.rs1 : a;
        const isW = d.k === K.CSRRW || d.k === K.CSRRWI;
        const doWrite = isW || d.rs1 !== 0;
        const doRead = !(isW && rd === 0);
        const old = this.csrRead(n);
        if (old === undefined && (doRead || doWrite)) throw new Trap(2, d.w);
        if (doWrite) {
          if ((n >>> 10) === 3) throw new Trap(2, d.w);  // read-only CSR
          const nv = isW ? src : (d.k === K.CSRRS || d.k === K.CSRRSI) ? old | src : old & ~src;
          if (!this.csrWrite(n, nv)) throw new Trap(2, d.w);
          if (e31) cyc += 5;
          if (n === 0x300 || n === 0x304) this.noteEnables();
        }
        val = old | 0; lat = 3;
        if (!doRead) write = false;
        break;
      }
      case K.ECALL: this.cycles += cyc; this.takeTrap(11, 0, false, pc); return;
      case K.EBREAK: this.cycles += cyc; this.instret++; this.pc = next; this.ebreakHit = pc; return;
      case K.MRET: {
        write = false;
        const mpie = (this.mstatus >>> 7) & 1;
        this.mstatus = (this.mstatus & ~0x8) | (mpie << 3) | 0x80 | 0x1800;
        next = this.mepc;
        this.inIsrSince = undefined;
        if (e31) cyc += 3;
        this.irqDirty = true;
        if (this.plic.claimed.length && this.mcause === (0x8000000b >>> 0)) {
          const ids = this.plic.claimed.join(', ');
          this.hint('no-complete', `mret with PLIC source ${ids} claimed but never completed. Until you write the ID back to the claim/complete register (0x0C200004), the PLIC won't deliver that source again.`, 'error');
        }
        break;
      }
      case K.WFI: write = false; if (!(this.mip & this.mie)) this.waiting = true; break;
      case K.FENCE: write = false; break;
      case K.LR: val = this.load(a >>> 0, 4, true); this.resv = (a >>> 0) & ~3; lat = 2; break;
      case K.SC: if (this.resv === ((a >>> 0) & ~3)) { this.store(a >>> 0, 4, b); val = 0; } else val = 1; this.resv = -1; break;
      case K.AMO: {
        const addr = a >>> 0;
        const old = this.load(addr, 4, true);
        let nv;
        switch (d.f) {
          case 0: nv = (old + b) | 0; break; case 1: nv = b; break; case 4: nv = old ^ b; break;
          case 12: nv = old & b; break; case 8: nv = old | b; break;
          case 16: nv = Math.min(old, b); break; case 20: nv = Math.max(old, b); break;
          case 24: nv = (old >>> 0) < (b >>> 0) ? old : b; break; default: nv = (old >>> 0) > (b >>> 0) ? old : b;
        }
        this.store(addr, 4, nv);
        val = old; lat = 2;
        break;
      }
      default: throw new Trap(2, d.w);
    }
    if (write && rd !== 0) {
      x[rd] = val;
      this.xInit[rd] = 1;
      if (e31) this.ready[rd] = this.cycles + cyc + lat - 1;
    }
    this.cycles += cyc;
    this.instret++;
    this.pc = next;
  }
  noteEnables() {
    if ((this.mstatus & 8) && (this.mie & 0x800)) this.notedPendingMasked = undefined;
  }
  predictBranch(pc, taken) {
    const c = this.bht.get(pc) ?? 1;
    const pred = c >= 2;
    this.bht.set(pc, taken ? Math.min(3, c + 1) : Math.max(0, c - 1));
    return pred === taken ? 0 : 3;
  }
  predictJump(pc, target, isCall, isRet) {
    let pen = 0;
    if (isRet && this.ras.length) { if (this.ras.pop() !== target) pen = 3; }
    else if (this.btb.get(pc) !== target) pen = 3;
    this.btb.set(pc, target);
    if (isCall) { this.ras.push((pc + 4) >>> 0); if (this.ras.length > 2) this.ras.shift(); }
    return pen;
  }

  // Run until `limit` cycles, a breakpoint, or a halt. Returns a reason string.
  run(limit, opts = {}) {
    const skipBp = opts.skipBreakpointAt;
    let first = true;
    const bps = this.breakpoints;
    while (this.cycles < limit) {
      if (this.halted) return 'halt';
      while (this.events.length && this.events[0].cycle <= this.cycles) this.events.shift().fn();
      const tc = this.timerCycle();
      let end = limit;
      if (this.events.length && this.events[0].cycle < end) end = this.events[0].cycle;
      if (tc > this.cycles && tc < end) end = tc;
      if (tc <= this.cycles && !this.timerFired) { this.timerFired = true; this.irqDirty = true; }
      if (tc > this.cycles) this.timerFired = false;
      this.irqDirty = true;
      if (this.waiting) {
        this.checkInterrupts();
        if (this.waiting) { this.cycles = Math.max(this.cycles, end); continue; }
      }
      while (this.cycles < end) {
        if (this.irqDirty) { this.checkInterrupts(); if (this.halted) return 'halt'; if (this.waiting) break; }
        if (bps.size && bps.has(this.pc) && !(first && this.pc === skipBp)) return 'break';
        first = false;
        if (this.pc === this.bootSyms.returned) {
          this.halt('returned', `Your program returned from ${this.program.entryName ?? 'its entry point'} (ret with ra pointing back into the startup code). On the board, the SDK's _enter then spins in an endless loop.`);
          return 'halt';
        }
        if (!this.step()) return this.halted ? 'halt' : 'stop';
        if (this.ebreakHit !== undefined) { this.lastEbreak = this.ebreakHit; this.ebreakHit = undefined; return 'ebreak'; }
        if (this.stopRequest) { const r = this.stopRequest; this.stopRequest = null; return r; }
        if (this.waiting) break;
        if (this.replan) { this.replan = false; break; }
      }
    }
    return 'limit';
  }

  // brightness of each pin since the last call (0..1), for drawing LEDs
  sampleBrightness() {
    const now = this.cycles;
    const span = now - (this.lastSample ?? 0);
    const dt = now - this.pinLastChange;
    const lit = this.pinLevels & this.pinDriven;
    const out = new Float32Array(32);
    for (let i = 0; i < 32; i++) {
      let hc = this.pinHighCycles[i];
      if (lit & (1 << i)) hc += dt;
      out[i] = span > 0 ? Math.min(1, hc / span) : ((lit >>> i) & 1);
      this.pinHighCycles[i] = 0;
    }
    this.pinLastChange = now;
    this.lastSample = now;
    return out;
  }

  // Diagnostics for "my interrupt doesn't fire" and "my ISR never returns"; called by the UI a few times a second.
  checkStuck() {
    const hz = this.opts.hz, g = this.gpio, p = this.plic;
    if (this.inIsrSince !== undefined && this.cycles - this.inIsrSince > 0.3 * hz)
      this.hint('long-isr', `The CPU has been inside the interrupt handler for over 0.3 s (since ${(this.inIsrSince / hz).toFixed(3)} s) without mret. ISRs should do a small, bounded amount of work — no delay loops or waiting for buttons inside the ISR.`, 'warn');
    const lp = this.lastPress;
    if (lp && this.cycles - lp.cycle > 0.05 * hz && this.cycles - lp.cycle < 2 * hz) {
      const pin = PINS[lp.name], id = 8 + pin, bit = 1 << pin;
      const fired = this.trapCountAtPress !== undefined && this.trapCount > this.trapCountAtPress;
      if (!fired && (this.mie & 0x800 || p.enable[id] || g.fall_ie & bit)) {
        let why = null;
        if (!(g.input_en & bit)) why = `input_en bit ${pin} is 0, so the GPIO block never sees the pin change (edges are only detected on enabled inputs).`;
        else if (!((g.fall_ie | g.rise_ie | g.low_ie | g.high_ie) & bit)) why = `no GPIO interrupt is enabled for pin ${pin}: set bit ${pin} in fall_ie (offset 0x20) for a falling-edge (press) interrupt.`;
        else if (!p.enable[id]) why = `PLIC source ${id} (GPIO ${pin}) isn't enabled: set bit ${id} of the enable register at 0x0C002000.`;
        else if (p.prio[id] === 0) why = `PLIC source ${id} has priority 0, which means "never interrupt". Write a priority to 0x0C000000 + 4×${id} = 0x${(PLIC_BASE + 4 * id).toString(16)}.`;
        else if (p.prio[id] <= p.threshold) why = `PLIC source ${id} has priority ${p.prio[id]}, not above the threshold ${p.threshold} (0x0C200000).`;
        else if (p.inflight[id]) why = `PLIC source ${id} was claimed earlier and never completed (write ${id} to 0x0C200004 in the ISR), so the PLIC holds it back.`;
        else if (!(this.mie & 0x800)) why = `mie bit 11 (MEIE, machine external interrupts) is 0.`;
        else if (!(this.mstatus & 8)) why = this.inIsrSince !== undefined ? `the CPU is still inside a previous interrupt handler (mstatus.MIE is 0 until mret).` : `mstatus bit 3 (MIE, global interrupt enable) is 0.`;
        if (why) this.hint('nofire-' + lp.name + '-' + why.slice(0, 20), `${lp.name} was pressed but no interrupt was taken: ${why}`, 'info');
      }
    }
  }

  regName(i) { return ABI[i]; }
  disasmAt(pc) { try { return disasm(this.load(pc, 4, false) >>> 0, pc); } catch { return '??'; } }
}

function divLat(a) {
  // 1-bit-per-cycle divider with early out: 2…33 cycles depending on the dividend's size
  const bits = 32 - Math.clz32(Math.abs(a) >>> 0);
  return Math.max(2, Math.min(33, bits + 1));
}
