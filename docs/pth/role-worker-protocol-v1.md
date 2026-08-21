# Role / Worker 定义协议 v1

> 状态：**定稿（2026-08-21）**。本文件是 engine 可变层（T1）的单一协议事实源；代码实现前先过本协议。
> 配套：`docs/POSITIONING.md`（三仓边界）、`docs/fracta-engine-execution-topology.md` §5.10（mutation tiers）。

## 1. 模型：Role = 类，Worker = 对象

| 概念 | 类比 | 文件/运行时 | 归属层 |
|---|---|---|---|
| RoleDefinition | 类声明 | `catalog/data/roles/<roleId>.json`（role-definition/v1） | T1 可变 |
| WorkerSpec | 实例化参数 | `catalog/data/workers.json`（worker-spec/v1） | T1 可变 |
| WorkerInstance | 实例化对象 | 运行时投影（`WorkerReplica` / `WorkerSlot`） | T0 机制，不可手写 |

- 角色定义 = 声明（prompt/capabilities/动作面）；worker = 有状态实例（role × replica）。
- 继承/组合生成**新角色**；修改角色产生**新 version**；两者都不改旧 worker 已绑定的定义。

## 2. `role-definition/v1`

### 2.1 文件格式

路径：`catalog/data/roles/<roleId>.json`，UTF-8，每文件一个角色。

```jsonc
{
  "schema": "role-definition/v1",
  "id": "myrole",
  "version": 1,
  "parent": "developer",
  "generation": 3,
  "tags": ["myrole"],
  "prompt": "你是 myrole ……",
  "capabilities": ["python", "bash", "memory"],
  "memoryScope": "own",
  "thinking": "medium",
  "model": null,
  "description": "…",
  "output": "…",
  "defaultReads": ["…"],
  "acceptanceRole": "writer",
  "differentiation": "…",
  "exploreKernels": ["python", "bash"],
  "actionTools": ["execPy", "execBash", "dev"],
  "loadPolicyRef": null
}
```

组合角色（与 `parent` 互斥二选一）：

```jsonc
{
  "schema": "role-definition/v1",
  "id": "fullstack-auditor",
  "version": 1,
  "composedFrom": ["analyst", "developer"],
  "generation": 4,
  "tags": ["fullstack-auditor"],
  "prompt": "…",              // 由组件 description 模板合成，可显式覆盖
  "capabilities": ["memory"],  // 缺省 = 组件交集，可显式覆盖
  "actionTools": ["dev"],      // 缺省 = 组件交集，可显式覆盖
  "memoryScope": "own"         // 缺省 own；全部组件为 all 且显式声明才可 all
}
```

### 2.2 字段与约束

| 字段 | 约束 |
|---|---|
| `schema` | 必须为 `role-definition/v1` |
| `id` | `^[a-z][a-z0-9-]{0,63}$`，全局唯一 |
| `version` | 正整数，单调递增；创建 = 1 |
| `parent` / `composedFrom` | 二选一；parent 必须已存在；composedFrom 非空且所有组件存在 |
| `generation` | 派生值：root=0；继承 = parent.generation+1；组合 = max(components.generation)+1。文件中声明值必须与计算一致（防手滑） |
| `tags` | 非空字符串数组，`tag-registry` 路由唯一标准 |
| `prompt` | 非空 |
| `capabilities` | capability 名白名单；缺省 = 宿主天花板 |
| `memoryScope` | `own` \| `all`；扩展角色缺省 `own` |
| `thinking` | `high` \| `medium` \| `low` |
| `acceptanceRole` | `read-only` \| `writer` |
| `actionTools` | 族名白名单（execTs/execPy/execBash/dev/debug/write/nav/cache 等） |

### 2.3 版本与 revision

- `version`：人读编辑代次。编辑必须携带 `baseVersion`；服务端检查 `baseVersion == 当前 version`，
  不一致返回 `409 CONFLICT`；成功则 `version = baseVersion + 1`。
- `revision`：内容寻址指纹 `role-sha256:<stable-json>`（沿用现有 `roleDefinitionRevision`）。
  **worker 只绑定 revision**，version 用于历史、回滚与并发控制。
- 任何字段变化（含 prompt 逗号）都会改变 revision；version 与 revision 一一对应但有不同用途。

### 2.4 继承与组合（生成新 role）

- **继承**：`POST /api/v1/kernel/roles/:id/derive`，body `{ specialization }`。
  新 role：`parent=:id`、`generation=parent.generation+1`、version=1、
  capabilities/thinking/acceptanceRole 继承，prompt 由模板生成。
- **组合**：`POST /api/v1/kernel/roles/compose`，body `{ from: string[], overrides? }`。
  新 role：`composedFrom=from`、`generation=max(...).generation+1`、version=1。
  缺省合并 = **最小权限**：capabilities/actionTools 取交集、memoryScope=own、
  prompt=组件 description 模板合成；`overrides` 可显式覆盖任何字段。
- 两种操作都生成**新文件**与**新 roleId**，不修改任何组件。

## 3. `worker-spec/v1`

