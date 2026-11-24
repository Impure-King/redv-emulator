# ------------------------------------------------------------------
# Example: print over UART0
# Text written to UART0's txdata register appears in the Console tab.
# ------------------------------------------------------------------
        .equ UART0,  0x10013000
        .equ TXDATA, 0x00                # write a byte; bit 31 reads 1 while the FIFO is full

        .section .text
        .align 2
        .globl _start
_start:
        li   s0, UART0
        la   s1, msg
print:
        lbu  t0, 0(s1)
        beqz t0, done
wait:
        lw   t1, TXDATA(s0)
        bltz t1, wait                    # FIFO full? (bit 31 set -> negative)
        sw   t0, TXDATA(s0)
        addi s1, s1, 1
        j    print
done:
        j    done

        .section .rodata
msg:    .asciz "Hello from the FE310-G002!\n"
