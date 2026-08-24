# Execution Target Matrix 标准化计划

> 状态：已实施（Phase 1–5 已落地；2026-08-23 验收通过，本文档保留为设计/落地对照）
> 目标：给出**标准化的 `ExecutionTarget` 定义**，让 engine 解析 notebook cell 请求后，按统一规则决定由哪个执行组件执行。
> 关联代码：`src/pth/execution/`、`packages/pth-kernel-execution/src/exec-channel.ts`、`packages/pth-sandbox/`、`deploy/services/jupyter/`
>
> **命名决策（已定）**：执行组件的标准化抽象命名为 **`ExecutionTarget`**，以避免与 `src/pth/tools/types.ts` 里工具级的 `executor: local|container|remote|mcp` 冲突。本文 “执行器矩阵 / Executor Matrix” 均指 **Execution Target Matrix**。

---

## 1. 背景与目标

### 1.1 现状问题
当前 Jupyter notebook 的 cell 执行路径是**写死**的：

```
pi-kernel → engine /api/v1/kernel/notebook/execute
         → KernelExecChannel.executeNotebookCell()
         → KernelManager
         → 默认 sandbox-kernel（python/bash）；ts 在 engine 进程内
```

这条路径：
- 不经过 `ExecutionBackendRegistry`；
- 不支持按 cell / 按 notebook 选择执行位置；
- `python` / `bash` / `ts` 的语言是固定的（`JUPYTER_ENGINE_LANG`），不能按 cell 声明。

而实际上，系统里已经存在多个执行组件，并且它们**都已经跑在 execution/v1.1 协议上**：

| 执行组件 | 协议 | 模式 | 现状 |
|---|---|---|---|
| sandbox（kernel 池） | execution/v1.1 | **persistent** `/sessions` | notebook python/bash 默认走这里 |
| sandbox（一次性） | execution/v1.1 | sync `/exec` | batch / professional runtime 用 |
| local-lean / local-u8 | execution/v1.1 | sync | 宿主命令执行器 |
| tool-container（compiled/network） | execution/v1.1 | sync | 工具容器 |
| jupyter（south） | execution/v1.1 | sync | 无头 notebook 执行 |
| engine-internal ts | 进程内 `TsInterpreter` | — | 不走 execution 协议 |

**关键洞察**：协议已经统一在 execution/v1.1 之下。我们缺的不是协议，而是：
1. 一个**统一的 `ExecutionTarget` 抽象**（把上述组件都描述成同一种东西）；
2. 一个 **notebook 层的路由器**，按 `(language, target)` 把 cell 分发到对应 ExecutionTarget；
3. 各 ExecutionTarget 对 “执行一个 cell” 的**语义适配**（REPL vs 一次性命令）。

### 1.2 目标
- 定义**标准化 `ExecutionTargetDefinition`**：每个执行组件一份声明式定义。
- 定义 **ExecutionTarget 注册表**：从 `deploy/executor-matrix.json` + `PTH_EXEC_BACKENDS` + tool/service registry 装配。
- 定义 **NotebookTargetRouter**：解析 cell 的语言与目标，路由到 ExecutionTarget。
- 保持**安全默认**：未声明目标时仍走 `sandbox`（隔离、生产默认）。

### 1.3 非目标
- 不重新发明执行协议（继续用 execution/v1.1）。
- 不改变 batch / professional runtime 的现有执行路径。
- 不在本计划内实现富媒体（MIME bundle）——单独立项，但 `ExecutionTargetDefinition` 为其预留字段。

---

## 2. 现状盘点（grounded inventory）

### 2.1 执行组件清单
| id | kind | profile | 语言 | 会话模型 | 协议绑定 |
|---|---|---|---|---|---|
| `sandbox` | kernel-pool | sandbox-untrusted | python, bash | persistent REPL | execution-session（backendId=`sandbox`） |
| `local-lean` | command | host | bash（命令） | one-shot | execution-backend（backendId=`local-lean`, sync） |
| `local-u8` | command | host | bash（命令） | one-shot | execution-backend（backendId=`local-u8`, sync） |
| `tool-compiled` | command | dev-container | bash（命令） | one-shot | execution-backend（backendId 来自 tool registry, sync） |
| `tool-network` | command | dev-container | bash（命令） | one-shot | execution-backend（同上） |
| `jupyter` | command | host | bash/python（driver） | one-shot | execution-backend（backendId=`jupyter`, sync） |
| `engine-ts` | engine-internal | engine | ts | one-shot（vm context） | engine-internal |

