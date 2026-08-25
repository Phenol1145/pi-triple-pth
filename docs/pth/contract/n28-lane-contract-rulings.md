# N28 lane 契约跨 lane 裁决记录

> 日期：2026-08-18
> 状态：用户已裁决（全部按建议修订）
> 适用范围：`docs/pth/plan/n28-role-memory-orchestration-implementation-plan.md` 与
> `docs/pth/contract/n28-task1-contract.md` … `docs/pth/contract/n28-task7-contract.md`。

## 0. Gate 0 记录

- N27 最终复验报告 `docs/pth/report/v1.2-acceptance-fix-revalidation-final.md`：**ACCEPTED**。
- 复验对象已修订为 `main@c2c0729`（R6 = lane tip `4d0a38b` 经 merge commit `c2c0729`
  合入 main；**R1–R6 全部 merged**）。
- N28 设计/实施计划基线 commit：`9f10082`（docs-only）。
- 各实现 lane 分支必须派生自包含 `9f10082` 的 main，首条 commit 注明 Gate 0 已过。

## 1. 裁决 C1：契约类型归属（计划 Task 1 Step 3 ↔ Task 3 Step 4）

- 问题：计划原写 Task 1 按设计 §2.2/§4.1/§5.3/§6.2 建接口，而 Task 3 代码在
  `memory-directory.ts` 重新定义 §4.1 的 `RegionMembership`/`DirectoryEntryInput`/
  `MemoryDirectorySnapshot`，造成同一类型两个家。
- 裁决：**§2.2/§5.3/§6.2 归 T1 `cognitive-responsibility.ts`**（含支撑类型
  `RetrievalWaveTrace`）；**§4.1 的三个 Directory 类型归 T3 `memory-directory.ts`
  独家拥有**，T1 不得重复定义，T4 从 T3 导入。
- 落账：计划 Task 1 Step 3 与 Task 3 Step 4 已修订；T1/T3 契约已同步。

## 2. 裁决 C2：授权探针分母 32 = 8 面 × 4 种失效（计划 Task 7 Step 2）

- 问题：Task 5 冻结的操作→capability 映射表为 7 个 read surface，但 Task 7 写
  `authorizationProbeCases===32`（eight read surfaces × 4）。
- 裁决：**第 8 个授权面 = KnowledgeContext build**。八面枚举：
  1. KnowledgeContext build（`memory.read`）
  2. `memory.retrieve`（`memory.read`）
  3. `memory.get`（`memory.read`）
  4. `memory.query`（`memory.read` + `memory.query`）
  5. `state.recallFunctions`（`state.recallFunctions`）
  6. `state.recallInsights`（`state.recallInsights`）
  7. `skills.list`（`skills.list`）
  8. `skills.get`（`skills.get`）
- 四种失效：invalid signature / missing capability / already expired /
  lease-expired-after-creation。32 保持不变。
- 落账：计划 Task 7 Step 2 已补枚举；T5/T7 契约已同步。

## 3. 裁决 C3：T4 legacy 调用 fail-closed（计划 Task 4 Step 6 补写）

- 问题：注入 `layeredRetriever` 后，无 worker 绑定的 legacy `query({grant,...})`
  路径计划未定义。
- 裁决：**未注入 layered retriever → 旧路径逐字节不变；已注入但调用方缺少
  replica/worker 绑定，或 Directory tenant/worker 与 verified envelope 不匹配 →
  fail-closed，`layeredSearchWave` 调用次数必须为 0**。
- 落账：计划 Task 4 Step 6 已补写；T4 契约 §8.2 已列为显式关闭条件。

## 4. 裁决 C4：ASP 模式取法（计划 Task 6 代码片段）

- 问题：计划片段用 `config.aspMode`，仓库现状为
  `pthConfig().str("PTH_ASP_MODE") === "on"`。
- 裁决：不改计划正文；T6 实现按仓库现状（`pthConfig` 字符串比较）适配
  `aspMode` 表述。
- 落账：T6 契约 §8.2/§9 已注明。

## 5. 裁决 C5：WorkerReplica.snapshot 空闲态 currentTaskId 键（计划 Task 2）

- 问题：计划 Step 1 冻结测试断言空闲/完成后
  `toMatchObject({ state, currentTaskId: undefined })`，但计划 Step 3 实现片段
  只在有任务时展开 `currentTaskId` 键 → `toMatchObject` 失败（T2 实测 2/4 红）。
