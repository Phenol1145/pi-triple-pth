# N19：v1.2 Phase 1b 实施设计（K1b——provenance + revision + refiner draft）

> 2026-08-18 · 审稿 P1-2/P1-4 的落地契约。K0/K1a 已落（N18）。
> 目标：官方领域知识强制 provenance；memory_entries 获得 append-only revision 历史；
> refiner 不再直写 official，只产带 tenant/space/provenance 的 scoped draft。
> K4 的候选验证/晋升闭环将在本批地基上实现——本批不做 promotion 服务。

## 0. 车道

- 分支 `lane/k1b-provenance` / `.worktrees/k1b`；合并序：main → K1b（单 lane）。

---

## 1. pth-memory：provenance 强制

### 1.1 新模块 `packages/pth-memory/src/knowledge-provenance.ts`

```ts
export const PROVENANCE_REQUIRED_KINDS: ReadonlySet<string> =
  new Set(["domain-fact", "domain-method"]);

export interface KnowledgeProvenance {
  sourceTaskId: string;
  producerRole: string;
  producerModel: string;
  sourceRefs: string[];        // 至少 1 条非空
  contentHash: string;         // sha256(content) hex
  createdAt: number;
}

export function contentHashOf(content: string): string;   // node:crypto sha256
export function buildKnowledgeProvenance(args: {
  content: string; sourceTaskId: string; producerRole: string; producerModel: string; sourceRefs: string[]; createdAt?: number;
}): KnowledgeProvenance;
export function validateKnowledgeProvenance(meta: unknown, content: string):
  { ok: true; provenance: KnowledgeProvenance } | { ok: false; error: string };
```

校验规则：六字段齐全；sourceRefs 为非空字符串数组；contentHash 必须是 64 位 hex
且与 `contentHashOf(content)` 一致（哈希不符 = 拒绝）。

### 1.2 PgMemoryStore.write 门禁

- 当 `entry.status === "official"` 且 `PROVENANCE_REQUIRED_KINDS.has(entry.kind)`：
  `validateKnowledgeProvenance(entry.meta, entry.content)`，失败 → throw（调用即拒绝，
  不落库）。draft/archived 不强制（候选先 draft，晋升时已有 provenance）。
- `write` 其余语义不变。

---

## 2. pth-memory：append-only revision

### 2.1 DDL（`packages/pth-memory/src/schema.ts` 追加到 MEMORY_SCHEMA_SQL）

```sql
CREATE TABLE IF NOT EXISTS memory_revisions (
  id BIGSERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  anchors JSONB NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT,
  reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_revisions_entry_rev
  ON memory_revisions(entry_id, tenant_id, revision);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_entry ON memory_revisions(entry_id);
```

### 2.2 接口

```ts
export interface MemoryRevision {
  entryId: string; tenantId: string; revision: number;
  content: string; status: MemoryEntry["status"]; anchors: string[];
  meta: Record<string, unknown>; createdAt: string; createdBy?: string; reason?: string;
}

async revisionHistory(entryId: string, opts?: { tenantId?: string }): Promise<MemoryRevision[]>;
async restoreRevision(entryId: string, revision: number, opts?: { tenantId?: string; createdBy?: string }): Promise<void>;
```

### 2.3 write 事务化（append-only 语义）

- `write(entry, opts & { createdBy?: string; reason?: string })` 改为单连接事务：
  1. `BEGIN`；
  2. `SELECT id, tenant_id, content, status, anchors, meta, version FROM memory_entries
     WHERE id = $1 FOR UPDATE`；
  3. 已有行 → `INSERT INTO memory_revisions (...)` 记**旧版本**（revision=旧 version、
     tenant=旧 tenant_id、createdBy/ reason=opts）；无行 → 不记历史；
  4. 执行现有 INSERT…ON CONFLICT DO UPDATE（K1a 语义与 SQL 不变）；
  5. `COMMIT`；异常 `ROLLBACK` 后重抛；`finally client.release()`。
