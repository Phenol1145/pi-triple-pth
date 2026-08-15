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
| A1 | PTC 契约类型化 + Seam 解耦 | 4 | 5 | ~~契约是 LLM↔核 的接口根——agent-loop/工具/模板/转译全消费它；现在不类型化，每加一层机制就多一层欠债~~ ✅ Phase 1–3 全落（2026-08-14 `c45256f`/`40a93f9`/本批） |
| A2 | 双 storage 层归并 | 3 | 4 | ~~持久化基座——一切记忆/任务/空间特性都写穿它；晚归并 = 双份迁移面~~ ✅ 已落（2026-08-14 `f51a944`→`dcdd4e3` 四提交 + 文档批——附录 B） |
| B6 | N8 空间-角色绑定校验 | 3 | 4 | ~~空间是执行基板，T6 治理模型已锁——校验晚做，空间分化会先失控~~ ✅ 已落（2026-08-14 `37216d0` 概念 / `1e6d785` 校验 / `7e0380d` 工具面退役——附录 C 修订版） |
| B2 | N6 复测（verify）一等化 | 3 | 4 | ~~JIT 闭环的信任锚——deopt 依赖诚实复测；验证不闭合，优化产物全建在沙上~~ ✅ 已落（2026-08-14——附录 D） |
| B4 | N2 skill 记忆类型（SOP 一等化） | 3 | 4 | 知识层根基——N4 生态转化与 §8.2「工作流 SOP」都建在它上面；**B4-2 已裁 A / B4-3 已裁 C（2026-08-15）；Phase 1–4 已实装（四段式格式 + 种子 + 两级检索 + memory-keeper 维护面 + staged 审核流 + controller:adversarial + SKILL.md 映射）** |
| D1 | N12 二期①：护栏进 scorecard 观测 | 2 | 3 | 护栏的数据层——JIT 调护栏参数（D1b）依赖它；与 N13 共用轨迹（✅ 2026-08-15 已落：trace guard 事件 + scorecard.guards） |
| B3 | N4 生态转化 pipeline | 3 | 3 | 0.13 机制落地——但上游是 N2（先有类型后有转化）（✅ 2026-08-15 已落：`importSkillMarkdown` 记忆侧 skill 条目化） |
| B5 | N1b 百科矛盾检测 | 2 | 3 | 污染防线写侧断言——wiki 在增长（91 条），污染代价随体量上升（✅ 2026-08-15 已落：`validateWikiWrite` + worker 写前强制校验） |
| D3 | T9 PTL 侧交接 flow + 提交指南 | 2 | 3 | PTL↔PTH 协作接口——T01/T03/T04 教训（任务文本非自包含）要靠它制度化 |
| D5 | 失败任务回收机制（软终止/警告闭合任务的转派/归档/重试） | 3 | 3 | D2 用户指出：护栏强制闭合当前只回 null——无回收通道，任务价值被丢弃；与 trigger retask 机制同源 |
| E1 | N13 思考路径图重建器 | 3 | 2 | 0.15 方法落地——是下一代 JIT collect 的前置，但现有机制不依赖它（✅ 2026-08-15 已落：`thinking-path.ts` 纯函数重建器） |
| B7 | N5 资源环采集 | 3 | 2 | 第三级外环——按 0.7.3 时间尺度分离，慢环本就最后闭合 |
| C1 | N10 剩余 21 子任务派发 | 1 | 2 | 验证基线——不阻塞代码，但应持续并行跑 |
| D4 | T8 role-doc 文案三要素对齐 | 1 | 2 | 内容对齐——随批次推进 |
| B1 | N7 归档定期触发接线 | 1 | 1 | 纯叶子——执行端已实装，只差 trigger 接线（工作量最小） |
| D2 | 治理族豁免负结果收敛 | 1 | 1 | ✅ 已裁决（2026-08-15 用户 custom）：**不豁免治理族——N 5→15 全局放宽**（sensor 观测窗口 + 失败任务回收机制缺失期不过早强制闭合；`PTH_GUARD_NEGATIVE_LIMIT=15`，引导仍 N=3，maxSteps 兜底） |
| E2 | N11 可预测性地图 | 1 | 1 | 0.14 猜想的前沿接口——无代码影响，纯设计 |

## 3. 四象限定位

```
紧迫度（根本程度）
5 │ A1
4 │           A2·B6·B2·B4          ← 核心区：基座与信任锚，最该先动
3 │           D1·B3·B5·D3·D5
2 │ E1·B7    C1·D4                  ← 能力区：新能力与验证，并行推进
1 │ E2·B1                           ← 旋钮区：随时可做
  └────────────────────────── 重要度（代码体量）
     1      2      3      4      5
```

## 4. 推荐执行序列（紧迫优先，同档按重要度）

**第一批（根基）**：
1. ~~A1 PTC 契约化（5）——一切接口改动的先手（实施方案见附录 A）~~ ✅ 全三阶段已落；
2. ~~A2 storage 归并（4/3）——地基，改完再叠新特性~~ ✅ 已落（附录 B 五 Phase 全完）；
3. ~~N6 复测一等化~~ ✅ 已落（附录 D）；
4. ~~N8 空间绑定校验~~ ✅ 已落（附录 C 修订版）；
5. N2 skill 类型（4）——知识层，为 N4 铺路（B4-2/B4-3 已裁——可直接开工 Phase 1）。

