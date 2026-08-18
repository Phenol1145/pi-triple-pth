# 并行车道账本（fork-session 协议）

> 2026-08-18 建立——多会话并行执行同一仓库任务的协作协议与认领账本（用户设计裁决：
> worktree 隔离 / 首批四条全开 / A2 开工具注册通道）。
>
> **会话纪律（每条 fork 会话必读）**：
> 1. 开工先读本账本全部（含决策栏）→ 认领 = 把车道表自己那行 `free → claimed`（填会话
>    标记 + 日期），**立即 commit + push**——认领以先到的 commit 为准，撞车让行；
> 2. 干活只在自己的 worktree（`.worktrees/<lane>`）+ 车道分支（`lane/<lane>-*`）；
> 3. 热点纪律：README 徽章/测试总数**只在合并回 main 时更新**（lane 内不改）；
>    `concepts.md` 只许 L1 改——其他 lane 的概念记录写进本表自己那行的「产出/备注」，
>    合并时由 L1 或合并者归并；
> 4. lane 内跑定向测试；合并者合并前跑全量（`./node_modules/.bin/vitest run`）+
>    `./node_modules/.bin/tsc --noEmit` + `npm run check:pth-boundaries`；
> 5. 遇真实分叉 → 停下来给用户出选择题；裁决结果由该会话记入下方决策栏；
> 6. 完成：lane 分支 push → 本表标 `done`（填产出 commit）→ 等用户串行 merge。

## 决策栏（跨 lane 裁决——开工必读）

| 日期 | 决策 | 结果 | 影响 |
|---|---|---|---|
| 2026-08-18 | P1 隔离方案 | **worktree 隔离**（每 lane 独立目录+车道分支，merge 串行回 main） | 全部 |
| 2026-08-18 | P2 首批车道 | **四条全开**（L1 设计线 + L2/L3/L4 工程线） | 全部 |
| 2026-08-18 | **A2 一等工具注册通道** | ✅ **开通道**——schema+执行器注册进工具面 + 审批治理；工具面优化层有真实承接（0.3.6 并联代偿落地第一步；D1 MCP 拆解价值翻倍）。L1 按完整四层次设计 | L1（后续 D1） |
| 2026-08-18 | R1 发布时机 | **等 L2/L3 合并后一起发 v1.1.3**（L3 已 done `982631e` 待合并；L2 进行中） | L4 |
| 2026-08-18 | R2 发布范围 | **全量发布**（release.sh --npm --docker --gh：npm 8 包 topo 序 + docker 回归 + GitHub release 附 tgz） | L4 |
| 2026-08-18 | **L1 设计裁决 Q1/Q2/Q3** | Q1 **增补式**细分（环向保留+四维缺口新增）/ Q2 **执行体三态**（program+builtin+agent——用户 custom「2+3」）/ Q3 **skill 同构治理**。产出：`docs/pth/n14-sensor-controller-four-dims.md`（分期 P0-P3 已全部实施落成——同日收尾批） | L1（后续 N14 实施批） |
| 2026-08-18 | L2 Q1 staged write 行为 | **拒绝 + 引导 propose**（不自动转提案——worker 必经治理入口） | L2 |
| 2026-08-18 | L2 Q2 审核任务编排 | **事件驱动自动派发**——capability 提案落库发 `skill.proposal.created` → trigger `skill-proposal-review` 自动派 controller:adversarial 审核任务（治理任务源新模式——同类可复用） | L2 |
| 2026-08-18 | **L1 Q4 存量归并** | **一次性全登记**——35 件硬编码工具全登记为 builtin 条目（执行不动、条目做治理面；TOOL_SCHEMAS 降级为执行器索引；P0 扩量：登记器 seed + 双写对账测试）。补录：`e719f04`（设计文档 §3.6） | L1（N14 P0） |

## 车道表

