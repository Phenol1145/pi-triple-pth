# N28 可行性再次验收反馈报告（Role / Memory / Worker 编排）

> - 日期：2026-08-19
> - 复验对象：`main@4def65b9a4bcc79310deb2717a888cd946fee160`
> - 取证基线工作树：clean（本报告落盘前）
> - 设计：[n28-role-memory-orchestration-design.md](../design/n28-role-memory-orchestration-design.md)
> - 实施计划：[n28-role-memory-orchestration-implementation-plan.md](../plan/n28-role-memory-orchestration-implementation-plan.md)
> - 自动报告：[n28-feasibility-report.md](./n28-feasibility-report.md)
> - 上轮复核：[n28-feasibility-acceptance-review.md](./n28-feasibility-acceptance-review.md)

## 1. 结论

**独立复验结论：NOT ACCEPTED / NO-GO。**

当前自动 acceptance driver 在允许本地 IPC、PostgreSQL 与 Redis 的环境中返回 **GO**，但本轮独立复验
发现两项可直接破坏 N28 核心可行性假设的运行时反例，以及多项会让 evaluator 假绿的证据缺口：

1. 生产 batch 创建的 Worker UUID 与 Memory Directory 中的责任主体 UUID 不一致，primary / overlap
   责任区实际失效；
2. 同一 memory ID 的重复返回行可以绕过单 Worker 的条目数和字符数预算；
3. H2 的扫描结果在汇总时被常量 `0` 覆盖；H1/H4/H5/H6 的部分分母不是完整公共探针；
4. Task 7 冻结的六条 sabotage 路径没有实现，无法证明观察器能发现真实组件缺陷；
5. 被自动报告绑定的 evaluated commit 尚未满足当时有效的类型检查合同，C7 是事后加入的收窄裁决。

因此，自动 GO 只能证明当前绿色门禁和 evaluator 的现有判定逻辑自洽，不能证明“责任区正确分摊、统一
认知预算不可绕过、H1–H6 观察器完整”已经成立。不得据此进入持久化责任分配、自动重平衡或自动扩缩容。

## 2. 新鲜门禁证据

以下结果均在当前 `HEAD`、clean worktree 上重新执行：

| 门禁 | 结果 | 说明 |
|---|---|---|
| evaluator 连跑两次 | **GO / GO，byte-identical** | 证明输出确定，但不消除下文的假绿问题 |
| N28 focused | **31 files，exit 0，skips=[]** | 局部契约与回归通过 |
| `npx tsc -p tsconfig.n28.json --noEmit` | **exit 0** | 当前 C7 口径只覆盖 4 scripts + 3 tests，共 7 文件 |
| `npm test` | **exit 0** | skip manifest 为冻结的 `sandbox-security` 9 项 |
| `npm run lint` | **exit 0** | tsc、PTH boundaries、PTH config 均通过 |
| authority driver | **GO，exit 0** | evaluated commit 为当前 `4def65b...` |

本报告不否认这些门禁结果。结论差异来自门禁没有观测到下述运行时反例，且 evaluator 的部分指标可以
在真实探针缺失时保持绿色。

下文两个运行时 JSON 反例来自不写仓库文件的 TSX 探针，输入和输出已在本报告中逐项列明；它们尚未成为
持久化回归测试或 acceptance artifact。因此本报告将其作为独立反证，重新验收时必须先把同等反例固化为
红→绿测试，不能继续依赖临时探针。

## 3. P0 阻断问题

### P0-1：生产 Worker 身份与 Memory Directory 责任主体不一致

生产 feasibility batch 在
[batch-process.ts](../../../src/pth/bootstrap/batch-process.ts) `:857-861` 中只向
`assembleBatchRuntime()` 传入 `{ role }`，没有传 Directory 中的 `requestedReplica`。默认 replica factory
因此生成随机 Worker UUID。另一方面，CLI 在同文件 `:941-959` 先从 JSON 构建含固定 Worker UUID 的
Memory Directory。

分层检索在
[layered-knowledge-retriever.ts](../../../src/pth/execution/layered-knowledge-retriever.ts) `:95-109`
按精确 `workerId` 查找 primary / overlap / fallback responsibilities。当前运行时 Worker 不在 Directory 时，
前两波没有责任区，只剩 `region:unclassified` 和最终 global wave。

本轮只读运行时探针：

```json
{
  "directoryWorker": "10000000-0000-4000-8000-000000000011",
  "runtimeWorker": "12fd026b-c443-43d9-a4b0-e1421d9bf479",
  "matches": false
}
```