**第二批（机制链）**：D1 护栏观测 + E1 N13 路径还原**可合批**（共用轨迹数据，一次把 0.15 的数据底座建起来）→ N4 生态转化 → N1b 矛盾检测 → D3 交接 flow → D5 失败任务回收。

**第三批（并行/顺手）**：C1 测试集全程并行跑；B1（N7 接线）任一批次顺手做掉；D4 文案随各批次对齐。

**已拍板/前沿**：D2 已裁并落地（2026-08-15——N 5→15）；N11 留作设计储备。

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

### Phase 2 —— Seam 解耦（装配上移，核稳定）✅ 已实装（2026-08-14 `40a93f9`——ptc/runner.ts 统一执行缝 + 三消费点迁移（agent-tools ts.run/ts.eval / agent-loop 降级 / task-loop 直执行）+ 核契约条目升级 + ptc/docs.ts 生成器（prompt-docs 接线待 golden 对齐）+ 8 测试；全量 1586 绿）

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

### Phase 3 —— 契约校验开启 + 执行级制动 ✅ 已实装（2026-08-14——全量测试绿）

9. **能力面越界 → 编译前拒绝** ✅：新增 `ptc/surface.ts`——扫描成员访问根/直接调用根，
   剥离字符串/模板串/注释/正则字面量，收集声明/形参/解构为安全名（保守策略——合法程序零误杀），
   JS 内建白名单按 node:vm 实测清单。越界 → `raw.ok=false + code=capability-out-of-bounds`
   + 引导消息（列出注册表派生的可用能力根——与 N12 unknown-tool 护栏同构）；
   `skipSurfaceCheck` 可关。预检基准 = `ts.state` 注入面键集合。
10. **TOOL_SCHEMAS 生成器** ✅：新增 `ptc/tools.ts`——35 条工具契约（三要素 anchor/whenToUse/effect
    + properties/required），`buildToolSchemas()` 派生 agent-tools 的 TOOL_SCHEMAS——
    与旧手写逐字节一致（生成时 round-trip 校验 + ptc-tools 测试 golden 钉死）。
11. **in-flight 终止语义**（对比文档 ③）✅：`Interpreter.abort?(): Promise<void>` 显式契约——
    终止运行中程序并 await 落地。ts 核=reject in-flight execute（ok:false aborted；同步 runaway
    仍由 runInContext timeout 中断——单线程边界）；PyKernel/BashKernel=同步 resolve pending + kill 进程
    （下个 execute 懒 spawn 自愈）；SandboxKernel=abort in-flight HTTP + dispose 归还租约 + await release。
    接线：batch-process shutdown 与 worker-remove 先 abort 后 dispose；KernelManager/worker facade
    全核转发（allSettled）。
12. **cache 注入收敛** ✅：task-loop 不再直调 injectCapability——构建 capabilityInject（cache 能力对象）
    → runAgentTask → agent-loop 透传 → runPtcProgram `caps` 统一装配（注入先于越界预检——同一机制）。

### 兼容与验证

- 每 phase 独立提交；Phase 1 纯重构——全量 1573 测试必须保持全绿；
- 行为逐字保留（降级模板/引导消息/结果注册语义不变）；
- 验收：agentic 测试集 T01（混合任务——PTC 组合）回归 + 新增 contract/runner 单测；
- 零新依赖（校验器手写；d.ts 预置由 stripTypeScriptTypes 免费吸收）；
- Phase 3 验收：ptc-surface（越界预检 7 组）/ptc-tools（35 条 golden）/ptc-runner（装配+越界 6 例）/
  ts·py·bash·sandbox 四核 abort 契约测试——全量套件回归绿。

> **A1 遗留（Phase 2 条目 8 尾件）**：能力索引文档生成器（ptc/docs.ts buildCapabilityIndexDoc）已建+已测，
> 但 prompt-docs.ts 的 buildCapabilityIndex 仍为手写散文（覆盖 fs.task/perf/model/obs/ext 等注册表外条目）——
> 切换需先补齐注册表条目并对齐 golden 断言，另行提交。



---

## 附录 B：A2 双 storage 层归并实施方案

> 依据：§8.2 概念债务「双 storage 层（pth/storage vs kernel/storage）归属待定」+ 张力表 D1（推荐 A：统一到 kernel/storage）。
> 探查结论（2026-08-14 全仓盘点——见下）。
> **✅ 已实装（2026-08-14）**：五 Phase 全落，裁决点按推荐 A/A/A（`f51a944` 归并 / `a594cdf` 死代码 / `697101e` 审计接线 / `dcdd4e3` obs 修复 + 文档批）。

### 0. 现状盘点（探查事实——不只是两个目录）