| Lane | 任务 | 主要文件域 | 分支 / worktree | 状态 | 认领（会话·日期） | 产出/备注 |
|---|---|---|---|---|---|---|
| **L1** | **N14 设计：sensor/controller 四维细分 + 分层 SOP + 一等工具注册通道设计**（0.17.4 落地；A2 已裁开通道——按完整四层次：工具面/单工具/记忆/规则；细分含 SOP 四段式草案；通道含注册契约+审批治理设计） | `docs/pth/concepts.md`、`builtin-roles.ts`、`skill` 格式、`docs/pth/` | `lane/l1-n14-design` / `.worktrees/l1` | **done** | 主会话-L1·2026-08-18 | ✅ **已合并 main（2026-08-18 主会话-L4 代合——docs-only 无冲突）**：`docs/pth/n14-sensor-controller-four-dims.md` + concepts 0.17.6/词表/N14 行；合并后全量 1988 绿/tsc/boundaries/config；✅ **P0–P3 实施已全部落成（2026-08-18 收尾批）**：P0 `2dce081` / P1 `d230f96` / P2 `008f85c` / P3 本批（controller 三点位 + manage.tool.* + tool-proposal 治理流 + SOP×4 + 真实晋升首跑） |
| **L2** | **A3：skill staged 审核流接线**（`PTH_SKILL_WRITE_POLICY=staged`：提案 → controller:adversarial 对抗性审核 → 监督批准 → memory-keeper 执行；配置项与角色已有，链路未闭） | `packages/pth-memory/src/skills.ts`、`src/pth/impls/kernels/capability.ts`、相关测试 | `lane/l2-staged-flow` / `.worktrees/l2` | **done** | 主会话·2026-08-18 | ✅ 产出 `e08ac2a`（lane 分支已推送）：propose 发 `skill.proposal.created` 事件 + trigger `skill-proposal-review` 事件驱动派审核任务 + staged write 引导 propose + 端到端 4 例（全链 pass/reject/审核面收窄）+ trigger 注册断言 6→7；全量 1985 绿/tsc(根+memory)/boundaries/config——**✅ 已合并 main（merge commit `1f8c6c9`，2026-08-18 主会话-L4 代合）**。概念记录（归并 concepts.md）：**N2 Phase 3 staged 流已闭**；Q1/Q2 裁决见决策栏。注意：staged 需显式开启 + controller:adversarial 入 batch 配比 |
| **L3** | **C1：worker 子进程健康/卡死检测**（§9 L2 缺口——IPC metric 只有耗时）**+ E2 文档同步**（§8.2 agentic 测试集 checkbox 勾除、§9 L3 标注 N5 已补齐） | `batch-manager.ts`、obs、`docs/pth/concepts.md` §9 表（仅 L3 行——经 L1 协调） | `lane/l3-health-docs` / `.worktrees/l3` | **done** | 主会话-L3·2026-08-18 | ✅ 产出 `982631e`（lane 分支已推送）：心跳自报 rss/cpu + listBatches/obs.batches 健康面（healthy/stale/dead + lag + 阈值 PTH_BATCH_HEALTH_STALE_MS）+ 3 测试；§8.2 checkbox/§9 L2·L3 行同步；全量 1982 绿/tsc/boundaries/config(108 键)——**✅ 已合并 main（2026-08-18 主会话-L4 代合）** |
| **L4** | **E1：v1.1.3 发布**（8 commit 未发版：W8×4 + flaky 修复 + 0.16.4 + 0.16.3 + 0.17 文档；走仓库 release 流程——版本号/changelog/徽章/tag） | `package.json`、CHANGELOG/发布文档、README 徽章 | `lane/l4-release` / `.worktrees/l4` | **done** | 主会话（本线程）·2026-08-18 | ✅ 预备 `2866707`（lane 分支已推送）：版本 1.1.3 全 bump（根+7 子包+lock）+ `docs/releases/v1.1.3.md` 草稿（L2/L3 两节占位）+ deployment/docs 索引同步；✅ **v1.1.3 已全量发布**（2026-08-18）：L3→L2 串行合并（244 文件/1988 绿）→ 发布说明定稿 → release.sh --npm --docker --gh 全过（npm 8 包 1.1.3 dist-tags 验证✓ / docker 健康+冒烟✓ / GH release+tag v1.1.3+tgz 附件✓）；途中修 release.sh 阶段 6 三坑（compose 路径/env-file/sandbox 同构构建）+ postgres 卷保数据改密（用户裁决） |
| **B2** | **N15 B2：穿透执行预算经济化**（单次/累计步数预算 + `penetration-edge` 边级计量面——B1 数据地基） | `tasking/penetration-budget.ts`（新）、`bootstrap/batch-process.ts` | `lane/b2-penetration-budget` / `.worktrees/b2` | **done** | 主会话·子代理·2026-08-18 | ✅ `4c166e5` + `cfe8632`（okCalls 调用级成败对齐）——**已合并 main（8b5edfb 序）**：双预算线 + 边级计量聚合；全量绿 |
| **B1** | **N15 B1：穿透稳定边自动发现**（`penetration-proposal` → 监督批准 → `skill:penetrate:<child>` 注册） | `tasking/penetration-discovery.ts`（新）、`system-triggers.ts`、`assembly.ts`、`pth-gateway-facade.ts` | `lane/b1-penetration-discovery` / `.worktrees/b1` | **done** | 主会话·子代理·2026-08-18 | ✅ `d5a3019`——**已合并 main**：discovery 巡检 + 治理链 + gateway 同流；全量绿 |
| **A4** | **N15 A4：护栏 JIT**（guard-kill-spike 热点 → `guard-config` 审批热调 → 复测/deopt 回滚） | `optimizer-hotspots/loop/apply.ts`、`guardrails.ts` | `lane/a4-guard-jit` / `.worktrees/a4` | **done** | 主会话·子代理·2026-08-18 | ✅ `0feeaff`——**已合并 main**：白名单热调 + fail-closed 基线 + deopt 回滚；全量绿 |
| **A5** | **N17 A5：叶子角色四段式 SOP 种子×8**（writer/coder/debug-case-writer/acceptor/planner/spider/solver/predictor——注入 prompt-docs） | `packages/pth-memory/src/skill-format.ts`、`src/pth/kernel/prompt-docs.ts` | `lane/a5-leaf-sops` / `.worktrees/a5` | **done** | 主会话·子代理·2026-08-18 | ✅ `b09ed8f`——**已合并 main**：SEED_LEAF_SOPS×8 + 注入循环；全量绿 |
+| **D1** | **N17 D1：MCP 拆解→tool-proposal 批量治理导入**（mcp-tool-bundle-v1 → parse/spec/importMcpTools + manage.tool.importMcp + import 脚本） | `src/pth/tasking/mcp-decompose.ts`（新）、`src/pth/kernel/extensions/manage.ts`、`scripts/import-mcp-bundle.ts`（新） | `lane/d1-mcp-decompose` / `.worktrees/d1` | **done** | 主会话·子代理·2026-08-18 | ✅ `3628d71`——**已合并 main**：draft 提案批量落库 + tool.proposal.created 自动审核；全量绿 |

