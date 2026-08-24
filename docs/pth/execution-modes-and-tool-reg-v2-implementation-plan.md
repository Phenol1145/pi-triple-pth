# PTH 执行模式、Tool-Reg v2 与规范化优化循环实施计划

> 状态：实施中（Wave 0–5 已落地，Wave 6 文档/全量验证进行中）
> 上游设计：[execution-modes-and-tool-reg-v2-design.md](./execution-modes-and-tool-reg-v2-design.md)
> 实施原则：默认行为不变；`tool-call` 仍是主验证路径；旧配置先兼容，后收敛；所有工具/adapter 变更必须可观测、可回滚、可审计。

---

## 0. 实施前提（先锁定）

开始编码前需要确认设计稿 §10 的 13 个决策点。本文先按以下推荐口径实施：

| 决策 | 默认口径 |
|---|---|
| `PTH_EXEC_MODE` | 不提供 `auto`；显式优先 |
| `target` vs `backend` | 显式 `target` 优先；`backend` 作为别名 |
| PTC 完成协议 | 强制 JSON：`{done, program?, reason?, finalResult?}` |
| tool-manifest 导入器 | 本期只做校验/执行路径；导入器可选 |
| `ptc` vs `asp` | 互斥；`PTH_EXEC_MODE` 显式值优先 |
| 自定义 adapter | 允许，但必须过 AST 静态分析 + 提案审核 |
| adapter 元数据 | 内置放代码注册表；运行时晋升的 program adapter 可放受治理数据面，Registry 保存已批准引用与版本 |
| `CommandFeedback` | 进入 `AgentToolResult`，作为可选字段 |
| `ToolSpec.returns` | v1 可选 |
| optimizer 新 kind | 增加 `tool` / `adapter` / `skill`，但只产生治理提案 |
| ActivityFactor 存储 | 明细落 `activity-factor`；聚合进 scorecard/metrics |
| 优化循环调度 | `OptimizationLoopRuntime` 管频率与预算；system triggers 只负责唤醒 |
| 模板 handoff | `nextWorkerKind` 只作建议；真实接手由路由与 Worker Registry 决定 |

---

## 1. 当前实现地图

| 模式/能力 | 当前状态 | 主要文件 |
|---|---|---|
| tool-call | 已实现 | `packages/pth-kernel-execution/src/execution/agent-loop.ts` |
| ASP | 已实现，是 tool-call 的 `asp=true` 变体 | `agent-loop.ts`、`agent-loop-prompt.ts`、`agent-tools.ts` |
| pulse（当前叫降级路径） | 已实现，但不是一等模式 | `src/pth/runner/agent-task-runner.ts`、`src/pth/bootstrap/task-loop.ts`、`packages/pth-kernel-execution/src/execution/nl-translator.ts`、`packages/pth-kernel-interpreter/src/ptc/runner.ts` |
| ptc 迭代模式 | 已实现（Wave 5） | `packages/pth-kernel-execution/src/execution/ptc-agent-loop.ts` |
| Tool-Reg v1 | 已实现 `program/builtin/agent` 三态 | `packages/pth-memory/src/tool-reg.ts`、`src/pth/tasking/tool-reg-builtin.ts` |
| TCE CommandGateway | 已部分接入 | `packages/pth-kernel-execution/src/execution/execution-command.ts`、`agent-loop.ts` |
| scorecard / optimizer | 已实现，但不是 TCE-aware | `worker-scorecard.ts`、`optimizer-hotspots.ts`、`optimizer-loop.ts`、`optimizer-apply.ts` |
| Knowledge Intake | 独立内环，默认 `off` | `src/pth/execution/knowledge-intake/*`、`src/pth/runner/intake-processors.ts`、`src/pth/bootstrap/batch-process.ts` |
| 观察策略 / 活动因子 | 已实现（Wave 5） | `observation-strategy.ts`、`observation-strategy-registry.ts` |

> 当前结构有一个必须处理的债务：`AgentTaskRunner` 与 `TaskLoop.execute()` 里存在两套 agent/pulse 分支。实施时必须把执行模式分支收敛到一个入口，避免继续双写。

### 1.1 与既有工作流的边界

