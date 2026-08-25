# ADR-0004: TCE 的 C 是 Code——PTC 能力接口第一性，tool-call 为适配投影

**Status**: accepted

**Date**: 2026-08-24

## Context

全量 TCE 推进中发现 Command 层被实现为**命令对象**（`ExecutionCommand` discriminated union：
language/external/internal + `EXEC_TOOL_CAP`/`capability-policy` 表驱动授权）。这导致三条裂缝：

1. **PTC ↔ tool-call 互转困难**：tool-call 与 PTC 程序是两条平行路径——`dev.*/write.*/debug.*`
   20 个工具只存在于 AGENT_TOOLS（tool-call 面），不在 PTC_CAPABILITIES（29 项能力清单）里，
   ts 程序内调不了 `dev.build()`；反向的 capability-as-action 只是幻觉降级桥。
2. **执行后端与 LLM interface 难分离**：命令对象同时承载 LLM 语义（tool 名/args）与执行语义
   （target/argv/code），两层耦合在同一数据结构上。
3. **权限管理难统一**：EXEC_TOOL_CAP（族级）+ capability-policy（internal 命令级）+ produces
   （kind 级）+ memoryScope（区域级）多张表并存，随工具增长而腐化（debug 族零门控即实证）。

设计文档 §3.7 早已写下意图（"静态越界预检提取程序用到的能力集合 ⊆ role.capabilities"），
实现只完成了存在性检查那一半。

## Decision

1. **TCE 释义改为 Tool → Code → Execute**。一切入口（tool call / PTC 程序 / notebook cell）
   归一化为**一段代码**；Code 层 = 归一化 + **静态审核**（提取代码的能力调用集 ⊆ role 能力集）；
   Execute 层 = 审核过的代码到执行面（核/会话/外部后端/loop）的路由。
2. **PTC 能力接口第一性**：能力契约是单一真相源；tool-call schema 从能力契约**投影生成**
   （现有 `asAction` 转正为规范方向）。能力注入即授权——角色没有的能力根本不存在于其核会话。
3. **PTC 宿主语言门槛 = 交互性三条件**：持久会话 / 可注入 / 可静态审核。ts、python、bash
   是宿主语言；非交互执行面（C/asm 编译、文档生产）**包装为能力**被宿主语言调用，不自成空间。
4. **权限收敛为单机制**：EXEC_TOOL_CAP / capability-policy 表驱动授权退役，统一为
   「注入 + 静态审核」。两个例外显式声明：参数级约束（produces kind 白名单等）作为审核的
   扩展规则；批准态（await-approval）= 静态审核命中策展规则的第三态输出。

## Considered Options

- **命令对象网关增强**（继续完善 ExecutionCommand + 策略表）：维持两条平行路径，策略表随
  工具增长腐化，PTC↔tool-call 互转问题无解。否决。
- **只做信封模型不收编 tool-call**（现状加固）：tool-call 面 20 个工具永远绕在信封外，
  观测/授权双轨。否决。

## Consequences

- `CommandGatewayImpl` 的命令对象形态退役（或退化为纯翻译器）；`UnifiedExecutionDispatcherImpl`
  （从未在生产装配）与 `InternalExecutorRegistry`（空壳）重新定位或移除。
- AGENT_TOOLS 命令式派发退役；工具执行体搬迁为 PTC 能力接口实现。
- 静态审核**到能力调用粒度为止，不透入字符串参数**（`bash.run("...")` 的命令内容不审核；
  嵌套代码生成的规则需明令）。
- done/pause/asp.cd/cache.* 等 loop/session 状态操作同样是能力调用代码（宿主为 loop），
  ASP-only 概念消解为「loop 宿主能力」。
- 字符串参数不审核意味着 tool-container 的 argv 白名单仍是 external 能力的自有边界（不收编）。
