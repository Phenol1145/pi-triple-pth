# N14：sensor/controller 四维细分 + 一等工具注册通道设计

> 2026-08-24 三源重构：optimizer-suggestion 语义废止、sensor/controller/actuator 升 gen 0——详见 `three-source-lineage-and-capacity-conservation-design.md`。

> 2026-08-18 · L1 设计批（fork-session 协议 · `lane/l1-n14-design`）
> 概念前提：`concepts.md §0.17`（工具/工具包/可见性三定义 + worker 优化四层次）。
> 本文是 N14 账本的落地设计：**纯设计批——不改执行代码**；实施分期见 §6。

## 0. 裁决记录（用户——2026-08-18）

| # | 问题 | 裁决 |
|---|---|---|
| A2 | 是否开一等工具注册通道 | ✅ **开通道**（账本决策栏已录） |
| Q1 | sensor/controller 细分方式 | ✅ **增补式**——保留现有环向点位，按四维缺口新增 |
| Q2 | 注册工具执行体形态 | ✅ **三态并存：program（ts 固化）+ builtin（代码内置）+ agent（LLM 子 agent）**（用户 custom「2+3」——含 Q2-1 的 program 态） |
| Q3 | 通道治理形态 | ✅ **skill 同构治理**——复用 staged 流（提案 → 对抗性审核 → 批准 → 注册生效） |
| Q4 | 存量归并策略（§3.6） | ✅ **一次性全登记**——存量 35 件硬编码工具全部登记为 builtin 条目（执行不动，条目做治理面），双写一致性对账钉测试 |

衍生澄清（用户提问，已答并纳入设计）：**tool-function 沉淀物不自动进工具列表**——
沉淀物是候选池，进列表走晋升管线（提案→审核→批准→注册），注册后按可见性定向
投放（不全局广播——命题 3 专注度防线）。

---

## 1. 四维 × 点位矩阵（现状盘点）

控制论点位现有两轴：**环向**（内环 worker / 中环系统 / 外环资源 / 记忆）与
**对象维**（0.17.4 四层次）。增补式 = 环向保留，对象维补缺口：

| 层次 | 观测（sensor）现状 | 调节（controller）现状 | 缺口 |
|---|---|---|---|
| **工具面优化** | 无（sensor:worker-opt 只测调用点流量，不测「组合难度」） | 无 | ❌ 观测+调节双缺 |
| **单工具优化** | 部分——sensor:worker-opt 的工具频率/失败率是调用点视角，非工具视角 | 无（T8 三要素是一次性人工批） | ⚠️ 观测半缺、调节缺 |
| **记忆优化** | ✅ sensor:memory | ✅ controller:memory | ✅ 已覆盖 |
| **规则优化** | 无（guardrails 计数不出 scorecard——N12 二期缺口） | 无（护栏阈值/规则 stamp 靠人工） | ❌ 观测+调节双缺（N12 二期落点） |

## 2. 增补点位设计（sensor +3 / controller +3）

六个新角色均为治理族叶子：`parent: sensor/controller，generation: 2`，
与现有 GOVERNANCE_ROLES 同款约束（谱系可见、默认不进 batch、`PTH_WORKER_ROLES`
显式启用）。三元组（动作空间 × 记忆空间 × 承诺任务类型）：

### 2.1 sensor 系（观测点——产物均落 `optimizer-suggestion` draft）

