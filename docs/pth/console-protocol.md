# PTH Console 协议（v1）

> 适用范围：浏览器 ↔ PTH Console server、PTH Console server ↔ PTH、PTH Console server ↔ N30。
> 权威实现：`packages/pth-console/src/operator-console/*`；路由机器可读规范：`packages/pth-console/operator-console-openapi.json`。
> 本文档与 OpenAPI 若冲突，以 OpenAPI JSON 为准；契约测试 `test/pth-contracts/console-api-contract.test.ts` 负责防漂移。

## 1. 版本与兼容

- Console API 版本前缀：`/api/v1/...`。
- 无前缀旧路径 `/api/...` 由 server 过渡重写到 `/api/v1/...`（不保证永久保留；新客户端必须使用 v1）。
- `GET /api/v1/version` 返回服务身份与版本：
  `{ "api": "v1", "service": "ptl-operator-console", "version": "1.4.0" }`
- 破坏性变更只能新增 `/api/v2/...`，v1 行为冻结。

## 2. 安全模型

| 边界 | 规则 |
|---|---|
| 网络 | Console server 只监听 `127.0.0.1`；拒绝其他 host 参数 |
| 静态资源 | 只服务 `asset-manifest.json` 清单内文件；启动时校验 sha256，清单外文件 404 |
| CORS | 不开启；所有浏览器请求同源 |
| 认证 | 一次性 bootstrap token（64 位小写 hex）只出现在 URL fragment；兑换后服务端设置 `ptl-operator` HttpOnly+SameSite cookie，客户端立即 `history.replaceState` 清除 fragment |
| CSRF | 所有非 GET/HEAD 请求必须携带 `x-ptl-csrf`；同时校验 Host 与 Origin |
| 上游凭据 | PTH admin token 只存在于 Console server 内存；任何响应/静态资源/日志不包含 |
| 错误 | 上游正文永不回传浏览器；只回稳定 `code`、`message` 与可选 `requestId` |

## 3. 通用 HTTP 约定

### 请求
- `content-type: application/json` 当有 body。
- 需要会话的 GET：携带 `cookie: ptl-operator=<session>` 且 Host 正确。
- 写请求：额外携带 `origin` 与 `x-ptl-csrf`。

### 错误信封
所有非 2xx JSON 响应统一为：

```json
{ "error": { "code": "UPPER_SNAKE", "message": "人类可读脱敏信息", "requestId": "uuid（上游失败时）" } }
```

- `code` 只允许 `[A-Z][A-Z0-9_-]{0,63}`；客户端只应展示 `code`，不应解析 `message` 做控制流。

### 状态码约定
- `400` 参数错误；`401` 未认证/CSRF 错误；`403` Host/Origin 不符；`404` 未知路径；`405` 方法不允许；`409` 幂等冲突/重复预览；`410` 预览过期；`429` 预览积压；`502` 上游 PTH/N30 失败；`503` 通道未装配。

## 4. 会话

- `POST /api/v1/session/bootstrap` body `{token}`：成功 `200` `{ok,csrfToken,operatorPrincipalId,expiresAt}` 并 Set-Cookie；失败 `401 BOOTSTRAP_REJECTED`。
- `GET /api/v1/session`：`200 {ok,operatorPrincipalId,expiresAt}`；`401` 会话缺失/过期。
- `POST /api/v1/session/logout`：清除 cookie，`200 {ok:true}`。

## 5. 只读巡检（Debug/Memory/Config）

浏览器永远不直接接触 PTH；Console server 经 PTH v1 observe API 拉取，并在 `browser-dto.ts` 做唯一形状归一化。

- `GET /api/v1/debug/workers` → `{workers,tenant,space}`
- `GET /api/v1/memory/summary` → `{byType,totals}`
- `GET /api/v1/memory/entries?type&kind&status&anchor&cursor&limit` → `{items,cursor,total}`
- `GET /api/v1/memory/entries/:id` → memory item DTO
- `GET /api/v1/memory/entries/:id/revisions` → revision rows
- `GET /api/v1/config/ptl` / `GET /api/v1/config/pth` → `{items:[...]}`
- `GET /api/v1/roles` → `{items:[...]}`
- `limit` 只允许 1..100；非法即 400。

## 6. Work 原生动作

- `GET /api/v1/work/actions` → `{actions:[{mode,action,nativeKind,descriptor}],tenant,space}`
- `POST /api/v1/work/preview` `{mode,action,input}` → `200 {preview,tenant,space}`；preview 含 `previewId,previewDigest,summary,impact,nativeTarget,expiresAt,confirmation:"required"`。
- `POST /api/v1/work/submit` `{previewId,previewDigest,idempotencyKey}` → `200 {ref}`；同一 idempotencyKey 重放返回同一 ref。
- `POST /api/v1/work/evaluate` `{mode,kind,id,submittedAt}` → `200 {acceptance:{ref,accepted,evidence}}`。
- 高风险动作 UI 必须要求用户输入动作标签后才允许确认。

## 7. N30 只读代理

只允许三条路径：`GET /observe/`、`GET /observe/snapshot`、`GET /observe/events`（SSE）。

- 上游只来自服务端配置的 loopback `N30_URL`；浏览器 query 中 `url/target/upstream/baseurl/n30url/proxy` 一律 400。
- 双向剥离 `authorization/cookie/set-cookie/connection/proxy-*`。
- HTML ≤512 KiB，snapshot ≤5 MiB，超时 10s。
- SSE：最多 8 客户端，30s 心跳超时，浏览器断开即取消上游。

## 8. 幂等与因果

- Task publish 的 native idempotency key 为 tenant-scoped；DB 唯一索引 `(tenant_id, idempotency_key)`。
- `run/intake/optimize` 只能经登记的原生动作创建；WorkEnvelope 由服务端盖章，mode 不可原地修改。
- 所有写路径必须携带 `x-ptl-csrf`；跨模式必须创建新 workId 并保留 causationId。
