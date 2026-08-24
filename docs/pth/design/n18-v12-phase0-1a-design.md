# N18：v1.2 Phase 0 / 1a 实施设计（K0 + K1a）

> 2026-08-18 · 审稿后路线切换（`n16-v1.2-role-expansion-review.md` +
> `n16-v1.2-role-domain-composition-design.md`）。本文件是 K0/K1a 两条车道的实施契约。
> K0 = 设计纠偏（数量事实源 + Discipline Catalog 契约与数据）；K1a = 知识正确性收口
> （tenant 隔离 + 常规检索 official + hit 计数最小接线）。两 lane 文件域不重叠，可并行。

## 0. 车道划分

| Lane | 内容 | 分支 / worktree | 主要文件域 |
|---|---|---|---|
| **K0** | Phase 0 设计纠偏 | `lane/k0-v12-design` / `.worktrees/k0` | `src/pth/contracts/domains.ts`、`src/pth/catalog/discipline-catalog.ts`、`scripts/build-discipline-catalog.ts`、`src/pth/catalog/data/discipline-catalog-data.ts`（生成）、测试 |
| **K1a** | Phase 1a 知识正确性收口 | `lane/k1a-knowledge-hardening` / `.worktrees/k1a` | `packages/pth-memory/src/memory-store-pg.ts`、`src/pth/execution/knowledge-broker.ts`、`src/pth/impls/kernels/capability.ts`（skills.list 过滤）、相关测试 |

合并序：K0 → K1a。

---

## 1. K0 契约

### 1.1 `src/pth/contracts/domains.ts`（新）

```ts
export type DomainId = string;
export type DomainLevel = "category" | "discipline" | "sub-discipline";
export const DOMAIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface DomainDefinition {
  id: DomainId;
  names: Record<string, string>;      // 至少含 zh-CN；en 可为 id 派生的回退
  aliases: string[];
  parents: DomainId[];                // 允许多父；目录整体必须无环
  level: DomainLevel;
  description: string;
  methodAnchors: string[];
  sourceRegistryIds: string[];
  toolAnchors: string[];
}

export interface DomainBinding {
  matches: Array<{ domainId: DomainId; confidence: number; evidence: string[] }>;
  primaryDomain?: DomainId;
  catalogVersion: string;
  resolverVersion: string;
}
```

校验（纯函数导出）：
- `validateDomainDefinition(d)`：id 正则、level 合法、names 为对象且至少一个非空值、
  description 非空、aliases/parents/anchors 为字符串数组（parents 元素满足 id 正则且无重复）；
- `validateDomainBinding(b, knownIds: Set<DomainId>)`：matches 非空可空？**matches 可为空**；
  每条 domainId 必须在 knownIds 且 matches 内唯一、confidence ∈ [0,1]、evidence 字符串数组、
  primaryDomain 若提供必须在 matches 中。

### 1.2 `src/pth/catalog/discipline-catalog.ts`（新）

- `DisciplineCatalogBuilder`：
  - `add(d: DomainDefinition)`：调用 1.1 校验；重复 id fail-closed（抛错）；
  - `build(): DisciplineCatalogSnapshot`：
    - 所有 parents 必须存在（缺父 fail-closed）；
    - 多父 DAG **无环**（DFS/入度校验，环上节点名进错误信息）；
    - 输出确定排序（按 id）；
    - `version` = 稳定指纹：FNV-1a(`<id>:<level>:<parents.join(">")>:<names.zh-CN>` 拼接的
      排序序列)——同数据同版本，顺序无关；
  - snapshot 方法：`get(id)` / `list()` / `ancestors(id)`（含自身，按深度稳定序）/
    `descendants(id)` / `resolveAlias(aliasOrId)`（先 id，后 aliases；歧义 fail-closed）/
    `counts(): { category, discipline, subDiscipline, total }`。
- 本模块**只放契约与结构**，不 import 百科/知识正文/数据库。

### 1.3 数据生成 `scripts/build-discipline-catalog.ts`

- 事实源：`docs/pth/design/n16-v1.2-role-expansion.md` 的 §2.1–§2.5 五张角色表（§2.6 非
  researcher **不导入**——它们是角色候选，不是 domain）。
- 解析规则：
  - 只取形如 `| id | 3/4/5 | parent | 职责 |` 的行；
  - gen 映射：3→category、4→discipline、5→sub-discipline；
  - `names = { "zh-CN": <职责列中“——”之前的最短职责名或整段截断 80 字符>, "en": <id> }`；
    （没有 en 真实译名，首版以 id 为 en 回退——文档化）；
  - `parents`：category → `[]`；discipline → 其表内父 category；sub-discipline → 其表内父
    discipline；
  - `description` = 职责列原文（截断 200 字符）；`aliases/methodAnchors/sourceRegistryIds/
    toolAnchors` 首版为空数组（试点阶段填充）。
- 输出：`src/pth/catalog/data/discipline-catalog-data.ts`——
  `export const DISCIPLINE_DEFINITIONS: DomainDefinition[]`（按 id 排序）+ 文件头注明生成源
  与命令，**禁止手改**。
