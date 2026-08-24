# N21：v1.2 Phase 3 实施设计（K3——KnowledgeContextProvider + broker search/get）

> 2026-08-18 · 组合设计 Phase 3 落地契约。依赖 K0（catalog）、K1a（tenant/official）、
> K2（TaskWorkItem.domains）。目标：每个任务在 claim 后获得**有界、可复现、版本化**的
> KnowledgeContext；KnowledgeBroker 获得窄 search/get 面（worker 不猜 SQL）。
> K4 的候选晋升用本批 broker 读取证据。

## 0. 车道

- 分支 `lane/k3-knowledge-context` / `.worktrees/k3`；单 lane。

---

## 1. KnowledgeContext 契约（`src/pth/runner/knowledge-context.ts` 新）

```ts
export interface KnowledgeContextEntry {
  entryId: string;
  version: number;                 // meta.version ?? 1
  anchor: string;                  // 第一个 anchor（展示用）
  summary: string;                 // content 前 240 字符（单行化）
  evidence: unknown;               // meta.provenance ?? null
}

export interface KnowledgeContext {
  id: string;                      // kc-<queryFingerprint>
  catalogVersion: string;
  queryFingerprint: string;        // FNV-1a hex（见 §2）
  domains: DomainId[];
  entries: KnowledgeContextEntry[];
  omitted: { count: number; reason: string };
}

export interface KnowledgeContextInput {
  tenantId: string;
  space: string;
  roleId: string;
  domains: readonly DomainId[];
  title: string;
  text: string;
  catalogVersion: string;
}

export interface KnowledgeContextProvider {
  build(input: KnowledgeContextInput): Promise<KnowledgeContext>;
}
```

- `createKnowledgeContextProvider(deps)`：
  - `memory.retrieve(opts & { tenantId })`（K1a 接口）；
  - `catalog?: DisciplineCatalogSnapshot`（提供 catalogVersion + ancestors 展开）；
  - `isVisible(meta, space)`（空间过滤——装配层传 K1a 同款可见性判定）；
  - `maxEntries = 8`、`summaryChars = 240`（可覆盖）。
- 排序（v1 确定性）：
  1. `relevance = 条目 anchors 与 domains 的交集数`（catalog 存在时，domain ancestors
     也计入命中面——anchors 数组最多取 8 个）；
  2. relevance 降序，再按 `id` 升序；
  3. 取前 maxEntries；剩余 `omitted={count, reason:"budget"}`。
- `queryFingerprint` = FNV-1a 32bit（`tenantId|space|roleId|domains(排序)|title|text|catalogVersion`
  的 `\n` join）转 8 位 hex；同输入同 catalog 同数据版本 → 同 id（可复现）。
- 检索条件：`anchors=domains`、`kinds=["domain-fact","domain-method","skill","task-insight"]`、
  `status=["official"]`、`tenantId`；空 domains → 不检索（entries=[]，domains=[]）。

## 2. Runner 接入（`src/pth/runner/agent-task-runner.ts`）

- `AgentTaskRunnerDeps` 增可选 `knowledgeContextProvider?: KnowledgeContextProvider`；
- `executeInner` 的 agent 路径：
  1. claim 后（kernel.reset 完成后）调用 `provider.build({...work, tenantId: work.scope.tenantId,
     space: 由 runner 配置/会话空间……})`；`space` 缺省 `"meta"`（显式传入，不是 fallback
     推理——K3 的 worker 会话空间可从 kernel sessionRef.currentSpace 取，取不到用 meta）；
  2. 组装任务正文：
     `work.text + "\n\n【Knowledge Context（catalog <ver>）】\n" + entries 每条 "- [entryId] anchor: summary"`；
     若 entries 空则追加一行「无相关 official 知识条目」；
  3. `capabilityInject` 增 `knowledge: { context }`（ts 程序可读轻量上下文）；
  4. 失败/降级：provider 抛错 → logger warn + 原文执行（知识降级不阻塞任务——组合设计
     §4.5 裁决）。
- legacy task-loop 路径本批不改（K3 只接新 runner；旧路径兼容）。

## 3. KnowledgeBroker search（`src/pth/execution/knowledge-broker.ts`）

- `KnowledgeOp` 增 `"search"`；`KnowledgeRequest` 增
  `queryText?: string`、`domains?: string[]`、`limit?: number`。
- `KnowledgeBrokerDeps.dataWorld.memory` 窄口增可选
  `search?(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string;
  queryText?: string; limit?: number })`；若未注入 search，则 broker 用 retrieve 兜底。
- search 语义：
  1. tenantId = grant.scope.tenantId（不可自报）；status 固定 official；
  2. anchors = request.domains ?? []；kinds = request.kinds ?? ["domain-fact","domain-method","skill","task-insight"]；
  3. queryText 非空 → 对结果做 case-insensitive 子串过滤（content 或 anchors 命中任一
     空白分词；无词命中则返回全部锚点结果——保守不误杀）；
  4. 按 id 升序（确定性），limit 缺省 8、≤20；
  5. 结果统一过 space 可见性过滤；返回 entries + queryFingerprint（同 §1 指纹函数）。
- `get` op 保持 K1a 语义（tenant + official? K1a get 未强制 official——K3 改为：
  非 official 返回 404（worker 面只读 official））。
- query op 仍保留诊断，注释说明。

## 4. 装配

- `createDataWorld` 不新增职责；K3 的 provider 在 runner 装配点注入：
  - `src/pth/bootstrap/task-loop.ts` 的 repository 分支/`agent-task-runner` 创建处：
    `knowledgeContextProvider = createKnowledgeContextProvider({ memory: dataWorld.memory,
    catalog, isVisible: filterVisibleEntries 同款判定 })`；
  - 若当前 runner 由 factory 统一创建（`kernel-factories.ts` / task-loop），在注入点补参数；
    找不到唯一装配点就只加类型/构造 + 测试注入，并在返回中说明。
- broker 生产 adapter（`pth-knowledge-broker.ts`）注入 `search` 实现（用 store.retrieve +
  queryText 过滤；或直接实现 broker 内兜底——二选一，保持一个实现）。

## 5. 测试

- `test/pth-runner/knowledge-context.test.ts`：指纹确定性、domains 检索、relevance 排序、
  budget omitted、空 domains、tenant 透传、provider 抛错时 runner 降级原文（fake provider）；
- `test/pth-execution/knowledge-broker.test.ts` 增 search（tenant 强制/official/queryText
  过滤/limit/空间过滤/指纹）、get 非 official 404；
- 全量 vitest + `npm run lint` 绿。

## 6. 约束

- 只碰 runner/execution/bootstrap 装配与测试；不改 concepts/parallel-lanes/TODO/README；
- 一条 commit 到 `lane/k3-knowledge-context`，不 merge/push；
- 返回改动文件、测试结果、偏差。
