# N20：v1.2 Phase 2 实施设计（K2——Discipline Catalog 双轴任务契约 + Resolver）

> 2026-08-18 · 组合设计 Phase 2 落地契约（依赖 K0 的 `DisciplineCatalog` + K1a 的 tenant 语义）。
> 目标：任务契约获得多值 `domains`；发布路径用 Discipline Resolver 解析并机读盖章；
> 角色路由（assignedRole）与学科识别（domains）**双轴分离**。K3 的 KnowledgeContext 读本批产物。

## 0. 车道

- 分支 `lane/k2-discipline-catalog` / `.worktrees/k2`；单 lane，合并序 main → K2。

---

## 1. 任务契约扩展

### 1.1 `src/pth/contracts/tasking.ts`

```ts
export interface TaskWorkItem {
  // 既有字段不动
  readonly domains: readonly DomainId[];        // 可为空；确定性排序
  readonly domainBinding?: DomainBinding;        // 解析证据（机读盖章）
}
```

### 1.2 `PublishInput` / 任务 payload 契约

- `src/pth/kernel/storage/task-store-pg.ts` 的 `PublishInput` 增可选
  `domains?: string[]`、`domainBinding?: DomainBinding`；
- publish 时由 resolver 归一后写进 `payload` 的 `domains`（字符串数组）与 `domainBinding`
  （DomainBinding 对象）两个键——**这两个键是服务器解析产物**；调用方 payload 里的同名键
  不直接可信，以 resolver 输出覆盖。

---

## 2. Discipline Resolver（`src/pth/catalog/discipline-resolver.ts` 新）

```ts
export interface DisciplineResolveInput {
  title: string; text: string; tags: readonly string[];
  /** 显式 domains（调用方声明——仍需 catalog 校验；可为空） */
  explicitDomains?: readonly DomainId[];
}
export type DisciplineResolveResult =
  | { ok: true; binding: DomainBinding }
  | { ok: false; error: string };
```

规则（v1，保守可解释）：

1. 显式 domains 非空：
   - 每个 id 必须 `catalog.get(id)` 存在，未知 id fail-closed；
   - matches = 去重后的显式 ids（按 id 排序），confidence=1，evidence=[`explicit:<id>`]；
2. 显式为空 → 别名扫描（非 LLM）：
   - 对 catalog 每个节点：`aliases` 全部 + `names["zh-CN"]`（若存在）做子串匹配
     `title + " " + text`（大小写不敏感）；命中者 confidence=0.6，evidence=[`text:<alias>`]；
   - 按 id 排序取前 5；无命中 → matches=[]（允许空 domains——回退通用 researcher）；
3. `primaryDomain` = matches 第一条（显式优先）；`catalogVersion` = catalog.version；
   `resolverVersion` = `"v1-explicit-alias"`；
4. 输出必须通过 `validateDomainBinding(binding, catalog.ids())`。

- 构造：`createDisciplineResolver(catalog: DisciplineCatalogSnapshot)`。
- **不做** tags 与 domain 互转（role tags 与 domain ids 命名空间分离，P0-4 裁决）。

## 3. 发布路径接线

### 3.1 `PgTaskStore`

- 构造签名：`constructor(pool, routing?, disciplineResolver?)`；
- `publish`（非 delegate 通道）：
  1. 从 `input.domains ?? payload.domains` 取显式 domains（payload.domains 必须是字符串数组，
     否则按空处理）；
  2. resolver 存在 → `resolve({title,text,tags,explicitDomains})`；`!ok` → 400 fail-closed；
  3. 合并 payload：`{ ...payload, domains: matches[].domainId, domainBinding: binding }`；
  4. 既有 routing/盖章逻辑不变；delegate 通道沿用父任务 domains（resolver 不重跑——
     delegate 是父工作流的子任务，域继承而非重新识别；其 payload.domains 由父 capability 传入）。
- `createDataWorld(pool, routing, disciplineResolver?)` 透传第三参。

### 3.2 `TaskControlService.publish`

- 不新增职责：`PublishInput.domains` 从路由 body 透传；scope 盖章逻辑不变。

### 3.3 外部路由 `/api/v1/kernel/tasks`

- 请求体增可选 `domains?: string[]`（顶层显式声明）；route 校验数组/字符串非空后并入
  `publishTask` input；非法形态 400。
- `delegate` capability 不开放 domains 参数（子任务继承父任务 payload.domains）。

### 3.4 claim 工作项映射

- `pg-task-repository.toWorkItem`：
  `payload.domains` 为字符串数组 → `domains`（去重排序）；
  `payload.domainBinding` 结构合法 → `domainBinding`；否则 domains=[]。
- `TaskWorkItem` 新增字段全仓消费点补齐（编译期全量暴露）。

## 4. 测试

- `test/pth-catalog/discipline-resolver.test.ts`：
  显式单域/多域去重、未知显式 id fail-closed、别名命中（zh/alias）、无命中空 domains、
  primaryDomain、binding 通过 validate、resolverVersion/catalogVersion。
- `test/pth-tasking/pg-task-repository`（或现有）claim 映射：payload.domains 合法/非法、
  domainBinding 合法/缺失。
- `test/pth-kernel-storage/task-store-pg` 或集成：publish 显式 domains → payload 盖章
  domains+binding；未知 id 400；delegate 继承 domains。
- 全量 vitest + `npm run lint` 绿。

## 5. 约束

- 只碰 contracts/tasking、tasking adapters、kernel/storage、catalog、gateway route、
  assembly/batch-process 装配点与测试；不改 concepts/parallel-lanes/TODO/README；
- 全量绿后一条 commit 到 `lane/k2-discipline-catalog`，不 merge/push；
- 返回改动文件、测试结果、偏差。