- 幂等写（content 与声明版本均未变）**不产生** revision 行（历史只记实际变更）；
- 跨 tenant 同 id 仍遵循现有 PK 语义（K1a 未改主键）；revision 行的 tenant 取旧行 tenant。
- `restoreRevision`：`revisionHistory` 查目标 → 用其 content/status/anchors/meta 构造
  MemoryEntry（tenant 取 opts.tenantId ?? 历史 tenant）→ `write(entry, { force: true,
  createdBy, reason: "restore", ... })`，meta 追加 `{ restoredFromRevision: revision,
  restoredAt: Date.now() }`。恢复同样先自动记录当前版本历史。

### 2.4 测试

- `packages/pth-memory/test/memory-store-pg.test.ts`（真实 PG testcontainers）增：
  首次写无历史；同 id 更新 → 历史 revision=1、内容为旧值；幂等重写不增历史；
  restore 后 active 内容=目标 revision 且历史含恢复前版本 + restoredFromRevision；
  revisionHistory 跨 tenant 隔离（default 查不到另一 tenant 历史）；
- provenance 单测 `test/…/knowledge-provenance.test.ts`（六字段/哈希不符/非 hex/sourceRefs 空）。
- 现有 memory-store-pg 测试若因事务/DDL 受影响，先修自身改动。

---

## 3. refiner：只写 scoped draft

### 3.1 `RefineInput` 契约

- 新增**必填** `scope: { tenantId: string; space: string }`；
- 新增可选 `outcome?: { status: string; result?: unknown }`、`artifactRefs?: string[]`
  （供 provenance.sourceRefs；缺省用 `["task:<id>"]`）。

### 3.2 持久化语义（逐条替换）

| 产物 | 旧 | 新 |
|---|---|---|
| tool-function | official | **draft** + `tenantId` + `spaceScope:{space, visibility:"private"}` + provenance |
| task-insight | official | **draft** + 同上 |
| differentiation-proposal | draft（无 scope） | draft + `tenantId` + `spaceScope` private |
| raw 自定义任务 | draft（无 scope） | draft + `tenantId` + `spaceScope` private |
| refine-report | official（无 scope） | official + `tenantId` + 显式 `spaceScope:{space, visibility:"private"}`（诊断自用，不隐式 public） |

- provenance 字段：`sourceTaskId=task.id`、`producerRole=role ?? task.claimed_by`、
  `producerModel=deps.model ?? "deepseek-v4-flash"`、`sourceRefs=artifactRefs ?? [task:<id>]`、
  `contentHash=contentHashOf(content)`、`createdAt=Date.now()`；写入 meta.provenance。
- `Refiner.refine` 开头：scope 缺失/字段非法 → throw `refine scope required`（fail-closed，
  不进 LLM）。
- `RefinerDeps.memory` 类型仍为 `Pick<PgMemoryStore,"write"|"retrieve">`。

### 3.3 调用方接线

- `src/pth/bootstrap/task-loop.ts` 调用处传
  `scope: { tenantId: task.tenantId ?? "default", space: "meta" }`（meta = 系统提炼空间，
  显式而非 fallback）；如该上下文可拿到 outcome/artifactRefs 一并传入；
- `src/pth/runner/observers/refine-observer.ts` 同传 scope；
- 其他调用方（测试）同步更新。

### 3.4 测试

- 更新 refiner 单测：所有产物 status=draft（refine-report 除外）、meta 含
  tenantId/spaceScope/provenance、contentHash 与实际内容一致；
- 新增 fail-closed：缺 scope 直接抛错，不调用 llm；
- 全量 vitest + `npm run lint` 绿。

---

## 4. 通用约束

- 不改 concepts.md / parallel-lanes.md / TODO.md / README / 其它 schema（只在
  MEMORY_SCHEMA_SQL 追加 revision 表）；
- worktree k1b 内完成：定向测试 → 全量 vitest → npm run lint，一条 commit，不 merge/push；
- 返回改动文件、测试结果、偏差说明。