| 角色 | 观测对象（承诺任务类型） | 数据源 | 关键信号 |
|---|---|---|---|
| **sensor:tool-face** | 工具面缺口：重复出现的工具组合链（≥N 步的固定序列 = 固化候选）、多步绕行（LLM 用多步组合出单步可得结果）、穿透/注册候选路径 | scorecard toolFreq 时序 · transcript 轨迹（N13 思考路径还原——决策链找「岔路口」） | 组合链频次 TopN · 平均组合深度 · 候选路径清单 |
| **sensor:tool-single** | 单工具质量：工具级跨 worker 聚合失败率、参数误用模式、幻觉邻近名（unknown-tool 引导记录）、描述三要素缺失/误导、回填带宽浪费（mode 误用） | scorecard 工具维聚合 · guardrails unknown-tool 计数 · obs.callpoint | 工具失败率排名 · 误用聚类 · 描述缺陷清单 |
| **sensor:rule** | 规则有效性：护栏命中率/**误杀率**、权限拒绝分布（用途层/capabilities 拒绝是否合理）、引导消息反复出现（规则未生效信号）、规则冲突 | guardrails 注册表计数（N12 二期观测面——本设计落点）· scorecard gated · obs | 护栏 hit/kill 比 · 拒绝分布 · 未生效规则清单 |

### 2.2 controller 系（调节点——裁决产物走治理流）

| 角色 | 调节对象（承诺任务类型） | 调节手段 |
|---|---|---|
| **controller:tool-face** | 工具面：工具注册提案裁决（晋升管线审批执行）、工具包组织（包归属/合并/退役提案）、可见性投放调整（哪些角色/空间可见） | `manage.tool.register`（提案落 draft——§3 治理流）· 工具面预算守卫执行 |
| **controller:tool-single** | 单工具：描述修订提案（三要素持续对齐——T8 的运营面）、交互模式优化（mode/回填协议）、功能扩展提案 | `manage.tool.propose`（修订 draft）· toolstore 产物链路 |
| **controller:rule** | 规则：护栏阈值 JIT 调参（`PTH_GUARD_*` 热调——N12 二期调节面）、规则 stamp 裁决（optimizer-hotspots 建议 → 审批）、权限策略调整提案 | `manage.params.set`（热调）· `manage.rule.stamp`（规则落 prompt 层提案） |

### 2.3 谱系影响

- `builtin-roles.ts` GOVERNANCE_ROLES +6（gen=2 挂 sensor/controller——与既有 9 点同构）；
- 组织权矩阵（W8 delegation-policy）自动继承：controller 系不获 tasks 投递权
  （sensor/controller 排除——W8 裁决不变）；
- 0.16.4 工具面收口不涉及（治理族根不按此条收口——既有裁决）。

---

## 3. 一等工具注册通道（契约先行——W8 P3 穿透同款模式）

### 3.1 注册条目（tool-reg）

- **kind = `tool-reg`**（prompt 层系统资产——worker 只读，防伪造注册；
  memory-policy PROMPT_KINDS 增补）；
- **id = `tool:<name>`**；条目不可变——修订 = 新版本（`version+1`，
  `promotedFrom` 链留痕——skill B4-1 同款）；
- **机读单一真相源**：`__tool_spec__` JSON 行（穿透 `__penetration_edge__` 同款——
  人类可读四段式 + 机器校验一行）：

```json
{
  "name": "util_parse_log",
  "version": 1,
  "description": { "anchor": "日志时间戳抽取（【场景锚点】）", "whenToUse": "解析杂乱日志首列时间戳", "effect": "ISO 时间数组" },
  "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
  "executor": { "type": "program", "source": "……固化 ts 源码……" },
  "visibility": { "roles": ["developer", "coder"], "pack": "util" },
  "promotedFrom": "tool-function:parseLogTimestamp"
}
```

### 3.2 执行体三态（用户裁决 Q2 = program + builtin + agent）

| 态 | 执行体 | 适用 | 来源/晋升 |
|---|---|---|---|
| **program** | 固化 ts 程序（ts 核执行——无 LLM） | 确定性数据处理/变换——**JIT 沉淀物晋升主路径** | tool-function 候选池 → schema 化包装（parameters 从 spec.signature 派生） |
| **builtin** | 代码内置函数（引用已入 TOOL_SCHEMAS 的执行器） | 性能/特权场景——= 现状 PR 通道纳入治理 | 代码审批（审批面 A）+ tool-reg 登记 |
| **agent** | LLM 子 agent（role + 输入/产物契约） | 不可机械化的判断类调用 | 穿透 skill 同款——`skill:penetrate:*` 是 agent 态的特化（本期并存，后续可名归一） |

代偿定位（与 0.3.6 对齐——准确表述）：三态执行体均由 LLM 发起 tool call、结果回填
——**仍属串联代偿的深化**；但 program/builtin 态把「召回源码→读懂→重写」编译为
一次调用，是串联内部的机械化极限。**注册通道同时是并联〔待议〕的机制前提**
（执行体注册表 + 审批治理就绪——并联只差「任务级直接接管」裁决）。

### 3.3 可见性投放（0.17.3——命题 3 防线）

- `visibility.roles` **默认窄投放**（只给触发/相关角色——不全局广播）；
- `pack` 归属（0.17.2 工具包——包级声明/裁剪粒度）；
- **工具面预算守卫**：每角色工具面 ≤ 预算（建议初值 24 件——现最大面 dev/debug
  族量级）——超限强制走合并/退役提案，防工具面膨胀侵蚀专注度；
- **T3 教训防线（pick_tools 前车）**：注册表快照**版本化**——任务开始时冻结快照，
  工具面按版本边界变化，不逐任务变（W6 冻结快照友好——前缀缓存不破坏）。

### 3.4 治理流（skill 同构——用户裁决 Q3）

```
候选（tool-function 沉淀 / sensor 观测提案 / 人工）
  → controller:tool-face 包装提案（kind=tool-proposal，draft）
  → controller:adversarial 对抗性审核（schema 质量 / 执行体安全 / 作弊捷径——W7 复用）
  → 监督批准（审批面——PTH_TOOL_WRITE_POLICY=staged|manual，W5 同款配置）
  → tool-reg official 生效（不可变 + 审计留痕）
  → 复测（N6 通道——调用成功率 / 组合步数下降为证据；deopt 回滚同款）
```

L2 正在接的 skill staged 流设施（propose/review/approve 三段）直接复用到 tool-proposal
——两通道同构不同 kind。

### 3.5 执行缝（实施 P2 落点）

agent-loop 工具解析 = **静态 TOOL_SCHEMAS ∪ 注册表可见集**（按 role 过滤 visibility、
按快照版本冻结）；执行分发：`executor.type` → program 走 ts 核（独立 vm 上下文，
能力白名单 = 条目声明）/ builtin 走既有 AGENT_TOOLS 表 / agent 走穿透 runChild 执行缝
（batch-process 已备——深度限 1 规则同样适用）。

### 3.6 现状执行体盘点与归并关系（2026-08-18 用户问询补录）

**现实起点：执行体四套位置、四种管理，互不统一**——通道设计必须正面回应：

| # | 现位置 | 存什么 | 现管理 | 归并去向 |
|---|---|---|---|---|
| ① | `agent-tools.ts`（TOOL_SCHEMAS + AGENT_TOOLS 两张硬编码表） | LLM 工具 schema + 执行器（35 件） | 改代码发版——无注册机制 | **builtin 态**——一次性全登记（本节裁决） |
| ② | `ptc/contract.ts` + `capability.ts` | PTC 能力函数（ts 程序面） | 注册表单一真相源，但装配手写 | **保持程序面**——不进 tool call 层；builtin 条目的执行体可引用同源实现（避免双实现漂移） |
| ③ | `memory_entries`（kind=tool-function） | refiner 沉淀源码片段 | 有统一存储、无执行管理（召回复制重放） | **program 态候选池**——晋升管线原料（§3.4） |
| ④ | `toolstore/extensions/<id>/` | 扩展包（plugin.json + index.ts） | 统一目录 + ext-registry 装载，但「代码库式」（2026-08-09 裁决：contracts 不注册装载，ext.use 重放） | **外部工具来源通路**——扩展/MCP 工具经 toolstore → 提案 → 注册（D1 落点）；④的装载器与重放式使用保持不动 |

**归并裁决（Q4——2026-08-18 用户）：一次性全登记。**

- 存量 35 件**全部登记为 builtin 条目**：`executor: {type:"builtin", ref:<AGENT_TOOLS 执行器键>}`；
  **执行完全不动**（仍走硬编码函数表——零行为变化），条目承担治理面
  （description 三要素统一/可见性声明/包归属/版本起点 v1）；
- **登记器**（P0 范围）：从 TOOL_SCHEMAS 自动生成 builtin 条目的 seed 脚本——幂等可重跑
  （seed-wiki 同款）；visibility 初值 = 现状推导（各角色 actionTools 声明的并集——
  登记不改变任何角色的实际可见面，只把隐式声明显式化）；
- **双写一致性对账**（P0 钉测试）：注册表 builtin 条目集 ≡ TOOL_SCHEMAS 键集
  （名称/包归属/三要素齐备）——防登记漂移；新增硬编码工具必须先有条目否则对账测试红；
- **归并完成态**：TOOL_SCHEMAS 退化为「builtin 执行器索引」（执行面），tool-reg 成为
  工具的**唯一治理面**（schema/可见性/版本）——①的两张硬编码表从「真相源」降级为
  「执行器仓库」，治理真相源归一到 tool-reg。
- ②的 PTC 能力函数**不做条目化**（程序面基板，非 0.17.1 定义的工具）——但 builtin
  条目执行体与其同源引用（contract.ts 仍是被引用的实现处）。

---

## 4. 分层 SOP × 4（四段式草案——W4 创建时机：本设计即「找到正路」时刻）

> SOP 粒度裁决（设计内自决）：**每层次一条通用 SOP**——层次是对象维，SOP 是工作流标准；
> 点位级差异在 Procedure 内分化，不单独立条（点位级 SOP 随 W4 时机自然补齐）。

### skill:opt-tool-face（工具面优化）

```
【场景锚点】sensor:tool-face 观测到重复工具组合链/多步绕行
【何时用】组合链频次 ≥ 阈值（建议 ≥3 任务复现）或穿透/注册候选出现
【效果】组合成本外移——LLM 一次 tool call 替代 N 步组合
## Procedure
1. 读 sensor:tool-face 观测报告（候选链清单——代价：1×obs 查询）
2. 判定固化形态：确定性→program；判断类→agent；性能/特权→builtin（代价：1×推理）
3. 走 §3.4 治理流提案（代价：1×manage.tool.register）
4. 复测验证（组合步数下降——代价：1×verify 任务）
## Pitfalls
- 工具面预算守卫：超限先合并/退役，不硬塞（专注度命题 3）
- 快照版本化：不在任务中途变工具面（T3 教训）
- 候选池≠工具：未过审批的沉淀物不进列表
## Verification
- 复测任务同场景组合步数下降 ≥50% 或调用成功率上升；tool-reg official 可查
```

### skill:opt-tool-single（单工具优化）

```
【场景锚点】sensor:tool-single 报告某工具高失败率/误用聚类/描述缺陷
【何时用】工具级失败率 > 15%（repeated-fail 同款阈值）或 unknown-tool 幻觉集中
【效果】单工具调用成功率上升、误用率下降
## Procedure
1. 读观测报告定位工具与失败模式（代价：1×obs 查询）
2. 归因分类：描述误导 / 参数契约不清 / 交互摩擦（mode 误用）/ 功能缺口（代价：1×推理）
3. 对症提案：修描述三要素 / 调交互协议 / 提功能扩展（代价：1×manage.tool.propose）
4. 审批生效后复测（代价：1×verify 任务）
## Pitfalls
- 描述修订保持三要素（T8 标准——场景锚点/何时用/效果）
- 工具不可变：修订 = 新版本，不就地改（B4-1）
## Verification
- 复测窗口该工具失败率回落至阈值下；幻觉邻近名消失
```

### skill:opt-memory（记忆优化）

```
【场景锚点】sensor:memory 报告记忆缺口/重复条目/僵尸 draft/低命中
【何时用】缺口定位（0.15 记忆缺口）或质量聚合超阈值
【效果】检索步数下降、命中质量上升
## Procedure
1. 读观测报告（缺口清单/重复聚类——代价：1×obs 查询）
2. 对症：补条目（refiner 沉淀路由）/ 合并重复 / 归档僵尸 / 优检索路径（代价：1-2×memory 操作）
3. 归档/合并类走 manage.memory.archive 提案（治理流——代价：1×提案）
4. 复测检索面（两级检索 ≤2 步达标——W3 访问复杂度）
## Pitfalls
- 删除类不自动（记忆是核心资产——治理层流转）
- 补条目先查重（N1b 矛盾检测）
## Verification
- 缺口场景检索 ≤2 步命中；重复聚类收敛；hit_count 均值回升
```

### skill:opt-rule（规则优化）

```
【场景锚点】sensor:rule 报告护栏误杀/规则未生效/权限拒绝异常
【何时用】护栏 hit/kill 比异常或引导消息反复出现 ≥3 任务
【效果】行为约束精准化——误杀下降、越界收敛
## Procedure
1. 读观测报告（护栏计数/拒绝分布——代价：1×obs 查询）
2. 归因：阈值不当 / 豁免缺失 / 规则文案不生效 / 权限过紧过松（代价：1×推理）
3. 对症：manage.params.set 热调 PTH_GUARD_* / 豁免矩阵提案 / 规则文案 stamp 提案（代价：1×调节调用）
4. 复测窗口对比（恶化回滚——deopt 同款）
## Pitfalls
- 阈值调整走配置中心（PTH_GUARD_*——不硬编码）
- 豁免不进代码——豁免矩阵声明式（N12）
- 治理族不豁免（D2 裁决——阈值放宽替代豁免的先例）
## Verification
- 复测窗口误杀率下降且越界事件不升；护栏参数变更有 audit 留痕
```

---

## 5. 与既有机制的咬合

| 既有项 | 咬合点 |
|---|---|
| **N12 护栏二期** | 观测面 = sensor:rule 数据源；调节面 = controller:rule——**二期随本设计 P1 同落**（不再单独立批） |
| **穿透 skill（0.16.3）** | agent 执行体的特化——本期并存；后续可把 `skill:penetrate:*` 名归一为 `tool-reg` agent 态（不在本期） |
| **W8 组织权** | 新 6 点位 = 治理族——不获 tasks 投递权（既有裁决自动继承） |
| **D1 MCP 拆解** | A2 开通道后价值翻倍——MCP 工具 → program/builtin 态注册是最自然来源（下批车道池） |
| **N6 复测** | 四层 SOP 的 Verification 统一走既有复测三通道 |
| **tool-function 沉淀** | 候选池定位不变（state.recallFunctions 保留——未晋升的片段仍可召回复用） |
| **0.3.6 并联〔待议〕** | 通道是其机制前提；三态工具本身仍是串联深化——〔待议〕状态不变 |

## 6. 实施分期（建议——后续工程批认领）

| 期 | 内容 | 量级 |
|---|---|---|
| **P0 契约** ✅ 已落（2026-08-18） | `tool-reg` 条目格式 + `__tool_spec__` 校验 + memory-policy PROMPT_KINDS 增补 + **存量登记器**（PTC_TOOL_DEFS 33 件 builtin 条目 seed，幂等——`scripts/seed-tool-reg.ts`；数量订正：33=AGENT_TOOLS 27 键含 done + ASP-only 6，本文 35 为 B6 退役前旧数）+ **双写一致性对账测试**（§3.6——穿透 P3 同款接口位先行，**可独立成批**） | 中（原小——Q4 裁决扩量） |
| **P1 观测** ✅ 已落（2026-08-18） | sensor 三新点位（builtin-roles + prompt）+ guardrails 计数进 scorecard（N12 二期观测面）——`d230f96` | 中 |
| **P2 通道执行缝** ✅ 已落（2026-08-18） | 注册表驱动动态工具面（快照版本化 + 预算守卫）+ program 执行器（ts 核）+ agent 态接穿透 runChild + `PTH_TOOL_WRITE_POLICY` 配置——`008f85c` | 大 |
| **P3 调节与 SOP** ✅ 已落（2026-08-18） | controller 三新点位（tool-face/tool-single/rule，GOVERNANCE_ROLES 13→16）+ manage.tool.* 调节面（预算守卫 + manual/staged 双策略）+ 四条 SOP 固化（SEED_OPT_SOPS 落库）+ 晋升管线首跑（真实 tool-function `fn-wx7wk7→tool:toolfn_anchor_stats` / `fn-v2u2if→tool:toolfn_anchors_of` 经提案→对抗审核→批准→注册全链，ts 核执行 + 快照可见验证——`scripts/n14-p3-tool-promotion.ts`） | 中 |

## 7. 验收要点（实施时钉测试）

1. tool-reg 注册校验：schema 非法/执行体缺字段/visibility 空 → 调用即拒绝（穿透校验同款）；
2. 快照版本化：任务中途注册新工具 → 本任务工具面不变，下任务生效（T3 防线）；
3. 预算守卫：工具面超限 → manage.tool.register 拒绝并提示合并/退役；
4. 治理流：draft 工具不可见/不可调；official 才进可见集（穿透 official 门槛同款）；
5. 新 6 点位：谱系注册 + 组织权排除 + actionTools 面符合治理族约束。