> 车道池（下批候选）：A5 叶子角色 seed skill ✅（N17——8 条叶子 SOP 已落）；D1 MCP 拆解
> ✅（N17——mcp-tool-bundle-v1 → tool-proposal 治理注册）。B1/B2/A4/N17 A5/N17 D1 均已落——
> 下一批见下方 v1.2 车道节。

---

## v1.2 车道（角色 × 学科域组合——审稿后路线切换）

> 2026-08-18 审稿裁决：原 N16 V1–V5（批量静态物化 188 个 WorkerRole）**冻结**。
> 问题证据：[N16 问题反馈评审](./n16-v1.2-role-expansion-review.md)（P0×5 / P1×5 / P2×3）。
> 采纳设计：[角色 × 学科域组合与 PTH Knowledge](./n16-v1.2-role-domain-composition-design.md)。
> 学科目录内容保留为输入：[N16 原稿](./n16-v1.2-role-expansion.md)。

### 决策栏（v1.2 修订）

| 日期 | 决策 | 结果 |
|------|------|------|
| 2026-08-18 | 原 V1–V5 批量角色生成 | **冻结**——空配置全量展开 / 32-worker 上限 / catalog 重复 id / tag 冲突 / 知识治理缺口均实证成立 |
| 2026-08-18 | 实施路线 | **组合设计 Phase 0 → 1a → 1b → 2 → 3 → 4 → 5**：先知识正确性加固，再目录/双轴路由，最后双域试点 |

### 车道表（v1.2 修订）

