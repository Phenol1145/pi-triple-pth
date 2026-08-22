> PTH（Pi-Triple-Heavy）文档 — 自耦自然语言解释器（解释即执行）
# API 参考

## 认证

所有 API（除 `/health`、`/metrics`）需要 Bearer token 认证。

```
Authorization: Bearer <token>
```

Token 存储在 Redis 中：

```
auth:token:{token} → {"tenantId": "xxx", "role": "tenant-agent"}
```

- `tenantId`：必填，标识租户
- `role`：可选，默认 `tenant-agent`。预留 `platform-admin` 用于未来全局管理

### 创建 token

```bash
redis-cli SET "auth:token:my-token" '{"tenantId":"my-team"}'
```

---

## 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（无需认证） |
| GET | `/metrics` | Prometheus 指标（无需认证） |
| GET | `/ws` | WebSocket 双向通信 |
| POST | `/api/v1/sessions` | 创建 Session |
| GET | `/api/v1/sessions` | 列出当前租户的 Session |
| GET | `/api/v1/sessions/:id` | 获取单个 Session |
| DELETE | `/api/v1/sessions/:id` | 销毁 Session |
| POST | `/api/v1/sessions/:id/prompt` | 发送 prompt（SSE 流） |
| POST | `/api/v1/sessions/:id/abort` | 中断正在执行的 prompt |
| GET | `/api/v1/self/tools` | 当前租户可用的工具列表 |
| GET | `/api/v1/self/version` | 平台版本信息 |

> 本节以上为交互式 Session API；engine 主工作面在 `/api/v1/kernel/*`。权威路由实现：
> `src/pth/gateway/routes-*.ts`；Console 消费子集见
> [pth-api-protocol.md](pth-api-protocol.md) 与 `docs/pth/pth-console-openapi.json`。

### kernel 主入口（子集）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/kernel/tasks` | 发布任务（`{title,text,tags?,payload?,idempotencyKey?}`） |
| GET | `/api/v1/kernel/tasks` · `/api/v1/kernel/tasks/:id` | 任务列表 / 单任务状态 |
| GET | `/api/v1/kernel/status` | kernel 全景（batch/tasks/watchdog/sandbox 聚合） |
| POST | `/api/v1/kernel/batch/add` · `/batch/remove` | batch 扩容/缩容 |
| POST | `/api/v1/kernel/batch/:id/workers` | worker 级 pause/resume/remove/add |
| GET | `/api/v1/kernel/lineage` · `/api/v1/kernel/roles` | 角色谱系 / 角色（roles 经 observe 域） |
| POST | `/api/v1/kernel/notebook/execute` | P5b：notebook cell 执行（`{language:python\|bash\|ts, code, sessionId?, timeoutMs?}`；无 sessionId 时新建并返回 sessionId） |
| POST | `/api/v1/kernel/notebook/cancel` | P5d：终止并销毁 notebook 会话（`{sessionId}`，不可恢复） |

notebook 会话语义：每 `sessionId` 一个独立 KernelManager（python/bash 状态隔离）；空闲 TTL
自动回收；cancel = abort + dispose，调用方重建 session。

---

## 端点详情

### `GET /health`

无需认证。返回服务状态。

```
GET /health
```

**响应** `200`：
```json
{
  "status": "ok",
  "uptime": 123.456
}
```

### `GET /metrics`

无需认证。返回 Prometheus text 格式指标。

```
GET /metrics
```

### `POST /api/v1/sessions`

创建新的 Agent Session。Session 创建后状态为 `idle`，可发送 prompt。