现有 evaluator 在 lifecycle probe 中显式传入 `requestedReplica`，因此不会发现生产 batch 的身份错配。
该缺陷直接破坏 Worker→Memory Responsibility 的生产组合，并使 H3 的责任区检索退化为全局兜底；
H1 的独立寻址/控制命题则因探针不完整而保持 INCONCLUSIVE。

### P0-2：重复 ID 可绕过统一认知预算

[cognitive-budget.ts](../../../packages/pth-kernel-execution/src/execution/cognitive-budget.ts) `:63-72` 在一次 admission
中按 ID 去重，第二个相同 ID 会被跳过。随后
[cognitive-working-set.ts](../../../src/pth/runner/cognitive-working-set.ts) `:73-77` 把 accepted ID
转换为 `Set`，并返回所有命中该 ID 的原始 rows。

因此，只要 backing query 返回相同 ID 的多行，账本只计第一行，facade 却暴露全部正文。最小复现使用
`maxMemoryEntries=1`、`maxMemoryChars=100`：

```json
{
  "returned": 2,
  "returnedChars": 1001,
  "usage": {
    "memoryEntries": 1,
    "memoryChars": 27
  },
  "omitted": {}
}
```

本轮修复已经解决“不同 ID 的 state rows 被 omitted 后仍返回”的旧问题，但没有覆盖重复 ID 的
memory.retrieve / memory.query / state rows。H5 的“单 Worker 可检索记忆范围具有稳定硬上限”仍不成立。

### P0-3：H2 的真实扫描结果被常量覆盖

[eval-n28-feasibility.ts](../../../scripts/eval-n28-feasibility.ts) `:332-370` 会计算 ownerless Region
和 projection 中的正文复制数；但 `evaluateN28Feasibility()` 在 `:905-917` 展开 `...gold` 后再次写入：

```ts
bodyCopiesOutsideCanonicalStore: 0,
ownerlessRegions: 0,
```

这使扫描结果永远无法进入最终判定。扫描本身也没有包含实施计划冻结的：

- canonical `Map<tenantId|entryId, body>` 的 composite-ID 重复检测；
- Working Set snapshot projection roots；
- Directory membership、Responsibility、Working Set 三种正文注入 detector。

因此自动报告中“ownerless/bodyCopies 真实扫描=0”的表述不成立，H2 不能验收为 PASS。

### P0-4：六条 sabotage 路径没有实现

[n28-task7-contract.md](../contract/n28-task7-contract.md) `:52-53, 70, 178-179` 冻结了六条真实组件
sabotage 及其 sentinel：

| Sabotage | 应失败假设 | Sentinel |
|---|---|---|
| `control-target-swap` | H1 | `sameRoleReplicaControlFailures` |
| `directory-body-copy` | H2 | `bodyCopiesOutsideCanonicalStore` |
| `remove-global-wave` | H3 | `missingFourWaveCases` |
| `scope-guard-bypass` | H4 | `unauthorizedReadPortInvocations` |
| `budget-wrapper-bypass` | H5 | `budgetViolations` |
| `tool-dispatch-guard-bypass` | H6 | `hiddenExecutorInvocations` |

这些名称在当前 harness、evaluator 和测试中均没有实现。
[n28-feasibility-evaluator.test.ts](../../../test/pth-runner/n28-feasibility-evaluator.test.ts) `:29-73`
只有三个测试，验证手工改坏 metrics 会得到 NO-GO，但没有验证生产观察器能发现对应缺陷。

这不是测试数量问题，而是 detector sensitivity 未被证明。当前 evaluator 即使遇到预算 wrapper、责任区、
授权或工具分发的真实回归，也可能继续输出 GO。

### P0-5：验收条件在 evaluated commit 之后被收窄

实施计划
[n28-role-memory-orchestration-implementation-plan.md](../plan/n28-role-memory-orchestration-implementation-plan.md)
`:2723-2786` 要求 `tsconfig.n28.json` 覆盖 4 个 scripts 和 31 个 focused tests，共 35 文件。

自动报告绑定的 evaluated commit `62bb8b22...` 中：

- 当时有效的 Task 7 合同仍要求文件清单与计划逐字一致；
- 实际 `tsconfig.n28.json` 已只有 7 个文件；
- C7 收窄裁决与 GO 报告直到后续 `4def65b...` 才在同一提交中加入。

