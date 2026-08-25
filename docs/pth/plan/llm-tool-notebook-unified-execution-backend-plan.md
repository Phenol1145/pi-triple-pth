# LLM 工具面 + Jupyter Notebook 统一执行后端计划

> 状态：已实施（主路径已落地；2026-08-23 验收通过，本文档保留为设计/落地对照）
> 目标：把 LLM 工具面的语言执行（ts/python/bash 动作工具）与 Jupyter Notebook cell 执行统一到同一个 **ExecutionTarget 矩阵 / 统一执行分发器** 上，共享目标解析、执行协议、会话语义、结果契约与安全策略。
> 关联：`docs/pth/plan/execution-target-matrix-plan.md`（已实施 Phase 1–5 的 Notebook 路由）、`docs/pth/design/task-lifecycle-and-context-design.md`（任务生命周期与上下文设计——goal/暂停/压缩/ASP 双轨；与本文档正交，接口见其 §6）、`packages/pth-kernel-execution/src/execution/agent-tools*.ts`、`packages/pth-kernel-execution/src/exec-channel.ts`、`src/pth/kernel/assembly.ts`。
> v2 修正（2026 复审）：①批准按**行为者**判定而非按执行面；②Command 层输出**三态 CommandDecision**（execute / deny / await-approval）；③Tool 层**严格 per-tool schema**（禁止通用 argv 透传工具）；④target 决策整体上移到 Command 层，Execute 层纯化为结构路由；⑤明确**控制面（多层优化环）与数据面（TCE）**的分工——优化环可执行产物必须穿 TCE，PTC/tool-call 平衡点接入优化环动态治理（§3.6）；⑥**全量 TCE**——一切入口（动作工具 / tool-reg / capability-as-action / notebook cell）皆命令过三层；粒度管入口不管函数调用（信封模型，§3.7）。

---

## 1. 背景与动机

### 1.1 现状

当前存在两条并行的“语言执行”路径：

```
LLM 工具面：
  LLM tool_calls
    → agent-loop.executeStep
    → AGENT_TOOLS[ts.run/python.run/bash.run/eval]
    → kernel.ts / kernel.python / kernel.bash（WorkerKernel）
    → sandbox / engine-ts（写死）

Jupyter Notebook：
  pi-kernel cell magic
    → POST /api/v1/kernel/notebook/execute
    → KernelExecChannel.executeNotebookCell()
    → ExecutionTargetRegistry + targetBackendExecutor（已接入矩阵）
    → sandbox / engine-ts / command（部分）
```

两条路径在语言执行层高度相似，但各有独立的调用链、会话管理和结果投影：

| 维度 | LLM 工具面 | Jupyter Notebook |
|---|---|---|
| 路由 | 无（直接 kernel） | ExecutionTargetRegistry（已实现） |
| 会话 | WorkerKernel 任务级 reset | KernelExecChannel.notebookSessions 每 notebook 独立 |
| 结果 | AgentToolResult + output mode | NotebookCellResult |
| 命令 target（local/tool/jupyter） | 不可达 | 已预留 |
| 安全面 | ASP 空间门控 + 角色 capabilities | HTTP bearer + 人类显式 target |

### 1.2 目标

1. **统一语言执行入口**：ts/python/bash 的“执行一个代码片段”不再由各消费方自行拼 kernel/backend，而是统一走 `CommandGateway → UnifiedExecutionDispatcher`。
2. **统一目标矩阵**：LLM 工具与 Notebook 使用同一份 `ExecutionTargetRegistry`，同一套 `requiresApproval/userSelectable/defaultFor` 语义。
3. **统一会话抽象**：任务级会话与 notebook 级会话实现同一个 `ExecutionSessionHost` 接口；状态隔离语义保留，但调用方不再关心具体 host。
4. **统一结果契约**：`ExecutionResult` 作为中间表示，各消费方只做自己的投影（agent output mode / notebook response）。
5. **保持安全默认**：LLM 工具默认仍走 `sandbox` / `engine-ts`，不因统一而扩大攻击面。

### 1.3 非目标

- 不重新发明 execution/v1.1 协议。
- 不把 `target` 选择权默认暴露给 LLM（见 §6 决策 1）。
- 不实现富媒体 MIME bundle。
- 不删除 `KernelManager` / `WorkerKernel`——它们降级为 Unified Execution 的 session host。
- loop 控制原语（done）不进 TCE——它由 agent-loop 拦截，从来不是执行（见 §6 决策 12）。
- PTC 程序**内部**的能力调用不逐次穿网关——由程序命令的授权信封治理（§3.7）。

### 1.4 三层执行面模型（v2 修正版）

