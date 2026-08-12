#!/usr/bin/env node
/**
 * rv32i-sim 单元测试（设计 §5.2/5.3）——Node 直接 require rv32i-sim.js
 * 用例：运算 / 分支 / 子例程 / 数组求和 / 死循环止损 + 失败路径（未知助记符/缺标签/内存越界）
 * 运行：node test/run-sim-tests.js  → 每用例 PASS/FAIL + 汇总
 */
"use strict";
const path = require("path");
const { assemble, simulate } = require(path.join(__dirname, "..", "rv32i-sim.js"));

let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) { pass++; results.push(`PASS  ${name}`); }
  else { fail++; results.push(`FAIL  ${name}  ${detail ?? ""}`); }
}

// ── 用例 1：运算 + write/exit（li/addi 伪指令展开）──
{
  const src = `
    .text
    .global _start
  _start:
    li x5, 42
    addi x5, x5, 1          # x5 = 43
    li a0, 1
    la a1, msg
    li a2, 12
    li a7, 64
    ecall                   # write(1, msg, 12)
    li a0, 0
    li a7, 93
    ecall                   # exit(0)
    .data
  msg: .asciz "hello rv32i\\n"
  `;
  const r = simulate(src);
  check("运算+write/exit", r.ok === true && r.stdout === "hello rv32i\n" && r.exitCode === 0,
    JSON.stringify({ ok: r.ok, stdout: r.stdout, exitCode: r.exitCode, error: r.error }));
}

// ── 用例 2：slt/beq 分支（if-else）──
{
  const src = `
    .text
  _start:
    li x5, 10
    li x6, 20
    slt x7, x5, x6          # x7 = 1 (10<20)
    beq x7, x0, LSE         # x7!=0 → 不走 else
    li a0, 1
    la a1, mYes
    li a2, 3
    li a7, 64
    ecall
    j LEND
  LSE:
    li a0, 1
    la a1, mNo
    li a2, 3
    li a7, 64
    ecall
  LEND:
    li a0, 0
    li a7, 93
    ecall
    .data
  mYes: .asciz "yes"
  mNo:  .asciz "no"
  `;
  const r = simulate(src);
  check("slt/beq 分支", r.ok === true && r.stdout === "yes" && r.exitCode === 0,
    JSON.stringify({ ok: r.ok, stdout: r.stdout, exitCode: r.exitCode, error: r.error }));
}

// ── 用例 3：jal/jalr 子例程（call/ret 伪指令）──
{
  const src = `
    .text
  _start:
    li a0, 5
    call twice             # 返回地址入 ra；twice: a0 = a0*2*2 = 20
    la a1, res
    sw a0, 0(a1)           # res = 20
    # 输出 res 的两位十进制（20）：'2' '0'
    la x15, res
    lw x13, 0(x15)         # x13 = 20
    li x14, 10
    # 十位 = 20/10 = 2（减法循环——RV32I 无 div）
    li x16, 0
  tens:
    blt x13, x14, tensDone
    addi x16, x16, 1
    sub x13, x13, x14
    j tens
  tensDone:
    addi x16, x16, 48      # '2'
    addi x13, x13, 48      # '0'
    la x17, digits
    sb x16, 0(x17)
    sb x13, 1(x17)
    li a0, 1
    la a1, digits
    li a2, 2
    li a7, 64
    ecall
    li a0, 0
    li a7, 93
    ecall
  twice:
    add a0, a0, a0         # a0 *= 2
    add a0, a0, a0         # a0 *= 2
    ret
    .data
  res: .word 0
  digits: .byte 0, 0
  `;
  const r = simulate(src);
  check("jal/jalr 子例程", r.ok === true && r.stdout === "20" && r.exitCode === 0,
    JSON.stringify({ ok: r.ok, stdout: r.stdout, exitCode: r.exitCode, error: r.error, steps: r.steps }));
}

