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

## 车道表

| Lane | 任务 | 主要文件域 | 分支 / worktree | 状态 | 认领（会话·日期） | 产出/备注 |
|---|---|---|---|---|---|---|
| **L1** | **N14 设计：sensor/controller 四维细分 + 分层 SOP + 一等工具注册通道设计**（0.17.4 落地；A2 已裁开通道——按完整四层次：工具面/单工具/记忆/规则；细分含 SOP 四段式草案；通道含注册契约+审批治理设计） | `docs/pth/concepts.md`、`builtin-roles.ts`、`skill` 格式、`docs/pth/` | `lane/l1-n14-design` / `.worktrees/l1` | free | — | 纯设计批——产出 = 设计文档 + 概念录入，不改执行代码 |
| **L2** | **A3：skill staged 审核流接线**（`PTH_SKILL_WRITE_POLICY=staged`：提案 → controller:adversarial 对抗性审核 → 监督批准 → memory-keeper 执行；配置项与角色已有，链路未闭） | `packages/pth-memory/src/skills.ts`、`src/pth/impls/kernels/capability.ts`、相关测试 | `lane/l2-staged-flow` / `.worktrees/l2` | **claimed** | 主会话·2026-08-18 | 链路短、闭环收益明确——N2 Phase 3 收尾 |
| **L3** | **C1：worker 子进程健康/卡死检测**（§9 L2 缺口——IPC metric 只有耗时）**+ E2 文档同步**（§8.2 agentic 测试集 checkbox 勾除、§9 L3 标注 N5 已补齐） | `batch-manager.ts`、obs、`docs/pth/concepts.md` §9 表（仅 L3 行——经 L1 协调） | `lane/l3-health-docs` / `.worktrees/l3` | free | — | 小颗粒；concepts.md 改动限 §9 表格行（与 L1 文件域交叠处——L3 先动手，冲突时 L1 让行后 rebase） |
| **L4** | **E1：v1.1.3 发布**（8 commit 未发版：W8×4 + flaky 修复 + 0.16.4 + 0.16.3 + 0.17 文档；走仓库 release 流程——版本号/changelog/徽章/tag） | `package.json`、CHANGELOG/发布文档、README 徽章 | `lane/l4-release` / `.worktrees/l4` | **claimed** | 主会话（本线程）·2026-08-18 | 等 L2/L3 合并后可重基再发（或先发 W8+0.16 批次） |

> 车道池（本批未开——下批候选）：B1 穿透自动发现通道（等 W8 派发数据积累）；
> B2 执行预算经济化（穿透计量面数据基础）；A4 N12 护栏二期（建议并入 L1 规则层 SOP）；
> A5 叶子角色 seed skill（随 L1 SOP 工作）；D1 MCP 拆解（A2 已开通道——价值翻倍，下批）。

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