| # | 事实 | 详情 |
|---|---|---|
| 0.1 | **双包** | `src/pth/storage/`（会话平面 4 文件·Redis——7 个 src 消费点 + 4 测试 + 2 示例）vs `src/pth/kernel/storage/`（数据世界 8 文件·PG——assembly.ts 与 batch-process.ts 双装配点，各建各的 pg 池） |
| 0.2 | **审计双后端** | `AuditWriter`（Redis Stream `audit:log`，maxlen 10k——活跃：agent-engine/tools-platform/components-store/fallback 消费）vs `PgAuditStore`（PG `audit_log` 表——createDataWorld 创建但**生产零消费**，仅测试引用） |
| 0.3 | **设置三面** | `RedisSettingsStore`（main.ts 创建但**零消费**——死接线）；`config/settings.json`（PTL 租户模板——hot-reloader 校验不注入——非存储层，不动）；`perf-params config()`（kernel 运行时参数——第三面，不动） |
| 0.4 | **发现缺陷** | `obs.tasks`/`obs.search` 走 `queryReadOnly`，但 `READONLY_TABLES` 仅 `memory_entries` → **生产环境两工具必抛「表不开放」**，而错误文案却引导「任务面请用 obs.tasks」——自相矛盾（测试 mock 数据世界未暴露） |
| 0.5 | **死表** | `lab_events`/`credit_tx`（agent-lab 迁 archive 后零消费——保留表+标注，不做 DROP 避免数据迁移面）；`skills`（v1 占位——B4 范围，不动） |
| 0.6 | **失效示例** | `examples/custom-store`/`custom-tool` 引用 `../../src/storage/*`（pth/ 前缀化前的旧路径）——已损坏，本批随迁修复 |
| 0.7 | **后端架构基线** | 引擎不归一（分析见 `docs/pth/storage-backend-analysis.md`）：PG 数据世界 + Redis 热面 + 文件产物 + 内存配置——四类形态各配其适、无同数据双写；A2 全部 Phase **不移动任何引擎**，归并范围 = 包/归属/接线/死代码 |

### 1. 归属裁决（概念先行）

**kernel/storage = PTH 持久化基座单一包**——记忆/任务/空间/转录/审计/会话六面全穿它：

```
src/pth/kernel/storage/
├─ index.ts              # barrel：数据世界 + 会话平面接口统一出口
├─ world 面（现存量）：pg.ts · schema.ts · task-store-pg.ts · memory-store-pg.ts
│             · transcript-store.ts · audit-store.ts
└─ session/（迁入）：interfaces.ts · types.ts · redis-session-store.ts
```

- **审计两平面**（取代"双后端"）：会话审计 = Redis Stream（PTL 侧会话事件——现状唯一活跃面）；
  任务审计 = PG `audit_log`（kernel 任务事件——本批接线，见 Phase 3）。两平面职责互补不重复。
- **设置归位**：会话平面协议保留 `SettingsStore` 接口；`RedisSettingsStore` 无消费者删除（见 Phase 2）。
- **迁移面单一化**：此后 schema 演进（N7/N9/N13 落库）只改 `schema.ts` 一处。

### 2. Phase 划分（每 phase 独立提交、独立全绿）

**Phase 1 —— 目录归并（纯移动 + 全量重接线，行为不变）**
- `git mv`：src/pth/storage/{interfaces,types,redis-session-store}.ts → src/pth/kernel/storage/session/（redis-settings-store 不迁——Phase 2 删）
- 6 个 src 消费点重接线：main.ts · gateway/server.ts · gateway/routes-observe.ts · workflow/orchestrator.ts · core/session-pool.ts · core/agent-engine.ts
- 4 个测试重接线：test/integration/{storage,engine-lifecycle}.test.ts · test/unit/{hub-observe,f-wp5-integration}.test.ts
- barrel：kernel/storage/index.ts re-export session 接口（SessionStore/SettingsStore/CredentialProvider——不 re-export Redis 实现）
- 决策点 1：**不留薄转发层**（D1 推荐 A 原文是"留薄转发层逐步废弃"——本仓消费点已全量盘点（7+4+2），转发层本身也是双迁移面的一部分，直接迁净）

**Phase 2 —— 死代码清理（设置面）**
- 删 `RedisSettingsStore` + main.ts 创建行 + test/integration/storage.test.ts 对应用例
- `SettingsStore` 接口保留（会话平面协议 + examples 内存实现依赖）

**Phase 3 —— 审计两平面接线（让 PgAuditStore 有真消费者）**
- task-loop 任务终态事件写 PG 审计：completed/submitted → `kernel.dataWorld.audit.write({ eventType: "task_completed", actor: role.id, taskId, payload })`；rejected → "task_rejected"（fire-and-forget——审计失败不阻断任务）
- 会话面事件（tool_call/self_modify/recovery）保持 Redis Stream 不变
- 测试：task-loop 测试断言终态审计写入 + transcript-audit 已有用例保持

**Phase 4 —— obs 只读面修复（探查缺陷 0.4）**
- 新增 `dataWorld.queryTemplate(sql)`：**受信模板通道**（obs 工具专用——SQL 为固定模板 + 参数白名单校验（status/role/limit 已正则），不经 READONLY_TABLES 的 memory-only 白名单，仍强制 SELECT/单语句/LIMIT 上限）
- obs.ts 的 tasks/search 改走 queryTemplate；LLM 面（memory.query）不变——memory_entries-only 安全边界不动
- 测试：真实池链路 obs.tasks/obs.search 可用；LLM SQL 仍拒绝 tasks/transcripts

