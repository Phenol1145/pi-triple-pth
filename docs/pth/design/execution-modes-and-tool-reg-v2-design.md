# PTH 执行模式与 Tool-Reg v2 设计：TCE、CommandFeedback 与规范化优化循环

> 状态：已收口——Wave 0–5 已落地、Wave 6 文档/全量验证完成（实施状态以 execution-modes-and-tool-reg-v2-implementation-plan.md 为准）。注意：工具面权限模型此后由 [ADR-0004](../../adr/0004-tce-code-layer-ptc-capability-first.md) 修订——TCE 的 C 是 Code 而非 Command 对象，CommandGateway 按计划退役；本文「Command」相关段落以 ADR-0004 为准。完整定稿待 TCE W0–W5 后评审（盘点 #12）
> 范围：PTH 执行模式统一（tool-call / asp / ptc / pulse）、工具注册表（tool-reg）Command 层 TS 连接器化、统一结果/错误反馈契约，以及规范化优化循环（代码/角色 sensor + 活动因子 + 分频调度）
> 关联代码：
> - `packages/pth-config/src/schema.ts`（PTH_AGENT_MODE / PTH_ASP_MODE）
> - `src/pth/runner/runner-config.ts`、`src/pth/runner/agent-task-runner.ts`、`src/pth/bootstrap/task-loop.ts`
> - `packages/pth-kernel-execution/src/execution/agent-loop.ts`、`agent-loop-types.ts`、`agent-tools.ts`、`agent-tools-registry.ts`
> - `packages/pth-memory/src/tool-reg.ts`、`src/pth/tasking/tool-reg-builtin.ts`
> - `packages/pth-kernel-interpreter/src/ptc/runner.ts`
> - `docs/pth/plan/llm-tool-notebook-unified-execution-backend-plan.md`（TCE 三层）
>
> **核心原则**：执行模式与工具实现形态解耦。Tool 层完全不区分执行类型——工具只是“名字 + 输入 schema + 可选返回值契约 + 描述 + 可见性 + command 引用”；具体怎么执行由 **Command 层的 TS 连接器（adapter）** 负责，Execute 层只暴露稳定执行接口。所有工具共享统一执行信封；Command 层把参数错误、授权拒绝、目标解析失败与执行失败归一化为结构化反馈。这样外部可执行命令、TS 函数、固化程序、子 agent 对 Tool 层完全透明。

---

## 0. 设计摘要

本设计把当前分散的执行与工具治理问题收敛为四条主线：

| 主线 | 核心决策 | 结果 |
|---|---|---|
| 执行模式 | 新增 `PTH_EXEC_MODE = tool-call / asp / ptc / pulse` | 执行入口统一，旧配置仅作兼容别名 |
| 工具治理 | Tool 层无类型化，只保留 schema / returns? / visibility / `command` | 工具不再关心自己是 TS、外部命令、程序还是子 agent |
| 执行连接 | Command 层用 adapter 生成 `ExecutionRequest`，Execute 层提供 `ExecutePorts` | target 解析、授权、错误反馈、耗时观测集中在正确层级 |
| 观测优化 | 规范化优化循环：sensor 可为代码或角色，频率按 loop 声明；trace/scorecard 输出 `ActivityFactor` | 所有优化环共享同一观测、提案、审批、验证与回滚骨架 |

实施细节另见：[execution-modes-and-tool-reg-v2-implementation-plan.md](../plan/execution-modes-and-tool-reg-v2-implementation-plan.md)。

---

## 1. 背景与现状

### 1.1 当前执行路径

| 路径 | 触发方式 | 行为 |
|---|---|---|
| tool-call | `PTH_AGENT_MODE=auto/eager/lazy`（默认） | LLM 每步输出结构化 `tool_calls`，agent-loop 逐步执行 |
| ASP | `PTH_ASP_MODE=on` | agent-loop 内启用动作空间协议，工具面随空间切换 |
| PTC 快速路径（本文称**脉冲模式**） | `PTH_AGENT_MODE=off` 或缺少 agentCaps | NL → `translateTask` 一次转译 → `runPtcProgram` 执行一次 |

### 1.2 现状问题

1. **模式语义分散**：`PTH_AGENT_MODE` 同时承担“prompt 框架”（eager/lazy）与“是否关闭 agent 循环”（off）两种职责；`PTH_ASP_MODE` 是独立开关。缺少一个统一的“执行模式”入口。
2. **PTC 只是降级路径**：目前“NL 一次转译 + 执行”只在 `PTH_AGENT_MODE=off` 或能力缺失时出现，不是一等模式；也没有“迭代修订程序”的能力。
3. **工具注册执行体单一**：`ToolRegExecutor` 目前只有 `program / builtin / agent` 三态。`builtin` 只表达“进程内函数引用”，无法表达：
   - 外部可执行命令（grep / ld / 网络工具等）的目标对象；
   - 参数如何映射为 argv；
   - 工具实现语言不受限的场景。
4. **“函数即工具”的局限**：TS 函数是最简单的工具形态，但它隐式绑定 `engine-internal` 执行面；高性能原生工具（grep、编译器、网络探针）不适合用 TS 重写，也没有“执行目标对象”的表达。

### 1.3 术语澄清：trace / transcript / scorecard / activity factor

本文中的 **trace** 不是分布式调用链 tracing，而是**单个任务执行过程的结构化事件流**：

```txt
任务开始
  → llm-call（第 N 步 LLM 输入/输出摘要、token usage）
  → tool-call（调用了哪个工具，参数摘要）
  → tool-result（工具成功/失败、durationMs、结果摘要、错误分类）
  → guard（护栏命中/引导/软终止/硬终止）
  → compression（上下文压缩）
  → finish（完成/失败、步数、错误/警告）
```

相关概念区分：

| 概念 | 含义 | 粒度 |
|---|---|---|
| `trace` | 单任务执行过程的结构化事件流 | 事件级 |
| `transcript` | trace 的持久化归档 + 摘要/压缩产物 | 任务级 |
| `scorecard` | 从 trace 聚合出的任务指标（步数、工具频率、失败数、token、guard 等） | 任务级聚合 |
| `activity factor` | 观察策略从 trace/scorecard 进一步计算出的专题指标（如 deny rate、p95 duration） | 跨任务/窗口聚合 |
| `log` | 运维日志，面向排障 | 进程/服务级 |

当前代码中，trace 事件类型是 `AgentTraceEvent`（`packages/pth-kernel-execution/src/execution/agent-loop-types.ts`），由 agent-loop 产生，经 `AgentTaskRunner` / `TaskLoop` 收集，最终写入 transcript。优化循环和观察策略都以它为输入。

---

## 2. 目标与非目标

### 2.1 目标

1. 引入 `PTH_EXEC_MODE`，统一表达执行模式：
   - `tool-call`：平铺 agent 循环（默认，保持现有主验证路径）；
   - `asp`：ASP 状态机 agent 循环；
   - `ptc`：**迭代式 PTC**——LLM 生成/修订 TS 程序，执行后观察再修订，直到完成；
   - `pulse`：**脉冲模式**——现有 PTC 快速路径正式化，NL 一次转译 + 执行一次。
2. 保留兼容：
   - `PTH_ASP_MODE=on` 继续可用（映射到 `asp`）；
   - `PTH_AGENT_MODE=off` 继续可用（映射到 `pulse`）；
   - `PTH_AGENT_MODE` 只保留 prompt 框架语义（eager/lazy/auto）。
