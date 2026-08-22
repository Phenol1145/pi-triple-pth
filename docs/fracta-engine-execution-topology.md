# FRACTA engine 执行面拓扑与协议面固定计划

> 状态：**P0 + P0.1 + P1 + P2 已实现并实测（execution/v1.1 模式框架 + ExecutionHttpServer + engine 后端注册硬切路由 + 本地执行器/Lean 外移全链路通过）；T2 + T3 + T4 已实现并实测（manifest 规范/回环注册表/pth tools 命令面/统一镜像 + tool-server + compiled gateway + secrets pty + 三域真实住户迁移 + v13-asm-toolchain 吸收与 assembly 路由）；宿主服务监督器已实现（pth services 管理 local-lean/local-u8 进程 + services.json 自动注册）；CLI 归属纠偏完成（local-exec 归 pth、ptl stack deprecated、TUI 下线）；npm 全量发布完成（2026-08-22：shared 1.7.4 + infra 1.6.0 + framework/mailbox/dev-container/pth-console/pth-memory/pth-sandbox/pth-cli 1.6.x，含 @away_from/pth-cli 瘦包）；部署密钥已轮换（2026-08-22 泄露后全部换新）；栈级验收通过（sandbox healthy + assembly/lean4 双专业 runtime satisfiesLock）；u8proj 本地执行器接入：U8-1 全链已实现并实测（u8-runtime-adapter + u8→local-u8 默认路由 + engine compile/run vertical，专业角色另立项；U8-2 待接线——persistent 基础 P4 已就绪）；GHCR release 待凭据实测；P4 已实现并实测（shared persistent 1.7.x + sandbox /sessions 宿主 + engine SandboxKernel 迁移 + 容器内 python/bash vertical 通过；legacy /kernel lease 路由 deprecated 待清理）；P5 Jupyter 已实现主体并 vertical 通过（南面 engine→jupyter→nbclient 无头执行；北面 JupyterLab :8888 + 宿主 pth 只读挂载透传；pi-kernel provider → engine notebook API 状态化 cell 执行 + cancel 端点；剩余体验收尾）；P6 pth CLI 运行时剖面统一入口设计定稿（`pth doctor`/`up --profile`/`status --all`，实现待开，见 docs/pth/p6-pth-cli-runtime-profiles-design.md）。**
> 三仓同源：pi-triple-deps / pi-triple-pth / pi-triple-ptl。任何变更三仓同步。
> 决策依据：`docs/adr/0001-fracta-engine-external-execution-surfaces.md`、
> `docs/adr/0002-tool-containers-execution-v11.md`。
> 协议事实源：`@away_from/shared/execution`（execution/v1.1 模式框架）；设计背景：`docs/execution-surface-v1-design.md`。

## 1. 约定（一句话）

**platform = FRACTA engine（engine）**。engine 只拥有 worker 实现与面向 LLM 的 interface；
**所有执行面都在外部实现**（sandbox / tool containers / 本地执行器 / jupyter），全部实现
execution 服务端。协议客户端 = **pth 产品面（engine + pth CLI）**；pth CLI 仅 127.0.0.1
回环访问 tool containers。**先固定协议面，再迁移实现。**

```
                 engine（= FRACTA engine；当前代码名 PTH）
                 拥有：worker / role / loop / LLM interface
                 永不拥有：spawn、工具链、沙箱进程
                        │ 只发 ExecutionRequest（execution/v1.1，Bearer）
        ┌───────────────┼───────────────┬─────────────────┬──────────────┐
        ▼               ▼               ▼                 ▼              ▼
  sandbox 容器    tool containers   本地执行器        jupyter 服务    （未来执行面）
  profile=        compiled/network   profile=host      单容器双面
  sandbox-        /secrets           Lean 落这里       北:8888/南:engine
  untrusted       127.0.0.1 回环      host.docker.internal
  网络：sandbox-internal（egress 锁）保持
```

## 2. 固定协议面（P0 基线 execution/v1；v1.1 模式框架见 §5.6）

### 2.1 单一事实源

- 类型、校验、wire 常量、客户端、服务端全部来自 `@away_from/shared/execution`：
  `EXECUTION_PROTOCOL_VERSION = "execution/v1"`、`EXECUTION_WIRE`、`validateExecutionRequest`、
  `HttpExecutionClient`、`LocalBackend`、`DockerExecBackend`；v1.1 增量 =
  `resolveExecutionMode`、`validateExecutionCapabilities`、`HttpExecutionClient.interactive`、
  `ExecutionHttpServer`（HTTP+WS + 模式路由 + Bearer 常数时间比较）。
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
- v1.1 增量：`GET /exec/:id/ws`（interactive，按 `capabilities.modes.interactive` 提供）与
  `/sessions*`（persistent，P4 已实现并实测）。服务端统一实现 = shared `ExecutionHttpServer`；
  sandbox 为**兼容宿主例外**（Fastify 手写 `/exec` + `/sessions`，wire 与 shared 对齐，
  后续收口，见 P4/§5.6）。

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
2. 启动时 `GET /capabilities`：`version ∉ { execution/v1, execution/v1.1 }` 或与 descriptor 期望冲突 → 该 backend 不可用。
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
| sandbox 容器 | `sandbox-untrusted` | ✅ `/exec`、SSE、cancel、capabilities 对齐 execution/v1；P4 已实现 persistent `/sessions`（capabilities 升 v1.1 并声明 persistent=true） | legacy `/kernel/acquire\|execute\|…` 路由 deprecated 待清理；interactive 不提供（如实声明 false） |
| tool containers（原 dev 容器） | `dev-container`（域 = compiled/network/secrets；由宿主回环注册表合成） | ✅ T2–T4：manifest + 统一镜像 + tool-server/pty + compiled gateway，execution/v1.1 对齐并实测 | GHCR 多架构发布 + digest 钉版待凭据实测 |
| 本地执行器 | `host` | ✅ P2：`pth local-exec`（v1.1 + pathMapping）+ `pth services` 监督 local-lean/local-u8；U8-1 adapter+路由已闭环 | 其余本地域按需扩展 |
| jupyter 服务 | `host`（south server 与 engine descriptor 均固定 host） | ✅ 南面 execution/v1.1 :8889 + 北面 JupyterLab :8888 + pth 宿主挂载透传 + pi-kernel → engine notebook API；无头与 notebook vertical 均通过 | Lab 内 interrupt 交互细化/体验收尾 |
| engine 侧 | — | ✅ P1+P2：BackendRegistry + `PTH_EXEC_BACKENDS`/`PTH_EXEC_BACKEND_ROUTES` 硬切路由 + tool/service 注册表合并消费；P4 已迁移 SandboxKernel 到 /sessions | interactive 消费语义（待真实 TTY 场景）；legacy 清理待办；品牌/服务名迁移另立项 |
| Lean 工具链 | — | ✅ 已从 engine 镜像移除，由 `local-lean` 宿主执行器提供（P2 实测） | 无（首期闭环完成） |

