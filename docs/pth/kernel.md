# PTH Kernel 体系（任务池 · 多语言 REPL · 记忆闭环）

> PTH 的 agent 运行时内核：任务发布 → 持久 REPL 执行 → 自动提炼 → 状态召回，全链路可观测。
> 相关设计文档：[性能计量 SPEC（旧仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/superpowers/specs/2026-08-08-pth-perf-metrics-design.md) · [日志 SPEC（旧仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/superpowers/specs/2026-08-08-pth-logging-design.md) · [REPL SPEC（旧仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/superpowers/specs/2026-08-08-pth-multilang-repl-design.md) · [任务链 SPEC（旧仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/superpowers/specs/2026-08-08-pth-task-resolver-design.md)

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

## Batch 架构（2026-08-09 单大 batch + worker 控制面）

- **默认单大 batch**：启动即 1 个进程承载全角色权重（PTH_WORKER_ROLES 展开）——内存最优（node 基线不重复）
- **worker 级控制**：pause/resume/remove/add（IPC 进程内启停——不影响其他 worker；remove 回收 python 进程）
- **资源分配策略**：BatchCompositionStrategy 接口（balanced/reinforced 内置 + 注册表可扩展）
- **batch 级 add/remove**：特殊手段（故障隔离/多租户）——autoscaler 默认 off

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
| **c（编译核）** | CCompiledKernel：编译-运行管道（非 REPL）——sha256 增量缓存（LRU 50）+ 文件即状态 + build/run 分离 + 诊断回填；编译器变体 gcc/clang/tcc（显式 > env > auto） | 缓存命中提速 **3x** | 编译-运行 |

### 调试协议（DebugSession——可选扩展）

- **基本集**：Debuggable/DebugSession 接口（attach/breakpoint/continue/step/stack/variables/evaluate/detach）+ gdb MI 解析器（parseMiLine 纯函数——结果/执行/控制台记录/元组/列表/裸键值/bkptno 顶层字段）+ CDebugSession 适配器（编译 `-g -O0` + `gdb -i=mi2` 管道）
- **四级回退链**：L0 gdb 完整调试 → L1 sanitize+警告诊断构建 → L2 bash 核 strace/valgrind（零新协议——二进制/文件系统共享）→ L3 Observation 恒可用
- **sandbox 工具链已装**：gcc/g++ · gdb 13.1 · strace 6.1 · valgrind 3.19 · tcc（容器验证：断点命中 bkptno + frame args 契约匹配）

### 标准扩展包（ts 核内能力对象）

统一注册机制 `TsReplExtension`（id/provide/seed/doc——能力注入/预置对象/文档聚合三通道）：

| 成员 | 能力 |
|------|------|
| **memory** | 记忆查询（受限只读 SQL）/ 写入 |
| **context** | 工作台 + results 注册表（跨步联动） |
| **model** | 会话内模型切换（选择链：显式 > model.current > env） |
| **perf** | 参数查看/运行时 SET（PTH_* 白名单）/ analyze / 策略 publish·apply·list（toolstore 闭环） |
| **obs** | 可监控数据调查：tasks（SQL 注入防护）/ metrics·batches（IPC 请求通道——batch→主进程 obs-req/obs-resp）/ kernels（sandbox 宿主直查）/ search（转义） |

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

PTL 调用 PTH：`pth kernel tasks add|ls / batch add|remove / status`（HTTP 兼容通道）；会话内 `/pthtask` 命令族（pth-tasks 扩展）。规范接口见 PTH CLI（`pth submit/status/wait`）。

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

## 正交角色谱系（2026-08-09 整理）

任务分配正交化：**角色间零竞速**——任务发布时确定性路由（flow 显式 → tags 语义 → hash 分片），candidates 只查自己队列。

### 内置角色（origin + 14 默认派发角色——2026-08-15 四族谱系定型；P3.6/W7 增补）

```
origin
├─ actuator（执行侧）
│  ├─ executor → developer{coder, tester{debug-case-writer}} · writer
│  ├─ explorer → scout · spider
│  ├─ governor → planner · acceptor
│  └─ researcher → analyst{prospector{predictor}, solver} · memory-keeper
├─ sensor（观测侧）→ sensor:worker-opt / system-opt / resource / memory
└─ controller（调节侧）→ controller:router / worker-opt / pth-opt / resource / memory / adversarial
```