3. Tool 层统一为无类型工具面：工具 = `name + description + parameters + returns? + visibility + command`，不携带任何执行体类型；
4. Command 层通过 TS 连接器（adapter）把工具调用翻译为 Execute 层接口调用，并负责 target 解析、授权、结构化错误反馈、注册期静态分析与执行耗时观测；
5. Execute 层提供稳定执行接口（language / external / internal / agent），承载实际执行；
6. 工具结果统一为全局执行信封：成功承载 `value/stdout`，失败承载 `CommandFeedback`；`ToolSpec.returns` 只描述成功时 `value` 的业务形态；
7. 工具注册表成为**统一治理面**：schema / 三要素 / 可见性 / command 连接器引用 / 可选 returns 都从 tool-reg 派生，消除手写双维护；
8. 规范化所有优化循环：sensor 可为代码或角色，频率由 loop 声明；trace/scorecard 原始事件先压缩为活动因子，再进入统一的 Detect → Propose → Govern → Apply → Verify → Deopt 骨架；
9. 统一 LLM worker 与 code worker 的契约层：身份、版本、输入输出、预算、观测与治理一致；调度通道仍按任务队列 / loop runtime / drainer 分流。

### 2.2 非目标

- 不把 PTC 程序内部的每次能力调用都改为 tool call（保持信封模型，TCE 粒度管入口）。
- 不强制所有工具用 TS 实现。
- 不改变 ASP_BLOCK 文本（沿用冻结红线）。
- 不改变 `human_requests` 契约，不新增 worker 主动 escalate 工具。
- 不删除现有 `AGENT_TOOLS` 静态表；本设计使其成为 Command 层 `builtinAdapter` 的实现仓库，逐步收敛。

---

## 3. 执行模式统一：PTH_EXEC_MODE

### 3.1 配置键

在 `packages/pth-config/src/schema.ts` 新增：

```ts
d("PTH_EXEC_MODE", "string", "tool-call", "mode", "both",
  "执行模式：tool-call（平铺 agent 循环，默认）/ asp（ASP 状态机）/ ptc（迭代式 PTC）/ pulse（NL 一次转译+PTC 执行）",
  { runtime: true });
```

### 3.2 模式解析优先级

新增纯函数 `resolveExecMode(env)`（放在 `runner-config.ts` 或 config 工具模块）：

```
0. 只读取原始 env / 显式注入值；不得读取经 config schema 默认值回填后的 PTH_EXEC_MODE；
1. 若显式 PTH_EXEC_MODE 存在且非法 → fail-fast（配置错误，不静默 fallback）；
2. 若显式 PTH_EXEC_MODE ∈ {tool-call, asp, ptc, pulse} → 使用该值；
3. 否则若 PTH_ASP_MODE=on → asp；
4. 否则若 PTH_AGENT_MODE=off → pulse；
5. 否则 → tool-call。
```

理由：
- `PTH_EXEC_MODE` 是新主入口，显式值优先；
- schema 默认值只用于文档/配置展示，不能被误认为“用户显式设置”，否则兼容别名会失效；
- `PTH_ASP_MODE=on` 与 `PTH_AGENT_MODE=off` 作为兼容别名；
- 默认 `tool-call` 保持现有 flat-primary 验证路径不变。

### 3.3 RunnerConfig 调整

```ts
export type ExecMode = "tool-call" | "asp" | "ptc" | "pulse";

export interface RunnerConfig {
  execMode: ExecMode;
  /** 兼容字段：aspMode = (execMode === "asp") */
  aspMode: boolean;
  /** 兼容字段：仅 tool-call/asp 属于 agent-loop；ptc 不是 agent-loop */
  agentMode: boolean; // execMode === "tool-call" || execMode === "asp"
}
```

`defaultRunnerConfig(env)` 改为基于 `resolveExecMode(env)` 派生，现有消费方继续读 `aspMode` / `agentMode` 可零改动过渡。

能力缺失规则（保持现状兼容）：

- 通过兼容别名/默认值解析为 `tool-call` 或 `asp`，但运行时缺少 `llm` 或 `agentCaps`：维持现有降级语义，转为 pulse，并在 trace/日志标记 `modeFallback: "missing-agent-caps"`；
- 显式 `PTH_EXEC_MODE=tool-call|asp|ptc` 但必需能力缺失：fail-closed 返回配置/装配错误，不静默降级；
- `pulse` 只需要 `llm`；缺 `llm` 仍 terminal reject。

### 3.4 各模式行为

| 模式 | 入口 | 行为 | 产物 |
|---|---|---|---|
| `tool-call` | `runAgentTask` | 现有 agent-loop，ASP 关闭 | `AgentTaskResult` |
| `asp` | `runAgentTask` | 现有 agent-loop，`asp=true` | `AgentTaskResult` |
| `ptc` | 新增 `runPtcTask` | 迭代程序生成→执行→修订→完成 | `AgentTaskResult`（steps=迭代次数） |
| `pulse` | 现有降级路径 | `translateTask` + `runPtcProgram` 一次 | `TaskOutcome` |

### 3.5 兼容矩阵

| 旧配置 | 新等效配置 |
|---|---|
| 未设置 / `PTH_AGENT_MODE=auto/eager/lazy` | `PTH_EXEC_MODE=tool-call` |
| `PTH_ASP_MODE=on` | `PTH_EXEC_MODE=asp` |
| `PTH_AGENT_MODE=off` | `PTH_EXEC_MODE=pulse` |
| （新）迭代 PTC | `PTH_EXEC_MODE=ptc` |

冲突规则：`PTH_EXEC_MODE` 显式值优先；若同时设置 `PTH_EXEC_MODE=tool-call` 与 `PTH_ASP_MODE=on`，以 `PTH_EXEC_MODE` 为准（避免歧义，部署文档注明）。

---

## 4. 脉冲模式（Pulse）

### 4.1 定义

脉冲模式 = 现有 PTC 快速路径正式化：

```
NL 任务文本
  → translateTask（LLM 生成 TS 程序）
  → runPtcProgram（整段执行一次）
  → 完成 / 失败
```

### 4.2 特点

- 一次“设计费”，零逐步 tool call；
- 适合任务明确、单次程序可完成、失败可整体重试的场景；
- 现有两条降级路径对 `TASK_AWAIT_SUSPENDED_CODE` 的处理并不一致：`AgentTaskRunner` 会 retryable requeue，legacy `TaskLoop.execute()` 会按 execution-failed 终态拒绝；pulse 正式化时统一为 retryable requeue，并把这作为显式迁移变更记录。

### 4.3 实现要点

- 不新增执行循环，只把 `agent-task-runner.ts` 中 `config.agentMode=false` 分支改为 `config.execMode==="pulse"` 分支；
- `PTH_AGENT_MODE=off` 兼容别名继续走同一分支；
- 当前 `AgentTraceEvent` 没有 `nl-translate` / `ptc` 事件；pulse 正式化需要新增 `pulse-translate` / `pulse-result`（或等价命名）trace 事件，并写入 transcript，不能声称沿用不存在的事件。

---

## 5. PTC 迭代模式（PTC Mode）

### 5.1 定义

PTC 模式 = 以“整个 TS 程序”为 LLM 动作单位的迭代执行：

```
循环（最多 PTH_PTC_MAX_ITERATIONS 次）：
  1. LLM 生成或修订 TS 程序；
  2. runPtcProgram 执行；
  3. 若程序明确声明 done=true → 完成；
  4. 否则把执行结果/错误/观察回填给 LLM，继续修订；
  5. 超迭代上限 → 软终止（retryable rejected）。
```

### 5.2 新增配置

```ts
d("PTH_PTC_MAX_ITERATIONS", "number", 5, "mode", "batch",
  "PTC 迭代模式最大程序修订轮数");
d("PTH_PTC_MODEL", "string", "", "model", "batch",
  "PTC 模式程序作者模型；空=角色 model，若角色未声明再用 PTH_AGENT_MODEL");
```

### 5.3 程序协议

为避免“完成判定”依赖启发式，PTC 模式使用显式 JSON 协议：

每次 LLM 输出（系统提示要求，单次文本）：

```json
{
  "done": false,
  "program": "async function main(){ ... return ... }",
  "reason": "说明这次程序想做什么 / 上次失败原因",
  "finalResult": null
}
```