| Lane | 任务 | 分支 / worktree | 状态 |
|------|------|-----------------|------|
| **K0** | Phase 0 设计纠偏：manifest 复算（184+4 事实源）+ 术语/契约定稿 + 目录数据转换脚本 | `lane/k0-v12-design` / `.worktrees/k0` | **done** |
| **K1a** | Phase 1a 知识正确性收口：tenant 强制隔离 + 常规检索默认 official/排除 archived + hit 计数接线 | `lane/k1a-knowledge-hardening` / `.worktrees/k1a` | **done** |
| **K1b** | Phase 1b provenance 强制 + append-only revision + refiner 只写 scoped draft | `lane/k1b-provenance` / `.worktrees/k1b` | **done** |
| **K2** | Phase 2 Discipline Catalog DAG + `TaskWorkItem.domains` + 双轴路由契约 | `lane/k2-discipline-catalog` / `.worktrees/k2` | **done** |
| **K3** | Phase 3 KnowledgeContextProvider + `KnowledgeBroker` 窄 search/get | `lane/k3-knowledge-context` / `.worktrees/k3` | **done** |
| **K4** | Phase 4 candidate→domain/adversarial verdict→memory-keeper promotion 闭环 | `lane/k4-knowledge-promotion` / `.worktrees/k4` | **done** |
| **K5** | Phase 5 双域试点（编程语言官方文档 + 材料科学开放数据库） | 真实 PTH 任务试点（无独立 lane） | **done** |

> K0 已落：`f8afa78`（contracts/domains + Discipline Catalog + 生成器 + 184 数据；全量 258/2122 绿）→ 已合并 main（`c027e0a`）。
> K1b 已落：`aa2762e`（knowledge-provenance + memory_revisions append-only/restore + refiner scoped draft）→ 已合并 main。
> K2 已落：`853b426`（TaskWorkItem.domains + DisciplineResolver + 发布盖章 + claim 映射）→ 已合并 main。
> K3 已落：`4ee2b40`（KnowledgeContextProvider + runner 注入 + broker search/get official 门槛）→ 已合并 main。
> K4 已落：`5fe95b1`（knowledge-verdicts/promotion + adversarial/memory-keeper 能力 + verify/promote 路由）→ 已合并 main。
> K5 已落：真实任务试点（报告 `docs/pth/k5-pilot-report.md`；任务 `f2aee2ff`/`9ec54497` 完成，K4 链真机通过）。
> K5-eval 已落：`75ea7e8`（source registry 12 + knowledge 24 + 60 冻结题 + 评测器；离线与 live 均为 recallAt3/At5/evidence = 1.0/1.0/1.0）。
> K1a 已落：`f4c760d`（PgMemoryStore tenant 隔离 + KnowledgeBroker official/tenant/hit + skills.list official）→ 已合并 main（`7d00b90`）。
>
> F1 已落：`c717677`（canonical provenance + capability 合并 + update revision + promote 幂等重放）→ 已合并 main。
> F5 已落：`32d2efa`（side-effect outbox + candidate lineage + audit 绑定）→ 已合并 main。
> F1–F5 车道实现均已合并；分契约修复映射见 `v1.2-acceptance-fix-completion.md`。独立复验
> 判定原 Gate A/B/C **NOT ACCEPTED**，剩余阻塞与关闭顺序见
> `v1.2-acceptance-fix-revalidation.md`；车道 done 不等于组合 Gate accepted。
> F4 已落：`aa0aa34`（生产 Catalog aliases + query ranking + DB evidence + snapshot hash + 84 题/7 指标）→ 已合并 main。
> F3 已落：`8d79538`（delegate domain 继承 + verdict/promotion 主体与 RBAC）→ 已合并 main。
> F2 已落：`d6f6487`（(tenant_id,id) 复合身份 + requireTenant fail-closed + raw query 门禁）→ 已合并 main。
>
### 合并顺序

K0 → K1a → K1b → K2 → K3 → K4 → K5（每 lane 全量 vitest + lint 绿后串行合并）

---

## R 轮车道（v1.2 复验修复 = N26 Phase 0）

> 触发：复验报告 `v1.2-acceptance-fix-revalidation.md` 改判 F1–F5 为 NOT ACCEPTED（P0×5/P1×5）。
> 计划与分契约：`n27-r1-r6-fix-plan.md` + `n27-r1..r6-contract.md`。
> 纪律：不得缩窄关闭条件——每条关闭条件必须可逐条对账（复验的核心批评）。

