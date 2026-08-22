# 模块化后续 + N28/N29 复验收口实施计划（2026-08-22）

> 状态：**实施中；Phase A 已完成，Phase B 已完成（N28 重新验收 GO，envelope 已落盘），Phase C 已完成（N29 重新验收 MIN_INNER_LOOP_GO，envelope 已落盘），Phase D–E 未开始**
> 范围：modularity/reuse 计划遗留的后续清理 + N28 Role/Memory/Worker 复验修复 + N29 最小可信知识摄入内环复验修复
> 依据：
> - `docs/pth/modularity-reuse-implementation-plan.md`
> - `docs/pth/modularity-reuse-audit.md`
> - `docs/pth/n28-feasibility-reacceptance-feedback.md`
> - `docs/pth/n29-minimal-intake-reacceptance-feedback.md`
> - `docs/pth/n28-role-memory-orchestration-implementation-plan.md`
> - `docs/pth/n29-minimal-knowledge-intake-loop-feedback-plan.md`

## 目标

1. 清掉 modularity 计划完成后的低风险遗留：ptl 测试失败、web 页面样板、跨仓重复脚本、adapter 小尾巴。
2. 按独立复验反馈把 N28 从 `NOT ACCEPTED / NO-GO` 修到可重新验收。
3. 按独立复验反馈把 N29 从 `NOT ACCEPTED / NO-GO` 修到 `MIN_INNER_LOOP_GO` 候选。
4. 全部完成后收紧工程纪律（import-cycle、barrel、大文件、kernel 子包评估），并在同一批提交里更新文档与发布。

## 阶段总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase A | 低风险遗留清理（ptl / web / 重复脚本 / adapter 例外） | 已完成 |
| Phase B | N28 复验修复（P0/P1 + 重新验收） | 已完成 |
| Phase C | N29 复验修复（P0/P1 + 重新验收） | 已完成（21befb4 GO） |
| Phase D | 工程纪律与结构收口（import-cycle / barrel / 大文件 / kernel 子包） | 未开始 |
| Phase E | 全量验收、文档、发布 | 未开始 |

依赖关系：

```
Phase A（独立可合入）
   ↓
Phase B（N28 修复，影响 execution/runner/worker）
   ↓
Phase C（N29 修复，依赖 tasking/outbox/promotion 稳定）
   ↓
Phase D（在 N28/N29 代码稳定后收紧静态环/深路径/大文件）
   ↓
Phase E（全量门禁 + 发布）
```

---

## Phase A：低风险遗留清理

> ✅ 已实现并验证（2026-08-22）：ptl `4d4e744`，pth `de318a2`。
> 全量门禁：ptl 67 files / 473 tests 全绿；pth 292 files / 2613 tests 全绿；pth/ptl lint、build、docs links 均通过。

### A1. ptl 两个 pre-existing 测试失败

**问题**
- `test/unit/docs-manifest.test.ts`：`docs/docs-manifest.json` 分类与 `collectDocsEntries()` 不一致。
- `test/unit/version.test.ts`：root `package.json` 为 `1.6.0`，`packages/framework/package.json` 为 `1.6.1`。

**任务**
1. 运行 `npx vitest run test/unit/docs-manifest.test.ts test/unit/version.test.ts` 拿到精确 diff。
2. 对 docs-manifest：以 `collectDocsEntries()` 为准重新生成 `docs/docs-manifest.json`，或修正 `scripts/build-docs-manifest.ts` 的分类映射；两者必须一致且 `collectDocLinkIssues` 为空。
3. 对 version：确认已发布的 `@away_from/framework` 版本后，统一 root/framework 版本号；若 framework `1.6.1` 已发布，root 同步到 `1.6.1`，否则 framework 回退到 `1.6.0`。
4. 跑 ptl `npm run lint` 和全量单测，确认 2 个失败消失且无新失败。

**验收**
- ptl `npx vitest run` 全绿。
- `docs/docs-manifest.json` 与 `collectDocsEntries()` 一致。
- `getPtlVersion()` 等于 root `package.json.version`。

### A2. Operator console 页面 load-state 样板收敛