**Phase 5 —— 文档与概念落档**
- concepts.md §8.2 勾除「双 storage 层归属待定」+ 写入本裁决；design-tensions-adjudication.md D1 行状态更新
- prompt-docs.ts PROJECT_DIR_DUTY「src/pth/kernel/storage」职责串更新（数据世界 + 会话平面）
- self-modify.ts 目录清单串同步；examples/custom-store、custom-tool 引用修复（含 EnvCredentialProvider 改自 @away_from/infra——现路径已不存在）
- schema.ts 死表标注（lab_events/credit_tx——archive/agent-lab 遗留，保留表+注释归属）

### 3. 验证

- 每 phase 全量测试绿（基线 1612）；Phase 1 纯移动——零行为变化（重接线逐文件对拍）
- 真实栈：pi-platform 重建 → 冒烟三连：① /observe/sessions 正常（会话平面）② 任务完成后 `audit_log` 有 task_completed 行（审计接线）③ obs.tasks/obs.search 经真实数据世界可用（0.4 修复）
- 无 schema 变更（SCHEMA_VERSION 不动）；git mv 保留历史

### 4. 待用户裁决（3 点）

| # | 事项 | 选项 | 推荐 |
|---|---|---|---|
| A2-1 | 包层归并方式（与引擎无关——引擎不归一是架构基线，见 0.7） | A 直接迁移（无转发层）· B 薄转发层逐步废弃（D1 原文） | ✅ A 已落地——消费点全量盘点，转发层=双迁移面残留 |
| A2-2 | PgAuditStore 处置 | A 接线（task-loop 终态事件写 audit_log——审计两平面）· B 摘除实例化（audit_log 留作预留）· C 删除 | ✅ A 已落地——task_completed/task_rejected 写入，PG 审计有真消费者 |
| A2-3 | RedisSettingsStore 处置 | A 删除类+接线移除（接口保留）· B 保留待未来 tenant settings 需求 | ✅ A 已落地——类已删，SettingsStore 协议保留 |



---

## 附录 C：B6 空间-角色绑定校验（N8）实施方案【修订版——概念先行】

> 修订（2026-08-14 用户裁决方向）：原版把绑定校验硬套旧工具面——概念未转变。
> 旧模型「空间先于 worker 分化存在，worker 在其间导航」→ 新模型「空间随 worker 分化/注意力管理需要生成」。
> 本修订版按新模型重写：概念转变 → 兼容诊断 → 派生实现。
> **✅ 已实装（2026-08-14，裁决按推荐 A/A/A）**：Phase 0 概念（`37216d0`）→ Phase 1 校验（`1e6d785`）→ Phase 2 工具面退役（`7e0380d`）→ Phase 3 恢复透传+落档（本批）。

### 0. 概念转变（先于一切实现）

**旧模型（先验基板）——0.10.3 编码了它**：
- 动作空间/记忆空间先于 worker 分化存在（内置六空间 = 共享基板）；
- 「每个 worker 在它的空间里导航」——导航为主，空间不动；
- 0.10.4 注意力解法 = 空间切换重置（切换已有空间）。

**新模型（派生结构）**：
- 空间 = worker 拓扑的派生结构：
  1. 随 **worker 分化需要**生成（新 worker 类型上线 → 生成其绑定空间 = 基板收窄 + 工具面裁剪 + 记忆域分配）；
  2. 随 **注意力管理需要**生成（上下文超限/专注切换 → 生成子空间重置注意力——0.10.4 的「切换重置」升级为「生成即重置」并存）；
- 空间与 worker 类型深度绑定（T6）——**生成即绑定**；
- 生成是优化行为 → 优化通道 + 审批面（不经 worker 直接执行）。

**关键区分（旧模型混淆的两件事）**：
- **语言执行基板**（ts/python/bash/dev/write + kernels）= 能力基础设施——先验、共享、不生成、不绑定——回答「代码在哪里执行」；
- **绑定空间** = worker 的工作容器（基板收窄 + 工具面裁剪 + 记忆域分配）——派生、生成、绑定——回答「这个 worker 的注意力装什么」；
- 旧模型把两者混成一个（六个内置空间既是基板又是共享容器）——这就是「空间先于 worker」的根源。

**概念修订清单（Phase 0 落点）**：
- 域 C 词条「空间（space）」〔旧〕→ 重写：worker 拓扑派生结构，生成即绑定，生成走优化通道；
- 域 C 新增词条「语言执行基板」〔桥〕：ts/python/bash/dev/write 共享基础设施；
- 0.10.3 修订：「每个 worker 在它的空间里导航」→「每个 worker 的空间随它分化生成，在其内导航」；
- 0.10.4 修订：注意力解法 = 生成即重置 + 切换重置并存（顺带清理已废止的 pick_tools 引用）；
- §10 账本 N8 更新。

### 1. asp.* 兼容诊断（对「兼容不好」的直接回答）

**是的——概念转变必然改工具面，硬套（旧工具 + 新绑定）才是兼容性最差的路。** 逐工具诊断：