| Lane | 任务 | 分支 / worktree | 状态 | 认领 |
|------|------|-----------------|------|------|
| **R1** | P0-1 revision/promotion 正确性：统一 version 语义 + expected-revision CAS + 单事务 promotion | `lane/r1-revision-promotion` / `.worktrees/r1` | **done** | 主会话·2026-08-18 |
| **R2** | P0-2 tenant 查询面：raw SQL 数据面强制 tenant/status/space + 跨租户负向 | `lane/r2-tenant-query-plane` / `.worktrees/r2` | **done** | 主会话·2026-08-18 |
| **R4** | P0-4/P0-5/P1-5 真事务 outbox：同事务 enqueue + claim lease/token/CAS + observer durable failure | `lane/r4-transactional-outbox` / `.worktrees/r4` | **done** | 主会话·2026-08-18 |
| **R3** | P0-3/P1-1/P1-2 verification 绑定：持久 VerificationPlan + service 授权 + 严格 revision + Domain 子集 binding | `lane/r3-verification-binding` / `.worktrees/r3` | **done** | 主会话·子代理·2026-08-18 |
| **R5** | P1-3/P1-4 生产评测：生产端口评测 + 全语料覆盖 + no-answer/冲突/跨版本/holdout + EvidenceRef 全链 | `lane/r5-production-evaluation` / `.worktrees/r5` | **done** | 主会话·子代理·2026-08-18 |
| **R6** | 组合验收：崩溃/并发/跨租户全链重跑（claim→context→commit→outbox→candidate→verification→promotion→retrieve） | 主会话直接执行 | free（依赖 R1–R5 全合并） | — |

> Wave 划分：wave1 = R1/R2/R4 并行；wave2 = R3；wave3 = R5；wave4 = R6。每 wave 串行合并回 main，合并前全量 vitest + lint 绿。

## fork 引导词（v1.2）

#### V1 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane V1（角色定义批）。先读 docs/pth/parallel-lanes.md
全部（协议+决策栏+v1.2 车道），把车道表 V1 行标 claimed（填你的会话名+日期）并 commit push。
工作目录 .worktrees/v1（分支 lane/v1-role-defs——若不存在先运行
scripts/lane-worktrees.sh 初始化；依赖：ln -s ../../node_modules node_modules 快速起步）。
任务：按 docs/pth/n16-v1.2-role-expansion.md 的设计，手写 41 个角色的完整定义：
- 5 个门类（gen=3）：formal-science / natural-science / social-science / humanities / applied-science
- 32 个学科（gen=4）：见设计文档 §2 完整清单
- 4 个非 researcher：debugger / reviewer / communicator / coordinator
每个角色需：id / tags / prompt（含学科背景知识框架） / description / thinking / capabilities /
actionTools / parent / generation / differentiation。
产出：更新 builtin-roles.ts（DEFAULT_ROLES + MID_ROLES）+ 角色定义完整性测试。
约束：遵循 0.16.4 收口（gen=3 门类 actionTools=["execTs","nav","cache"]）；
gen=4 学科 capabilities=["fs","memory","readSource","readText","web","python","bash"]；
不改 concepts.md（概念记录写入本表产出/备注列）。遇分叉停下来给我选择题；做完更新账本。
```

#### V2 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane V2（子学科生成批）。先读 docs/pth/parallel-lanes.md
全部，把 V2 行标 claimed 并 commit push。工作目录 .worktrees/v2（分支
lane/v2-subdisciplines——scripts/lane-worktrees.sh 初始化；ln -s ../../node_modules
node_modules 起步）。任务：基于 V1 产出的 32 个学科 prompt，用模板化方式生成 112 个
gen=5 子学科角色定义。模板参数见 n16-v1.2-role-expansion.md §4。每个子学科需：
id / tags / prompt（父学科 prompt + 子学科专精段） / description / thinking="medium" /
capabilities（继承父学科） / actionTools / parent / generation=5 / differentiation。
产出：builtin-roles.ts 追加 112 个角色 + 测试。约束：不改 concepts.md；等 V1 完成。
遇分叉停下来给我选择题；做完更新账本。
```