- `done=false`：必须有 `program`，执行后回填观察；
- `done=true` 且无 `program`：任务完成，`result` 取上次执行值或显式 `finalResult` 字段；
- `done=true` 且带 `program`：协议错误，不计入迭代次数，按一次协议修订失败处理；
- 首轮即 `done=true`：必须提供 `finalResult`，否则按协议修订失败处理；
- 若 LLM 输出不合法 JSON，按一次“协议修订失败”计数；该计数独立于 `PTH_PTC_MAX_ITERATIONS`，建议默认硬上限 3，超过后软终止。

协议失败计数与迭代计数分离：只有实际执行了一轮 `program` 才消耗 `PTH_PTC_MAX_ITERATIONS`。

### 5.4 执行与回填

每次执行调用 `runPtcProgram`：

```ts
const { raw, assembled } = await runPtcProgram({
  code,
  cwd: taskWorkspace,
  ts: kernel.ts,
  caps: taskCaps,
  // 可扩展：goal / publisherClarification / toolReg 等
});
```

回填给下一轮 LLM 的观察：

```
【第 N 次执行结果】
ok: true/false
error: <错误信息或空>
errorClass: <CommandFeedback.class 或空>
errorCode: <CommandFeedback.code 或空>
retryable: <true/false/空>
value: <截断 2000 字符>
stdout: <截断 2000 字符>
```

### 5.5 与现有生命周期集成

- **goal / publisherClarification**：与 `runAgentTask` 相同，注入 system prompt（`【根目标】` / `【发布者澄清】`），逐字传播；
- **pause**：PTC 程序内 `tasks.await` 返回 `TASK_AWAIT_SUSPENDED_CODE` 时，与 `AgentTaskRunner` 路径一致返回 retryable suspension；恢复后默认重跑当前程序。程序作者应保证 `tasks.await` 之前的副作用幂等；若无法保证，需要在程序内显式记录可恢复状态；
- **知识上下文 / cognitive working set**：沿用 `agent-task-runner` 中现有装配，在首轮 user 消息注入 `Knowledge Context`；
- **trace**：新增事件 `{ type: "ptc-program", step, codePreview }` 与 `{ type: "ptc-result", step, ok, valuePreview, error }`；
- **compaction**：迭代历史过长时复用 `shouldCompressInLoop` / `compressContext`，保留最近 2 轮原始消息。

### 5.6 与 tool-reg 的关系

- PTC 模式仍以 capability 函数为程序内调用面（信封模型），不把程序内调用改为 tool call；
- 因此 PTC 的 TCE 观测默认到“整段程序”粒度：`errorClass/errorCode/retryable` 来自程序级结果或程序内显式返回的结构化错误；程序内每次 capability 调用不产生独立 `tool-result`；
- 若后续需要 capability 级观测，应由 `runPtcProgram` 增加结构化 capability events，而不是把信封模型改成逐步 tool call；
- 高频成功程序可经现有 tool-reg 晋升通道结晶为带 `programAdapter` 的工具（本设计不新开通道，复用 N14）。

---

## 6. Tool-Reg v2：Tool 层无类型 + Command 层 TS 连接器

### 6.1 问题重申

当前 `ToolRegExecutor` 把“执行体类型”放在 Tool 层：

```ts
export type ToolRegExecutor =
  | { type: "program"; source: string }
  | { type: "builtin"; ref: string }
  | { type: "agent"; role: string; input?: string; output?: string };
```

问题：
- `builtin` 无法表达“外部命令 + argvTemplate + target”；
- Tool 层被迫知道“这个工具是函数、外部命令、程序还是子 agent”；
- 工具实现语言/执行目标被隐式绑定在 Tool 层类型上。

### 6.2 目标模型：三层各司其职

**Tool 层完全不区分类型**——工具只是声明：

```ts
export interface ToolSpec {
  name: string;
  description: { anchor: string; whenToUse: string; effect: string };
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  /**
   * 业务返回值契约（可选）。
   * 注意：Tool 层仍不声明执行类型；returns 只描述成功时 `value` 的形态，供治理审核、
   * PTC 组合、结果校验与文档生成使用。若模型提供方不消费 return schema，则不进入 tool_calls。
   */
  returns?: {
    /** `value` 的 JSON Schema；缺省表示返回值自由形态 */
    schema?: Record<string, unknown>;
    /** 面向 LLM/人类的回包说明（例如“返回匹配行数组，字段 path/line/text”） */
    description?: string;
  };
  visibility: { roles: string[]; pack: string };
  /** Command 层连接器 id；Tool 层不知道也不关心它如何执行 */
  command: string;
}
```

**回报信息分两层声明**：

1. **全局执行回包（ToolOutcome）**：所有工具共享，不在每个 `ToolSpec` 里重复声明。`ToolOutcome` 是 Command/Execute 层的规范化内部信封；`AgentToolResult` 是它在 agent-loop 中的投影。组成固定为 `ok / value / stdout / stderr / error|feedback / code / durationMs / truncated / requestId` 等执行信封字段；失败时 `feedback` 使用 §6.6 的 `CommandFeedback`。

   ```ts
   export interface ToolOutcome {
     ok: boolean;
     value?: unknown;
     stdout?: string;
     stderr?: string;
     error?: string;
     code?: string;
     /** 单次工具执行耗时（ExecutePorts/Command 层归一化；trace/scorecard 观测源） */
     durationMs?: number;
     truncated?: boolean;
     requestId?: string;
     /** 结构化错误反馈（见 §6.6；可选，向后兼容） */
     feedback?: CommandFeedback;
   }
   ```

2. **工具业务返回值（ToolSpec.returns）**：可选，只描述成功时 `value` 的形态，不描述 `ok/stdout/stderr/error` 这些信封字段。它主要用于治理审核、工具文档、PTC 组合与结果校验；若模型提供方不支持 return schema，则不进入 `tool_calls`，只保留在 tool-reg 机读面。

**Command 层用 TS 连接器（adapter）连接**：

```ts
export interface LanguageExecReq {
  kind: "language";
  language: "ts";
  code: string;
  args: Record<string, unknown>;
  target?: string;
}
export interface ExternalExecReq {
  kind: "external";
  ref: string;
  argv: string[];
  args: Record<string, unknown>;
  target: string;
  timeoutMs?: number;
}
export interface InternalExecReq {
  kind: "internal";
  ref: string;
  args: Record<string, unknown>;
  target: "engine-internal";
}
export interface AgentExecReq {
  kind: "agent";
  role: string;
  args: Record<string, unknown>;
  input?: string;
  output?: string;
}
export type ExecutionRequest = LanguageExecReq | ExternalExecReq | InternalExecReq | AgentExecReq;

export interface ToolCommandContext {
  principalId: string;
  tenantId: string;
  roleId: string;
  taskId?: string;
  space?: string;
}

export type ToolCommandAdapterResult =
  | { kind: "request"; request: ExecutionRequest }
  | { kind: "deny"; reason: string; feedback?: CommandFeedback };

export type ToolCommandAdapter = (
  ctx: ToolCommandContext,
  args: Record<string, unknown>,
) => Promise<ToolCommandAdapterResult>;
```

**不变量：adapter 不执行，也不做最终授权。** adapter 只负责翻译/补全/声明 target 意图；它不得持有 `ExecutePorts`，不得直接调用执行接口，也不得返回 `execute` 或 `await-approval` 决策。所有可执行请求都必须重新进入 CommandGateway 盖章与授权。统一管道为：

```txt
ToolCall
  → ToolSpec.command 查 adapter
  → adapter 返回 ExecutionRequest 或 deny
  → Command 层把 ExecutionRequest 规范化为 ExecutionCommand（盖章 id/security/scope/target）
  → CommandGateway 授权 / await-approval / deny
  → Execute 层按 ExecutionCommand 执行
  → Command 层归一化为 ToolOutcome / CommandFeedback
```

Command 层维护一个 `CommandAdapterRegistry`：

```ts
interface CommandAdapterRegistry {
  get(id: string): ToolCommandAdapter | undefined;
  register(id: string, adapter: ToolCommandAdapter): void;
}
```