当前 C7 下，7 文件 typecheck 是自洽的；但它不能回溯修复 `62bb8b22...` 的验收证据，也不符合本轮沿用
“验收条件不变”的口径。若确需收窄，应在重新评估前由人类明确批准，并生成绑定新合同版本的 envelope。

## 4. P1 高优先级问题

### P1-1：H1、H4、H5、H6 的分母含非真实或不完整观察

- H1：`probeLifecycle()` 没有执行 pause / resume，却直接返回 `workerLifecycleProbeCases=6`；heartbeat
  直接增加 4，只检查 envelope shape，没有逐个验证 Worker identity；
- H4：invalid-signature 与 already-expired 多数只在 scope factory 层重复执行，没有穿过 8 个 read
  surface；14 个 visibility cases 只对四个 `trap-*` 统计泄漏，没有断言三个 `probe-*` 的允许结果，
  “拒绝全部内容”也可能 PASS；
- H5：1000 cases 只直接调用 `CognitiveBudgetLedger`，不经过 capability facade；
  `workingSetMismatches` 初始化为 0 后未更新，两次输入也不是独立反序 working set；
- H6：12 项检查证明了真实 AgentTaskRunner 可运行和隐藏 executor 未调用，但没有把 final Working Set
  的 Tool、Skill、Memory ID 集合与 LLM schema、prompt 和 facade 暴露面做精确相等比较。

这些正向探针有局部价值，但不能作为完整 H1/H4/H5/H6 关闭证据。

### P1-2：Worker 控制端口会把 unknown 回执当成功

[batch-manager.ts](../../../packages/pth-kernel-execution/src/execution/batch-manager.ts) `:143-150` 在接收 replica 回执时
丢弃 `accepted` 字段；`:278-283` 对 pause / resume 只判断 `state !== "error"`。子进程返回
`state="unknown", accepted=false` 时，主进程仍解析为成功。

只读探针复现 unknown Worker 的结果为：

```json
{
  "pause": true,
  "resume": true
}
```

unknown remove 在超时后还会在 `pendingRemovalCtl` 保留 waiter key，可能形成长期积累。

### P1-3：Production wave trace 的 candidate / visible 语义不诚实

[batch-process.ts](../../../src/pth/bootstrap/batch-process.ts) `:251-269` 先进行 tenant/status/space
授权过滤，再构造 `inWave`，随后把 `candidateCount` 和 `visibleCount` 都写成 `inWave.length`。

Task 4 合同要求 candidate 是授权前候选范围，visible 是授权后、query/rank/limit 前的数量。当前 trace
不能显示授权过滤了多少条，无法支持 H4 的 `visible < candidate` 陷阱观测。

### P1-4：Acceptance driver 的 mixed-gate 判定优先级仍不正确

[accept-n28-feasibility.ts](../../../scripts/accept-n28-feasibility.ts) `:187-205` 先判断是否有 unavailable /
not-started gate；只要存在，就直接返回 `EVALUATION-INCOMPLETE`，不会优先处理其他已启动 gate 的非零退出。

本轮沙箱内首次运行实际出现 `fullRegression=unavailable`、`lint=started/exit 1`，最终被标记为
`EVALUATION-INCOMPLETE`。在允许 IPC 的环境重跑后四门禁均通过并得到 GO，因此这不是当前 lint 失败，
而是 driver 仍违反“任何 started gate 非零永远 NO-GO”的合同。

另外，Redis preflight 虽执行，但 `:160-163` 没有任何 gate 消费其结果；sandbox preflight 在 `:107`
直接固定为 `ok=true`。所以 envelope 不能据此证明 Redis 或 sandbox 环境实际可用。

## 5. H1–H6 独立复核矩阵

| 假设 | 自动结果 | 独立复核 | 说明 |
|---|---|---|---|
| **H1 Role / Worker 分离** | PASS | **INCONCLUSIVE** | workerId 端口已存在；但 lifecycle 分母不含 pause/resume、heartbeat identity 不完整，unknown 控制误报成功。 |
| **H2 重叠责任区不复制正文** | PASS | **INCONCLUSIVE** | Directory 模型和局部测试存在，但扫描结果被常量覆盖，缺三类正文复制 detector。 |
| **H3 错误绑定不导致不可达** | PASS | **FAIL（生产组合）** | layered retriever 正例 12/12 可达；生产 Worker/Directory 身份错配使责任区退化到 global。 |
| **H4 fallback 不改变授权** | PASS | **INCONCLUSIVE** | 授权组件有正向基础，但 32+14 不是完整 surface × 预期矩阵，scope sabotage 缺失。 |
| **H5 统一预算硬上限** | PASS | **FAIL** | 不同 ID 的 state 过滤已修；重复 ID 仍可暴露多份正文且只计一次。 |
| **H6 Working Set 进入 agent 面** | PASS | **PARTIAL** | 真实 agent 与 hidden-dispatch 正向探针有效；缺精确 surface equality 和 guard-bypass sabotage。 |

