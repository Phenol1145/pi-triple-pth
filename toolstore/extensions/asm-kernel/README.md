# asm-kernel —— PTH 多平台汇编开发核

> toolstore 扩展（代码库式——不动 PTH 内核；仅 agent-tools dev.build/dev.run 极小接线，见
> `agent-tools.asm.patch`）。设计：memory kind=design-doc（2026-08-12）。
> 入口 `index.js`（SDK 约定：`/// <reference path="../sdk.d.ts" />` + `// @ts-check` +
> `module.exports = factory(ctx)`——eval 通道友好；模拟器段由 `test/build-index.js` 从
> `rv32i-sim.js` 注入，二者同源勿手工改 index.js 模拟器段）。

## 1. 工具（7）

| 工具 | 签名 | 语义 |
|---|---|---|
| assemble | `({source?\|path?, target?})` | 汇编 .s → .o（按 target 选 as/交叉 as）——单一阶段 |
| link | `({objRef?\|path?, target?, static?})` | 链接 .o → 可执行（交叉默认 -static——纯 syscall 无 libc 依赖） |
| build | `({source?\|path?, target?, static?})` | as+ld 合并（对标 dev.build 语义；sha256 增量缓存） |
| run | `({binaryRef?\|path?, target?, args?, timeoutMs?})` | 执行：target==host 直接跑；否则 qemu-<arch> 包装（受控子进程） |
| disasm | `({objRef?\|binaryRef?\|path?, target?})` | objdump -d 反汇编 |
| simulate | `({source?\|path?, arch="rv32i", maxSteps?, timeoutMs?, stdin?})` | 探索核：RV32I 纯 JS 解释执行（不碰系统工具链） |
| status | `({})` | 工具链可用性诊断（{host, perTarget:{aarch64,x86_64,riscv64:{as,ld,qemu,ok}}}） |

限制（生产核）：编译超时 60s（as/ld 毫秒级）、运行超时默认 10s（上限 30s）、输出上限 4MB、
sha256 增量缓存（`<workDir>/.build-cache/asm/{sha}/{main.s,main.o,main}`——workDir =
`PTH_WORKSPACES_PATH` 或 cwd 下的 `.asm-work`）。
限制（探索核）：maxSteps=1_000_000（可配）、timeoutMs=2000（可配）、code 64KiB + data 64KiB、
syscall 仅 write/exit。

## 2. kernels

- `asm`（生产核）：`create(ctx) → {language:"asm", execute(program, {buildOnly?, target?, timeoutMs?}), reset, dispose, snapshot}`
  —— 与 dev.build/dev.run 接线（见 patch）。execute 返回 `{ok, value, stdout, stderr, durationMs}`。
- `asm-sim`（探索核）：`create(ctx) → {language:"asm-sim", execute(program, {maxSteps?, timeoutMs?}), ...}`
  —— RV32I 模拟器（`rv32i-sim.js` 可独立 `require` 复用）。

## 3. 探索核指令集（RV32I 核心子集）

- R 型：`add sub sll srl sra and or xor slt sltu`
- I 型：`addi slti sltiu xori ori andi slli srli srai lb lw lui auipc jalr`
- S 型：`sb sw`；B 型：`beq bne blt bge bltu bgeu`；U/J：`jal`
- SYSTEM：`ecall`（a7=64 write / a7=93 exit；其余拒绝）、`ebreak`
- 伪指令：`li mv nop la call ret j`
- 节指令：`.text .data .ascii .asciz .word .byte .align .space` + 标签（两遍汇编）+ `.globl/.global`（忽略）
- 寄存器别名：`x0..x31` + ABI 名（zero/ra/sp/gp/tp/t0-t2/s0-s2/a0-a7/t3-t6）
- 语法：`lw rd, off(rs1)` / `sw rs2, off(rs1)` 均支持

## 4. 每架构 syscall ABI 模板（纯 syscall——无 libc）

