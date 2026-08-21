# FRACTA engine 执行面拓扑与协议面固定计划

> 状态：**约定已定；P0 协议面冻结已实现（2026-08-21）——P1–P3 待实施**。
> 三仓同源：pi-triple-deps / pi-triple-pth / pi-triple-ptl。任何变更三仓同步。
> 决策依据：`docs/adr/0001-fracta-engine-external-execution-surfaces.md`。
> 协议事实源：`@away_from/shared/execution`（execution/v1）；设计背景：`docs/execution-surface-v1-design.md`。

## 1. 约定（一句话）

**platform = FRACTA engine（engine）**。engine 只拥有 worker 实现与面向 LLM 的 interface；
**所有执行面都在外部实现**（sandbox 容器 / dev 容器 / 本地执行器），全部实现 `execution/v1`
服务端，以 engine 为唯一协议客户端连接。**先固定协议面，再迁移实现。**

```
                 engine（= FRACTA engine；当前代码名 PTH）
                 拥有：worker / role / loop / LLM interface
                 永不拥有：spawn、工具链、沙箱进程
                          │ 只发 ExecutionRequest（execution/v1，Bearer 认证）
      ┌───────────────────┼───────────────────┬────────────────────┐
      ▼                   ▼                   ▼                    ▼
 sandbox 容器        dev 容器          本地执行器（宿主机）       （未来新执行面）
 profile=           profile=           profile=host
 sandbox-untrusted  dev-container      Lean 首期落这里
 网络：sandbox-     网络：default       网络：default
 internal（egress 锁）                  （host.docker.internal）
```

## 2. 固定协议面（P0——先冻结，任何实现迁移都必须先过这里）

### 2.1 单一事实源

- 类型、校验、wire 常量、客户端全部来自 `@away_from/shared/execution`：
  `EXECUTION_PROTOCOL_VERSION = "execution/v1"`、`EXECUTION_WIRE`、`validateExecutionRequest`、
  `HttpExecutionClient`、`LocalBackend`、`DockerExecBackend`。
- **禁止任何执行面复制类型或手写第二份 wire**；新增执行面只允许 import 共享包。

### 2.2 固定 wire 面（每个执行面必须实现的最小集合）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/health` | liveness，无需认证 |
| GET | `/ready` | readiness（可选但建议；compose healthcheck 用） |
| GET | `/capabilities` | 能力声明 `ExecutionCapabilities` |
| POST | `/exec` | 同步执行；或 `stream:true` 返回 `{execId,status}` |
| GET | `/exec/:id` | stream 任务状态 `{status,result?}` |
| GET | `/exec/:id/stream` | SSE：`output`/`done` 事件 |
| POST | `/exec/:id/cancel` | 尽力取消，返回 `{ok}` |

- 错误信封：`{ error: { code, message } }`，code 只取 `EXECUTION_WIRE.errorCodes`。
- 不支持的 streaming/cancel 必须在 `capabilities` 里如实声明 `false`，客户端据此降级。

### 2.3 后端身份与信任档

新增共享类型（放 `@away_from/shared/execution/types.ts`）：

```ts
export interface ExecutionBackendDescriptor {
  id: string;                  // engine 内唯一后端名，如 "sandbox" | "local-lean"
  url: string;                 // 不含尾斜杠的 baseUrl
  profile: ExecutionProfile;   // 期望信任档：host | dev-container | sandbox-untrusted
  tokenEnv?: string;           // 认证 token 的环境变量名（值不落配置）
  pathMapping?: ExecutionPathMapping; // 可选：engine 路径 → 执行面路径
  required?: boolean;          // 缺此 backend 时 engine 是否拒绝启动
}

export interface HttpExecutionBackend extends ExecutionBackend {
  readonly descriptor: ExecutionBackendDescriptor;
}
```

规则（引擎侧 fail-closed）：