**问题**
- `config/debug/memory/overview/work` 五个页面都有 `setLoadState / setErrorCode / useEffect` 重复样板。
- 之前只抽了 `view-models/{config,debug,memory}.ts`，`overview.tsx` / `work.tsx` 仍内联重复。

**任务**
1. 新增 `packages/pth-console/web-src/src/hooks/useLoadState.ts`（或等价公共 hook），统一 `loading/ready/error`、`errorCode`、`runLoad()` 与 `ApiError` 映射。
2. 迁移 `config.tsx / debug.tsx / memory.tsx / overview.tsx / work.tsx` 全部使用该 hook。
3. 删除页面内重复的 `LoadState` 类型与错误处理分支；保留页面自身的数据转换逻辑。
4. 跑 `packages/pth-console` 的 web typecheck / build 和相关测试。

**验收**
- `grep -n "setLoadState" packages/pth-console/web-src/src/pages` 只剩 hook 调用，不再有页面内 `useState` 样板。
- `npm run build`（含 Vite web build）通过。

### A3. pth/ptl 跨仓重复脚本

**问题**
- `pth/scripts/check-doc-links.ts` 与 `ptl/scripts/check-doc-links.ts` 完全一致。
- `pth/scripts/check-product-boundaries.ts` 与 `ptl/scripts/check-product-boundaries.ts` 完全一致。

**任务**
1. 先给两份脚本加“内容一致”同步守卫测试（类似 `ext-shared-sync.test.ts`），防止继续漂移。
2. 评估是否发布共享脚本包（候选：新增 `@away_from/repo-scripts`，或放入 `@away_from/shared`/`@away_from/infra` 的独立 subpath）。
3. 若发布共享包，则 pth/ptl 的 `package.json` 与 CI 改为依赖该包，删除本地副本。
4. 若暂不发布，则保留同步守卫并在文档中标注“copyBoth 有意复制，但受守卫保护”。

**决策点**
- **D-1**：共享脚本采用“同步守卫”还是“发布脚本包”？（推荐先同步守卫，低风险；后续需要时再发布。）

**验收**
- pth/ptl 两份脚本内容 diff 为空，或 pth/ptl 均从同一共享包导入。
- `npm run check:docs-links` / `check:product-boundaries` 两仓均通过。

### A4. computational-chemistry adapter cleanup 例外

**问题**
- `computational-chemistry-adapter.ts` 的 `finally` 仍直接 `running.delete(request.jobId)`，没有统一到 `ctx.cleanup()`。
- 原因是改成 `ctx.cleanup()` 后 batch fork 集成测试出现 pending。

**任务**
1. 重新尝试 `ctx.cleanup()`，并定位 fork 子进程下回归的根因（`createJobRunContext` 的 `cleanup` 是否因闭包/引用导致 running map 未共享）。
2. 若根因可修，统一为 `ctx.cleanup()`，并补一个防止回归的集成测试。
3. 若仍必须保留例外，在 `job-runner.ts` 与 adapter 头部写清原因，并挂一条 TODO/backlog 跟踪。
4. 顺手评估 adapter 内残留 `sha256hex` 是否还有独立用途；无用则删除，只保留 `job-runner.ts` 一份。

**验收**
- `npx vitest run test/pth-batch/**`（含 fork 集成）全绿。
- adapter 的 cleanup 行为与其它 adapter 一致，或有明确的文档化例外。

---

## Phase B：N28 复验修复

> 依据 `docs/pth/n28-feasibility-reacceptance-feedback.md`。当前已有大部分实现，本阶段是“按反例修复 + 重新验收”，不是从零实现。

### B0. 先决决策与 Gate 0 刷新

1. 确认 N28 合同版本：恢复原 Task 7 要求的 **35 文件 typecheck**，或由人类明确批准收窄后的 C7 范围；若恢复，重建 `tsconfig.n28.json`。
2. 在干净 main commit 上记录新 Gate 0 基线，确保实现、合同、验收 driver 绑定同一 commit。

**决策点**
- **D-2**：N28 typecheck 范围恢复 35 文件，还是接受 C7 的 7 文件收窄？（推荐恢复原合同，避免再次被“事后收窄”质疑。）

