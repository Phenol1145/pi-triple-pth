# PTH 框架契约（Framework Contracts）

> 状态：**活文档**（2026-08-16 建立，依据模块化 v2 完成后代码）。
> 代码是事实源：类型与校验见 `src/pth/contracts/`，机器强制见 `scripts/check/check-pth-boundaries.ts`
> （`npm run check:pth-boundaries`，已并入 `npm run lint`）。本文是人读的单一入口；
> 代码与本文冲突时以代码为准，并应同步修正本文。

## 1. 模块地图（框架 / 实现）

```
src/pth/
├── contracts/       框架契约（纯类型+结构校验，无宿主依赖；含 role-routing-policy / program /
│                    catalog-contribution-schema 端口）
├── tasking/         任务机制：claim→run→commit、CAS、observers
│   └── adapters/    实现：pg-task-repository / pg-task-queries
├── runner/          纯执行：AgentTaskRunner + TaskWorkspace/RunnerConfig（index.ts 公共 API）
│   └── observers/   实现：audit/transcript/activity/metrics/notifier/refine/optimizer
├── execution/       执行授权 + 知识访问
│   ├── authorization/   实现：HMAC grant 签发/校验、replay guard
│   └── adapters/        实现：sandbox HTTP 执行 / PTH dataWorld 知识适配
├── catalog/         不可变运行时目录 + 策略
│   ├── adapters/    实现：内置角色/空间 manifest
│   └── extensions/  扩展贡献：loader / policy / context（schema 已上移 contracts）
├── bootstrap/       组合根（composition root）：buildPthHost + module manifest
│                    + task-loop / batch-process（2026-08-17 模块优化 P0：执行装配移出 kernel）
├── application/     gateway 唯一 kernel 适配面（PthGatewayFacade）
├── gateway/         HTTP 层（只经 facade / 公共模块 API 访问）
├── kernel/          存量核心引擎（assembly/storage/execution 等——已不再反向依赖上层模块）
│   └── execution/   worker-cluster / space-registry / builtin-roles / builtin-spaces / kernel-factories
└── impls/           具体实现（核；角色/空间定义已下移 kernel——本目录保留兼容 re-export）

packages/
├── pth-sandbox/     沙箱域 + 内核 interpreter 契约（Interpreter/WorkerKernel 等）
└── pth-memory/      记忆域（可见性/存储/技能）
```

理解方式：**框架 = contracts/tasking/runner/execution/catalog/bootstrap 的机制面；
实现 = 各 `adapters/`、`impls/`、`application/gateway`、两个 packages；
bootstrap 是唯一接线处。**

## 2. 公共契约清单

### 2.1 contracts/（纯类型 + 校验；零 fastify/pg/redis/pth-sandbox import）

| 域 | 符号 | 说明 |
|---|---|---|
| identity | `TenantScope` / `WorkspaceRef` | 服务器端派生 scope；workspace 为 opaque 引用（不承载宿主路径） |
| tasking | `TaskLease` / `TaskLeaseReference` / `TaskWorkItem` / `TaskOutcome` / `ArtifactRef` | lease 是 capability：UUID + generation + deadline |
| tasking 端口 | `TaskRepository` / `TaskReadModel` / `TaskRunner` | claim/recover/commit；pending/get；run(lease+work)→outcome |
| execution | `ExecutionRequest` / `ExecutionGrant` / `ExecutionResult` / `ExecutionPort` | grant 绑定 lease/scope/workspace/language/capabilities/deadline + 签名 |
| 校验器 | `is*StructurallyValid` 系列、`TASK_MAX_CLAIMS` | 只做结构形状，不产生授权 |

### 2.2 tasking/

