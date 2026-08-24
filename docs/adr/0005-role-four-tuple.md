# ADR-0005: Role 四元组——身份 + 能力 + 资源 + 模块

**Status**: accepted

**Date**: 2026-08-24

> 编号说明：本仓 ADR 编号独立于旧仓归档——旧仓 ADR-0005 是 pth human-interaction boundary（已归档），与本文无关；跨仓引用旧仓 ADR 时请带仓名。

## Context

三源谱系重构落地后，role 的定义散落在 `catalog/data/roles/*.json` 字段、worker-spec 与各设计文档中，
没有单一事实源回答「role 由什么构成」。模型化审计（system-construction-modeling-audit.md §1）把候选
切分收敛为三案：二元组（身份 + 能力）、三元组（身份 + 能力 + 资源）、四元组（+ 模块）。2026-08-24
用户裁决采用四元组。

## Decision

**role = 身份 + 能力 + 资源 + 模块**：

| 分量 | 语义 | 字段归入 |
|---|---|---|
| 身份 | 它是谁 | `id` / `prompt` / `tags` / `labelPatterns` / `description` / `parent` / `generation` / `differentiation` |
| 能力 | 它能做什么 | 工具 + 工具内部权限（capability 不是裸工具名；权限机制收敛于 ADR-0004 的「注入 + 静态审核」） |
| 资源 | 它能用多少 | `model` / `thinking` / `tokens` / `time` / `maxSteps` |
| 模块 | 可插拔的能力封装 | 可挂接/卸载的能力集合，自带内部权限与配额；首批为 memory / cache；系统无某模块也可运作——模块是挂接，不是内核 |

配套裁决：

- capability 采用「工具 + 工具内部权限」，放弃更粗的二元组归并；
- 模块先声明后落地（catalog 先声明模块，实现随后跟上）；
- 路由保持 kernel 确定性（tag-registry）；taxonomy 演化走实装闭环：controller:router 提
  modification-plan → 审批 → actuator 实装（`implementation.kind=taxonomy-change`）。

## Considered Options

- **二元组（身份 + 能力）**：资源与模块都塞进「能力」。能力会变成杂物抽屉——资源配额（定量）与
  权限审核（定界）是两种方向的约束，混在一张表里会互相腐化。否决。
- **三元组（身份 + 能力 + 资源，无模块）**：模块压平为能力的子字段。但模块的本质是
  「可挂接/卸载 + 自带配额」的生命周期语义，压平后挂接/卸载无处安放。否决。

## Consequences

- role 谱系 catalog 化按四元组切表实施：role-catalog-and-four-tuple-refinement-plan.md（W0–W5）。
- TCE 静态审核的权限边界 = 能力分量 ∪ 已挂接模块的能力（ADR-0004「注入即授权」在四元组下的落法）。
- 术语以 CONTEXT.md 术语表为准；后续设计/计划文档引用四元组时以本文为准。