## 4. 优先级计划（协议面优先）

### P0 协议面冻结（pi-triple-deps，无行为迁移）

**状态：✅ 已实现并发布（2026-08-21 实现；2026-08-22 发布 `@away_from/shared@1.6.0` + `@away_from/infra@1.6.0`）。**

1. ✅ shared 增加 `ExecutionBackendDescriptor` + `HttpExecutionBackend`（封装
   `HttpExecutionClient`：id、descriptor、capabilities 缓存与 profile 校验）。
   实现：`packages/shared/src/execution/types.ts` · `validate.ts` · `backends/http.ts`；
   barrel 经 `@away_from/shared/execution` 导出。
2. ✅ 契约测试：`test/unit/execution-http-backend.test.ts`——golden descriptor JSON、
   capabilities version 不匹配、sandbox-untrusted 安全不变量、profile 自提升拒绝、
   pathMapping 注入、stream/pathMapping 能力前置拒绝。
3. ✅ 发布 `@away_from/shared@1.6.0` + `@away_from/infra@1.6.0`（2026-08-22；PTH/PTL lock 升级）。
4. ✅ 退出门（代码/测试）：deps lint/build 绿，15 files / 93 tests 全绿；三仓文档同步。

### P0.1 execution/v1.1 模式框架（pi-triple-deps，与 P0 合并发布）

**状态：✅ 已实现并发布（2026-08-22；shared/infra 1.6.0 + PTH/PTL lock 升级）。**

1. ✅ `ExecutionRequest.mode` + capabilities `modes` 位图 + `MODE_NOT_SUPPORTED`；
   `interactive` = WS `/exec/:id/ws`（stdin/stdout/stderr/resize/pty）；`persistent`
   wire 规范定稿（`/sessions*` 路径 + session 校验 + lease 5s..24h）；
   2026-08-22 已实现并发布：`ExecutionSessionManager` + `ExecutionHttpServer` /sessions
   + `HttpExecutionClient` 会话 API（`@away_from/shared@1.7.1`）。
2. ✅ shared 增加 `ExecutionHttpServer`（HTTP+WS、模式路由、Bearer 常数时间比较、
   结构化错误信封）与客户端 `interactive()` 会话；旧 `stream:true` 字段映射保留，
   v1 请求字节形状不注入 mode。
3. ✅ 契约测试：16 files / 113 tests（v1.1 新增 20：模式能力声明、未声明模式拒绝、
   WS 消息帧、SSE 回放、v1/v1.1 客户端分支、v1.0 fail-closed、persistent 规范）。
4. ✅ 发布 `@away_from/shared@1.6.0`（P0 + P0.1 合并产物，一次发布；PTH/PTL lock 升级）。

### P1 engine 后端注册与路由（pi-triple-pth）

**状态：✅ 已实现（2026-08-22；`execution/backend-registry.ts` + 组合根接线 + 专业 runtime 硬切路由）。**

**裁决（2026-08-21）：立即硬切——删除隐式 LocalBackend 直跑。未路由 runtime 一律
unregistered；dev 也必须显式配置 backend 或 legacy execPrefix。**

前置：发布 `@away_from/shared@1.6.0`（P0 + P0.1 合并产物）并升级 PTH lock；本地开发
可先用 Verdaccio 预发布包验证。registry 按 capabilities 协商 v1/v1.1。

#### P1.0 顺带修复（生产专业 runtime 装配空洞）

`batch-process.ts` 现调 `assembleProfessionalRuntimeRegistry({ lock, factories })` 未传
`artifactPath`，而全部默认 factory 都以 `artifactPath !== undefined` 为前置 → 生产 batch
实际注册零 adapter。P1 必须传 `artifactPath: deps.artifactPath`（workDir/packagesDir 等
继续由 adapter 从配置中心读取）。

#### P1.1 配置面（`config/schema.ts` + `config-center.ts`）

`ConfigGroup` 增加 `"execution"`；新增：

| key | type | 默认 | 说明 |
|---|---|---|---|
| `PTH_EXEC_BACKENDS` | json | `""` | `ExecutionBackendDescriptor[]`（shared 校验器解析） |
| `PTH_EXEC_BACKEND_ROUTES` | json | `""` | 覆盖 `DEFAULT_BACKEND_ROUTES`（代码默认：`lean4→local-lean`、`assembly→tools-compiled`、`jupyter→jupyter`、`u8→local-u8`、`wolfram→local-wolfram`、`psi4/cp2k/quantum-espresso→local-chem`） |
| `PTH_EXEC_BACKEND_PROBE_TIMEOUT_MS` | number | `2000` | startup 单 backend 探测超时 |
| `PTH_EXEC_SANDBOX_ALIAS` | string | `"on"` | `off` 时不从 `SANDBOX_URL` 合成 sandbox 后端 |

`PthConfig` 增加 `json(key)` accessor（解析失败抛带 key 的错误，registry 捕获包装）。

#### P1.2 新模块 `src/pth/execution/backend-registry.ts`