| 符号 | 契约 |
|---|---|
| `TaskDispatcher`（`TaskDispatcherDeps`） | 固定 `claim → run → commit`；claim 空零执行；stale lease 跳过；pause/stop 控制 |
| `TaskOutcomeCommitter` / `TaskOutcomeCommitterPort` | commit 只委派 `TaskRepository.commit` |
| `TaskOutcomeObserver` / `TaskOutcomeObserverEvent` / `notifyObservers` | 只在 `committed=true` fan-out；单 observer 失败隔离 |
| `BoundedBackgroundQueue` | 慢 observer（refine/optimizer）有界后台，不阻塞下一轮 claim |
| adapters：`createPgTaskRepository` / `PgTaskQueries` / `TaskControlService` / `toTaskWorkItem` | PG 实现；publish 的 createdBy/tenantId 只取 scope |

### 2.3 runner/

| 符号 | 契约 |
|---|---|
| `AgentTaskRunner` | 只收 `{lease, work}` 出 `TaskOutcome`；不调用 repository/audit/transcript/notify；`await kernel.reset()` 完成后执行 |
| `TaskWorkspace` / `makeTaskWorkspace` | dir/tenant/taskId 值对象（分配/归档在调度层） |
| `RunnerConfig` / `defaultRunnerConfig` | agentMode/aspMode 环境默认 |
| observers：`createAuditObserver` 等 7 类 | 见 §4 生命周期 |

### 2.4 execution/

| 符号 | 契约 |
|---|---|
| `ExecutionGrantService`（`createExecutionGrantService`） | issue/verify：签名、过期、generation、replay、request 绑定；密钥只来自注入的 `GrantKeyProvider` |
| `GrantKeyProvider` / `createHmacGrantKeyProvider` | HMAC 签名/验签（timing-safe）；无默认密钥 |
| `ReplayGuard` / `createMemoryReplayGuard` | nonce 单次消费，有界 |
| `ExecutionService` | 唯一执行缝：grant 验证失败不触 adapter |
| `KnowledgeBroker`（`createKnowledgeBroker`） | grant 必须含 `memory.read`；空间只来自 `grant.scope.space`；body 自报 space 忽略；缺 meta 400 |
| adapters：`createSandboxExecutionAdapter` / `createPthKnowledgeBroker` | sandbox HTTP / dataWorld 实现 |

### 2.5 catalog/

| 符号 | 契约 |
|---|---|
| `RuntimeCatalogSnapshot` / `CatalogBuilder` / `RuntimeCatalogData` | build 后不可变；外部只拿副本；重复 id/非法 capability/policy fail-closed；id 字典序确定 |
| `CapabilityPolicy` / `validateCapabilityPolicy` | allow/deny（deny ⊆ allow）；能力名 `[A-Za-z0-9][A-Za-z0-9._-]*` |
| `RoleRoutingPolicy` / `createRoleRoutingPolicy` / `setRuntimeCatalog` | 只读快照路由；新生产代码优先走 catalog，旧全局 getter 仅兼容 |
| `SpaceLookup` / `createSpaceLookup` | 只读快照的 get/children/depth |
| adapters：`buildBuiltinCatalog` | 内置角色/空间折叠为同一 manifest（assembly 与 batch-process 等价） |
| extensions：`validateCatalogContributions` / `loadCatalogContributions` / `classifyExtensionDir` | 只收 roles/spaces/observers/capabilityPolicies；tools/events/kernels/debugAdapters/onStartup 拒绝；目录三分类 |

### 2.6 bootstrap/

| 符号 | 契约 |
|---|---|
| `PthModuleManifest` / `DEFAULT_MODULE_MANIFEST` / `validateModuleManifest` | 单 Host manifest；未知 module/非法 catalog fail-closed；无 PTH_PROFILE |
| `loadBootstrapConfig` | env → manifest/secret |
| `buildPthHost` → `BuiltPthHost` | 构建 catalog 并注入；main 与 batch-process 共用；监听/fork 前失败 |

### 2.7 application/gateway/

| 符号 | 契约 |
|---|---|
| `PthGatewayFacade` / `createPthGatewayFacade` | gateway 唯一 kernel 适配面；route-shape 方法，**无 pool/dataWorld/batchManager 字段** |

### 2.8 packages/

