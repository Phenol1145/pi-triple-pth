> PTH（Pi-Triple-Heavy）文档 — agent 联邦平台
> 双产品全景见顶层 [`ARCHITECTURE.md`](../../ARCHITECTURE.md)。
# 架构文档

## 设计哲学

pi-platform 采用**模块化单体**架构。所有模块在单一 Node.js 进程中运行，但通过明确的接口（DTO + AsyncIterable）实现逻辑隔离。这使得内部团队可以快速迭代，同时在业务需要时可以将模块独立拆分到微服务。

**核心原则**：
- **pi SDK 是引擎，平台是壳**：不重写 pi 的 Agent 能力，而是在其外层添加多租户、治理、监控
- **接口先行**：模块间通过 JSON 可序列化的 DTO 通信，不直接依赖内部实现
- **治理透明化**：工具调用、模型请求、会话管理全链路审计

## 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│  Gateway Layer（网关层）                                      │
│  Fastify HTTP · WebSocket · Auth Hook · SSE 流式输出          │
├──────────────────────────────────────────────────────────────┤
│  Core Layer（核心层）                                         │
│  AgentEngine · SessionPool（busy/idle 状态机）· Bridge       │
├──────────────────────────────────────────────────────────────┤
│  Platform Layer（平台层）                                     │
│  ModelRouter · ToolPlatform · WorkflowOrchestrator           │
│  WorkspaceManager · HotReloader · RebuildTrigger             │
├──────────────────────────────────────────────────────────────┤
│  Infrastructure Layer（基础设施层）                           │
│  Redis · BullMQ · pino · prom-client · chokidar · Platform   │
│  Adapter（跨 OS）                                             │
└──────────────────────────────────────────────────────────────┘
```

## 模块详解

### Gateway Layer

| 模块 | 职责 |
|------|------|
| `server.ts` | Fastify 实例创建、路由注册、WebSocket 注册 |
| `auth.ts` | Bearer token 认证 hook，读取 Redis `auth:token:{token}` |
| `routes-sessions.ts` | Session CRUD + SSE prompt |
| `routes-programs.ts` | ★ agent 程序上传/版本/运行（PTL→PTH 桥服务端） |
| `routes-self.ts` | 工具列表、版本信息、健康检查 |

认证流程：
```
Client → Bearer token → auth hook → Redis GET auth:token:{token}
  → {tenantId, role} → req.auth = {tenantId, role}
  → 传递给所有请求处理器
```

#### 扩展方式

**添加自定义 API 端点**：采用 Fastify plugin 模式，与现有路由风格一致。

```typescript
// src/gateway/routes-custom.ts
export function registerCustomRoutes(app: FastifyInstance, engine: AgentEngine) {
  app.get("/api/v1/stats", async (req) => ({
    tenant: req.auth.tenantId,           // auth hook 自动注入
    sessions: engine.listSessions(req.auth.tenantId).length,
  }));
}