- **优化循环**不是唯一优化通道：JIT Optimizer 会从 scorecard 自动生成建议；sensor/controller 角色也会通过治理任务产生观测和提案；refiner、perf-autopilot、tool/skill 治理流各自独立存在。本计划先把它们统一到 `OptimizationLoopSpec` 骨架，再让它们共享 TCE 观测与治理边界；不把所有优化强行改成 `sensor -> optimizer`。
- **Knowledge Intake** 不走通用 taskflow。它是独立内环：due scanner 创建 `IntakeRun` 并排 `intake.fetch` outbox，生产 drainer 依次消费 `fetch/extract/review-domain/review-adversarial/promote` stage handler；复用 batch、PG、outbox、LLM 调用等基础设施，但不经过 `tasks.publish -> TaskLoop -> worker` 的通用任务链。

---

## 2. 总体顺序

```txt
Wave 0  决策锁定 + 基线验证
Wave 1  规范化优化循环（Canonical Optimization Loop + ActivityFactor）
Wave 2  Tool-Reg v2 + Command adapter + CommandFeedback + TCE 观测字段
Wave 3  PTH_EXEC_MODE + resolveExecMode + runner 接线
Wave 4  Pulse 正式化 + legacy 分支收敛
Wave 5  PTC 迭代模式
Wave 6  文档、全量验证、发布准备
```

依赖关系：

- Wave 1 先统一优化循环骨架与观察策略，不依赖 Tool-Reg v2 全量落地；
- Wave 2 是 Wave 4/5 的基础，并为 Wave 1 补齐 TCE 维度；
- Wave 3 可部分并行 Wave 2，但最终接线依赖统一工具结果契约；
- Wave 5 依赖 `runPtcProgram` 和 `CommandFeedback`；
- Wave 6 最后做。

---

## Wave 0：决策锁定 + 基线验证

### 任务

1. 确认设计稿 §10 的 13 个决策点；
2. 从当前 `main` 建实施分支；
3. 记录基线：
   ```bash
   npm run build
   npm run lint
   PTH_ASP_MODE=off npx vitest run
   npm run check:docs-links
   ```
4. 确认当前未修改文件清单，避免把设计文档改动误带入代码实现。

### 验收

- 基线构建、lint、测试通过；
- 决策点已收敛或在文档中显式标记为“允许后置”。

---

## Wave 1：规范化优化循环（Canonical Optimization Loop）

### 目标

先统一所有优化环的骨架，而不是继续为每个环各写一套调度、观测、提案和回滚逻辑。sensor 可以是代码、角色或混合形态；频率是每个 loop 的一等配置。

### 代码任务

建议新增：

- `packages/pth-kernel-execution/src/execution/optimization-loop-spec.ts`
- `packages/pth-kernel-execution/src/execution/optimization-loop-runtime.ts`
- `packages/pth-kernel-execution/src/execution/observation-strategy.ts`
- `packages/pth-kernel-execution/src/execution/observation-strategy-registry.ts`

#### 1.1 定义统一 Loop Spec

实现：

- `OptimizationLoopSpec`
- `LoopSensor = code | role | hybrid`
- `LoopSchedule = event | task-finish | window | interval | manual`
- `LoopGovernance`
- `LoopVerifyPolicy`
- 共享纯类型：`ExecMode` 与 `CommandErrorClass`（供 ActivityFactor/后续 Wave 复用，避免 Wave 1 反向依赖 Wave 2/3）

要求：

- sensor 只读；
- detect 只产生候选；
- apply 必须走治理通道；
- verify/deopt 是必备节点；
- 每个 loop 有独立 frequency 与 budget；
- 安全敏感 applyChannel 不得使用 `auto-reversible`；
- `auto-reversible` 必须声明 `rollbackRef`。

#### 1.2 实现 ActivityFactor 与声明式观察策略

实现：

- `ObservationStrategySpec`
- `ActivityFactor`
- `ObservationStrategyRegistry`
- 字段路径 matcher；
- eq/ne/gt/gte/lt/lte/contains/regex；
- count/rate/sum/avg/p50/p95/p99/distinct；
- regex 长度与执行 budget。

v1 只要求声明式策略进热路径；脚本策略先走异步队列，不阻塞 worker。

#### 1.3 把现有 Optimizer 包装成一个内置 loop

