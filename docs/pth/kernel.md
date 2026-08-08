# PTH Kernel 体系（任务池 · 多语言 REPL · 记忆闭环）

> PTH 的 agent 运行时内核：任务发布 → 持久 REPL 执行 → 自动提炼 → 状态召回，全链路可观测。
> 相关设计文档：[性能计量 SPEC](../superpowers/specs/2026-08-08-pth-perf-metrics-design.md) · [日志 SPEC](../superpowers/specs/2026-08-08-pth-logging-design.md) · [REPL SPEC](../superpowers/specs/2026-08-08-pth-multilang-repl-design.md) · [任务链 SPEC](../superpowers/specs/2026-08-08-pth-task-resolver-design.md)

## 架构总览

```
                    ┌─────────────────────────────────────────────┐
                    │                PTH main process             │
                    │  gateway (/api/v1/kernel/*)  ──  metrics     │
                    │  /metrics  Prometheus 端点（四层 35+ 指标）   │
                    └──────────────┬──────────────────────────────┘
                                   │ fork + IPC（日志/metrics 转发）
                    ┌──────────────▼──────────────────────────────┐
                    │           assembly.ts（装配层）              │
                    │  KernelWatchdog（崩溃记录）· resolver 轮询    │
                    │  BatchManager（batch 生命周期/IPC 路由）       │
                    └──────────────┬──────────────────────────────┘
                                   │
              ┌────────────────────┼─────────────────────┐
              ▼                    ▼                     ▼
      ┌──────────────┐    ┌──────────────┐     ┌──────────────┐
      │  TaskLoop    │    │  Refiner     │     │  TaskResolver│
      │  peek→claim  │    │  快照→LLM→   │     │  payload.flow│
      │  →execute    │    │  双通道持久化 │     │  自带路由/递归│
      │  →submit/    │    │              │     │  transform/  │
      │  reject      │    └──────────────┘     │  branch/loop │
      └──────┬───────┘                         └──────┬───────┘
             ▼                                         ▼
      ┌──────────────────────────────────────────────────────┐
      │  KernelManager（多语言持久 REPL 统一路由）              │
      │  ts: VM 沙箱（能力白名单）                             │
      │  python: PyKernel（持久管道 JSON-RPC，230x）           │
      │  bash:  BashKernel（持久 shell 会话）                 │
      └───────────────┬──────────────────────────────────────┘
                      ▼
      ┌──────────────────────────────────────────────────────┐
      │  持久化双通道（PostgreSQL + toolstore 文件）           │
      │  tasks / memory_entries（task-insight·refine-report）│
      │  toolstore/*.ts + *.json（LLM import 工具文件）       │
      └──────────────────────────────────────────────────────┘
```

## 任务池（核心工作流）

任务即数据包：`tasks` 表 + `payload` JSON（自带路由）。

| 环节 | 说明 |
|------|------|
| **发布** | `POST /api/v1/kernel/tasks`（text=代码形态 + title/createdBy/tags）或模板渲染（recon-doc/memory-maintain/dev-task/dev-task-ts） |
| **认领** | TaskLoop `peek`（只读）→ `claim`（即承诺：认领后必执行或 reject）；竞态丢失者跳过 |
| **执行** | 任务代码在 ts VM 内运行，可调 `python.execute` / `bash.execute` / `llm.*` / `web.fetchText` / `fs.*` / `state.*` |
| **收尾** | `ok:false`（语法/运行时错误）按 **reject** 处理（绝不标 completed）；成功 → submit + 归档（workspace snapshot） |
| **拒绝原因** | `assessed-as-unfit`（空转防护：整批零认领全部放回池）、`execution-failed:*`、`execution-crashed:*`——前缀分类归一，防 label 基数爆炸 |

### 任务链（TaskResolver，任务池即工作流）

`payload.flow` 声明路由（有序阶段表），resolver 独立轮询 2s：

```
flow: {
  stages: [
    { op: "transform", task: { role: "developer", ... }, next: "verify" },
    { op: "transform", task: { role: "acceptor", deps: ["<parent>"], ... }, terminal: true },
  ]
}
```

- **算子**：`transform` / `decompose`（拆分子任务）/ `branch`（条件表达式路由）/ `loop` / `wait`（显式等待依赖）/ `terminal`
- **条件表达式**：嵌套递归下降解析器（`&& || ! ( )`，零 eval 零 new Function）
- **递归注销**：resolvedStages 跟踪，子任务完成后推进父流程
- **生产闭环**：developer 任务 → resolver 自动生成验收任务（parent/deps 关联）→ acceptor 执行 → 双 completed

## 多语言持久 REPL（Interpreter 层）

| Kernel | 实现 | 性能 | 状态 |
|--------|------|------|------|
| **ts** | VM 沙箱（能力白名单注入：web/state/fs/llm/python/bash） | ~0.08ms | 任务执行引擎 |
| **python** | PyKernel：常驻进程 + 行式 JSON-RPC + `_result` 返回值通道 | ~0.12ms（vs spawn 12ms，**230x**） | 持久（跨命令状态） |
| **bash** | BashKernel：持久 shell 会话 + 结束标记协议 + cwd/env/变量持久 | ~0.04ms | 持久（跨命令状态） |

