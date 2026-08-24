# N28 可行性验证报告（ROLE/MEMORY/WORKER 编排）——Phase B 重新验收后权威版

> 日期：2026-08-22
> evaluated commit：`d4f363dc69b15a9811e214b106e44f27ad45389a`
> 最终决定：**GO**（provisional evaluator 与 acceptance envelope 均为 GO）
> 决定来源：`scripts/accept-n28-feasibility.ts`（唯一终审权威）
> 完整权威 envelope：`docs/pth/n28-feasibility-envelope.json`

## 0. 结论

**GO。** H1–H6 全部非空分母且全部 PASS；两次 evaluator byte-identical；focused 31 文件
zero-skip、**35 文件 typecheck**（4 scripts + 31 focused tests）、full regression（冻结 58 skip）、
lint 四道门禁全绿。合同 disposition 为人工批准的 Task 7 合同 **v1.2**（恢复 35 文件 typecheck）。

GO 只授权编写生产化实施计划（persistent lease/Region 表/outbox 投影/权重校准/重平衡），
不授权数据库迁移、自动扩缩容或默认开启。

## 1. 验收门禁（clean worktree 上真实执行，同 commit `d4f363d`）

> **Phase E 复核（2026-08-23）**：官方 GO envelope 仍绑定 `d4f363d`（Phase B 验收 commit）。
> Phase C/D 为结构重构（kernel 子包拆分、大文件拆分、barrel 纪律），未改变 N28 合同语义；
> 当前 HEAD `f9b7afa` 全量门禁再次通过：lint（含 import-cycles/boundaries）exit 0、build exit 0、
> `npm test` 297 files / 2619 passed / 58 frozen skipped / 0 failed。若后续需要把 full/intake 或
> N28 生产化 gate 绑定到新 commit，应重新运行 `scripts/accept-n28-feasibility.ts` 生成新 envelope。

| 门禁 | 结果 |
|---|---|
| 两次 evaluator | byte-identical，provisional GO |
| 六条 sabotage 敏感度 | 每条 NO-GO 且只翻转其映射 H，sentinel > baseline（见 §3） |
| `npx tsc -p tsconfig.n28.json --noEmit` | exit 0（合同 v1.2：4 scripts + 31 focused tests） |
| N28 focused 31 文件 | exit 0，skips=[] |
| `npm test` | exit 0，skip manifest = 冻结清单 58（sandbox-security + 4 个 professional integration） |
| `npm run lint` | exit 0（boundaries 0 / config 0） |

## 2. H1–H6 对账（全部 PASS）

| H | 证据（非空分母） |
|---|---|
| H1 | workerLifecycle 6/6（busy remove / no-preclaim / peer continues / pause / resume / idle remove）、batchRuntime 1/1、cleanup 2/2、heartbeat 4/4（逐 replica/task identity）、audit 3/3、grant 3/3；failures 全 0 |
| H2 | invariant 8/8、determinism 1/1、coverage=1、memoryTypes=4、bodies=100、refs=101>100、overlap=1、ownerless/bodyCopies 由真实扫描得出=0 |
| H3 | gold 12/12、fourWave 12/12、maxWave=4、maxSelected=16、incomplete/failed=0 |
| H4 | authorization 32/32（8 面 × 4 失效，全部穿过同一 surface 入口）、visibility 14/14（7 行 × Broker/Context，allow/deny 双向断言）、leaks=0、unauthorizedWave=0、unauthorizedRead=0 |
| H5 | budget 1000/1000（全部经 `createBudgetedTaskCapabilities` facade）、responsibility 1000/1000、violations 0、workingSet 反序输入 determinism 0（freezeSkillIndex 已改为字典序冻结） |
| H6 | surfaceComparison 12/12（含 final Working Set 与最后一回合 LLM tools 面、prompt Knowledge Context 行、Skill facade 的精确集合相等）、hiddenDispatch 1/1、hiddenExecutor=0 |

## 3. 六条 sabotage 对账（P0-4）

| Sabotage | 翻转假设 | Sentinel |
|---|---|---|
| `control-target-swap` | H1 | `sameRoleReplicaControlFailures` > 0 |
| `directory-body-copy` | H2 | `bodyCopiesOutsideCanonicalStore` > 0 |
| `remove-global-wave` | H3 | `missingFourWaveCases` > 0 |
| `scope-guard-bypass` | H4 | `unauthorizedReadPortInvocations` > 0 |
| `budget-wrapper-bypass` | H5 | `budgetViolations` > 0 |
| `tool-dispatch-guard-bypass` | H6 | `hiddenExecutorInvocations` > 0 |