> 注：`tool-compiled` / `tool-network` 的 backendId 由 `buildExecutionBackendRegistry` 从 tool registry 合并（`domain=compiled|network`）。`local-lean` / `local-u8` / `jupyter` 由 `PTH_EXEC_BACKENDS` 或 service registry 提供。

### 2.2 现有装配入口
- `src/pth/execution/backend-registry.ts` → `buildExecutionBackendRegistry()`：
  - 输入 `PTH_EXEC_BACKENDS`（descriptor JSON）+ tool registry + service registry；
  - 产出 `ExecutionBackendRegistry`（`HttpExecutionBackend` map + professional runtime routes）。
- **注意**：`HttpExecutionBackend.execute()` 会**拒绝 `mode=persistent`**；persistent 会话能力在 `HttpExecutionClient` 的 session API 里，未暴露给 `HttpExecutionBackend`。
- notebook 的 sandbox persistent 执行目前走 `SandboxKernel`（直连 `/sessions`），**不经过**该注册表。

---

## 3. 标准化 ExecutionTarget 定义（核心交付物）

### 3.1 类型定义（TypeScript）
落点：`packages/pth-contracts/src/execution-target.ts`（跨切面契约，和已有 `execution.ts` 并列）。

```ts
import type { ExecutionModes, ExecutionProfile } from "@away_from/shared/execution";

/** notebook 可执行语言（可扩展："c"、"lean"…） */
export type NotebookLanguage = "python" | "bash" | "ts";

/** ExecutionTarget 实现形态 */
export type ExecutionTargetKind =
  | "kernel-pool"        // 持久 REPL 池（sandbox python/bash）
  | "command"            // 一次性命令执行（local/tool/jupyter）
  | "engine-internal";   // engine 进程内解释器（ts）

/** 会话模型 */
export type SessionModel =
  | { readonly type: "persistent-repl"; readonly scope: "notebook"; readonly ttlMs?: number }
  | { readonly type: "one-shot" }     // 每 cell 独立
  | { readonly type: "none" };

/** ExecutionTarget 能力（富媒体字段为后续 MIME bundle 预留） */
export interface ExecutionTargetCapabilities {
  readonly richMedia: boolean;        // 是否可产出 mimeBundle
  readonly streaming: boolean;
  readonly cancel: boolean;
  readonly pathMapping: boolean;
  readonly maxOutputBytes?: number;
}

/** 路由策略 */
export interface ExecutionTargetRoutingPolicy {
  /** 该 ExecutionTarget 是哪些语言的默认执行组件 */
  readonly defaultFor: NotebookLanguage[];
  /** 是否允许 cell magic 显式选择 */
  readonly userSelectable: boolean;
  /** 是否需要用户显式批准后才能使用（如 local/tool） */
  readonly requiresApproval: boolean;
}

/** engine 如何触达该 ExecutionTarget（判别联合） */
export type ExecutionTargetBinding =
  | { readonly type: "execution-backend"; readonly backendId: string; readonly mode: "sync" | "stream" }
  | { readonly type: "execution-session"; readonly backendId: string }      // persistent /sessions
  | { readonly type: "engine-internal"; readonly interpreter: "ts" };

/** 信任档：复用共享 ExecutionProfile，扩展 "engine" 内部分类（不下发 execution/v1.1） */
export type ExecutionTargetProfile = ExecutionProfile | "engine";

/** 标准化 ExecutionTarget 定义（每个执行组件一份） */
export interface ExecutionTargetDefinition {
  /** engine 内唯一 id，^[a-z][a-z0-9._-]{0,63}$ */
  readonly id: string;
  readonly kind: ExecutionTargetKind;
  /** 信任档；engine-internal 用 "engine" */
  readonly profile: ExecutionTargetProfile;
  readonly description?: string;
  /** 支持的语言 */
  readonly languages: NotebookLanguage[];
  /** execution/v1.1 模式位图（复用现有类型） */
  readonly modes: ExecutionModes;
  readonly session: SessionModel;
  readonly capabilities: ExecutionTargetCapabilities;
  readonly routing: ExecutionTargetRoutingPolicy;
  readonly binding: ExecutionTargetBinding;
}

/** Router 只依赖该只读接口，不依赖 src/pth 实现（由装配层注入） */
export interface ExecutionTargetRegistry {
  get(id: string): ExecutionTargetDefinition | undefined;
  list(): ReadonlyMap<string, ExecutionTargetDefinition>;
  /** 按语言/显式 target 解析；非法或未批准时抛结构化错误 */
  resolve(language: NotebookLanguage, target?: string | null): ExecutionTargetDefinition;
}
```