- `@away_from/pth-sandbox`：内核 interpreter 契约 `Interpreter/InterpreterResult/ExecuteOptions/WorkerKernel` 与持久核实现同包（拆分裁决）；另有 `SandboxLease`、sandbox grant verifier（wire 同构但零 core import）。
- `@away_from/pth-memory`：`MemoryEntry`、`isVisible`、skill/wiki 等记忆域契约。

## 3. 依赖方向

```
contracts ◄── kernel ◄── impls ◄── catalog ◄── bootstrap
     ▲         ▲                                │
     │         └── tasking ◄── runner ◄─────────┘
     └── execution ──── sandbox 包（经 impls/kernels 白名单 + sandbox adapter）

gateway ──► application/pth-gateway-facade ──► kernel / tasking（唯一窄口）
main ──► bootstrap / gateway / kernel / …（进程入口装配）
```

规则（机器强制，`scripts/check/pth-boundaries-core.ts`）：

1. `gateway/**` 不 import `KernelRuntime`/`DataWorldAccess`，不访问 `kernel.pool/kernel.dataWorld`。
2. `tasking/runner/execution/catalog/bootstrap` 之间只走他方 `index.ts` 公共 API；
   storage adapter 绑定例外：`bootstrap/**` 是组合根（task-loop/batch-process 装配点），允许 runtime-import
   `kernel/storage/*`——其余 framework 模块仍禁止。
3. domain 模块不 import `@away_from/pth-sandbox` 运行时；白名单仅 `impls/kernels/**`、`bootstrap/**`、`main.ts`。
4. `contracts/` 不 import fastify/pg/redis/`@away_from/pth-sandbox`。
5. 新增违规在 `npm run lint` 失败（基线机制：`scripts/check/pth-boundaries.baseline.json`）。

## 4. 生命周期不变量

- **任务**：`candidates → claim(lease UUID, generation+1, deadline) → run → commit(CAS)`；
  `committed=false` 不触发任何 observer；runner 抛错生成 `runner-crashed` terminal outcome 且只跑一次。
- **取消**：客户端 abort → `/kernel/cancel` 等 controller ack（kernel abort 落地、entry disposed）→ release；
  ack 不可达则本地 lease 作废，绝不乐观 release/复用。
- **执行**：无签名 grant 不得执行；grant 验证 = 结构 → 签名 → 未过期 → generation 匹配 → replay 单次；
  输出按字节上限截断且超限杀进程组。
- **知识访问**：`memory.read` capability + `grant.scope.space`（签名盖章）；请求体自报 space 不可授权。
- **装配**：同一 manifest → 同一 catalog；`buildPthHost` 失败发生在监听端口/fork worker 之前。
- **扩展进 catalog**：只接受有宿主实现的 roles/spaces/observers/capabilityPolicies；
  legacy tools/events/kernels 仍是合法 PTH 插件，但不能进 catalog（strict 模式拒绝）。

## 5. 遗留与迁移面

- `DataWorldAccess` / `createDataWorld`：`@deprecated assembly-only`，仅 bootstrap/assembly/facade 兼容持有。
- `worker-cluster`/`tagRegistry`/`spaceRegistry` 全局 getter：运行中兼容；新生产代码走 catalog policy/lookup。
- `ExtRegistry`：legacy 装载默认兼容；`strictCatalogContributions: true` 为 catalog 路径。
- token 化 `/api/v1/kernel/memory-bridge`：保留为兼容通道；grant 路径在 `/api/v1/kernel/knowledge`。

## 6. 变更契约的流程

1. 改 `src/pth/contracts/`（或对应模块公共 index）→ 更新结构校验器；
2. 更新实现 adapter 与装配点（bootstrap/assembly/batch-process）；
3. 先写失败测试再实现；
4. `npm run check:pth-boundaries`（或 `npm run lint`）零违规；
5. 更新本文与 `docs/pth/architecture.md`。

## 相关文档

- 分层总览：`docs/pth/architecture.md`
- HTTP API 契约：`docs/pth/api.md`
- 模块化决策：`docs/adr/0002-pth-modularization-re-review.md`
- 执行计划（已闭合）：`docs/superpowers/plans/2026-08-15-pth-modularization-v2.md`
