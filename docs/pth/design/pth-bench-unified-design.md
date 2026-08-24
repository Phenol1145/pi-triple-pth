# PTH Bench 统一抽象设计（agentic benchmark + 运行效率测试）

> 状态：**设计稿（已定方向）；W0–W3 核心/runner/gate/ScriptedLlmFn 已落地（2026-08-24）**
> 分支：`feat/pth-exec-unified`
> 关联设计：`three-source-lineage-and-capacity-conservation-design.md`（三源谱系——本装置是其
> 受控测量上游）、`execution-modes-and-tool-reg-v2-design.md`（观察策略/活动因子/WorkerKind——
> 测量定义层直接复用）。

本文给出「配套自动化测试装置」的统一抽象：**agentic benchmark 与运行效率测试是同一套系统的
两个特化**，差别只落在流水线的两个可替换点上。

---

## 0. 核心命题：一个系统，不是两个

统一流水线：

```
Suite(套件) → Scenario(场景) → Driver(驱动) × ExecPolicy(执行策略)
           → RunRecord(观测) → Grader(评分) → Report(报告)
           → Archive(归档) → Baseline Gate(门禁) → exit code
```

| | agentic benchmark | 效率测试 |
|---|---|---|
| Grader 断言对象 | 行为/产物（值正确性、工具序列、轨迹谓词） | 测量值（execMs、p95、token、吞吐） |
| ExecPolicy | `repeats:1` + 确定性 LLM（可复现判分） | `repeats:N` + `warmup` + `concurrency`（统计意义） |

**效率测试 = grader 断言在测量值上的 benchmark。** 同一 runner，grader 代数对「正确性字段」
和「测量字段」同构——不需要两套装置。

### 0.1 现有代码基础（设计前提，已核查）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| `pth bench`（7 硬编码任务，归档 `.perf-bench/`，list/compare） | `packages/pth-console/src/commands/bench.ts` | 迁移为 `core.json` 套件；CLI 薄壳重写（行为零回归） |
| 指标化评测（阈值 + 退出码） | `scripts/eval-k5-pilot.ts` + `pilot-evaluator.ts` | 阈值门禁模式 → Baseline Gate |
| 进程内全生产装配 + 确定性 LLM（outcome/toolsByTurn/traces/usage 采集） | `scripts/n28-feasibility-harness.ts` | L0 in-process driver 的装配模式 |
| 指标基础设施（L0/L1/LLM/L2/L3，prom-client） | `src/pth/observability/kernel-metrics.ts`、`metrics-observer.ts` | `/metrics` 抓取 → system 快照 + metric-delta grader |
| `buildScorecard(traceEvents)`（反模式/利用率聚合） | `pth-kernel-execution`（已导出；gateway trace 路由已随轨迹返回 scorecard） | RunRecord.trace.scorecard；`scorecard` grader |
| **观察策略/活动因子**（声明式 matcher + p50/p95/p99 聚合 + 热路径预算；`getPathValue`/`matchObservationCondition`） | `pth-kernel-execution/observation-strategy.ts` | **测量定义层**（§3）；grader 路径/匹配原语全部复用 |
| token 计量 | `LlmResult.usage`（契约层） | `tokens` grader |
| 轨迹采集双通道 | runner `onTrace`/`onStep`；HTTP `getObserveTrace`/`getObserveEvents`/SSE | L0 直取 / L1 回填 |
| 驱动入口 | `POST /api/v1/kernel/exec`；task 发布/wait/cancel；batch 控制 | task-pool / kernel-exec driver |
| 确定性 LLM 钩子 | `PTH_LLM_STUB=1`（schema 已注册） | L1 smoke 档 |
| 四执行模式 | tool-call/asp/ptc/pulse | matrix 对比维度 |

---

## 1. 八个核心抽象

### 1.1 Scenario —— 声明式场景

JSON 文件，zod 校验（zod ^4 已是根依赖，pth-kernel-interpreter 有先例——零新依赖）：