**Execute 层只暴露稳定接口（只接收已授权、已盖章的 ExecutionCommand）**：

```ts
export interface ExecutePorts {
  runLanguage(command: ExecutionCommand): Promise<ExecutionResult>;
  runExternal(command: ExecutionCommand): Promise<ExecutionResult>;
  runInternal(command: ExecutionCommand): Promise<ExecutionResult>;
  /** agent 命令由 Command 层授权后映射到 toolRegExec/runChild 通道 */
  runAgent(command: ExecutionCommand): Promise<ExecutionResult>;
}
```

`ExecutionRequest` 是 Command 层内部的“待授权请求”，不是 Execute 层输入；Execute 层只消费 `ExecutionCommand`。

### 6.3 Adapter 形态（由声明式元数据生成，不必手写）

虽然 Tool 层无类型，Command 层内部仍可提供四种**标准 adapter 生成器**，把原“执行体类型”降级为 Command 层的实现细节：

| adapter 生成器 | 生成逻辑 | 产出 ExecutionRequest |
|---|---|---|
| `builtinAdapter(ref)` | 生成进程内执行请求 | `{ kind:"internal", ref, args, target:"engine-internal" }` |
| `externalAdapter({ ref, argvTemplate, target?, backend? })` | 槽位填充 argv，解析 target/backend | `{ kind:"external", ref, argv, args, target }` |
| `programAdapter(source)` | 把工具参数注入常量后生成 TS 程序请求 | `{ kind:"language", language:"ts", code, args }` |
| `agentAdapter(role)` | 生成子 agent 穿透请求 | `{ kind:"agent", role, args }` |

这样：
- **TS 函数**：`command: "builtin:memory.query"`，由 `builtinAdapter` 连接；
- **grep / 编译器**：`command: "external:grep"`，由 `externalAdapter` 连接，`argvTemplate` 和 `target` 放在 adapter 元数据里；
- **PTC 结晶程序**：`command: "program:tool:xxx"`，由 `programAdapter` 连接；
- **子 agent**：`command: "agent:role:xxx"`，由 `agentAdapter` 连接。

### 6.4 校验规则（fail-closed）

1. `ToolSpec.command` 必须能解析到已注册的 Command adapter；解析不到 → 工具不可见/调用拒绝；
2. Tool 层只校验 schema / 三要素 / returns（若提供）/ visibility / command 引用存在；
3. `returns` 可选；若提供，`returns.schema` 必须为 JSON Schema 对象，`returns.description` 必须为非空字符串；`returns.schema` 只约束成功结果的 `value`，不约束全局执行信封；
4. adapter 元数据（如 `externalAdapter` 的 `argvTemplate`）按自身规则校验：
   - `argvTemplate` 每个 `{{slot}}` ∈ `parameters.properties`；
   - 被无条件引用的槽位 ∈ `parameters.required`；可选槽位必须放在条件片段中，或在缺省时整体省略；
   - `external` 的 argv 永远是数组，绝不拼接 shell 字符串；
   - 默认禁止槽位值以 `-` 开头进入位置参数；如需传 flag 值，adapter 元数据必须显式声明 `slotPattern` / `allowDashPrefixed`，并在位置参数前使用 `--` 分隔；
   - `target` / `backend` 至少一个，或可由 adapter 元数据的执行域推导，否则拒绝；
5. `builtin` / `program` 的 target 固定 `engine-internal`，不需要外部目标对象。

### 6.5 目标解析

```
resolveExternalTarget(adapterMeta, spec):
  1. adapterMeta.target 显式 → 直接使用；
  2. adapterMeta.backend 显式 → 查 ExecutionBackendRegistry 得到 target；
  3. adapterMeta.domain 显式：
     - domain=compiled → target=tool-compiled
     - domain=network  → target=tool-network
  4. visibility.pack 只描述工具包/可见性，不用于推导外部 target；
  5. 无法推导且无显式 target/backend/domain → 拒绝调用（不静默 fallback）。
```

- `builtin` / `program`：target 固定 `engine-internal`，不需要外部目标对象；
- `external`：target 由上述规则解析，解决“没有指定 execute 目标对象”的问题；
- 若推导到 `sandbox`，必须确认该后端确实支持 argv external 执行；不支持则拒绝。

### 6.6 错误反馈契约（CommandFeedback）

**结论：有，而且必须显式建模。** Command 层不能只返回“拒绝/失败字符串”，否则 tool-call/ASP/PTC 无法区分“模型可修正的参数错误”与“权限/治理拒绝”。但边界要守住：

- **Command 层负责决策前错误**：ToolSpec/args schema 校验、`command` adapter 解析、adapter 元数据校验、target/backend 解析、授权拒绝；
- **Execute 层负责执行后错误**：语言程序、外部命令、进程内函数、子 agent 的实际执行失败；
- **Command 层负责归一化投影**：把两类错误统一投影成工具结果，供 agent-loop / PTC 回填，供 trace/scorecard 观测；
- **Command 层负责返回契约校验**：对 `ok:true` 且声明 `returns.schema` 的工具结果校验 `value`，契约漂移记为 `return-schema-mismatch`；
- **Command 层不自动重试、不吞错**：只给出 `retryable` / `suggestion`，由执行模式层决定重试、换工具、降级或终止。

`CommandDecision` 仍保持 TCE 三态（`execute / deny / await-approval`），本设计不新增第四态；但 `deny` 需要扩展为可携带结构化反馈：

```ts
type CommandDecision =
  | { kind: "execute"; command: ExecutionCommand }
  | { kind: "deny"; reason: string; feedback?: CommandFeedback }
  | { kind: "await-approval"; requestId: string; command: ExecutionCommand };
```

`await-approval` 不是错误，不进入 CommandFeedback；它继续映射为 `HUMAN_APPROVAL_PENDING` + `TaskSuspension{kind:"human"}`，保持 human_requests 契约不变。

建议引入稳定错误反馈结构：

```ts
export type CommandErrorClass =
  | "tool-schema"        // args 不符合 ToolSpec.parameters
  | "adapter-not-found"  // command 引用未注册
  | "adapter-config"     // argvTemplate / ref / source / role 等元数据非法
  | "target-resolution"  // target/backend/domain 推导失败
  | "authorization"      // CommandDecision.deny
  | "execution"          // ExecutePorts 返回 ok:false
  | "tool-contract"      // returns.schema 等结果契约校验失败
  | "adapter-exception"; // adapter 自身抛异常

export interface CommandFeedback {
  layer: "command" | "execute";
  class: CommandErrorClass;
  code?: string;                  // 稳定机器码，如 argv-slot-missing / target-unresolved
  message: string;                // 人类/LLM 可读错误
  retryable: boolean;             // 同一调用是否值得重试（不含权限/治理变化）
  suggestion?: string;            // 给 LLM/PTC 的下一步建议
  details?: Record<string, unknown>; // 结构化细节：缺失槽位、候选 target、stderr 摘要等
}
```

投影规则：

| 来源 | 反馈分类 | 对 LLM/PTC 的语义 |
|---|---|---|
| ToolSpec/args schema 校验失败 | `tool-schema` | `retryable=true`，提示按 schema 修正参数 |
| `command` 引用不存在 | `adapter-not-found` | `retryable=false`，建议换用已注册工具或 `ts.run` |
| adapter 元数据非法 | `adapter-config` | `retryable=false`，属于治理/配置缺陷 |
| target/backend 解析失败 | `target-resolution` | `retryable=false`，不静默 fallback |
| `CommandDecision.deny` | `authorization` | `retryable=false`，不得诱导绕过授权 |
| `ExecutePorts` 返回 `ok:false` | `execution` | 保留 `error.code/message/stderr`，由模式层决定回填/修订 |
| 成功结果不符合 `returns.schema` | `tool-contract`（`layer="command"`，`code=return-schema-mismatch`） | `retryable=false`，属于工具实现/契约漂移；进入治理观测 |
| adapter 抛异常 | `adapter-exception` | `retryable=false`，作为实现缺陷进入 trace |