> 依赖与导出：`ExecutionModes` / `ExecutionProfile` 来自 `@away_from/shared/execution`，因此 `packages/pth-contracts/package.json` 需新增 `@away_from/shared` 依赖；新增 `execution-target.ts` 后必须同步 `packages/pth-contracts/src/index.ts` 的 barrel 导出。

### 3.2 注册表 JSON Schema
事实源：`deploy/executor-matrix.json`（文件事实源，和 `runtime-profiles.json` 同级）。

```json
{
  "version": 1,
  "targets": [
    {
      "id": "sandbox",
      "kind": "kernel-pool",
      "profile": "sandbox-untrusted",
      "languages": ["python", "bash"],
      "modes": { "sync": true, "stream": false, "interactive": false, "persistent": true },
      "session": { "type": "persistent-repl", "scope": "notebook", "ttlMs": 1800000 },
      "capabilities": { "richMedia": true, "streaming": false, "cancel": true, "pathMapping": false },
      "routing": { "defaultFor": ["python", "bash"], "userSelectable": false, "requiresApproval": false },
      "binding": { "type": "execution-session", "backendId": "sandbox" }
    },
    {
      "id": "engine-ts",
      "kind": "engine-internal",
      "profile": "engine",
      "languages": ["ts"],
      "modes": { "sync": true, "stream": false, "interactive": false, "persistent": false },
      "session": { "type": "one-shot" },
      "capabilities": { "richMedia": false, "streaming": false, "cancel": true, "pathMapping": false },
      "routing": { "defaultFor": ["ts"], "userSelectable": false, "requiresApproval": false },
      "binding": { "type": "engine-internal", "interpreter": "ts" }
    }
  ]
}
```

动态 target（`local-lean` / `local-u8` / `tool-compiled` / `tool-network` / `jupyter`）**不静态写入本文件**，由 `PTH_EXEC_BACKENDS` + service/tool registry 派生。若确需显式覆盖，按 `buildExecutionBackendRegistry` 的既有语义：**显式配置优先，派生冲突产生 warnings**。示意（派生后的内存形态，不作为文件内容）：

```json
{
  "id": "local-lean",
  "kind": "command",
  "profile": "host",
  "languages": ["bash"],
  "modes": { "sync": true, "stream": false, "interactive": false, "persistent": false },
  "session": { "type": "one-shot" },
  "capabilities": { "richMedia": false, "streaming": false, "cancel": false, "pathMapping": true },
  "routing": { "defaultFor": [], "userSelectable": true, "requiresApproval": true },
  "binding": { "type": "execution-backend", "backendId": "local-lean", "mode": "sync" }
}
```

> 校验函数 `validateExecutionTargetMatrix()` 参照 `validateExecutionBackendDescriptor()` 的 fail-closed 风格：重复 id / 非法 language / binding.backendId 未注册 → 装配期抛错。若 contracts 内已有 `isXxxStructurallyValid()` 布尔风格，可提供布尔校验 + 抛错包装，避免风格分裂。

### 3.3 语义约定
- **默认路由**：未声明 target 时，按 `routing.defaultFor` 命中语言的那个 ExecutionTarget（当前即 `sandbox`）。
- **userSelectable=false**：cell magic 无法选中（如 `sandbox` 始终默认，不允许显式绕过）。
- **requiresApproval=true**：首次使用需用户确认（沿用 `pth-cli-command-registry-design.md` 里的批准机制），非交互环境拒绝。
- **会话归属**：`persistent-repl` 的 session 由 notebook 的 `sessionId` 维持；`one-shot` 每 cell 独立，不复用状态。
- **能力位**：`modes` 是 execution/v1.1 协议事实源；`capabilities.streaming` 保留为 Router 快速能力位，若实现时发现冗余可收敛到 `modes`（避免双源漂移）。

---

## 4. NotebookTargetRouter 设计

