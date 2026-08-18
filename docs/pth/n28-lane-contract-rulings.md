# N28 lane 契约跨 lane 裁决记录

> 日期：2026-08-18
> 状态：用户已裁决（全部按建议修订）
> 适用范围：`docs/pth/n28-role-memory-orchestration-implementation-plan.md` 与
> `docs/pth/n28-task1-contract.md` … `docs/pth/n28-task7-contract.md`。

## 0. Gate 0 记录

- N27 最终复验报告 `docs/pth/v1.2-acceptance-fix-revalidation-final.md`：**ACCEPTED**。
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