改造：

- `optimizer-loop.ts`
- `optimizer-hotspots.ts`
- `optimizer-apply.ts`

要求：

- 现有 `Optimizer.collect()` 变成 `optimization-loop:jit-worker` 的 sensor/detect 输入；
- 现有 `detectHotspots()` 变成 loop 的 Detect 阶段；
- 现有 `apply/verify/deopt` 保持治理语义；
- 不改变现有建议内容和默认行为。

#### 1.4 接入现有频率面

- `task-finish`：scorecard / JIT 优化；
- `window`：hotspot 检测；
- `interval`：resource / perf / intake 指标；
- `event`：tool/skill 提案、guard 事件；
- `manual`：operator 触发。

不要求所有 loop 共用一个 scheduler tick。

#### 1.5 统一 LLM worker / code worker 契约

任务：

1. 定义 `WorkerKind = "llm" | "code" | "hybrid"` 与 `WorkerUnitSpec`；
2. 建立 Worker Registry：role worker、观察策略、intake processor、stage handler 都能被同一身份/版本/观测模型描述；
3. 明确调度边界：LLM worker 走任务队列，code worker 走 loop/drainer/scheduler，hybrid 组合二者；
4. 审计 `TaskTemplate`：当前无下游 worker 类型字段；新增可选 `handoff.nextWorkerKind` 仅作为建议，真实接手身份仍由路由与 Worker Registry 决定。

### 测试

- loop spec 校验；
- code sensor 只读；
- role sensor 正常包装为任务型 loop；
- WorkerKind registry 能区分 llm/code/hybrid；
- 模板 handoff 只作建议，不覆盖真实路由；
- 安全敏感 `applyChannel` 不得声明 `auto-reversible`；
- `auto-reversible` 必须有 `rollbackRef`；
- 不同 frequency 的 loop 不互相阻塞；
- task/fixed/sliding 窗口的状态归属明确，跨任务聚合不依赖单 worker 内存；
- ActivityFactor 计算正确；
- 现有 optimizer 行为 golden 不变；
- 策略异常只产生 `observation-strategy-error`，不影响任务。

### 验收

- 现有 JIT optimizer 以“一个规范化 loop”的形式运行；
- sensor 可以是代码策略、角色任务或 hybrid；
- LLM worker / code worker 共享统一身份、版本、观测与治理契约，但调度通道不强行合并；
- 不同 loop 可以有不同频率；
- 首个规范化 loop 具备 Propose → Govern → Apply → Verify → Deopt 的完整骨架；
- 其余优化环至少登记到 Loop Registry，并标注迁移状态；
- 默认任务执行路径无行为变化。

---

## Wave 2：Tool-Reg v2 + Command adapter + CommandFeedback

### 目标

让 Tool 层无类型化，并让 Command 层具备 adapter、错误反馈、耗时和 TCE 观测能力。

### 代码任务

#### 2.1 定义 CommandFeedback / ExecutionRequest / ExecutionCommand 扩展

建议位置：

- `packages/pth-kernel-execution/src/execution/command-feedback.ts`（新增）
- `packages/pth-kernel-execution/src/execution/execution-command.ts`（扩展或 re-export）

内容：

- `CommandErrorClass`
- `CommandFeedback`
- `ExecutionRequest`（adapter 产出的待授权请求）
- `ExecutionCommand` 扩展 `agent` kind（若最终裁决保留 `runAgent`）
- `CommandDecision.deny` 增加可选 `feedback`
- `await-approval` 继续映射为 `HUMAN_APPROVAL_PENDING` + `TaskSuspension`

注意：不要破坏现有 `CommandDecision` 三态；adapter 不得直接执行。

#### 2.2 扩展 AgentToolResult / ToolOutcome

文件：

- `packages/pth-kernel-execution/src/execution/agent-tools-registry.ts`
- 必要时 `agent-loop-types.ts`

新增可选字段：

```ts
feedback?: CommandFeedback;
durationMs?: number;
```

要求：

- 旧消费方不读 `feedback` 也能继续工作；
- `error/code` 保留；
- `durationMs` 从 Execute 层或 agent-loop 计时填充。

#### 2.3 实现 CommandAdapterRegistry 与标准 adapter