执行模式消费方式：

- **tool-call / asp**：把 `CommandFeedback` 投影为工具消息（保留 `class/code/retryable/suggestion`），让 LLM 修正参数或换策略；
- **ptc**：作为下一轮程序修订观察的一部分（与 `runPtcProgram` 的 `ok/error/stdout` 并列）；
- **pulse**：没有迭代修订环，失败即任务失败；`retryable=true` 只表示可由外层 runner 做整体重试，不在工具层隐式重试。

trace/scorecard：`tool-result` 事件建议扩展可选字段 `errorClass/errorCode/retryable`，让 sensor/controller 能区分“参数误用”“目标解析失败”“授权拒绝”“真实执行失败”。

### 6.7 Adapter 静态分析与运行观测

#### 纯 TS 工具

允许，而且是最简单形态。Tool 层仍不标记“这是 TS 工具”，只在 Command 层选择连接器：

- 稳定维护的 TS 函数：`command: "builtin:<ref>"` → `builtinAdapter(ref)` → `runInternal(...)`，target 固定 `engine-internal`；
- PTC 结晶出的 TS 程序：`command: "program:<id>"` → `programAdapter(source)` → `runLanguage(...)`。

也就是说，“纯 TS 工具”不是一种 Tool 层类型，而是 Command 层选择 `builtin` 或 `program` 连接器的实现细节。

#### Adapter 静态分析

当前草案必须补一层**注册期静态分析**，但它只是入场闸，不替代运行时授权：

| adapter 来源 | 静态分析要求 |
|---|---|
| 标准 adapter 生成器（`builtinAdapter` / `externalAdapter` / `programAdapter` / `agentAdapter`） | 主要校验声明式元数据：`ref`、`argvTemplate` 槽位、`target/backend`、`source`、`role`；生成器本身随代码评审 |
| 自定义 TS adapter | 必须过 AST 静态分析 + 提案审核；未通过不得注册 |

自定义 adapter 的最低静态规则：

1. 只允许导出 adapter 工厂/函数签名；禁止顶层副作用；
2. 禁止运行时 `import()` / `require`；只允许类型级 import 或白名单纯函数工具库；
3. 禁止直接访问 `process` / `fs` / `child_process` / `net` / `fetch` / `eval` / `Function` / `worker_threads` 等能力；
4. adapter 不得持有或调用 `ExecutePorts`；执行能力只能以返回 `ExecutionRequest` 的方式表达；
5. 不得修改 `CommandAdapterRegistry`、`ToolSpec`、授权上下文或全局状态。

边界：静态分析只能防“明显越权和脏代码”，不能证明 adapter 安全。真正的授权、target 解析、资源限制仍在 Command/Execute 运行时边界执行。

#### 工具运行时长

有，且应显式纳入统一执行信封：

- `ExecutePorts.*` 返回的 `ExecutionResult.durationMs` 是唯一执行耗时真相源；
- Command 层把它归一化到 `ToolOutcome.durationMs`；
- tool-call/ASP 的 `tool-result` trace 继续携带 `durationMs`；
- PTC 模式每轮记录程序生成耗时与执行耗时（执行耗时来自 `runPtcProgram`/`ExecutionResult`）；
- scorecard 按 `tool / adapter / execMode / errorClass` 聚合 `count / errorRate / duration p50 / p95 / p99`，供 sensor/controller 识别慢工具与高失败工具。

### 6.8 执行路径映射

| Tool 层 | Command adapter | Execute 接口 | 错误反馈入口 |
|---|---|---|---|
| 任意工具（无类型） | `builtinAdapter` | `runInternal` | Command 层参数/引用错误；Execute 层函数错误 |
| 任意工具（无类型） | `externalAdapter` | `runExternal` | Command 层 argv/target 错误；Execute 层 exit/stderr 错误 |
| 任意工具（无类型） | `programAdapter` | `runLanguage` | Command 层 source/args 错误；Execute 层程序错误 |
| 任意工具（无类型） | `agentAdapter` | `runAgent` | Command 层 role/契约错误；Execute 层子 agent 失败 |

### 6.9 注册与治理

- **Tool 层（tool-reg）**：
  - 条目 = `ToolSpec`（含 `command` 引用），不再携带执行体类型；
  - 仍由 N14 治理：draft → official、不可变版本链、visibility 窄投放、快照冻结、budget；
  - 机读 `__tool_spec__` 仍是单一真相源。
- **Command 层（adapter 注册表）**：
  - 内置 adapter 与代码同库，受代码评审；
  - 新增外部/自定义 adapter 走提案审核（复用 tool-reg 治理流或独立 adapter 治理）；
  - 自定义 TS adapter 必须附带静态分析结果（AST 规则见 §6.7）；未通过不得注册；
  - adapter 是纯 TS 翻译函数，只产出 `ExecutionRequest` 或 `deny`；不得持有 `ExecutePorts`，也不能直接碰文件系统/网络。
- **对账测试**：
  - builtin 对账仍要求 builtin adapter 覆盖 `PTC_TOOL_DEFS` 键集；
  - external/program/agent adapter 单独做 schema / argv / target 校验；
  - 声明了 `returns.schema` 的工具必须有结果校验用例；
  - 双写一致性：`__tool_spec__` 机读行仍是单一真相源。

### 6.10 与 TCE 的关系

本设计是 `docs/pth/plan/llm-tool-notebook-unified-execution-backend-plan.md` “全量 TCE” 在 tool-reg 上的落地：

- Tool 层：`ToolSpec` = per-tool 输入 schema + 可选 returns + `command` 引用，不区分执行类型；
- Command 层：`CommandGateway` 查找 `command` 对应的 TS adapter，翻译为 `internal / external / language / agent` 命令，完成 target 解析、授权与 `CommandFeedback` 归一化；
- Execute 层：`ExecutePorts` 按 target 结构路由，`engine-internal` 走进程内，`external` 走后端。

`external` 工具在未接入 `CommandGateway` 的 legacy 路径下**调用即拒绝**（fail-closed），避免绕过授权。

---

## 7. 优化循环适配（TCE-aware）

当前优化循环（scorecard → hotspot → suggestion → apply/verify/deopt）可以继续沿用，但必须从“只看 tool 名 + ok”升级为“看 TCE 结构”：同一工具失败可能来自参数 schema、adapter 配置、target 解析、授权或真实执行，优化动作完全不同。

### 7.0 规范化优化循环模型

**结论：可以规范化所有优化循环，前提是两点成立：**

1. **sensor 不一定必须是 LLM worker**：它可以是一段受治理的代码（观察策略 / 聚合器 / 检测器），也可以是角色任务，或二者混合；
2. **频率是一等配置**：不同 loop 可以按事件、任务完成、滑动窗口、固定间隔或人工触发运行，不能强行统一到同一个 tick。

规范化后的公共骨架为：

```txt
Sense（采集）
  → Factor（活动因子）
  → Detect（热点/异常/机会识别）
  → Propose（优化提案）
  → Govern（审核/批准/预算）
  → Apply（受控应用）
  → Verify（复测/基线对比）
  → Deopt/Rollback（劣化回滚）
```

建议定义 `OptimizationLoopSpec`：

