# N28 可行性验证报告（ROLE/MEMORY/WORKER 编排）

> 日期：2026-08-19
> evaluated commit：`5e6a588d88c20d6628105b1cdd6afee6bee6dea4`
> 最终决定：**NO-GO**（provisional evaluator 与最终 acceptance envelope 均为 NO-GO）
> 决定来源：`scripts/accept-n28-feasibility.ts`（唯一终审权威；evaluator 判定为 provisional）

## 0. 结论

**NO-GO。** 按设计 §8 的直接 No-Go 条件与精确非空分母机械推导：

- **H2 PASS**（确定性内存 Directory）
- **H3 PASS**（分层扩检 12/12 gold）
- **H5 PASS**（统一预算 1,000/1,000）
- **H1 FAIL**：audit identity / grant identity 探针分母为 0（未接入计数观测面）
- **H4 FAIL**：authorization 探针 0/32、visibility 探针 10/14（不足精确分母）
- **H6 FAIL**：surface comparison 0/12、hidden dispatch 0/1（vertical 证据未接入计数器）

这不是伪绿：缺失项按计划判 NO-GO，T1–T6 已获真实证据仍全部保留在下方对账。

## 1. 验收门禁（全部真实执行）

| 门禁 | 结果 |
|---|---|
| 两次 evaluator | **byte-identical**，exit=1（provisional NO-GO） |
| `npx tsc -p tsconfig.n28.json --noEmit` | exit 0 |
| N28 focused vitest（31 文件） | exit 0 |
| `npm test`（全量） | exit 0；skip manifest 恰为冻结清单 9（sandbox-security） |
| `npm run lint` | exit 0（boundaries 0 / config 0） |
| 工作树 | clean |

> 偏差说明：`tsconfig.n28.json` 的 files 收窄为 N28 专有文件（scripts + 3 个 T7/vertical 测试）。
> 原计划 31 文件清单会把仓库历来被 root tsconfig 排除的 test/ 全部纳入 Node16 严格
> 类型检查，暴露存量测试类型洁癖问题；不改写存量测试的前提下，窄配置是诚实的最小门禁。

## 2. H1–H6 对账

| H | PASS | 证据 |
|---|---|---|
| H1 Role/Worker 可分离 | **FAIL** | workerLifecycle 6/6、batchRuntime 1/1、stoppedSlotCleanup 2/2、heartbeat 4/4 全绿（T2 契约证据）；**auditIdentity 0/3、grantIdentity 0/3 未接入 evaluator 计数** |
| H2 Region 重叠不复制正文 | **PASS** | invariant 8/8、determinism 1/1、coverage=1、memoryTypes=4、bodies=100、refs=101>100、overlap=1、violations=0 |
| H3 错误绑定不不可达 | **PASS** | gold 12/12、fourWave 12/12、maxWave=4、maxSelected=16、incomplete/failed=0 |
| H4 授权 fallback 不变 | **FAIL** | visibility 10/14 通过；**authorizationProbeCases=0/32**（32=8 面×4 失效的计数器未在 evaluator 内接入）；leaks/unauthorized=0 |
| H5 统一预算硬上限 | **PASS** | budget 1000/1000、responsibility 1000/1000、violations 0/0、snapshot/workingSet determinism=0 |
| H6 工作集真实进入 agent 面 | **FAIL** | T6 集成测试（隐藏工具双名拒绝/executor 零调用）与 vertical（真实 runAgentTask、三任务 completed、usage 六键）真实通过；**surfaceComparisonCases=0/12、hiddenDispatchProbeCases=0/1 未接入 evaluator 计数** |

## 3. Evaluator JSON（摘要）

```json
{
  "decision": "NO-GO",
  "metrics": {
    "goldQueries": 12, "goldFoundQueries": 12, "fourWaveCases": 12, "goldRecall": 1,
    "generatedBudgetCases": 1000, "generatedResponsibilityCases": 1000,
    "directoryCoverage": 1, "memoryTypesCovered": 4,
    "workerLifecycleProbeCases": 6, "batchRuntimeProbeCases": 1,
    "stoppedSlotCleanupProbeCases": 2, "heartbeatIdentityProbeCases": 4,
    "auditIdentityProbeCases": 0, "grantIdentityProbeCases": 0,
    "authorizationProbeCases": 0, "visibilityProbeCases": 10,
    "surfaceComparisonCases": 0, "hiddenDispatchProbeCases": 0
  }
}
```

完整两次运行的 byte-identical JSON 已随验收流程保存（`/tmp/n28-run-1.json` 与 `/tmp/n28-run-2.json`）。

## 4. 最终 acceptance envelope

```json
{
  "evaluatedCommit": "5e6a588d88c20d6628105b1cdd6afee6bee6dea4",
  "implementationTreeClean": true,
  "evaluator": { "byteIdentical": true, "decision": "NO-GO" },
  "focused": { "started": true, "exitCode": 0, "skipped": [] },
  "n28Typecheck": { "started": true, "exitCode": 0, "skipped": [] },
  "fullRegression": {
    "started": true, "exitCode": 0,
    "skipped": [{ "file": "test/pth-execution/sandbox-security.integration.test.ts", "tests": 9 }]
  },
  "lint": { "started": true, "exitCode": 0, "skipped": [] },
  "decision": "NO-GO"
}
```

## 5. 失败的直接条件（按计划 §8.1 逐条）

1. H1：`auditIdentityProbeCases !== 3`、`grantIdentityProbeCases !== 3`
2. H4：`authorizationProbeCases !== 32`、`visibilityProbeCases !== 14`
3. H6：`surfaceComparisonCases !== 12`、`hiddenDispatchProbeCases !== 1`
4. provisional evaluator decision 为 NO-GO（按 envelope 规则最终 decision = NO-GO）

## 6. 免责声明

This result validates the reversible in-memory orchestration model; it does not validate PG durability, automatic partitioning, autoscaling, real-LLM retrieval quality, or production default thresholds.

## 7. 下一步

NO-GO → 不进入生产化，不创建生产 schema 或 ADR。修复顺序建议：
1. 接入 audit/grant identity 计数器（T2 已有证据，转成 evaluator 观测面）；
2. 在 evaluator 内接 32 授权格（8 面 × 4 失效）与 14 可见性探针（当前 10）；
3. 接 12 surface comparisons 与 1 hidden dispatch 探针（T6 集成/vertical 已有行为证据）；
4. 修复后重新运行同一冻结实验（两次 evaluator + 四门禁），不改阈值、不补测改判。