```
┌────────────────────────────────────────────────────────────┐
│ Tool 层：完整 tool call 定义，面向 LLM 的 interface          │
│   严格 per-tool schema（见 §3.1 构建规则）                   │
│   只产出 ToolCall（schema 已校验），不执行                   │
└──────────────────────────────┬─────────────────────────────┘
                               ↓ ToolCall / NotebookCell
┌────────────────────────────────────────────────────────────┐
│ Command 层：翻译 + 目标决策 + 权限审查                       │
│   1. translate：ToolCall → draft ExecutionCommand           │
│      （语言工具→code；tool.<name>→argv 模板槽位填充）        │
│   2. resolveTarget：默认路由 / 显式选择策略 → 具体 target id │
│      （LLM surface 没有 target 字段——schema 层就不存在）     │
│   3. authorize：EXEC_TOOL_CAP + 批准（按行为者，见 §3.4）    │
│   输出：三态 CommandDecision                                │
└──────────────────────────────┬─────────────────────────────┘
                               ↓ ExecutionCommand（target 已具体）
┌────────────────────────────────────────────────────────────┐
│ Execute 层：纯结构路由 + 执行                                │
│   1. registry.get(target) + 结构断言（kind×binding 匹配、    │
│      dev-container 拒 language、requiresApproval 须有 approval）│
│   2. 按 binding 分发：engine-internal / session / backend    │
│   3. 归一化 ExecutionResult                                 │
└────────────────────────────────────────────────────────────┘
```

关键约定：

1. **Tool 层不执行**：只负责 schema 与 tool call 契约。
2. **Command 层不直接执行**：产出 `ExecutionCommand` + 决策；不 import backend/kernel 实现（端口注入）。
3. **Execute 层不做策略决策**：target 已由 Command 层解析为具体 id；Execute 只做结构安全断言（defense-in-depth）。
4. **Command 对象是 Command→Execute 的唯一契约**：`language`（代码）/ `external`（argv 白名单命令）/ `internal`（进程内能力调用——dev/write/debug/obs/manage 等，见 §3.7）。
5. **入口不必穿全三层**：notebook cell 是用户写的代码而非 LLM tool call，HTTP 路由直接进 Command 层；受信内部运行时（professional runtime 的 `execViaBackend`）可直进 Execute 层（盖 system 上下文）。
6. **tool-container 定位**：Tool 层暴露 per-tool 工具（如 `tool.as_x86_64`）；Command 层按 manifest 模板翻译成 argv；Execute 层路由到 `tools-compiled` / `tools-network`。绝不让 `bash.run target=tools-compiled` 绕过白名单。

---

## 2. 现状盘点（grounded inventory）

### 2.1 语言执行消费点

| 消费点 | 文件 | 当前调用 |
|---|---|---|
| agent ts.run / ts.eval | `packages/pth-kernel-execution/src/execution/agent-tools-registry.ts` | `runPtcProgram`（PTC 统一执行缝） |
| agent python.run / python.eval | 同上 | `kernel.python.execute` |
| agent bash.run / bash.eval | 同上 | `kernel.bash.execute` |
| agent capability-as-action 降级 | `agent-loop.ts` | `runPtcProgram` |
| notebook cell | `exec-channel.ts` | `ExecutionTargetRegistry` + `KernelManager` / `targetBackendExecutor` |

### 2.2 ExecutionTarget 现状

- 类型/校验：`packages/pth-contracts/src/execution-target.ts`
- 注册表：`src/pth/execution/execution-target-registry.ts`
- 路由：`packages/pth-kernel-execution/src/execution/notebook-target-router.ts`
- 静态矩阵：`deploy/executor-matrix.json`
- 命令 target：由 `PTH_EXEC_BACKENDS` / tool / service registry 派生，`languages` 目前只有 `["bash"]`，`requiresApproval=true`。
- `resolve()` 目前内嵌 `requiresApproval` / `userSelectable` 抛错——v2 移出（见 §3.3）。

### 2.3 会话现状

- 任务级：`WorkerKernel`（task-loop 每任务 `kernel.reset()`，ts/python/bash 三核状态任务内共享）。
- Notebook 级：`KernelExecChannel.notebookSessions`（每 session 一个 `KernelManager`，python/bash 状态隔离，ts 独立 vm）。
- 一次性 command：无会话，每 cell 独立。

### 2.4 权限与审核现状（复用清单）

| 机制 | 位置 | 复用方式 |
|---|---|---|
| HTTP bearer 认证（tenant/role/principalId/space） | `src/pth/gateway/auth.ts` | notebook 入口 Command ctx 盖章来源 |
| 角色能力门控 `EXEC_TOOL_CAP` | `agent-loop-prompt.ts` + `agent-loop.ts` | 抽成 Command 层共用纯函数（单一事实源） |
| 签名 ExecutionGrant（HMAC/lease/TTL/replay guard） | `src/pth/execution/authorization/execution-grant-service.ts` | 任务级 grant 路径维持现状，不进本计划 |
| human-requests（PG/CAS/幂等/waiting-human） | `src/pth/interaction/*` + `routes-human-interaction.ts` | `HumanApprovalGateway` 端口进程内适配 |
| `TaskSuspension{kind:"human"}` + `onSuspension` 钩子 | `pth-contracts/human-interaction.ts` + `task-dispatcher.ts` | agent 侧 await-approval 落点（需在 bootstrap 接线） |
| tool manifest / registry（argv 白名单、hostOnly） | `src/pth/tools/tool-manifest.ts` / `tool-registry.ts` | per-tool schema 与 argv 模板的事实源 |