> **分拆收口原则（2026-08-17 概念补充）**：已分拆出子类型的 worker，工具面只保留
> `execTs/nav/cache` 基本工具 + 面向直接子类型的任务投递工具（投递原语待 W8 定稿；
> 定稿前为保持闭环暂不强制）。详见 concepts §0.16.4。

> 默认 batch 构成 = `allWorkerRoles ×1`（origin + 14 默认派发角色——其中 analyst/developer 同时是内部类型）；
> MID（actuator/executor/explorer/governor/researcher）
> 与 governance 系（sensor/controller 子角色）需 `PTH_WORKER_ROLES` 显式启用才进 batch。
> 完整定义以 `src/pth/impls/roles/default-roles.ts` 为准。

| 角色 | 固定 tags（分选器唯一标准——精确匹配） | 职责（族属） | 权限特征 |
|------|--------------------------|------|---------|
| **origin** | origin | **升级链终点**（terminal reject → trigger 转写 origin 标签 → Origin 全能力兼底完成；Origin 失败即终态） | 全量 |
| analyst | analysis/research/deep-analysis | researcher 族·深度演化分析（按问题类型二分入口） | fs/memory/readSource/readText/web/python/bash（无管理面） |
| prospector | open-explore/hypothesis/prospect | analyst 子类型·开放探索（无定解/发散假设） | 同 analyst（含 readSource/readText）；双语言探索核 |
| solver | closed-solve/constraint/solve | analyst 子类型·封闭求解（有约束/收敛推导） | 同 analyst（含 readSource/readText）；thinking high |
| predictor | predict/forecast/extrapolate | prospector 子类型·预测外推（趋势/分布/不确定性） | 同 analyst（含 readSource/readText） |
| planner | plan/design | governor 族·任务分解/方案设计（只读推理） | fs/memory/readSource/readText；deepseek-v4-pro |
| developer | implement/code/fix | executor 族·代码实现/缺陷修复/技术交付 | python/bash/c/fs/web/llm/state/ext/env/memory/skills/obs |
| coder | coding/write-code/snippet | developer 子类型·纯代码编写（不调试/测试/文档） | python/bash/c/fs/memory/readSource/readText |
| scout | recon/investigate | explorer 族·快速侦察/环境探查 | fs/memory/readSource/readText/bash；thinking low |
| spider | crawl/scrape/fetch | explorer 族·网页抓取/结构化采集 | scout 面 + web/ext（agent-reach） |
| memory-keeper | memory/organize | researcher 族·记忆整理/知识沉淀/索引维护 | memory/fs/readSource |
| acceptor | accept/verify | governor 族·结果验证/交付验收（只读审查） | fs/memory/readSource/readText/python/bash + dev.run/dev.list/write.read/write.list 只读面 |
| tester | test/qa/verify-func | developer 子类型·功能测试/行为验证 | fs/memory/readSource/readText/python/bash/c + dev/debug |
| writer | write/doc/story/tutorial/article | executor 族·文档/内容创作（write 空间） | fs/memory/readSource/readText（无执行核） |
| debug-case-writer | debug-case/regression-case/boundary-case | tester 子类型·自修正闭环验证（复现/回归/边界用例 + 真实运行输出） | fs/memory/readSource/readText/python/bash/c + dev/debug |
| controller:adversarial | controller/review/adversarial | controller 系·skill 固化提案对抗性审核（W7——只读） | memory/fs/readSource/readText |

### 扩展角色（ExtRegistry 装载注册——兼容性扩展接口）

| 角色 | tags | 来源 | 权限声明（注入面收窄）| memory 域 |
|------|------|------|---------------------|-----------|
| greeting-agent | greeting/hello | toolstore/extensions/hello-world | memory/fs/ext | own（role:greeting-agent 命名空间）|

### 任务池纯化（2026-08-10——标签制 + Origin 升级链 + kernel 直连）