```
POST /api/v1/sessions
Content-Type: application/json
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `project` | string | 否 | 项目标识，默认 `"default"` |
| `provider` | string | 否 | 模型提供商（如 `deepseek`），不指定则自动检测 |
| `model` | string | 否 | 模型 ID（如 `deepseek-v4-flash`），不指定则用第一个可用 |
| `thinkingLevel` | string | 否 | 思考深度：`low` / `medium` / `high`，默认 `medium` |

**响应** `201`：
```json
{
  "sessionId": "ab23ba50-6443-439c-ac90-dd5a3f26ca92",
  "tenantId": "demo",
  "project": "my-project",
  "state": "idle",
  "model": "deepseek-v4-flash",
  "createdAt": "2026-07-27T07:43:51.027Z",
  "lastAccess": "2026-07-27T07:43:51.027Z"
}
```

**响应** `429`（超出限额）：
```json
{
  "error": "Tenant limit (5) reached"
}
```

### `GET /api/v1/sessions`

列出当前租户的所有 Session。

```bash
curl -s http://localhost:3000/api/v1/sessions \
  -H "Authorization: Bearer my-token"
```

**响应** `200`：
```json
[
  {
    "sessionId": "ab23ba50-...",
    "tenantId": "demo",
    "project": "my-project",
    "state": "idle",
    "model": "deepseek-v4-flash",
    "createdAt": "...",
    "lastAccess": "..."
  }
]
```

> 注：`model` 字段来自 session 创建时的 `ModelRouter.resolve()` 结果。如果创建时指定的模型不可用且 failover 失败，`model` 可能显示 `"unknown"`。

### `GET /api/v1/sessions/:id`

获取单个 Session 详情。

```bash
curl -s http://localhost:3000/api/v1/sessions/ab23ba50-6443-439c-ac90-dd5a3f26ca92 \
  -H "Authorization: Bearer my-token"
```

**响应** `200`：同上 Session 对象。

**响应** `404`：
```json
{ "error": "Not found" }
```

### `DELETE /api/v1/sessions/:id`

销毁 Session，释放 AgentSession 内存并清理 Redis 记录。

```bash
curl -s -X DELETE http://localhost:3000/api/v1/sessions/ab23ba50... \
  -H "Authorization: Bearer my-token"
```

**响应** `200`：
```json
{ "ok": true }
```

### `POST /api/v1/sessions/:id/prompt`

发送 prompt，**以 SSE（Server-Sent Events）流式返回**。

```
POST /api/v1/sessions/ab23ba50-.../prompt
Content-Type: application/json
```

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 发送给 Agent 的文本 |

**响应** `200`，`Content-Type: text/event-stream`：

```
data: {"seq":1,"type":"agent_start","data":{...},"terminal":false,"timestamp":"..."}

data: {"seq":2,"type":"turn_start","data":{...},"terminal":false,"timestamp":"..."}

data: {"seq":3,"type":"message_start","data":{...},"terminal":false,"timestamp":"..."}

data: {"seq":4,"type":"message_end","data":{...},"terminal":false,"timestamp":"..."}

data: {"seq":5,"type":"message_start","data":{"type":"message_start","message":{"role":"assistant",...}},"terminal":false,"timestamp":"..."}

data: {"seq":6,"type":"message_update","data":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}},"terminal":false,"timestamp":"..."}

... (more text_delta events)

data: {"seq":N,"type":"message_end","data":{...},"terminal":false,"timestamp":"..."}

data: {"seq":N+1,"type":"agent_end","data":{...},"terminal":true,"timestamp":"..."}