| 工具 | 旧模型语义（现状） | 新模型下 | 处置 |
|---|---|---|---|
| asp.cd | 在全局空间树迁移（共享基板） | 在我的绑定空间集内切换注意力（工具面/记忆域随之切换）；进入未绑定空间拒绝 | 保留工具，描述重写（T8 三要素），新增绑定校验 |
| asp.index | 全局空间树 | 展示我的绑定空间集 + 生成状态 | 保留，输出改写 |
| asp.create | worker 运行时建子空间（批 3 dev 隔离） | 退役 worker 侧——生成走优化通道（分化提案联动）/管理 SDK | 移出 worker 工具面（TOOL_SCHEMAS 35→33）+ agent-loop 分支移除；spaceRegistry.register/unregister 保留（治理通道接口） |
| asp.destroy | worker 注销子空间 | 治理通道（worker 类型退役 → 空间随之注销） | 同 create |
| ASP_BLOCK prompt | 「探索：asp_index…执行：asp_cd 迁移到语言/生产空间」 | 绑定空间叙事 | 文本重写 |
| 批 3 测试（space-governance 200 行 / asp-space 276 行） | worker 侧 create/cd 用例 | 按新语义改写（create 用例移至注册表/治理通道层） | 测试批量对齐 |
| dev 子空间隔离模式（批 3） | worker 用 asp.create 造隔离舱 | 由「注意力管理生成」接管（生成器按需造舱，worker 只 cd） | 能力保留，通道变更 |

### 2. 实现 Phase（修订）

- **Phase 0 概念（先行提交）**：概念修订清单全量落 concepts.md（词条重写 / 0.10.3 / 0.10.4 / N8）。
- **Phase 1 模型+校验**：SpaceDef.bindRoles（生成空间必填 = 生成即绑定；基板不填）；register 格式/幂等校验；isRoleBound（谱系上溯）；asp.cd 进入校验。
- **Phase 2 工具面/prompt**：asp.cd/asp.index 描述重写；asp.create/asp.destroy 移出 worker 工具面（TOOL_SCHEMAS 生成器删 2 条——治理通道接口保留）；ASP_BLOCK 重写；space-index 展示绑定集+生成状态。
- **Phase 3 恢复+测试+落档**：assembly 恢复透传 bindRoles；测试批量对齐（存量 create 用例迁移）；容器重建冒烟（绑定空间拒绝非绑定角色）。

### 3. 裁决点（修订）

| # | 事项 | 选项 | 推荐 |
|---|---|---|---|
| B6-1 | 基板/绑定二分 | A 内置六空间重定位为「语言执行基板」（共享、不绑定、cd 自由）；生成空间 = 绑定容器 / B 内置也绑定化（收紧） | **A**——二分正是新模型的支柱；绑定只约束派生空间 |
| B6-2 | create/destroy 退役方式 | A 本批移出 worker 工具面（治理通道接口保留）/ B 渐进（先只授优化器系角色，下批移除） | **A**——T6「不经 worker 直接执行」一步到位；旧用例按新语义迁移 |
| B6-3 | 生成机制接线范围 | A 本批只落概念+语义+校验，生成触发（分化提案联动空间生成）留 D3 / B 本批连带最小生成钩子（role-register 时自动生成绑定空间） | **A**——生成触发是治理通道大件，不阻塞校验；概念已为它留位 |

### 4. 验证

- Phase 0：concepts 修订（纯文档）；
- Phase 1-2：存量 asp-space/space-governance 按新语义对齐后全绿 + 新增绑定拒绝/放行/谱系上溯用例；
- Phase 3：全量测试 + 容器重建冒烟（绑定空间拒绝非绑定角色进入——真实 agent-loop 链路）。


---

## 附录 D：B2 复测（verify）一等化——落地记录

> N6 已实装（2026-08-14）。原缺口：「verifyAfterWindow 标志已有；独立复测任务未一等化」——
> 复测只有被动窗口等待（有机流量），流量枯竭/混杂时验证永不闭合——deopt 的信任锚悬空。

### 落地机制（四件套）

1. **独立复测任务派发**：apply（自动/人工两路径）对 role-doc 目标派发受控复现任务
   （payload.flow 路由到目标角色 + verifyOf 键控）——任务文本自包含（背景/规则/证据场景）；
   capability-index 目标无单一角色——不派发（走全局聚合）。
2. **证据三通道结算**（checkDeopt）：受控优先——verify-task 聚合（N 个受控任务）＞
   角色有机流量（基线后 ≥ 窗口）＞ 全局聚合 rollup（capability-index 目标——跨角色求和）。
   劣化 50%+ → 回滚；达标 → verified（verifyAfterWindow=false + verifySource 落账）。
3. **超时诚实闭合**：deadline 内零证据进展 → verify_expired + task-insight 洞察——
   验证缺口可见（人工复核/降级人工闸门），不再静默悬挂。
4. **独立巡检**：checkDeopt 定时器（PTH_VERIFY_SWEEP_MS 缺省 30s；unref 不阻塞退出；
   worker-remove 停表）——不再只挂窗口检测（流量枯竭时窗口永不填满的悬挂路径消除）。

### 数据面

- 复测任务 scorecard **不进**热点窗口与角色聚合（受控场景会系统性偏置两者）——
  只进 `verify-aggregate:<suggestionId>`（按建议键控的受控证据）。
- 配置键：`PTH_VERIFY_TASKS`（受控任务数，缺省 3）· `PTH_VERIFY_TIMEOUT_MS`（缺省 30min）·
  `PTH_VERIFY_SWEEP_MS`（缺省 30s——0 禁用）。

