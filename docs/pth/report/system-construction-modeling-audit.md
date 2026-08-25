# 系统构造模型化审计（2026-08-24）

> 定位：模型化当前系统构造的阶段性结论记录——role 框架定义裁决、TCE 结构化审计、角色谱系可插拔性审计。
> 本文档只记录结论与证据，不含实施计划；§12 概要设计（three-source-lineage-and-capacity-conservation-design.md）由维护者撰写时可引用本文。
> 勘误：本文 TCE 审计有两条已确认错判（worker 侧 gateway 实际已接线等），勘误表见 [tce-code-model-remediation-plan.md](../plan/tce-code-model-remediation-plan.md) §0「现状修正」。
> Superseded（2026-08-24 TCE W0–W5）：本文 §2 的「Command 对象网关」审计口径已被 [ADR-0004](../../adr/0004-tce-code-layer-ptc-capability-first.md) 与 tce-code-model-remediation-plan 完成态取代——工具面已统一为能力契约 + 方法级静态审核，CommandGateway 退化为兼容 shim。

## 1. Role 框架定义裁决（2026-08-24 用户裁决）

### 1.1 role 四元组

**role = 身份 + 能力 + 资源 + 模块**：

| 分量 | 语义 | 现有字段归入 |
|---|---|---|
| 身份 | 它是谁 | `id`/`prompt`/`tags`/`labelPatterns`/`description`/`parent`/`generation`/`differentiation` |
| 能力 | 可使用的工具 + **工具内部权限** | `capabilities`、`actionTools`；工具内部权限是细化增量（如 fs 可用但只读、tasks 可用但不可 penetrate） |
| 资源 | 定量配额 | `model`、`thinking`、`exploreKernels`；新增候选：`tokens`、`time`、`maxStepsPerTask` |
| 模块 | **能力的封装集合**——可整体挂接/卸载的可选子系统，自带内部权限与配额 | memory 模块（吸收 `memoryScope`/`produces`/`defaultReads`）、cache 模块；**系统无某模块也可运作** |

关键归类判定：`memoryScope` 名为资源实为权限（表达"能否跨区"），模块独立化后归 memory 模块的内部权限面；`produces` 保持权限语义（W0 已按写边界 fail-fast 强制实现）。

### 1.2 任务类型分化（taxonomy differentiation）

- **逐任务分派（routing）** 留在 kernel：tag-registry 精确匹配 / flow 显式 role，不经过任何 role。
- **类型体系演化** 归 controller：**实装 `controller:router`**（去掉"guard 占位"标注）提出任务类型分化方案（modification-plan draft）→ 监督批准 → **actuator 实施**（新增 `implementation.kind=taxonomy-change`，注册进 tag-registry）→ 此后新类型由 routing 确定性分派。
- 现状缺口（裁决背景）：切分职责分散在五处——kernel 分选器 / planner 分解（其 `type` 自由文本与 tag-registry 词汇表脱节）/ 各族中间层 prompt 内分布式判断（软约束无强制）/ task-resolver flow 算子 / controller:router 占位。

### 1.3 A/B 优化周期

- 基线窗：n 轮行为数据为基线；变更生效后 n+1~2n 轮为实验窗；比较两窗裁决 keep/rollback（映射到 modification-plan 已有的复测窗口/回滚条件字段）。
- **sensor 严守三源职责**：只产 observation-report（行为模式事实+严重度+证据链），不 brainstorm 方案；方案归 controller。

以上术语已录入 `CONTEXT.md`（role / capability / module / routing / taxonomy differentiation / baseline window）。

## 2. TCE 结构化审计（2026-08-24）

基准：`llm-tool-notebook-unified-execution-backend-plan.md` §3.7「全量 TCE——一切入口皆命令」（Tool 层 per-tool schema / Command 层三态 CommandDecision / Execute 层结构路由；done/pause 设计豁免；PTC 程序内能力调用走信封治理）。

### 2.1 覆盖矩阵

| 入口 | T schema | C Command 三态 | E 结构路由 | 结论 |
|---|---|---|---|---|
| `ts/python/bash run/eval`（6） | ✅ | ✅ language 命令（caps+target+审计） | ✅ kernel/targetBackend | 全量 TCE |
| notebook cell | — | ✅ exec-channel decide | ✅ dispatcher | 全量 TCE |
| tool-reg（command adapter 态） | ✅ manifest | ✅ decideRequest | ✅ UnifiedExecutionDispatcher | 全量 TCE |
| tool-reg（program/agent 态） | ✅ | ✅ decide 门控 | 信封（内联 runPtcProgram/runChild） | 设计接受（信封模型） |
| `dev.*`（6） | ✅ | ❌ 不过网关 | ❌ loop 内联 | Command 层缺位（仅 EXEC_TOOL_CAP 内联门控） |
| `write.*`（6） | ✅ | ❌ 不过网关 | ❌ loop 内联 | Command 层缺位（同上） |
| `debug.*`（8） | ✅ | ❌ 不过网关 | ❌ 内联 HTTP→sandbox | **零能力门控**（EXEC_TOOL_CAP 无 debug 族） |
| `asp.cd`/`asp.index`（2） | ✅ | ❌ | ❌ loop 内联 | 自有门控（空间绑定）；设计给 nav 留了"可留 loop 层"口子 |
| `memory.index`（1） | ✅ | ❌ | ❌ loop 内联 | capability-policy 有条目但派发路径不到达 |
| `cache.*`（3） | ✅ | ❌ | ❌ loop 内联 | capability-policy 无 cache 条目 |
| `done`/`pause`（2） | ✅ | — | — | 设计豁免（loop 控制原语） |
| capability-as-action（memory.query/write、llm.complete、web.fetchText、fs.*、state.*、tasks.*、env.inspect、skills.get） | ❌ 无 schema | ❌ 不过网关 | 信封（caps 注入） | 设计要求升格为正式 internal 路径——未做 |
| `obs.*/manage.*/perf.*`（PTC 程序内） | — | 信封治理 | — | 设计内；manage 即时生效类另有 planGrant（W2） |