### 4.1 职责
输入：cell 的 `(language, target?, code, sessionId)`；
输出：选中某个 `ExecutionTargetDefinition` 并调用其执行适配。

### 4.2 cell 目标声明（cell magic）
在 `pi-kernel` 侧解析首行（不引入 IPython）：

```
%%python              → language=python, target=default
%%python sandbox      → language=python, target=sandbox
%%bash local-lean     → language=bash,   target=local-lean
%%ts                  → language=ts,     target=default
```

- 未写 magic → 用 `JUPYTER_ENGINE_LANG` 作为默认语言，`target` 走默认路由。
- `pi-kernel` 把 `language` + `target` 一并放进 notebook execute 请求。

### 4.3 engine 侧路由
扩展 `POST /api/v1/kernel/notebook/execute` 请求：

```json
{
  "language": "python" | "bash" | "ts",
  "target": "sandbox" | "local-lean" | "tool-compiled" | "jupyter" | "engine-ts" | null,
  "code": "...",
  "sessionId": "...",
  "timeoutMs": 60000
}
```

Router 决策：
1. `target` 为空 → 按 `defaultFor[language]` 选 ExecutionTarget。
2. `target` 非空 → 查注册表；`userSelectable=false` 或 `requiresApproval` 未批准 → 拒绝（结构化错误）。
3. 校验 `language ∈ target.languages`，否则 `INVALID_REQUEST`。
4. 按 `target.binding` 分发：
   - `execution-session` → persistent 会话执行（现有 `SandboxKernel` 路径）。
   - `execution-backend` → `ExecutionBackendRegistry.get(backendId).execute()`（sync）。
   - `engine-internal` → 现有 `TsInterpreter`。

### 4.4 落点
- 类型 / 只读接口：`packages/pth-contracts/src/execution-target.ts`（含 `ExecutionTargetRegistry` 接口）
- 注册表 builder：`src/pth/execution/execution-target-registry.ts`（复用 `buildExecutionBackendRegistry`，实现 `ExecutionTargetRegistry`）
- Router：`packages/pth-kernel-execution/src/execution/notebook-target-router.ts`（**只依赖 `ExecutionTargetRegistry` 接口，不 import `src/pth/**`**）
- 注入：`src/pth/kernel/assembly.ts` 装配真实 registry，经 `KernelExecChannel` 的 deps 注入 Router
- 接入：在 `exec-channel.executeNotebookCell()` 内调用注入的 Router（替换当前写死的 `createManager()` 路由）
- barrel：新增 `notebook-target-router.ts` 后同步 `packages/pth-kernel-execution/src/execution/index.ts` 导出

---

## 5. 分阶段实施计划

### Phase 0 — 盘点与冻结（已完成）
- 交付：执行组件清单表（本文 §2.1）。
- 验收：确认各类执行组件的协议 / 模式 / 会话模型无遗漏。

### Phase 1 — ExecutionTarget 类型与校验（核心定义）
- 新增 `packages/pth-contracts/src/execution-target.ts`：`ExecutionTargetDefinition` / `SessionModel` / `ExecutionTargetBinding` / `ExecutionTargetRegistry` 等。
- `packages/pth-contracts/package.json` 新增 `@away_from/shared` 依赖；`src/index.ts` 增加 `export * from "./execution-target.js"`。
- 新增 `validateExecutionTargetMatrix()`（fail-closed；若 contracts 走布尔风格则同时提供 `isExecutionTargetMatrixStructurallyValid()` + 抛错包装）。
- 单测：合法/非法 schema、重复 id、非法 language、binding 校验、barrel 导出。
- 验收：`npm run lint` + 新增单测全绿。

### Phase 2 — ExecutionTarget 注册表
- 新增 `src/pth/execution/execution-target-registry.ts`：
  - 从 `deploy/executor-matrix.json` + `PTH_EXEC_BACKENDS` + tool/service registry 装配。
  - `deploy/executor-matrix.json` 只声明静态/标准 target；`local-lean` / `local-u8` / `tool-*` / `jupyter` 由 service/tool registry 派生。
  - 冲突优先级沿用 `buildExecutionBackendRegistry`：显式配置优先，派生冲突产生 warnings。
  - 把 `execution-session`（persistent）能力纳入，补齐 `HttpExecutionBackend` 未暴露 persistent 的缺口（或在 registry 层单独持有 session client）。