```ts
export interface ExecutionBackendRegistry {
  get(id: string): HttpExecutionBackend | undefined;
  list(): ReadonlyMap<string, HttpExecutionBackend>;
  routes: Readonly<Partial<Record<ProfessionalRuntimeId, string>>>;
}
export function buildExecutionBackendRegistry(input: {
  descriptorsJson?: string; routesJson?: string;
  env: NodeJS.ProcessEnv; strict: boolean;
  fetchLike?: typeof fetch; capabilitiesTtlMs?: number;
}): { registry: ExecutionBackendRegistry; warnings: string[] };
export async function probeExecutionBackends(registry, opts: {
  strict: boolean; timeoutMs: number; logger: { warn(...); error(...) };
}): Promise<void>;
```

合成规则（fail-closed）：

1. `PTH_EXEC_BACKENDS` 为空且 sandbox alias 开 → 合成
   `{ id:"sandbox", url:SANDBOX_URL ?? "http://localhost:8080", profile:"sandbox-untrusted",
   tokenEnv:"SANDBOX_SHARED_SECRET", required: strict }`。
2. 已配置 → 逐项 `validateExecutionBackendDescriptor`；未知字段/非法 id/url/profile 抛错；
   id 重复抛错。
3. 配置中没有 `sandbox` 且 alias 开 → 仍合成 sandbox 合并（现网兼容；`off` 关闭）。
4. `tokenEnv` 引用的 env 缺失：strict 且 `required:true` → 抛错；否则告警（运行时 401）。
5. routes：key 必须合法 `ProfessionalRuntimeId`，value 必须命中已注册 backend id——typo
   在装配期抛错。
6. 装配不探网络；探测由 `probeExecutionBackends` 执行：并行 + 单后端 2s 超时；
   `getCapabilities()` 的 version/安全不变量不匹配由 P0 wrapper 抛 `BACKEND_UNAVAILABLE`。
   strict：任一 `required:true` 失败 → 抛错（main 监听端口前 / batch fork 后首个装配点）；
   非 required 失败 → error 日志。dev：全部失败仅告警。

#### P1.3 组合根（`bootstrap/pth-host.ts` / `main.ts` / `batch-process.ts`）

- `BuiltPthHost` 增加 `backends` 与 `routes`；`buildPthHost(manifest, options?)` 支持注入
  `env` / `fetchLike`（测试用）。
- main：build → `probeExecutionBackends` → 用 `backends.get("sandbox")` 的
  `descriptor.url/token` 喂 `SandboxExecClient` + `SandboxHealthMonitor`（无 sandbox 时回退
  现 env 读法）。
- batch：build → probe → PG 池；`createKernelManager` 的 `sandboxKernel.url/secret` 改从
  sandbox descriptor 取（env 兜底）。

#### P1.4 专业 runtime 路由（`professional-runtime-adapters.ts`）

输入扩展：`executionBackends?`、`backendRoutes?`、`allowLegacyExecutionFallback?`
（硬切后默认 `false`）。

后端解析优先级：

1. `backendRoutes[runtimeId]` → registry `get()`；
2. 代码默认路由（`DEFAULT_BACKEND_ROUTES`，registry 中存在即用）：`lean4→local-lean`、
   `assembly→tools-compiled`（T4）、`u8→local-u8`（U8-1）、`jupyter→jupyter`（P5）、
   `wolfram→local-wolfram`、`psi4/cp2k/quantum-espresso→local-chem`；
3. legacy 前缀 env（`PTH_LEAN4_TOOLCHAIN_EXEC` / `PTH_ASM_TOOLCHAIN_EXEC` 等）→
   `DockerExecBackend`（仍作为显式配置受支持）；
4. 都没有 → **不创建该 factory**（strict 与 dev 一致）→ registry 返回
   `unregistered-runtime`。不再有任何隐式 LocalBackend。

#### P1.5 adapter 侧去隐式默认（`exec-via-backend.ts` + 五个 adapter）

- `executionBackendFromPrefix(prefix)`：无 prefix 不再返回 `LocalBackend`，返回
  `undefined`；有 `["docker","exec",...]` 仍解析 `DockerExecBackend`。
- 新增 `resolveExecutionBackend({ executionBackend?, execPrefix? })` 与
  `unavailableAdapterExec(reason)`；五个 professional adapter 改为：
  无 backend/prefix → exec 函数返回 `{ok:false, error:"<runtime>: no execution backend
  configured"}` → `probe()` 自然返回 unavailable。
- 既有集成测试迁移：原本“宿主有 lean/工具链时 undefined 前缀直跑”的用例改为显式
  `executionBackend: new LocalBackend()`；容器路径继续用 execPrefix。

#### P1.6 测试

| 文件 | 用例 |
|---|---|
| `test/pth-execution/execution-backend-registry.test.ts`（新） | JSON 解析 / 非法 descriptor / 重复 id / route typo / token 缺失 / alias 合成与关闭 / strict 与 dev probe 语义（fake fetch） |
| `test/pth-bootstrap/bootstrap.test.ts`（扩） | buildPthHost 返回 backends；非法 `PTH_EXEC_BACKENDS` 在监听前抛错 |
| `test/pth-config/config.test.ts`（扩） | 新 schema 键 + `json()` accessor |
| `test/pth-professional`（扩） | 路由优先级；未路由 runtime 不注册（硬切）；artifactPath 修复后默认 factory 激活；adapter 无 backend 时 probe unavailable |
| 集成测试 | 直跑用例显式 `LocalBackend`，行为不变 |

#### 退出门

1. ✅ deps 1.6.0 发布后 PTH lint 全绿 + batch/professional 集成测试通过（PTL 470/470 全绿）；
2. ✅ strict 且零 backend → 装配即失败；dev → 告警，专业 runtime 全部 unregistered（无隐式 LocalBackend）；
3. ✅ sandbox 现网行为零变化（alias 合成 + 原 SandboxExecClient 路径）；
4. ✅ 三仓拓扑文档 P1 状态同步。

### P2 Lean 外移 + 本地执行器（pi-triple-ptl 为主，pth 联动）

**状态：✅ 已实现并实测（2026-08-22）。**