```ts
export interface OptimizationLoopSpec {
  id: string;
  version: number;
  domain: "tool" | "adapter" | "rule" | "role" | "memory" | "resource" | "mode" | "intake";
  description: string;

  /** sensor 可以是代码、角色，或代码先行、角色复核的混合形态 */
  sensor:
    | { type: "code"; strategyRef: string }       // 观察策略/聚合器
    | { type: "role"; roleId: string }            // LLM sensor worker
    | { type: "hybrid"; strategyRef: string; roleId: string };

  /** 频率差异是一等配置 */
  schedule:
    | { kind: "event"; eventTypes: string[] }
    | { kind: "task-finish" }
    | { kind: "window"; windowSize: number }
    | { kind: "interval"; everyMs: number }
    | { kind: "manual" };

  /** 输入与输出 */
  inputs: Array<"trace" | "scorecard" | "activity-factor" | "metrics" | "memory" | "intake-run">;
  emits: { factors: string[]; suggestionKinds: Array<OptimizerSuggestion["kind"]> };

  /** 检测与应用边界 */
  detect: { hotspotRefs?: string[]; scriptRef?: string };
  governance: {
    approval: "auto-reversible" | "manual" | "adversarial" | "human";
    applyChannel: "optimizer-apply" | "tool-proposal" | "adapter-proposal" | "skill-proposal" | "config-change" | "memory-proposal";
  };
  verify: {
    metricRefs: string[];
    /** 证据通道优先级：通常 ["verify-task", "role", "global"] */
    baselinePriority: Array<"verify-task" | "role" | "global">;
    worseThreshold: number;
    timeoutMs: number;
    /** 可回滚变更必须声明回滚句柄/逆操作；否则不得使用 auto-reversible */
    rollbackRef?: string;
  };

  budget?: { maxRunMs?: number; maxFactors?: number; maxSuggestionsPerWindow?: number };
}
```

现有优化环映射：

| 现有环 | 规范化解释 |
|---|---|
| JIT optimizer | `sensor=code(scorecard/hotspot)`，`schedule=task-finish/window`，`apply=optimizer-apply` |
| sensor/controller 角色 | `sensor=role`，`schedule=interval/event`，`apply=对应治理提案` |
| guard JIT | `sensor=code(guards)`，`apply=config-change`，`verify=global/verify-task` |
| resource / perf-autopilot | `sensor=code(metrics)`，`schedule=interval`，`apply=config-change` |
| tool/skill 治理 | `sensor=code或role`，`apply=tool-proposal/skill-proposal` |
| intake 反馈 | `sensor=code(intake-run metrics)`，`schedule=interval/event`，`apply=人工或策略提案` |

规范化不变量：

- sensor 只读，不直接改系统；
- Detect 只产生候选，不直接生效；
- Apply 必须经治理通道；
- Verify/Deopt 是所有 loop 的必备闭环节点；
- 频率差异只影响调度，不改变证据与治理语义；
- 治理下限必须可被 schema 校验器强制执行：涉及 `target/backend/外部命令/config-change/adapter-proposal` 的 loop，不得声明 `approval="auto-reversible"`；至少要求 `adversarial` 或 `human`；
- `approval="auto-reversible"` 只适用于存在明确逆操作/回滚句柄的变更；verify 无基线、无证据或超时时不得默认保持生效，必须挂起人工复核或回滚。

role / hybrid sensor 的调度规则：

- `sensor.type="role"`：event/window/interval 触发时由 `OptimizationLoopRuntime` 物化为一个受治理任务进入任务队列；sensor 角色必须使用只读工具面；
- `sensor.type="hybrid"`：code 部分先产出 `ActivityFactor` 与候选摘要，role 部分只接收这份压缩载荷复核；
- code sensor 不抢任务队列，role sensor 不在热路径同步执行；
- sensor 角色的只读约束必须体现在其 Worker Registry / RoleDefinition 的工具面声明中，不能只靠 prompt 自律。

`verify.baselinePriority` 支持三通道证据优先级：`verify-task` > `role` > `global`；若三通道均无证据，loop 不得自行宣布 verified。

### 7.1 观测面扩展

`tool-result` trace 在现有 `durationMs/ok/resultPreview` 基础上扩展可选 TCE 字段：

```ts
export interface ToolTraceTceMeta {
  execMode?: ExecMode;                    // tool-call / asp / ptc / pulse
  commandId?: string;                     // ExecutionCommand id
  adapterId?: string;                     // ToolSpec.command
  execKind?: "language" | "external" | "internal" | "agent";
  target?: string;                        // 实际执行 target
  errorClass?: CommandErrorClass;
  errorCode?: string;
  retryable?: boolean;
}
```

`WorkerScorecard` 保留现有字段（`toolFreq/failedActions/guards/...`），新增聚合面：

```ts
export interface ToolRuntimeAgg {
  calls: number;
  fails: number;
  totalDurationMs: number;
  errorClasses: Record<string, number>;
}

interface WorkerScorecardTceExt {
  toolsDetailed?: Record<string, ToolRuntimeAgg>;    // 按 tool 聚合
  adapters?: Record<string, ToolRuntimeAgg>;         // 按 command/adapter 聚合
  targets?: Record<string, ToolRuntimeAgg>;          // 按执行 target 聚合
  execModes?: Record<string, { tasks: number; fails: number; totalDurationMs: number }>;
}
```

注意：在 `ptc/pulse` 中，工具级聚合默认只统计整段程序入口；程序内 capability 级调用需要额外 capability events，不属于 v1 必需项。

### 7.2 热点规则扩展

现有热点继续有效：`repeated-fail / no-progress / gate-heavy / token-bloat / cache-waste / guard-kill-spike`。新增 TCE 热点：

| 热点 | 触发信号 | 优化方向 |
|---|---|---|
| `adapter-config-error` | `adapter-config` / `adapter-not-found` 高频 | 修 adapter 元数据或注册面 |
| `target-resolution-error` | `target-resolution` 高频 | 修 target/backend 映射或 pack 推导 |
| `authorization-deny-spike` | `authorization` deny 高频 | 角色能力与工具可见性错配 |
| `tool-schema-misuse` | `tool-schema` 高频 | 优化工具描述、参数 schema、示例或角色规则 |
| `tool-contract-mismatch` | `return-schema-mismatch` | 修工具实现或 `returns.schema` |
| `slow-tool` | 单工具/adapter `duration p95` 超阈值 | 优化实现、改 target、拆工具或改执行模式 |
| `mode-mismatch` | 某模式失败/耗时显著高于任务同类 | 调整 mode 路由规则或任务派发建议 |
| `ptc-revision-loop` | PTC 迭代次数高且最终失败 | 改程序作者提示、能力面或转 tool-call |

### 7.3 sensor/controller 对接

| 点位 | 新观测/调节职责 |
|---|---|
| `sensor:tool-single` | 单工具维度：失败率、`errorClass` 分布、`duration p95`、`return-schema-mismatch` |
| `sensor:tool-face` | 工具面维度：缺失 adapter、工具组合困难、target/backend 错配、工具缺口 |
| `sensor:rule` | 护栏与 CommandFeedback 的交互：高频 retryable 错误是否演变成 guard 命中 |
| `sensor:worker-opt` | execMode 维度：tool-call / asp / ptc / pulse 的步数、失败率、耗时对比 |
| `controller:tool-single` | 发起工具描述、参数 schema、`returns`、交互模式修订提案 |
| `controller:tool-face` | 发起新工具/新 adapter/工具面组合提案 |
| `controller:rule` | 调节护栏或模式路由规则（仅软规则；硬安全边界不自动调） |

### 7.4 建议与应用边界

`OptimizerSuggestion.kind` 建议扩展：

```ts
kind: "rule" | "role" | "guard" | "tool" | "adapter" | "skill";
```

但应用路径必须分治理域：

- `kind="tool"` → 转 `tool-proposal`（tool-reg 治理流：draft → adversarial review → approve → execute）；
- `kind="adapter"` → 转 adapter 提案；标准元数据修复可半自动，自定义 TS adapter 必须附静态分析结果；
- `kind="skill"` → 转 skill 维护提案流；
- `kind="guard"` → 沿用现有护栏热调白名单；
- `kind="rule"/"role"` → 沿用现有 role-doc / capability-index / lineage 通道；
- target/backend/外部命令安全边界变化 → 永远人工审批，不走自动 apply。

verify/deopt 继续沿用现有三通道证据（独立复测任务 > 角色有机流量 > 全局聚合），但对比指标从 `avgFails/avgSteps` 扩展为：