---

## 3. 层契约设计（v2）

### 3.1 Tool 层：严格 per-tool schema 构建规则

**构建规则（强约束，违反即拒绝注册/暴露）：**

1. 每个 LLM 可见工具必须有**独立的 JSON schema**；禁止任何“通用 argv/代码透传”工具进入 LLM 工具面。
2. tool-container 工具的 args → argv 只能经 manifest 声明的 `argvTemplate` **槽位填充**（`{{slot}}`），LLM 无法注入模板之外的参数；槽位必须全部在 `argsSchema.properties` 中声明。
3. argv 永远是数组形式，绝不拼接 shell 字符串。
4. `hostOnly` 工具（secrets 域）永不进入 LLM 工具面；`engineVisible=false` 同理。
5. 路径类参数在 schema 中用 `pattern` 约束（拒绝绝对路径与 `..` 穿越）。
6. 语言 meta-tool（`ts.run/eval`、`python.run/eval`、`bash.run/eval`）的 schema 即现有 `PTC_TOOL_DEFS`，天然满足 per-tool schema；**不含 `target` 字段**（决策 1）。
7. Tool 层只做声明 + 参数校验，产物 `ToolCall`，不执行。

**manifest 扩展（`src/pth/tools/tool-manifest.ts` 的 `ToolDefinition`）：**

```json
{
  "name": "as-x86_64",
  "argv": ["x86_64-linux-gnu-as"],
  "description": "GNU as 交叉汇编器（x86_64）",
  "engineVisible": true,
  "hostOnly": false,
  "modes": ["sync"],
  "argsSchema": {
    "type": "object",
    "properties": {
      "src": { "type": "string", "pattern": "^[^./][^\\n]*$", "description": "汇编源文件（容器工作区相对路径）" },
      "out": { "type": "string", "pattern": "^[^./][^\\n]*$", "description": "输出目标文件" }
    },
    "required": ["src", "out"],
    "additionalProperties": false
  },
  "argvTemplate": ["-o", "{{out}}", "{{src}}"]
}
```

校验（fail-closed，加载即校验）：
- `argvTemplate` 每个 `{{slot}}` ∈ `argsSchema.properties`；模板引用的槽位 ∈ `required`；
- 无 `argsSchema`/`argvTemplate` 的工具 `engineVisible` 必须为 false（即默认不对 LLM 暴露，逐个策展放开）；
- 三套交叉工具链（x86_64/aarch64/riscv64 的 as/ld/objdump）同构，策展一份模板生成三份，成本可控（16 个 compiled 工具 ≈ 8 种 schema 形态）。

**Tool 层生成器**：manifest + registry → LLM 工具定义列表（`tool.<name>`，name 经命名规范化），喂给 agent-loop 的工具面装配。

### 3.2 Command 层：CommandGateway + 三态 CommandDecision

```ts
// Command 层输入（入口归一）
type CommandInput =
  | { surface: "agent-tool"; toolCall: ToolCall; ctx: CommandSecurityContext }
  | { surface: "notebook"; cell: { language; code; target?; sessionId?; timeoutMs? }; ctx: CommandSecurityContext };

// Command 层输出（三态——批准是异步的，二态 ok/not-ok 表达不了“等人工”）
type CommandDecision =
  | { kind: "execute"; command: ExecutionCommand }               // target 已解析为具体 id
  | { kind: "deny"; reason: string }
  | { kind: "await-approval"; requestId: string; command: ExecutionCommand };

interface CommandGateway {
  decide(input: CommandInput): Promise<CommandDecision>;
}
```

内部管线（纯函数 + 注入端口）：

1. **translate**：
   - 语言工具 → `kind:"language"`（code/mode/sessionId/space/taskWorkspace/caps 归一化）；
   - `tool.<name>` → `kind:"external"`（manifest argvTemplate 槽位填充 argv；name → tool-registry 查 backendId 作为 target）；
   - 其余动作工具 / capability-as-action → `kind:"internal"`（capability + args——映射见 §3.7）；
   - notebook cell → `kind:"language"`（code 直传，sessionId/timeoutMs 透传）。
2. **resolveTarget**：
   - 显式 target（仅 notebook/人类 surface 可携带）：校验存在、支持该 language/kind；
   - 缺省：`registry` 按 `defaultFor` 默认路由（安全默认 sandbox / engine-ts）；
   - 输出**具体 target id** 写进 command——Execute 层不再做任何路由策略。
3. **authorize**：
   - 角色能力：`EXEC_TOOL_CAP` 抽为共用纯函数（agent-loop 现有检查改为调它）；internal/信封按 §3.7 能力策略表判定；角色 `capabilities` 数组为唯一事实源；
   - `hostOnly` / `engineVisible` 检查；
   - 批准（按行为者，见 §3.4）。

### 3.3 Execute 层：纯结构路由