// server.ts 中挂载：
// registerCustomRoutes(app, engine);
```

- 所有 `/api/v1/*` 路由自动经过 auth hook（Bearer token → tenantId）
- `/health` 和 `/metrics` 免认证
- `req.auth: { tenantId, role }` 在所有 handler 中可用

详见 `examples/custom-route/index.ts`。

### Core Layer

| 模块 | 职责 |
|------|------|
| `AgentEngine` | 平台主入口：创建 session、发送 prompt、abort、销毁、驱逐 |
| `SessionPool` | 内存 Session 池：busy/idle 状态机、LRU 驱逐、限额管理 |
| `AsyncIterableBridge` | 桥接 pi SDK 的 `session.subscribe()` 回调和 AsyncIterable，支持背压和溢出检测 |

**AgentEngine** 是平台的核心协调器。它持有：
- `SessionPool`：session 生命周期管理
- `ModelRouter`：模型选择
- `WorkspaceManager`：工作目录
- `SessionStore`：Redis 持久化
- `ToolPlatform`：工具治理

**SessionPool 状态机**：
```
                  canCreate()
   (不存在) ──────────────────→ idle
                add()
                                   markBusy()
   idle ───────────────────────────────────→ busy
     ↑                                          │
     │        markIdle() (refCount=0)             │
     └──────────────────────────────────────────┘
     
   idle ──→ evicting ──→ (删除)
        evictLRU()
```

- 全局上限：`maxSessions`（默认 20）
- 每租户上限：`maxSessionsPerTenant`（默认 5）
- LRU 驱逐：仅驱逐 `idle` 状态的 session
- 空闲超时：`idleTimeoutMs`（默认 300s）— 预留字段，当前未启用定时驱逐

### Platform Layer

#### ModelRouter

```typescript
async initialize()
  → ModelRuntime.create()（pi SDK）
  → 加载 api key（env var 优先，其次 ~/.pi/agent/auth.json）
  → 调用 getAvailable() 获取所有可用模型
  → 自动选择第一个可用模型作为默认
  → 可用 PI_PLATFORM_PROVIDER / PI_PLATFORM_MODEL env var 覆盖（需同时设置）

resolve(provider?, model?)
  → 优先使用指定 provider/model
  → 未找到 → failover 链（anthropic → openai → google）
  → 仍未找到 → 最后 fallback 到自动检测的第一个模型
```

#### ToolPlatform（C8 治理层）

ToolPlatform 是 pi 内置工具的**治理外壳**，不是工具的重新实现。

```
pi 内置工具 (read, bash, edit, write)
         ↓
   ToolPlatform（治理层）
   ├── allowlist 过滤       → getAllowedTools(tenantId)
   ├── 审计日志              → recordToolStart/End()
   ├── Prometheus 指标       → toolCallsTotal
   └── governExecution()     → 正式调用入口（预留给外部 Hook）
         ↓
   AgentEngine.prompt() 的 subscribe 回调
```

当前 pi 的 `createAgentSession` 直接使用 `toolPlatform.getAllowedTools(tenantId)` 返回的工具列表传入 SDK。治理事件在 `session.subscribe()` 回调中记录（`recordToolStart` / `recordToolEnd`）。

#### 扩展方式

**注册自定义工具**：

```typescript
// main.ts 中 assembly 阶段
toolRegistry.registerCustomTool("my-tenant", {
  name: "weather",
  description: "查询指定城市的天气",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  version: 1,
  idempotent: true,
  executor: "local",
});
```

- 工具名不能与内置工具（`read/bash/edit/write/grep/find/ls`）重名
- 每个租户有独立的 allowlist：`setTenantAllowlist(tenantId, [...])` 可定制
- `ToolExecutor` SPI 提供 `execute(request): AsyncIterable<ToolEvent>` + `cancel(toolCallId)` 接口
- 自定义工具的治理事件（审计 + 指标）通过 `ToolPlatform.recordToolStart/End()` 记录

详见 `examples/custom-tool/index.ts`。

#### WorkflowOrchestrator

> ⚠️ **与 PTL pit-flow 的区别**：本节是 PTH 服务端的 BullMQ 集中编排；PTL 的 `pit-flow`（`src/ptl/flow/`）是本地波次并行引擎，两者独立。PTL 程序经 `pit hub submit` 上传后由 **ProgramStore**（下节）托管，可选走本编排器或直接起 session 运行。

```
Orchestrator (App 层状态机)
  ├── 读取 workflow intent 从 Redis
  ├── 调度 AgentEngine 执行 agent 步骤
  ├── BullMQ intent worker 处理异步任务
  └── 分布式锁（Redis Lua 脚本 safe delete）

步骤类型：
  agent        → 创建 session + prompt + 等待完成
  parallel     → (stub，预留)
  condition    → (stub，预留)
```

#### 扩展方式

**定义工作流**：

```typescript
const reviewFlow: WorkflowDefinition = {
  id: "code-review",
  name: "自动代码审查",
  contentHash: "abc123",
  steps: [
    { type: "agent", index: 0, agentConfig: { project: "repo" }, prompt: "审查代码", idempotencyKey: "step-0" },
    { type: "agent", index: 1, agentConfig: { project: "repo" }, prompt: "根据审查结果生成修复", idempotencyKey: "step-1" },
    { type: "human-approval", index: 2, question: "是否合并？", timeoutMs: 3600_000 },
  ],
};

await orchestrator.execute(reviewFlow, tenantId);
```

四种步骤类型中 `agent` 和 `human-approval` 可用，`parallel` 和 `condition` 为 stub。工作流执行获取 Redis 分布式锁，Lua 脚本安全释放，`fencingToken` 防止误删。

#### ProgramStore（PTL→PTH 桥服务端）

`src/pth/programs/` + `gateway/routes-programs.ts` —— 托管 PTL `pit hub submit` 上传的 agent 程序。

```
POST   /api/v1/programs              上传程序（tar，INCR 版本号，tar 安全解包 + GC）
GET    /api/v1/programs              列出程序
GET    /api/v1/programs/:name        程序详情/版本
DELETE /api/v1/programs/:name        删除
POST   /api/v1/programs/:name/run    运行（起一次性 session，SSE 双信封 {seq,type,data} 直推，流结束自动销毁）
```

程序 = `agent.json` manifest + skills + systemPrompt。运行时通过 `DefaultResourceLoader` 的 `appendSystemPrompt` / `additionalSkillPaths` / `noContextFiles` 注入；工具取 tenant allowlist 交集；每 run 独立 workspace（扁平名 `program-run-<sessionId>`，因 WorkspaceManager 不允许 `/`）。Fastify bodyLimit 提到 6MB 以容纳程序包。

#### Self-Modify（自修改）

三层模型：

| 层级 | 内容 | 实现 | 生效 |
|------|------|------|------|
| L1 热加载 | skills/prompts/settings 文件变更 | `HotReloader`（chokidar） | 即时，下次 turn 生效 |
| L2 工具注册 | 新增工具定义文件 | `ToolRegistry.registerCustomTool()` | 需重启 |
| L3 代码变更 | 平台核心代码更新 | `RebuildTrigger` + `supervisor.sh` | 外部 supervisor 接管 |

**L3 流程**：
```
RebuildTrigger.requestRebuild(tenantId, commitHash)
  → 写入 /data/platform/.rebuild-request 文件
  → supervisor.sh 检测到 .rebuild-request
  → kill 旧进程 → npm ci + build → 启动新版本
  → 健康检查 → 失败则回滚到符号链接
```

#### 扩展方式

**热加载开发指引**：在 `{DATA_DIR}/platform/` 下创建文件，chokidar 自动检测变更。

```bash
# L1: 添加 SKILL.md（即时生效，下次 turn 使用）
mkdir -p .pi-platform-data/platform/skills/my-skill/
# 写入 SKILL.md（必须包含 # 标题），保存后自动热加载

# L2: 注册新工具（需重启）
# 在 main.ts 中调用 toolRegistry.registerCustomTool()

# L3: 代码变更（通过 RebuildTrigger + supervisor.sh）
# 写入 .rebuild-request → supervisor 检测 → A/B 符号链接切换
```

- 监听目录：`skills/`、`prompts/`、`config/`
- `SKILL.md` 校验：必须包含 Markdown 标题
- `settings.json` 校验：必须是合法 JSON
- 错误文件不覆盖上次成功 hash

#### WorkspaceManager

```
ensureWorkspace(tenantId, project)
  → 创建 /data/workspaces/{tenantId}/{project}
  → 返回 cwd（传入 createAgentSession）

路径结构：
  {dataDir}/
    workspaces/{tenant}/{project}/    ← Agent 工作目录
    platform/                         ← skills/prompts/tools/config
    tenants/{tenant}/                 ← 租户级配置
```

路径完全由服务端根据 `tenantId` 推导，不接受客户端指定（C5）。

### Infrastructure Layer

#### 存储模型

使用 Redis 的 **append-only entry + snapshot** 模型：

```
SessionMeta       → session:{tenant}:{sessionId}:meta（字符串 JSON）
SessionEntry      → session:{tenant}:{sessionId}:entry:{seq}（独立 key）
Snapshot          → session:{tenant}:{sessionId}:snapshot:{seq}（定期写入）
VersionSnapshot   → session:{tenant}:{sessionId}:vsnapshot:{seq}（每 turn）
SessionIndex      → session-index:{tenant}（ZSET，member 为 {"sessionId","project"}）
```

回放时：取最新 snapshot + 其 seq 之后的所有 entry。

#### 扩展方式

**替换存储后端**：实现 `SessionStore` 和 `SettingsStore` 接口即可。

接口方法（完整列表）：

```typescript
interface SessionStore {
  appendEntry / getEntries / getMeta / saveMeta
  saveSnapshot / getLatestSnapshot / listSessions
  deleteSession / saveVersionSnapshot / getLatestVersionSnapshot
}
interface SettingsStore {
  get / set
}
interface CredentialProvider {
  getApiKey(tenant, provider) → Promise<string | null>
}
```

替换方式：在 `main.ts` 中改变实例化（其余代码通过接口消费，无需改动）：

```typescript
// 原: const sessionStore = new RedisSessionStore(redis);
// 改为:
const sessionStore = new PostgresSessionStore(pgPool);
const settingsStore = new VaultSettingsStore();
const credentials = new DatabaseCredentialProvider(dbPool);
```

详见 `examples/custom-store/index.ts`（内存版 SessionStore 完整示例）。

#### 跨 OS 抽象（PlatformAdapter）

```typescript
interface PlatformAdapter {
  os: "linux" | "darwin" | "win32";
  shell: { execute(cmd, cwd) → Promise<{stdout, stderr, exitCode}> };
  fs: { readFile, writeFile, mkdir, exists, watch? };
  process: { env, cwd, signal: { graceful } };
}
```

- POSIX 实现：使用原生 `child_process`、`fs`、`process`
- Win32 实现：映射 `%USERPROFILE%` 等路径差异、处理 CRLF

---

## 数据流：一次 prompt 请求的完整生命周期

```
1. Client → POST /api/v1/sessions/:id/prompt
   {"text": "列出当前目录"}

2. Gateway (Fastify)
   ├── auth hook：验证 Bearer token，提取 tenantId
   └── routes-sessions：设置 SSE headers

3. AgentEngine.prompt(sid, tenantId, text)
   ├── 租户校验：managed.tenantId !== tenantId → Forbidden
   ├── Pool.markBusy(sid)
   ├── session.subscribe(callback)        ← pi SDK
   ├── session.prompt(text)              ← pi SDK（fire, 通过 subscribe 收事件）
   └── createBridge()：push/done/error → AsyncIterable

4. pi SDK 内部
   ├── 读取 cwd 目录 → system prompt
   ├── 流式请求 LLM（model 已在 createSession 时通过 ModelRouter.resolve() 选定）
   └── 触发工具调用 → 执行 → subscribe 推送事件

5. AgentEngine 处理事件
   ├── text_delta → push(seq, "message_update", ...)
   ├── tool_execution_start → recordToolStart() → audit + metrics
   ├── tool_execution_end → recordToolEnd() → audit + metrics
   ├── message_end → tokensTotal.inc() → Prometheus
   └── agent_end → done() → push(terminal=true)

6. Gateway 写入 SSE
   data: {"seq":1,...}\n\n
   data: {"seq":2,...}\n\n
   ...
   data: [DONE]\n\n

7. AgentEngine 收尾
   ├── await promptPromise（等待 pi SDK 完成）
   ├── checkpoint()：computeVersionSnapshot → saveVersionSnapshot()
   └── Pool.markIdle(sid)
```

---

## 硬约束详解

### C1: 跨模块 JSON DTO + 流式 AsyncIterable

所有模块间通信通过 `src/core/types.ts` 定义的接口。流式数据使用 `AsyncIterable<AgentEvent>`，经过 Bridge 转换。不支持直接共享对象引用。

### C2: 无 OS 沙箱

仅通过 `cwd` 隔离工作目录。Agent 的 `bash` 工具以调用者身份执行，无 Docker/VM 沙箱。适用于内部团队可信任环境。

### C3: BullMQ 仅用于无状态短任务

工作流编排的状态机在 `WorkflowOrchestrator`（App 层）维护。BullMQ intent 仅传递简短的 JSON 任务描述，不直接执行长时间 Agent session。

### C4: worker_threads（Phase 1 降级）

BullMQ worker 当前在主进程运行（`createIntentWorker` 在 `main.ts` 直接调用）。未来迁移到 `worker_threads` 隔离。

### C5: Token → tenantId，路径服务端推导

认证通过 `auth:token:{token}` → `{tenantId}`。工作目录路径由 `WorkspaceManager.ensureWorkspace(tenantId, project)` 服务端生成，格式固定为 `{dataDir}/workspaces/{tenantId}/{project}`。

### C6: pino + Prometheus

日志：pino JSON 格式输出到 stdout。
指标：prom-client 注册，暴露在 `/metrics`。
关键指标已接入：`tokensTotal`、`toolCallsTotal`、`sessionsActive`、`promptDuration`、`selfModifyTotal`。

### C7: Engine 层租户校验

`AgentEngine` 的 `prompt()`、`abort()`、`destroySession()` 均校验 `tenantId` 是否匹配。Gateway 的租户信息从 auth hook 注入，不信任客户端。

### C8: 工具适配器模式

pi 的 4 个内置工具（read/bash/edit/write）通过 `getAllowedTools(tenantId)` 传入 `createAgentSession`。`ToolPlatform` 提供治理层（审计日志、指标、allowlist），不重写工具本身。

### C9: Turn 级版本快照

每个 prompt 完成后执行 `checkpoint()`：
```
computeVersionSnapshot()
  → 遍历 /data/platform/skills/*, prompts/*, tools/*
  → SHA256 hash（前 12 位） → saveVersionSnapshot() → Redis
```

### C10: 外部 supervisor 回滚

`scripts/supervisor.sh` 在平台进程外部运行，负责 A/B 符号链接切换、健康检查、自动回滚。Layer 3 代码变更由 `RebuildTrigger` 写入标记文件，supervisor 检测并接管。

---

## Phase 2 迁移路径

当业务需要时，模块化单体可以渐进式拆分：

```
Phase 1（当前）             Phase 2（目标）
───────────────           ───────────────
单进程                     Dapr sidecar + K8s

Gateway     → 独立 Pod（无状态，水平扩展）
Engine      → 有状态 Pod（Dapr state store 管理 session 亲和性）
Workflow    → Dapr Workflow（替代 BullMQ state machine）
Tool Exec   → 独立 Deployment（安全隔离）
Storage     → Dapr State Store（Redis → 多后端可选）
```

迁移成本低，因为模块间已经是接口通信（C1），接口不需要改变。