建议新增：

- `packages/pth-kernel-execution/src/execution/tool-command-adapters.ts`

内容：

- `CommandAdapterRegistry`
- `builtinAdapter(ref)`
- `externalAdapter({ ref, argvTemplate, target?, backend? })`
- `programAdapter(source)`
- `agentAdapter(role)`

要求：

- adapter 不直接碰 `fs/network/process`；
- external argv 永远数组，不拼 shell 字符串；
- target 解析 fail-closed；
- 自定义 adapter 预留静态分析入口。

#### 2.4 ToolSpec v2

文件：

- `packages/pth-memory/src/tool-reg.ts`

任务：

- 新增 `command: string`；
- 新增可选 `returns`；
- 保留旧 `executor` 读取能力；
- 增加迁移函数：旧 `program/builtin/agent` → 默认 adapter id；
- `buildToolRegContent` 渲染 `command` / `returns`；
- `parseToolRegContent` / `validateToolRegSpec` 支持新旧两种 spec。

#### 2.5 对账与种子更新

文件：

- `src/pth/tasking/tool-reg-builtin.ts`

任务：

- 现有 builtin seed 改为 `command: "builtin:<ref>"`；
- 对账逻辑只要求 builtin adapter 覆盖 `PTC_TOOL_DEFS`；
- external/program/agent adapter 单独校验。

#### 2.6 agent-loop 接线

文件：

- `packages/pth-kernel-execution/src/execution/agent-loop.ts`

任务：

- tool-reg 工具优先按 `spec.command` 查 adapter；
- adapter 返回 `ExecutionRequest` 后必须先规范化为 `ExecutionCommand` 并过 CommandGateway 授权；
- 将 `CommandFeedback` 投影到工具消息与 trace；
- `await-approval` 不被误归类为错误反馈，继续走 human suspension；
- 保持现有静态 `AGENT_TOOLS` 路径不变。

#### 2.7 ExecutePorts / 执行分发实现

任务：

- 明确 `ExecutePorts` 的实现归属（CommandGateway 内部或 UnifiedExecutionDispatcher）；
- `runInternal` 映射现有 `AGENT_TOOLS` / capability 执行；
- `runLanguage` 映射 `runPtcProgram`；
- `runExternal` 映射 execution backend/tool-container；
- `runAgent` 映射 `toolRegExec.runChild`；
- 增加“adapter 直调 ExecutePorts 必须不存在/不可达”的结构测试。

### 测试

新增/更新：

- `packages/pth-memory/test/tool-reg*.test.ts`
- `packages/pth-kernel-execution/test/tool-command-adapters.test.ts`
- `test/pth-execution/agent-loop*.test.ts`

覆盖：

1. 旧 spec 自动迁移；
2. `command` 未注册 → `adapter-not-found`；
3. 参数 schema 错误 → `tool-schema` 且 `retryable=true`；
4. external argvTemplate 缺槽 → `adapter-config`；
5. target 解析失败 → `target-resolution`；
6. Execute 返回失败 → `execution`；
7. `returns.schema` 不匹配 → `return-schema-mismatch`；
8. trace 带 `adapterId/execKind/target/errorClass/errorCode/retryable/durationMs`；
9. adapter 无法绕过 CommandGateway 直调 ExecutePorts；
10. `deny.feedback` 能保留结构化 class/code；
11. `await-approval` 仍进入 human suspension，不被当作普通失败；
12. argv 槽位以 `-` 开头时按规则拒绝或要求 `--`；
13. 存量 tool-reg 条目全部能映射到已注册 adapter，否则启动/迁移审计显式报警；
14. 默认 flat 路径不变。

### 验收

- 全部新增测试通过；
- `npm run build`、`npm run lint` 通过；
- `PTH_ASP_MODE=off npx vitest run` 不出现新增回归。

---

## Wave 3：PTH_EXEC_MODE

### 目标

把执行模式入口从两个环境变量收敛到 `PTH_EXEC_MODE`。

### 代码任务

1. `packages/pth-config/src/schema.ts`
   - 新增 `PTH_EXEC_MODE = tool-call | asp | ptc | pulse`，默认 `tool-call`；
   - 保留 `PTH_AGENT_MODE` / `PTH_ASP_MODE`。

