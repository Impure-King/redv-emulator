// Headless tests: node test/run-tests.mjs
import { readFileSync } from 'node:fs';
import { assemble } from '../js/asm.js';
import { Board, PINS } from '../js/board.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✕', name, extra); } };
const ex = (f) => readFileSync(new URL('../examples/' + f, import.meta.url), 'utf8');
const build = (src, name = 't.S', extra = {}) => assemble({ [name]: src, ...extra }, name);
const boardFor = (prog, opts = {}) => { const b = new Board({ randomizeRegs: false, ...opts }); b.loadProgram(prog); return b; };
const ledVal = (v) => { let n = 0; PINS.leds.forEach((p, i) => { if ((v >>> p) & 1) n |= 1 << i; }); return n; };
const HZ = 16e6;

console.log('assembler');
{
  const r = build(ex('led-chaser.S'));
  ok(r.ok, 'led-chaser.S builds');
  const u = build(ex('uart-hello.S'));
  ok(u.ok, 'uart-hello.S builds');
  const e = build('_start:\n  addi t0, t0\n  lw t1, 0(t9)\n  j nowhere\n');
  ok(!e.ok && e.errors.length === 3, 'reports each bad line', JSON.stringify(e.errors?.map((x) => x.msg)));
  ok(e.errors?.[0]?.line === 2, 'error carries its line number');
  const c = build('#include "defs.h"\n_start:\n  li t0, MASK\n  li t1, (1 << 3) | 4\nloop: j loop\n', 'm.S', { 'defs.h': '#define MASK 0x00FC0C00\n' });
  ok(c.ok, 'preprocessor #include / #define');
  const b = boardFor(c); b.run(200);
  ok((b.x[5] >>> 0) === 0x00FC0C00 && b.x[6] === 12, 'li with large and expression constants');
  const up = build('_start:\n  LI T0, 5\n');
  ok(!up.ok, 'uppercase mnemonics/registers rejected like GNU as');
}

console.log('cpu');
{
  const src = `_start:
  li a0, 10
  li a1, 0
1: add a1, a1, a0
  addi a0, a0, -1
  bnez a0, 1b
  li t0, -7
  li t1, 2
  div t2, t0, t1
  rem t3, t0, t1
  mulh t4, t0, t0
  la s0, buf
  li t5, 0x12345678
  sw t5, 0(s0)
  lbu t6, 1(s0)
  lh s1, 2(s0)
  jal ra, f
  addi s3, s2, 1
done: j done
f: li s2, 41
  ret
  .data
buf: .word 0
`;
  const r = build(src); ok(r.ok, 'program builds', JSON.stringify(r.errors));
  const b = boardFor(r); b.run(2000);
  ok(b.x[11] === 55, 'loop sum = 55');
  ok(b.x[7] === -3 && b.x[28] === -1, 'div/rem truncate toward zero');
  ok(b.x[29] === 0, 'mulh high word');
  ok(b.x[31] === 0x56 && b.x[9] === 0x1234, 'little-endian byte/half loads');
  ok(b.x[19] === 42, 'jal/ret');
}

console.log('timing');
{
  const r = build(ex('led-chaser.S'));
  const b = boardFor(r);
  b.run(HZ * 0.6);
  const t = b.gpioLog.map((e) => e.cycle / HZ);
  const d = t.slice(2).map((x, i) => x - t[i + 1]);
  ok(d.length >= 3 && d.every((x) => Math.abs(x - 0.125) < 0.001), 'delay loop of 1,000,000 x 2 cycles = 125 ms at 16 MHz', d.map((x) => x.toFixed(5)).join(','));
  const vals = b.gpioLog.map((e) => ledVal(e.value));
  ok(vals.slice(0, 4).join(',') === '1,2,4,8', 'LEDs light in order 0,1,2,3', vals.join(','));
}

console.log('uart');
{
  const b = boardFor(build(ex('uart-hello.S')));
  let out = '';
  b.on('uart', (c) => { out += String.fromCharCode(c); });
  b.run(HZ * 0.05);
  ok(out === 'Hello from the FE310-G002!\n', 'UART0 output', JSON.stringify(out));
}

console.log('timer interrupt (CLINT)');
{
  const src = `_start:
  la t0, handler
  csrw mtvec, t0
  li s0, 0x02004000      # mtimecmp
  li t0, 3277            # ~0.1 s at 32.768 kHz
  sw t0, 0(s0)
  sw zero, 4(s0)
  li t0, 1 << 7
  csrs mie, t0
  csrsi mstatus, 8
  li s1, 0
spin: j spin
  .align 2
handler:
  addi s1, s1, 1
  lw t0, 0(s0)
  li t1, 3277
  add t0, t0, t1
  sw t0, 0(s0)
  mret
`;
  const r = build(src); ok(r.ok, 'builds', JSON.stringify(r.errors));
  const b = boardFor(r);
  b.run(HZ * 1.05);
  ok(b.x[9] === 10, 'ten timer interrupts in 1.05 s', String(b.x[9]));
  ok((b.mcause >>> 0) === 0x80000007, 'mcause = machine timer interrupt');
}

console.log('exceptions and hints');
{
  const r = build('_start:\n  li t0, 0x80000001\n  lw t1, 0(t0)\nx: j x\n');
  const b = boardFor(r);
  const traps = []; b.on('trap', (t) => traps.push(t));
  b.run(500);
  ok(traps.length >= 1 && traps[0].cause === 4, 'misaligned load raises cause 4');
  const r2 = build('_start:\n  li s0, 0x10012000\n  li t0, 0x00FC0C00\n  sw t0, 0x0C(s0)\nx: j x\n');
  const b2 = boardFor(r2);
  const hints = []; b2.on('hint', (h) => hints.push(h.msg));
  b2.run(HZ * 0.01); b2.checkStuck();
  ok(hints.some((m) => /output_en/.test(m)), 'hint when output_val is written without output_en', hints.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