- 单测：装配、冲突优先级、缺失后端告警。
- 验收：注册表能列出 §2.1 全部执行组件。

### Phase 3 — NotebookTargetRouter + cell magic
- 扩展 `pi-kernel`（`packages/pth-cli/deploy/services/jupyter/kernels/pi-kernel/pi_kernel.py`）解析 `%%<lang> [target]`，并在请求 payload 增加 `target`。
- 扩展 `notebook/execute` API：
  - `src/pth/gateway/routes-kernel.ts`：解析并校验 `target` 字段。
  - `src/pth/application/gateway/pth-gateway-facade.ts`：透传 `target`。
- 扩展 `packages/pth-kernel-execution/src/exec-channel.ts`：`NotebookCellRequest` 增加 `target?: string | null`；`NotebookCellResult` 可增加 `target?: string`（观测用）。
- 实现 Router 决策（§4.3），Router 只依赖 `ExecutionTargetRegistry` 接口。
- `src/pth/kernel/assembly.ts` 装配真实 registry，通过 `KernelExecChannel` deps 注入。
- 接入 `exec-channel.executeNotebookCell()`。
- barrel：`packages/pth-kernel-execution/src/execution/index.ts` 导出 `notebook-target-router.js`。
- 集成测试：默认走 sandbox；显式切 `local-lean`/`engine-ts`；非法目标拒绝。
- 验收：`print(x)` 在 sandbox 报 NameError（已修）；`%%ts` 能跑 ts。

### Phase 4 — 各 ExecutionTarget 的 cell 适配
- 为 `command` 类 ExecutionTarget（local/tool/jupyter）实现 “cell → 命令” 包装（如 `bash -lc <code>`）。
- 明确 `one-shot` 语义（无跨 cell 状态）。
- 验收：`%%bash local-lean` 能在宿主跑命令并回传输出。

### Phase 5 — 会话生命周期 + 安全
- `pi-kernel` 增加 `do_shutdown` → 主动 `cancel` engine 侧 session（修当前泄漏）。
- `requiresApproval` 批准/撤销机制接入。
- 验收：重启 kernel 后旧 session 被释放。

### Phase 6 — 文档 / 测试 / 发布
- 更新 `deployment.md`、`concepts.md` 的执行拓扑描述。
- 更新 `pth-api-protocol.md` / `kernel.md` 的 notebook execute 请求与 `target` 语义。
- 全量回归（`npm test` + `npm run lint` + e2e）。
- 发布 patch 版本。

> 富媒体（MIME bundle）不在本计划，单独立项；`ExecutionTargetCapabilities.richMedia` 已预留。

---

## 6. 决策记录（已裁决）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 抽象命名 | **`ExecutionTarget`**（避免与工具级 `executor` 冲突） |
| 2 | `engine-internal` ts | **纳入矩阵**，统一抽象（`binding=engine-internal`） |
| 3 | 注册表事实源 | **`deploy/executor-matrix.json`**（文件） |
| 4 | 类型落点 | **`packages/pth-contracts`**（新增 `@away_from/shared` 依赖；同步 barrel 导出） |
| 5 | one-shot 组件状态 | `local`/`tool`/`jupyter` 一律 `one-shot`（推荐，待 Phase 4 确认） |
| 6 | Router 依赖边界 | Router 只依赖 `ExecutionTargetRegistry` 接口；真实实现由 `src/pth` 装配注入 |
| 7 | 动态 target 来源 | `local-lean`/`local-u8`/`tool-*`/`jupyter` 由 service/tool registry 派生；静态文件只声明标准 target；显式 `PTH_EXEC_BACKENDS` 优先并告警 |
| 8 | 类型复用 | `ExecutionModes` / `ExecutionProfile` 复用 `@away_from/shared/execution`；`"engine"` 作为本地 `ExecutionTargetProfile` 扩展，不下发 execution/v1.1 |

---

## 7. 结论
- 协议已统一（execution/v1.1），**不缺协议，缺抽象与路由**。
- 本计划的核心交付物是 §3 的 **标准化 `ExecutionTargetDefinition`** + 注册表 + Router。
- 工程量集中在 Phase 1–3（类型 / 注册表 / 路由），Phase 4–6 为适配与收尾。
- 安全默认不变：未声明目标 → `sandbox`。
