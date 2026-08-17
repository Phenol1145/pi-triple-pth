# N22：v1.2 Phase 4 实施设计（K4——候选验证与晋升闭环）

> 2026-08-18 · 组合设计 Phase 4 落地契约。依赖 K1b（refiner 已只写 scoped draft +
> provenance）、K1a（tenant/official 过滤）、K3（broker 只读 official）。
> 目标：draft 知识候选必须取得**领域 verdict + 对抗 verdict** 后，由 memory-keeper 受控晋升
> official；生产者不能核验自己的候选；每次晋升留痕可反查。
> 本批不新增 worker 角色；领域 verdict 走监督通道（HTTP），对抗 verdict 走
> controller:adversarial 能力。

## 0. 车道

- 分支 `lane/k4-knowledge-promotion` / `.worktrees/k4`；单 lane。

---

## 1. 状态机与契约（`src/pth/execution/knowledge-verdicts.ts` 新）

```ts
export type KnowledgeVerdictKind = "domain" | "adversarial";
export interface KnowledgeVerdict {
  kind: KnowledgeVerdictKind;
  verdict: "pass" | "reject";
  reviewerRole: string;      // domain:<id> 或 controller:adversarial 或 memory-keeper
  note: string;              // 非空
  at: number;
}
```

纯函数：
- `validateKnowledgeVerdict(v)`：kind/verdict/reviewerRole/note 校验；
- `canPromote(entry)`：
  - status === draft；
  - `meta.provenance` 存在且 `validateKnowledgeProvenance(meta.provenance, content)` ok；
  - `meta.verdicts` 数组含**至少一条 domain pass 与一条 adversarial pass**，且无 reject；
  - 生产/审核分离：provenance.producerRole 不得等于任一 pass verdict 的 reviewerRole，
    且 domain reviewer 与 adversarial reviewer 不得相同；
  - 返回 `{ok:true}|{ok:false,reason}`。

## 2. 服务（`src/pth/execution/knowledge-promotion.ts` 新）

```ts
export async function recordKnowledgeVerdict(
  store: Pick<PgMemoryStore, "get" | "update">,
  entryId: string,
  verdict: KnowledgeVerdict,
  opts?: { tenantId?: string },
): Promise<{ ok: true } | { ok: false; error: string }>;
```
- 仅 draft 可审；`validateKnowledgeVerdict` 失败拒绝；
- meta.verdicts append（同 kind 同 reviewer 重复提交 → 幂等返回 ok，不重复 append）；
- producer 自审 → 拒绝（`reviewerRole === provenance.producerRole`）。

```ts
export async function promoteKnowledgeEntry(
  store: Pick<PgMemoryStore, "get" | "write">,
  entryId: string,
  opts?: { tenantId?: string; promoterRole?: string; note?: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
```
- `canPromote` fail-closed；promoterRole 缺省 `"memory-keeper"`；
- 用 `store.write({ ...entry, status: "official", tenantId, meta: { ...entry.meta,
  promotion: { promotedBy, promotedAt, verdicts: entry.meta.verdicts } } },
  { force: true, reason: "knowledge-promotion", createdBy: promoterRole })`；
- official 后 provenance 门禁（K1b）自然再次校验。

```ts
export async function rejectKnowledgeEntry(store, entryId, reviewerRole, reason, opts?)
```
- 仅 draft；meta.verdicts 追加 reject verdict + `status:"archived"` via update（不删内容）。

## 3. 能力注入（`src/pth/impls/kernels/capability.ts`）

- `roleId === "controller:adversarial"`：注入
  `knowledge: { review: async ({ entryId, verdict, note }) => recordKnowledgeVerdict(store, entryId,
  { kind: "adversarial", verdict, reviewerRole: "controller:adversarial", note, at: Date.now() }) }`；
- `roleId === "memory-keeper"`：注入
  `knowledge: { promote: async (entryId) => promoteKnowledgeEntry(store, entryId,
  { promoterRole: "memory-keeper" }) }`；
- 其它角色不注入 knowledge 写能力（读走 K3 broker）。

## 4. 监督通道（gateway）

- `PthGatewayFacade` 增：
  - `verifyKnowledge(entryId, verdict): Promise<unknown>`（调 recordKnowledgeVerdict）；
  - `promoteKnowledge(entryId): Promise<unknown>`（调 promoteKnowledgeEntry）；
- `routes-kernel.ts` 增：
  - `POST /api/v1/kernel/knowledge/verify`：body `{ entryId, kind: "domain"|"adversarial",
    verdict: "pass"|"reject", note }`；非法 400；结果 `!ok` → 400；
  - `POST /api/v1/kernel/knowledge/promote`：body `{ entryId }`；结果 `!ok` → 400；
- 认证沿用既有 kernel 路由模式（无新增角色权限判断——监督通道）。

## 5. 测试

- `test/pth-execution/knowledge-promotion.test.ts`（fake store）：
  - verdict 幂等/只 draft/自审拒绝/非法 verdict；
  - 缺任一 pass / 有 reject / 同一 reviewer / producer 自核验 → promote 拒绝；
  - 全链：两个不同 reviewer pass → promote → status official + promotion meta +
    revision 历史存在（fake store 可只断言 write 调用参数）；
  - reject → archived；
- capability 测试：adversarial 有 knowledge.review、memory-keeper 有 knowledge.promote、
  developer 无；
- gateway 路由测试（沿用 kernel-routes.test 风格）verify/promote 形状校验；
- 全量 vitest + `npm run lint` 绿。

## 6. 约束与已知边界

- 不改 concepts/parallel-lanes/TODO/README/schema；
- 本批**不引入持久化队列/outbox**：candidate 由 K1b refiner 在 post-commit 后 fire-and-forget
  产出；进程崩溃丢 candidate 是已知边界，K5 试点如复现再补 durable queue（文档化在返回偏差）；
- 一条 commit 到 `lane/k4-knowledge-promotion`，不 merge/push；
- 返回改动文件、测试结果、偏差。