路径：`catalog/data/workers.json`（取代裸 `PTH_WORKER_ROLES` 成为主源；env 仅 bootstrap 覆盖）。

```jsonc
{
  "schema": "worker-spec/v1",
  "defaultCopies": 1,
  "roles": {
    "developer":     { "copies": 3, "roleRevision": "auto" },
    "lean4-prover":  { "copies": 1 }
  },
  "policies": {
    "maxCopiesPerRole": 8,
    "maxTotalWorkers": 32,
    "drainGraceMs": 3600000,
    "drainOnRoleUpdate": "after-task"
  }
}
```

- `roleRevision: "auto" | "role-sha256:…"`：auto = 跟随当前文件 revision；显式 pin = 灰度/回滚。
- 运行时装配 = 现有 `assembleBatchRuntime(workerSpecs)`：`{role, requestedReplica}` → `WorkerSlot`
  （loop/kernel/dispose）。`WorkerReplica.ref = { roleId, roleRevision, workerId, batchId }` 不变。

## 4. REST 面（读写 + 只读）

所有写操作要求 `role: platform-admin`（或等价管理 scope），写 audit；GET 只读。

### 4.1 Worker 控制（对象实例）

| 方法/路径 | 语义 | 底层映射 |
|---|---|---|
| `POST /api/v1/kernel/workers` | 启动 worker：`{roleId, roleRevision\|version, copies}` | `batchManager.addWorker` |
| `GET /api/v1/kernel/workers` | 只读列表（roleId/roleVersion/roleRevision/state/currentTaskId/lease/心跳） | `queryWorkers` + batch 投影 |
| `GET /api/v1/kernel/workers/:workerId` | 单 worker 详情 | 同上过滤 |
| `POST /api/v1/kernel/workers/:workerId/pause` | 睡眠：暂停认领 | `pauseWorker` |
| `POST /api/v1/kernel/workers/:workerId/resume` | 唤醒 | `resumeWorker` |
| `POST /api/v1/kernel/workers/:workerId/stop` | drain-safe 停止 | `removeWorker` |
| `DELETE /api/v1/kernel/workers/:workerId` | 强制删除 | `removeWorker` |

状态机沿用 `WorkerReplica`：`idle → running → paused → stopped`，不新增 sleep 状态。

### 4.2 Role 控制（类定义）

| 方法/路径 | 语义 |
|---|---|
| `POST /api/v1/kernel/roles` | 新建 role（文件事实源，version=1） |
| `GET /api/v1/kernel/roles` | 完整定义列表（含 prompt/capabilities/actionTools/version/generation/revision） |
| `GET /api/v1/kernel/roles/:id` | 单角色完整定义 |
| `GET /api/v1/kernel/roles/:id/revisions` | version 历史（乐观并发/回滚依据） |
| `PUT /api/v1/kernel/roles/:id` | 修改 role：`{baseVersion, fields...}` → version+1 → drain-swap |
| `POST /api/v1/kernel/roles/:id/derive` | 继承派生新 role |
| `POST /api/v1/kernel/roles/compose` | 组合新 role |
| `POST /api/v1/kernel/roles/:id/apply` | 将已审批文件应用到运行时（drain-swap） |

### 4.3 任务/状态只读

| 方法/路径 | 返回 |
|---|---|
| `GET /api/v1/kernel/tasks/summary` | `{ counts: {pending, claimed, completed, rejected, …} }`（现 `/kernel/status` 的 tasks 部分） |
| `GET /api/v1/kernel/tasks` | 任务列表（现有，保持兼容） |

### 4.4 任务提交（Web 入口，现成能力）

| 方法/路径 | 语义 |
|---|---|
| `POST /api/v1/kernel/tasks` | 发布任务；`pth submit` 即其薄封装 |
| `GET /api/v1/kernel/templates` | 公开任务模板列表 |
| `GET /api/v1/kernel/tasks/:id` | 单任务状态 |
| `POST /api/v1/kernel/tasks/:id/cancel` | 取消（`recursive` 可选，沿 delivery 链传播） |

- 鉴权：`Authorization: Bearer <token>`；`tenantId/createdBy` 只从 token 声明派生，
  请求体不可覆盖（`routes-kernel.ts` P0-3/P1-3 语义）。
- 直接发布 body：`{title, text, tags?, payload?, flow?, domains?, idempotencyKey?}`；
  限制 title ≤200 字符、text ≤64KB。
- 模板发布 body：`{template, params, tags?, idempotencyKey?}`。
- 返回 `201 {id, status, assigned_role}`；operator console 的任务发布动作走同一端点。

## 5. GitOps 写回路径

1. Web/CLI 编辑只写 **proposal**（PG `memory_entries`，kind=`role-proposal`，status=draft）。
2. 审批：`platform-admin` 批准（可带 overrides）。
3. `pth role export --proposal <id>` 生成/更新 `catalog/data/roles/<id>.json`，人工 git 提交。
4. `POST /api/v1/kernel/roles/:id/apply`：读取文件 → `validateRoleDefinition` → runtime 投影 →
   drain-swap 生效。