### B1. P0-1：生产 Worker 身份与 Memory Directory 责任主体一致

1. `src/pth/bootstrap/batch-process.ts` 的 production batch 必须从 Directory 传入 exact `WorkerReplicaRef` 给 `assembleBatchRuntime()`。
2. 启动时若运行时 Worker 不在 Directory 中，fail closed，不得静默退化到 global。
3. 新增红→绿回归：断言 production batch 的 runtime Worker UUID == Directory `requestedReplica`。
4. 用真实 production batch 路径验证 primary / overlap / fallback / global 四波 expected wave。

### B2. P0-2：重复 ID 绕过统一认知预算

1. `cognitive-budget.ts` admission 改为返回逐行 token / accepted index，禁止用 ID Set 反向放行重复 rows。
2. 所有 backing read port（memory.retrieve / memory.query / state recall）在 facade 层强制唯一 ID，或由账本逐行计数。
3. 新增测试：
   - 同一 memory ID 多行时，实际暴露条目数/字符数不超过账本；
   - omitted 内容不可见；
   - summary→full expansion 重复 ID 也被计数。

### B3. P0-3：H2 真实扫描结果不再被常量覆盖

1. 删除 `eval-n28-feasibility.ts` 中 `bodyCopiesOutsideCanonicalStore: 0` / `ownerlessRegions: 0` 的覆盖。
2. 建立 canonical body map，并实现三类 detector：
   - canonical `Map<tenantId|entryId, body>` composite-ID 重复检测；
   - Working Set snapshot projection roots；
   - Directory membership / Responsibility / Working Set 三种正文注入 detector。
3. 确保 H2 的扫描结果能真实影响最终判定。

### B4. P0-4：六条 sabotage 路径

按 `docs/pth/n28-task7-contract.md` 冻结实现：

| Sabotage | 对应假设 | Sentinel |
|---|---|---|
| `control-target-swap` | H1 | `sameRoleReplicaControlFailures` |
| `directory-body-copy` | H2 | `bodyCopiesOutsideCanonicalStore` |
| `remove-global-wave` | H3 | `missingFourWaveCases` |
| `scope-guard-bypass` | H4 | `unauthorizedReadPortInvocations` |
| `budget-wrapper-bypass` | H5 | `budgetViolations` |
| `tool-dispatch-guard-bypass` | H6 | `hiddenExecutorInvocations` |

1. 在共享 harness 中提供可注入 sabotage 的开关，所有 sabotage 只改变输入/依赖/动作。
2. 每条 sabotage 都要有“唯一对应假设失败、sentinel 严格高于 baseline”的测试。
3. `n28-feasibility-evaluator.test.ts` 从 3 个测试扩展为覆盖全部 sentinel 的敏感度测试。

### B5. P1-1：H1/H4/H5/H6 分母与探针完整化

1. H1：`probeLifecycle()` 必须实际执行 pause / resume，并逐个验证 Worker identity；heartbeat 不再只查 envelope shape。
2. H4：完成 8 read surfaces × 4 invalid conditions 的完整 allow/deny 矩阵；7 rows × 2 ports 的 `probe-*` 允许结果也要断言。
3. H5：1000 cases 必须穿过 capability facade，不能只调 `CognitiveBudgetLedger`；`workingSetMismatches` 不能恒为 0。
4. H6：final Working Set 的 Tool / Skill / Memory ID 集合必须与 LLM schema、prompt、Skill/Memory facade 暴露面做 exact-set equality。

### B6. P1-2：BatchManager unknown 回执处理

1. 接收 replica 回执时保留并验证 `accepted` 字段。
2. `pause/resume/remove` 对 `state="unknown", accepted=false` 返回 false。
3. unknown remove 超时后清理 `pendingRemovalCtl` waiter key，避免长期积累。
4. 新增 unknown worker 控制负测。

### B7. P1-3：wave trace 语义诚实化

1. `batch-process.ts` 分别记录：
   - `candidate`：授权前候选范围；
   - `visible`：授权后、query/rank/limit 前；
   - `selected`：limit 后；
   - `scanned`：真实扫描数。
