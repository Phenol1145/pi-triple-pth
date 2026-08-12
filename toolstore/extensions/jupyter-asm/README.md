# jupyter-asm —— RV32I (asm-sim) Jupyter Kernel 适配器（v1 验证）

让 Jupyter 前端（notebook / jupyter_client）直接执行 RV32I 汇编单元格。
这是 **PTH 核 ↔ Jupyter 协议语义桥接的最小闭环验证**（2026-08-12 架构对话：
PTH 核与 Jupyter 协议不兼容——但语义可桥接；本适配器即该结论的落地证明）。

部署形态：**模式 A** —— 本地 jupyter（宿主机）↔ kernel 独立进程（不连 PTH——v1 纯探索）。

```
Jupyter 前端 ──zmq──▶ PthAsmSimKernel (kernel.py, ipykernel 子类)
                              │ subprocess（超时 10s）
                              ▼
                        node bridge.js ──require──▶ rv32i-sim.cjs（模拟器复用，不复制）
```

## 文件清单

| 文件 | 作用 |
|---|---|
| `kernel.py` | ipykernel `Kernel` 子类——`execute_request` → 子进程调用 bridge → `stream`/`execute_result`/`error` 协议消息 |
| `bridge.js` | node 桥——stdin/argv 读汇编 → `simulate(src, {timeoutMs:2000})` → stdout 单行 JSON |
| `kernel.json` | kernelspec（`display_name="RV32I (asm-sim)"`，`language=rv32i-asm`） |
| `install_kernel.sh` | 一键注册：解析模拟器绝对路径 → 写入 kernel.json → `jupyter kernelspec install` |
| `test/bridge_test.js` | bridge 集成测试（node 实测 ok/exitCode/stdout 语义） |
| `test/kernel_static_check.py` | kernel.py 静态自检（语法/类结构/协议要点——无 ipykernel 环境用） |
| `test/run_tests.sh` | 自测入口 |

## 依赖（宿主机）

- `python3` + `ipykernel`（kernel 基类）
- `node`（bridge.js 子进程）
- `jupyter` / `jupyter_client`（前端驱动）
- `rv32i-sim.cjs`（asm-sim 探索核——toolstore/extensions/asm-kernel/rv32i-sim.cjs——**复用不复制**）

## 安装（注册 kernelspec）

```bash
cd jupyter-asm
# 方式 A：一键（推荐）——自动解析模拟器绝对路径并写入 kernel.json
PTH_ASM_SIM_PATH=/abs/path/to/rv32i-sim.cjs ./install_kernel.sh rv32i-asm
#   缺省：<脚本目录>/../asm-kernel/rv32i-sim.cjs 存在则自动采用

# 方式 B：手动
#   1) 编辑 kernel.json：把 "__PTH_ASM_SIM_PATH__" 换成 rv32i-sim.cjs 的绝对路径
#   2) jupyter kernelspec install . --name rv32i-asm --replace
#   3) jupyter kernelspec list   # 确认已注册
```

`kernel.json` 的 argv 用 `{resource_dir}` 占位符定位 kernel.py（kernelspec 安装时
kernel.py/bridge.js 会随目录复制到 kernels 目录——`{resource_dir}` 自动解析为安装位置）。

## 验证（jupyter_client 驱动——监督层验收同款）

```python
import jupyter_client

km = jupyter_client.KernelManager(kernel_name="rv32i-asm")
km.start_kernel()
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=30)

# 验收样例：exit code 42
reply = kc.execute_interactive("li a0, 42\nli a7, 93\necall")
#   → execute_reply status='ok'（无 error）
#   → execute_result text/plain 含 "[asm-sim] exit=42 steps=3"

kc.stop_channels()
km.shutdown_kernel()
```

预期输出（execute_result 的 text/plain）：

```
[asm-sim] exit=42 steps=3
```

带 stdout 的样例：

```python
kc.execute_interactive('.data\nmsg: .ascii "hi\\n"\n.text\nla a1, msg\nli a0, 1\nli a2, 3\nli a7, 64\necall\nli a0, 0\nli a7, 93\necall')
# stream(name=stdout): "hi\n"  +  execute_result: [asm-sim] exit=0 steps=9
```

## 协议映射（语义桥接表）

| simulate() 结果 | Jupyter 消息 | execute_reply |
|---|---|---|
| `ok=true` | `stream(stdout)` / `stream(stderr)`（若有）→ `execute_result`（text/plain = stdout + `[asm-sim] exit=N steps=M` 摘要） | `status=ok` |
| `ok=false`（汇编失败/PC 越界/非法指令/模拟超时） | `error`（`ename=SimulationError`，`evalue=error 文本`） | `status=error` |
| bridge 子进程失败/非 JSON/超时 10s | `error`（`ename=BridgeError`） | `status=error` |

**关键语义约定（实测确认）**：`simulate()` 的 `ok` 是【模拟状态】——`ok=true` 表示程序
正常跑到终点（含 SYS_exit 任意退出码，如 `ecall exit(42)` → `ok=true, exitCode=42`）。
因此 **exitCode 是数据而非状态**：非零退出码仍走 `execute_result`，只有 `ok=false` 才走
`error`。这保证验收样例（exit 42 → execute_reply + 无 error）成立。

## 自测（容器内——无外网不装 ipykernel）

```bash
cd jupyter-asm
PTH_ASM_SIM_PATH=/abs/path/to/rv32i-sim.cjs ./test/run_tests.sh
#   [1/2] bridge.js 集成测试（node 实测 5 用例：exit42/写 stdout/非零退出/坏汇编/argv 内联）
#   [2/2] kernel.py 静态自检（py_compile + AST 类结构/协议要点）
```

## v1 限制（探索核范围）

- 仅 RV32I 核心子集 + syscall `write(64)` / `exit(93)`
- 无 stdin（`allow_stdin` 未启用）、无 comm、无 completion（补全/内省由前端本地提供）
- 单元格即独立模拟：无跨单元格状态（每 cell 重新汇编+模拟）
- 模拟护栏：`timeoutMs=2000`（可 `--timeout` 覆盖）`maxSteps=1_000_000` + 内核子进程 10s