- 脚本模式：
  - 默认：解析并复算数量 → 写数据文件；
  - `--check`：重新解析与磁盘文件逐字节/内容一致 + 数量断言；
  - 数量断言（事实源钉死）：**category=5、discipline=32、sub-discipline=147、total=184**；
    任何不符非零退出（这就是“manifest 复算取代手写总数”）。
- 首跑后把生成文件提交进 K0 车道；文档中的 149/112/160+ 不再作为事实源（文档修订由合并者
  统一处理，K0 车道不改 docs）。

### 1.4 K0 测试

- `test/pth-catalog/discipline-catalog.test.ts`：重复 id / 缺父 / 环 / 多父通过、
  ancestors/descendants/resolveAlias（歧义拒绝）/counts/version 确定性；
- `test/pth-catalog/discipline-catalog-data.test.ts`：数据文件 counts=5/32/147/184、
  全部 parents 可解析、`DisciplineCatalogBuilder.build()` 无环、version 稳定。
- 全量 vitest + `npm run lint` 绿。

---

## 2. K1a 契约

### 2.1 tenant 隔离（`packages/pth-memory/src/memory-store-pg.ts`）

- `MemoryEntry` 增 `tenantId?: string`（不强制——存量调用默认 default）。
- `PgMemoryStore` 构造签名改为
  `constructor(pool: pg.Pool, opts?: { defaultTenantId?: string })`，缺省
  `DEFAULT_TENANT_ID = "default"`（导出）。
- 方法语义（全部向后兼容 default tenant）：
  - `write`：INSERT `tenant_id` 取 `entry.tenantId ?? defaultTenantId`；
  - `get(id, opts?: { tenantId?: string })`：`WHERE id=$1 AND tenant_id=$2`；tenant 不符 →
    undefined；
  - `update(id, patch, opts?: { force?: boolean; tenantId?: string })`：
    `WHERE id=$1 AND tenant_id=$2`，0 行 → 抛 `entry not found in tenant <t>`（fail-closed，
    不静默 no-op）；
  - `retrieve(opts & { tenantId?: string })`：新增 `tenant_id=$tenant` 条件（缺省 default）；
    **status 默认语义不变**（避免破坏治理流）——official-only 由新端口/broker 表达；
  - `listIds(opts?: { tenantId?: string })`：缺省只列 default tenant；
  - `incrementAggregate(..., opts?: { tenantId?: string })`：upsert 键 + tenant 条件；
  - `bumpHitCount(id, opts?: { tenantId?: string })`：tenant 条件。
- 不做 DDL 迁移（tenant_id 列已存在且 default 'default'）；不在本批改主键为 (tenant,id)。

### 2.2 常规检索 official（`KnowledgeBroker`）

- `KnowledgeBrokerDeps.dataWorld.memory` 窄口扩为：
  `retrieve(opts: { anchors?; kinds?; status?; tenantId? })`、`get(id, opts?: { tenantId? })`、
  可选 `recordConsumption?(id: string, tenantId?: string): Promise<void>`。
- `retrieve` op：status 固定 `["official"]`（draft/archived 不回给 worker），
  tenantId = `grant.scope.tenantId`；
- `get` op：tenantId = grant.scope.tenantId；命中后 `await deps.recordConsumption?.(id, tenantId)`
  ——这区分“列表 exposure”（不计数）与“全文 consumption”（计数）；
- `query` op 本批保持（诊断通道），但 broker 注释明确 v1.2 K3 收敛为 search/get。
- 装配（`src/pth/kernel/assembly.ts` 的 broker 创建处）：
  `recordConsumption: (id, tenantId) => dataWorld.memory.bumpHitCount(id, { tenantId })`。
  若 assembly 无 broker 创建点，则不改装配，仅测试注入。

### 2.3 skills.list 排除 archived

- `src/pth/impls/kernels/capability.ts` 的 `skills.list`：
  现 `filter(s => s.status !== "draft")` 改为 `s.status === "official"`
  （draft 与 archived 都不出现在 worker 面；治理查询走 store/其它通道）。

### 2.4 K1a 测试

- `packages/pth-memory/test/memory-store-pg.test.ts` 增：
  跨 tenant write/get/retrieve/listIds/update/bumpHitCount 隔离与 fail-closed；
- `test/pth-execution/knowledge-broker.test.ts`（或现有文件）增：
  retrieve 只回 official（draft/archived 排除）、tenantId 从 grant 透传、
  get 命中触发 recordConsumption；
- capability 相关测试：`skills.list` 不含 draft 与 archived；
- 全量 vitest + `npm run lint` 绿。存量调用不传 tenant 的测试应保持默认 tenant 兼容。

---

## 3. 通用约束

- worktree + 分支：`.worktrees/k0`/`lane/k0-v12-design`、`.worktrees/k1a`/`lane/k1a-knowledge-hardening`；
- 不 npm install、不改 README 徽章、不改 concepts.md / parallel-lanes.md / TODO.md（合并者归账）；
- 各自全量 vitest + lint 绿后一条 commit，不 merge/push；
- 返回改动文件、测试结果、偏差说明。
