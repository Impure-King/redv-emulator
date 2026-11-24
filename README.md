# RED-V Board Emulator

**Live site: https://impure-king.github.io/redv-emulator/**

A browser emulator for the SparkFun **RED-V Thing Plus** (SiFive **FE310-G002**, RV32IMAC) with the lab daughter board used in ECE 222 at the University of Waterloo: an 8-LED bar, a seven-segment display and two push buttons. Write or open a GNU-assembler `.S` file, press **Run**, and watch the board, registers, GPIO and interrupt state. Nothing to install: it's a static site and runs entirely in your browser.

## What it does
- **Assembler:** GNU `as` syntax with the C preprocessor subset `.S` files use (`#include`, `#define`, `#if…`), all RV32IMA + Zicsr instructions, the standard pseudo-instructions (`li`, `la`, `call`, `j`, `bnez`, `csrs`, …), local labels (`1b`/`1f`), `%hi`/`%lo`/`%pcrel_*`, macros and the common directives. Its output was checked **byte for byte against GNU binutils 2.47** (`test/compare-gnu.mjs`). Errors use GNU's wording plus a plain-language hint.
- **Board:** like the real board, the SDK's `_enter` sets `gp`, `sp` and a temporary `mtvec`, then calls your `_start`.
  - Code and `.rodata` live in flash at `0x20010000`; `.data`, `.bss` and the stack live in the 16 KiB DTIM at `0x80000000`.
  - **GPIO**, **PLIC**, **CLINT** and **UART0** are modelled at register level from the FE310-G002 manual:
    - `input_val` is gated by `input_en`.
    - `*_ip` bits latch on edges and clear when you write 1.
    - `iof_en` takes pins away from `output_val`.
    - PLIC priority must exceed threshold, and claim/complete goes through the gateway.
    - `mtime` runs at 32.768 kHz.
- **Timing:** 16 MHz with the E31 pipeline rules from the FE310 manual: loads take 2–3 cycles before their result can be used, `mul` 5, `div` up to 33, mispredicted branches cost 3, CSR writes 5. A two-instruction delay loop costs 2 cycles per iteration, as the lab manual assumes. There's also a simple 1-cycle-per-instruction mode.
- **Debugging:**
  - Breakpoints (inside ISRs too), step and step over.
  - Register, CSR, PLIC and GPIO bit views, a memory view and a listing with machine code.
  - A **timeline** of every LED and seven-segment change with timestamps.
  - A console that explains traps and common mistakes: output not enabled, IOF still on, an interrupt that never reaches the CPU, a missing PLIC complete, an interrupt storm, stack overflow.
- **Realism:**
  - LEDs show brightness from their duty cycle.
  - S2 bounces, because it isn't debounced on the real board.
  - Uninitialized registers and RAM hold random values.
  - Every one of these can be changed in Settings.

## Board reference
| Part | GPIO | Notes |
|---|---|---|
| LED bar LED0 … LED7 | 10, 11, 18, 19, 20, 21, 22, 23 | mask `0x00FC0C00`, 1 = on |
| Seven-segment a b c d e f g | 0 1 2 3 4 5 9 | mask `0x0000023F`, 1 = segment on |
| S1 / S2 | 12 / 13 | active low; PLIC sources 20 / 21 |

GPIO base `0x10012000`. PLIC: priority `0x0C000000 + 4·ID`, enable `0x0C002000`, threshold `0x0C200000`, claim/complete `0x0C200004`. CLINT: `mtimecmp` `0x02004000`, `mtime` `0x0200BFF8`. UART0 `0x10013000`.

## Known differences from real hardware
- The emulator emits uncompressed 32-bit encodings. The lab toolchain also uses compressed (RVC) instructions, so addresses can differ, but behaviour doesn't.
- Flash and instruction-cache miss latency isn't modelled. Neither are peripherals other than GPIO, PLIC, CLINT and UART0: their registers just read back what was written.
- Assumed, not measured: GPIO 2–5, 9, 16 and 17 start with `iof_en` set, so the seven-segment needs `iof_en` cleared, as the Lab 4 manual says. Change this under Settings.

## Development
Plain ES modules, no build step. Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000/`.

- `js/asm.js`: preprocessor and assembler
- `js/board.js`: CPU and devices
- `js/isa.js`: encodings and disassembler
- `js/app.js`: UI

Checks:
```
node test/compare-gnu.mjs test/encodings.S    # needs riscv64-elf-binutils and clang
```

The editor is [CodeMirror 5](https://codemirror.net/5/) (MIT), vendored in `vendor/`.

This is a study tool. It contains no lab solutions.
