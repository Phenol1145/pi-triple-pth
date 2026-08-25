# N27-R6 契约：组合验收与最终复验

> 对应复验报告 **§6 R6**；依赖 **R1–R5 全部合并**。
> 文件域：组合验收测试/脚本 + 最终复验报告（本 lane 是验收车道，允许更新账本/完成记录）。

## 1. 目标

在真实 PostgreSQL/Redis + 多 batch process 环境重跑完整知识闭环：

```text
claim → context → commit → outbox → candidate → verification → promotion → retrieve
```

覆盖进程崩溃、并发 drainer、lease 过期、重复结果、stale worker、跨租户读取，并以
复验报告格式给出最终结论（ACCEPTED 或诚实标注未关闭项）。

## 2. 阻塞项引用

**§6 R6 原文：**

> **R6—composition acceptance**：重跑完整 `claim → context → commit → outbox → candidate →
> verification → promotion → retrieve`，覆盖进程崩溃、并发与跨租户。

**§6 结论原文：**

> 只有 R1–R6 的正向与负向证据均成立，才可把 Gate A/B/C 改回 accepted。

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| `test/pth-composition/r6-acceptance.test.ts`（或等价 vitest 组合套件） | 端到端组合场景 + 故障注入 |
| `scripts/accept/r6-composition-acceptance.ts`（可选） | 手动/CI 可跑的脚本封装，输出证据表 |
| `docs/pth/report/v1.2-acceptance-fix-revalidation-final.md` | 最终复验报告（矩阵格式，见 §5） |
| `docs/pth/parallel-lanes.md` + `TODO.md` | 验收通过后允许更新账本状态（本 lane 例外；不得在验收前标 done） |

## 4. 设计裁决要点

### 4.1 组合场景（必须真实，不走 mock）

- seed：双域 24 条 domain-fact（含 evidence）+ 双租户（tenant A 与 tenant B）+ 多空间。
- 任务链：发布带 domains 的任务（生产 resolver 盖章）→ claim → KnowledgeContext 注入
  （生产端口，evidence 结构化）→ 执行完成 → commit → outbox 同事务落库 → drainer 消费 →
  refiner 产出 scoped draft candidate → 创建 VerificationPlan → domain verdict +
  adversarial verdict（不同 principal）→ promotion（R1 CAS + R3 plan 绑定）→ official →
  生产 retrieve 命中。
- 断言每个阶段的落库形态（version/revision、outbox token、plan status、verdict 绑定、
  promotion 记录、retrieve 结果）与各契约一致。

### 4.2 故障注入（每个都要有负向断言）

- `crash between commit and enqueue`：注入 enqueue 失败 → 断言 task commit 回滚/可修复，
  candidate 不永久缺失（R4 语义）。
- `dual drainer`：两个独立连接并发 claim，断言同一 outbox 行不被处理两次。
- `lease expiry`：claim 后不 complete，等租约过期（测试用短 lease）→ 被重新 claim，
  attempts 递增，不丢行。
- `duplicate result`：同 key 重复 enqueue / 重复 handler 结果 → 幂等，不重复晋升。
- `stale worker`：旧 token complete → CAS 冲突，不能覆盖新状态。
- `cross-tenant`：tenant B 全程无法检索/verify/promote tenant A 的 candidate；raw query 隔离
  （R2）与 retrieve 隔离双负向。
- `stale verdict`：计划创建后修改 candidate 内容 → 旧 plan/verdict invalidated，promotion 拒绝。

### 4.3 最终复验报告

- 按 `v1.2-acceptance-fix-revalidation.md` 的矩阵格式逐项给结论：
  每个 P0/P1 一行：状态（PASS/PARTIAL/FAIL）+ 证据（测试名/探针输出/文件行号）。
- 报告必须包含「新鲜验证证据」表：全量 vitest、npm run lint、K5 离线/live、R6 组合
  验收、各真实 PG 探针——全部本轮重跑，不引用旧数字。
- 结论只能写：**ACCEPTED**（全部 PASS）或 NOT ACCEPTED + 明确剩余阻塞；禁止用
  "测试全绿所以通过"或"offline fixture 自洽"替代组合证据。

## 5. 非目标

- 不新增功能代码（只写测试/脚本/报告；若发现缺陷，缺陷修复应回对应 lane 契约，不在本 lane 夹带）。
- 不把 N26 的 10 域/60 条当作本轮门槛（那是 N26 Phase 4）。
- 不 push、不发版。

## 6. 验收标准

### 6.1 组合测试

- `r6-acceptance.test.ts` 全绿，且覆盖 §4.1 全部阶段断言 + §4.2 全部故障注入。
- 测试使用真实 PG/Redis（compose 或等价），宿主无 DB skip 不算数。
- 全量 `npx vitest run` 全绿且无 `observer failed` 输出；`npm run lint` 全绿。

### 6.2 关闭条件对账表

| 关闭条件 | 证据 |
|---|---|
| 完整链 `claim → ... → retrieve` 真实跑通 | §4.1 场景 + 阶段断言 |
| 覆盖进程崩溃、并发与跨租户 | §4.2 全部故障注入负向断言 |
| 最终复验报告给出 ACCEPTED/NOT ACCEPTED 与逐项证据 | `v1.2-acceptance-fix-revalidation-final.md` |

### 6.3 完成动作

- 更新 `docs/pth/parallel-lanes.md`（R1–R6 行标 done + 决策栏记裁决）与 `TODO.md`
  （v1.2 复验修复轮勾平），**仅限本 lane**。
- 一条 commit（测试/脚本/报告 + 账本更新）；返回最终报告路径、证据表摘要、偏差说明。