1. 客户端**不得自我提升 profile**；引擎只发该 backend 声明的 profile，执行面再校验一次。
2. 启动时 `GET /capabilities`：`version !== "execution/v1"` 或与 descriptor 期望冲突 → 该 backend 不可用。
3. `required: true` 的 backend 不可用 → 生产 strict 模式拒绝启动；dev 模式仅告警。
4. 每个 backend 沿用 `SANDBOX_DEGRADED_THRESHOLD` 的连续失败降级模型（per-backend 计数）。

### 2.4 引擎侧注册协议（P1）

- 配置中心新增 `PTH_EXEC_BACKENDS`（JSON 字符串，数组 of `ExecutionBackendDescriptor`，
  `tokenEnv` 只引用环境变量名）。
- bootstrap 的 `buildPthHost` 构建 `BackendRegistry`：descriptor → `HttpExecutionBackend`。
- 现有专业适配器（lean4 / assembly / computational-chemistry / wolfram / jupyter）
  已经统一到 `ExecutionBackend` 参数——P1 只改装配：按 `id` 或按 `profile` 解析后端，
  不再走「无前缀即 LocalBackend（容器内直跑）」的默认。
- 兼容期：`execPrefix` → `DockerExecBackend` 路径保留给 PTL 侧测试注入，不作为生产默认。

### 2.5 路径映射（本地执行器必需的协议项）

engine 容器的 workspace 是 `/data/workspaces`，宿主机本地执行器看不到这个路径。
约定：本地执行器必须声明 `pathMapping: true`，引擎请求携带
`pathMapping: { hostRoot: "/data/workspaces", execRoot: "<host-side workspace root>" }`，
执行面只接受已登记映射并做前缀翻译；未登记映射一律 `CWD_NOT_ALLOWED`。

## 3. 现状 → 目标矩阵

| 执行面 | profile | 协议状态 | 差距 |
|---|---|---|---|
| sandbox 容器 | `sandbox-untrusted` | ✅ `/exec`、SSE、cancel、capabilities 已对齐 execution/v1 | 无（保持 sandbox-internal egress 锁，不动网络） |
| dev 容器 | `dev-container` | ❌ 只是工具容器，无 `/exec` HTTP 面 | 需新增 execution/v1 server（复用 shared 类型） |
| 本地执行器 | `host` | ❌ `LocalBackend` 只在进程内 | 需新增 execution/v1 server + pathMapping；首期承载 Lean |
| engine 侧 | — | ⚠️ 适配器已接 `ExecutionBackend`，但装配仍是 LocalBackend/DockerExecBackend 硬编码 | 需 BackendRegistry + `PTH_EXEC_BACKENDS` |
| Lean 工具链 | — | ❌ 在 engine 镜像内（`deploy/Dockerfile` 装 elan/lean/lake） | 从镜像移除，改由本地执行器提供 |

## 4. 优先级计划（协议面优先）

### P0 协议面冻结（pi-triple-deps，无行为迁移）

**状态：✅ 已实现（2026-08-21）；npm 发布待办。**

1. ✅ shared 增加 `ExecutionBackendDescriptor` + `HttpExecutionBackend`（封装
   `HttpExecutionClient`：id、descriptor、capabilities 缓存与 profile 校验）。
   实现：`packages/shared/src/execution/types.ts` · `validate.ts` · `backends/http.ts`；
   barrel 经 `@away_from/shared/execution` 导出。
2. ✅ 契约测试：`test/unit/execution-http-backend.test.ts`——golden descriptor JSON、
   capabilities version 不匹配、sandbox-untrusted 安全不变量、profile 自提升拒绝、
   pathMapping 注入、stream/pathMapping 能力前置拒绝。
3. ⏳ 发布 `@away_from/shared` 新版本，PTH/PTL lock 升级（npm 发布为用户动作）。
4. ✅ 退出门（代码/测试）：deps lint/build 绿，15 files / 93 tests 全绿；三仓文档同步。

### P1 engine 后端注册与路由（pi-triple-pth）