```ts
interface UnifiedExecutionDispatcher {
  execute(command: ExecutionCommand): Promise<ExecutionResult>;
}
```

- 输入 command 的 `target` **必须是具体 id**；dispatcher 只 `registry.get(id)`，不再 `resolve(language, null)`。
- 结构断言（defense-in-depth，fail-closed）：
  - kind × binding 匹配（external 只能去 execution-backend；engine-internal 只收 ts）；
  - `profile === "dev-container"`（tool-container）拒绝 `language` 命令，只收 `external` argv；
  - `target.routing.requiresApproval && !command.security.approval` → 拒绝（即使调用方绕过 Command 层也安全）。
- 按 binding 分发：`engineTsExecutor`（复用 `runPtcProgram`）/ `sessionExecutor` / `commandExecutor`；`internal` 命令经 **internalExecutor 注册表**（capability → 实现）分发——dev/write/debug 等工具体从 AGENT_TOOLS 搬迁为实现（行为不变，只搬管线）。
- `ExecutionTargetRegistry.resolve()` **纯化**：删除 `requiresApproval` / `userSelectable` 抛错，回归“纯解析”；显式选择策略全部在 Command 层。
- 结果归一化为 `ExecutionResult`；消费方投影（agent `applyOutputMode` / notebook `NotebookCellResult`）留在各自入口。

> 迁移顺序注意：exec-channel legacy 路径目前没有 dev-container 防护，删除 `resolve()` 抛错必须与 exec-channel 切换到 dispatcher（或给 legacy 路径补结构断言）同批进行，否则会短暂打开 `%%bash tools-compiled` 的 `bash -lc` 缺口。

### 3.4 批准模型：按行为者（actor），不按执行面

`requiresApproval` 的含义：**当发起者不是可确认的人类时，需要人类批准**。批准门控行为者，不门控 surface。

| 行为者 | surface | requiresApproval 处理 |
|---|---|---|
| 人类 principal（bearer 认证，Jupyter UI 显式操作） | notebook | **选择即批准**：Command 层盖 `approval: { ref: "principal:<principalId>", decision: "approved" }`（自批准，进审计），直接 execute |
| LLM / agent（task 上下文，人未看过具体命令） | agent-tool | 三态 `await-approval`：`HumanApprovalGateway` 发起 human-request → `TaskSuspension{ kind:"human", requestId }` → task `waiting-human` → 人工响应后任务回 `pending` 重跑，重跑时 ctx 携带 `approval: { ref: requestId, decision: "approved" }` |
| 受信内部运行时（professional runtime 等） | （直进 Execute） | 盖 system 上下文；如改走 Command 层则 auto-approve 策略 |

细则：

1. **命令指纹绑定**：发起 human-request 时把 `tool + args + target` 的 hash 存进 `human_requests.payload`；验证 approval ref 时比对指纹，防“批准 A 命令、执行 B 命令”。
2. **复用现有 API**：`HumanApprovalGateway` 是端口；进程内实现直接包 `PgHumanInteractionService`（与 `POST /api/v1/human-requests` 同一存储同一语义），**不新建审批存储/API**。`human_requests` 契约不变（仍 task-only——notebook 不需要异步批准）。
3. **notebook 202 语义**：人类 surface 自批准，无 202；若未来出现“LLM 驱动 notebook”通道，它从 agent surface 进入，自动落入 await-approval。
4. **onSuspension 接线**：`TaskDispatcher.onSuspension` 钩子已存在但未装配，本计划补上（bootstrap/task-loop）。

### 3.5 tool-container / 专业化本地执行器怎么调用

tool-container（`tools-compiled` / `tools-network`）与 `local-lean` / `local-u8` 等“专业化本地执行器”在现有代码里已经有一条成熟调用链，统一计划应复用而不是绕过：

```
~/.pi-triple/tool-containers.json / services.json
  → buildExecutionBackendRegistry()
  → HttpExecutionBackend{ id: "tools-compiled" | "tools-network" | "local-lean" | ... }
  → buildExecutionTargetRegistry()
  → ExecutionTarget{ binding: { type: "execution-backend", backendId } }
  → UnifiedExecutionDispatcher.commandExecutor
  → backend.execute({ cmd: [tool, ...args], cwd, timeoutMs, maxStdoutBytes, maxStderrBytes })
```

具体到 tool-container：

- **它不是通用 shell**，而是“argv 白名单”容器。manifest 里每个工具声明 `argv`（如 `bf`、`x86_64-linux-gnu-as`、`qemu-x86_64`），容器网关按白名单服务端放行（第二道防线）。
- 因此 **不能** 用 `bash -lc <code>` 这种通用 command adapter 去调 tool-container；那会绕过 argv 白名单，把容器变成任意命令执行面。
- 正确调用方式是 **按工具名 + 参数数组**：
  ```ts
  await backend.execute({
    cmd: ["x86_64-linux-gnu-as", "-o", objPath, srcPath],
    cwd,
    timeoutMs,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  });
  ```
