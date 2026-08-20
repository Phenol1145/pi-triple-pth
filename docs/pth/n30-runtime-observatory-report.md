# N30 运行观测台验收报告（NO-GO）

- **evaluatedCommit**: `e75df7f428478c727471c25723470037417932f6`（main，验收开始时 `git status --porcelain` 为空）
- **验收日期**: 2026-08-20
- **决策**: **NO-GO**（见 §7；accept driver 崩溃未产出 envelope，决策由各已启动门的确定性失败直接推定）
- **环境**: Docker 29.4.0（Testcontainers PostgreSQL 可用）；`PI_PLATFORM_PROVIDER=deepseek PI_PLATFORM_MODEL=deepseek-v4-flash`；全量/focused 均带 `--hookTimeout 60000`

## 1. Eval 双跑（字节一致性）

| 项 | 结果 |
|---|---|
| 命令 | `node --import tsx scripts/eval-n30-runtime-observatory.ts`（脚本无 `--output` 参数，stdout 重定向至 `/tmp/n30-eval-1.json` / `/tmp/n30-eval-2.json`） |
| 两次 exit | 0 / 0 |
| `cmp` 字节比较 | **一致（BYTE-IDENTICAL）** |
| decision | **PASS** |
| totals | 13 个 probe 文件（glob 实测展开），104 tests，104 passed，0 failed，0 skipped |
| 门禁 | 39 条全部 ok（含 6 个 probe.file、19 条 required probes、ledger/latency/write-calls） |

## 2. Focused 套件

命令：`npx vitest run test/unit/docker-monitor-*.test.ts test/pth-contracts/runtime-observation.test.ts test/pth-application/runtime-observation-facade.pg.test.ts test/pth-composition/runtime-observatory.integration.test.ts test/pth-composition/runtime-observatory-long-run.test.ts test/browser/runtime-observatory.test.ts --hookTimeout 60000 --testTimeout 120000 --reporter=json --outputFile /tmp/n30-focused.json`

- exit **0**
- **104 tests：104 passed / 0 failed / 0 skipped**（零 skip，满足 focused 零 skip 门）
- vitest 顶层报告 37 个 test suites（含 browser project 等多项目展开），断言归属 13 个 probe 文件

## 3. Full 回归

命令：`npm test -- --hookTimeout 60000 --reporter=json --outputFile /tmp/n30-full.json`

- exit **1**
- 982 suites，**3014 tests：3003 passed / 2 failed / 9 pending**
- **skip manifest 与冻结清单完全一致**（无新增 skip）：
  - `test/pth-execution/sandbox-security.integration.test.ts`：9 skips（既有冻结）
- 2 个失败（均为 `test/pth-architecture/` 边界检查，干净工作树上可确定性复现）：
  1. `final-boundaries.test.ts :: contracts/tasking/runner/execution/catalog/bootstrap/gateway 全量违规为 0` —— 实测 12 条 `cross-module-private-import` 违规 ≠ []
  2. `phase-boundaries.test.ts :: records current violations explicitly in baseline and fails only on NEW violations` —— 新增未入账违规：`bootstrap/professional-runtime-adapters.ts:17 → execution/adapters/assembly-runtime-adapter.ts`（由 HEAD 提交 e75df7f `feat(professional): add wolfram symbolic vertical` 引入）

### 当前 12 条边界违规（`collectBoundaryViolations(src/pth)` 实测）

| rule | file:line | detail |
|---|---|---|
| cross-module-private-import | bootstrap/professional-runtime-adapters.ts:17 | execution/adapters/assembly-runtime-adapter.ts |
| cross-module-private-import | bootstrap/professional-runtime-adapters.ts:18 | execution/adapters/lean4-runtime-adapter.ts |
| cross-module-private-import | bootstrap/professional-runtime-adapters.ts:19 | execution/adapters/wolfram-runtime-adapter.ts |
| cross-module-private-import | bootstrap/professional-runtime-adapters.ts:20 | execution/professional-runtime.ts |
| cross-module-private-import | bootstrap/professional-runtime-adapters.ts:25 | runner/professional-task-capability.ts |
| cross-module-private-import | execution/adapters/assembly-runtime-adapter.ts:36 | runner/professional-task-capability.ts |
| cross-module-private-import | execution/adapters/lean4-runtime-adapter.ts:34 | runner/professional-task-capability.ts |
| cross-module-private-import | execution/adapters/wolfram-runtime-adapter.ts:29 | runner/professional-task-capability.ts |
| cross-module-private-import | runner/agent-task-runner.ts:31 | execution/authorization/execution-grant-service.ts |
| cross-module-private-import | runner/agent-task-runner.ts:32 | execution/professional-runtime.ts |
| cross-module-private-import | runner/professional-task-capability.ts:33 | execution/authorization/execution-grant-service.ts |
| cross-module-private-import | runner/professional-task-capability.ts:26 | execution/professional-runtime.ts |

全部来自 professional-runtime 垂直功能（assembly / lean4 / wolfram，`2cfc367`–`e75df7f` 区间提交），与 N30 O0–O4 代码无关。

## 4. Lint / Build