- 统一 `KernelManager.execute(language, program)` 路由；`pythonMode/bashMode` 可切回 sandbox interpreter（生产沙箱模式）
- 每 kernel FIFO 队列 + 超时 kill 冷备重启；snapshot 协议（globals 分类：JSON 变量/函数源码含 exec 动态提取/oversized）
- v1 per-worker 归属，v2 计划进程池化（min(worker, CPU)——内存优化非吞吐瓶颈）

## 记忆闭环（Refine + 召回）

任务完成 → **快照**（三 kernel 聚合）→ **LLM 提炼**（deepseek-v4-flash）→ **双通道持久化**：

```
tool-function（源码 + spec 构造文档：signature/purpose/logic/examples）
  → toolstore 文件（LLM import 用：fs.list/fs.readText + eval 重放）
task-insight + refine-report → memory_entries（检索用）
```

- **召回**：vm 白名单 `state.recallFunctions`（源码+spec，eval 重放或按 spec 重建）/ `recallInsights`（只读，限 5/10 条）
- **降级**：LLM 解析失败 → 源码原样保存（不丢）；`PTH_REFINE=off` 或 `payload.refine=off` 可关
- **扁平化闭环**：任务 A 定义函数 → refine 沉淀 → 任务 B 召回 eval 重放 → 直接用（fib(20)=6765 验证）

## 可观测性

### 监控（四层 35+ 指标，`/metrics` Prometheus）

| 层 | 指标示例 | 已验证 |
|----|---------|--------|
| L0 基础设施 | `pth_cpu_usage_percent` / `pth_memory_rss_bytes` / `pth_llm_tokens_total{type}` / `pth_llm_calls_total{provider,model}` | ✅ |
| L1 Kernel | `pth_kernel_exec_total{language,ok}` / duration histogram / truncated / timeout_kill | ✅ |
| L2 任务 | `pth_task_status_total{status}` / `pth_task_stage_duration_seconds{stage}` / reject reason | ✅ |
| L3 产出 | `pth_refine_duration_seconds` / `pth_refine_yield{kind}` / memory entries / chain generated | ✅ |

- **ResourceProvider**：跨 OS 抽象（darwin/linux/容器/nvidia 矩阵，GPU N/A 占位）
- **buckets 分层可配置**（kernel 细/任务粗）+ **采样周期可配置**（`PTH_METRICS_INTERVAL_MS`）
- batch 子进程事件经 IPC 转发主进程统一计量（与日志同模式）；任务代码直调 python/bash 也计入（metered 包装）

### 日志（KernelLogger）

- JSON 默认 / `PTH_LOG_FORMAT=pretty` 可切；级别过滤；组件白名单 15 类
- 链路 ctx：taskId/role/batchPid 自动携带；batch IPC 日志转发统一打标
- kernel stderr → warn 转发；任务 stdout 保持分离（Observation）

## API 面（/api/v1/kernel/*）

| 端点 | 说明 |
|------|------|
| `POST /tasks` | 发布任务（text/title/createdBy/tags/payload） |
| `GET /tasks` | 任务列表（全状态） |
| `GET /tasks/status` | 运行状态全景（batch/队列/pending） |
| `POST /batch/add` · `POST /batch/remove` | 启动/停止 worker batch |
| `GET /batch` | batch 列表（含 PID/存活） |
| `GET /templates` | 模板列表 |
| `/metrics` | Prometheus 指标（四层） |

PTL 交互层：`ptl hub kernel tasks add|ls / batch add|remove / status`；会话内 `/pthtask` 命令族（pth-tasks 扩展）。

## 目录索引

```
src/pth/kernel/
├── assembly.ts          # 装配层：createKernelRuntime + watchdog + resolver 轮询
├── commands.ts          # /pth 命令族纯函数
├── templates.ts         # 任务模板库（recon-doc/memory-maintain/dev-task/dev-task-ts）
├── logger.ts            # KernelLogger（15 组件白名单/链路 ctx）
├── execution/
│   ├── task-loop.ts     # 任务循环（peek→claim→execute→submit/reject）
│   ├── batch-manager.ts # batch 生命周期 + IPC 路由（log/metric）
│   ├── batch-process.ts # 子进程入口（装配 kernel/refiner/TaskLoop）
│   ├── task-resolver.ts # 任务链路由（transform/decompose/branch/loop/wait/terminal）
│   ├── resolver-core.ts # matchesRule/validateFlow/嵌套表达式解析器
│   ├── refiner.ts       # 快照→LLM→双通道持久化
│   ├── model-router.ts  # KernelModelRouter（SDK ModelRuntime，凭据统一）
│   ├── workspace.ts     # 任务工作区分配
│   └── stats.ts / archive.ts
├── interpreter/
│   ├── kernel-manager.ts # 三语言统一路由 + metered 包装
│   ├── py-kernel.ts      # 持久管道 JSON-RPC（230x）
│   ├── bash-kernel.ts    # 持久 shell 会话
│   ├── ts-interpreter.ts # VM 沙箱
│   ├── capability.ts     # vm 白名单（web/state/fs/llm/python/bash）
│   ├── toolstore.ts      # 文件通道（readText 前缀校验/list）
│   └── llm-fn.ts         # LLM 函数（onMetric 计量）
├── storage/              # pg 层：tasks/memory_entries/transcripts/audit
└── observability/        # kernel-metrics（四层）/resource-provider（跨 OS）
```
