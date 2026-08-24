# Role Catalog 化与四元组细化实施计划（W0–W5）

> 2026-08-24 立项。目标：把角色从代码 bundle 切分为可装配的 catalog 单元（CONTEXT.md role-definition/v1 目标态），
> 同时把角色定义归位到四元组（身份/能力/资源/模块）。本文档是实施纲领——逐 wave 推进、逐 wave 全量验证。

## 0. 裁决基线（2026-08-24 用户裁决）

| 决策点 | 裁决 |
|---|---|
| role 定义 | 四元组 = 身份 + 能力（工具+工具内部权限）+ 资源（model/thinking/tokens/time…）+ 模块（能力的封装集合，可挂接/卸载） |
| 落地形态 | **直接 catalog 化**：`catalog/data/roles/<id>.json`，装配层按目录装载 |
| 模块时序 | **先声明后落地**：角色卡声明模块挂接意图；memory/cache 模块独立化后置 |
| 细化深度 | **先归位后增量**：第一期现有字段归位四元组；工具内部权限/tokens/time/maxSteps 等增量字段后置 |
| 任务类型分化 | 实装 controller:router 提案 → 批准 → actuator 实施 taxonomy-change（独立工作流，不在本计划） |
| sensor 职责 | 严守三源：只产 observation-report，不 brainstorm 方案 |

现状审计依据：`docs/pth/report/system-construction-modeling-audit.md`（TCE 矩阵 + 可插拔性六障碍）。

## 1. 前置三件套（W0 核心交付）

1. **词汇表收敛**：当前 capabilities 16 个非正式字符串 + actionTools 11 个（族名/逐工具混用）→ 规范枚举集（与 L2 能力族、扩展对象面对齐）；产出 `catalog/vocabulary.json` 或同等物，注册闸与守恒校验器改读它。
2. **role-definition/v1 schema**：四元组分桶的 JSON schema + version/revision 元数据（CONTEXT.md：version 单调递增、generation 由 parent 派生、revision=内容哈希）。
3. **prompt 自洽化规则**：卡片 prompt 只许引用谱系内确定存在的角色（同枝祖先/已切兄弟）；泛化引用（"方案归 controller:worker-opt"）改为职责描述而非 id 引用。

## 2. role-definition/v1 卡片模板（第一期 schema）

```jsonc
{
  "id": "sensor:worker-opt",
  "version": 1,
  "identity": {                     // 身份——它是谁
    "tags": ["sensor", "observe"],
    "prompt": "……（自洽版）",
    "description": "调用点观测",
    "parent": "sensor",             // generation 由 parent 链派生，不手写
    "differentiation": "……"          // 分化理由（可选）
  },
  "capabilities": {                 // 能力——可使用的工具
    "functions": ["fs", "memory", "obs", "readSource", "python", "bash"],
    "actionTools": ["execTs", "nav", "cache"]
    // 增量（后置）：toolPermissions 工具内部权限矩阵
  },
  "resources": {                    // 资源——定量配额
    "thinking": "medium",
    "model": null                   // 缺省=全局
    // 增量（后置）：tokens / time / maxStepsPerTask
  },
  "modules": {                      // 模块——挂接意图声明（先声明后落地）
    "memory": {                     // 装载器投影为现行 RoleDefinition 字段：
      "scope": "own",               //   → memoryScope
      "produces": ["observation-report"], // → produces
      "defaultReads": []            //   → defaultReads
    }
    // cache: 后置
  }
}
```

装载器职责：schema 校验 → 四元组 → 现行 `RoleDefinition` 投影（运行时不感知卡片结构）→ tag 注册。generation 由 parent 链派生（装载时计算），revision = 内容哈希。

## 3. Wave 划分

| Wave | 内容 | 验证 |
|---|---|---|
| **W0** | 词汇表收敛 + v1 schema + 卡片模板定稿 + 装载器骨架（只校验不接线） | schema 单测；lint 绿 |
| **W1** | catalog 装载通道：`catalog/data/roles/` + 装配三调用点（assembly/batch-process/cli）改 catalog 装载；内置 bundle 等价迁移为默认 catalog 内容（37+5 全量，零行为变化） | 全量串行测试绿；`check:role-conservation` 读 catalog 通过 |
| **W2** | **sensor 枝切分（7）**——同构度最高，模板验证枝；prompt 自洽化 | 全量绿 + 守恒校验 + 逐卡片 schema 校验 |
| **W3** | **controller 枝切分（9）**——produces 全为 modification-plan | 同上 |
| **W4** | **actuator 枝切分（18）**——叶子先行（coder/scout/spider…），中间层（executor/explorer/governor/researcher）随后，prompt 互引最多的一枝 | 同上 + 路由回归（tag 冲突零） |
| **W5** | **professional（5）+ 三源根（3）**——根定义森林语义，最后切；builtin-roles.ts 退役为纯 re-export（或删除） | 全量绿；守恒校验器数据源完全切换 catalog |

每 wave 提交约定：`refactor(roles):`（代码）/ `docs(pth):`（文档）；全量串行测试 + lint + build + 守恒校验全绿才进下一 wave。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| L1 守恒报告逐枝漂移 | W2–W5 期间 L1 保持 report-only（现状即如此），W5 收口后再评估 --strict |
| prompt 互引断链误导 LLM | W0 自洽化规则；W2–W5 逐卡片执行；切分过渡期允许引用"已切或内置确定存在"的角色 |
| tag 路由回归 | 装载器 tag 冲突抛错（tag-registry 现状机制）+ W4 路由回归测试 |
| 词汇表争议 | W0 词汇表作为独立交付物先评审再推进 |
| 模块声明沦为纸面 | 装载器投影保证声明即刻生效于现行字段（produces/memoryScope），模块独立化落地时声明原样迁移 |

## 5. 明确的非目标（第一期）

- 工具内部权限矩阵、tokens/time/maxSteps 定量资源（增量字段，后置）；
- memory/cache 模块独立化实现（先声明后落地——模块系统另立工作流）；
- controller:router 实装与 taxonomy-change 实施路由（独立工作流）；
- TCE 收编（internal executor 搬迁 / capability-as-action 升格——见审计 §2.2，独立工作流）；
- debug 族零门控修复（独立安全修复，可随时先行）。