1. `config/schema.ts` 增加 `PTH_EXEC_BACKENDS`；`bootstrap/pth-host.ts` 构建 registry。
2. 专业适配器按 backend id 解析；删除「容器内 LocalBackend 直跑」作为生产默认
   （dev 模式 `PTH_CONFIG_STRICT=0` 可显式保留）。
3. sandbox 后端从 registry 解析（`SANDBOX_URL` 兼容别名，不破坏现网）。
4. **退出门**：pth 全量测试绿；不配置任何 backend 时 strict 模式拒绝启动、dev 模式告警。

### P2 Lean 外移 + 本地执行器（pi-triple-ptl 为主，pth 联动）

1. 按 §5 开发指南实现本地执行器（宿主机，默认 `127.0.0.1:8787`，Bearer 认证，
   `pathMapping` 指向宿主 workspace 根）。
2. `deploy/Dockerfile` 移除 elan / lean / lake 安装段；镜像构建验证不再依赖 Lean 网络源。
3. compose 为 engine 增加 `extra_hosts: host.docker.internal:host-gateway`，并注入
   `PTH_EXEC_BACKENDS` 含 `local-lean`（`profile: "host"`）。
4. `lean4-runtime-adapter` 默认解析 `local-lean`；`PTH_LEAN4_TOOLCHAIN_EXEC` 前缀仅在
   测试/临时容器场景使用。
5. **退出门**：`lean --version`、`lake build` 样例经 engine → 本地执行器全链路通过；
   engine 镜像不再含 Lean；超时/输出上限/错误信封契约测试通过。

### P3 dev 容器成为执行面（pi-triple-ptl）

1. dev 容器内新增 execution/v1 server（与本地执行器同一参考实现，profile 改
   `dev-container`）；compose 把 dev 加入 engine 可达网络并注入 token。
2. registry 增加 `dev` 后端；PTL 侧 `DockerExecBackend` 保留为 `ptl` 运维直连通道，
   不再作为 engine 协议路径。
3. **退出门**：engine 可经 HTTP 在 dev 容器执行 python/bfc/yt-dlp 类命令；
   DockerExecBackend 测试不回退。

### P4 后续（不在本轮）

- assembly / wolfram / jupyter / computational-chemistry 按需路由到 dev/本地执行面；
- sandbox kernel-host lease API 的 wire 版本化（与 execution/v1 同轨）；
- engine 品牌/服务名迁移（独立立项，不在协议面范围内）。

## 5. 本地执行器开发指南（Lean 首期参考实现）

### 5.1 定位与安全基线

- 一个宿主机长驻进程：实现 `execution/v1` 的最小服务端，内部用 `@away_from/shared` 的
  `LocalBackend`（或等价 spawn）执行命令。
- 只监听 `127.0.0.1`；engine 容器经 `host.docker.internal` 访问。
- 认证：Bearer token（如 `LOCAL_EXEC_SHARED_SECRET`），`/health` 除外；
  常数时间比较，失败返回 `401 UNAUTHORIZED`。
- profile 固定 `host`：请求体自报 `dev-container`/`sandbox-untrusted` 一律
  `INVALID_REQUEST`（客户端不得自我提升）。
- 不在本执行器内实现沙箱语义；它只服务宿主机已信任的工作区。

### 5.2 最小实现清单

| 项 | 内容 |
|---|---|
| 依赖 | `@away_from/shared@^1.5`（execution 子路径）+ Node ≥22 内置 `node:http` 即可 |
| 工具链 | 执行器进程 PATH 能找到 `lean` / `lake`（elan 正常安装即可） |
| capabilities | `{ version:"execution/v1", streaming:false, cancel:false, cwdWhitelist:false, uidIsolation:false, egressLocked:false, pathMapping:true }` |
| pathMapping | 启动参数/配置登记 `hostRoot → execRoot` 映射；`POST /exec` 先翻译 `cwd`，再交给 LocalBackend |
| 硬约束 | 超时杀进程组、stdout/stderr 上限截断、`ExecutionResult` 形状（LocalBackend 已实现） |

