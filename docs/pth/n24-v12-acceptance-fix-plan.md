# N24：v1.2 验收阻塞修复计划（Gate A/B/C）

> 输入：`docs/pth/v1.2-acceptance-evaluation-report.md`（AB-01…AB-08 + 6.1–6.7）。
> 目标：修复报告中全部已知阻塞与高优先级缺口；每车道全量 vitest + lint 绿后合并。
> 车道顺序依赖同文件域，按下表串行；每个 lane 先写分契约再实现。

| Lane | 阻塞项 | 主要文件域 | 合并序 |
|---|---|---|---|
| **F1** | AB-02 canonical provenance；AB-03 capability 合并；6.3 update revision / promotion 幂等重放 | `packages/pth-memory/*`、`runner/agent-task-runner.ts`、`impls/kernels/capability.ts`、`scripts/seed-k5-pilot.ts` | 1 |
| **F2** | AB-01 复合租户身份 + TenantScope fail-closed + bridge/broker raw query 门禁 | `packages/pth-memory/schema|store`、`execution/knowledge-broker`、`gateway/facade`、全部内部调用点 | 2 |
| **F3** | AB-04 verifier/promoter 身份与 RBAC；AB-05 delegate Domain envelope | `contracts/tasking`、`tasking/task-control-service`、`bootstrap/task-loop`、`gateway/routes-kernel`、`facade`、`knowledge-verdicts/promotion` | 3 |
| **F4** | AB-06/07/08 + 6.4/6.5/6.6 重建可信评测 | `catalog/*`、`scripts/build-discipline-catalog`、`pilot-evaluator`、`eval-k5-pilot`、数据文件 | 4 |
| **F5** | 6.1 outbox、6.2 candidate lineage、6.7 audit observer | `kernel/storage/schema`、`tasking/task-outcome-observers`、`bootstrap/task-loop`、`refiner` | 5 |

最终完成标准：
- 报告的 Gate A/B/C 关闭条件全部有代码 + 真实 PG/组合回归测试；
- 全量 vitest + lint 绿；K5 评测在生产路径上达到或诚实标注未达阈值；
- 账本恢复为按证据状态，不以测试绿替代生产验收。