- 当前生产已经这么做：`createAssemblyRuntimeAdapter()` 通过 `execViaBackend(backend)` 调 `tools-compiled` 的 `as/ld/objdump/qemu-*`；`u8/lean4/chem` 通过 `local-u8/local-lean/local-chem` 走同一 `execViaBackend` 桥。

对统一执行后端的影响：

1. **Notebook `%%bash tools-compiled` 被拒绝**：tool-container 不是 bash 解释器（Execute 层结构断言拒绝 language→dev-container）。Notebook 调工具走 per-tool 工具面或后续 notebook 侧的 tool cell magic。
2. **LLM 工具面**：不暴露 `tools-compiled` 为 `bash.run` 的 target；暴露 per-tool schema 工具（§3.1），Command 层翻译成 argv。
3. **commandExecutor 按 target profile 分派**：
   - `local-lean` / `local-u8` / `jupyter`：可接受 language→argv 包装（`bash -lc` / `python3 -c`，受控 profile）；
   - `tools-compiled` / `tools-network`（dev-container profile）：只收 `external` argv。

### 3.6 控制面（多层优化环）与数据面（TCE）的关系

体系内已有多层优化环（L0 护栏三段式 / L1 worker-scorecard / L2 refiner / L3 optimizer-loop / L4 perf-autopilot + 横切 tool-reg 注册通道）。它们是**控制面**；TCE 是**数据面**。两者正交：

- **控制面自身不穿 TCE**：其部署动作（optimizer-apply 直写 store、perf-autopilot 调 PTH_* 参数）走有意的特权治理通道（不经 worker 面 memory-policy——防自批），这在 TCE 下依然成立。
- **控制面的可执行产物落在数据面上时必须穿 TCE**——这是现状缺口。

**现状缺口（TCE 收编清单）：**

| 产物/路径 | 现状 | TCE 收编 |
|---|---|---|
| tool-reg program 态 | agent-loop 直拼 `const args=…; source` → `runPtcProgram`，**跳过 EXEC_TOOL_CAP 调用时门控**（agent-loop.ts:435-456；builtin 归并路径注释明示"走下方标准路径（含 EXEC_TOOL_CAP 门控）"） | CommandGateway 翻译为 language command（args 注入属翻译细节） |
| tool-reg agent 态 | runChild 穿透，父级无门控 | runChild 之前过 Command 层门控 |
| tool-reg builtin 态 | 归并静态面，有 EXEC_TOOL_CAP | 不动 |
| capability-as-action 降级桥 | 幻觉工具名自动包 ts 程序直跑，连 Tool 层 schema 校验都没有 | 随 AGENT_TOOLS 语言执行器一同迁移 |

收编优先级高于 AGENT_TOOLS 迁移，理由：结晶通道的产物是**系统生成的可执行物**（refiner LLM 提炼 / optimizer 数据驱动建议）。tool-reg 现有治理全在**注册时**（draft→official 监督批准 + visibility 窄投放 + 快照冻结 + budget≤24），但**调用时**无门控——注册时批准 ≠ 调用时授权。自进化环越成功，绕过权限模型的执行面越大。

**优化环资产按 TCE 层分类**（可优化资产边界清晰化，deopt 回滚粒度按层定）：

- Tool 层资产：role-doc 规则 / capability-index / tool-reg 条目（per-tool schema）/ 角色工具面配置
- Command 层资产：guard 阈值（PTH_GUARD_*）/ EXEC_TOOL_CAP 映射 / 批准策略
- Execute 层资产：perf 参数（PTH_* 超时/并发/预算）

**Command 层是优化环的新观测点（sensor 数据源）：**

三态决策产生的新信号进 scorecard 供 optimizer 消费：
- deny 率（按角色/工具分账）——"某角色高频 deny → 能力与任务错配 → 路径 B 角色分化"信号；
- await-approval 率 / 批准拒绝率——批准策略校准；
- 命令指纹不匹配次数——安全审计信号。

**PTC 与 tool-call 平衡点的动态治理（接入优化环，不自建流水线）：**

PTC 与直接 tool call 共享 Command/Execute 层，平衡纯粹是 Tool 层的暴露策略；平衡点**不是静态设计出来的，而是优化环按角色调出来的**（optimizer 哲学：重构分工使每个角色所需智力下降）。全部复用现有环：

1. **scorecard 增加 PTC 能力面观测**（唯一新埋点）：PTC runner 上报程序内 capability 调用频次/失败——现有 toolFreq 只统计 tool 粒度（ts.run 算 1 次），程序内部是黑盒。该黑盒同样遮蔽治理角色自身：sensor 的 `obs.*` 调用发生在 ts 程序内，scorecard 不可见——**优化环观测不了自己的观测者**。
2. **hotspots 规则表加 PTC 粒度反模式**：`ptc-trivial`（单表达式 ts.run——该用 ts.eval/直调）、`ptc-iso-heavy`（高频同构程序——该结晶为 tool-reg program 条目）。
3. **路由规则经优化环路径 A 落地**："单操作用 eval/直调、组合逻辑用 ts.run"作为 role-doc 规则产物（数据驱动生成），而非手写死在 prompt。
4. **结晶产物落 tool-reg 注册通道**（program 执行体），自动获得 draft→official / visibility / 快照 / budget / deopt 治理；L0 加路由纠偏护栏（单表达式 run / 依赖链直调 → guide 提示，复用三段式）。

