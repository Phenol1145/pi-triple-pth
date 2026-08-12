# asm-kernel 设计：PTH 多平台汇编开发核（生产核 + 探索核）

> 角色：planner · 任务类型：design · 产出：本设计文档（落 memory kind=design-doc；附环境探测证据）
> 日期：2026-08-12 · 目标落地：toolstore/extensions/asm-kernel/（代码库式扩展，不动 PTH 内核；仅 agent-tools dev.build 极小接线）

---

## 0. 环境探测结论（exec 实测——先验证后设计）

| 项 | 实测结果 |
|---|---|
| 主机架构 | aarch64（uname -m；node process.arch=arm64） |
| OS | Debian 12 bookworm |
| 已装工具链 | binutils 2.40（as/ld 原生 aarch64）✓、gcc 12.2.0 ✓、binutils-aarch64-linux-gnu（aarch64-linux-gnu-* 全套含 gcc）✓ |
| 未装 | qemu-user（无任何 qemu）、binutils-x86-64-linux-gnu、binutils-riscv64-linux-gnu |
| 网络 | DNS 解析失败（EAI_AGAIN）——sandbox 无外网；/var/lib/apt/lists 空且属 root（apt-get update 权限拒绝）→ **运行时 apt 安装不可行，工具链必须在镜像构建期（Dockerfile）安装**（dev 容器方案 C 经验一致） |
| apt 缓存 | 局部索引可查：binutils / binutils-aarch64-linux-gnu / binutils-common / libbinutils（qemu 不在局部索引——包名以 Debian bookworm 官方 main 为准：qemu-user、binutils-x86-64-linux-gnu、binutils-riscv64-linux-gnu） |
| 原生 asm 冒烟 | **通过**：as+ld → 静态 ELF64 AArch64 EXEC（无 PT_INTERP）→ ./hello 输出 "hello asm!" exit=0 |

关键推论：
1. 原生 aarch64 目标**零安装**即可用（as/ld 已在容器内）。
2. 纯 syscall 汇编 + 静态链接（ld 不链 libc）→ 产物无 PT_INTERP → **qemu 运行不需要交叉 libc/-L 前缀**——交叉目标仅需交叉 binutils + qemu-user 两个包族。
3. dev 空间现状核实：spaceRegistry dev={kind:action, execTool:"dev", extraTools:["debug"]}；agent-tools dev.build/dev.run 硬编码 ctx.kernel.c.execute（已读源码确认）；KernelManager.registerKernel 拒绝覆盖 ts/python/bash/c、新语言入 extraKernels，且暴露 manager.execute(language,program,opts) 顶层路由（已读源码确认）——asm/asm-sim 语言名可用。

---

## 1. 扩展结构（toolstore/extensions/asm-kernel/）

### 1.1 目录与 manifest

```
toolstore/extensions/asm-kernel/
├── plugin.json          # 声明式 contracts（ExtManifestSchema 校验）
├── index.ts             # 工厂：module.exports = (ctx) => ({ tools, kernels, create })
├── toolchain.ts         # 生产核：as/ld/qemu 命令矩阵 + sha256 增量缓存（可选拆分）
├── rv32i-sim.ts         # 探索核：RV32I 纯 JS 模拟器（单文件自包含）
└── README.md            # 用法/指令集速查/每架构 syscall ABI 模板
```

### 1.2 plugin.json（ExtManifestSchema 对齐——ext-manifest.js 实测 schema）

```json
{
  "id": "asm-kernel",
  "name": "asm-kernel",
  "version": "0.1.0",
  "description": "多平台汇编开发核：生产核（as/ld+qemu 系统工具链——aarch64 原生 + x86_64/riscv64 交叉）+ 探索核（RV32I 纯 JS 模拟器）",
  "contracts": {
    "tools": ["assemble", "build", "link", "run", "disasm", "simulate", "status"],
    "kernels": [
      { "language": "asm",     "impl": "index.ts#createAsmKernel",     "mode": "compiled" },
      { "language": "asm-sim", "impl": "index.ts#createAsmSimKernel",  "mode": "repl" }
    ]
  },
  "activation": { "lazy": true },
  "compat": { "pluginApi": "0.7.0" }
}
```

