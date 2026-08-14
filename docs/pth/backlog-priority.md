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
1. ~~A1 PTC 契约化（5）——一切接口改动的先手（实施方案见附录 A）~~ ✅ 全三阶段已落；
2. ~~A2 storage 归并（4/3）——地基，改完再叠新特性~~ ✅ 已落（附录 B 五 Phase 全完）；
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

- **审计两平面**（取代"双后端"）：会话审计 = Redis Stream（PTL 交互面事件——现状唯一活跃面）；
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