2. `src/pth/runner/runner-config.ts`
   - 新增 `ExecMode`；
   - 新增 `resolveExecMode(env)`；
   - `RunnerConfig` 增加 `execMode`；
   - `aspMode = execMode === "asp"`；
   - `agentMode = (execMode === "tool-call" || execMode === "asp")`。

3. `src/pth/runner/agent-task-runner.ts`
   - 按 `execMode` 分支；
   - `tool-call/asp` 走 `runAgentTask`；
   - `pulse` 走 translate + runPtcProgram；
   - `ptc` 暂报 `unsupported-exec-mode`，等 Wave 5 接入。

4. `src/pth/bootstrap/task-loop.ts`
   - 兼容路径读取同一 `resolveExecMode`；
   - 不新增第二套模式判断。

### 测试

- `runner-config.test.ts`：
  - 显式 `PTH_EXEC_MODE` 优先；
  - `PTH_ASP_MODE=on` → `asp`；
  - `PTH_AGENT_MODE=off` → `pulse`；
  - 默认 → `tool-call`；
  - config schema 默认值不被误认为显式设置；
  - 非法 `PTH_EXEC_MODE` fail-fast；
  - legacy/default 路径缺少 agentCaps 时维持 pulse fallback；
  - 显式 `PTH_EXEC_MODE=tool-call|asp|ptc` 缺必需能力时 fail-closed。
- runner 集成测试：`tool-call/asp/pulse` 能路由到既有执行路径，`ptc` 在 Wave 5 前显式返回 `unsupported-exec-mode`。

### 验收

- 默认行为与基线一致；
- 兼容别名行为不变；
- 配置文档测试/检查通过。

---

## Wave 4：Pulse 正式化 + legacy 分支收敛

### 目标

把现有“降级路径”正式命名为 pulse，并消除双写分支。

### 代码任务

1. 将 pulse 分支标注为 `execMode === "pulse"`；
2. 新增 `pulse-translate` / `pulse-result` trace 事件，并写入 transcript；
3. `translateTask` 错误映射为 `CommandFeedback` 友好的结果；
4. 收敛 `TaskLoop.execute()` legacy 分支：
   - 优先方案：legacy 路径也委托 `AgentTaskRunner`；
   - 若短期不能删除，则抽取共享 `executeByExecMode` helper，禁止继续双写业务逻辑；
5. 更新 `PTH_AGENT_MODE=off` 的兼容测试。

### 测试

- pulse 成功；
- translate 失败；
- runPtcProgram 失败；
- `pulse-translate` / `pulse-result` 事件写入 trace 与 transcript；
- `TASK_AWAIT_SUSPENDED_CODE` 保持 retryable；
- 旧配置 `PTH_AGENT_MODE=off` 行为一致。

### 验收

- pulse 是一等模式；
- 任务结果与当前降级路径一致；唯一例外是 legacy `TaskLoop` 的挂起语义收敛为 retryable requeue；
- 不再存在两份独立演化的模式分支。

---

## Wave 5：PTC 迭代模式

### 目标

新增以“整个 TS 程序”为动作单位的迭代执行模式。

### 代码任务

1. 新增：
   - `packages/pth-kernel-execution/src/execution/ptc-agent-loop.ts`

2. 配置：
   - `PTH_PTC_MAX_ITERATIONS` 默认 5；
   - `PTH_PTC_MODEL` 默认空。

3. 协议：
   - LLM 每轮输出 JSON：
     ```json
     {
       "done": false,
       "program": "async function main(){ ... }",
       "reason": "..."
     }
     ```
   - 非法 JSON 走修订失败计数；
   - 超上限软终止。

4. 执行：
   - 每轮调用 `runPtcProgram`；
   - 回填 `ok/error/errorClass/errorCode/retryable/value/stdout`；
   - pause / goal / knowledge / compaction 与 `runAgentTask` 对齐。

5. trace：
   - `ptc-program`；
   - `ptc-result`；
   - `finish`。

### 测试

- 初始程序成功；
- 第一次失败，第二次修订成功；
- 非法 JSON 重试；
- 达到最大迭代后软终止；
- `tasks.await` 挂起传播；
- goal / publisherClarification 注入；
- trace/transcript 事件完整。

