# @away_from/pth-sandbox

PTH 的**沙箱域 + 内核契约/运行时** workspace 包（单仓拆分决策见 `docs/pth/split-design.md`）。

- 生产形态：独立 sandbox 容器（`Dockerfile.sandbox`），只挂 `sandbox-internal` 网络、无宿主机端口映射；控制器 root 仅用于 setuid，工作负载以 UID/GID 2001 运行。
- PTH 侧通过 `http://sandbox:8080` 调用：无状态执行走 `/exec`（`sandbox-bash.ts` 客户端），持久 REPL 池走 `/kernel/*`（`SandboxKernel` 客户端）。
- 内核 interpreter 契约（`Interpreter` / `InterpreterResult` / `WorkerKernel`）由本包稳定导出——遵守拆分裁决，不另建 contracts 包。

## 命名对照（易混点）

| 名称 | 形态 | 位置 | 用途 |
|---|---|---|---|
| `sandbox-bash.ts` | 无状态客户端 | `src/sandbox-bash.ts` | PTH 侧调 sandbox `/exec` 的转发客户端（含连续失败 → degraded 监控） |
| `BashKernel` | 本地持久 REPL | `src/bash-kernel.ts` | `PTH_BASH_MODE=kernel` 时在 PTH 容器内运行；生产默认关闭 |
| `PyKernel` | 本地持久 REPL | `src/py-kernel.ts` | `PTH_PYTHON_MODE=kernel` 时在 PTH 容器内运行；生产默认关闭 |
| `sandbox-kernel.ts` | 转发代理客户端 | `src/sandbox-kernel.ts` | 生产默认：把 interpreter 接口映射到 sandbox `/kernel/*` lease 协议 |
| `kernel-host.ts` | Fastify 宿主服务 | `src/kernel-host.ts` | sandbox 容器内：kernel 池 + lease + 编译核 + gdb + 记忆桥转发 |
| `exec-api.ts` | Fastify 服务 | `src/exec-api.ts` | sandbox 容器内：无状态 `/exec` + SSE，私有工作区/UID 隔离 |

一句话区分：**`sandbox-bash` 是"把 bash 命令丢给沙箱执行"的客户端；`BashKernel` 是"本机持久 bash REPL 解释器"；`kernel-host` 是两者背后的池化宿主服务。** 生产路径为 `sandbox-bash` + `sandbox-kernel`；本地调试才启用 `BashKernel`/`PyKernel`。

## HTTP 端点

### exec-api（无状态执行，任务级工作区隔离）

| 方法/路径 | 说明 |
|---|---|
| `GET /health` | liveness（当前无条件 200；readiness 拆分见模块化 v2 P2-6） |
| `POST /exec` | 执行 bash/python 命令或 C 编译运行；allowlist env + workload UID + `/srv/workload` 私有拷贝 |
| `GET /exec/:id` | 任务结果查询（完成后缓存 60s） |
| `GET /exec/:id/stream` | SSE 流式输出 |

### kernel-host（持久 REPL 池，opaque lease 协议）

| 方法/路径 | 说明 |
|---|---|
| `POST /kernel/acquire` | 返回 UUID `SandboxLease`（id+generation+expiresAt）；旧 `kernelId` 协议已退役 |
| `POST /kernel/execute` / `reset` / `snapshot` / `release` | 全部校验 lease id+generation；release 同 lease 幂等 |
| `POST /kernel/memory-bridge` | loopback 免密钥只读桥（body.space 被剥除，上游按 bridge token 声明过滤）；外部调用需 `SANDBOX_SHARED_SECRET` |
| `POST /kernel/compiled` | C 编译+运行（`buildOnly` 可选），持久 cache + 并发信号量 |
| `POST /kernel/debug/*` | gdb MI 会话（attach/breakpoint/step/continue/stack/variables/evaluate/snapshot/detach） |
| `GET /kernel/debug/sessions` | 当前调试会话列表 |
| `GET /kernel/status` | 池容量/编译统计/调试会话数（监控面板与 `obs.kernels` 数据源） |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SANDBOX_SHARED_SECRET` | **compose `:?` 必填** | 控制器间认证（绝不注入 workload） |
| `PTH_MEMORY_BRIDGE_TOKEN` | 空 → memory-bridge fail-closed 503 | 上游 PTH 桥 Bearer token（controller-only） |
| `PTH_BRIDGE_URL` | `http://pi-platform:3000` | 记忆桥上游 |
| `PTH_KERNEL_POOL_SIZE` | 24 | 池容量（≥ 并发 worker ×2 建议） |
| `PTH_KERNEL_ACQUIRE_TIMEOUT_MS` | 10000 | acquire 排队超时 |
| `PTH_KERNEL_ENTRY_TTL_MS` | 1800000 | lease TTL；过期 `active → cancelling → disposed`，不复用 |
| `PTH_COMPILED_CACHE_DIR` / `_MAX_MB` / `PTH_COMPILED_MAX_CACHE` | `/data/compiled-cache/c` / 200 / 50 | 编译缓存目录与磁盘/条数上限 |
| `PTH_COMPILED_TIMEOUT_MS` / `PTH_COMPILED_CONCURRENCY` | 60000 / 4 | 编译超时与并发信号量 |
| `PTH_DEBUG_SESSIONS` | 4 | gdb 会话数上限 |
| `PTH_DEBUG_IDLE_MS` | 1800000 | gdb idle detach（30min） |
| `PTH_DEBUG_WORKDIR` | `/data/workspaces` | gdb 调试工作区根（`.debug/<id>`） |
| `PTH_EXEC_PRIVATE_ROOT` | 空 | `/exec` 私有工作区根（生产 `/srv/workload`） |

## 安全边界（P0 整改后基线）

- workload env 一律 allowlist 构造；`SANDBOX_SHARED_SECRET` / `PTH_MEMORY_BRIDGE_TOKEN` / DB / LLM key 强制剔除。
- 工作负载 UID/GID 2001；`/app` root 只读；控制器 root 仅 setuid。
- kernel 池 TTL 到期先销毁再移出，绝不乐观标 idle。
- 沙箱无外网（仅 `sandbox-internal`）；`/exec` cwd 白名单 + 私有工作区拷贝。
- 记忆桥只读三操作（query/retrieve/get），space 只能来自上游 token 声明，body 自报 space 无效。

长尾与加固计划见 `docs/superpowers/plans/2026-08-16-pth-sandbox-hardening.md`。