### 1.3 index.ts 工具清单（每个工具签名+语义）

工厂约定（与 ext-capability.js 实测一致）：`module.exports = (ctx) => ({ tools, kernels, create })`；
kernels 契约：`create(ctx) => ({ language, execute, reset, dispose, snapshot })`（Interpreter 接口）。

| 工具 | 签名 | 语义 |
|---|---|---|
| assemble | ({source?\|path?, target?}) → {ok, objRef} | 汇编 .s → .o（as；按 target 选 as/交叉 as）——单一阶段 |
| link | ({objRef?, target?, static?}) → {ok, binaryRef} | 链接 .o → 可执行（ld；交叉默认 -static——纯 syscall 无 libc 依赖） |
| build | ({source?\|path?, target?, static?}) → {ok, binaryRef} | as+ld 合并（对标 dev.build 语义；sha256 增量缓存） |
| run | ({binaryRef\|path?, target?, args?, timeoutMs?}) → {stdout, stderr, exitCode, timedOut} | 执行：target==host 直接跑；否则 qemu-<arch> 包装（受控子进程） |
| disasm | ({objRef\|binaryRef?, target?}) → {text} | objdump -d 反汇编（验证/调试辅助） |
| simulate | ({source?\|path?, arch="rv32i", maxSteps?, timeoutMs?, stdin?}) → {stdout, exitCode, steps, error?} | 探索核：RV32I 纯 JS 解释执行（不碰系统工具链） |
| status | ({}) → {host, perTarget:{aarch64,x86_64,riscv64:{as,ld,qemu,ok}}} | 工具链可用性诊断（dev 空间排查用） |

语言命名与 dev 空间关系：
- 生产核语言 id = `asm`（KernelManager 非内置名——registerKernel 可注册；dev.build 按 .s 分发到 manager.execute("asm",…)）；
- 探索核语言 id = `asm-sim`（纯 JS，与 asm 并存——角色 exploreKernels 可声明 `["asm-sim"]` 给 explorer 族角色，A/B 并存互不干扰）；
- 均引用 toolstore 扩展代码（RCE 收敛：ext.kernel 拒绝任务内联代码——已核实源码拒绝分支）。

---

## 2. 生产核工具链方案

### 2.1 容器 Dockerfile 增补（pi-platform 镜像构建期——运行时无法装）

```dockerfile
# 多平台汇编工具链（asm-kernel 生产核依赖——镜像构建期安装，sandbox 无外网）
RUN apt-get update && apt-get install -y --no-install-recommends \
    binutils \                     # 原生 as/ld（本镜像已含——幂等保留）
    qemu-user \                    # qemu-aarch64 / qemu-x86_64 / qemu-riscv64（用户态）
    binutils-x86-64-linux-gnu \    # x86_64-linux-gnu-as / x86_64-linux-gnu-ld（交叉）
    binutils-riscv64-linux-gnu \   # riscv64-linux-gnu-as / riscv64-linux-gnu-ld（可选目标）
    && rm -rf /var/lib/apt/lists/*
```
- 用 `qemu-user` 而非 `qemu-user-static`：本设计显式调用 `qemu-<arch>`（静态变体仅为 binfmt_misc 自动处理而设——不需要）。
- 交叉目标不装交叉 libc（libc6-dev-*-cross）：v1 只支持**纯 syscall 汇编 + 静态链接**（as/ld 产物无 PT_INTERP → qemu 直跑）。libc 依赖的汇编程序留待 v2（届时补 `libc6-dev-amd64-cross` 等 + qemu -L 前缀）。

### 2.2 多平台命令矩阵（toolchain.ts）

