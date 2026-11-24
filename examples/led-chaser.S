# ------------------------------------------------------------------
# Example: LED chaser
# Lights one LED at a time across the LED bar, using a lookup table
# of pin masks in .rodata and a busy-wait delay loop.
#
# Try: set a breakpoint (click left of a line number), press Run,
# then Step through the loop and watch the registers change.
# ------------------------------------------------------------------
        .equ GPIO_BASE,  0x10012000
        .equ OUTPUT_EN,  0x08
        .equ OUTPUT_VAL, 0x0C
        .equ LED_PINS,   0x00FC0C00      # LED bar: GPIO 10, 11, 18-23

        .section .text
        .align 2
        .globl _start
_start:
        li   s0, GPIO_BASE
        li   t0, LED_PINS
        sw   t0, OUTPUT_EN(s0)           # make the LED pins outputs

next_pass:
        la   s1, led_masks               # s1 walks through the table
        li   s2, 8                       # 8 LEDs per pass
next_led:
        lw   t0, 0(s1)
        sw   t0, OUTPUT_VAL(s0)          # light exactly one LED
        li   a0, 1000000                 # 1,000,000 x 2 cycles = 0.125 s at 16 MHz
        jal  ra, delay
        addi s1, s1, 4
        addi s2, s2, -1
        bnez s2, next_led
        j    next_pass

# delay: spins a0 times (2 instructions per iteration)
delay:
        addi a0, a0, -1
        bnez a0, delay
        ret

        .section .rodata
led_masks:                               # LED0 ... LED7
        .word 1<<10, 1<<11, 1<<18, 1<<19, 1<<20, 1<<21, 1<<22, 1<<23