**sensor/controller 专用工具面登记（internal 形态的事实源）：**

sensor/controller 的专用工具不是动作工具，而是两个 PTC 能力扩展（角色 `capabilities` 数组门控；actionTools 只给通用执行核 execTs/execPy/execBash/nav/cache）：

- **obs 扩展**（sensor 系，capabilities 含 `obs`）：`obs.tasks / callpoint / guards / metrics / batches / kernels / search / memory / pg / storage / container / resource`——全部只读；SQL 白名单参数化防注入、固定 IPC 通道。obs=读 / manage=写，读写分离。
- **manage 扩展**（controller 系，capabilities 含 `manage`）：`manage.params.set`（PTH_ 前缀白名单热调）/ `resource.config` / `memory.archive` / `worker.propose` / `tool.register/revise/list/importMcp` / `fix.approve`——**写动作全部强制 draft 提案**（memory kind 提案通道，监督层流转）。

推论：manage 写动作的 draft 提案就是 await-approval 的能力面版本（走 memory 提案通道而非 human-requests）。全量 TCE 收编后（§3.7），Command 层 authorize 识别“能力自带 draft 语义”，不重复发起批准。

### 3.7 全量 TCE：一切入口皆命令（粒度定义 + 信封模型）

**粒度定义（决策 12）**：TCE 管**入口**（tool call / 程序 / cell），不管程序内部的函数调用。若让 PTC 程序内每次 `memory.query(...)` 都过 CommandGateway，PTC 的核心优势（控制流下沉、能力调用 = 廉价进程内调用）即被摧毁。

**信封模型**：PTC 程序的治理发生在程序边界——

```
ts.run(code) 入口 = language command
  → Command 层 authorize：静态越界预检提取程序用到的能力集合 ⊆ role.capabilities
  → Execute 层：按授权集合注入 caps（runPtcProgram 现状机制）
  → 程序结束：PTC runner 上报能力用量（G1 观测埋点落位，§3.6）
```

程序内部调用由该命令的**授权信封**治理；运行时逐调用检查仅作 defense-in-depth（本地集合查询，O(1)）。

**全工具映射表**：

| 现有工具 | 命令形态 | 说明 |
|---|---|---|
| ts/python/bash run/eval | `language` | 已是 |
| tool-container per-tool | `external` | argvTemplate 槽位填充 |
| dev.write/edit、write.*、dev.save/list | `internal`（fs.write / toolstore） | 工具体搬进 internalExecutor 实现 |
| dev.build/run | `internal`（c.build/c.run） | C/asm 核选择、asm 惰性注册留在执行实现 |
| debug.* | `internal`（debug 会话 API） | HTTP 细节沉到执行实现 |
| nav（ASP cd/index） | `internal`（会话状态变更） | 边界决策点，也可留 loop 层 |
| capability-as-action | `internal` | 从幻觉降级桥升格为正式路径（Tool 层补 schema） |
| obs.*/manage.*（PTC 内） | 信封治理 | 程序边界授权；manage 自带 draft 语义保留 |
| done | 不进 TCE | loop 控制原语，agent-loop 拦截 |

**能力策略表**（Command 层 authorize 对 internal/信封的判定依据，策展维护）：

- `obs.*`：只读，免批准；
- `manage.*`：自带 draft 提案语义（memory 提案通道）——Command 层识别，不重复发起批准；
- `memory.write` 等自由写：免批准（memory-policy 通道自有治理）；
- 写类/外部副作用能力：按表逐个策展。

**权限唯一事实源**：角色 `capabilities` 数组升格——同一张表同时门控动作面（internal 命令授权）与 PTC 信封（vm 注入 + 预检）。`EXEC_TOOL_CAP` 保留为“命令 → 所需能力”的推导表，判定统一以 capabilities 数组为准。

**收益**：权限检查点收敛为一个；审计完备（每入口带 principal 盖章）；观测黑盒消失（含治理角色自身）；新工具治理规则只剩一条（schema + translator + internal 实现）。

---

## 4. 接入改造

### 4.1 Notebook 侧

- `KernelExecChannel` 增加 `commandGateway?: CommandGateway` 注入；`executeNotebookCell` 改为：
  1. 由 facade/路由传入 HTTP auth 盖章的 `CommandSecurityContext`（取代现在写死的 `engine:notebook-exec-channel` grantIdentity）；
  2. `gateway.decide({ surface:"notebook", cell, ctx })` → `execute` 则 `dispatcher.execute(command)`，投影 `NotebookCellResult`；`deny` 返回结构化错误；
  3. 未注入时保留 legacy 路径（测试/降级兼容）——但 legacy 路径补 dev-container 结构断言（见 §3.3 迁移注意）。