#### V3 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane V3（SOP 批）。先读 docs/pth/parallel-lanes.md
全部，把 V3 行标 claimed 并 commit push。工作目录 .worktrees/v3（分支
lane/v3-sop——scripts/lane-worktrees.sh 初始化；ln -s ../../node_modules
node_modules 起步）。任务：为所有角色（现有 15 + 新增 149 ≈ 164）编写四段式 SOP：
场景锚点/何时用/效果/Procedure/Pitfalls/Verification。SOP 遵循 skill 四段式格式
（concepts.md W1）。每个角色至少 1 条。产出：skills/ 目录 + memory_entries seed。
约束：等 V1/V2 完成角色列表；不改 concepts.md。遇分叉停下来给我选择题；做完更新账本。
```

#### V4 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane V4（知识填充批）。先读 docs/pth/parallel-lanes.md
全部，把 V4 行标 claimed 并 commit push。工作目录 .worktrees/v4（分支
lane/v4-knowledge——scripts/lane-worktrees.sh 初始化；ln -s ../../node_modules
node_modules 起步）。任务两件：① 百科扩展——按五大门类填充核心术语/概念/方法论到
pth-wiki（seed-wiki 同款幂等脚本）；② 角色文档完善——每个角色的三要素
（场景锚点/何时用/效果）注入 role-doc。产出：pth-wiki seed + role-doc 注入。
约束：等 V1/V2 完成角色列表；不改 concepts.md。遇分叉停下来给我选择题；做完更新账本。
```

#### V5 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane V5（工程实施批）。先读 docs/pth/parallel-lanes.md
全部，把 V5 行标 claimed 并 commit push。工作目录 .worktrees/v5（分支
lane/v5-engineering——scripts/lane-worktrees.sh 初始化；ln -s ../../node_modules
node_modules 起步）。任务：① 合并 V1-V4 产出到 builtin-roles.ts 最终版本；
② 谱系完整性测试（所有 parent 存在/无循环/标签唯一性/组织权覆盖）；
③ 全量 vitest + tsc + boundaries 绿；④ 版本号 bump 到 1.2.0（根+7 子包+lock）；
⑤ 写 docs/releases/v1.2.0.md 发布说明草稿。约束：等 V1-V4 全部完成；
README 徽章/测试总数只在合并时更新。遇分叉停下来给我选择题；做完更新账本。
```

## fork 引导词（每条 lane 一段——粘贴进新会话即上岗）

### L1 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane L1（设计批）。先读 docs/pth/parallel-lanes.md
全部（协议+决策栏），把车道表 L1 行标 claimed（填你的会话名+日期）并 commit push。
工作目录 .worktrees/l1（分支 lane/l1-n14-design——若不存在先运行
scripts/lane-worktrees.sh 初始化；依赖：ln -s ../../node_modules node_modules 快速起步）。
任务：N14 设计——按 0.17.4 四层次（工具面/单工具/记忆/规则）细分 sensor/controller
（重组或增补观测调节点，每层配 skill 四段式 SOP 草案），并设计一等工具注册通道
（A2 已裁开通道：schema+执行器注册+审批治理——参考 W8 P3 穿透接口位的契约先行模式）。
产出：docs/pth/n14-sensor-controller-four-dims.md 设计文档 + concepts.md 概念录入
（0.17 增补 + N14 行更新）。约束：本 lane 纯设计不改执行代码；遇分叉停下来给我选择题；
做完更新账本标 done。
```