```json
{
  "suite": "agentic-basic",
  "suiteVersion": 1,
  "defaults": {
    "execPolicy": { "repeats": 1, "timeoutMs": 180000 },
    "graders": [{ "kind": "status", "expect": "completed" }]
  },
  "scenarios": [
    {
      "id": "calc-sum-ts",
      "title": "用 ts 计算 1..100 的和",
      "tags": ["agentic", "smoke"],
      "driver": {
        "kind": "task-pool",
        "input": { "title": "[bench] 求和", "text": "请计算 1 到 100 的和…", "tags": ["code"] }
      },
      "execPolicy": { "execMode": "tool-call", "repeats": 5, "warmup": 1 },
      "graders": [
        { "kind": "value", "path": "sum", "equals": 5050 },
        { "kind": "tool-seq", "mode": "subsequence", "expect": ["ts.execute"] },
        { "kind": "factor", "strategyId": "bench-exec-p95", "op": "lte", "value": 30000 },
        { "kind": "tokens", "maxTotal": 5000 }
      ]
    }
  ]
}
```

- `defaults`：suite 级 grader/policy 继承，场景级覆盖；
- `matrix`（可选）：suite 级 `{ "execMode": ["tool-call","ptc","pulse"] }` → runner 展开
  场景×模式笛卡尔积，报告按模式分组；
- 场景纯数据（LLM 剧本也内联在 `driver.input.script`）；无注释问题用 `"_doc"` 字段约定承载。

### 1.2 Driver —— 执行通道

```ts
type BenchDriver = { execute(scenario, target, policy): Promise<RunRecord> };
```

| kind | 通道 | 用途 |
|---|---|---|
| `task-pool` | `PthClient.publishTask` + 轮询（现 bench.ts 逻辑） | NL 任务全链路 |
| `kernel-exec` | `POST /api/v1/kernel/exec`（stateless/repl） | 纯 kernel 效率基线 |
| `in-process` | n28-harness 式进程内装配 + `runAgentTask` | L0 确定性 agentic 判分 |
| `program` | `client.run()` SSE（P2 可裁） | PTL 程序面回归 |

### 1.3 ExecPolicy —— 执行策略

```ts
interface ExecPolicy {
  repeats: number; warmup: number; concurrency: number;  // 并发 = 吞吐模式
  timeoutMs: number;
  execMode?: "tool-call" | "asp" | "ptc" | "pulse";      // 矩阵维度
  env?: Record<string, string>;                          // 场景级环境覆盖
}
```

### 1.4 BenchTarget —— 目标端口（依赖反转，测试缝）

```ts
interface BenchTarget {
  publishTask(input): Promise<{ id: string }>;
  waitTask(id, timeoutMs): Promise<TaskSnapshot>;   // status/outputRef/claimed_at
  kernelExec(req): Promise<KernelExecResult>;
  kernelStatus(): Promise<Record<string, unknown>>;
  metricsText?(): Promise<string>;                  // /metrics 抓取
  close?(): Promise<void>;
}
```

runner 只面向此端口：单测用 fake（零服务）；同一 runner 可打 local-container /
local-process 两个 deploy target（复用部署 target 抽象）。

### 1.5 RunRecord —— 统一观测记录

```ts
interface RunRecord {
  scenarioId: string; repeat: number; startedAt: string;
  status: string;                                   // completed/rejected/timeout/infra-error
  timing: { totalMs: number; queueMs?: number; execMs?: number;
            stageMs?: Record<string, number> };
  value?: unknown;                                  // outputRef.value
  error?: string | null;
  usage?: { inputTokens: number; outputTokens: number;
            cacheReadTokens?: number; cacheWriteTokens?: number };
  trace?: {
    toolsByTurn?: string[][];
    steps?: Array<{ n: number; tool: string; durationMs: number; ok: boolean }>;
    scorecard?: WorkerScorecard;                    // buildScorecard 复用
  };
  factors?: ActivityFactor[];                       // 观察策略求值（§3）
  system?: Record<string, unknown>;                 // /kernel/status 快照
}
```

所有字段现有系统均可产出——这个抽象做的是**收编**，不是发明。

### 1.6 Grader —— 评分器代数（设计核心）

```ts
type Grader = (rec: RunRecord, ctx: GradeContext) => Grade;
interface Grade { pass: boolean; score: number; reason?: string }   // score ∈ [0,1]
```