data: [DONE]
```

**错误响应**：流内推送 `event: error`：
```
event: error
data: {"error":"Session is busy"}
```

---

### SSE 事件格式

每个 SSE 事件格式：

```json
{
  "seq": 1,
  "type": "string",
  "data": { ... },
  "terminal": false,
  "timestamp": "2026-07-27T07:44:01.571Z"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `seq` | number | 事件序号（从 1 递增） |
| `type` | string | 事件类型 |
| `data` | object | 事件负载 |
| `terminal` | boolean | 最后一个事件为 `true` |
| `timestamp` | string | ISO 8601 时间戳 |

### 事件类型

| 类型 | 说明 |
|------|------|
| `agent_start` | Agent 开始处理 |
| `turn_start` | 新一轮开始 |
| `message_start` | 消息开始（user / assistant / system） |
| `message_update` | 消息增量更新（含 `assistantMessageEvent`） |
| `message_end` | 消息结束，含 `usage` 信息 |
| `tool_execution_start` | 工具调用开始 |
| `tool_execution_end` | 工具调用结束（含 `durationMs`、`isError`） |
| `agent_end` | Agent 处理完毕，`terminal: true` |

### `message_update` 子事件类型

`message_update.data.assistantMessageEvent.type` 可以是：

- `thinking_start` / `thinking_delta` — 推理过程（deepseek 等支持思考的模型）
- `text_delta` — 文本增量
- `tool_use` — 工具调用请求

### `POST /api/v1/sessions/:id/abort`

中断正在执行的 prompt。

```bash
curl -s -X POST http://localhost:3000/api/v1/sessions/ab23ba50.../abort \
  -H "Authorization: Bearer my-token"
```

**响应** `200`：
```json
{ "ok": true }
```

### `GET /api/v1/self/tools`

返回当前租户可用的工具名称列表。

```bash
curl -s http://localhost:3000/api/v1/self/tools \
  -H "Authorization: Bearer my-token"
```

**响应** `200`：
```json
{
  "tools": ["read", "bash", "edit", "write"]
}
```

### `GET /api/v1/self/version`

返回平台版本和运行时信息。

```
GET /api/v1/self/version
```

**响应** `200`：
```json
{
  "version": "0.1.0",
  "node": "v24.14.1",
  "platform": "darwin"
}
```

**响应** `401`（需要认证）：
```json
{ "error": "Missing authorization" }
```

---

## WebSocket

连接：`ws://localhost:3000/ws`

**认证**：WebSocket 连接也需要 Bearer token。在连接 URL 中传递：

```
ws://localhost:3000/ws?token=my-token
```

或在连接请求头中：

```
Authorization: Bearer my-token
```

> 注：当前实现通过 Fastify auth hook 验证 token，自动从 Redis `auth:token:{token}` 中提取 `tenantId`。未经认证的 WebSocket 连接将被拒绝。

### 发送消息

```json
{ "type": "prompt", "sessionId": "...", "text": "..." }
{ "type": "abort", "sessionId": "..." }
```

### 接收消息

```json
{ "type": "event", "sessionId": "...", "event": { "seq": 1, "type": "...", "data": {...}, "terminal": false, "timestamp": "..." } }
{ "type": "done", "sessionId": "..." }
{ "type": "error", "error": "..." }
```

---

## 错误格式

各端点返回的错误格式略有不同，常见模式：

**创建 session 限额错误**（429）：
```json
{ "error": "Tenant limit (5) reached" }
```

**认证错误**（401）：
```json
{ "error": "Missing authorization" }
```

**资源不存在**（404）：
```json
{ "error": "Not found" }
```

**abort 错误**：
- 403 Forbidden：`{ "error": "Forbidden: tenant mismatch" }`（跨租户访问）
- 404 Not Found：`{ "error": "Session not found: ..." }`
- 500：其他内部错误

**prompt 错误**（SSE 流内下发）：
```
event: error
data: {"error":"Session is busy"}
```

常见状态码：

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 401 | 认证失败 |
| 403 | 禁止访问（跨租户） |
| 404 | 资源不存在 |
| 429 | 超出限额（session 数达上限） |
| 500 | 内部错误 |

### 认证错误

```
GET /api/v1/sessions (无 token)
→ 401 {"error":"Missing authorization"}

GET /api/v1/sessions -H "Authorization: Bearer invalid"
→ 401 {"error":"Invalid token"}
```

### 租户隔离错误

跨租户访问 session 会返回 `Forbidden`：

```
POST /api/v1/sessions/other-tenant-session/prompt  (用 tenant-A 的 token 访问 tenant-B 的 session)
→ 流内 SSE event: error {"error":"Forbidden: tenant mismatch"}
```