### 5.3 参考骨架

```ts
// local-exec-server.ts —— 本地执行器参考实现（execution/v1 server，profile=host）
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  LocalBackend, validateExecutionRequest, ExecutionClientError,
  EXECUTION_WIRE, type ExecutionCapabilities, type ExecutionRequest, type ExecutionPathMapping,
} from "@away_from/shared/execution";

const PORT = Number(process.env.LOCAL_EXEC_PORT ?? 8787);
const TOKEN = process.env.LOCAL_EXEC_SHARED_SECRET;
if (!TOKEN) throw new Error("LOCAL_EXEC_SHARED_SECRET must be set");

const CAPABILITIES: ExecutionCapabilities = {
  version: EXECUTION_WIRE.version,
  streaming: false, cancel: false,
  cwdWhitelist: false, uidIsolation: false, egressLocked: false,
  pathMapping: true,
};

// 仅接受已登记映射：引擎容器路径 → 宿主机路径
const MAPPINGS: ExecutionPathMapping[] = [
  { hostRoot: "/data/workspaces", execRoot: process.env.LOCAL_EXEC_WORKSPACE_ROOT ?? "" },
].filter((m) => m.execRoot !== "");

function mapCwd(cwd: string | undefined, mapping?: ExecutionPathMapping): string | undefined {
  if (!cwd) return cwd;
  if (!mapping) throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.cwdNotAllowed,
    "no pathMapping registered for this request");
  if (!cwd.startsWith(mapping.hostRoot))
    throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.cwdNotAllowed, `cwd outside hostRoot: ${cwd}`);
  const rel = cwd.slice(mapping.hostRoot.length).replace(/^\/+/, "");
  return rel ? `${mapping.execRoot}/${rel}` : mapping.execRoot;
}

function authed(req: IncomingMessage): boolean {
  const got = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(got); const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const backend = new LocalBackend({
  defaultTimeoutMs: 120_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 4 * 1024 * 1024,
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === EXECUTION_WIRE.paths.health) return send(res, 200, { status: "ok" });
  if (req.method === "GET" && url.pathname === EXECUTION_WIRE.paths.capabilities) return send(res, 200, CAPABILITIES);
  if (req.method !== "POST" || url.pathname !== EXECUTION_WIRE.paths.exec)
    return send(res, 404, { error: { code: EXECUTION_WIRE.errorCodes.notFound, message: "not found" } });
  if (!authed(req)) return send(res, 401, { error: { code: EXECUTION_WIRE.errorCodes.unauthorized, message: "unauthorized" } });

  try {
    const body = (await readBody(req)) as ExecutionRequest;
    const request = validateExecutionRequest(body, { timeoutMs: 120_000 });
    if (request.profile !== undefined && request.profile !== "host")
      throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.invalidRequest, "only profile=host is accepted");
    if (request.stream) throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.invalidRequest, "streaming not supported");
    const result = await backend.execute({
      ...request,
      cwd: mapCwd(request.cwd, request.pathMapping ?? MAPPINGS[0]),
      pathMapping: undefined,          // 映射已在本服务端消费
    });
    send(res, 200, result);
  } catch (e) {
    const err = e instanceof ExecutionClientError ? e
      : new ExecutionClientError(EXECUTION_WIRE.errorCodes.backendUnavailable, String(e));
    send(res, 400, { error: { code: err.code, message: err.message } });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`local exec surface on 127.0.0.1:${PORT}`));

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
```

### 5.4 engine 侧接线（compose / env）