1. ✅ 本地执行器：PTH `LocalSpawnBackend`（sync+stream、pathMapping 翻译、超时/截断）
   + `startLocalExecServer`（shared `ExecutionHttpServer`，127.0.0.1，Bearer）+ `pth local-exec`。
   （2026-08-22 纠偏：本地执行器归 PTH 产品面；`pth services` 进程监督器管理；PTL 不再直接暴露。）
2. ✅ `deploy/Dockerfile` 移除 elan / lean / lake 安装段；镜像构建不再依赖 Lean 网络源。
3. ✅ compose：engine `extra_hosts: host.docker.internal:host-gateway` + `PTH_EXEC_BACKENDS`
   含 `local-lean`（profile host, tokenEnv LOCAL_EXEC_SHARED_SECRET）。
   **补充裁决（2026-08-22）**：`workspaces` 由 named volume 改为宿主 bind mount
   （`PTH_WORKSPACES_HOST` 必填）——engine/sandbox/宿主执行器三方同目录；
   旧 named volume 数据需一次性迁移。
4. ✅ `lean4-runtime-adapter` 默认解析 `local-lean`（P1 约定路由）；`PTH_LEAN4_TOOLCHAIN_EXEC`
   前缀仅在测试/临时容器场景使用。
5. ✅ **退出门全部通过**：`lean --version` 与 `lake build`（8 jobs 成功）经 engine 镜像 →
   本地执行器全链路通过；engine 镜像不再含 Lean；超时/输出上限/错误信封契约测试通过
   （PTL 476 tests 全绿）。栈级验收补丁（2026-08-22）：compose 注入
   `PTH_WORKSPACES_PATH=/data/workspaces`，使 lean4 专业任务工作区落在宿主执行器
   pathMapping 内——engine 容器 probe lean4 → `{version:"4.33.0", satisfiesLock:true}`。

### P3 → T3：tool containers 三域迁移（取代 dev 容器）

**状态：✅ 已实现并实测（2026-08-22）——三域真实住户经 pth CLI 协议可调用。**

“dev 容器”已废弃。当前事实：PTL 工具容器（agent-reach / yt-dlp / instsci / bf / bfc /
chatgpt-share），可信可出网、无密钥注入、root 单用户，调用方式 = 宿主机 wrapper →
`docker exec -T dev <tool>`；不是执行面，也不在 pi-triple-pth 生产 compose 里。T3 按
§5 设计把它退役并迁移为三个实体域 + 一个预留域。

1. ✅ `deploy/tool-containers/`：三域统一 Dockerfile + compose 生成器 +
   `tool-manifest.json`（GHCR digest 钉版；secrets 不 join engine 网络、无 ENGINE_TOKEN）。
2. ✅ `pth tools` 命令族上线；PTL `/container` 与旧 wrapper 进入退役兼容期
   （deprecation banner，后续删除）；`agent-reach` wrapper 与 dev-container 旧
   compose 路径的彻底清理随退役执行。
3. ✅ 存量分流：bf/bfc → compiled（beef/tcc 后端）；yt-dlp → network；
   agent-reach + chatgpt-share → secrets；v13-asm-toolchain 于 T4 迁入 compiled；
   instsci 保持宿主机。
4. ✅ **退出门（pth CLI 面）**：bf HelloWorld / bfc emit-C / yt-dlp --version /
   agent-reach v1.5.0 / chatgpt-share --help 全部经 execution 协议调用成功；
   `pth tools verify` 全 healthy；secrets WS+pty 会话通过；DockerExecBackend 测试不回退
   （PTL 476 tests 全绿）。engine 经 registry 调 compiled/network 由 T4 接线完成。

### T4 v13-asm-toolchain 吸收 + professional 路由切换

**状态：✅ 已实现并实测（2026-08-22）。**

1. ✅ compiled 镜像安装 binutils + qemu-user + x86-64/aarch64/riscv64 交叉 binutils
   （版本 2.40 与 committed lock 一致）。
2. ✅ manifest 移除 `v13-asm-toolchain` 占位符，登记 asm-kernel 全部 16 个白名单工具
   （which/objdump/三目标 as/ld/objdump/三 qemu）。
3. ✅ engine 自动合并宿主 tool 回环注册表：`buildPthHost` 读取
   `PTH_TOOL_REGISTRY_PATH`（compose 只读挂载 `${HOME}/.pi-triple`），compiled/network
   条目合成 `dev-container` backend，127.0.0.1 → host.docker.internal 改写，ENGINE_TOKEN
   直连；secrets 永不进 engine。
4. ✅ professional 默认路由 `assembly → tools-compiled`（backendRoutes 可覆盖）；
   lean4 等其他路由不变。
5. ✅ 实测：6 个工具链二进制 `--version` 全部经 execution 协议返回正确版本；
   `pth tools verify` 16/16 healthy；registry merge 单测覆盖 token/url 改写与 secrets 隔离。
6. ✅ 栈级验收（2026-08-22）：真实 `pth up` + `pth tools up` 栈内，engine 容器
   `assembleProfessionalRuntimeRegistry` 经 tools-compiled probe assembly →
   `{version:"2.40", satisfiesLock:true}`；compose 补 `PTH_ASM_KERNEL_INDEX_PATH=
   /data/toolstore/...` 修复生产 asm-kernel 装载路径。

### P4 persistent + kernel-host 迁移（✅ 已完成，2026-08-22；legacy 清理待办）

- **shared 已实现并发布（1.7.1 会话基础，1.7.2 快照 `state`，1.7.3 execute 上下文，1.7.4 execute `value`）**：`ExecutionSessionManager`（sessionId→backend token、
  lease/TTL、execute 续租、快照登记、released/expired 状态机）+ `ExecutionHttpServer`
  `/sessions*` 路由 + `HttpExecutionClient` 会话 API；v1 capabilities 装配 sessions 后
  自动升 v1.1 并声明 persistent=true。