- 裁决（用户选项 1）：**snapshot 恒定输出 `currentTaskId` 键**（无任务时为
  `undefined`；JSON/IPC 序列化时自然省略）。测试与契约不动。
- 落账：计划 Task 2 Step 3 代码已修订；T2 实现 `c0f09fa` 已按此落地。

## 6. 裁决 C6：toolsDescription 增加 allowlist 参数（计划 Task 6）

- 问题：计划 Step 2 要求 prompt 只列冻结 union（`buildAgentSystemPrompt()`/
  `toolsDescription()`），但 T6 契约 §3 文件域漏列 `agent-tools.ts`。
- 裁决（用户选项 1）：**允许 T6 修改 `agent-tools.ts`**——`toolsDescription`
  接受 `allowlist?: readonly string[]`（过滤前先 canonicalize 下划线→点）。
- 落账：T6 实现 `db4efce` 已落地；账本决策栏 C6 已登记。

## 7. 裁决 C7：n28Typecheck 门禁范围正式收窄（计划 Task 7 / P1-5）

- 问题：计划 Task 7 的 `tsconfig.n28.json` files 清单要求 4 scripts + 31 个 focused
  测试文件；但仓库 root `tsconfig.json` 历来排除 `test/`，存量测试并非 Node16 严格
  类型洁癖（无扩展名 import、vitest globals、既有类型假设）。把 31 个存量测试整体
  纳入 Node16 严格检查需要改写大量与 N28 无关的测试代码。
- 裁决：**n28Typecheck 门禁正式收窄为 N28 专有文件**（4 scripts + vertical +
  evaluator/acceptance 三测试，共 7 文件）；其余测试的“能跑”证据由 focused 31 文件
  与 `npm test` 全量回归承担，源码类型正确性由 `npm run lint` 的根 `tsc --noEmit`
  承担。未来清理存量测试类型洁癖后可再扩回 31 文件。
- 落账：`tsconfig.n28.json` 已按此提交；T7 契约 §8.2 类型门禁条目同步修订。




## 8. 裁决 C7 事后人工批准（第二轮复核 P0-5 / §8 条件 7）

- 问题：第二轮独立复核指出 C7 收窄发生在被评估 commit 之后，§8 条件 7 要求
  人工批准合同版本或恢复 35 文件 typecheck。
- 裁决（用户选项）：**批准 Task 7 合同 v1.1**——确认 C7 收窄后的 7 文件清单为
  最终合同范围，n28Typecheck 证据以 `tsconfig.n28.json` 7 文件 zero-skip 为准；
  `npm run lint` 根 `tsc --noEmit` 继续覆盖源码类型正确性。
- 落账：`docs/pth/contract/n28-task7-contract.md` §11 v1.1 人工批准修订；envelope 的
  `contractDisposition` 引用本裁决。

## 9. 裁决 P1-1：H1/H4/H5/H6 正向探针补成真实观察（第二轮复核 §7 线 3）

- 问题：H1 无 pause/resume 且 heartbeat 只查 envelope；H4 的 32 格多数停在 scope factory；
  H5 未经过 capability facade 且 working-set 反序输入未验证；H6 未做 Working Set 与
  LLM schema/prompt/facade 暴露面的精确集合相等。
- 裁决：探针全部补成真实观察，分母冻结值不变（workerLifecycle=6、authorization=32、
  visibility=14、surfaceComparison=12、budget=1000）：
  - H1：6 格 = busy remove / no-preclaim / peer continues / pause / resume / idle remove；
    heartbeat 4 格含逐 replica 与逐 task 的 worker identity 比对。
  - H4：invalid-signature、missing-capability、already-expired、lease-expired 四类全部穿过
    同一 surface 入口（入口内先 verifyBrokerGrant 再执行真实 read）；visibility 14 格改为
    正反双向断言——allowed 行必须命中、denied 行必须为空。
  - H5：1000 cases 经 `createBudgetedTaskCapabilities` facade；`workingSetDeterminismMismatches`
    由反序 skill/candidate 输入独立构造。暴露的生产缺陷：`freezeSkillIndex` 对输入顺序敏感，
    已改为按 id 字典序冻结（`cognitive-budget.ts`），并有反序回归测试锁住。
  - H6：final Working Set trace 的 Tool/Memory/Skill 集合与最后一回合 LLM tools 面、
    prompt Knowledge Context 行、facade skill 暴露做精确相等比较。