### 验收

- `PTH_EXEC_MODE=ptc` 可运行；
- 默认 `tool-call` 不受影响；
- pulse 与 ptc 语义清晰分离。

---

## Wave 6：文档与全量验证

### 文档

更新：

- `docs/pth/concepts.md`
- `docs/pth/configuration.md`
- `docs/pth/deployment.md`
- `docs/pth/kernel.md`（如涉及 trace/scorecard）
- `docs/docs-manifest.json`

### 全量验证

```bash
npm run build
npm run lint
npm run check:docs-links
PTH_ASP_MODE=off npx vitest run
```

必要时补：

```bash
PTH_EXEC_MODE=pulse npx vitest run <focused pulse tests>
PTH_EXEC_MODE=ptc npx vitest run <focused ptc tests>
PTH_EXEC_MODE=asp npx vitest run <focused asp tests>
```

### 验收

- 全量测试绿；
- 文档链接绿；
- 默认配置行为不变；
- 发布说明草稿完成。

---

## 7. 测试矩阵

| 层级 | 必测内容 |
|---|---|
| 类型/纯函数 | `OptimizationLoopSpec`、`ObservationStrategySpec`、`resolveExecMode`、ToolSpec 校验、adapter 元数据校验、target 解析、CommandFeedback 映射 |
| 单元 | AgentToolResult 扩展、agent-loop adapter 调用、pulse 分支、PTC JSON 协议、观察策略 matcher/aggregator |
| 集成 | task claim → runner → tool-call/asp/pulse/ptc → transcript/scorecard |
| 兼容 | `PTH_ASP_MODE=on`、`PTH_AGENT_MODE=off`、未设置新变量 |
| 安全 | 自定义 adapter AST 拒绝、external argv 不拼 shell、legacy 路径 external fail-closed |
| 性能 | 观察策略 budget、tool durationMs 统计、pulse/ptc 超时 |

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `TaskLoop.execute()` 与 `AgentTaskRunner` 双写 | 模式行为漂移 | Wave 4 强制收敛到共享入口 |
| pulse 挂起语义收敛 | legacy `TaskLoop` 从终态拒绝变为 retryable requeue | 作为显式迁移变更记录，补兼容测试与发布说明 |
| ToolSpec 迁移破坏旧注册表 | 工具不可见/不可执行 | 新旧 spec 双读 + golden tests |
| adapter 引入安全面 | 绕过授权/越权 | AST 闸 + 提案审核 + ExecutePorts 唯一能力入口 |
| 外部工具 target 错配 | 执行到错误环境 | fail-closed + target 解析测试 |
| PTC 协议不稳定 | 迭代失败/死循环 | 严格 JSON、最大轮数、软终止、trace 可观测 |
| 观察策略拖慢 worker | 吞吐下降 | 声明式 DSL 热路径 + 脚本异步 + budget |
| trace 字段膨胀 | transcript 变大 | 可选字段 + preview 截断 + scorecard 聚合 |

---

## 9. 完成定义（Definition of Done）

本实施计划完成的标准：

1. JIT optimizer 作为首个规范化 loop 落地；refiner / perf-autopilot / tool-skill 治理 / intake 反馈至少登记到 Loop Registry 并声明迁移计划；
2. `PTH_EXEC_MODE` 成为唯一执行模式入口；
3. 旧配置仅作为兼容别名；
4. Tool 层不再携带执行体类型；
5. Command 层具备 adapter registry、静态分析闸、CommandFeedback、durationMs；
6. pulse / ptc 都是一等模式；
7. scorecard / optimizer / sensor 能消费 TCE 字段与 ActivityFactor；
8. 默认 flat-mode 全量测试保持绿色；
9. 文档、manifest、部署说明全部同步。

---

## 10. 参考

- [execution-modes-and-tool-reg-v2-design.md](./execution-modes-and-tool-reg-v2-design.md)
- [llm-tool-notebook-unified-execution-backend-plan.md](./llm-tool-notebook-unified-execution-backend-plan.md)
- [n14-sensor-controller-four-dims.md](./n14-sensor-controller-four-dims.md)
- [task-lifecycle-and-context-design.md](./task-lifecycle-and-context-design.md)