```yaml
# deploy/docker-compose.yaml · pi-platform 服务
extra_hosts:
  - "host.docker.internal:host-gateway"
environment:
  - PTH_EXEC_BACKENDS=[{"id":"sandbox","url":"http://sandbox:8080","profile":"sandbox-untrusted","tokenEnv":"SANDBOX_SHARED_SECRET","required":true},{"id":"local-lean","url":"http://host.docker.internal:8787","profile":"host","tokenEnv":"LOCAL_EXEC_SHARED_SECRET","pathMapping":{"hostRoot":"/data/workspaces","execRoot":"/Users/<you>/pi-triple-pth/.pi-platform-data/workspaces"}}]
  - LOCAL_EXEC_SHARED_SECRET=${LOCAL_EXEC_SHARED_SECRET:?LOCAL_EXEC_SHARED_SECRET must be set}
```

Lean 请求形态（engine 侧 `lean4-runtime-adapter` 构造）：

```json
{ "cmd": ["lake", "build"], "cwd": "/data/workspaces/<tenant>/<project>",
  "timeoutMs": 120000, "maxStdoutBytes": 1048576, "maxStderrBytes": 1048576,
  "profile": "host", "pathMapping": { "hostRoot": "/data/workspaces", "execRoot": "<host workspace root>" } }
```

### 5.5 验收清单

- [ ] `curl /health` 无 token 通过；`curl /capabilities` 返回 `pathMapping:true`
- [ ] 错误 token → `401 UNAUTHORIZED`；请求自报 `sandbox-untrusted` → `400 INVALID_REQUEST`
- [ ] `lean --version` 经 `/exec` 返回 `exitCode:0` 与版本输出
- [ ] `lake build` 在映射后的宿主 workspace 执行成功（engine 内 `cwd=/data/workspaces/...` 可用）
- [ ] 超时命令被杀进程组，`timedOut:true`；超过输出上限 `truncated` 存在
- [ ] 未登记 pathMapping → `CWD_NOT_ALLOWED`
- [ ] engine 容器 `curl http://host.docker.internal:8787/health` 可达

## 6. 网关边界（2026-08-21 裁决：暂不引入统一网关）

**现状保持直连**，不新增 nginx / HAProxy 等统一网关：

- **北向**：pth CLI / web UI 继续直连 engine `:3000`（compose 唯一对外发布端口，已天然单入口）。
- **南向执行面**：engine 继续经 `PTH_EXEC_BACKENDS` registry 直连各执行面；不插入物理代理、
  不做 `/sandbox`、`/dev` 这类前缀重写（execution/v1 的 registry 就是逻辑网关）。
- **数据面**：engine 直连 Redis / PostgreSQL（compose DNS）；PG 连接池需要时按既定路线
  引入 PgBouncer，Redis 多节点用 Cluster/Sentinel——**都不走通用网关**。
- **安全**：sandbox 的 `sandbox-internal` egress 锁不变。

**引入北向网关的触发条件**（满足任一即重新评估，而不是直接实施）：

1. 需要从非 localhost 暴露 engine 且必须 TLS 终结；
2. 出现多 engine 实例、灰度 / canary 路由需求；
3. 需要边缘统一鉴权 / 租户隔离 / 限流 / 集中审计；
4. 需要跨服务统一 request-id / access log 口径（engine 内部日志已覆盖时不算）。

**将来引入时的硬约束**：

- 网关只反代 HTTP(S) 北向流量（CLI / web UI → engine）；
- 不代理 PG / Redis（专用组件替代）；不拦截南向 `execution/v1` 数据面；
- SSE / WebSocket 必须关闭缓冲（`proxy_buffering off`、正确的 upgrade 头）；
- engine 对各执行面的 baseUrl 仍保持直连，不改成网关前缀。

## 7. 变更纪律

1. 本计划任何变更先改本文件（三仓同源同步），再改代码；
2. 协议类型/常量只改 `pi-triple-deps` 的 `packages/shared/src/execution/**`，随后 npm 发布；
3. engine 侧装配只改 `bootstrap/` 与 `config/schema.ts`，adapter 保持 `ExecutionBackend` 参数不变；
4. 每阶段退出门含全量测试 + 三仓文档同步。