### 4.2 LLM 工具面（agent-tools / agent-loop）

- `AgentToolCtx` 增加 `commandGateway?: CommandGateway` 与 command ctx 所需字段（principalId/tenantId/roleId/taskId/sessionId）。
- `AgentLoopOptions` / `TaskLoopDeps` / `AgentTaskRunnerDeps` 同步透传。
- `AGENT_TOOLS` 语言执行器（ts/python/bash run/eval）改为：
  ```
  decision = await ctx.commandGateway.decide({ surface:"agent-tool", toolCall, ctx })
  execute → 投影 ExecutionResult（applyOutputMode 保持工具层）
  deny → { ok:false, error: reason }
  await-approval → 返回挂起信号（code: HUMAN_APPROVAL_PENDING，runner 落 TaskSuspension）
  ```
- `EXEC_TOOL_CAP` 检查从 agent-loop 内联代码抽为 Command 层共用纯函数，agent-loop 改调它。
- per-tool 工具（`tool.<name>`）经 Tool 层生成器进入工具面装配，executor 统一走 CommandGateway。
- **tool-reg 执行缝收编（优先级最高——系统生成可执行物）**：program 态改走 CommandGateway（args 注入属翻译细节）；agent 态 runChild 之前过 Command 层门控；builtin 态已归并静态面，不动；capability-as-action 降级桥随语言执行器一同迁移。现状 program/agent 态跳过 EXEC_TOOL_CAP（见 §3.6）。
- **internal 命令收编（全量 TCE，§3.7）**：dev.*/write.*/debug.*/nav 等动作工具的工具体搬迁为 Execute 层 internalExecutor 实现注册表；capability-as-action 从“幻觉降级桥”升格为正式 internal 命令路径（Tool 层补 schema）；角色 `capabilities` 数组升格为唯一事实源（动作面门控 + PTC 信封注入共用同一张表）。

### 4.3 装配

- `src/pth/kernel/assembly.ts`：
  - 构建 `UnifiedExecutionDispatcher`（注入 targetRegistry / engineTsExecutor / sessionExecutor / commandExecutor / internalExecutor 缺省）；
  - 构建 `CommandGateway`（注入 registry、HumanApprovalGateway 适配 `PgHumanInteractionService`、角色能力函数）；
  - 传给 `KernelExecChannel`。
- `src/pth/bootstrap/batch-process.ts`（每个 worker）：构建同一实现、scope="task" 的 gateway/dispatcher，经 `TaskLoopDeps → AgentTaskRunnerDeps → AgentLoopOptions` 注入。
- 接线 `TaskDispatcher.onSuspension`（task `waiting-human` 过渡）。
- 修复 assembly `targetBackendExecutor` 的 `bash -lc` 直拼：language→argv 包装仅对非 dev-container profile 合法。

### 4.4 测试

- `command-gateway.test.ts`：翻译（语言/tool/notebook）、目标决策、EXEC_TOOL_CAP 拒绝、人类自批准盖章、agent await-approval、指纹不匹配拒绝。
- `unified-execution-dispatcher.test.ts`：结构断言（dev-container 拒 language、requiresApproval 无 approval 拒绝）、三种 binding 分发、结果归一化。
- manifest schema 校验测试：模板槽位 ∉ properties 拒绝、无 schema 却 engineVisible 拒绝、hostOnly 不进入工具面。
- tool-reg program/agent 态调用时门控测试（EXEC_TOOL_CAP 拒绝、批准流）。
- internal 命令迁移回归（dev/write/debug 行为不变，只搬管线）；能力策略表测试（obs 免批准、manage draft 语义识别）。
- PTC 能力面观测埋点测试（scorecard 可见程序内 capability 调用频次/失败）。
- 回归：agent 工具测试 mock CommandGateway；notebook 路由测试。

---

## 5. 分阶段实施计划

### Phase 1 — Command 层契约
- `execution-command.ts` 增加 `CommandInput` / `CommandDecision` / `CommandGateway` / `HumanApprovalGateway` 端口；`ExecutionCommand.target` 语义改为“具体 id”。
- `EXEC_TOOL_CAP` 抽共用纯函数。

### Phase 2 — Execute 纯化
- dispatcher：target 必具体（删内部默认路由），加 defense-in-depth 结构断言（requiresApproval 无 approval 拒绝）。
- `registry.resolve()` 删 `requiresApproval`/`userSelectable` 抛错（纯化）；**同批**给 exec-channel legacy 路径补 dev-container 结构断言（或切 dispatcher）。

### Phase 3 — CommandGateway 实现与接线
- `src/pth/execution/command-gateway.ts`：translate / resolveTarget / authorize（批准按行为者 + 指纹绑定）。
- `HumanApprovalGateway` 进程内适配 `PgHumanInteractionService`。
- 接线 agent-loop / exec-channel / assembly；接线 `onSuspension`；修 assembly `bash -lc`。
- **tool-reg 执行缝收编（优先级最高）**：program 态 → CommandGateway language command；agent 态 → runChild 前过 Command 层门控；capability-as-action 降级桥随语言执行器迁移。

