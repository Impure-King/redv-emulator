// RV32IMA + Zicsr tables shared by the assembler, CPU and disassembler.

export const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];

export const REGS = (() => {
  const m = new Map();
  for (let i = 0; i < 32; i++) { m.set('x' + i, i); m.set(ABI[i], i); }
  m.set('fp', 8);
  return m;
})();

export const CSR_NAMES = {
  mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305, mcounteren: 0x306,
  mcountinhibit: 0x320, mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343,
  mbadaddr: 0x343, mip: 0x344,
  pmpcfg0: 0x3a0, pmpcfg1: 0x3a1, pmpcfg2: 0x3a2, pmpcfg3: 0x3a3,
  mcycle: 0xb00, minstret: 0xb02, mcycleh: 0xb80, minstreth: 0xb82,
  cycle: 0xc00, time: 0xc01, instret: 0xc02, cycleh: 0xc80, timeh: 0xc81, instreth: 0xc82,
  mvendorid: 0xf11, marchid: 0xf12, mimpid: 0xf13, mhartid: 0xf14,
};
for (let i = 0; i < 16; i++) CSR_NAMES['pmpaddr' + i] = 0x3b0 + i;
for (let i = 3; i < 32; i++) {
  CSR_NAMES['mhpmcounter' + i] = 0xb00 + i;
  CSR_NAMES['mhpmcounter' + i + 'h'] = 0xb80 + i;
  CSR_NAMES['mhpmevent' + i] = 0x320 + i;
}
export const CSR_BY_NUM = (() => {
  const m = new Map();
  for (const [k, v] of Object.entries(CSR_NAMES)) if (!m.has(v) && k !== 'mbadaddr') m.set(v, k);
  return m;
})();

// Real instructions: name -> [format, opcode, funct3, funct7/extra, operand syntax]
// Operand syntax letters: d=rd s=rs1 t=rs2 j=imm12 >=shamt o(s)=mem p=branch target a=jal target u=imm20 E=csr Z=uimm5
export const INSNS = {
  lui: ['U', 0x37, 0, 0, 'd,u'],
  auipc: ['U', 0x17, 0, 0, 'd,u'],
  jal: ['J', 0x6f, 0, 0, 'd,a'],
  jalr: ['I', 0x67, 0, 0, 'd,o(s)'],
  beq: ['B', 0x63, 0, 0, 's,t,p'], bne: ['B', 0x63, 1, 0, 's,t,p'],
  blt: ['B', 0x63, 4, 0, 's,t,p'], bge: ['B', 0x63, 5, 0, 's,t,p'],
  bltu: ['B', 0x63, 6, 0, 's,t,p'], bgeu: ['B', 0x63, 7, 0, 's,t,p'],
  lb: ['I', 0x03, 0, 0, 'd,o(s)'], lh: ['I', 0x03, 1, 0, 'd,o(s)'], lw: ['I', 0x03, 2, 0, 'd,o(s)'],
  lbu: ['I', 0x03, 4, 0, 'd,o(s)'], lhu: ['I', 0x03, 5, 0, 'd,o(s)'],
  sb: ['S', 0x23, 0, 0, 't,o(s)'], sh: ['S', 0x23, 1, 0, 't,o(s)'], sw: ['S', 0x23, 2, 0, 't,o(s)'],
  addi: ['I', 0x13, 0, 0, 'd,s,j'], slti: ['I', 0x13, 2, 0, 'd,s,j'], sltiu: ['I', 0x13, 3, 0, 'd,s,j'],
  xori: ['I', 0x13, 4, 0, 'd,s,j'], ori: ['I', 0x13, 6, 0, 'd,s,j'], andi: ['I', 0x13, 7, 0, 'd,s,j'],
  slli: ['SH', 0x13, 1, 0x00, 'd,s,>'], srli: ['SH', 0x13, 5, 0x00, 'd,s,>'], srai: ['SH', 0x13, 5, 0x20, 'd,s,>'],
  add: ['R', 0x33, 0, 0x00, 'd,s,t'], sub: ['R', 0x33, 0, 0x20, 'd,s,t'],
  sll: ['R', 0x33, 1, 0x00, 'd,s,t'], slt: ['R', 0x33, 2, 0x00, 'd,s,t'], sltu: ['R', 0x33, 3, 0x00, 'd,s,t'],
  xor: ['R', 0x33, 4, 0x00, 'd,s,t'], srl: ['R', 0x33, 5, 0x00, 'd,s,t'], sra: ['R', 0x33, 5, 0x20, 'd,s,t'],
  or: ['R', 0x33, 6, 0x00, 'd,s,t'], and: ['R', 0x33, 7, 0x00, 'd,s,t'],
  mul: ['R', 0x33, 0, 0x01, 'd,s,t'], mulh: ['R', 0x33, 1, 0x01, 'd,s,t'],
  mulhsu: ['R', 0x33, 2, 0x01, 'd,s,t'], mulhu: ['R', 0x33, 3, 0x01, 'd,s,t'],
  div: ['R', 0x33, 4, 0x01, 'd,s,t'], divu: ['R', 0x33, 5, 0x01, 'd,s,t'],
  rem: ['R', 0x33, 6, 0x01, 'd,s,t'], remu: ['R', 0x33, 7, 0x01, 'd,s,t'],
  csrrw: ['CSR', 0x73, 1, 0, 'd,E,s'], csrrs: ['CSR', 0x73, 2, 0, 'd,E,s'], csrrc: ['CSR', 0x73, 3, 0, 'd,E,s'],
  csrrwi: ['CSRI', 0x73, 5, 0, 'd,E,Z'], csrrsi: ['CSRI', 0x73, 6, 0, 'd,E,Z'], csrrci: ['CSRI', 0x73, 7, 0, 'd,E,Z'],
  ecall: ['FIX', 0x00000073], ebreak: ['FIX', 0x00100073], mret: ['FIX', 0x30200073],
  wfi: ['FIX', 0x10500073], 'fence.i': ['FIX', 0x0000100f],
};
export const AMO = {
  'lr.w': 0x02, 'sc.w': 0x03, 'amoswap.w': 0x01, 'amoadd.w': 0x00, 'amoxor.w': 0x04,
  'amoand.w': 0x0c, 'amoor.w': 0x08, 'amomin.w': 0x10, 'amomax.w': 0x14,
  'amominu.w': 0x18, 'amomaxu.w': 0x1c,
};