- **sandbox /sessions 宿主已实现（2026-08-22 裁决）**：与 /kernel/* 共享同一对语言池；
  wire body 不变，create 经私有头 `x-sandbox-kernel-lang` + `x-sandbox-grant`
  （base64url(JSON) 签名 grant）在会话层盖章 task/tenant 绑定；snapshot 只导出状态，
  reset 仅支持回会话初始，reset(snapshotId) = MODE_NOT_SUPPORTED。
- **engine 已迁移（2026-08-22）**：`SandboxKernel` 全量走 /sessions（私有头
  lang/grant/exec/space；REPL `value` 与 snapshot `state` 经 wire 保真；abort 后本地
  会话作废不 release，池 TTL 兜底）；kernel-manager 集成测试真实 python/bash 通过。
- **容器内 vertical 已通过（2026-08-22）**：engine 容器内 SandboxKernel → sandbox
  `/sessions` → python value/reset/snapshot + bash 输出全链实测。
- **legacy 清理待办**：`/kernel/acquire|execute|reset|snapshot|release|cancel` 已标
  DEPRECATED（新代码禁止使用），后续清理批连同旧测试一并删除。
- assembly / wolfram / computational-chemistry 按需路由到 tool containers / 本地执行面。
- engine 的 interactive 消费：待出现真实“worker 驱动 TTY”场景再设计 agent 驱动语义。
- engine 品牌/服务名迁移（独立立项，不在协议面范围内）。

### P5 Jupyter：单容器双面 + 前端分工（2026-08-22：南面已实现并实测）

**边界**：浏览器 / Jupyter 前端**永不直接访问执行后端**；Jupyter 是北向消费者
（`浏览器 → jupyter server → engine → 执行后端`），token 不进浏览器。

**形态（ADR-0002）**：jupyter = 常驻服务，单容器一套安装、南北两面：

- ✅ 南面：容器内跑 shared `ExecutionHttpServer`（v1.1，:8889，Bearer 共享密钥）；
  engine 经 registry 后端 `jupyter`（默认路由）调用，`jupyter-runtime-adapter`
  已是薄客户端（probe/execute 全部经 backend），不再 docker exec。
  vertical 已通过：engine 容器内 adapter → `http://jupyter:8889` → nbclient
  clean-kernel execute-all → executed-notebook/report artifacts + 输出核对。
- ✅ 北面：JupyterLab `:8888`（回环发布）同容器运行，workspaces 共享卷；
  `pth` CLI 经宿主依赖树只读挂载 `/opt/pth-host` + wrapper 透传（镜像零 pth 字节，
  2026-08-22 用户裁决；不可用时终端给出明确指引）。
- ✅ kernel provider 原型：`pi-kernel`（cell → engine `/api/v1/kernel/notebook/execute`，
  sessionId 在 kernel 实例内保持；nbconvert 执行真实 notebook 已通过）。
- ✅ engine 北向 notebook 契约：`POST /api/v1/kernel/notebook/execute|cancel`
  （python/bash/ts，每 session 独立 KernelManager + idle TTL；python/bash 随
  PTH_*_MODE 走 sandbox-kernel 持久会话）。
- 共享 workspaces / artifacts 卷；由 `pth services` 管理（`pth services up jupyter`），
  部署物在 `deploy/services/jupyter/`（service.json + Dockerfile + compose +
  south-server + entrypoint）。

两条方向（A：engine 无头跑 notebook；B：用户 notebook 消费执行面）在同一容器内共存，
一套 jupyter 安装。

**前端分工**：operator console 保留（任务/日志/巡检/动作）；JupyterLab 只承担终端与
notebook 交互（P5）；未来最多加 1–2 个薄插件搬常用页面，不整体重做控制台。

落地顺序（P5a→d）：✅ P5a 南面部署物 + engine 无头 notebook vertical →
✅ P5b engine notebook 会话契约（execute/cancel，session 隔离 + TTL）→
✅ P5c pi-kernel provider（nbconvert 真实 notebook 通过）→
✅ P5d 有状态 REPL（persistent 已实现）/ cancel 端点 + JupyterLab 基础体验；
剩余：Lab 内 interrupt 交互细化与体验收尾（可另开小批）。

### P6 pth CLI 统一入口（设计定稿，实现待开）

- `pth doctor` 前置体检；`pth up/down --profile|--with|--without|--all` 编排；
  `pth status --all` 聚合健康。
- 运行时剖面：`core`（默认）/ `tools` / `lean4` / `u8` / `jupyter` / `full`，
  声明在 `deploy/runtime-profiles.json`（P6-2）。
- 部署顺序：doctor → secrets env 注入 → 数据层 → **生成 operator token（同源给
  JUPYTER_ENGINE_TOKEN）** → 宿主服务 → 工具容器 → jupyter → **最后 engine**
  （`pth up --token` 复用同值；保证 batch 启动 probe 全部 backend ready）→ verify。
- 完整设计：`docs/pth/p6-pth-cli-runtime-profiles-design.md`。

## 5. tool containers 与 execution/v1.1 模式框架（ADR-0002 定稿）

### 5.1 域模型与住户

“dev 容器”废弃。tool containers 只承载**命令行工具（job 生命周期，含 TTY）**；常驻服务
（jupyter 等）走独立服务容器。第一分类轴 = 功能域 + 信任 + 升级节奏，实现语言只是镜像细节。

| 域 | 住户 | 运行时网络 | 协议消费者 | 备注 |
|---|---|---|---|---|
| `compiled` | bf/bfc + `v13-asm-toolchain`（首个真实住户） | internal（离线） | pth CLI + engine | 构建期可联网，运行时无外网 |
| `network` | yt-dlp | default（出网） | pth CLI + engine | engine 按角色 capability 白名单，默认关闭 |
| `secrets` | agent-reach + chatgpt-share（TTY） | default（出网） | **仅 pth CLI** | 不 join engine 网络、无 ENGINE_TOKEN |
| `interactive` | （暂无住户） | 预留 | 未来无凭据 TTY 工具 | 协议模式本轮实现，实体容器不建 |

### 5.2 所有权与部署事实源

- 部署物迁至 PTH 仓：`deploy/tool-containers/`（compose + Dockerfile + `tool-manifest.json`）；
  每个域一个 image：`ghcr.io/<owner>/pi-triple-pth-tools-<domain>`。
- PTL `packages/dev-container` 与 `/container` deprecated：一个版本兼容期（转发到
  `pth tools`），随后删除；旧 wrapper 由 pth CLI 重生成。
- 每个域镜像 = 统一 base（node + 域工具） + npm 安装 `@away_from/shared` +
  启动 shared `ExecutionHttpServer`。

### 5.3 `pth tools` / `pth services` 命令面

- `pth tools`：独立 compose 项目，与 engine 栈生命周期解耦——
  `build/push/release/pull/up/down/status/logs/run/verify/mount/list/debug`。
  `run` 走 execution 协议（compiled/network HTTP；secrets 的 TTY 走 WS）；
  `debug` 是唯一 docker exec 逃生舱。
- `pth services`：宿主进程监督器 + 常驻服务——
  `list/up/down/status/logs/restart`；`deploy/services/<id>/service.json` 声明
  `kind=host`（本地执行器：`pth local-exec`，detached spawn + pid/log + 健康就绪 + SIGTERM/SIGKILL）
  或 `kind=compose`（jupyter，P5）。token 本地生成注入 `tokenEnv`，只进
  `~/.pi-triple/services.json`（0600）。
- 所有 docker 调用 argv 数组（沿用 dev-container 包的安全约定）。

### 5.4 回环端点与本地注册表

- 每个域容器 bind `127.0.0.1` **动态端口**（compose `127.0.0.1::PORT`），不发 LAN/公网。
- pth CLI 维护 `~/.pi-triple/tool-containers.json`（0600）：descriptor、实际端口、
  token（本地生成，绝不随 manifest/镜像迁移）；`up`/`pull` 后刷新。
- 宿主服务由 `pth services` 维护 `~/.pi-triple/services.json`（0600）：pid/port/token/
  logFile/pathMapping；engine `buildPthHost` 同时合并 tool + service 注册表——
  local-lean/local-u8 自动成为 registry backend（127.0.0.1 → host.docker.internal）。
- compiled 回环发布（2026-08-22 适配）：OrbStack / 部分 Docker Desktop 不给仅连
  internal 网络的容器分配 `127.0.0.1::8080` 动态端口 → 增加 `tools-compiled-gateway`
  边车（同时连 tools-compiled + tools-loopback，原始 TCP 中继并发布动态端口）；
  compiled 工具容器本体仍无出网能力。

### 5.5 镜像发布与迁移（GHCR）

- buildx 一次产出 `linux/arm64 + linux/amd64`；`pth tools release` push 后把 **digest**
  钉进 `tool-manifest.json`；`up/pull` 只按 digest 拉取。
- 跨机器迁移 = 装 pth + `pth tools pull` + `pth tools up`；token 在目标机重新生成。
- Mach-O 原生工具不进 tool containers（留宿主）；不做 macOS/Windows 原生产物线。

### 5.6 execution/v1.1 模式框架

```ts
ExecutionRequest.mode: "sync" | "stream" | "interactive" | "persistent"
capabilities: { version: "execution/v1" | "execution/v1.1", modes: {
  sync: boolean, stream: boolean, interactive: boolean, persistent: boolean } }
```

| 模式 | wire | 本轮 |
|---|---|---|
| sync | POST /exec → 同步结果 | ✅ 实现 |
| stream | POST /exec → GET /exec/:id/stream（SSE） | ✅ 实现 |
| interactive | POST /exec → WS /exec/:id/ws（stdin/stdout/stderr/resize/pty） | ✅ 实现 |
| persistent | session create/execute/snapshot/reset/release + lease/TTL | ✅ 已实现并容器内实测（shared 1.7.x + sandbox /sessions 宿主 + engine SandboxKernel 迁移；legacy /kernel lease 路由 deprecated 待清理） |

- 未声明模式 → `MODE_NOT_SUPPORTED`；旧 `stream:true` 字段映射到 `mode:"stream"`。
- persistent wire 已定稿：`POST /sessions`（create）· `GET /sessions/:id` ·
  `POST /sessions/:id/execute|snapshot|reset|release`；`leaseMs` 5s..24h（缺省 10min），
  每次 execute 自动续租；`SESSION_EXPIRED` / `SNAPSHOT_NOT_FOUND` 错误码。
- v1.0 客户端遇 v1.1 fail-closed；升级需部署顺序编排。
- 服务端实现：jupyter 南面 / tool containers / 本地执行器 = shared `ExecutionHttpServer`；
  **sandbox 为兼容宿主例外**（Fastify 手写 `/exec` + `/sessions`，与 `/kernel/*` 共享语言池、
  wire 与 shared 对齐，后续收口到 `ExecutionHttpServer`）。registry 按 capabilities 协商 v1/v1.1。
- persistent 语义：交互核状态在后端（session/lease），engine 保持无状态；
  sandbox 生产路径已迁移（P4：`/sessions` 宿主 + SandboxKernel 全量切会话）。

### 5.7 principal 与授权

- 每域 `HOST_TOKEN` / `ENGINE_TOKEN`；secrets 域只有 HOST_TOKEN。
- **角色→工具授权全部在 engine 内完成**（role capabilities；network 域默认关闭）；
  后端对持有效 ENGINE_TOKEN 的 engine 请求视为可信。
- manifest 标记 `engineVisible` 工具白名单与 `hostOnly` 工具；凭据工具恒 `hostOnly`。

### 5.8 实施顺序（对应 §4）

`P0.1 deps（v1.1 框架 + ExecutionHttpServer + 客户端，与 P0 合并发布 shared@1.6）`
→ `P1 registry v1/v1.1 协商` → `T2 pth tools/services + manifest + 回环注册表`
→ `T3 三域迁移 + 旧 dev 退役` → `T4 v13-asm-toolchain 吸收 + professional 路由切换`

**T2 状态（2026-08-22）**：✅ 已实现——`tool-manifest.json` schema+校验+digest 钉版、
`~/.pi-triple/tool-containers.json`（0600/token 本地生成）、`pth tools list|up|down|
status|logs|run|verify|debug|build|pull|release`、三域统一镜像 + 容器内
`tool-server.mjs`（argv 白名单 + sync/stream/interactive；secrets pty 经 node-pty +
resize）+ compiled gateway 边车。三域真实住户由 T3 装入并实测。⏳ 待续：GHCR buildx
release 实测（需 push 凭据）。
→ `P2 本地执行器 v1.1` → `✅ P4 persistent 实现 + kernel-host 迁移（2026-08-22；legacy 清理待办）` → `✅ P5 jupyter 双面（2026-08-22；体验收尾待办）` → `P6 pth CLI 统一入口（设计定稿，实现待开）`。

### 5.9 风险与护栏

- pty 终端注入 / escape 序列：interactive 实现必须做输出转义防护与权限边界。
- engine 驱动 network 域 = 出网能力：role capability 默认关闭 + 审计事件。
- compiled「运行时离线」与「构建期联网」以 Dockerfile stage 区分，运行镜像不装包。
- v1.0→v1.1 升级窗口：先升客户端或采用兼容降级路径，再切后端版本。
- 动态端口漂移：本地注册表每次 `up` 刷新；旧端口连接即失效。
- 已知旧路径漂移：`agent-reach` wrapper 与 dev-container 包指向
  `~/pi-platform/docker-compose.yaml`，T3 一并修正。

### 5.10 可改性分层（mutation tiers，与 role/worker 协议同源）

| 层 | 内容 | 变更方式 |
|---|---|---|
| T0 不可修改 | contracts / execution wire / validate / grant / kernel·loop·interpreter 机制 / 装配 fail-closed / professional-runtime-lock / tool-manifest digest | PR + 门禁 + 镜像/npm 发布 |
| T1 声明式可变 | `catalog/data/**`：role-definition/v1、worker-spec/v1、policies、observers、spaces、任务模板、skills/prompts | proposal → 审批 → 文件（GitOps）→ apply（drain-swap 热生效） |
| T2 配置可变 | PTH_* env / PTH_EXEC_BACKENDS / 模式开关 | 配置中心 + env + 重启（部分 runtime SET） |

- 机器断言：T0 源码不得 import `catalog/data/**`；role 对象在生产装配中只来自 catalog loader；
  T1 写入口只经 `pth role/worker` 或审批管线（写审计）。
- role/worker 完整协议（字段、REST 面、drain-swap、迁移映射）见 PTH 仓
  `docs/pth/role-worker-protocol-v1.md`；本表是三仓共用的边界摘要。

### 5.11 执行协议边界（2026-08-22 补充裁决）

- **执行协议只管“执行已知命令”**：信息回传 = 进程级（`stdout`/`stderr`/`exitCode`/`signal`/
  `timedOut`/`truncated` + SSE `output`/`done`/`error` + WS `stdout`/`stderr`/`resize`/`done`/`error`）。
  **不引入 stdout 之外的带类型信息通道**；机器可读结果用 stdout JSON 约定或
  `pathMapping` 文件 artifact。将来确有 progress/artifact 事件需求时，按 **v1.2 可选事件**
  增量定稿，不回改 v1.1 已发布客户端。
- **工具定义查询不进执行 wire**：`/capabilities` 只描述协议能力（version/modes/pathMapping…），
  不描述工具清单；后端**不提供** `GET /tools`。工具定义 = engine 侧 **T1 catalog**
  （`catalog/data/tools.json`），由 `pth tools` 从 `tool-manifest.json` 生成/校验（GitOps），
  engine 仅在装配期读取；清单条目与镜像 digest 互锁，升级经 `pth tools up/pull` 刷新。
- **授权边界**：role capabilities 在 engine 内做工具白名单；执行面对持有效 ENGINE_TOKEN
  的请求视为可信、不感知角色。`engineVisible`/`hostOnly` 是 manifest → catalog 的生成过滤
  条件，不是执行协议字段。

## 6. 本地执行器开发指南（Lean 首期参考实现）

### 6.1 定位与安全基线

- 一个宿主机长驻进程：实现 `execution/v1.1` 的最小服务端（优先直接使用
  `@away_from/shared/execution` 的 `ExecutionHttpServer`；骨架仅演示最小手工实现），
  内部用 `LocalBackend`（或等价 spawn）执行命令。
- 只监听 `127.0.0.1`；engine 容器经 `host.docker.internal` 访问。
- 认证：Bearer token（如 `LOCAL_EXEC_SHARED_SECRET`），`/health` 除外；
  常数时间比较，失败返回 `401 UNAUTHORIZED`。
- profile 固定 `host`：请求体自报 `dev-container`/`sandbox-untrusted` 一律
  `INVALID_REQUEST`（客户端不得自我提升）。
- 不在本执行器内实现沙箱语义；它只服务宿主机已信任的工作区。
- **宿主前置**：elan 已安装且 `lean`/`lake` 在执行器进程 PATH 中（`elan` 标准安装即可）；
  执行器本身不下载/安装任何工具链。

### 6.2 最小实现清单

| 项 | 内容 |
|---|---|
| 依赖 | `@away_from/shared@^1.6`（execution 子路径，含 v1.1 模式框架）+ Node ≥22 内置 `node:http` 即可 |
| 工具链 | 执行器进程 PATH 能找到 `lean` / `lake`（elan 正常安装即可） |
| capabilities | `{ version:"execution/v1.1", modes:{sync:true, stream:true, interactive:false, persistent:false}, cwdWhitelist:false, uidIsolation:false, egressLocked:false, pathMapping:true }` |
| pathMapping | 启动参数/配置登记 `hostRoot → execRoot` 映射；`POST /exec` 先翻译 `cwd`，再交给 LocalBackend |
| 硬约束 | 超时杀进程组、stdout/stderr 上限截断、`ExecutionResult` 形状（LocalBackend 已实现） |

### 6.3 参考骨架

```ts
// local-exec-server.ts —— 本地执行器参考骨架（execution/v1.1 sync 子集，profile=host；
// 生产实现直接用 shared 的 ExecutionHttpServer，不要复制本骨架）
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

### 6.4 engine 侧接线（compose / env）

```yaml
# deploy/docker-compose.yaml · pi-platform 服务
extra_hosts:
  - "host.docker.internal:host-gateway"
environment:
  - PTH_EXEC_BACKENDS=[{"id":"sandbox","url":"http://sandbox:8080","profile":"sandbox-untrusted","tokenEnv":"SANDBOX_SHARED_SECRET","required":true},{"id":"local-lean","url":"http://host.docker.internal:8787","profile":"host","tokenEnv":"LOCAL_EXEC_SHARED_SECRET","pathMapping":{"hostRoot":"/data/workspaces","execRoot":"${PTH_WORKSPACES_HOST}"},"required":false},{"id":"local-u8","url":"http://host.docker.internal:8788","profile":"host","tokenEnv":"LOCAL_EXEC_SHARED_SECRET","pathMapping":{"hostRoot":"/data/workspaces","execRoot":"${PTH_WORKSPACES_HOST}"},"required":false},{"id":"jupyter","url":"http://jupyter:8889","profile":"host","tokenEnv":"JUPYTER_SERVICE_TOKEN","required":false}]
  # LOCAL_EXEC_SHARED_SECRET / JUPYTER_SERVICE_TOKEN 为可选注入（${VAR:-}）；缺失时对应 backend 运行期 401，不阻塞启动
  - LOCAL_EXEC_SHARED_SECRET=${LOCAL_EXEC_SHARED_SECRET:-}
  - JUPYTER_SERVICE_TOKEN=${JUPYTER_SERVICE_TOKEN:-}
```

Lean 请求形态（engine 侧 `lean4-runtime-adapter` 构造）：

```json
{ "cmd": ["lake", "build"], "cwd": "/data/workspaces/<tenant>/<project>",
  "timeoutMs": 120000, "maxStdoutBytes": 1048576, "maxStderrBytes": 1048576,
  "profile": "host", "pathMapping": { "hostRoot": "/data/workspaces", "execRoot": "<host workspace root>" } }
```

### 6.5 验收清单

- [x] `curl /health` 无 token 通过；`curl /capabilities` 返回 `pathMapping:true`（PTL 自动化测试）
- [x] 错误 token → `401 UNAUTHORIZED`；请求自报 `sandbox-untrusted` → `400 INVALID_REQUEST`
- [x] `lean --version` 经 `/exec` 返回 `exitCode:0` 与版本输出（2026-08-22 实测，宿主 elan v4.33.0）
- [x] `lake build` 在映射后的宿主 workspace 执行成功（engine 内 `cwd=/data/workspaces/...` 可用；8 jobs）
- [x] 超时命令被杀进程组，`timedOut:true`；超过输出上限 `truncated` 存在
- [x] 未登记 pathMapping → `CWD_NOT_ALLOWED`
- [x] engine 容器 → `host.docker.internal:8787` 可达：engine 镜像内 `HttpExecutionClient`
  经执行器读取映射后的宿主 workspace 文件成功（2026-08-22 实测）

### 6.6 u8proj 本地执行器接入（2026-08-22 设计定稿）

团队 u8proj = 纯 C 小型 VM 工具链（`u8 compile/run/debug/analyze`；源码 .u8asm →
二进制 .u8programme）。跨平台已验证：macOS/Linux `cc` 一条命令构建，Windows 有
`u8.exe`。接入分两期：

**U8-1（本地执行器，2026-08-22 全链已实现并实测）**
- u8 版本 0.0.2：`u8 run <programme> --reg K=V ... --io N=V ...` 非交互注入初值；
  无参数保持交互；`debug/analyze` 仍为团队待实现（协议侧不接线）。
- 集成基线：`deploy/local-exec/u8/`（源码 + `build-u8.sh`）；编译产物放进
  `pth local-exec` 进程 PATH。
- 已接线：engine `PTH_EXEC_BACKENDS` 注册 `local-u8`（profile=host，
  pathMapping `/data/workspaces`，tokenEnv `LOCAL_EXEC_SHARED_SECRET`）+
  `u8-runtime-adapter`（probe `u8 version`；compile/run 经 sync + artifact port）
  → 默认路由 `u8 → local-u8`；vertical 实测通过（engine → host.docker.internal:8788
  → pathMapping → `u8 compile/run` → source/programme/run-log artifacts）。
- 角色归属：暂不对任何专业角色开放 allowlist（`u8-programmer` 或等价角色另立项）。

**U8-2（有状态，待接线）**
- P4 persistent 已实现：`u8 run` 的寄存器/I/O 逐步输入可映射到 persistent session execute，
  不再需要 batch 参数逐轮拼接；具体接线与 `u8-programmer` 角色立项同步推进。

### 6.7 CLI 归属纠偏（2026-08-22 补充裁决）

- **本地执行器归 PTH**：`pth local-exec`（`LocalSpawnBackend` + `ExecutionHttpServer`），
  生命周期由 `pth services` 管理；`ptl local-exec` 不再存在（显示迁移提示）。
- **容器管理归 PTH**：`ptl stack` 进入 deprecated 兼容期，全部容器生命周期 = `pth up` /
  `pth tools` / `pth services`。
- **TUI 正式下线**：`ptl tui` 从命令面移除（`tui-*` 源码保留只读兼容）；
  前端 = `pth web` operator console / JupyterLab。

## 7. 网关边界（2026-08-21 裁决：暂不引入统一网关）

**现状保持直连**，不新增 nginx / HAProxy 等统一网关：

- **北向**：pth CLI / web UI 继续直连 engine `:3000`（核心栈唯一全网发布端口，天然单入口；
  jupyter 北面 `:8888` 只绑 127.0.0.1 回环，不属于网关域）。
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

## 8. 变更纪律

1. 本计划任何变更先改本文件（三仓同源同步），再改代码；
2. 协议类型/常量只改 `pi-triple-deps` 的 `packages/shared/src/execution/**`，随后 npm 发布；
3. engine 侧装配只改 `bootstrap/` 与 `config/schema.ts`，adapter 保持 `ExecutionBackend` 参数不变；
4. 每阶段退出门含全量测试 + 三仓文档同步。
