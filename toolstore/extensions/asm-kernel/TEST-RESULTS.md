# asm-kernel 测试结果（2026-08-12 · 容器 aarch64/Debian12/node v22.23.2）

## 1. 模拟器单测（node test/run-sim-tests.js）——11 PASS / 0 FAIL

| 用例 | 覆盖（设计 §5.2/5.3） | 结果 |
|---|---|---|
| 运算+write/exit | li/addi 伪指令展开、ecall(write/exit)、.asciz | PASS（stdout="hello rv32i\n" exit=0） |
| slt/beq 分支 | B/R 型、if-else 结构 | PASS（走正确分支 "yes"） |
| jal/jalr 子例程 | call/ret 伪指令、auipc+jalr 展开、返回地址 | PASS（"20" exit=0） |
| lw/sw 数组求和 | S/I 型、内存、减法拆位循环 | PASS（"15" exit=0） |
| 死循环止损 | maxSteps / timeoutMs 双护栏 | PASS（均触发止损） |
| 未知助记符报错 | 汇编错误行号 | PASS（line=2） |
| 缺标签报错 | 两遍汇编符号解析 | PASS |
| 内存越界报错 | OOB 边界检查 + PC 上下文 | PASS |
| 未知 syscall 报错 | syscall 白名单（仅 write/exit） | PASS |
| li 大立即数+la/lw 编码 | lui/addi 展开、绝对寻址 | PASS（0x1C3F6285 LE 正确） |

## 2. ext-check（工厂装载 + 工具冒烟——node test/ext-check.js）——10 PASS / 0 FAIL

- factory 可装载（new Function eval——与 ext-registry/ext-capability 同装载通道）
- 返回契约 {tools, kernels, create}；7 工具齐全；kernels 含 asm + asm-sim
- create(ctx) → Interpreter 接口（execute/reset/dispose/snapshot）
- simulate 工具（RV32I 探索核——不依赖系统工具链）stdout="sim-ok"
- status 工具：host=aarch64，perTarget.aarch64 {as✓ ld✓ qemu✗ ok✓}（host 直跑无需 qemu）
- build（aarch64 原生 as+ld）→ binaryRef；run（host 直跑）stdout="hello asm!\n" exit=0
- disasm（objdump -d）成功

## 3. kernel 接口验证（Interpreter 语义）

- asm 核 execute(buildOnly) → {ok, value:{binaryRef}}；execute() → {ok, value:{stdout,exitCode}, stdout}
- asm-sim 核 execute → {ok, value:{steps,exitCode}, stdout}（"sim\n" steps=9）
- snapshot → {cacheEntries, workDir}；reset 清缓存（已测）

## 4. agent-tools 接线补丁模拟验证（对照 dist kernel-manager 语义）——6/6

- ensureAsmKernel 惰性注册（toolstore 读 index.js → eval → registerKernel("asm")）✓
- WeakSet 防重复注册 ✓；dev.build(.s) buildOnly ✓；dev.run(.s) 全流程 ✓（stdout="patch" exit=0）
- C 路径不受影响 ✓；内置语言保护（拒绝覆盖 c）✓

## 5. 生产核 aarch64 原生冒烟（test/smoke-aarch64.sh）——PASS

`as hello-aarch64.s → ld → ./hello` stdout="hello asm!" exit=0（容器已有 binutils 2.40）

## 6. plugin.json manifest 校验

`parseExtManifest`（/app/dist/pth/kernel/extensions/ext-manifest.js 实装）校验通过——
ExtManifestSchema 支持 contracts.kernels（ExtKernelSchema: language/impl/mode）→ 字段保留；
`activation` 字段 schema 不支持 → 已省略。

## 已知限制 / 待监督层

- x86_64/riscv64 交叉 + qemu-user 未安装（status 探测缺失并提示）——Dockerfile 增补见 README §5
- ext.use/ext-registry 装载通道硬编码读 `index.ts`——asm-kernel 按任务约定用 `index.js`
  （SDK/checkJs 友好）；官方通道若需装载，加一个 index.ts shim（或等通道支持 .js 回退）。
  agent-tools 接线补丁按任务契约读 `index.js`——已实测通过。
- 探索核 v1 仅 RV32I（arch=rv32i）；syscall 仅 write/exit——满足设计 §3。