5. `--draft` 仅用于本地试运行：写入 runtime 投影但**不落文件**，重启即丢，禁止用于生产。

## 6. 生效语义：drain-swap（热应用）

任何 task 从头到尾只由一个 worker 执行，且该 worker 绑定唯一 role revision。

```
1. validateRoleDefinition（字段 + lineage + 合并规则）
2. 注册新 revision（先不入路由）
3. pause 旧 revision 全部 worker        → 不再 claim 新任务
4. spawn 新 revision worker 并等就绪    → 新任务由新 worker claim
5. 旧 worker 跑完在飞任务 → stop → dispose → remove（WorkerSlotRuntime 已 drain-safe）
6. 审计 {fromVersion, toVersion, drained}
失败回滚：新 worker 起不来 → 旧 worker resume，继续旧 revision
```

- `drainGraceMs`：在飞任务超过时限仍未完成 → 强制 stop（任务失败重试，仍保持任务级一致）。
- `role-doc` 快照：worker 自读文档按 `role-doc:<roleId>@<version>` 取，避免旧 worker 读到新 prompt。
- 专业任务：grant 已绑定 roleRevision，旧在飞 grant 继续有效，新任务用新 revision。
- 可选冷应用：`POST /api/v1/kernel/roles/:id/apply {mode:"restart"}` 重启整个 engine（显式路径）。

## 7. Mutation Tiers（可改性分层）

| 层 | 内容 | 变更方式 |
|---|---|---|
| T0 不可修改 | contracts / execution wire / validate / grant / kernel·loop·interpreter 机制 / 装配 fail-closed / professional-runtime-lock / tool-manifest digest | PR + 门禁 + 镜像/npm 发布 |
| T1 声明式可变 | `catalog/data/**`：role-definition/v1、worker-spec/v1、policies、observers、spaces、任务模板、skills/prompts | 本协议：proposal → 审批 → 文件 → apply（热生效） |
| T2 配置可变 | PTH_* env / PTH_EXEC_BACKENDS / 模式开关 | 配置中心 + env + 重启（部分 runtime SET） |

机器断言（随实现加入 `check:pth-boundaries` 或独立脚本）：

- T0 源码不得 import `catalog/data/**`；
- role 对象在生产装配中只来自 catalog loader；
- T1 文件写入口只经 `pth role/worker` 或审批管线（写审计）；
- `catalog/data/**` 只允许出现在 T1 清单中，CI 拒绝新扩展点绕过协议。

## 8. 编辑面（实现依赖本协议）

- **CLI**：`pth role list/show/create/update/diff/revisions/export/apply`、
  `pth worker list/start/pause/resume/stop/status`。
- **Web**：operator console Role/Worker 页面；表单由 contracts 导出的 JSON Schema 生成，
  提供 baseVersion 冲突提示、drain 进度、副本约束即时校验。
- **Jupyter**：不参与 role/worker 编辑（前端分工：Jupyter 只做终端与 notebook 交互）。

## 9. 与现有实现的迁移映射

| 现状 | 协议后 |
|---|---|
| `builtin-roles.ts` 硬编码 | 迁为 `catalog/data/roles/*.json`（过渡期 TS re-export 兼容） |
| `registerWorkerRole` 重复 id 抛错 | 改为 revision 替换语义；旧调用点兼容 |
| `ExtRoleSchema`（5 字段） | 保留为 role-definition/v1 的受控投影（+extensionId，loader 展开） |
| `worker-role:<id>` memory 持久化 | 继续作为 runtime 投影与重启恢复；文件是事实源，启动时以文件为准 diff 并告警 |
| lineage approve 路由 | 改为 proposal 审批 + export 的前半段；后半段接 apply |
| `PTH_WORKER_ROLES` env | 保留为 bootstrap 覆盖；主源为 workers.json |
| obs/roles、obs/workers | 作为 §4 只读 GET 的数据来源，补充完整字段 |

## 10. 实施顺序与退出门

1. **P0**：contracts `validateRoleDefinition` + JSON Schema 导出 + 单元测试（先写失败测试）。
2. **P1**：`catalog/data` 布局 + 内置角色迁移为文件 + 启动 diff/告警；`PTH_WORKER_ROLES` 覆盖兼容。
3. **P2**：REST 只读面（roles 完整定义 / workers / tasks summary）上线。
4. **P3**：proposal 审批 + `pth role export` + GitOps 闭环。
5. **P4**：drain-swap apply（pause→spawn→drain→rollback）+ role-doc@version 快照。
6. **P5**：CLI 命令族 + console Role/Worker 页面（JSON Schema 驱动表单）。
7. 退出门：T1 修改全程不重启 engine；旧/新 revision 并行窗口可观测；409 冲突/回滚/审计测试全绿。

## 变更纪律

- 本协议任何字段/语义变更，先改本文件 + 三仓 `fracta-engine-execution-topology.md` §5.10；
- 涉及 RoleDefinition 的代码同步 `worker-cluster.ts` 注释与 contracts 校验器；
- 全量门禁（lint/build/test/docs-links）通过后合并。
