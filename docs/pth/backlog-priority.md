# 待办事项二维评估表（2026-08-14）

> 依据：§8.2 概念债务 + §10 账本 N1–N13 + 会话余项（PTC 契约化/Seam 解耦）。
> 两个维度（用户定义）：
> - **重要程度** = 该待办影响项目中代码的**体量**（改动波及面）；
> - **紧迫程度** = 在逻辑上的**根本程度**（越根本的改动越要尽早实现）。

## 1. 评分标尺

| 分值 | 重要度（影响代码体量） | 紧迫度（逻辑根本程度） |
|---|---|---|
| 5 | 牵动全项目接口/地基，几乎处处要改 | 一切上层机制都建立其上——晚做=推倒重来 |
| 4 | 跨多个核心模块的连锁改动 | 核心闭环的信任锚/治理根基 |
| 3 | 一个核心模块 + 周边接线的改动 | 某条机制链的上游环节 |
| 2 | 单模块增量，局部接线 | 附加能力/增强——不阻塞现有机制 |
| 1 | 一行/配置/文档级 | 叶子改动/政策旋钮，随时可做 |

## 2. 全量评估表（按紧迫度排序）

| # | 事项 | 重要度 | 紧迫度 | 理由 |
|---|---|---|---|---|
| A1 | PTC 契约类型化 + Seam 解耦 | 4 | 5 | 契约是 LLM↔核 的接口根——agent-loop/工具/模板/转译全消费它；现在不类型化，每加一层机制就多一层欠债 |
| A2 | 双 storage 层归并 | 3 | 4 | 持久化基座——一切记忆/任务/空间特性都写穿它；晚归并 = 双份迁移面 |
| B6 | N8 空间-角色绑定校验 | 3 | 4 | 空间是执行基板，T6 治理模型已锁——校验晚做，空间分化会先失控 |
| B2 | N6 复测（verify）一等化 | 3 | 4 | JIT 闭环的信任锚——deopt 依赖诚实复测；验证不闭合，优化产物全建在沙上 |
| B4 | N2 skill 记忆类型（SOP 一等化） | 3 | 4 | 知识层根基——N4 生态转化与 §8.2「工作流 SOP」都建在它上面 |
| D1 | N12 二期①：护栏进 scorecard 观测 | 2 | 3 | 护栏的数据层——JIT 调护栏参数（D1b）与治理族裁决（D2）都依赖它；与 N13 共用轨迹 |
| B3 | N4 生态转化 pipeline | 3 | 3 | 0.13 机制落地——但上游是 N2（先有类型后有转化） |
| B5 | N1b 百科矛盾检测 | 2 | 3 | 污染防线写侧断言——wiki 在增长（91 条），污染代价随体量上升 |
| D3 | T9 PTL 侧交接 flow + 提交指南 | 2 | 3 | PTL↔PTH 协作接口——T01/T03/T04 教训（任务文本非自包含）要靠它制度化 |
| E1 | N13 思考路径图重建器 | 3 | 2 | 0.15 方法落地——是下一代 JIT collect 的前置，但现有机制不依赖它 |
| B7 | N5 资源环采集 | 3 | 2 | 第三级外环——按 0.7.3 时间尺度分离，慢环本就最后闭合 |
| C1 | N10 剩余 21 子任务派发 | 1 | 2 | 验证基线——不阻塞代码，但应持续并行跑 |
| D4 | T8 role-doc 文案三要素对齐 | 1 | 2 | 内容对齐——随批次推进 |
| B1 | N7 归档定期触发接线 | 1 | 1 | 纯叶子——执行端已实装，只差 trigger 接线（工作量最小） |
| D2 | 治理族豁免负结果收敛（待裁决） | 1 | 1 | 政策旋钮——GUARD_EXEMPTIONS 加一行谓词；可逆，无依赖 |
| E2 | N11 可预测性地图 | 1 | 1 | 0.14 猜想的前沿接口——无代码影响，纯设计 |

## 3. 四象限定位

```
紧迫度（根本程度）
5 │ A1
4 │           A2·B6·B2·B4          ← 核心区：基座与信任锚，最该先动
3 │           D1·B3·B5·D3
2 │ E1·B7    C1·D4                  ← 能力区：新能力与验证，并行推进
1 │ E2·B1·D2                        ← 旋钮区：随时可做
  └────────────────────────── 重要度（代码体量）
     1      2      3      4      5
```

## 4. 推荐执行序列（紧迫优先，同档按重要度）

**第一批（根基）**：
1. A1 PTC 契约化（5）——一切接口改动的先手（实施方案见附录 A）；
2. A2 storage 归并（4/3）——地基，改完再叠新特性；
3. N6 复测一等化（4）——先把 JIT 的信任锚闭合成；
4. N8 空间绑定校验（4）——治理防线，趁空间数量还小；
5. N2 skill 类型（4）——知识层，为 N4 铺路。

**第二批（机制链）**：D1 护栏观测 + E1 N13 路径还原**可合批**（共用轨迹数据，一次把 0.15 的数据底座建起来）→ N4 生态转化 → N1b 矛盾检测 → D3 交接 flow。

**第三批（并行/顺手）**：C1 测试集全程并行跑；B1（N7 接线）任一批次顺手做掉；D4 文案随各批次对齐。