| 目标 | as | ld | 运行 |
|---|---|---|---|
| aarch64（原生=host） | `as -o x.o x.s` | `ld -o x x.o`（默认静态） | `./x`（原生直跑——快） |
| x86_64（交叉） | `x86_64-linux-gnu-as -o x.o x.s` | `x86_64-linux-gnu-ld -static -o x x.o` | `qemu-x86_64 ./x` |
| riscv64（交叉·可选） | `riscv64-linux-gnu-as -o x.o x.s` | `riscv64-linux-gnu-ld -static -o x x.o` | `qemu-riscv64 ./x` |

- target 缺省 = host（aarch64）；显式 target 参数覆盖（dev.build args.target）。
- 运行出口统一走受控子进程通道：优先 `ctx.exec(cmd,args,{cwd,timeoutMs,maxOutputBytes})`（sandbox /exec 契约实测：POST {cmd,cwd,timeout}→{stdout,stderr,exitCode,timedOut}）；不可用时回退 kernel 内 execFile（与 compiled-kernel 同模式：timeout + maxBuffer 4MB）。
- 限制：编译超时 60s（as/ld 毫秒级）、运行超时默认 10s（上限 30s）、输出上限 4MB、sha256 增量缓存（复用 compiled-kernel 缓存模式：workDir/.build-cache/asm/{sha}/{main.s,main.o,main}）。

### 2.3 文件/产物管理

```
dev.write path=hello.s（任务工作区，相对路径防穿越——resolveArtifact 已核实）
  → dev.build path=hello.s target=x86_64
      readArtifact → ctx.kernel.execute("asm", src, {buildOnly:true, target})
        → 写 cacheDir/{sha}/main.s → as → main.o → ld → main（binaryRef=sha）
  → dev.run path=hello.s target=x86_64
      ctx.kernel.execute("asm", src, {target, timeoutMs})（缓存命中→直接 run）
        → target==host ? exec ./main : exec qemu-x86_64 ./main
  → {stdout:"hello asm!", exitCode:0, durationMs}
```
状态模型与编译核一致：文件即状态（无命名空间——跨 execute 靠工作区文件）；reset() 清构建缓存；snapshot() 产物清单。

---

## 3. 探索核模拟器方案（asm-sim——纯 JS）

### 3.1 指令集子集选型：**RISC-V RV32I 核心子集**（推荐）

候选对比（x86-64 子集 vs RV32I 子集）：
- **RV32I 优**：定长 32 位指令、6 种基础格式（R/I/S/B/U/J）、32 个统一寄存器（x0 恒 0）、无标志位（比较用 slt*）、无 modrm/REX 前缀等变长编码——纯 JS 解释器实现正确性可审计、规模小（汇编器 ~200 行 + 解释器 ~400 行单文件）；语义确定性高（无隐式标志状态 → 无隐藏 bug 面）。RV32I 是教学/探索事实标准（RARS/Ripes 同款）。
- **x86-64 子集优（仅一点）**：与生产核 x86_64 目标 ISA 对齐——探索代码可直接上生产。代价：变长指令/前缀/寻址模式使子集实现 2-3 倍大且易出角例；且生产核三目标中 x86_64 仅其一，对齐收益有限。
- **结论**：v1 选 RV32I 核心子集（安全、快、正确性高）；README 提供 syscall ABI 对照（RV32I ecall ↔ x86_64/aarch64 svc 语义同构——Linux ABI：a7/rax/x8=号，a0-a5/rdi..rsi..=参），探索代码概念上可迁移生产。若后续用户明确要 ISA 对齐，可增量加 x86-64 子集变体（explore arch 参数化，接口已预留）。

子集清单（RV32I base 37 条 + 伪指令）：
- R-type：add sub sll srl sra and or xor slt sltu
- I-type：addi slti sltiu xori ori andi slli srli srai lui auipc jalr lw lb
- S-type：sw sb
- B-type：beq bne blt bge bltu bgeu
- U-type：jal
- SYSTEM：ecall（syscall 表：write(1,buf,len)/exit(code)——其余拒绝）、ebreak（调试断点）
- 伪指令（汇编器展开）：li mv nop la call ret
- 节指令：.text .data .ascii .asciz .word .align .byte + 标签（两遍汇编）

### 3.2 实现结构（rv32i-sim.ts——单文件自包含 ~600-800 行）