### 范围外（记录）

- 复测任务的**场景自动生成**仍是模板级（证据 metric 摘要拼入任务文本）——
  场景的语义精准复现（同一任务类型重放）留热点检测 v2/LLM 生成升级；
- capability-index 目标用全局聚合（角色指标不可归属）——全局 rollup 是近似证据，人工复核兜底。


---

## 附录 E：B4 skill 记忆类型（N2——工作流 SOP 一等化）实施方案

> 依据：§10 账本 N2「skill 记忆类型（工作流 SOP 一等化）——无实现」+ 域 B 词条「skill〔新〕：
> 系统化描述怎么做某件事（SOP）——JIT 优化对象（版本化+deopt）——场景锚点（三要素）」+
> §8.2 债务「工作流 SOP——角色特定标准作业步骤还不是一等概念」+ 0.13.2「SKILL.md → memory 条目」。
> 现状探查（2026-08-14）：skill kind 已入 memory-policy **prompt 层**（worker 只读 ✓）；
> 手写种子 skill:api-investigation 已有（lazy 指针模式 ✓）；skills 表 v1 占位；skills.get 能力 v1 返回空。
> **修订（2026-08-14 用户裁决 ×2）**：
> ① skill 治理从「JIT 优化对象（版本化+deopt）」**改为不可变**——SKILL.md 是声明式知识，
> 不适用断点续跑检测（N6 复测靠受控复跑对比指标，知识 SOP 无法被行为复测）；
> ② **维护收编 memory-keeper 专项**——skill 是记忆四类型之一（域 B 设定/百科/skill/日志），
> 维护 = 记忆维护 worker 的角色职责（同 spaceMaint 收编 controller 系的治理模式）。
> **外部参考（2026-08-14 调研）**：Hermes Agent（记忆与 skill 稳定进化结构）+ Prime Agent（多级记忆）——
> 对照见 `docs/superpowers/explorations/2026-08-14-hermes-prime-memory-reference.md`；
> **吸收的设计点已单独列示于 concepts §8.3 待议清单（W1–W7）——2026-08-14 用户裁决完成**：
> W1/W2/W4/W6 原案生效；W3 修订为**访问复杂度限制**（不按容量）；W5 修订为**审核策略可配置**
> （同 T4 分层闸门）；W7 设计为**对抗性安全审核角色**。生效设计已并入下方 Phase。
> B4-2 已裁 A / B4-3 已裁 C（2026-08-15）——按 Phase 落地（每 phase 独立提交）。

### 0. 现状盘点

| # | 事实 | 详情 |
|---|---|---|
| 0.1 | **类型已半埋** | kind="skill" 在 memory-policy 已是 prompt 层（layerOfKind → 拒绝 worker 写——治理半就位） |
| 0.2 | **种子已有** | skill:api-investigation 手写条目（受保护系统文档 + system prompt lazy 指针——检索模式已验证） |
| 0.3 | **占位未接** | schema skills 表（v1 视图占位）；capability skills.get 返回 undefined（v1 占位） |
| 0.4 | **JIT 缺口** | optimizer 建议 kind 只有 rule/role——skill 不在优化对象面（N2 的「版本化+deopt」无通道） |
| 0.5 | **SOP 债务** | 角色特定标准作业步骤散落在 role.prompt 散文里——无结构化条目（§8.2 债务） |

### 1. 概念落定（域 B 词条修订）

**skill〔新〕** = 系统化描述怎么做某件事（SOP）的**独立不可变知识条目**：
- **格式——四段式（§8.3 W1 ✅）**：场景锚点三要素（【场景锚点】/【何时用】/【效果】）+ Procedure 有序步骤
  + **Pitfalls**（已知失败模式与修正——负知识结构化）+ **Verification**（怎么确认成功——验收标准）；
- **有界——访问复杂度限制（§8.3 W3 ✅ 修订——不按容量设限）**：度量①寻址复杂度（场景 → 全文的查询步数，
  两级检索保证 ≤2）；度量②执行复杂度（Procedure 每步标注所需工具调用数/基本函数语句数，
  总代价超阈值 → 不合格需拆分——维护任务与审核角色的质检项）；
- **治理——不可变 + 专项维护（2026-08-14 用户裁决）**：prompt 层、非维护角色只读；**写后冻结**——
  不进 JIT 优化对象面（deopt/复测不适用：SOP 是声明式知识，断点续跑检测测的是行为，知识无法被复跑测量）；
  **维护 = memory-keeper 专项**（记忆四类型的维护职责——同 spaceMaint 收编 controller 系）：
  专属维护面（写新条目/显式覆写 force/归档）仅注入 memory-keeper 角色；修订审计留痕；
- **与 rule 的分界**：rule = 一句话规则（追加进 role-doc/capability-index 的 stamp——**可 deopt 回滚**）；
  skill = 完整 SOP 条目（独立条目 id=skill:<name>，按场景锚点检索——**不可变**）。

### 2. Phase 划分