export const encR = (op, f3, f7, rd, rs1, rs2) =>
  ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
export const encI = (op, f3, rd, rs1, imm) =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
export const encS = (op, f3, rs1, rs2, imm) =>
  ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | op) >>> 0;
export const encB = (op, f3, rs1, rs2, imm) =>
  ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) |
    (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | op) >>> 0;
export const encU = (op, rd, imm20) => (((imm20 & 0xfffff) << 12) | (rd << 7) | op) >>> 0;
export const encJ = (op, rd, imm) =>
  ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) |
    (((imm >> 12) & 0xff) << 12) | (rd << 7) | op) >>> 0;

const sx = (v, bits) => (v << (32 - bits)) >> (32 - bits);
export const immI = (w) => w >> 20;
export const immS = (w) => ((w >> 25) << 5) | ((w >>> 7) & 0x1f);
export const immB = (w) => sx((((w >>> 31) & 1) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1), 13);
export const immJ = (w) => sx((((w >>> 31) & 1) << 20) | (((w >>> 12) & 0xff) << 12) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1), 21);

const hex = (v) => '0x' + (v >>> 0).toString(16);
const R = (i) => ABI[i];
const csrName = (n) => CSR_BY_NUM.get(n) || hex(n);

// Disassemble one 32-bit word (or 16-bit compressed parcel). Returns text like GNU objdump (ABI names).
export function disasm(w, pc = 0) {
  w >>>= 0;
  if ((w & 3) !== 3) return disasmC(w & 0xffff, pc);
  const op = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31,
    rs2 = (w >>> 20) & 31, f7 = w >>> 25;
  switch (op) {
    case 0x37: return `lui ${R(rd)},${hex(w >>> 12)}`;
    case 0x17: return `auipc ${R(rd)},${hex(w >>> 12)}`;
    case 0x6f: { const t = (pc + immJ(w)) >>> 0; return rd === 0 ? `j ${hex(t)}` : rd === 1 ? `jal ${hex(t)}` : `jal ${R(rd)},${hex(t)}`; }
    case 0x67: {
      const i = immI(w);
      if (rd === 0 && rs1 === 1 && i === 0) return 'ret';
      if (rd === 0 && i === 0) return `jr ${R(rs1)}`;
      if (rd === 1 && i === 0) return `jalr ${R(rs1)}`;
      return `jalr ${R(rd)},${i}(${R(rs1)})`;
    }
    case 0x63: {
      const n = ['beq', 'bne', '', '', 'blt', 'bge', 'bltu', 'bgeu'][f3]; if (!n) break;
      const t = hex(pc + immB(w));
      if (rs2 === 0 && (f3 === 0 || f3 === 1)) return `${f3 ? 'bnez' : 'beqz'} ${R(rs1)},${t}`;
      return `${n} ${R(rs1)},${R(rs2)},${t}`;
    }
    case 0x03: { const n = ['lb', 'lh', 'lw', '', 'lbu', 'lhu'][f3]; if (!n) break; return `${n} ${R(rd)},${immI(w)}(${R(rs1)})`; }
    case 0x23: { const n = ['sb', 'sh', 'sw'][f3]; if (!n) break; return `${n} ${R(rs2)},${immS(w)}(${R(rs1)})`; }
    case 0x13: {
      const i = immI(w);
      if (f3 === 0) {
        if (rd === 0 && rs1 === 0 && i === 0) return 'nop';
        if (rs1 === 0) return `li ${R(rd)},${i}`;
        if (i === 0) return `mv ${R(rd)},${R(rs1)}`;
        return `addi ${R(rd)},${R(rs1)},${i}`;
      }
      if (f3 === 1) return f7 ? `.word ${hex(w)}` : `slli ${R(rd)},${R(rs1)},${rs2}`;
      if (f3 === 5) return f7 === 0x20 ? `srai ${R(rd)},${R(rs1)},${rs2}` : f7 === 0 ? `srli ${R(rd)},${R(rs1)},${rs2}` : `.word ${hex(w)}`;
      if (f3 === 4 && i === -1) return `not ${R(rd)},${R(rs1)}`;
      if (f3 === 3 && i === 1) return `seqz ${R(rd)},${R(rs1)}`;
      return `${['', '', 'slti', 'sltiu', 'xori', '', 'ori', 'andi'][f3]} ${R(rd)},${R(rs1)},${i}`;
    }
    case 0x33: {
      if (f7 === 1) return `${['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'][f3]} ${R(rd)},${R(rs1)},${R(rs2)}`;
      if (f7 === 0x20 && f3 === 0) return rs1 === 0 ? `neg ${R(rd)},${R(rs2)}` : `sub ${R(rd)},${R(rs1)},${R(rs2)}`;
      if (f7 === 0x20 && f3 === 5) return `sra ${R(rd)},${R(rs1)},${R(rs2)}`;
      if (f7 !== 0) break;
      if (f3 === 3 && rs1 === 0) return `snez ${R(rd)},${R(rs2)}`;
      return `${['add', 'sll', 'slt', 'sltu', 'xor', 'srl', 'or', 'and'][f3]} ${R(rd)},${R(rs1)},${R(rs2)}`;
    }
    case 0x0f: return f3 === 1 ? 'fence.i' : 'fence';
    case 0x2f: {
      if (f3 !== 2) break;
      const f5 = f7 >>> 2;
      const n = Object.keys(AMO).find((k) => AMO[k] === f5); if (!n) break;
      if (f5 === 2) return `${n} ${R(rd)},(${R(rs1)})`;
      return `${n} ${R(rd)},${R(rs2)},(${R(rs1)})`;
    }
    case 0x73: {
      if (w === 0x00000073) return 'ecall';
      if (w === 0x00100073) return 'ebreak';
      if (w === 0x30200073) return 'mret';
      if (w === 0x10500073) return 'wfi';
      const csr = w >>> 20, c = csrName(csr);
      switch (f3) {
        case 1: return rd === 0 ? `csrw ${c},${R(rs1)}` : `csrrw ${R(rd)},${c},${R(rs1)}`;
        case 2: return rs1 === 0 ? `csrr ${R(rd)},${c}` : rd === 0 ? `csrs ${c},${R(rs1)}` : `csrrs ${R(rd)},${c},${R(rs1)}`;
        case 3: return rd === 0 ? `csrc ${c},${R(rs1)}` : `csrrc ${R(rd)},${c},${R(rs1)}`;
        case 5: return rd === 0 ? `csrwi ${c},${rs1}` : `csrrwi ${R(rd)},${c},${rs1}`;
        case 6: return rd === 0 ? `csrsi ${c},${rs1}` : `csrrsi ${R(rd)},${c},${rs1}`;
        case 7: return rd === 0 ? `csrci ${c},${rs1}` : `csrrci ${R(rd)},${c},${rs1}`;
      }
    }
  }
  return `.word ${hex(w)}`;
}

function disasmC(h, pc) {
  // Minimal: compressed code is never generated by this assembler, but show something sensible.
  return `.half ${hex(h)}`;
}