```
lexer/line-parser（标签/指令/伪指令/节）
  → 两遍汇编器（第一遍标号定址；第二遍编码）→ Uint32Array(code) + Uint8Array(data)
  → 解释循环：fetch(4B LE) → decode(format) → execute
     register file: Int32Array(32)；memory: code 64KiB + data 64KiB（合计 128KiB 上限）
     PC 逐条 + step 计数 + Date.now() 墙钟
  → syscall 表：write→stdout 缓冲、exit→结束；未知→错误
```

### 3.3 限制（防失控——explore 安全边界）

| 限制 | 默认值 | 说明 |
|---|---|---|
| 指令数 | maxSteps=1_000_000（可配） | 死循环止损（含自旋检测提示） |
| 墙钟超时 | timeoutMs=2000（可配） | 解释器时间预算 |
| 内存 | code 64KiB + data 64KiB | 每 lw/sw/lb/sb 边界检查（OOB→清晰错误+PC 上下文） |
| syscall | 仅 write/exit | 无文件/网络/进程能力 |
| 非法指令 | 编码不在子集表 → 报错 | 含 PC/指令字上下文 |
| 输入 | 可选 stdin 缓冲（仅 read 预留） | v1 可不实现 read |

---

## 4. dev 空间接线推荐

### 推荐：**选项 b——dev.build/dev.run 按扩展名分发**（+ dev.build 内惰性自注册）

改动（agent-tools.ts——自修改指南路径 src/pth/kernel/execution/agent-tools.ts，~15 行）：

```ts
// dev.build 内（现硬编码 ctx.kernel.c）：
const ext = path.extname(str(args, "path")).toLowerCase();
const target = args.target ?? "aarch64";                 // 缺省 host
if (ext === ".s" || ext === ".S") {
  if (!ctx.kernel.asmRegistered) { /* 惰性注册：ctx.toolstore 读 extensions/asm-kernel/index.ts → eval → registerKernel("asm", create(ctx)) */ }
  const r = await ctx.kernel.execute("asm", code, { buildOnly: true, target });
  ...
}
// dev.run 同款：ext===".s" → ctx.kernel.execute("asm", code, { target, timeoutMs })
```

**论证（对照 a/b/c）**：
- RCE 收敛：kernel 代码只引用 toolstore 扩展（ext.kernel 已拒绝内联代码——源码核实）；dev.build 只读工作区产物（resolveArtifact 防穿越已核实）——两条既有安全边界不变。
- 最小改动：仅 dev.build/dev.run 两处加扩展名分发（~15 行）——比 (a) 新增 dev.asm.* 工具族（重复 build/run 管道 + schema + 门控）小一个量级；(c) 虽零改动，但 asm 只能经 ts 空间 ext.use 调用——**dev 空间语义断裂**：无 dev.write/save/list 产物流、无 dev 生产空间门控、worker 需离开 dev 空间，与"编译类语言唯一入口=dev 空间"的既定原则冲突。
- 自足性：dev.build 内惰性注册解决"dev 空间 worker 无法调用 ts 空间 ext.kernel"的矛盾（注册源=ctx.toolstore 通道，仍安全）；worker 无需记忆前置步骤。
- (a) 作为**后续可选增强**（若需要 asm 专属工具如 disasm/status 进 dev 工具面）：给 dev 空间 extraTools 追加 "asm" 族——v1 不做，先走 (b) + ext.use 兜底。
- 兜底路径 (c)：explore 场景（ts 空间）直接 `ext.use("asm-kernel",{tool:"simulate",args:{source}})` / `ext.use(...,{tool:"assemble"})`——零 PTH 改动即用（探索核 A/B 并存）。

---

## 5. 测试矩阵

### 5.1 生产核多平台冒烟

