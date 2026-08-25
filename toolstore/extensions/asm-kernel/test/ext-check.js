#!/usr/bin/env node
/**
 * ext-check（手动——仓库无 scripts/tools/ext-check.ts）：按 PTH 装载通道语义验证 asm-kernel
 *  1. 与 ext-registry/ext-capability 同款 new Function 包装 eval（module/exports + index.js）
 *  2. factory(ctx) → 校验 {tools, kernels, create} 契约
 *  3. 工具冒烟：status / simulate（探索核）+ build/run（生产核 aarch64 原生——真实 as/ld）
 * 用法：node test/ext-check.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(dir, "index.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${detail ?? ""}`); } };

(async () => {
  // ── 1. 装载通道语义（与 ext-registry.evalFactory / ext-capability.use 同款）──
  const wrapped = `"use strict";
    const module = { exports: {} };
    const exports = module.exports;
    ${code}
    return module.exports.default ?? module.exports;`;
  const fn = new Function(wrapped)();
  ok("factory 可装载（new Function eval）", typeof fn === "function", `typeof=${typeof fn}`);

  // ctx 模拟：exec 受控通道（真实 child_process 包装）+ log
  const { execFile } = require("child_process");
  const ctx = {
    log: () => {},
    exec: (cmd, args, opts = {}) => new Promise((resolve) => {
      execFile(cmd, args ?? [], { timeout: opts.timeoutMs ?? 30000, maxBuffer: (opts.maxOutputBytes ?? 4 * 1024 * 1024) }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: String(stderr || err.message), code: err.code });
        else resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
      });
    }),
  };
  const mod = await fn(ctx);
  ok("factory 返回契约 {tools, kernels, create}", mod && typeof mod.tools === "object" && Array.isArray(mod.kernels) && typeof mod.create === "function",
    `tools=${Object.keys(mod?.tools ?? {}).length} kernels=${mod?.kernels?.map((k) => k.language).join(",")}`);
  ok("工具齐全（7）", ["assemble", "link", "build", "run", "disasm", "simulate", "status"].every((t) => typeof mod.tools[t] === "function"),
    Object.keys(mod.tools).join(","));
  ok("kernels 含 asm + asm-sim", mod.kernels.some((k) => k.language === "asm") && mod.kernels.some((k) => k.language === "asm-sim"));
  const k = mod.create({});
  ok("create(ctx) → Interpreter 接口", k && k.language === "asm" && ["execute", "reset", "dispose", "snapshot"].every((m) => typeof k[m] === "function"));

  // ── 2. 探索核 simulate 工具（RV32I 纯 JS——不依赖系统工具链）──
  const simSrc = `
    .text
  _start:
    li a0, 1
    la a1, msg
    li a2, 6
    li a7, 64
    ecall
    li a0, 0
    li a7, 93
    ecall
    .data
  msg: .asciz "sim-ok"
  `;
  const s = await mod.tools.simulate({ source: simSrc });
  ok("simulate 工具（RV32I）", s.ok === true && s.result.stdout === "sim-ok" && s.result.exitCode === 0 && s.result.steps > 0,
    JSON.stringify(s));

  // ── 3. 生产核 aarch64 原生冒烟（真实 as/ld——容器已有）──
  const hello = `
    .global _start
    .text
  _start:
    mov x0, #1
    adr x1, msg
    mov x2, #11
    mov x8, #64
    svc #0
    mov x0, #0
    mov x8, #93
    svc #0
    .data
  msg: .ascii "hello asm!\\n"
  `;
  const st = await mod.tools.status({});
  ok("status 工具", st.ok === true && st.result.host === "aarch64" && st.result.perTarget.aarch64.ok === true,
    JSON.stringify(st.result?.perTarget));
  const b = await mod.tools.build({ source: hello, target: "aarch64" });
  ok("build（aarch64 原生 as+ld）", b.ok === true && !!b.result.binaryRef, JSON.stringify(b).slice(0, 200));
  const r = await mod.tools.run({ binaryRef: b.result?.binaryRef, target: "aarch64" });
  ok("run（host 直跑）", r.ok === true && r.result.stdout === "hello asm!\n" && r.result.exitCode === 0,
    JSON.stringify(r).slice(0, 300));
  const d = await mod.tools.disasm({ binaryRef: b.result?.binaryRef });
  ok("disasm（objdump -d）", d.ok === true && /_start|<.*>:/i.test(d.result?.text ?? ""), JSON.stringify(d).slice(0, 120));

  // ── 4. 交叉目标冒烟（x86_64：交叉 as/ld -static + qemu-x86_64 + per-target objdump）──
  // 工具缺失 = FAIL（与 v1.3 Task 5 纪律一致：不 skip）；需要
  // binutils-x86-64-linux-gnu + qemu-user（见 README §5 / deploy/Dockerfile）。
  const helloX86 = `
    .global _start
    .text
_start:
    mov $1, %rax
    mov $1, %rdi
    lea msg(%rip), %rsi
    mov $11, %rdx
    syscall
    mov $60, %rax
    xor %rdi, %rdi
    syscall
    .data
msg: .ascii "hello asm!\\n"
  `;
  const xb = await mod.tools.build({ source: helloX86, target: "x86_64" });
  ok("build（x86_64 交叉 as+ld -static）", xb.ok === true && !!xb.result.binaryRef, JSON.stringify(xb).slice(0, 200));
  const xr = await mod.tools.run({ binaryRef: xb.result?.binaryRef, target: "x86_64" });
  ok("run（qemu-x86_64 包装）", xr.ok === true && xr.result.stdout === "hello asm!\n" && xr.result.exitCode === 0,
    JSON.stringify(xr).slice(0, 300));
  const xd = await mod.tools.disasm({ binaryRef: xb.result?.binaryRef, target: "x86_64" });
  ok("disasm（x86_64-linux-gnu-objdump）", xd.ok === true && /syscall/.test(xd.result?.text ?? "") && xd.result?.objdump === "x86_64-linux-gnu-objdump",
    JSON.stringify(xd).slice(0, 200));

  console.log(`\n=== ext-check 汇总: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ext-check 异常:", e); process.exit(1); });