// ── 用例 4：lw/sw 数组求和（内存）──
{
  const src = `
    .text
  _start:
    la x10, arr
    li x11, 0              # sum
    li x12, 5              # count
  loop:
    lw x13, 0(x10)
    add x11, x11, x13
    addi x10, x10, 4
    addi x12, x12, -1
    bne x12, x0, loop
    # sum = 1+2+3+4+5 = 15 → 输出 "15"（减法拆位——RV32I 无 div/rem）
    li x14, 10
    li x15, 0              # 十位
    mv x16, x11            # 剩余 = 15
  tens:
    blt x16, x14, tensDone
    addi x15, x15, 1
    sub x16, x16, x14
    j tens
  tensDone:
    addi x15, x15, 48      # '1'
    addi x16, x16, 48      # '5'
    la x17, digits
    sb x15, 0(x17)
    sb x16, 1(x17)
    li a0, 1
    la a1, digits
    li a2, 2
    li a7, 64
    ecall
    li a0, 0
    li a7, 93
    ecall
    .data
  arr: .word 1, 2, 3, 4, 5
  digits: .byte 0, 0
  `;
  const r = simulate(src);
  check("lw/sw 数组求和", r.ok === true && r.stdout === "15" && r.exitCode === 0,
    JSON.stringify({ ok: r.ok, stdout: r.stdout, exitCode: r.exitCode, error: r.error }));
}

// ── 用例 5：死循环止损（maxSteps）──
{
  const src = `
    .text
  _start:
  spin:
    j spin
  `;
  const r = simulate(src, { maxSteps: 1000 });
  check("死循环止损(maxSteps)", r.ok === false && /步数超限|死循环/.test(r.error ?? ""),
    JSON.stringify({ ok: r.ok, error: r.error, steps: r.steps }));
  const r2 = simulate(src, { timeoutMs: 1, maxSteps: 1000000 });
  check("死循环止损(timeoutMs)", r2.ok === false && /超时/.test(r2.error ?? ""),
    JSON.stringify({ ok: r2.ok, error: r2.error, steps: r2.steps }));
}

// ── 失败路径 ──
{
  const r1 = assemble(".text\n  bogus x1, x2\n");
  check("未知助记符报错(带行号)", r1.ok === false && /bogus/.test(r1.error ?? "") && r1.line === 2,
    JSON.stringify({ ok: r1.ok, error: r1.error, line: r1.line }));

  const r2 = simulate(".text\n  li a0, 1\n  beq a0, a0, nolabel\n");
  check("缺标签报错", r2.ok === false && /未定义标签/.test(r2.error ?? ""),
    JSON.stringify({ ok: r2.ok, error: r2.error }));

  const r3 = simulate(`
    .text
  _start:
    li x11, 0x20000       # MEM_END 处（越界）
    lw x12, 0(x11)        # 读越界
    li a0, 0
    li a7, 93
    ecall
  `);
  check("内存越界报错(带PC上下文)", r3.ok === false && /越界/.test(r3.error ?? ""),
    JSON.stringify({ ok: r3.ok, error: r3.error }));

  const r4 = simulate(".text\n  ecall\n", { });  // a7=0 未知 syscall
  check("未知 syscall 报错", r4.ok === false && /syscall/.test(r4.error ?? ""),
    JSON.stringify({ ok: r4.ok, error: r4.error }));
}

// ── 额外：伪指令 la/li 大立即数 / auipc 正确性 ──
{
  const src = `
    .text
  _start:
    li x5, 0x12345678
    la x6, msg
    lw x7, 0(x6)
    add x8, x5, x7
    # x8 = 0x12345678 + 0x0A0B0C0D = 0x1D404285
    la x9, out
    sw x8, 0(x9)
    li a0, 1
    la a1, out
    li a2, 4
    li a7, 64
    ecall
    li a0, 0
    li a7, 93
    ecall
    .data
  msg: .word 0x0A0B0C0D
  out: .word 0
  `;
  const r = simulate(src);
  const out = r.stdout;
  // 期望 LE 字节 85 62 3F 1C（0x12345678 + 0x0A0B0C0D = 0x1C3F6285）
  const expect = String.fromCharCode(0x85, 0x62, 0x3f, 0x1c);
  check("li 大立即数+la/lw 编码", r.ok === true && out === expect && r.exitCode === 0,
    JSON.stringify({ ok: r.ok, stdoutHex: Buffer.from(out, "latin1").toString("hex"), error: r.error }));
}

console.log(results.join("\n"));
console.log(`\n=== 汇总: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