H3 与 H5 已存在运行时反例；任一项失败都足以让整体决定为 NO-GO。

## 6. 已确认的正向修复

以下成果可以保留，不需要推倒重来：

- `state.recallFunctions` / `state.recallInsights` 已只返回不同 ID 中 ledger accepted 的 rows；
- Knowledge Context layered 分支已复用注入的同一 `layeredSearchWave`；
- workerId route → facade → BatchManager 的副本控制端口已接通；
- busy remove 等待最终 `worker-removed`，role remove 已有聚合最终回执；
- feasibility 子 agent 的 grant / activity 已传播真实父 Worker UUID；
- focused、full regression、lint 和当前 7 文件 typecheck 均已通过；
- H3 的 layered retriever 12 条冻结正例与 H6 的真实 AgentTaskRunner hidden-dispatch 探针具有局部有效证据。

这些修复说明总体方向仍可行，但不能抵消 P0 阻断。

## 7. 建议修复顺序

### 第一层：恢复核心可行性不变量

1. 生产 `workerSpecs` 必须使用 Directory 中的 exact `WorkerReplicaRef`；启动时拒绝 unknown / unowned
   Worker，而不是静默退化到 global；
2. admission 返回逐行 token 或 accepted index，禁止用 ID Set 反向放行重复 rows；或者在所有 backing
   read port 强制唯一 ID 并在 facade 再次验证；
3. 增加 memory.retrieve、memory.query、state recall 的重复 ID、summary→full expansion、条目数和字符数
   红→绿回归；
4. 用真实 production batch 路径验证 primary、overlap、fallback、global 四波的 expected wave。

### 第二层：修复 evaluator 与观察器

1. 删除 H2 汇总常量覆盖，建立 canonical body map，并扫描 Directory / Responsibility / WorkingSet；
2. 实现合同冻结的六条 sabotage，只允许通过共享 harness 改变输入、依赖或动作；
3. lifecycle、authorization、visibility、working-set、surface 分母只在对应公共探针完成并断言预期后递增；
4. evaluator 只调用共享 production harness，不内联另一套 ranking、visibility、budget 或 tool filtering；
5. H6 对 final Working Set 与 schema、prompt、Skill/Memory facade 做 exact-set equality。

### 第三层：收紧控制、trace 与最终门禁

1. BatchManager 保留并验证 `accepted`，unknown Worker 的 pause/resume/remove 必须返回 false；超时清理 waiter；
2. wave port 分别记录授权前 candidate、授权后 visible、limit 后 selected 与真实 scanned；
3. acceptance driver 先处理所有 started gate 的失败，再判断环境是否使剩余 gate 无法启动；
4. 恢复原 35 文件 typecheck，或由人类在评估前明确批准新的范围并重建合同版本；
5. 在同一 clean commit 上重跑 evaluator、focused、typecheck、full regression、lint，并保存完整 envelope。

## 8. 重新验收条件

重新验收必须同时满足：

1. runtime Worker UUID 与 Directory responsibilities 完全一致，unknown Worker 启动即失败；
2. 重复 ID 探针中，实际返回集合的条目数和字符数不超过账本，且 omitted 内容不可见；
3. H2 不再被常量覆盖，三类正文复制 detector 均能使 H2 失败；
4. 六条 sabotage 均使唯一对应假设失败，sentinel 严格高于 baseline；
5. H4 完成 8 surfaces × 4 invalid conditions 与 7 rows × 2 ports 的完整 allow/deny 矩阵；
6. H6 完成 final Working Set 与实际 Agent surface 的精确对账；
7. focused、合同一致的 typecheck、full regression、lint 均通过，且任何 started gate 失败优先判 NO-GO；
8. 新报告绑定同时包含实现、合同和验收驱动的 evaluated commit，工作树 clean，证据可追溯。

在这些条件全部满足前：

- 自动 acceptance driver 的当前状态可以记录为 **GO**；
- 本报告的独立符合性处置保持 **NOT ACCEPTED / NO-GO**；
- 不进入持久化责任分配、自动重平衡、自动扩缩容或默认开启阶段。
