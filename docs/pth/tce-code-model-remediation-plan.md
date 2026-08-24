# 工具面 TCE 结构化整改计划（Code 模型，W0–W5）

> 2026-08-24 立项。依据 ADR-0004（TCE = Tool→Code→Execute，PTC 能力接口第一性）。
> 目标：把一切入口归一化为代码，权限收敛为「注入 + 静态审核」单机制，tool-call 面成为能力契约的投影。
> 现状审计：`docs/pth/system-construction-modeling-audit.md` §2。

## 0. 现状修正（对审计 §2.2 的 errata）

详查后修正两条审计记录：

1. **worker 侧 gateway 已完整接线**——`batch/tool-face.ts` 的 CommandGatewayImpl 注入了
   humanApprovalGateway（PgHumanInteractionService）+ toolTranslator（manifest per-tool）；
   await-approval 在 worker 路径可达。审计原判"未接线/不可达"仅适用于 assembly.ts 主进程侧
   （notebook 通道——cell 无 per-tool 调用、人类 principal 自批准，二者 N/A，记录为设计内）。
2. **Execute 层比审计记录的更空**：`UnifiedExecutionDispatcherImpl` 全仓仅在测试中实例化，
   生产装配从未接线——tool-reg adapter 的 execute 分支（`if (input.executionDispatcher)`）
   在生产落空，授权后的命令落回 inline program/agent 执行。

## 1. 缺口清单（Code 模型下重述）

| # | 缺口 | Code 模型下的形态 |
|---|---|---|
| G1 | debug 族零门控（EXEC_TOOL_CAP 无 debug 族，acceptor 等只读角色可调 debug.attach） | debug 不是 PTC 能力——能力面缺失即不可调用；门控表整个概念退役 |
| G2 | dev/write/debug 20 工具只在 AGENT_TOOLS，不在 PTC_CAPABILITIES | ts 程序调不了 `dev.build()`——能力接口缺失，接口第一性倒挂 |
| G3 | capability-as-action 是幻觉降级桥 | 归一化方向反了：应转正为 tool-call → 代码的主路 |
| G4 | CommandGateway 命令对象 + 双策略表 | 命令对象形态退役，授权收敛为注入 + 静态审核 |
| G5 | ASP 内联 6 工具（nav/memory.index/cache.*）无 TCE | loop/session 宿主能力——同样是代码形态的能力调用 |
| G6 | Execute 层空壳（dispatcher/internal registry 未装配） | Execute 层重新定位为「能力实现的路由」 |

## 2. Wave 划分

### W0 — 能力契约统一（契约层）

**内容**：
- `PTC_CAPABILITIES` 扩为全能力单一真相源：补 dev（write/edit/build/run/save/list）、
  write（create/edit/read/list/save/section）、debug（attach/breakpoint/continue/step/
  snapshot/evaluate/detach/sessions）、loop 宿主能力（asp.cd/asp.index/cache.load/
  cache.index/cache.cancel/done/pause 的契约声明，标注 host=loop）
- 每条能力契约含：params/returnType/anchor/whenToUse/effect（T8 三要素）+ asAction 转正 +
  宿主声明（host: kernel ts / loop / sandbox-debug）
- `PTC_TOOL_DEFS` 与 `PTC_CAPABILITIES` 合并表态：TOOL schema 由契约派生（消除双源）
- 能力词汇表收敛（与 role catalog 计划 W0 共用同一张表）

**验证**：契约 schema 单测；TOOL schema 派生与现状逐字节一致（golden）；lint 绿。

### W1 — 能力实现搬迁（实现层）

**内容**：
- dev/write/debug 执行体从 `agent-tools-registry.ts` 抽为能力对象实现
  （`ptc/capabilities/{dev,write,debug}.ts`——新文件，不拆既有禁拆文件）
- 依赖注入显式化：taskWorkspace / kernel / debugApi / toolstore 由能力工厂在任务启动时绑定
  （per-task 闭包——与 llm-agent.ts 现有 commandContext 构造点同位）
- `runPtcProgram` 注入装配扩展：按角色 capabilities 注入 dev/write/debug 能力对象
- applyOutputMode / truncate / asm 惰性注册等行为语义原样保留

**验证**：ts 程序内 `await dev.build("main.c")` 端到端可用；无能力角色预检拒绝
（G1 在此自然消除）；AGENT_TOOLS 旧路径双跑对照测试。

### W2 — tool-call 面投影化（适配层）

