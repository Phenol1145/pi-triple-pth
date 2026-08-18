# N28 可行性验证报告（ROLE/MEMORY/WORKER 编排）——修复后权威版

> 日期：2026-08-19
> evaluated commit：`62bb8b22a566decdadd63b9ed31705501b429c8d`
> 最终决定：**GO**（provisional evaluator 与 acceptance envelope 均为 GO）
> 决定来源：`scripts/accept-n28-feasibility.ts`（唯一终审权威）

## 0. 结论

**GO。** H1–H6 全部非空分母且全部 PASS；两次 evaluator byte-identical；四道门禁全绿。
GO 只授权编写生产化实施计划（persistent lease/Region 表/outbox 投影/权重校准/重平衡），
不授权数据库迁移、自动扩缩容或默认开启。

## 1. 验收门禁（clean worktree 上真实执行）

| 门禁 | 结果 |
|---|---|
| 两次 evaluator | byte-identical，exit 0（provisional GO） |
| `npx tsc -p tsconfig.n28.json --noEmit` | exit 0 |
| N28 focused 31 文件 | exit 0，skips=[] |
| `npm test` | exit 0，skip manifest = 冻结清单 9（sandbox-security） |
| `npm run lint` | exit 0（boundaries 0 / config 0） |

## 2. H1–H6 对账（全部 PASS）

| H | 证据（非空分母） |
|---|---|
| H1 | workerLifecycle 6/6、batchRuntime 1/1、stoppedSlotCleanup 2/2、heartbeat 4/4、auditIdentity 3/3、grantIdentity 3/3；failures 全 0 |
| H2 | invariant 8/8、determinism 1/1、coverage=1、memoryTypes=4、bodies=100、refs=101>100、overlap=1、ownerless/bodyCopies 真实扫描=0 |
| H3 | gold 12/12、fourWave 12/12、maxWave=4、maxSelected=16、incomplete/failed=0 |
| H4 | authorization 32/32（8 面×4 失效）、visibility 14/14、leaks=0、unauthorizedWave=0、unauthorizedRead=0 |
| H5 | budget 1000/1000、responsibility 1000/1000、violations 0、determinism 0 |
| H6 | surfaceComparison 12/12、hiddenDispatch 1/1、mismatches=0、hiddenExecutor=0 |

## 3. Evaluator JSON（摘要）

```json
{
  "decision": "GO",
  "hypotheses": { "H1": { "passed": true }, "H2": { "passed": true }, "H3": { "passed": true },
    "H4": { "passed": true }, "H5": { "passed": true }, "H6": { "passed": true } },
  "metrics": {
    "goldQueries": 12, "goldFoundQueries": 12, "fourWaveCases": 12, "goldRecall": 1,
    "authorizationProbeCases": 32, "visibilityProbeCases": 14,
    "generatedBudgetCases": 1000, "generatedResponsibilityCases": 1000,
    "workerLifecycleProbeCases": 6, "auditIdentityProbeCases": 3, "grantIdentityProbeCases": 3,
    "surfaceComparisonCases": 12, "hiddenDispatchProbeCases": 1
  }
}
```

## 4. 最终 acceptance envelope

```json
{
  "evaluatedCommit": "62bb8b22a566decdadd63b9ed31705501b429c8d",
  "implementationTreeClean": true,
  "evaluator": { "byteIdentical": true, "decision": "GO" },
  "focused": { "started": true, "exitCode": 0, "skipped": [] },
  "n28Typecheck": { "started": true, "exitCode": 0, "skipped": [] },
  "fullRegression": {
    "started": true, "exitCode": 0,
    "skipped": [{ "file": "test/pth-execution/sandbox-security.integration.test.ts", "tests": 9 }]
  },
  "lint": { "started": true, "exitCode": 0, "skipped": [] },
  "decision": "GO", "reasons": []
}
```

## 5. 修复轮对照（复核报告 §8 四层）

- Layer 1：P0-1 state recall 只返回 ledger accepted（红→绿）；P1-1 Context 复用同一 wave port。
- Layer 2：P0-2 生产 batch feasibility 组合路径（Directory+retriever+wavePort+自建 factories+CLI JSON）。
- Layer 3：P1-2 workerId 生产 API/role 最终回执；P1-3 child-agent 真实 worker UUID。
- Layer 4：P1-4 driver 门禁语义/跳过清单/输出留档；P0-3 全部探针真实化；P1-5 类型门禁按裁决 C7 正式收窄并修订契约。

## 6. 免责声明

This result validates the reversible in-memory orchestration model; it does not validate PG durability, automatic partitioning, autoscaling, real-LLM retrieval quality, or production default thresholds.

## 7. 下一步（仅规划输入，不在本计划实施）

1. persistent WorkerReplica lease identity；
2. Region/Responsibility revision 表与 CAS 模型；
3. membership 投影 transactional outbox；
4. real-corpus 权重校准（索引字节/延迟/摄入速率）；
5. make-before-break Region 重平衡与副本扩缩容。