**待拍板/前沿**：D2 裁决后一分钟改完；N11 留作设计储备。

> 总规律：紧迫度高的都撞在「接口/基座/信任锚」上（契约、存储、治理、JIT 验证、知识类型）——
> 印证原则 14：先还原后优化，先把底座还原齐整，再谈新能力。

---

## 附录 A：A1 PTC 契约化 + Seam 解耦实施方案

> 依据：`docs/superpowers/explorations/2026-08-14-ptc-comparison-dsh-prime.md` 可借鉴项 ①/②。
> 现状：能力面四处散落——`impls/kernels/capability.ts` buildCapabilities（大工厂）、
> `parse-agent-action.ts` AGENT_CAPABILITY_AS_ACTION（手拼代码字符串降级）、
> `agent-loop.ts` executeStep（ts.run 直调）、`templates.ts`/`nl-translator.ts`（各自拼 llm.complete）、
> 能力文档（散文式——T8 已改三要素但仍是手写）；ts-interpreter 只认 `Record<string, unknown>`。

### Phase 1 —— 契约类型化（纯重构，行为不变）✅ 已实装（2026-08-14 `c45256f`——ptc/contract.ts 注册表 21 条目 + wrapValidated 接线 buildCapabilities + AGENT_CAPABILITY_AS_ACTION 派生 + 5 测试；全量 1578 绿）

1. **注册表单一真相源**：新建 `src/pth/kernel/ptc/contract.ts`——
   `PtcCapabilityDef` = { name、argsSchema（JSON Schema）、returnType（TS 类型串）、
   归属核（ts-local / python / bash / memory / llm / web / fs / env / state）、三要素（场景锚点/何时用/效果——T8）}；
   `PTC_CAPABILITIES` 注册表收纳 memory.query/write、llm.complete、web.fetchText、fs.readText/list/readSource、
   env.inspect、state.recallFunctions/recallInsights、bash/python/c 核、cache、results/context。
2. **运行时参数校验**（零依赖手写校验器，不用 zod）：越界/缺参 → 结构化错误注入工具结果，替代裸 TypeError。
3. **buildCapabilities 变薄适配器**：注册表 → Record 注入（兼容垫片，现有核不动）。
4. **AGENT_CAPABILITY_AS_ACTION 降级模板迁移进注册表**（每个 def 带 asAction 代码生成器）——消灭字符串拼接双维护点。

### Phase 2 —— Seam 解耦（装配上移，核稳定）

5. **统一执行入口（只管 ts 缝——不建 per-language runner）**：新建 `src/pth/kernel/ptc/runner.ts` ——
   `runPtcProgram({ code, cwd?, exec?, ts, registerResult? })` 返回 `{ raw: InterpreterResult, assembled }`：
   raw = 核原始结果（消费点按需取用）；assembled = ts.run/ts.eval 的组装输出（「返回值:/结果:」前缀 + 截断）。
   消费点迁移：agent-tools 的 ts.run/ts.eval、agent-loop 的 capability-as-action 降级、task-loop 的降级直执行。
6. **ts-interpreter 只管「程序 × 绑定」**：构造入参收敛为 bindings，不再知道能力从哪来（对照 DSH Seam：
   「Runtimes know nothing about tools」）；buildSeeds 不动。
7. **核契约对齐（其他语言落位）**：python/bash/c 不是 ts 的平级——两级落位：
   - **核契约层**：registry 的 bash/python 条目升级为 Interpreter 契约描述（`execute(program, ExecuteOptions) → InterpreterResult`；
     dispose 标注为 Phase 3 制动点）——ts 程序内调 `python.execute/bash.execute` 即此契约，不建 per-language 包装；
   - **动作工具面**：python.run/bash.run/dev.build（c/asm）留在 AGENT_TOOLS（单步 tool_call 不是程序，不走 runner）；
     其 TOOL_SCHEMAS 三要素在 Phase 3 由同一注册表生成（工具面 = 契约的 tool_call 投影，能力面 = ts binding 投影）。
8. **能力索引文档生成器**：capability-index 从注册表生成（三要素格式）——手写散文退役，T8 role-doc 对齐随之自动化。

### Phase 3 —— 契约校验开启 + 执行级制动

9. **能力面越界 → 编译前拒绝**（引导消息，而非运行时 undefined——与 N12 unknown-tool 护栏同构）。
10. **TOOL_SCHEMAS 生成器**：35 个动作工具 schema 从注册表/工具定义生成——工具面与能力面同一契约源。
11. **in-flight 终止语义**（对比文档 ③）：`dispose()` 显式契约——终止运行中程序并 await（ts/python/bash 统一）；
    现有只有调用级 LLM 超时与任务级 claim 回收，程序级跑飞无制动。
12. **cache 注入收敛**：task-loop 的 `injectCapability("cache")` 进 runner 能力面装配（与越界校验同一机制）。

### 兼容与验证

- 每 phase 独立提交；Phase 1 纯重构——全量 1573 测试必须保持全绿；
- 行为逐字保留（降级模板/引导消息/结果注册语义不变）；
- 验收：agentic 测试集 T01（混合任务——PTC 组合）回归 + 新增 contract/runner 单测；
- 零新依赖（校验器手写；d.ts 预置由 stripTypeScriptTypes 免费吸收）。