敏感度测试 `test/pth-runner/n28-feasibility-evaluator.test.ts` 逐条断言：decision=NO-GO、
映射假设 FAIL、其余五条假设保持 PASS。sabotage 只改变共享 harness 输入/依赖/动作，不直写 metric。

## 4. 复验阻断项修复对照（Phase B）

| 阻断项 | 修复 | 落点 |
|---|---|---|
| P0-1 身份对齐 | batch feasibility 从 `deps.memoryDirectory.workers` 派生 workerSpecs（`requestedReplica` + `roleDefinitionRevision`），unknown worker 抛错 | `batch-process.ts` |
| P0-2 重复 ID 硬限 | state recall/memory retrieve/query 逐行 `#rowN` token 计费并按 token 过滤，omitted 不可见；新增重复 ID 多行回归 | `cognitive-working-set.ts`、`cognitive-working-set.test.ts` |
| P0-3 扫描常量 | 删除 H2 常量覆盖；ownerless 与 Directory/Responsibility/Working Set projection 正文复制由真实扫描得出 | `eval-n28-feasibility.ts` |
| P0-4 六 sabotage | 六条冻结哨兵全部实现 + 敏感度测试 | `eval-n28-feasibility.ts`、evaluator test |
| P0-5 合同收窄 | Task 7 合同 **v1.2** 人工批准修订（用户选择恢复 35 文件 typecheck）；envelope 绑定 `contractDisposition` 并纳入终审校验 | `n28-task7-contract.md` §12、`accept-n28-feasibility.ts` |
| P1-1 分母真实化 | pause/resume、逐 worker heartbeat、四类失效穿 8 surface、visibility allow/deny 双向、H5 facade 反序、H6 精确集合相等；`freezeSkillIndex` 顺序确定性缺陷根修 | `eval-n28-feasibility.ts`、`cognitive-budget.ts` |
| P1-2 unknown 回执/waiter | `accepted` 字段 + unknown/false/error 判失败（含 removal 失败回执），超时清理 waiter；新增 unknown 负测 | `batch-manager.ts`、`batch-manager.test.ts` |
| P1-3 trace 三态 | `candidateCount=all`、`visibleCount=inWave`、`scannedCount=all` 分列；新增 candidate>=visible>=selected 断言 | `batch-process.ts`、`layered-knowledge-retriever.test.ts` |
| P1-4 混合门禁优先 | started 非零先判 NO-GO，再判 EVALUATION-INCOMPLETE；Redis preflight 被门禁消费 | `accept-n28-feasibility.ts` |

## 5. 最终 acceptance envelope（摘要；完整 JSON 见同目录 envelope 文件）

```json
{
  "evaluatedCommit": "d4f363dc69b15a9811e214b106e44f27ad45389a",
  "implementationTreeClean": true,
  "contractDisposition": {
    "version": "v1.2",
    "approved": true,
    "approvalSource": "user-selected-option-in-reacceptance-session",
    "amendmentDoc": "docs/pth/contract/n28-task7-contract.md",
    "amendmentClause": "## 12. 人工批准修订 v1.2（恢复 35 文件 typecheck）",
    "typecheckScope": "tsconfig.n28.json (4 scripts + 31 focused tests)"
  },
  "evaluator": { "byteIdentical": true, "first": "GO", "second": "GO" },
  "focused": { "started": true, "exitCode": 0, "skipped": [] },
  "n28Typecheck": { "started": true, "exitCode": 0, "skipped": [] },
  "fullRegression": {
    "started": true, "exitCode": 0,
    "skipped": [
      { "file": "test/pth-execution/sandbox-security.integration.test.ts", "tests": 9 },
      { "file": "test/pth-professional/assembly-engineer.integration.test.ts", "tests": 14 },
      { "file": "test/pth-professional/computational-chemist.integration.test.ts", "tests": 5 },
      { "file": "test/pth-professional/lean4-prover.integration.test.ts", "tests": 13 },
      { "file": "test/pth-professional/technical-educator.integration.test.ts", "tests": 17 }
    ]
  },
  "lint": { "started": true, "exitCode": 0, "skipped": [] },
  "decision": "GO", "reasons": []
}
```

## 6. 免责声明

This result validates the reversible in-memory orchestration model; it does not validate PG durability, automatic partitioning, autoscaling, real-LLM retrieval quality, or production default thresholds.