| 门 | 命令 | exit | 证据 |
|---|---|---|---|
| lint | `npm run lint` | **1** | 各 `tsc` 段全部通过；失败于 `check:pth-boundaries`：`── 新增违规 12 条（必须修复或先入账）──`（同上 12 条） |
| build | `npm run build` | **1** | 各 `tsc` 段通过；失败于 `scripts/copy-framework-web-assets.mjs`：`operator-console web asset not allowed: packages/framework/web/operator-console/config.js`。白名单仅允许 `index.html / styles.css / app.js`，但 HEAD 已跟踪 `config.js / debug.js / memory.js` → 干净树上确定性失败 |

## 5. Long-run / Browser / 真实性证据（focused 报告 passed 用例）

| 真实性门 | 状态 | 证据 |
|---|---|---|
| real-docker-pth-composition | satisfied | `runtime-observatory.integration.test.ts :: monitor /snapshot 合并真实 PG durable timeline` = passed（真实 Testcontainers PostgreSQL + PTH gateway + docker-monitor 聚合） |
| long-run-bounded-memory | satisfied | `runtime-observatory-long-run.test.ts :: ring 内存：14,400 个样本后只保留 1,800 条，时间轴漂移 ≤ 1 采样周期` = passed（含 8 小时 server 采样有界、event 内存不累积、stale 精确边界） |
| browser-credential-boundary | satisfied | `runtime-observatory.test.ts :: 页面源码与浏览器模块不含 Docker socket 路径或凭据字段` = passed（另含 stale 灰显降级、联动缩放共享窗口） |

## 6. Latency 指标与破坏探针矩阵（来自 eval 台账，`n30-runtime-observatory-ledger/1`）

| 指标 | 样本数（精确分母） | P50 | P95 | P99 | 健康目标（P95） | 判定 |
|---|---|---|---|---|---|---|
| resource | 14,400 | 0ms | 0ms | 0ms | ≤ 5000ms | ✅ |
| activity | 14,400 | 0ms | 0ms | 0ms | ≤ 2000ms | ✅ |
| timeline | 14,400 | 0ms | 0ms | 0ms | ≤ 10000ms | ✅ |

（long-run 用假时钟推进，延迟读数为 0 但有限且非 NaN；`writeCallsObserved=0`，观测台零写调用。）

破坏探针 8/8 全部翻转（证明门禁非空转）：

| 探针 | baseOk | sabotagedOk | flipped |
|---|---|---|---|
| probe.ring.bounded | true | false | ✅ |
| probe.metrics.nullPreserved | true | false | ✅ |
| probe.tenant.isolation | true | false | ✅ |
| probe.browser.credential | true | false | ✅ |
| probe.reconcile.authoritative | true | false | ✅ |
| probe.browser.staleHonest | true | false | ✅ |
| probe.charts.sharedScale | true | false | ✅ |
| alerts.write-calls | true | false | ✅ |

## 7. Accept driver 运行结果与决策

命令：`node --import tsx scripts/accept-n30-runtime-observatory.ts --output /tmp/n30-accept.json`

- **driver 在四门重跑完成后、产出 envelope 前崩溃**，exit 1：
  ```
  TypeError: assertions.some is not a function
      at passedTitle (scripts/accept-n30-runtime-observatory.ts:157:21)
      at deriveN30RealismGates (scripts/accept-n30-runtime-observatory.ts:161:29)
  ```
  根因：`deriveN30RealismGates(assertions)` 内部三处调用 `passedTitle(file, pattern)` 少传第一个 `assertions` 实参（函数签名为 `(assertions, file, pattern)`）。**这是 accept driver 自身的 bug**，未产出 `/tmp/n30-accept.json`，因此本次不生成 `docs/pth/n30-runtime-observatory-envelope.json`。
- 决策推定：**NO-GO**。依据 driver 自身判定规则（`decideN30Acceptance`）：full/lint/build 三个**已启动**门 exit 非零即为 NO-GO，且 NO-GO 不得被覆盖；三门失败均为干净工作树上的确定性失败（见 §3/§4）。
- 阻塞项与 N30 O0–O4 代码无关：① professional-runtime 垂直功能引入的 12 条未入账/越界 import；② operator-console web asset 白名单与已跟踪文件不一致；③ accept driver realism-gate 推导 bug。

## 8. 偏差清单

1. `scripts/accept-n30-runtime-observatory.ts` `deriveN30RealismGates` 少传 `assertions`（崩溃，无法产出权威 envelope）。
2. full 2 个架构边界测试失败（12 条 cross-module-private-import，其中 1 条为 HEAD 新引入未入账）。
3. lint 失败于 `check:pth-boundaries`（同 12 条）。
4. build 失败于 web asset 白名单拒绝已跟踪的 `config.js`（及 `debug.js`/`memory.js`）。
5. eval 脚本无 `--output` 参数，按预案以 stdout 重定向执行双跑；字节一致。

> 本报告仅评估 N30 本地运行观测台（O0–O4）：Docker 采样、tenant 维度 durable PTH 时间线投影、服务端聚合/freshness、C 布局甘特/资源图、只读告警、有界长跑内存与破坏探针敏感度。不代表 N33 嵌入、O5 租户自助、长期历史保留或任何控制面写路径。