| 用例 | 目标 | 步骤 | 期望 |
|---|---|---|---|
| hello.s（aarch64：x8=64 write/x8=93 exit） | aarch64 原生 | as→ld→./hello | stdout="hello asm!" exit=0（**本容器已实测通过** ✓） |
| hello.s（x86_64：rax=1 write/rax=60 exit） | x86_64 交叉 | x86_64-linux-gnu-as→ld -static→qemu-x86_64 | stdout="hello asm!" exit=0（Dockerfile 安装后验证） |
| hello.s（riscv64：a7=64/a7=93） | riscv64 交叉 | riscv64-linux-gnu-as→ld -static→qemu-riscv64 | stdout="hello asm!" exit=0（可选目标） |
| 相同源码 sha 二次 build | 任一 | dev.build 两次 | 第二次 cache-hit（binaryRef 同） |

### 5.2 探索核（asm-sim）指令覆盖

| 用例 | 覆盖 | 期望 |
|---|---|---|
| li x5,42 / addi 运算 / ecall(write+exit) | I/R/SYSTEM | stdout 正确 exit=0 |
| slt/beq 分支（if-else 结构） | B/R | 走正确分支 |
| jal/jalr（call/ret 子例程） | U/I | 返回地址正确 |
| lw/sw 数组求和 | S/I/内存 | 结果正确 |
| 伪指令 li/la/mv 展开 | 汇编器 | 编码正确 |

### 5.3 失败路径

| 用例 | 期望 |
|---|---|
| 未知助记符 / 缺标签 / 语法错 | 汇编错误信息（行号+上下文） |
| 链接未定义符号 | ld 错误透出 |
| 内存越界（lw 超 data 区） | 模拟器 OOB 错误 + PC 上下文 |
| 非法指令编码 | 非法指令错误 |
| 死循环（无出口） | maxSteps 触发报错（不挂死） |
| run 超时 / 输出超 cap | timedOut=true / 截断标记（镜像 compiled-kernel 语义） |
| target 工具链未安装（status 探测） | ok:false + 缺包提示（装 qemu-user/binutils-*） |

---

## 6. 风险与依赖

| 风险 | 等级 | 缓解 |
|---|---|---|
| 运行时 apt 不可装（无外网+无 root） | 高·已确认 | 工具链进 Dockerfile 构建期安装（镜像构建有网络——dev 容器方案 C 经验）；status 工具诊断缺失项 |
| 交叉包名（qemu-user / binutils-x86-64-linux-gnu / binutils-riscv64-linux-gnu） | 中 | 均为 Debian bookworm main 标准包名（本地 apt 缓存已证 binutils-aarch64-linux-gnu 同族存在）；构建期 apt-cache policy 复核 |
| qemu 执行速度 | 低 | qemu-user 用户态开销小（hello 级毫秒-亚秒）；运行超时默认 10s 足够 |
| 交叉 libc 缺失（动态链接汇编程序跑不了） | 中 | v1 限定纯 syscall+静态链接（文档声明）；v2 补 libc6-dev-*-cross + qemu -L |
| dev.build 分发改动触碰 PTH 内核 | 中 | 遵循 self-modify-guide 单步修改流程；改动 ~15 行且仅在扩展名分支——回归面小；(c) 兜底保证扩展本身零依赖可先落地 |
| 各架构 syscall ABI 不同（x86_64 rax / aarch64 x8 / riscv64 a7） | 低 | README 每架构模板 + 冒烟测试固化 |
| exploreKernels 字段当前构建未检索到 | 低 | 按任务契约设计（角色可声明 asm-sim）——A/B 并存机制不受阻（ext.use 兜底可用） |

---

## 7. 落地步骤（建议顺序）

1. 写 toolstore/extensions/asm-kernel/{plugin.json,index.ts,toolchain.ts,rv32i-sim.ts,README.md}（零 PTH 改动即可用：ts 空间 ext.use/ext.kernel 全功能）
2. Dockerfile 增补工具链 → 重建镜像 → 跑 5.1 x86_64/riscv64 冒烟
3. PTH 极小接线：agent-tools.ts dev.build/dev.run 扩展名分发 + 惰性注册（自修改流程单步）
4. 回归：C 核 dev.build 不受影响（非 .s 走原路径）→ 全矩阵（§5）执行 → memory 沉淀 task-insight