2. 增加断言：`candidate >= visible >= selected`，且授权过滤量可观测。

### B8. P1-4：acceptance driver 门禁优先级

1. `accept-n28-feasibility.ts` 先检查所有 started gate 的非零退出；任一 started gate 失败优先判 `NO-GO`，再判断未启动 gate 是否环境 unavailable。
2. Redis preflight 结果必须被某个 gate 实际消费；sandbox preflight 不能固定 `ok=true`。
3. 增加 mixed-gate 判定测试。

### B9. N28 重新验收

1. 在同一 clean commit 上重跑：evaluator、focused、typecheck、full regression、lint。
2. 保存完整 `N28AcceptanceEnvelope`，更新 `docs/pth/n28-feasibility-report.md`。
3. 只有全部满足 `n28-feasibility-reacceptance-feedback.md` §8 的 8 条条件，才允许 `accept-n28-feasibility.ts` 输出 GO。

---

## Phase C：N29 复验修复

> 依据 `docs/pth/n29-minimal-intake-reacceptance-feedback.md`。默认 `PTH_KNOWLEDGE_INTAKE_MODE=off` 必须保持到验收通过。

### C0. 安全基线

1. 保持 `PTH_KNOWLEDGE_INTAKE_MODE=off`。
2. 在 `draft/full` 未绑定 `MIN_INNER_LOOP_GO` attestation 前，启动时 fail closed。

### C1. P0-1：side effect tenant 服务端盖章

1. `pg-task-repository.ts` / `knowledge-intake-pg.ts` 的 side-effect tenant 由聚合上下文盖章，不信任调用方字段。
2. 若输入仍带 `tenantId`，与聚合 tenant 不等时事务写入前 fail closed。
3. 新增 Task 与 IntakeRun 两条真实 PG 跨租户回归。

### C2. P0-2：Run CAS 增加 fromStage 与迁移矩阵

1. UPDATE SQL 必须比较当前 `stage`。
2. `fromStage → toStage/status` 使用服务端固定矩阵；非法跳转、同 stage 特例、终态重放都有 PG 测试。
3. 错误 `fromStage=promote, toStage=complete` 必须零领域写、零 outbox。

### C3. P0-3：Trust Policy 运行时不可伪造

1. 删除“repository 接受 `VerifiedTrustPolicy` 结构对象”的公开入口。
2. 只保留一个 verifier→repository 单入口：repository 接收 raw manifest，写事务前调用注入的 Ed25519 verifier；或 verifier 返回不可由普通对象构造的 opaque attestation。
3. 无效 signature / 伪造 digest / 错 tenant/space / service principal 安装均为零行。

### C4. P0-4：SourceRevision / Artifact 不变量

1. repository 层重算：
   - `rawHash === sha256(rawBytes)`
   - `normalizedTextHash === sha256(normalizedText)`
   - admitted 必须从同 tenant/subscription 的 raw-quarantine revision 派生
   - use decision 必须为 `allow`，且 policy/rule/tenant/space 与 Subscription 一致
2. 所有 repository 公共写口按“被错误内部调用者直接调用”做对抗测试。

### C5. P0-5：official knowledge 唯一权威入口

1. 删除 raw store / facade 直接写 `status=official` 的路径。
2. `promoteOfficial()` 的 evaluator 不可省略；未提供 evaluator 时不得写 official。
3. 非 intake 内部知识若不需要外部 SourceRevision，必须走显式 `origin=internal` 的 verification contract，不能用空 digest 兼容路径。

### C6. P0-6：unchanged 分支先过当前 use-policy

1. unchanged/reuse 必须与 changed 一样先通过当前 use-policy。
2. deny 时保留可审计 quarantine/acquisition，明确撤权/冻结语义，不能解释为 unchanged success。
3. 新增“策略收紧后 unchanged 被 deny”的回归。

### C7. P0-7：PromotionSourceGuard 真实数据与策略轮换语义

1. 从 immutable artifact/revision 重算真实 byteLength、content type、license、URI/redirect。
2. 冻结 policy 轮换语义：re-admit / re-extract / rebind / reject 必须显式选择，并持久化新的 policy id/version/digest 决定。
3. 禁止在旧 candidate 上静默换绑。

