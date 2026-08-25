# N30：统一运行观测台设计

> 日期：2026-08-19
>
> 状态：**已实施，验收 GO**（见 n30-runtime-observatory-report.md；权威 envelope：n30-runtime-observatory-envelope.json）
>
> 已确认视觉方案：C——统一时间轴、执行甘特图与资源折线联动
>
> 分层待办：[根 TODO：N30 O0–O5（旧仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/TODO.md#n30-%E7%BB%9F%E4%B8%80%E8%BF%90%E8%A1%8C%E8%A7%82%E6%B5%8B%E5%8F%B0c-%E6%96%B9%E6%A1%88%E5%88%86%E5%B1%82%E5%BE%85%E5%8A%9E2026-08-19-%E5%B7%B2%E7%A1%AE%E8%AE%A4%E5%B8%83%E5%B1%80)
>
> 实施计划：[2026-08-19 N30 运行观测台实施计划（旧仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/superpowers/plans/2026-08-19-n30-runtime-observatory.md)
>
> v1.3 操作入口：[N33 PTL 五页 Operator Console](./n33-v13-ptl-operator-console-design.md)

## 0. 执行摘要

N30 建设一个本机管理员优先的统一运行观测台，用同一时间轴回答两个问题：

1. PTH 此刻正在执行什么：Job、Task、Knowledge Intake Run、Stage、Worker、Role、Batch；
2. 执行期间消耗了什么：容器与 Batch 的 CPU、RSS、Heap、Network、heartbeat 和健康状态。

主界面采用已确认的 C 方案：上方为全局状态和筛选，中间为
Job → Task → Intake/Optimize/Professional Stage 分层甘特图，下方为共享横轴的资源折线图，右侧为选中区间的
Worker、Role、Batch、Trace、重试、事件和资源摘要。

本设计不新建业务状态机。PTH 只提供 tenant-scoped、read-only 的运行投影；现有
`deploy/docker-monitor` 继续负责本机页面、Docker Socket 读取、短期资源采样和两个读面的聚合。
看板故障不得阻塞或改变 Task、Intake、Worker、Promotion 等生产状态。

首版只支持本机管理员：默认监听 `127.0.0.1`，PTH 管理令牌仅存在于服务端，Docker Socket
永不暴露给浏览器。租户自助访问与长期时序存储属于 O5，必须另行验收。

N30 始终是只读 Observation Plane。它可以独立提供 C 方案页面；N33 落地后，PTL Operator
Console 通过同源 GET/SSE 代理把该页面以 `embed=1` 放入“总览”。N30 进程不因此获得 PTH 写凭据，
也不承载运行、调试、记忆或配置页的控制逻辑。

## 1. 当前基础与缺口

### 1.1 可直接复用

- `deploy/docker-monitor/server.js`：零依赖 Node HTTP 服务和 2 秒 SSE 推送；
- `deploy/docker-monitor/docker-api.js`：只读 Docker Engine Unix Socket 客户端；
- `deploy/docker-monitor/metrics.js`：CPU、内存、网络快照计算；
- `/metrics`：PTH Prometheus 当前值；
- `/api/v1/kernel/status`：Batch、Task count、watchdog 和资源心跳快照；
- `/api/v1/kernel/events`：ActivityHub 的实时活动流；
- PostgreSQL `tasks`：`created_at`、`claimed_at`、`submitted_at`、`completed_at`、role、worker、job；
- PostgreSQL `knowledge_intake_runs` 与 append-only `knowledge_intake_attempts`：摄入阶段、租约、结果时间；
- `/api/v1/observe/*` 的 tenant-scoped 会话查询模式和统一认证钩子。

### 1.2 必须补齐

- Docker Monitor 目前只保留一个快照，没有资源历史、容器 inspect 时间线或统一事件 envelope；
- PTH 没有稳定的 runtime timeline DTO，现有 status/jobs 接口不能表达嵌套区间；
- ActivityHub 只保留最近 500 条内存事件，没有稳定 event id，不能作为历史甘特图事实源；
- 当前资源只能可靠量到容器、进程或 Batch，不能精确归因到一个 Worker 或 Task；
- 浏览器若直接访问 PTH 与 Docker Monitor，会产生多源认证、CORS 和令牌暴露问题；
- 根 `package.json` 的 `monitor` 脚本仍指向迁移前的 `tools/docker-monitor/server.js`。

## 2. 目标与非目标

### 2.1 目标

- 用一条 UTC 时间轴统一展示服务生命周期、任务执行和摄入阶段；
- 资源折线与甘特区间可双向联动，高亮同一时间窗；
- durable 时间线来自 PostgreSQL，实时事件只负责降低刷新延迟；
- 资源采样有固定周期、固定保留量和固定内存上限；
- 所有查询具有 tenant、时间窗、分页与返回量边界；
- 数据缺失、来源陈旧、连接失败均显式显示，不用零值伪装健康；
- 看板默认关闭、可独立回滚、不可触发生产控制动作。

### 2.2 首版非目标

- 不精确计算单个 Worker 或 Task 的 CPU/RSS；
- 不构建分布式 tracing、日志搜索或完整 APM；
- 不把 ActivityHub 改成持久事件仓库；
- 不新增观测数据库、对象存储或时序数据库；
- 不允许浏览器直接读取 Docker Socket、Redis、PostgreSQL 或 PTH 管理令牌；
- 不提供 pause、resume、remove、retry、cancel 等控制按钮；
- 不因为 N33 嵌入而接收任何 POST、控制命令或浏览器身份；
- 不在 O1–O4 提供公网或多租户自助访问；
- 不把告警直接连接到 controller 或自动调节路径。

## 3. 边界与所有权

### 3.1 PTH Runtime Observation

PTH 新增一个只读 application/query service：`RuntimeObservationFacade`。它只把现有生产状态
投影为稳定 DTO，不拥有任务、摄入、Worker 或资源状态，也不写任何领域表。

职责：

- 按认证上下文解析 tenant/space；
- 从 Task/Job/Intake/Optimizer/Professional Job 的 durable 数据构造时间区间；
- 从 BatchManager 读取当前 Batch/Worker 关联和健康快照；
- 输出有界的 timeline snapshot；
- 提供实时 activity stream，但明确标记为 hint，不作为历史真相。

### 3.2 Docker Monitor Adapter

`deploy/docker-monitor` 是本机管理员适配器，不升级为 PTH Module。它拥有：

- 页面静态资源；
- Docker Socket 的只读访问；
- 容器 inspect 与资源采样；
- 有界内存 ring buffer；
- 对 PTH observation API 的 server-to-server 读取；
- 浏览器唯一 `/snapshot` 和 `/events` 入口；
- UI 使用的本地统一序列号与断线恢复。

它不拥有：

- Task、Intake、Worker 或 Knowledge 的状态；
- 长期历史；
- tenant 授权事实；
- 生产控制能力。

### 3.3 浏览器

浏览器只消费 Docker Monitor 输出的已裁剪 DTO。浏览器可以筛选、折叠、暂停、缩放和选择，
但不能构造 tenant 身份、访问管理密钥或调用写端点。

## 4. 核心数据合同

时间一律使用 UTC epoch milliseconds；展示层再转换到本地时区。所有 ID 都由服务端产生或读取，
浏览器不得拼接可用于授权判断的 ID。

~~~typescript
export type RuntimeIntervalKind =
  | "service"
  | "job"
  | "task"
  | "optimizer-work"
  | "professional-job"
  | "intake-run"
  | "intake-stage";

export type RuntimeIntervalStatus =
  | "queued"
  | "running"
  | "waiting"
  | "retrying"
  | "completed"
  | "failed"
  | "stale"
  | "unknown";

import type { WorkMode } from "./work-mode.js";

export interface RuntimeInterval {
  id: string;
  parentId?: string;
  kind: RuntimeIntervalKind;
  /** service 等中立基础设施区间可为空；业务 work 必须由服务端投影。 */
  workMode?: WorkMode;
  label: string;
  status: RuntimeIntervalStatus;
  /** 来源内单调版本；优先使用 rowVersion，否则使用规范化 updatedAt。 */
  sourceVersion: string;
  startAt: number;
  /** 运行中为 null；UI 只能延伸到 sourceObservedAt。 */
  endAt: number | null;
  freshness: FreshnessStamp;
  tenantId?: string;
  space?: string;
  jobId?: string;
  taskId?: string;
  runId?: string;
  stage?: string;
  attempt?: number;
  workerId?: string;
  roleId?: string;
  batchId?: string;
  traceId?: string;
  detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export type ResourceTargetKind = "container" | "batch" | "process" | "system";

export interface ResourceSample {
  ts: number;
  targetKind: ResourceTargetKind;
  targetId: string;
  cpuPercent?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  memoryLimitBytes?: number;
  netRxBytes?: number;
  netTxBytes?: number;
  heartbeatLagMs?: number;
  health?: "healthy" | "stale" | "dead" | "unknown";
  source: "docker" | "pth-batch" | "pth-process";
  freshness: FreshnessStamp;
}

export type FreshnessState = "fresh" | "lagging" | "stale" | "disconnected";

export interface FreshnessStamp {
  /** 来源产生或确认该事实的时间。 */
  sourceObservedAt: number;
  /** 聚合器收到并接受该事实的时间。 */
  collectedAt: number;
  expectedIntervalMs: number;
  staleAfterMs: number;
}

export interface RuntimeSourceState {
  source: "docker" | "pth-timeline" | "pth-events";
  state: FreshnessState;
  lastSuccessAt: number | null;
  lastAttemptAt: number;
  expectedIntervalMs: number;
  staleAfterMs: number;
  consecutiveFailures: number;
}

export interface RuntimeSummary {
  activeTasks: number;
  queuedTasks: number;
  workers: number;
  idleWorkers: number;
  activeIntakeRuns: number;
  activeOptimizeWorks: number;
  activeRunWorks: number;
  alerts: number;
}

export interface RuntimeSnapshot {
  snapshotId: string;
  collectedAt: number;
  window: { from: number; to: number };
  scope: { mode: "local-admin"; tenantId: string; space?: string };
  summary: RuntimeSummary;
  intervals: readonly RuntimeInterval[];
  resources: readonly ResourceSample[];
  sources: readonly RuntimeSourceState[];
  warnings: readonly RuntimeWarning[];
}

export interface RuntimeWarning {
  code: string;
  source: "docker" | "pth" | "aggregator";
  message: string;
  observedAt: number;
  staleSince?: number;
}

export interface RuntimeDelta {
  streamEpoch: string;
  seq: number;
  observedAt: number;
  type: "snapshot" | "interval.upsert" | "resource.sample" | "warning.upsert" | "heartbeat";
  payload: RuntimeSnapshot | RuntimeInterval | ResourceSample | RuntimeWarning | RuntimeHeartbeat;
}

export interface RuntimeHeartbeat {
  source: "pth-events" | "aggregator";
  freshness: FreshnessStamp;
}
~~~

### 4.1 不可伪造的资源归因

`ResourceSample.targetKind` 只允许使用实际可测量主体。首版的 Task/Worker 详情可以显示
“关联 Batch 的资源曲线”，但不得标注成“该 Task 消耗”或“该 Worker 消耗”。只有未来存在
独立 cgroup/process 归属证据时，才能新增更细 target kind。

`RuntimeInterval.id` 使用类型化命名空间，至少包括 `service:`、`job:`、`task:`、
`intake-run:` 与 `intake-stage:` 前缀；tenant-owned interval 的 ID 同时绑定 tenantId，避免
不同来源或租户的业务 ID 在聚合器中碰撞。

### 4.2 区间时间语义

| 区间 | startAt | endAt |
|---|---|---|
| service | Docker inspect `StartedAt`；未启动用 `Created` | 已退出用 `FinishedAt`；运行中 null |
| job | 子任务最早 `created_at` | 所有子任务终态的最晚终态时间；否则 null |
| task | `created_at` | `completed_at`、`escalated_at` 或最后终态更新时间；否则 null |
| intake-run | `created_at` | completed/failed/dead-letter 的 `updated_at`；否则 null |
| intake-stage | attempt 的 leased `created_at` | 同 identity 的 succeeded/failed/expired `created_at`；否则 null |

运行中区间在 UI 中只延伸到该来源的 `freshness.sourceObservedAt`。来源停止更新后，区间冻结并标记
`stale`，不能继续向“现在”延伸造成系统仍健康的错觉。

## 5. 运行架构

~~~mermaid
flowchart LR
    PG[(PostgreSQL\nTask / Intake truth)] --> RO[RuntimeObservationFacade]
    BM[BatchManager\nworker + heartbeat] --> RO
    AH[ActivityHub\nlow-latency hints] --> RO
    RO -->|authenticated read-only| OA[Docker Monitor Aggregator]

    DS[/Docker Socket/] --> DC[Docker Collector]
    DC --> RB[Bounded Ring Buffer]
    RB --> OA

    OA -->|GET /snapshot| UI[Runtime Observatory UI]
    OA -->|SSE /events| UI

    TIMER[5s authoritative reconcile] --> RO

    PM[(Prometheus-compatible history\nO5 only)] -.optional.-> OA
~~~

### 5.1 PTH 接口

新增路由独立于旧 session observe：

~~~text
GET /api/v1/observe/runtime/timeline
  ?from=<epoch-ms>&to=<epoch-ms>&limit=<1..2000>
  &jobId=&taskId=&runId=&status=&roleId=&workerId=

GET /api/v1/observe/runtime/status

GET /api/v1/observe/runtime/events
  SSE，实时 hint；连接或序列丢失时客户端必须重取 timeline snapshot
~~~

规则：

- `runtime-observer` 与 tenant-agent 都强制使用 token 中的 `req.auth.tenantId` 和 space，
  不接受 query/body 覆盖；
- O1–O4 每个 Monitor 实例只观察一个配置 tenant，不提供跨 tenant 汇总或浏览器 tenant 切换；
- `runtime-observer` 是受限服务身份，只允许访问 `GET /api/v1/observe/runtime/*`；认证钩子在
  其他路径一律拒绝该身份，避免复用现有 platform-admin 广权限 token；
- 默认时间窗 1 小时，单次最大 24 小时；默认 500 条，最大 2,000 条；
- SQL 必须在数据层包含 tenant/time predicate，不得先全量读出再过滤；
- 返回值不含任务正文、Knowledge 内容、prompt、token、原始错误堆栈或凭据。

### 5.2 本机聚合接口

~~~text
GET /                       已确认的 C 方案页面
GET /snapshot?from=&to=     Docker + PTH 的统一初始快照
GET /events                 RuntimeDelta SSE
GET /health                 仅报告 aggregator、docker、pth 三个来源状态
~~~

浏览器首次加载和每次 SSE 重连都先请求 `/snapshot`。`RuntimeDelta.seq` 只在当前
`streamEpoch` 内单调递增；聚合器重启会更换 epoch，浏览器发现 epoch 变化后丢弃本地增量并重取
snapshot。首版不声称支持跨进程 Last-Event-ID replay。

5 秒 reconcile timer 属于 Docker Monitor Aggregator；它周期调用无状态的 PTH timeline GET，
比较 snapshotId/sourceVersion 后产生 upsert。PTH 不为看板新增常驻调度器，也不把 UI cursor
写入业务表。

## 6. 采样与保留

- 默认采样周期：2 秒；允许配置为 1–30 秒；
- 默认资源历史：1 小时；每个 target 最多 1,800 个样本；
- 硬上限：8 小时；2 秒周期时每个 target 最多 14,400 个样本；
- target 消失后保留到当前窗口淘汰，不永久保存；
- ring buffer 只保存 `ResourceSample`，不保存原始 Docker stats；
- 网络图展示相邻样本的 bytes/second，累计字节仍保留在 sample 中；
- 缺失指标使用 `undefined`，不得自动替换为 0；
- O5 之前，聚合器重启后资源历史清空是明确行为，页面必须显示“history reset”。

### 6.1 Freshness Contract

N30 不承诺不可证明的“绝对实时”，而承诺两件可验收的事：健康时观测延迟有上限；不健康时
页面在规定时间内停止声称数据新鲜。推送和快照承担不同职责：

- ActivityHub SSE 只负责降低 Task/Intake 状态变化的显示延迟；
- runtime events route 在无领域事件时仍每 2 秒发送 heartbeat；`pth-events` 新鲜度依据
  transport heartbeat，不依据“最近一次任务事件”，避免系统空闲时被误判 stale；
- PostgreSQL timeline snapshot 每 5 秒重建一次，负责纠正丢事件、乱序、重连和进程重启；
- Docker resource collector 每 2 秒采样一次，sample 自身即该资源窗口的事实源；
- 浏览器首次加载、SSE 重连、`seq` 缺口或 `streamEpoch` 变化时，必须先获取完整 snapshot；
- 增量流连续时，浏览器仍每 30 秒做一次轻量 snapshot 校验，发现 snapshotId 不一致就全量替换。

默认时效目标：

| 数据面 | 正常周期 | 健康时目标 | lagging | stale | disconnected |
|---|---:|---:|---:|---:|---:|
| Docker resource | 2s | sample-to-screen P95 ≤ 5s | age > 5s | age > 6s | age > 30s |
| PTH activity hint | push | event-to-screen P95 ≤ 2s | age > 2s | age > 5s | age > 30s |
| PTH durable timeline | 5s | DB-to-screen P95 ≤ 10s | age > 10s | age > 15s | age > 30s |

配置改变采样周期时，resource stale 阈值取 `max(3 × interval, 6s)`；disconnected 阈值不得低于
`max(10 × interval, 30s)`。PTH timeline 的 reconcile 周期允许 2–30 秒，但 stale 阈值至少为
3 个 reconcile 周期。

### 6.2 时间戳职责

- 服务端 transport 只携带 `sourceObservedAt` 与 `collectedAt`；
- 浏览器在实际绘制时记录本地 `renderedAt`，并计算
  `ageMs = renderedAt - sourceObservedAt`；
- `renderedAt` 和 `ageMs` 是 UI view model，不写回服务器，也不冒充来源时间；
- 页面使用 snapshot 的 `collectedAt` 估算浏览器与服务端时钟偏差；偏差超过 2 秒时显示
  `clock-skew` warning，并使用校正后的 age；
- Worker/Batch 事件中的客户端时间不直接决定 durable interval，最终仍以 PostgreSQL 时间为准。

### 6.3 顺序、去重与晚到数据

- Runtime delta 使用 `(streamEpoch, seq)` 排序；同 epoch 内 seq 必须严格递增；
- heartbeat 同样占用 seq，因此既能证明连接存活，也能暴露中间帧缺口；
- 发现 seq 缺口、倒退或未知 epoch 时，不猜测缺失内容，立即重取 snapshot；
- Resource sample 以 `(source, targetKind, targetId, ts)` 去重；相同 key 只接受相同内容；
- Task/Intake interval 只接受更高 `rowVersion`，或在无 rowVersion 时接受更晚 `updatedAt`；
- 晚到旧版本不得覆盖终态或更新版本；时间戳逆序样本丢弃并产生 warning；
- SSE backpressure 采用 latest-wins：中间资源帧可合并，状态终态和 warning 不可静默丢弃；
- snapshot 始终覆盖本地派生状态，是断线后的唯一恢复基线。

### 6.4 页面时效表达

页面顶部不使用无条件绿色 `LIVE`。它显示整体状态和每个来源的年龄，例如：

~~~text
FRESH · Docker 1.8s · PTH timeline 3.2s · events 0.4s
~~~

- 任一核心来源 lagging，整体状态至少为 `LAGGING`；
- 任一当前视图依赖来源 stale，相关甘特 lane 和折线冻结并加阴影；
- disconnected 时保留最后数据用于排障，但醒目标注“最后观测于 …”，不继续延长运行条；
- 用户暂停实时滚动时状态显示 `PAUSED`，服务端采样继续，恢复时先重取 snapshot；
- 缺失指标显示 `unknown`，不得用 0 维持折线连续。

### 6.5 时效性验收

验收使用可控时钟与故障注入，而不是只检查页面存在：

1. 记录 source observed、collector accepted、SSE emitted、browser applied 四个时间点；
2. 在稳定负载下计算 resource P95≤5s、activity P95≤2s、timeline P95≤10s；
3. 丢弃一条 SSE event，证明 5 秒 reconcile 窗口内恢复 durable 状态；
4. 注入 seq gap、epoch change、乱序、重复与晚到终态，证明触发 snapshot 或正确拒绝；
5. 停止 Docker/PTH 来源，证明在对应 stale/disconnected deadline 内冻结并降级；
6. 推进浏览器与服务端假时钟，证明 clock-skew warning 与校正 age 生效；
7. 制造慢浏览器/backpressure，证明内存有界且终态不丢失；
8. 所有 SLO 结果进入验收报告；任一分母为零不得判 PASS。

## 7. 页面行为

### 7.1 固定布局

1. 顶栏：scope、work mode、role、status、时间范围、实时/暂停；
2. KPI：active tasks、workers、queue、CPU、RSS、alerts；
3. 甘特图：可折叠 Job/Task/Intake/Optimize/Professional Run/Stage，加 service 辅助 lane；
4. 折线图：CPU、RSS、Heap、Network，共享甘特横轴；
5. 详情栏：所选区间的关联身份、状态、资源窗口和最近事件。

### 7.2 联动

- 选择区间：两张图同时高亮 `[startAt, endAt ?? freshness.sourceObservedAt]`；
- 在资源图刷选：甘特图缩放到相同窗口；
- 点击资源峰值：详情栏列出该时间点相交的 interval，但不宣称因果；
- 暂停实时：停止自动平移，不停止服务端采样；
- 恢复实时：重取 snapshot 后跳到当前窗口；
- 状态色固定：running cyan、completed green、waiting amber、failed red、stale grey。
- Work Mode 使用独立图形/筛选标记（intake/optimize/run），不得覆盖状态颜色或被解释为执行进度。

### 7.3 可访问性与降级

- 图形信息同时用文本、颜色和形状表达；
- 键盘可选择 lane、缩放时间窗和打开详情；
- 对 CPU/RSS/Network 提供表格化当前值与峰值；
- Docker 不可用时仍展示 PTH 时间线；PTH 不可用时仍展示服务和资源；
- 两者都不可用时保留页面壳并显示来源错误，不显示伪造 KPI。

## 8. 安全模型

### 8.1 O1–O4 本机模式

- 监听地址固定默认为 `127.0.0.1`，配置非 loopback 时启动失败；
- Docker Socket 只在 Node 服务端打开；
- PTH `runtime-observer` token 从只读 token file 或进程 secret 读取，不注入 HTML、不下发浏览器、
  不写日志；
- 认证钩子把 `runtime-observer` 限定在 runtime observe GET/SSE 路径；聚合器因此没有任务写、
  Worker 控制或 Knowledge 写权限；
- 输出 detail 使用字段白名单，错误字符串长度有界并移除 header/token/URL query secrets；
- 页面设置严格 CSP，禁止任意外部脚本与跨源请求；
- `/snapshot`、`/events` 和 `/health` 只接受本地连接；Host/Origin 不满足本地策略时拒绝。

### 8.2 O5 租户模式

O5 不复用“来自 loopback 即可信”的假设。它必须新增稳定 principal、session/token 生命周期、
tenant/space policy、访问审计、速率限制和 CSRF/Origin 边界。O5 未通过前，禁止把 O1–O4
反向代理到公网或共享网络。

## 9. 错误与恢复语义

| 故障 | 行为 |
|---|---|
| Docker Socket 不可达 | docker warning；PTH timeline 继续；资源值标 unknown |
| 单容器 stats 失败 | 保留容器 lane；该 target 本采样缺失，不写零值 |
| PTH timeout/5xx | pth warning；使用最后 snapshot 到 stale 阈值后冻结 |
| SSE 断开 | 指数退避；重连前先 GET snapshot；不盲目续接旧 seq |
| 聚合器重启 | 新 streamEpoch；浏览器清本地增量；资源历史显示 reset |
| 时间戳逆序 | 丢弃异常 sample、记录 warning，不改写旧样本 |
| interval end < start | PTH 投影层拒绝该行并计数；页面不渲染畸形区间 |
| 返回量超限 | 服务端截断并返回 warning/cursor，不做无界全量查询 |
| 浏览器渲染异常 | 不影响采集与 PTH；刷新后从 snapshot 恢复 |

resource/timeline 时效阈值以 §6.1 Freshness Contract 为准；Batch 自报健康仍使用
`PTH_BATCH_HEALTH_STALE_MS`，两者分别展示，不能互相覆盖。告警由观察值派生，不会触发
pause、restart、retry 或扩缩容。

## 10. 配置

O1–O4 只新增本机模式，不预埋未实现的 tenant 模式：

~~~text
PTH_RUNTIME_OBSERVATORY=off|local        default off
MONITOR_HOST=127.0.0.1                   non-loopback rejected in local mode
MONITOR_PORT=9090
MONITOR_INTERVAL_MS=2000                 range 1000..30000
MONITOR_PTH_RECONCILE_MS=5000            range 2000..30000
MONITOR_SNAPSHOT_VERIFY_MS=30000         must be >= reconcile interval
MONITOR_HISTORY_MS=3600000               max 28800000
MONITOR_PTH_URL=http://127.0.0.1:<port>
MONITOR_PTH_TOKEN_FILE=<read-only path>
~~~

现有 `DOCKER_SOCKET` 保留。所有数值配置在启动时 fail closed；无效值不得静默回默认。

## 11. 分层交付

### O0：设计与安全契约

- 冻结 DTO、时间语义、Freshness Contract、scope、feature flag 和 threat boundary；
- 为现有输入建立字段映射样例；
- 建立“不精确归因 Worker/Task 资源”的合同测试。

### O1：本机服务观测 MVP

- 扩展 Docker collector：inspect 生命周期 + resource ring buffer；
- 落已确认页面的服务甘特和资源曲线；
- 修正 `npm run monitor` 路径；
- 在无 PTH 的情况下独立验收。

### O2：PTH 执行时间线

- 落 RuntimeObservationFacade、数据层查询和三条 read-only endpoint；
- 投影 Task/Job/Intake/Batch，不新增业务表；
- 完成 tenant/time/limit 对抗测试。

### O3：统一联动与实时增量

- Docker Monitor 聚合 PTH snapshot/events，push 降低延迟、5 秒 reconcile 修复一致性；
- 浏览器只连接单一 snapshot/SSE；
- 完成时间轴联动、详情栏、断线和 epoch 恢复。

### O4：告警与运行验收

- heartbeat、queue、resource、task timeout、intake stalled 与 freshness SLO 告警；
- 真实 Docker + PTH 组合测试；
- 长时间采样与内存上限验证；
- feature-off、降级和回滚验证。

### O5：租户访问与持久历史

- 单独设计和验收 tenant-facing auth；
- 接 Prometheus-compatible history adapter；
- 增加 retention、downsampling、审计和成本边界。

实施依赖严格为 O0 → O1 → O2 → O3 → O4。O5 单独立项。O1 和 O2 可以分别验收，
但 O3 只能组合已经通过的两个读面。

## 12. 测试与验收

### 12.1 单元

- Docker stats、inspect 时间、resource delta 和 ring buffer 上限；
- interval 投影、父子关系、状态归一、时间异常；
- snapshot merge、epoch/seq、stale、warning 去重；
- UI 时间映射、选择联动和空/缺失数据格式化；
- sourceVersion、seq gap、晚到终态、clock skew 和 freshness 状态机。

### 12.2 路由与数据层

- `runtime-observer` 可读取本 tenant runtime observe，但访问任意任务、Worker、Knowledge 写路由均 403；
- tenant-agent 无法覆盖 tenant/space；platform-admin 行为显式；
- SQL tenant/time predicate 和 limit 在数据层生效；
- 任务正文、Knowledge 内容、token 和敏感 error 不出 DTO；
- `from > to`、24 小时以上窗口、limit 越界均 400；
- 2,000 条以上使用 cursor/warning，不无界返回。

### 12.3 组合

- Docker 可用/PTH 可用；Docker 失败/PTH 可用；Docker 可用/PTH 失败；二者失败；
- 初始 snapshot → SSE upsert → 断线 → snapshot 恢复；
- SSE 丢事件后在一个 reconcile 周期内恢复 durable 状态；
- running interval 终态转换不重复、不倒退；
- 选择摄入阶段后正确高亮关联 Batch 资源，不标注成阶段独占资源；
- 1 小时默认与 8 小时硬上限下，采样内存保持有界。

### 12.4 O4 最终门

1. feature 默认 off，旧 Docker Monitor 与 PTH API 回归通过；
2. 本机模式拒绝非 loopback 监听和非本地 Origin；
3. 浏览器产物、网络响应与日志均不包含 PTH token；
4. 跨 tenant/space 查询为零命中；
5. 甘特与折线共享窗口误差不超过一个采样周期；
6. resource、activity、timeline 的 P95 分别满足 5s、2s、10s，且样本分母均非零；
7. seq gap/epoch change/丢事件均触发 snapshot 纠偏，durable 状态误差窗口不超过 5s；
8. 所有来源故障均在合同期限内显示 lagging/stale/disconnected，不伪造健康或零值；
9. 看板停机、崩溃或重启不影响 Task/Intake 执行；
10. 告警没有任何生产写副作用；
11. focused、full regression、lint、配置与边界检查全部通过。

任一项缺失，O4 不得标完成，也不得开始 O5 公网或租户化部署。

## 13. 预期改动面

详细文件级拆分将在本设计确认后的实施计划中冻结。预期边界为：

- `deploy/docker-monitor/`：collector、ring buffer、aggregator、SSE、页面；
- `src/pth/contracts/`：只读 runtime observation DTO；
- `src/pth/application/`：RuntimeObservationFacade；
- `src/pth/gateway/`：runtime observe routes；
- `src/pth/kernel/storage/`：tenant/time-bound 查询 adapter；
- `src/pth/config/`：feature 与采样配置；
- `test/`：unit、route、PG、composition、security；
- `package.json`：修复 monitor 启动路径。

不修改 Knowledge Intake、Task lease、Worker control、Promotion、Memory 写路径或 PthModuleName。

## 14. 后续步骤

本设计经用户确认后，下一步编写逐文件、逐测试、逐提交的 N30 实施计划。实施计划先展开
O0–O1 的可执行任务；O2–O5 保留依赖、接口和验收门，直到前一层验收通过再展开下一层。