### 2.2 五个缺口

1. **`debug.*` 全族零能力门控**——EXEC_TOOL_CAP 只登记 python/bash/dev/write 四族；`capability-policy.ts` 已写好 debug 策略（`["dev","c","python","bash"]`）但主派发路径不到达。最急迫的安全缺口。
2. **internal 收编未发生（Phase 4 未做）**——dev/write/debug/nav 工具体未搬进 Execute 层；`InternalExecutorRegistry` 存在但 assembly 从未实例化、零注册（空壳）。
3. **capability-as-action 仍是幻觉降级桥**——无 Tool 层 schema、不过 Command。
4. **CommandGateway 装配条件化**——仅当 `executionBackends` 配置时构造；`toolTranslator`/`humanApprovalGateway` 未接线（await-approval 态实际不可达，requiresApproval 的 target 一律 deny）。
5. **ASP 内联 6 工具无 TCE**——nav 有设计口子；cache 无策略条目；memory.index 有条目但路径不到达。

**一句话**：全量 TCE 只覆盖"语言命令 + notebook + tool-reg adapter"主轴；34 个动作工具中 20 个（dev 6 + write 6 + debug 8）Command 层缺位，其中 debug 8 个连内联门控都没有。

## 3. 角色谱系可插拔性审计（2026-08-24）

**问题**：能否用当前资源构造一个仅由一个特殊 actuator + sensor + controller 构成的系统，逐个测试功能？

**结论**：机制层可插拔，但纯配置不可达——差一个"角色集选择"通道。

### 3.1 已具备的可插拔机制

- 注入式装配：`setDefaultRoles(defaults, mid, governance)` 接受任意角色数组，核心不 import 实现层。
- 动态注册：`registerWorkerRole`（tag 自动挂载、id 冲突拒绝）。
- batch 裁剪：`PTH_WORKER_ROLES`（0 副本禁用 / reinforced 单角色）。
- explicit-only 先例：professional 角色默认零副本。

### 3.2 六个障碍

| # | 障碍 | 位置 | 严重性 |
|---|---|---|---|
| 1 | 角色集无配置通道：三个调用点硬编码全量内置包 | `assembly.ts:167`、`batch-process.ts:501`、`pth-cli.ts:170` | 唯一硬障碍，改动极小 |
| 2 | MID 根不是派发目标（tag 不注册为 role 类） | `worker-cluster.ts` setDefaultRoles | 最小系统里根接任务需 flow 显式 role，或注入为 defaults |
| 3 | batch 默认全量展开（未列角色默认 1） | `parseRoleWeights` | 纯 env 最小化需显式零掉全部 14 个 DEFAULT_ROLES |
| 4 | 硬编码角色引用：code-fix→developer / ROOTS 三根 | `plan-implementation.ts:59`、`check-role-conservation.ts` | 用同名 id 则无感 |
| 5 | prompt 语义互引断链（"方案归 controller:worker-opt"） | builtin-roles.ts | 不阻塞，误导 LLM；最小系统需自洽 prompt |
| 6 | 事件触发派单假定角色存在（tags:["adversarial"]） | system-triggers | 仅事件发生时触发 |

### 3.3 与目标架构的对照

`CONTEXT.md` 的 role-definition/v1 已声明目标态（`catalog/data/roles/<id>.json` 文件协议），但 catalog 目录尚不存在，角色仍是代码 bundle。最小三源系统是"角色集从代码 bundle 变成可选择装配单元"的第一个真实用例。

落地选项（用户裁决：**只记录结论，暂不实施**）：① 角色集配置通道（PTH_ROLE_SET）；② 仅测试夹具注入；③ 直接 catalog 化。

## 4. 对后续模型化工作的输入

- 四元组（§1.1）是 role 模型的定义面；TCE 矩阵（§2.1）是工具面的现状面；可插拔性障碍表（§3.2）是装配面的缺口清单——三者合起来构成"当前系统构造"的完整模型化素材。
- memory/cache 模块独立化（§1.1）满足 ADR 三条件（难逆转/无上下文会惊讶/真实取舍），建议后续落 `docs/adr/`。
- `debug.*` 零门控（§2.2-1）是独立可修的安全缺口，不依赖模型化工作的完成。