**Phase 1 —— 类型与格式（memory-policy + 种子 SOP）** ✅ 已实装（2026-08-15——`src/pth/kernel/skill-format.ts` 格式模板/种子数据 + `prompt-docs.ts` 注入 3 条种子；测试 `skill-format.test.ts` + `prompt-docs.test.ts`）
- 定义 skill 条目格式规范（四段式——三要素 + Procedure + Pitfalls + Verification，写入 concepts 域 B 词条 + skill 模板常量；
  Procedure 每步标注调用代价——访问复杂度质检项）；
- 首批种子：把散落在 role.prompt 的角色 SOP 条目化（developer 实现→验证→交付 / scout 侦察→简报 /
  memory-keeper 沉淀流程——seed skills 注入 + 受保护）；
- §8.2「工作流 SOP」债务勾除；skills 表标注同步（视图投影语义不变）。

**Phase 2 —— 检索面与能力接线**
- `skills.get(name)` 真实现：capability.ts v1 占位 → dataWorld.memory.get(`skill:${name}`)（返回结构化条目）；
- **渐进披露两级检索（§8.3 W2 ✅）**：Level 0 = skill 清单（name+description 摘要——memory.index 的 skill 节）；
  Level 1 = 按需全文（memory.query id 查）；冻结快照友好（§8.3 W6 ✅）——skill 不进 system prompt，不破坏 prefix cache；
- 测试：skills.get 取条目/未知名空/worker 写拒绝/清单两级。

**Phase 3 —— 不可变 + memory-keeper 专项维护面（替代原 JIT 对象化——按用户裁决取消）**
- **维护能力按角色注入**：buildCapabilities 增加 roleId 上下文——`skills.maintain`（write 新条目 /
  显式覆写 force / archive 归档）**仅注入 memory-keeper 角色**（roleFilter 机制同源）；
  其他角色调 memory.write({kind:skill}) 依旧被 checkWrite 拒绝（prompt 层只读不变）；
- **不可变语义**：maintain.write 只允许新条目或显式覆写（force + 审计 meta）；写后冻结——
  checkUpdate 对 skill 拒绝一切隐式修改；修订 = 归档旧条目 + 新条目（审计留痕）；
- 维护任务流：tags memory/organize → memory-keeper 路由（已有角色）——任务内用维护面写条目，
  完成后即冻结；**创建时机（§8.3 W4 ✅）**：复杂任务成功/踩坑找到正路/用户纠正 → refine insight 捕捉 →
  维护任务固化；optimizer 面不接 skill（不 propose/apply/deopt）；
- **审核策略可配置（§8.3 W5 ✅ 修订——同 T4 分层闸门）**：PTH_SKILL_WRITE_POLICY 用户可设——
  manual（缺省，人工闸门）/ staged（draft 提案 → 监督批准 → memory-keeper 执行——与 T7 归档 approve 流同构）；
- **对抗性安全审核角色（§8.3 W7 ✅ 设计）**：治理族新增 controller:adversarial——skill 固化提案的对抗性审核
  （reward hacking 显式检验：Pitfalls 完整性 / Verification 可测性 / 作弊捷径——绕过治理/越权/目标函数漏洞）；
  接入 staged 流：提案 → 对抗性审核 → 监督批准 → memory-keeper 执行；
- PTC 注册表补 entries：skills.maintain.write/archive（三要素 + 参数校验——A1 契约纪律）；
- 范围外（记录）：skill 的 JIT 自动生成（热点→SOP 生成器）——若未来做，产物仍是 draft 提案 +
  memory-keeper 维护任务批准成不可变条目。

**Phase 4 —— 0.13 转化落点 + 落档**
- SKILL.md → 条目格式映射定稿（0.13.2 转化流程的 skill 分支落点——N4 pipeline 直接写该格式）；
- concepts N2 账本 → ✅ / 域 B 词条修订 / backlog B4 行；容器重建冒烟（skills.get 真实链路）。

### 3. 待用户裁决（3 点）

| # | 事项 | 选项 | 推荐 |
|---|---|---|---|
| B4-1 | skill 的治理语义 | ✅ 已裁决（2026-08-14 用户 ×2）：**不可变**——写后冻结；不进 JIT deopt/复测面（SKILL.md 不适用断点续跑检测）；**维护收编 memory-keeper 专项**（专属维护面按角色注入） | **D**——知识不可变，行为才可复测；维护 = 记忆 worker 职责 |
| B4-2 | 首批种子 SOP | A 注入 3 个角色 SOP seed（developer/scout/memory-keeper——从 role.prompt 提炼条目化）/ B 不注入（空类型——JIT 自然生长）/ C 全角色 13 个（当前叶子数） | ✅ 已裁决 A（2026-08-15）：3 条 seed 证明格式与检索闭环，JIT 再自然扩展（裁决材料 → 附录 F） |
| B4-3 | skill 检索面 | A 沿用 memory.query 指针 / B 独立 skill 索引工具 / C 清单+按需两级（Hermes 渐进披露） | ✅ 已裁决 C（=§8.3 W2）——Level 0 清单 + Level 1 按需全文 |

### 4. 验证

- 每 phase 全量测试绿（基线 1628）；Phase 3 复用 N6 复测闭环（skill 目标走 verify 三通道——targetRole 路由复测任务）；
- 容器重建 + 冒烟：ts 程序内 skills.get 取种子 SOP 条目（真实链路）。

---

## 附录 F：B4-2 / D2 裁决材料（2026-08-15）