**内容**：
- AGENT_TOOLS 命令式派发退役：tool call → asAction 代码投影 → runPtcProgram（单调用程序）
- AGENT_CAPABILITY_AS_ACTION 降级桥转正即主路（幻觉桥语义消失——所有 tool call 皆投影）
- agent-loop.ts 派发瘦身：tool 归一 → 投影 → 执行；EXEC_TOOL_CAP 内联检查删除
- ASP 空间门控归位：dev/write 工具的空间可解析规则（spaceOfExecTool）移入能力对象的
  宿主检查（loop 能力在 loop 宿主执行，保留空间绑定校验语义）

**验证**：既有 dev/write/debug 测试全绿（行为等价）；投影路径 trace 带 capabilityId 埋点。

### W3 — 静态审核升级（审核层）

**内容**：
- `ptc/surface.ts` 从「根存在性检查」升级为「能力调用集提取 ⊆ role 能力集」
  （root.method 粒度——方法级提取天然承载工具内部权限：fs.readText vs fs.task.write）
- 参数级审核扩展规则：produces kind 白名单（memory.write 的 entry.kind）移入审核层
  ——声明式规则表（能力 × 参数约束），与调用集提取并置
- 策展规则表（批准态）：manage.* 写类 → await-approval（对接现有 PgHumanInteractionService）；
  obs.* 只读免批准；manage 自带 draft 语义不重复批准（设计 §3.6 保留）
- 明令文档化：不透入字符串参数（bash.run 命令内容不审核）；嵌套代码生成（程序内再生成
  code 喂核）的规则

**验证**：越界程序结构化拒绝（列出缺失能力）；acceptor 角色调 debug.attach 在审核层拒绝；
误杀率零（既有全部 PTC 测试程序通过）。

### W4 — 命令对象网关退役与 Execute 层重构（执行层）

**内容**：
- `CommandGatewayImpl` 退役或退化为纯归一化翻译器（tool call → 代码）；EXEC_TOOL_CAP /
  capability-policy 表删除
- notebook cell 直连 Code 层（cell 本来就是代码——跳过对象化）
- Execute 层重新定位：能力实现的路由表（能力 → 宿主：ts 核 / loop / sandbox debug API /
  external tool-container）；`UnifiedExecutionDispatcherImpl`/`InternalExecutorRegistry`
  按此重构或移除（二选一在 W4 启动时定）
- tool-container external（argv 白名单）保留为 external 能力形态（边界不收编——ADR 已声明）

**验证**：全量串行测试绿；无命令对象残留（grep ExecutionCommand 仅存兼容 shim 或为零）。

### W5 — 观测与收尾

**内容**：
- Code 层审核埋点：deny/await-approval 率 → obs 数据源（sensor:rule 消费面）
- `scripts/check-tce-coverage.ts`：每个工具/能力必须有契约声明（lint 链新档）
- 文档：concepts.md TCE 段改写（Tool→Code→Execute）、CONTEXT.md 释义同步、release notes
- 审计文档 §2 标注 superseded by 本计划完成态

**验证**：lint 链全绿（含新档）；文档一致性。

## 3. 每 wave 纪律

- `refactor(tce):` / `docs(pth):` 提交；全量串行测试 + lint + build 全绿才进下一 wave；
- 行为等价性由既有测试钉死——W1/W2 不得改任何工具的可观察行为（输出格式/截断/错误文案）；
- 禁拆文件清单继续适用（task-loop.ts 等——派发瘦身属搬迁不改语义）。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 行为漂移（输出格式/错误文案微妙变化） | W1 双跑对照 + golden 测试；W2 全量回归 |
| 静态审核误杀合法程序 | surface.ts 保守策略延续（宁漏报不误伤）；W3 全量既有 PTC 程序零误杀为验收线 |
| 性能（每次 tool call 变单调用程序的开销） | 进程内 vm 调用本就廉价；W2 记录基准对比（trace durationMs 分布） |
| 能力对象与 ASP 空间语义耦合 | 空间绑定校验作为能力宿主检查保留，不在本计划动 ASP 空间模型本身 |
| tool-reg 注册工具（program/agent/adapter）与契约统一 | W4 处理——tool-reg 的 program 态本身就是代码形态，天然兼容 |

## 5. 非目标

- notebook 执行面改造（cell 已是代码形态，W4 仅简化其路径）；
- sandbox/tool-container 内部实现；
- role catalog 化（独立计划，词汇表与 W0 共用）；
- B9/B10 治理回路断裂修复（backlog 独立项）。