### C8. P0-8：阶段领域写与 Run CAS 同事务/可恢复

1. 每个阶段把“聚合状态变更 + Run CAS + 下一阶段 outbox”纳入同一事务边界。
2. 若跨 store 无法同事务，先取得带 generation/token 的 durable stage-commit capability，所有领域写以该 capability CAS/幂等，并由恢复器判定唯一胜者。
3. 新增 lease 过期后旧 worker 不留下领域写/outbox 的测试。

### C9. P0-9：draft/full 安全级别

1. `draft` 最多运行到 private draft + open plan，不注册 promote handler。
2. `full` 必须由启动时验签的 acceptance attestation 解锁，并校验 evaluated commit / config contract。

### C10. P1-1：特殊 IP/IPv6 分类

1. 使用标准化 IP 解析替代前缀正则拼补。
2. 覆盖 IPv6 multicast/link scope、IPv4-mapped、benchmark、documentation、reserved、future-use 等全集。
3. 补 `ff02::1`、`0:0:0:0:0:ffff:127.0.0.1`、`198.18.0.1`、`192.0.2.1` 红→绿测试。

### C11. P1-2：review execution separation

1. `knowledge-promotion.ts` / `knowledge-verdicts.ts` 的双核验除 principal 不同外，`executionId` 也必须不同。
2. 新增同 execution、不同 principal 的负测。

### C12. P1-3：acceptance sentinel 精确化

1. 冻结逐项 sentinel ID，要求 exact denominator。
2. 每个旁路必须有唯一对应 sentinel；删除/绕过门禁时 sentinel 必须翻红。
3. 为五类 PG 反例增加精确命名的红→绿回归。

### C13. G8/G9/G10 收口

1. G8：双 OS drainer、三个 SIGKILL 恢复点。
2. G9：受控 TLS 完整生产组合 + 人类批准来源 canary。
3. G10：trust/evidence/digest/lease/stale 逐项 sabotage harness。

### C14. N29 重新验收

1. 在同一 clean commit 上重跑：focused、build、lint、N29/root/N28 typecheck、full regression。
2. 保存 `docs/pth/n29-minimal-intake-acceptance.json` 与 `docs/pth/n29-minimal-intake-report.md`。
3. 只有满足 `n29-minimal-intake-reacceptance-feedback.md` §8 的 12 条条件，才允许 `MIN_INNER_LOOP_GO`。

---

## Phase D：工程纪律与结构收口

> 放在 N28/N29 之后，避免在代码仍大改时过早收紧静态环/拆分大文件。

### D1. import-cycle 继续收紧

1. 当前 `check:import-cycles` 报告：`static-runtime SCC=0`、`static-all SCC=2`、`dynamic SCC=0`。
2. 目标：在 N28/N29 修复后把 `static-all SCC` 降为 0。
3. 需要处理的两个 static-all 环：
   - `catalog/index → pilot-evaluator → runner/agent-task-runner → runner/index → runner/knowledge-context`
   - `execution/knowledge-broker → layered-knowledge-retriever → memory-directory`
4. 评估是 type-only 环还是 barrel re-export 环；优先把深层依赖下沉到 contracts 或拆 barrel。
5. 收敛后把 `import-cycles.baseline.json` 扩展到 `static-all=0` 并加入 lint 门禁。

### D2. 深路径 barrel 纪律

1. 扩展 `scripts/pth-boundaries-core.ts`：把 `cross-module-private-import` 从 gateway/application-gateway 扩展到整个 `src/pth` 的跨模块深路径。
2. 迁移剩余深路径到各模块 `index.ts`；组合根/bootstrap 的显式装配可保留白名单。
3. 目标：`check:pth-boundaries` 违规数从 0 开始，不新增；存量深路径逐步清零。

### D3. kernel 子包拆分评估/实施

1. 先产出 kernel 子包拆分 ADR 或评估报告：候选 `kernel-storage` / `kernel-execution` / `kernel-interpreter`。
2. 若评估通过，按“先拆 barrel → 再拆目录 → 最后独立 package”的顺序实施。
3. 若评估不通过，至少完成 kernel 顶层 barrel 与模块所有权文档更新。