| kind | 断言对象 | 说明 |
|---|---|---|
| `status` | rec.status | 默认继承 |
| `value` | rec.value 路径取值 | **路径/匹配复用 observation-strategy 的 `getPathValue`/`matchObservationCondition`**；`equals`/`contains`/`approx` |
| `output-regex` | value 序列化 | 非结构化输出 |
| `tool-seq` | trace.toolsByTurn 拍平 | `exact`/`subsequence`/`set` + `forbidden` |
| `trace-pred` | trace 事件 | 内建谓词：`no-escalate` / `used-knowledge` / `max-turns:N` |
| `scorecard` | trace.scorecard | 反模式/利用率字段（gate-heavy / repeated-fail / cache-waste / timeReuse） |
| `factor` | factors[strategyId].value | `op` + 阈值（§3——测量定义共享的正解） |
| `latency` | timing.* | `maxMs` 单轮；聚合档 p50/p95（语义对齐 strategy aggregate） |
| `tokens` | usage.* | maxInput/maxOutput/maxTotal |
| `metric-delta` | /metrics 前后差值 | P2（L1 token 精度兜底） |
| `llm-judge` | value+trace | **仅 L2，rubric 显式声明，默认关闭**——报告标注非确定 |

聚合：场景分 = grader score 均值（等权，权重字段预留）；套件分 = 场景分均值。
**grade 只产数据，exit code 只由 Gate 决定**——职责分离。

### 1.7 Report + Fingerprint

```json
{
  "reportVersion": 1, "ts": "…", "suite": "core", "tier": "l1",
  "fingerprint": { "version": "1.7.0", "node": "v22.x", "commit": "…",
                   "target": "local-container", "execMode": "tool-call",
                   "llm": "stub-1", "deterministic": true },
  "results": [ { "scenarioId", "grades": [], "score": 1.0,
                 "runs": ["RunRecord…"],
                 "agg": { "execMs": { "p50": 812, "p95": 1103 } } } ],
  "summary": { "total": 7, "passed": 7, "meanScore": 1.0, "wallMs": 41200 }
}
```

- `fingerprint.deterministic` 显式标注——**凡含真实 LLM 的报告不得进 baseline**；
- 归档 `.pth-bench/`（补 .gitignore——顺带修 `.perf-bench` 名义忽略实际未忽略的漏洞）；
  compare 读新旧两目录（旧格式只读兼容，不迁移）。

### 1.8 Baseline + Gate —— 回归门禁

基线 = pin 住的报告（`bench/baselines/<name>.json`，可入库）；门禁规则：

```json
{ "scoreFloor": 0.95, "latencyRegressionPct": 20, "tokenRegressionPct": 30,
  "requireDeterministic": true,
  "perScenario": { "calc-sum-ts": { "maxExecMs": 12000 } } }
```

退出码三值（CI 友好）：`0` 全过 / `1` 门禁失败 / `2` 设施故障（连不上栈、超时风暴）——
**区分「系统变慢了」和「环境坏了」**。

---

## 2. 决定论分层（Tier）

| | L0 进程内 | L1 黑盒本地栈 | L2 真实 LLM |
|---|---|---|---|
| 驱动 | in-process（n28 模式推广） | task-pool / kernel-exec，打 `pth up` 的栈 | 同 L1 |
| LLM | **ScriptedLlmFn**（场景数据驱动：按剧本吐 toolCalls 后 done） | `PTH_LLM_STUB=1`（只够 smoke） | 真实模型 |
| 判分强度 | 全量（轨迹/值/工具序列/factor） | 值+时延+status | 全量 + llm-judge + 成本 |
| 用途 | CI 每提交 | CI 每提交 / 本地 | nightly / 发版前 |

ScriptedLlmFn 是 L0 关键新增件：`PTH_LLM_STUB=1` 只会「立即 done」，无法演练多轮工具调用。

---

## 3. 测量定义层与判定层分离（观察策略复用——已裁决方向）

设计文档已裁决「sensor 不一定必须是 LLM worker：可以是受治理的代码（观察策略/聚合器/
检测器）」。code 态 sensor 确定性、有热路径预算、受治理、run 级求值——**正是测量路径的
正确机制**（LLM 态 sensor 四错配：非确定 / 窗口聚合 / 产物语义 / 依赖面，不进测量路径）。

```
测量定义层：ObservationStrategySpec（受治理、版本化——生产观测与 bench 共用同一份定义）
判定层：    grader { kind:"factor", strategyId:"bench-exec-p95", op:"lte", value:30000 }
```