- `errorRate`；
- `duration p50/p95/p99`；
- `errorClass` 分布；
- `return-schema-mismatch` 次数；
- mode 维度成功率与耗时。

### 7.5 与执行模式的关系

优化循环不直接切换 `PTH_EXEC_MODE`。它只产生模式路由建议或配置提案：

- 简单 NL 任务在 `tool-call` 中步数过少且稳定 → 可建议走 `pulse`；
- 复杂任务在 `pulse` 中一次失败但错误可修订 → 可建议走 `ptc`；
- `ptc` 迭代长期不收敛 → 可建议回退 `tool-call` 或优化能力面；
- `asp` 只在动作空间收益明确时开启，不作为默认路由目标。

### 7.6 可部署观察策略：活动因子（Activity Factors）

目标：把 sensor 从“读原始 trace 再现场分析”解放出来。观察策略是一组**受治理、可版本化、可灰度部署**的规则/脚本，随 worker 执行流并行消费事件，把原始事件压缩成 sensor 直接可读的**活动因子**。

#### 策略定义

```ts
export interface ObservationStrategySpec {
  id: string;
  version: number;
  description: string;
  scope?: {
    roles?: string[];
    execModes?: ExecMode[];
    tools?: string[];
    adapters?: string[];
    targets?: string[];
  };
  trigger: "trace-event" | "task-finish" | "window";
  match?: Array<{
    eventType?: string;             // tool-result / llm-call / guard / finish / ptc-result ...
    field: string;                  // dot path：errorClass / target / durationMs / resultPreview
    op?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "regex";
    value?: unknown;
    regex?: string;                 // 受限正则；禁止灾难性回溯
  }>;
  aggregate: {
    kind: "count" | "rate" | "sum" | "avg" | "p50" | "p95" | "p99" | "distinct" | "custom";
    field?: string;                 // 如 durationMs / tokens.input / failedActions
    window: { type: "task" | "sliding" | "fixed"; size: number | string };
  };
  emit: {
    factor: string;                 // 活动因子名：tool.authorization-deny-rate 等
    unit?: string;
    description?: string;
  };
  /** 可选脚本抽取器；只能消费事件快照并返回因子，不得触碰执行环境 */
  scriptRef?: string;
  budget?: {
    maxRegexLength?: number;
    maxMsPerEvent?: number;
    maxEventsPerTask?: number;
    maxFactorsPerTask?: number;
  };
}
```

输出统一为 `ActivityFactor`：

```ts
export interface ActivityFactor {
  factor: string;
  value: number | string | boolean;
  unit?: string;
  labels: {
    tenantId: string;
    roleId: string;
    taskId?: string;
    execMode?: ExecMode;
    tool?: string;
    adapterId?: string;
    target?: string;
    errorClass?: CommandErrorClass;
  };
  evidence?: { traceEventIndexes?: number[]; scorecardRef?: string };
  strategy: { id: string; version: number };
  ts: number;
}
```

#### 两种运行形态

| 形态 | 适用 | 执行位置 | 约束 |
|---|---|---|---|
| 声明式策略 | 正则匹配、字段统计、常见比率/分位数 | worker 内 observer 热路径 | 只允许受限 DSL；必须满足 `budget` |
| 脚本策略 | 复杂解析/跨事件关联/自定义指标 | 异步后台队列；必要时经 `ExecutePorts.runLanguage` | 只收不可变事件快照；输出 `ActivityFactor[]`；不得影响任务执行 |

跨任务窗口的状态归属必须显式：

- `window.type="task"`：只看当前任务事件快照，可在 worker 内完成；
- `window.type="fixed" / "sliding"`：聚合状态归 `OptimizationLoopRuntime` / observation store，不归单个 worker；worker 只提交事件或因子增量；
- 窗口单位必须明确为任务数、事件数或毫秒；v1 建议先只支持任务数，时间窗后续扩展；
- 全局标签基数必须有上限（如 tool×adapter×target×errorClass 组合封顶），超限只保留 top-N + `other`。

脚本策略不直接在 worker 主路径里 `eval`。它要么：

1. 在任务结束后由 `TaskOutcomeObserver` 异步执行；要么
2. 进入 bounded queue / outbox，由独立观察 worker 执行。

#### 与现有结构的接法

- **输入**：`AgentTraceEvent`、`ToolOutcome`、`WorkerScorecard`、任务终态 `TaskOutcome`；
- **产出**：`ActivityFactor`，写入 `activity-factor` 观测面或挂到 scorecard 扩展字段；
- **消费**：sensor 优先读取活动因子；只有证据不足时才回读 transcript / 原始 trace；
- **治理**：观察策略像 tool-reg / skill 一样版本化，部署前过校验；脚本策略需审核；运行失败只记录 `observation-strategy-error`，不影响 worker 任务；
- **性能**：声明式策略必须 O(events) 且有 budget；脚本策略不得阻塞 `runOnce` / task dispatch。

#### 与 TCE 的关系

观察策略不是业务工具，不进入 Tool 层工具面；它是 Command/Execute 观测消费器。若策略需要执行自定义脚本，则脚本执行仍走 Execute 层接口，能力面最小化，不绕过 TCE。

### 7.7 LLM worker 与 code worker 统一

**结论：可以统一，但应统一“契约、身份、观测与治理”，不要强行统一调度通道。**

建议引入统一的 worker 形态：

```ts
export type WorkerKind = "llm" | "code" | "hybrid";

export interface WorkerUnitSpec {
  id: string;
  version: number;
  kind: WorkerKind;
  /** kind=llm/hybrid 时绑定角色；kind=code 时可为空 */
  roleId?: string;
  /** kind=code/hybrid 时绑定代码 worker（观察策略 / processor / handler） */
  strategyRef?: string;
  consumes: string[];                 // trace / task / metrics / intake-run / memory...
  produces: string[];                 // activity-factor / proposal / task-result...
  budget?: { maxRunMs?: number; maxTokens?: number; maxFactors?: number };
}
```

对应关系：

| 当前形态 | 规范化解释 | 调度通道 |
|---|---|---|
| LLM worker | `kind=llm`，由 RoleDefinition + TaskLoop 承载 | 任务队列 / agent loop |
| code worker | `kind=code`，由观察策略、processor、stage handler 承载 | optimization loop / outbox drainer / interval scheduler |
| hybrid worker | `kind=hybrid`，代码先做筛选/聚合，LLM 做复核/解释 | 代码热路径 + 任务队列 |

统一边界：

- 统一身份、版本、输入输出、budget、trace/activity factor 观测、治理提案格式；
- 不要求 code worker 去抢任务队列；
- 不要求 LLM worker 承载高频确定性计算；
- code worker 若需执行脚本，仍走 Execute 层或异步 observer 通道。

### 7.8 任务模板中的“下游 worker 类型”

当前模板契约**没有**“下游 worker 类型”字段。

现有字段只能表达：

| 字段 | 位置 | 语义 |
|---|---|---|
| `roleTag` | `TaskTemplate` | 默认路由标签 |
| `role` / `tags` | `TemplateTaskSpec` | 发布时的路由覆盖 |
| `workMode` | `TaskTemplate` / `TaskWorkItem` | `run / optimize / intake`，不是 worker 类型 |
| `renderKind` | `TaskTemplate` | 模板渲染产物是 TS 代码还是自然语言 |
| `TaskDelegateInput.to` | delegate 调用 | 明确指定下一个角色 id，但不是 worker kind |
| `TaskDelivery.path` | 任务 payload | 类型树路径，不声明下一步由 code 还是 LLM 接手 |

因此当前无法从任务模板直接回答“接下来由 code worker 还是 LLM worker 接手”。

建议增加可选的 **handoff 声明**，但它只做规划/观测提示，不作为路由权限：

```ts
export interface TaskTemplate {
  // ...现有字段
  handoff?: {
    nextRoleId?: string;
    nextWorkerKind?: WorkerKind;
    reason?: string;
    requiresApproval?: boolean;
  };
}
```