**任务池只面向自然语言**（混合池是调试期临时形态，已废止）：所有任务走 agent 循环（LLM 理解+多步工具调用）。执行模式统一由 `PTH_EXEC_MODE` 决定：`tool-call`/`asp` 走 agent 循环；`pulse` 走一次性转译 + PTC；`ptc` 走迭代式 PTC。降级链：`PTH_AGENT_MODE=off`/无 caps（legacy 默认）→ pulse；显式模式缺必需能力 → fail-closed；无 llm → terminal reject。

**标签严格校验**（publish 唯一入口）：
- 未知标签 → 400（报错含已注册标签表）
- 无角色标签且无 flow → 400（无 hash 分片兼底——无主任务不再随机派发）
- 多角色歧义 → 400（一个任务只派一个角色）
- 路由：`① payload.flow 显式 role → ② tags 精确匹配`（双向 includes 模糊匹配已废止）

**Origin 升级链**（错误处理由 Trigger 完成）：
```
terminal reject（task.rejected 事件）→ origin-escalation 系统 trigger（retask 模式）
  → 重发布原任务（正文继承 + tags=[origin] + escalatedFrom 元数据）→ Origin 接取
  → Origin 失败 → 终态闹（不再升级——防死循环）
```

**kernel 直连通道**（调试/运维代码执行——不占任务池）：
```
POST /api/v1/kernel/exec  { code, mode?, sessionId?, timeoutMs? }
  mode=stateless（默认）：独立 vm context 单次执行
  mode=repl：sessionId 持久 context（跨调用状态保留——idle 30min 回收）
```

**notebook cell 执行（P5b + ExecutionTarget Matrix）**：
```
POST /api/v1/kernel/notebook/execute  { language, code, sessionId?, timeoutMs?, target? }
```
- `target` 由 pi-kernel cell magic 解析：`%%python sandbox` / `%%bash local-lean` / `%%ts`。
- 未声明 target 时按语言默认路由：python/bash → `sandbox`，ts → `engine-ts`。
- 路由由 `NotebookTargetRouter`（`packages/pth-kernel-execution/src/execution/notebook-target-router.ts`）经 `ExecutionTargetRegistry` 解析；`local/tool/jupyter` 等一次性 command target 需显式选择且要求批准。

**标签注册通道**（tag-registry——预留 complexity/priority 维度）：角色注册自动挂载其固定 tags；`registerTag({name, kind, role?})` 显式扩展。

### 权限系统 v2（2026-08-10——9.3 第一轮）

**记忆用途层分级**（memory.* worker 面内嵌规则——memory-policy.ts）：

| 层 | kinds | worker 权限 |
|---|---|---|
| prompt | role-doc:* · capability-index · project-map · pth-worker-system · self-modify-guide · skill:* · extension-index | 只读 |
| config | trigger · refine-task:* | 只读（防自开触发器/自改 refine 行为） |
| governance | differentiation-proposal · refine-report | 可写但**强制 draft**（可提草案不可自批；update 禁状态流转） |
| knowledge | task-insight · tool-function · dev-artifact · …（默认） | 读写全开 |

**查询面收敛**：memory.query 表白名单仅 `memory_entries`（任务面走 obs.tasks／事件检索走 obs.search——tasks/transcripts/audit_log 不再可 raw SQL）。

**管理面摘除**（buildCapabilities 装配层裁剪）：
- `perf` 只读子集（params/status/analyze/list）——set/publish/apply 不进 worker 注入面
- `model` 只读子集（get/usage）——set 摘除（防 worker 切模型）
- `tasks` 能力整体摘除（任务代码不可直接 peek/submit 任务池）
- 系统组件（autopilot/console/lineage）主进程直调 store/config——不经能力注入，不受影响

**角色声明**：缺省全量废止——developer 已补齐显式声明（core+data 全量，无 admin）。

## 2026-08 落地摘要（TCE / 任务生命周期）

- `KernelExecChannel` 支持 `commandGateway` 注入；notebook cell 先过 Command 层。
- `TaskControlService` 增加 pause/answer/sweep；dispatcher `onSuspension` 接 publisher-question 与 human。
- worker 侧 CommandGateway 装配（含 tool translator），agent-loop 语言工具与 tool-reg 执行缝先过授权。

详细设计：[task-lifecycle-and-context-design](design/task-lifecycle-and-context-design.md) · [llm-tool-notebook-unified-execution-backend-plan](plan/llm-tool-notebook-unified-execution-backend-plan.md)