### Phase 4 — internal 命令收编（全量 TCE，§3.7）
- internalExecutor 注册表（capability → 实现）；dev/write/debug/nav 工具体搬迁（行为不变，只搬管线）。
- 能力策略表策展（obs 免批准 / manage draft 语义识别 / 写类逐个策展）；角色 `capabilities` 数组升格唯一事实源。
- capability-as-action 正式化（Tool 层补 schema）。

### Phase 5 — per-tool 工具面 + 优化环观测扩展
- manifest 扩展 `argsSchema`/`argvTemplate` + fail-closed 校验；策展 19 个工具的 schema（secrets 域维持 hostOnly 不暴露）。
- Tool 层生成器 + agent-loop 工具面装配；Command 层 tool translator。
- scorecard 增加 PTC 能力面观测（PTC runner 上报程序内 capability 调用频次/失败——治理角色自身的 obs/manage 调用同时可见）；hotspots 规则表加 `ptc-trivial` / `ptc-iso-heavy` 反模式；L0 加路由纠偏护栏（三段式复用）。

### Phase 6 — 回归 / 文档
- 全量 `npm run lint` + `npm test`；更新 `concepts.md` / `kernel.md` / `deployment.md` / `pth-api-protocol.md`。

---

## 6. 决策记录（已定）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| 1 | LLM 工具是否暴露 `target` 参数 | **不暴露** | 工具面最小化；目标选择由空间/角色策略派生（schema 层就没有 target 字段） |
| 2 | Command 层输出形态 | **三态 CommandDecision** | 批准是异步的，二态 ok/not-ok 表达不了“等人工” |
| 3 | 批准绑定对象 | **按行为者，不按执行面** | notebook 是人类直接操作（选择即批准）；只有 LLM 自主行为需要人工审批 |
| 4 | tool-container LLM 工具面 | **严格 per-tool schema**（用户裁决） | 禁止通用 argv 透传；args 经 argvTemplate 槽位填充，LLM 无法注入模板外参数 |
| 5 | `registry.resolve` 批准拒绝 | **移出（resolve 纯化）** | 批准来源因行为者而异，归 Command 层；Execute 仅 defense-in-depth |
| 6 | Agent 默认 target | **sandbox / engine-ts（现状不变）** | 安全默认 |
| 7 | 全量 TCE（internal 收编） | **采纳——一切入口皆命令** | 权限点/审计/观测收敛为一个；角色 `capabilities` 数组升格唯一事实源；manage 自带 draft 语义由 Command 层识别，不重复批准 |
| 8 | Notebook ts 是否走 PTC 越界预检 | **走** | 与 agent ts 同一执行缝，安全一致 |
| 9 | human-requests 契约 | **不变（task-only）** | notebook 自批准，无需异步批准上下文扩展 |
| 10 | 优化环可执行产物 | **必须穿 TCE（收编 tool-reg program/agent 执行缝）** | 系统生成代码比人手写更需要调用时门控；注册时批准 ≠ 调用时授权 |
| 11 | PTC / tool-call 平衡点 | **接入多层优化环动态治理，不自建流水线** | scorecard 能力面观测 + hotspot 反模式 + tool-reg 结晶通道 + deopt 回滚均已存在（§3.6） |
| 12 | TCE 粒度 | **管入口不管函数调用（信封模型）** | PTC 程序内能力调用由程序命令的授权信封治理（越界预检 + caps 注入 + 用量上报），保住 PTC 廉价调用优势；done 等 loop 控制原语不进 TCE |

---

## 7. 结论

- 当前 `ExecutionTarget` 矩阵已经为 Notebook 建立了统一目标抽象；本计划把它提升为 **LLM 工具面与 Notebook 共用的语言执行后端**。
- v2 修正的核心：**批准按行为者判定**（人类操作不审批、LLM 行为走 human-requests）、**Command 层三态决策**（execute / deny / await-approval）、**Tool 层严格 per-tool schema**（manifest argvTemplate 槽位填充）、**Execute 层纯化**（target 由 Command 层解析为具体 id，Execute 只做结构断言 + 分发）。
- 控制面/数据面分工：多层优化环（控制面）与 TCE（数据面）正交——优化环的可执行产物必须穿 TCE（tool-reg program/agent 收编为第一优先级）；Command 层三态决策同时是优化环的新观测信号源（deny/await-approval 率）；PTC 与 tool-call 的平衡点由优化环按角色动态治理，不做静态设计。
- 全量 TCE：一切入口皆命令（动作工具 / tool-reg / capability-as-action / notebook cell 统一过三层）；PTC 程序内能力调用由授权信封治理——粒度是入口而非函数调用，PTC 优势不受损；角色 `capabilities` 数组成为权限唯一事实源。
- 落地后，新增一个执行后端（如 local-lean / tool-container / jupyter）只需在矩阵里加 target + 策展 manifest schema，LLM 工具和 Notebook 同时受益。