裁决建议：

- `nextWorkerKind` 与 `nextRoleId` 都只是**建议**，不得直接改变路由；
- 真实接手身份仍由 `roleId / tags / TaskDelegateInput.to` 与 Worker Registry 决定；
- `workerKind` 最好从 Worker Registry 派生，不允许外部请求自报；
- `requiresApproval` 只能收紧治理，不得豁免本应存在的人工/对抗性审批；
- 模板作者身份与信任级必须可审计；非人工生成的模板只能落入 draft；
- 对优化 loop 来说，`OptimizationLoopSpec.sensor.type` 已经是更准确的 worker kind 声明，不必强迫每个 task template 都声明下游类型。

---

## 8. 兼容与迁移

### 8.1 代码兼容

- `RunnerConfig` 增加 `execMode`，保留 `aspMode` / `agentMode` 派生字段；
- `AgentToolResult` 增加可选 `feedback`（`CommandFeedback`），保留现有 `error/code` 字段；旧消费方不读 `feedback` 也可继续工作；
- `PTH_ASP_MODE` / `PTH_AGENT_MODE` 继续可读，不删除；
- Tool 层 `ToolSpec` 以 `command` 引用取代 `ToolRegExecutor`；存量 `program/builtin/agent` spec 通过迁移映射到对应 adapter id；
- `validateToolRegSpec` 对旧 spec 做兼容迁移（旧 spec 无 `command` 时按原 executor 推导默认 adapter）。

### 8.2 行为兼容

- 默认 `PTH_EXEC_MODE=tool-call`，现有 flat-mode 全量测试应保持绿色；
- `PTH_ASP_MODE=on` 行为不变（ASP_BLOCK 冻结）；
- `PTH_AGENT_MODE=off` 仍映射为 pulse；唯一显式迁移变更是 legacy `TaskLoop` 的 `TASK_AWAIT_SUSPENDED_CODE` 从终态拒绝收敛为 retryable requeue，与 `AgentTaskRunner` 对齐。

### 8.3 部署文档

- `docs/pth/configuration.md` / `deployment.md` 增加 `PTH_EXEC_MODE` 与 `PTH_PTC_*` 说明；
- 明确冲突规则：`PTH_EXEC_MODE` 显式值优先于兼容别名。

---

## 9. 实施顺序概览

> 具体任务拆分、文件改动、测试清单、验收标准与风险控制见：[execution-modes-and-tool-reg-v2-implementation-plan.md](../plan/execution-modes-and-tool-reg-v2-implementation-plan.md)。本节只保留高层顺序。

### Wave 1：规范化优化循环

- 定义 `OptimizationLoopSpec`：sensor 可为代码/角色/混合形态，频率支持 event / task-finish / window / interval / manual；
- 实现 `ObservationStrategySpec` 与 `ActivityFactor`；
- 把现有 JIT optimizer 包装成第一个规范化 loop；
- 所有 loop 共用 Detect → Propose → Govern → Apply → Verify → Deopt 骨架。

### Wave 2：Tool-Reg v2（Tool 层无类型 + Command adapter）

- ToolSpec 增加 `command` / `returns?`；
- Command 层实现 adapter registry、标准 adapter、静态分析闸、CommandFeedback、durationMs；
- trace/scorecard 扩展 TCE 字段。

### Wave 3：PTH_EXEC_MODE

- 新增 `PTH_EXEC_MODE` 与 `resolveExecMode`；
- runner/task-loop 按 `execMode` 分支；
- 旧配置作为兼容别名。

### Wave 4：脉冲模式正式化

- 将现有降级路径迁移为 `execMode==="pulse"`；
- 收敛 legacy 双写分支；
- 补 trace 标记与测试。

### Wave 5：PTC 迭代模式

- 新增 `runPtcTask`；
- 新增 `PTH_PTC_MAX_ITERATIONS` / `PTH_PTC_MODEL`；
- 生命周期与轨迹事件对齐。

### Wave 6：文档与全量验证

- 更新 `docs/pth/concepts.md`、`configuration.md`、`deployment.md`；
- 更新 `docs/docs-manifest.json`；
- `npm run build` + `npm run lint` + `PTH_ASP_MODE=off npx vitest run` 全量绿。

---

## 10. 待评审决策点

1. `PTH_EXEC_MODE` 是否还需要 `auto` 值（自动按任务/角色选择）？本文暂不引入，保持显式。
2. `external` 的 `target` 与 `backend` 同时提供时以谁为准？建议显式 `target` 优先，`backend` 作为别名。
3. PTC 模式完成判定是否一定要求 LLM 输出 JSON 协议，还是允许“程序 return 非空即完成”的简化模式？本文建议正式版用 JSON 协议，简化模式可后续作为 `pulse` 的增强。
4. tool-manifest 导入器是否本期实现？若只做 tool-reg 校验与执行路径，可延后。
5. `PTH_EXEC_MODE=ptc` 是否需要与 `PTH_ASP_MODE` 互斥？本文建议互斥（asp 是 tool-call 变体，ptc 是另一执行范式），冲突时 `PTH_EXEC_MODE` 优先。
6. Command adapter 是否允许用户注册**任意 TS 脚本**？本文建议：允许“受治理的自定义 TS adapter”，但必须过 AST 静态分析 + 提案审核；内置 adapter 与代码同库受评审；所有 adapter 只能产出 `ExecutionRequest` 或 `deny`，不得持有 `ExecutePorts`，不得返回最终 `execute/await-approval` 决策，也不能直接碰文件系统/网络。
7. Tool 层 `command` 引用与 adapter 元数据（如 `argvTemplate`/`target`）的存放位置：全部放 tool-reg 机读行，还是 adapter 元数据放代码注册表、tool-reg 只放 `command` id？本文倾向后者；但 `programAdapter` 这类由治理通道运行时晋升的 adapter，其元数据/源码可存放在受治理的数据面（memory/toolstore），Registry 只保存已批准引用与版本。
8. `CommandFeedback` 是否进入 `AgentToolResult` / tool 消息的稳定契约？本文建议进入（作为可选结构化字段），否则 LLM/PTC 只能解析自然语言错误，无法稳定区分“可修正参数错误”与“治理拒绝”。
9. `ToolSpec.returns` 是否应设为必填？本文建议 v1 可选：全局执行信封固定，业务返回值 schema 只对高价值/可组合工具逐步补齐；强制必填会抬高存量工具迁移成本。
10. 优化循环是否新增 `OptimizerSuggestion.kind = "tool" | "adapter" | "skill"`？本文建议新增，但都必须转对应治理提案流；不允许优化环绕过治理直接改工具/连接器/skill。
11. `ActivityFactor` 的存储面是 memory 条目、指标库，还是两者双写？本文建议：明细/证据以 `activity-factor` 条目留痕，聚合指标进 scorecard/metrics；sensor 查询优先读活动因子。
12. 规范化优化循环的调度权归属：`OptimizationLoopRuntime` 自调度，还是复用 system triggers？本文建议：loop runtime 负责声明式频率与预算，system triggers 只作为唤醒/驱动入口，不复制调度语义。
13. 任务模板是否新增 `handoff.nextWorkerKind` / `handoff.nextRoleId`？本文建议：可作为可选规划/观测提示；真实接手身份仍由 role/tag/delegate 与 Worker Registry 决定；`workerKind` 不允许由外部请求自报为路由权限，`requiresApproval` 只能收紧治理不得放松。

---

## 11. 参考

- `docs/pth/plan/llm-tool-notebook-unified-execution-backend-plan.md`：TCE 三层 / 全量收编 / 信封模型。
- `docs/pth/design/n14-sensor-controller-four-dims.md`：tool-reg 一等通道、三态执行体、治理流。
- `docs/pth/concepts.md`：PTC 范式、智力代偿三级形态。
- `docs/pth/design/task-lifecycle-and-context-design.md`：goal / pause / 压缩 / ASP 双轨。