- 同一份策略 spec，sensor 环用它做趋势观测，bench 门禁用它做回归判定——
  **杜绝「p95 执行时长」两处定义漂移**；
- bench 专属策略（`bench-exec-p95` / `bench-tool-deny-rate`）可注册为 **kind=code worker
  单元**进 Worker Registry（L1+ 可选路径）——白拿身份/版本/治理/灰度；
- harness 在系统外（CI 同步语义），**测量定义在系统内**——装置归属张力的正解。

---

## 4. 落点与边界合规

```
packages/pth-bench/            # 纯核心：scenario(zod)/runner/graders/report/baseline/archive/ports
                               #   依赖仅 zod + 类型 import；单测全 fake，零服务
packages/pth-console/src/commands/bench.ts   # 薄壳重写：flags → pth-bench API；
                               #   HttpBenchTarget 适配器包 PthClient（package→package 合法）
src/cli/pth-cli.ts             # case "bench" 分发点不动
scripts/pth-bench-l0.ts        # L0 入口（先例：eval-k5-pilot.ts 同为 scripts/ + import src/）
src/bench/scripted-llm.ts      # ScriptedLlmFn + L0 装配（必须 src 侧：import src/pth runner）
bench/suites/*.json            # 场景库（与 deploy/、scripts/ 平级）
bench/baselines/*.json         # pin 基线（入库）
.pth-bench/                    # 归档（补 .gitignore）
```

- **边界**：凡 import `src/pth` 装配的（L0）一律放 src/ 或 scripts/——不触碰 src↔packages 单向规则；
- **配置**：v1 不加任何新 `PTH_*` env key，全部 CLI flag + 默认值（绕开 schema.ts 变更成本）；
- **CLI 兼容**：裸 `pth bench` ≡ `pth bench run --suite core`（7 任务迁移 `bench/suites/core.json`，
  任务文本逐字保留）；`--task ts` → `--scenario ts-calc`；`--list/--compare` 语义不变——
  **现有行为零回归，test/pth-cli 不需要改**。

---

## 5. 测试策略

- `packages/pth-bench`：fake BenchTarget + 固定 clock → runner/graders/gate 全单测（含退出码三值）；
- `test/pth-bench/`：scenario 解析、report 聚合、baseline 对比、归档兼容（读旧 `.perf-bench`）；
- L0：脚本 stub 本身是确定性件，smoke suite 进 vitest；
- bench 自身不进串行全量套（当前已 424s），独立命令跑。

## 6. Wave 划分（供实施计划细化）

| Wave | 内容 |
|---|---|
| W0 | pth-bench 核心：scenario schema + 基础 grader + report/聚合 + 单测（grader 原语建在 observation-strategy 上——matcher/aggregate 不写第二份） |
| W1 | runner + HttpBenchTarget + `pth bench` 薄壳迁移（legacy 全兼容）+ core.json |
| W2 | baseline + gate（三值退出码）+ `.pth-bench` 归档/gitignore + compare 升级 |
| W3 | L0：ScriptedLlmFn + in-process driver + agentic-basic suite |
| W4（可裁） | matrix 展开、concurrency 吞吐模式、metric-delta、llm-judge |

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| L1 拿不全 token/轨迹（outputRef 未回传 usage） | `metric-delta` grader 兜底（/metrics 聚合差值，精度降级但可用） |
| **bench 合成流量污染 sensor 观测面**（scorecard/callpoint 统计混入 bench 任务） | `createdBy:"bench"` 过滤约定（先例已有）——过滤责任在 sensor 查询侧 |
| 旧 `.perf-bench` 历史数据 | compare 双目录读取，不做格式迁移 |
| 场景 JSON 无注释 | `"_doc"` 字段约定 |

## 8. 与三源设计的关系

- bench = **控制环的受控刺激源**：bench-report（run summary）可作为 `observation-report`
  数据源被 sensor 评估（受控测量补齐 N14「单工具优化观测半缺」）；依赖方向单向
  （sensor → bench 产物），bench 不被阻塞、不感知；
- 反向不成立：LLM 态 sensor 不进 bench 测量路径（§3 四错配）；
- 可选 P2 桥接：bench run 完成写 `memory kind=bench-report`（status=official）供 LLM 态
  sensor 消费——遵守三源产物契约（bench-report 是装置产物，非任何角色 produces）。
