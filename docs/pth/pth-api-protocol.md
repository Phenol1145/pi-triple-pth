# PTH HTTP API 协议（v1，Console-facing subset）

> 权威路由实现：`src/pth/gateway/routes-*.ts`。
> 机器可读子集：`docs/pth/pth-console-openapi.json`。
> 安全前提：PTH admin token 只在 Console server 内存；浏览器永远不直接接触 PTH。

## 1. 版本

- 对外 HTTP 路径统一 `/api/v1/*`。
- 破坏性变更新增 `/api/v2/*`；v1 行为冻结。
- 返回 JSON；错误见 §3。

## 2. 认证与租户

- 所有请求需要 `Authorization: Bearer <token>`（由 Console server 持有）。
- `tenantId`/`space` 从服务器端认证声明派生；请求 body/query 不得覆盖。
- 跨租户访问一律 401/404/空结果，不得泄露存在性。

## 3. 错误信封

PTH 内部错误统一为：

```json
{ "error": "稳定错误描述" }
```

- 400 参数/状态机错误；401 未认证；404 未知路径/不可见；503 facade 未装配。
- 领域状态机冲突（如 intake stage 错序）由具体路由返回结构化 `{error,code?,details?}`，以路由 OpenAPI 为准。

## 4. Console 只读巡检（observe）

| 路径 | 说明 |
|---|---|
| `GET /api/v1/observe/workers` | WorkerInspection[]，不含 prompt/content/secret |
| `GET /api/v1/observe/memory/summary` | 五类记忆 count/bytes |
| `GET /api/v1/observe/memory/entries` | 分页 `{items,nextCursor}`；limit 1..100 |
| `GET /api/v1/observe/memory/entries/:id` | 单条 MemoryListItem |
| `GET /api/v1/observe/memory/entries/:id/revisions` | `{entryId,revisions}`；可见性与 detail 同一谓词 |
| `GET /api/v1/observe/config` | ConfigInspectionEntry[]，secret 恒 `***` |
| `GET /api/v1/observe/roles` | RoleInspection[] |
| `GET /api/v1/observe/timeline` | durable runtime timeline（N30 合并基线） |
| `GET /api/v1/observe/runtime/events` | SSE 事件流（N30 消费） |

## 5. 写路径

### 任务发布
- `POST /api/v1/kernel/tasks`
- body：`{title,text,tags?,payload?,idempotencyKey?}`
- 201：`{id,status,...}`
- 幂等：`idempotency_key` 在 `(tenant_id, idempotency_key)` 上唯一；同 key 重放返回首次任务。
- `createdBy`/`tenantId`/`workMode` 由服务端盖章，body 值被忽略。

### Intake（原生动作）
- `POST /api/v1/intake/subscriptions`：创建订阅；body 包含 `idempotencyKey` 与 expected policy 指纹。
- `POST /api/v1/intake/runs`：手动触发一次摄入 run；必须 `idempotencyKey`。
- `GET /api/v1/intake/subscriptions/:id` / `GET /api/v1/intake/runs/:id`：状态查询（tenant 域内）。
- 状态推进只在服务端状态机内发生；客户端不得自报 stage。

### Optimizer
- `POST /api/v1/kernel/optimizer/apply`：应用建议；tenant 由认证派生。

### Trigger 管理（增强）
- `POST /api/v1/kernel/triggers` body 支持：
  - `schedule: { everySec }`（定时源；与 `event` 至少其一）
  - `action: { type, params }`（原生 action；与 `task` 至少其一）
  - `task.template + task.params`（模板任务）
  - `task.retask: true`（重发布原任务）
  - `task.flow: FlowSpec`（完整 FlowSpec，由 TaskResolver 执行）
- 注册期校验：`task`/`action` 至少其一；`event`/`schedule` 至少其一；flow 经 `validateFlow`；任务路由经 `checkTaskRouting`。

### Human Review（N25）
- `POST /api/v1/human-requests`：创建人工请求，任务进入 `waiting-human`。
  - body：`{taskId, kind, title, body, assignedTo?, policySelector?, expiresAt?, idempotencyKey?}`
  - `tenantId`/`principalId`/`createdBy` 由服务端 auth 盖章，body 不得自报。
- `GET /api/v1/human-requests`：列表（`?status=&limit=`，tenant 域内）。
- `GET /api/v1/human-requests/:id`：详情。
- `POST /api/v1/human-requests/:id/responses`：`{decision: "approved"|"rejected", reason?, idempotencyKey?}`；CAS + 幂等。
- `POST /api/v1/human-requests/:id/cancel`：取消请求并把任务回 `pending`。

### Notebook execute（ExecutionTarget）
- `POST /api/v1/kernel/notebook/execute` body 新增 `target?: string | null`。
- `target` 来自 pi-kernel cell magic（`%%python sandbox` / `%%bash local-lean` / `%%ts`）；缺省按语言默认 ExecutionTarget（python/bash→sandbox，ts→engine-ts）。
- 响应新增 `target?: string`（实际命中的 ExecutionTarget id，观测用）。

## 6. SSE

- `GET /api/v1/observe/runtime/events`：`text/event-stream`；事件为 JSON 信封 `{seq,type,data,terminal?,timestamp}`。
- 客户端断连后重连应从最近 durable timeline 对账，不得信任内存中的 seq 缺口。

## 7. 幂等与因果

- 所有外部创建边界均接受 `idempotencyKey`（1..128 字符，tenant-scoped）。
- WorkEnvelope 由服务端构造：`workId` 全局唯一；`causationId` 完整保留；mode 不可原地修改。
- 重试必须使用同一 `idempotencyKey` 与同一 payload digest；冲突返回 409。

## 8. 兼容性测试

- `test/pth-contracts/console-api-contract.test.ts` 校验 Console OpenAPI ↔ 实现。
- PTH OpenAPI 子集在 `docs/pth/pth-console-openapi.json`；新增 Console 消费的 PTH 路由必须同时更新该文件与测试。

## 2026-08 新增路由

- `POST /api/v1/kernel/tasks/:id/answer`：人工回答 paused 任务。
- `GET /api/v1/kernel/tasks?status=paused`：待回答问题箱。
- `POST /api/v1/human-requests` 及响应/取消：通用人工审核（详见 [workflow-trigger-human-review-correction-plan](plan/workflow-trigger-human-review-correction-plan.md)）。
- `POST /api/v1/kernel/notebook/execute`：ExecutionTarget 路由（详见 [execution-target-matrix-plan](plan/execution-target-matrix-plan.md)）。