### aarch64（生产核·原生——host 直跑）
```
.global _start
.text
_start:
    mov x0, #1            // fd = stdout
    adr x1, msg
    mov x2, #12           // len
    mov x8, #64           // write 号
    svc #0
    mov x0, #0            // exit code
    mov x8, #93           // exit 号
    svc #0
.data
msg: .ascii "hello asm!\n"
```
`as hello.s -o hello.o && ld hello.o -o hello && ./hello`（容器已实测 ✓）

### x86_64（生产核·交叉——需 binutils-x86-64-linux-gnu + qemu-user，见 §5）
```
.global _start
.text
_start:
    mov $1, %rax          // write 号
    mov $1, %rdi          // fd = stdout
    lea msg(%rip), %rsi
    mov $12, %rdx         // len
    syscall
    mov $60, %rax         // exit 号
    xor %rdi, %rdi
    syscall
.data
msg: .ascii "hello asm!\n"
```
`x86_64-linux-gnu-as hello.s -o hello.o && x86_64-linux-gnu-ld -static hello.o -o hello && qemu-x86_64 hello`

### riscv64（生产核·交叉——需 binutils-riscv64-linux-gnu + qemu-user）
```
.global _start
.text
_start:
    li a0, 1              // fd = stdout
    la a1, msg
    li a2, 12             // len
    li a7, 64             // write 号
    ecall
    li a0, 0
    li a7, 93             // exit 号
    ecall
.data
msg: .ascii "hello asm!\n"
```
`riscv64-linux-gnu-as hello.s -o hello.o && riscv64-linux-gnu-ld -static hello.o -o hello && qemu-riscv64 hello`

### rv32i（探索核 simulate——纯 JS）
```
.text
_start:
    li a0, 1
    la a1, msg
    li a2, 12
    li a7, 64             // write 号
    ecall
    li a0, 0
    li a7, 93             // exit 号
    ecall
.data
msg: .asciz "hello rv32i\n"
```
`node -e "console.log(require('./rv32i-sim.js').simulate(process.argv[1]))" "$(cat hello.s)"`

ABI 对照：syscall 号统一放 `x8`（aarch64）/ `rax`（x86_64）/ `a7`（riscv64/rv32i）；
参数依次 `x0-x5` / `rdi,rsi,rdx,r10,r8,r9` / `a0-a5`；`svc #0`（aarch64）/ `syscall`（x86_64）/ `ecall`（riscv）。

## 5. Dockerfile 增补（镜像构建期——sandbox 无外网；监督层确认）

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    binutils \                    # 原生 as/ld（本镜像已含——幂等保留）
    qemu-user \                   # qemu-aarch64 / qemu-x86_64 / qemu-riscv64（用户态）
    binutils-x86-64-linux-gnu \   # x86_64-linux-gnu-as / -ld（交叉）
    binutils-riscv64-linux-gnu \  # riscv64-linux-gnu-as / -ld（交叉）
    && rm -rf /var/lib/apt/lists/*
```

## 6. 测试

- `node test/run-sim-tests.js` —— 模拟器单测（运算/分支/子例程/数组求和/死循环止损 + 失败路径）
- `node test/ext-check.js` —— 工厂装载（new Function eval 同装载通道）+ 工具冒烟（status/simulate/build/run/disasm）
- `node test/build-index.js` —— 从 rv32i-sim.js 重建 index.js（注入模拟器段）
- aarch64 原生冒烟：见 §4 模板（as→ld→run——容器已实测）

## 7. 安装（监督层）

将 `plugin.json`、`index.js`、`rv32i-sim.js`、`README.md` 落入 `toolstore/extensions/asm-kernel/`；
应用 `agent-tools.asm.patch`（src/pth/kernel/execution/agent-tools.ts——dev.build/dev.run 按
扩展名分发 + asm 惰性注册）；重启 batch。零 PTH 改动即可用：ts 空间
`ext.use("asm-kernel", {tool:"build", args:{source, target}})` / `ext.kernel("asm-kernel")`。
