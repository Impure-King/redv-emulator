// Cross-check this assembler against GNU binutils (riscv64-elf-as/ld), section by section.
// Usage: node test/compare-gnu.mjs file.S [more.h ...]
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { assemble } from '../js/asm.js';

const [main, ...extra] = process.argv.slice(2);
const files = {};
for (const f of [main, ...extra]) files[basename(f)] = readFileSync(f, 'utf8');
const r = assemble(files, basename(main));
if (!r.ok) { console.log('ASSEMBLER ERRORS', r.errors); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'rvcmp-'));
for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
execFileSync('clang', ['-E', '-P', '-x', 'assembler-with-cpp', join(dir, basename(main)), '-o', join(dir, 'pp.s')]);
execFileSync('riscv64-elf-as', ['-march=rv32ima_zicsr_zifencei', '-mabi=ilp32', '-mno-relax', join(dir, 'pp.s'), '-o', join(dir, 'a.o')]);
writeFileSync(join(dir, 'l.ld'), `SECTIONS { . = 0x20010000; .text : { *(.text) } . = ALIGN(8); .rodata : { *(.rodata) } . = 0x80000000; .data : { *(.data) } . = ALIGN(8); .bss : { *(.bss) } }`);
execFileSync('riscv64-elf-ld', ['-m', 'elf32lriscv', '--no-relax', '-T', join(dir, 'l.ld'), join(dir, 'a.o'), '-o', join(dir, 'a.elf')]);
let bad = 0;
for (const sec of ['text', 'rodata', 'data']) {
  execFileSync('riscv64-elf-objcopy', ['-O', 'binary', '-j', '.' + sec, join(dir, 'a.elf'), join(dir, sec + '.bin')]);
  const gnu = readFileSync(join(dir, sec + '.bin'));
  const mine = r.image[sec];
  if (gnu.length !== mine.length) { console.log(`${sec}: size gnu=${gnu.length} mine=${mine.length}`); bad++; }
  for (let i = 0; i + 4 <= Math.min(gnu.length, mine.length); i += 4) {
    const g = gnu.readUInt32LE(i), m = mine[i] | mine[i + 1] << 8 | mine[i + 2] << 16 | (mine[i + 3] << 24 >>> 0);
    if (g >>> 0 !== m >>> 0) {
      bad++;
      const ent = r.listing.find((l) => l.addr <= r.bases[sec] + i && r.bases[sec] + i < l.addr + l.size);
      console.log(`${sec}+0x${i.toString(16)}: gnu=${(g >>> 0).toString(16).padStart(8, '0')} mine=${(m >>> 0).toString(16).padStart(8, '0')}  ${ent ? ent.file + ':' + ent.line + '  ' + ent.src.trim() : ''}`);
      if (bad > 40) break;
    }
  }
}
const nm = execFileSync('riscv64-elf-nm', [join(dir, 'a.elf')]).toString().trim().split('\n');
for (const l of nm) {
  const [addr, , name] = l.split(' ');
  const s = r.symbols.get(name);
  if (s && s.kind === 'label' && (s.v >>> 0) !== parseInt(addr, 16)) { console.log(`symbol ${name}: gnu=${addr} mine=${(s.v >>> 0).toString(16)}`); bad++; }
}
console.log(bad ? `MISMATCHES: ${bad}` : `OK: ${basename(main)} matches GNU as byte for byte (${r.image.text.length} B text, ${r.image.rodata.length} B rodata, ${r.image.data.length} B data)`);
process.exit(bad ? 1 : 0);
