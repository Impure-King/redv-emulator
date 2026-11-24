#define BASE 0x10012000
#define BIT(n) (1 << (n))
.equ OFF, 0x0C
.equ BIG, 0x12345FFF
.section .text
.align 2
.globl _start
_start:
    add a0, a1, a2
    sub t0, t1, t2
    sll s0, s1, a0
    slt a3, a4, a5
    sltu a6, a7, s2
    xor s3, s4, s5
    srl s6, s7, s8
    sra s9, s10, s11
    or t3, t4, t5
    and t6, zero, ra
    mul a0, a1, a2
    mulh a0, a1, a2
    mulhsu a0, a1, a2
    mulhu a0, a1, a2
    div a0, a1, a2
    divu a0, a1, a2
    rem a0, a1, a2
    remu a0, a1, a2
    addi sp, sp, -16
    addi a0, a0, 2047
    addi a0, a0, -2048
    slti a0, a1, -1
    sltiu a0, a1, 1
    xori a0, a1, 0x7ff
    ori a0, a1, 0x555
    andi a0, a1, 0xFC
    slli a0, a1, 31
    srli a0, a1, 1
    srai a0, a1, 7
    lb a0, -1(sp)
    lh a0, 2(sp)
    lw a0, OFF(s0)
    lbu a0, 0(a1)
    lhu a0, (a1)
    sb a0, -100(sp)
    sh a1, 6(sp)
    sw ra, 12(sp)
    lui a0, 0x10012
    auipc a0, 0xfffff
    li t0, BASE
    li t1, 2047
    li t2, -2048
    li t3, 2048
    li t4, BIG
    li t5, 0xFFFFFFFF
    li t6, 0x80000000
    li a0, BIT(11)
    li a1, (1 << 3)
    li a2, 0x7FFFF800
    li a3, -1
    li a4, 16000000
    mv a0, a1
    not a0, a1
    neg a0, a1
    seqz a0, a1
    snez a0, a1
    sltz a0, a1
    sgtz a0, a1
    nop
    csrw mtvec, t0
    csrs mie, t0
    csrc mstatus, t1
    csrr t0, mstatus
    csrwi mstatus, 8
    csrsi mie, 3
    csrci mip, 31
    csrrw a0, mscratch, a1
    csrrs a0, mepc, zero
    csrrc a0, mcause, a1
    csrr a0, mhartid
    csrr a0, 0x7c1
    rdcycle a0
    rdinstret a1
    csrs mie, 8
    ecall
    ebreak
    mret
    wfi
    fence
    fence.i
    fence rw, rw
loop:
    beq a0, a1, loop
    bne a0, a1, fwd
    blt a0, a1, loop
    bge a0, a1, fwd
    bltu a0, a1, loop
    bgeu a0, a1, fwd
    beqz a0, loop
    bnez a0, fwd
    blez a0, loop
    bgez a0, fwd
    bltz a0, loop
    bgtz a0, fwd
    bgt a0, a1, loop
    ble a0, a1, fwd
    bgtu a0, a1, loop
    bleu a0, a1, fwd
1:  j 1b
    j 2f
2:  jal fwd
    jal ra, loop
    jal t0, fwd
    jalr t0
    jalr ra, 4(t1)
    jalr a0, a1, -8
    jr t1
    ret
fwd:
    la a0, table
    la a1, msg
    lla a2, buf
    call helper
    tail helper
    lw a3, table
    sw a3, buf, t0
    amoadd.w a0, a1, (a2)
    lr.w a0, (a1)
    sc.w a2, a1, (a0)
    amoswap.w a0, a1, (a2)
helper:
    ret
    .align 4
after_align:
    nop
    lui a0, %hi(msg)
    addi a0, a0, %lo(msg)
3:  auipc a1, %pcrel_hi(buf)
    addi a1, a1, %pcrel_lo(3b)
.section .rodata
table:
    .word 1, 2, 0xdeadbeef, table, _start
    .half 0x17, 0x1D5
    .byte 1, 2, 3, 'A', -1
msg: .asciz "Hi\n\t\"x\""
    .ascii "ab"
    .balign 4
    .space 6, 0xAA
    .zero 3
    .string "z"
.data
buf: .word 0
     .byte 7
.bss
big: .space 64
