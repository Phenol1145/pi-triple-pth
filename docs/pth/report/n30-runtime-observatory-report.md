# N30 运行观测台验收报告（GO）

- **evaluatedCommit**: `c3a2e5a94bac3bdcc50e458c91a691c88a5e551d`（main，验收开始与结束时工作树均 clean）
- **验收日期**: 2026-08-20
- **决策**: **GO**（唯一权威 envelope：`docs/pth/n30-runtime-observatory-envelope.json`，reasons=0）
- **环境**: Docker（Testcontainers PostgreSQL 可用）；`PI_PLATFORM_PROVIDER=deepseek PI_PLATFORM_MODEL=deepseek-v4-flash`；focused/full 均带 `--hookTimeout 60000`
- **历史**: 本报告覆盖 2026-08-20 早前 NO-GO 报告（`901a7ce`）之后的全部修复：
  - `4320fd8` 边界违规（bootstrap/runner 改走公共 barrel）；
  - `911a7ef` pth-config lint 与 web asset 白名单；
  - `971201c` chemistry adapter 配置读取；
  - `e0ea82d` accept driver realism gate 实参修复；
  - `e6d346d` computational-chemist allowlist 增加 cp2k；
  - `cf6f1e3` pth-client 在飞轮询 rejection 捕获（消除 vitest unhandled error 假 exit 1）；
  - `48bd554` N33 driver fail-closed 加固；
  - `c3a2e5a` 用户复验收文档落库（docs-only）。

## 1. Eval 双跑（字节一致性）

`node --import tsx scripts/eval/eval-n30-runtime-observatory.ts` 连续两次：

| 项 | 结果 |
|---|---|
| 两次 exit | 0 / 0 |
| 字节比较 | **BYTE-IDENTICAL** |
| decision | **PASS** |
| 精确分母 | 13 个 probe 文件 / 104 tests / 104 passed / 0 failed / 0 skipped |
| 门禁 | 全部 ok（probe.file ×13、required probes、ledger、latency、write-calls） |

## 2. Focused 套件

- exit **0**
- **104 tests：104 passed / 0 failed / 0 skipped**
- 文件：13 个 probe 文件（docker-monitor 单元、runtime-observation 契约、PG facade、real Docker+PTH composition、long-run、browser credential boundary）

## 3. Full 回归

- exit **0**
- **3019 tests：3010 passed / 0 failed / 9 skipped**
- skip manifest 与冻结清单完全一致：
  - `test/pth-execution/sandbox-security.integration.test.ts`：9 skips（既有冻结，无新增）

## 4. Lint / Build

| 门 | exit | 证据 |
|---|---|---|
| `npm run lint` | 0 | pth-boundaries 0 违规；pth-config 检查通过 |
| `npm run build` | 0 | 六项 operator-console assets 复制成功 |

## 5. 真实性门（Realism Gates）

| Gate | 结果 |
|---|---|
| real-docker-pth-composition | **satisfied** —— testcontainers PostgreSQL + 最小 PTH gateway + docker-monitor `/snapshot` 合并 durable timeline |
| long-run-bounded-memory | **satisfied** —— 14,400×2s 假时钟推进，ring/sample/event 内存有界，stale 边界精确 |
| browser-credential-boundary | **satisfied** —— 页面源码与浏览器模块不含 Docker socket 路径或凭据字段 |

## 6. 破坏探针

8 个 sabotage probe 全部按要求翻转（baseOk=true、sabotagedOk=false）：

`probe.ring.bounded`、`probe.metrics.nullPreserved`、`probe.tenant.isolation`、`probe.browser.credential`、`probe.reconcile.authoritative`、`probe.browser.staleHonest`、`probe.charts.sharedScale`、`alerts.write-calls`。

## 7. 结论

N30 O0–O4 运行观测台在绑定 commit 上通过权威验收：focused/full/lint/build 全绿，skip manifest 无新增，真实性门与破坏探针全 satisfied。权威 envelope 为 `docs/pth/n30-runtime-observatory-envelope.json`（`decision: "GO"`）。

N30 只代表只读观测面；N33 五页操作台需以其自身 reacceptance 条件独立验收，不得从本报告外推。