### L2 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane L2（工程批）。先读 docs/pth/parallel-lanes.md
全部，把 L2 行标 claimed 并 commit push。工作目录 .worktrees/l2（分支
lane/l2-staged-flow——scripts/lane-worktrees.sh 初始化；ln -s ../../node_modules
node_modules 起步）。任务：A3——skill staged 审核流接线：PTH_SKILL_WRITE_POLICY=staged
时打通「memory-keeper 提案 → controller:adversarial 对抗性审核（reviewSkillProposal）
→ 监督批准 → memory-keeper 执行」全链。现状：配置项（config/schema.ts:176）、角色、
maintainSkillWrite/proposeSkillMaintenance/reviewSkillProposal 已有，链路未闭。
验收：staged 模式端到端测试（提案→审核 pass/reject→批准→条目落库）；全量 vitest +
tsc + check:pth-boundaries 绿；不改 README 徽章。遇分叉停下来给我选择题；做完更新账本。
```

### L3 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane L3（工程批）。先读 docs/pth/parallel-lanes.md
全部，把 L3 行标 claimed 并 commit push。工作目录 .worktrees/l3（分支
lane/l3-health-docs——scripts/lane-worktrees.sh 初始化；ln -s ../../node_modules
node_modules 起步）。任务两件：① C1 worker 子进程健康/卡死检测（§9 L2 缺口——
IPC metric 现只有耗时：加心跳/存活观测，卡死判定与上报通道）；② E2 文档同步
（concepts.md §8.2 agentic 测试集 checkbox 勾除——N10 已完成；§9 L3 行标注
N5 obs.resource 已补齐——只动这两处表格行，不碰 concepts.md 其他部分）。
验收：健康检测有测试；全量 vitest + tsc + boundaries 绿；不改 README 徽章。
遇分叉停下来给我选择题；做完更新账本。
```

### L4 引导词

```
仓库 /Users/anzhize/pi-platform 的 lane L4（发布批）。先读 docs/pth/parallel-lanes.md
全部，把 L4 行标 claimed 并 commit push。工作目录 .worktrees/l4（分支
lane/l4-release——scripts/lane-worktrees.sh 初始化；ln -s ../../node_modules
node_modules 起步）。任务：E1 v1.1.3 发布——盘点 main 上未发版的 8 个 commit
（W8 P0-P3 任务派发、flaky 根治、0.16.4 工具面收口、0.16.3 穿透执行面、0.17 概念），
走仓库既有 release 流程（版本号/changelog/徽章/tag——先调研仓库 release 惯例再动手）。
注意：L2/L3 合并后可能需要重基或补发——动手前先问我「先发还是等 L2/L3」。
验收：发布产物完整、全量测试绿。遇分叉停下来给我选择题；做完更新账本。
```

> R 轮进展（2026-08-18 主会话合并者记录）：R1 `38128a1` 已合并（merge `a18e72a`）——全量门槛逮到
> 3 例 fake store 缺 promoteOfficial，返修在 `fix/r1-followup`（test/helpers.ts 共享 fake + 3 测试文件）；
> R2 `076a627`+`e423a54`（含合并者对抗评审补丁：FROM 逗号跨表 400 + SELECT 函数调用禁令 + 2 负向测试）
> 待 R1 返修合并后按序合并；R4 实施中（首选同事务 enqueue，申报增改 task-outcome-committer/pg-task-repository）。
> R1 已落：`38128a1` + 返修 `1604d8d`（共享内存 promoteOfficial fake）→ 已合并 main（merge `9d90a2c`）。
> R2 已落：`076a627` + 评审补丁 `e423a54`（FROM 逗号跨表 400 + SELECT 函数调用禁令）→ 已合并 main（merge `83b9699`）。
> R1+R2 合并后门槛：全量 268 文件 / 2294 用例绿 + 9 skip；lint（tsc/boundaries/config）全绿。
> R4 已落：`c5db1a3`（同事务 enqueue + 原子 claim CTE token/lease + observer durable failure + 根修 observer failed）→ 已合并 main（merge `afc870a`）。
> Wave-1 全部合并后门槛：268 文件 / 2298 用例绿 + 9 skip；observer failed 0；lint 全绿。
> R3 已落：`ececb2a` + 返修 `c660c36`（capability kernel verification repo 注入缝）→ 已合并 main（merge `00be7c6`/`0fa2e44`）。合并后门槛：269 文件 / 2283 用例绿；lint 全绿。
> R5 已落：`e8abe1a`（生产端口评测 + 138 题/24 全覆盖/holdout 42(30.4%)/mutation 1.0 + EvidenceRef 全链 + sourceBindingsDigest 填实）→ 已合并 main（merge `1ee7c1b`）。合并后门槛：连续两轮全量 269 文件 / 2292 用例绿（首轮 1 例 flaky 未复现）；lint 全绿。
> Wave-4 R6 组合验收为最后一棒。