> 两个都是「政策旋钮」级裁决，落地都小：B4-2 决定 N2 skill 类型首批种子；D2 决定
> `GUARD_EXEMPTIONS["negative-loop"]` 对治理族的豁免面。现状已核对实现：
> B4 方案见附录 E（Phase 1 开工只差本裁决）；D2 对应 `guardrails.ts` 豁免矩阵
> （当前仅 scout/explorer——T5）。

### F1. B4-2：首批种子 SOP 选型

| 选项 | 做法 | 收益 | 代价/风险 |
|---|---|---|---|
| **A** | 注入 3 条 seed：developer（实现→自验→交付）/ scout（侦察→压缩→交接）/ memory-keeper（整理→沉淀→索引）——从现有 role.prompt 提炼为四段式（W1：场景锚点 + Procedure + Pitfalls + Verification） | ① 四段式格式立即有真实条目；② Phase 2 两级检索与 skills.get、Phase 3 memory-keeper 维护面都有东西可验；③ 3 个角色正是 §8.2「工作流 SOP 债务」最重的落点；④ 人工质量可控 | 另外 10 个叶子角色暂无 seed——等闭环稳定后随 JIT/N4 补 |
| B | 不注入 seed（空类型，等 JIT 自然生长） | 零人工、无先入为主的 SOP | skill 类型长期空转：检索/维护面没真实条目可验证；SOP 债务继续挂账；N4 转化缺目标格式样例 |
| C | 全角色 13 条 seed 一次注入 | 覆盖最全 | 13 条人工提炼 + 验收工作量大；prospector/solver/predictor 等 8/15 刚分化，SOP 未成熟——首批质量风险高 |

**推荐 A**：与附录 E Phase 1 设计完全一致；3 条足以跑通「格式 → 检索 → 维护」全链路，
其余 10 条等闭环稳定后按 W4 创建时机（成功/踩坑/用户纠正 → refine 捕捉 → 维护任务固化）自然补齐。
（选项 C 中的「全角色 7 个」已按 2026-08-15 谱系更新为 13 个。）

**✅ 裁决（2026-08-15）**：**A**——注入 developer / scout / memory-keeper 3 条 seed，Phase 1 据此开工。

### F2. D2：治理族是否豁免负结果收敛强制终止

> **B1 实锤**：2026-08-14 acceptor 汇总长任务做合法重复探测，被 negative-loop N=5 软终止截断
> （concepts §10 批注）。护栏语义：guide 从第 3 次连续负结果起、强制终止在第 5 次；
> `maxSteps`（PTH_AGENT_MAX_STEPS）始终兜底；T5 已把 scout/explorer 写进豁免矩阵。
> **豁免 ≠ 裸奔**：豁免只取消 N=5 终止，第 3 次起仍有引导，任务仍有 maxSteps 上限。

| 选项 | 做法 | 收益 | 代价/风险 |
|---|---|---|---|
| **A** | 治理族全豁免：`planner / governor / acceptor` + `sensor / controller` 及其 `sensor:* / controller:*` 子角色进 `GUARD_EXEMPTIONS["negative-loop"]` | 治理/验收/观测/调节类任务的核心动作就是「反复检查直到有结论」——负结果（not found / 失败 / 空）是合法结论信号而非死循环；与 T5 同构（留 guide + maxSteps 兜底）；策略统一，不用逐角色补裁决 | 真死循环的治理 worker 会跑到 maxSteps（有界）；滥用信号靠 D1（护栏命中进 scorecard）观测——这是 D1 被排在 D2 前面的原因 |
| B | 仅 acceptor 豁免（最小证据面） | 改动最小，恰好覆盖 B1 实锤 | 同属反复探测型的 planner / sensor / controller 仍可能被误杀；策略碎片化，下次还要再裁 |
| C | 不豁免，治理族单独调高阈值（如 N=8 才终止） | 保留刹车 | 只是推迟误杀而非消除；阈值靠猜，合法探测次数本无上界 |
| D | 维持现状观察 | 零改动 | B1 已实锤一次，验收类任务天然反复探测，复发概率高 |

**推荐 A**：与 T5 先例一致（合法多探测按角色类豁免、guide/maxSteps 兜底）；
B1 案例证明这不是理论担忧。若采纳，落地 = `guardrails.ts` 豁免谓词加治理族判定 + 测试
（acceptor/planner/sensor:system-opt 豁免、developer/coder 不豁免），随 D2 勾销 backlog 行。

**✅ 裁决（2026-08-15 用户 custom）**：**不豁免治理族——N 5→15 全局放宽**。
- 用户澄清后确认：N 就是护栏阈值 `PTH_GUARD_NEGATIVE_LIMIT`（缺省 5）；
- 裁决理由：① 15 给 sensor 留足行为轨迹观测窗口；② 现阶段失败任务终止没有正常回收机制，
  一律放弃过于严苛——宁可放宽到 15（仍有 N=3 引导 + maxSteps 兜底）；
- 落地：`guardrails.ts` 缺省 5→15 + agent-loop 注释/测试同步 + concepts/backlog 落档；
- 衍生待办：**D5**（失败任务回收机制——软终止/警告闭合任务的转派/归档/重试）已进 backlog 表。