**决策点**
- **D-3**：kernel 子包拆分在本计划内实施，还是只做评估 + barrel 纪律？（推荐先做评估 + barrel，拆分另立专项。）

### D4. 大文件拆分

| 文件 | 当前 LOC | 建议方向 |
|---|---:|---|
| `src/pth/catalog/data/discipline-catalog-data.ts` | 2964 | 按学科/门类拆数据模块，保留 barrel |
| `src/pth/kernel/storage/knowledge-intake-pg.ts` | 1495 | N29 修复后按 repository 聚合拆小文件 |
| `src/pth/bootstrap/batch-process.ts` | 1254 | 按 worker 装配 / 服务编排 / 路由拆 |
| `packages/pth-memory/src/memory-store-pg.ts` | 1055 | 按 store 职责拆 repository/query/promotion |

1. 每个拆分保持对外 API 不变，先补/移测试。
2. 拆分后文件 ≤ 600 LOC 作为目标，但不强制；以可读性和测试覆盖为准。

### D5. 重复脚本最终形态

- 若 Phase A3 已发布共享脚本包，则此处只需确认两仓均使用共享包。
- 若 Phase A3 只加同步守卫，此处评估是否升级为共享包。

---

## Phase E：全量验收、文档与发布

### E1. 全量门禁

| 仓库 | 门禁 |
|---|---|
| deps | lint、build、vitest、docs links |
| pth | lint（含 import-cycles / boundaries）、build（含 Vite）、vitest 全量、docs links |
| ptl | lint、vitest 全量、docs links |

### E2. 文档回填

1. 更新 `docs/pth/modularity-reuse-implementation-plan.md` 状态表，标注后续计划入口。
2. 更新 `docs/pth/modularity-reuse-audit.md` 的遗留项状态。
3. 更新 `docs/fracta-engine-backlog.md`：把已完成的 A/B/C 项移入已完成区；N28/N29 状态写清。
4. 更新 N28/N29 报告与 acceptance envelope。

### E3. 发布

按实际 API 变化发布：

- `@away_from/shared`（若脚本/工具/常量有变化）
- `@away_from/infra`（若共享脚本/工具放入 infra）
- `@away_from/framework`（若 ptl version 统一）
- `@away_from/pth-memory` / `@away_from/pth-sandbox` / `@away_from/pth-console` / `@away_from/pth-cli`（若包内代码变化）
- 新增 `@away_from/repo-scripts`（若 A3 走发布脚本包路线）

发布顺序必须按依赖方向：`shared/infra` → 产品包 → `pth-cli`。

### E4. 提交

- 每阶段独立 commit，提交信息前缀 `feat/fix/refactor/docs`。
- 全部完成后三仓工作树 clean，推送到各自 `origin/main`。

---

## 风险与决策点汇总

| ID | 决策 | 推荐 |
|---|---|---|
| D-1 | 跨仓重复脚本：同步守卫 vs 发布脚本包 | 先同步守卫，后续再发布 |
| D-2 | N28 typecheck 范围：恢复 35 文件 vs 接受 C7 | 恢复原合同 35 文件 |
| D-3 | kernel 子包拆分：本计划实施 vs 仅评估 | 仅评估 + barrel 纪律 |
| D-4 | ptl version 对齐方向 | 以已发布 framework 版本为准统一 root |
| D-5 | N29 `full` attestation 形态 | **已选：由 CI/发布密钥签名的 acceptance envelope，启动时验签**（`sign-n29-acceptance.ts` + `PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PUBLIC_KEY_PATH`） |

## 非目标

- 不实现 N26 来源发现外环 / 自动扩源 / 生产 canary（除非 N29 G9 通过后单独批准）。
- 不启用 `PTH_KNOWLEDGE_INTAKE_MODE=draft|full`，除非 N29 重新验收通过。
- 不进入 N28 的持久化责任分配、自动重平衡、自动扩缩容。
- 不改变 PTL/PTH 产品边界。
- 不强制 kernel 子包拆分，除非 D-3 批准。
