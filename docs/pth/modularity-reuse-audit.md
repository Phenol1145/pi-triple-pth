# 模块化与代码复用率审计（v1.3.0 预发布）

- 扫描范围：`src/`、`scripts/`、8 个 `packages/*/src`、`deploy/docker-monitor/`、`test/`（排除 node_modules/dist/.worktrees）
- 规模：**803** 文件（生产 483 / 测试 320）
- 行数：生产 **93,777** LOC，测试 **58,886** LOC

## 1. 模块边界与 barrel 使用

| 指标 | 数值 |
|---|---|
| `src/pth` 相对导入总数 | 890 |
| 同域导入 | 463（52.0%） |
| 跨域经公共 barrel（index.ts） | 192（21.6%） |
| 跨域深路径私有导入 | 235（26.4%；**与 check-pth-boundaries 允许基线一致，无新增违规**） |

典型跨域深路径导入（多为 application → kernel/tasking/execution 的网关适配面）：

- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/kernel/assembly.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/kernel/execution/worker-cluster.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/kernel/storage/task-store-pg.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/tasking/task-control-service.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/tasking/task-queries.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/execution/knowledge-promotion.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/execution/knowledge-broker.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/execution/knowledge-verdicts.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/kernel/execution/optimizer-apply.js`
- `src/pth/application/gateway/pth-gateway-facade.ts` → `src/pth/tasking/penetration-discovery.js`

## 2. 循环依赖

- 检测到的强连通分量：**0**，文件 **0** 个（无循环依赖）。

## 3. 复用面（fan-in 最高的模块）

| 模块 | 被引用文件数 |
|---|---|
| `test/helpers.ts` | 24 |
| `src/pth/kernel/storage/pg.ts` | 8 |
| `src/pth/kernel/storage/schema.ts` | 7 |
| `deploy/docker-monitor/ui-state.js` | 4 |
| `src/pth/impls/roles/default-roles.ts` | 4 |
| `src/pth/kernel/assembly.ts` | 4 |
| `deploy/docker-monitor/server.js` | 4 |
| `src/pth/kernel/storage/index.ts` | 4 |
| `src/pth/impls/kernels/ts-interpreter.ts` | 3 |
| `deploy/docker-monitor/ring-buffer.js` | 3 |

命名的导出符号复用 Top 10（近似；vitest 与 node:os 属于框架性复用）：

- `describe`：314 个 importer
- `it`：313 个 importer
- `expect`：313 个 importer
- `beforeAll`：79 个 importer
- `afterAll`：76 个 importer
- `vi`：71 个 importer
- `beforeEach`：51 个 importer
- `tmpdir`：46 个 importer
- `createHash`：43 个 importer
- `join`：43 个 importer

## 4. 重复代码估算（8 行归一化窗口）

- 生产代码：重复块 372，估算重复行 8，估算重复率 **0.01%**，完全重复文件 5
- 测试代码：重复块 582，估算重复行 160，估算重复率 **0.27%**

生产重复 Top（可作为复用机会）：

- src/pth/execution/adapters/assembly-runtime-adapter.ts / src/pth/execution/adapters/computational-chemistry-adapter.ts / src/pth/execution/adapters/jupyter-runtime-adapter.ts — 片段: `const artifacts: ArtifactRef[] = [];`
- src/pth/execution/adapters/computational-chemistry-adapter.ts / src/pth/execution/adapters/jupyter-runtime-adapter.ts / src/pth/execution/adapters/lean4-runtime-adapter.ts — 片段: `let stdout = "";`
- src/pth/execution/adapters/computational-chemistry-adapter.ts / src/pth/execution/adapters/jupyter-runtime-adapter.ts / src/pth/execution/adapters/lean4-runtime-adapter.ts — 片段: `let stderr = "";`
- packages/framework/src/bridge/bench.ts / packages/framework/src/bridge/jobs.ts / packages/framework/src/bridge/kernel.ts — 片段: `function requireClient(): PthClient {`
- packages/framework/src/bridge/bench.ts / packages/framework/src/bridge/jobs.ts / packages/framework/src/bridge/kernel.ts — 片段: `const client = PthClient.fromConfig();`

测试重复 Top（可抽取共享 helper）：

- test/pth-composition/r6-acceptance.test.ts / test/pth-composition/work-mode-classification.test.ts / test/pth-execution/knowledge-broker.pg.test.ts — 片段: `async function hasDocker(): Promise<boolean> {`
- test/pth-composition/r6-acceptance.test.ts / test/pth-composition/work-mode-classification.test.ts / test/pth-execution/knowledge-broker.pg.test.ts — 片段: `if (process.env.PTH_TEST_NO_DOCKER === "1") return false;`
- test/pth-composition/r6-acceptance.test.ts / test/pth-composition/work-mode-classification.test.ts / test/pth-execution/knowledge-broker.pg.test.ts — 片段: `try {`
- test/pth-composition/r6-acceptance.test.ts / test/pth-execution/knowledge-broker.pg.test.ts / test/pth-execution/knowledge-verdicts.test.ts — 片段: `await getContainerRuntimeClient();`
- test/unit/agent-engine-recover.test.ts / test/unit/f-wp2-integration.test.ts / test/unit/f-wp3-integration.test.ts — 片段: `let redis: RedisType;`

## 5. 结论

1. **模块化健康**：生产代码无循环依赖；pth 跨域访问 192/235 走/未走 barrel 的比例处于基线内，且权威 lint（`check-pth-boundaries`）为 0 新增违规。
2. **复用健康**：生产重复率约 0.01%，主要重复来自四个 runtime adapter 的 exec 收尾样板（可抽共享 helper 但收益很小）。
3. **测试复用机会**：PG/docker 可用性守卫 `hasDocker` 在多个测试文件重复（Top 命中 18 次），可统一收敛到 `test/helpers.ts`，预期减少约 160 行重复。
4. 本审计为静态估算，不计注释与生成物，不替代边界 lint 与类型系统。