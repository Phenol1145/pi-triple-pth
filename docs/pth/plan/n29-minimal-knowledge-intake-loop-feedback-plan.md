# N29：最小可信知识摄入内环复验反馈与实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
>（推荐）或 `superpowers:executing-plans` 按任务执行；每个任务必须独立复核后再合并。
>
> 日期：2026-08-19
> 取证基线：`main@3b1956623976594f193035f594f6cb3bb8017e23`
> 基线工作树：clean
> 当前结论：**NOT ACCEPTED / NO-GO**
> 上位设计：[N26 自主知识摄入设计](../design/n26-autonomous-knowledge-intake-design.md)

**Goal:** 在本轮尽可能完成一条可信的单信源持续摄入内环：一个人类签名策略已批准的
HTTPS 来源，能够自动完成初次摄入、核验、晋升、不变重爬和变化重爬；任何来源或任务状态异常
均 fail closed。

**Architecture:** 不新增顶层 Intake Module。Knowledge Intake 继续属于 PTH Knowledge 的写侧
application service；PostgreSQL 保存 Subscription、Run、Artifact、Revision、Dependency 与
outbox 真相，Task/Role/Tool 只执行阶段处理。首轮明确不实现来源发现外环。

**Tech Stack:** TypeScript、PostgreSQL、现有 `PgMemoryStore`、Task lease、transactional outbox、
Knowledge Verification/Promotion、Vitest、Testcontainers PostgreSQL。

**Spec:** [docs/pth/design/n26-autonomous-knowledge-intake-design.md](../design/n26-autonomous-knowledge-intake-design.md)

## Global Constraints

- 不新增 `PthModuleName`、常驻 worker role、常驻进程类型/部署单元、数据库、对象存储或向量库。
- 人类签名 Trust Policy 是来源抓取与使用授权的唯一事实源；LLM、worker 与 service 均只读。
- 首轮正向路径仅允许 HTTPS、一个 tenant、一个 space、一个 domain、一个 source subscription；
  另设第二 tenant 只做隔离负测。
- 首轮只实现一个 bounded HTTPS/HTML connector；每个 admitted revision 最多抽取一条原子 claim，artifact
  直接受限存入 PostgreSQL。
- 外部内容只能产生 quarantined Source Revision 或 private draft Knowledge Candidate；不得 direct official。
- 每个 official 条目必须绑定非空、不可变的 Source Revision 与 Evidence Reference。
- 所有 task/run 状态迁移必须使用未过期 lease、generation、expected rowVersion 和 tenant scope。
- 状态迁移与下一阶段 outbox 必须同一 PostgreSQL transaction；CAS 失败不得写 outbox。
- outbox 幂等身份必须是 `(tenant_id, key)`，所有 claim/complete/fail 均携带 tenant 与 token。
- 同 tenant/key 只有 kind、payload 与 payload hash 完全一致才算幂等；不同 payload 必须显式 conflict。
- Trust Policy 的批准主体必须是 PTL 验证并签发的 human principal；不得从 role 名或 principalId 前缀推断人类。
- 只允许在 plan 满足 domain + adversarial 两个独立 check 后晋升 exact candidate hash。
- Trigger 只唤醒 due scanner；`Subscription.nextCrawlAt` 是唯一调度真相。
- 测试可以替换外部 HTTP 与 LLM，但不得替换 repository、事务、Task lease、outbox、
  KnowledgeIngestor、VerificationPlan、Promotion 或 Broker/Context。
- 测试 LLM 只能替换 `LlmFn` 后端；必须经过生产 extractor processor、结果 schema 与服务端 evidence
  重算，不得直接返回 candidate 或写库。
- 实现前后均须保留 N28 feature flag 默认关闭；N29 不依赖自动分片或自动扩缩容。
- 新增 `PTH_KNOWLEDGE_INTAKE_MODE=off|draft|full`；在唯一 acceptance envelope 为
  `MIN_INNER_LOOP_GO` 前不得启用 `full`。

---

## 1. 本轮复验反馈

### 1.1 总结

当前通用执行底座已经可复用，但 N26 自己的业务闭环尚不存在：

| 层次 | 复验结论 | 当前成熟度 |
|---|---|---:|
| N28 worker/记忆/工具有界面 | PASS（可行性） | 约 70–75% 可复用 |
| 单信源持续摄入内环 | NO-GO | 约 20% |
| 来源发现与扩展外环 | NO-GO | 约 5–10% |
| 完整双环 | NO-GO | 约 15–20% |

当前生产代码中没有 `TrustPolicy`、`SourceSubscription`、`IntakeRun`、`SourceRevision`、
`KnowledgeIngestor`、`nextCrawlAt` scanner 或来源依赖图；数据库也没有 source/intake/artifact 表。
N28 最近的修复提高了 worker 责任区、检索和预算的可行性证据，但没有实现摄入状态。

### 1.2 新鲜门禁证据

以下均在基线 HEAD 重新执行：

| 门禁 | 结果 |
|---|---|
| `npm test` | 287 files passed、1 skipped；2374 passed、9 skipped；exit 0 |
| `npm run lint` | exit 0；boundaries 0；config 直读 0 |
| `npx tsc -p tsconfig.n28.json --noEmit` | exit 0 |
| N28 evaluator 两次 | exit 0 / exit 0；byte-identical；GO / GO |
| R6 + outbox + promotion 真实 PG | 3 files、26/26 passed |
| 内环相关聚焦套件 | 6 files、93/93 passed |

这些结果证明现有机制可以复用，不证明摄入内环已存在。当前测试没有覆盖下列两个真实 PG 反例。

### 1.3 P0-1：错误 Task CAS 仍写下一阶段 outbox

`PgTaskRepository.commit()` 在 task `UPDATE` 返回 `rowCount=0` 后仍执行 `insertSideEffects()`。
真实 PostgreSQL 探针使用错误 generation，结果为：

```json
{
  "commitResult": { "committed": false },
  "task": { "status": "claimed", "lease_generation": "2" },
  "outbox": [{ "key": "probe:wrong-generation", "status": "pending" }]
}
```

这允许旧 worker、重复 outcome 或错误 generation 在任务未提交时推进摄入阶段。

### 1.4 P0-2：过期 Task lease 仍能提交

completed/retry/rejected 三条 CAS SQL 都没有 `lease_expires_at > now()`。真实 PostgreSQL 探针：

```json
{
  "commitResult": { "committed": true },
  "task": { "status": "completed", "expired": true }
}
```

摄入运行依赖任务结果驱动状态迁移，因此这是最小内环的前置阻断。

### 1.5 P0-3：outbox 不是 tenant-qualified exact idempotency

当前 side-effect outbox 以全局 `UNIQUE(key)` 去重，enqueue 对冲突直接 `DO NOTHING`，complete/fail 也只按
key 更新。这会让两个 tenant 使用同一业务 key 时静默丢掉后者，也会把同 tenant/key 的不同 payload 错当
成幂等重放。摄入阶段必须使用 `(tenant_id,key)` 身份，并对 payload hash 不同返回 conflict。

### 1.6 P0-4：外部内容仍可 direct official

当前 `recon-doc` 仍执行：

```text
任意公网 URL → web.fetchText → LLM → public official memory
```

worker 的 knowledge layer `memory.write` 也允许显式 `status=official`。该路径绕过人类 Trust Policy、
Source Revision、Evidence Reference、VerificationPlan 与 Promotion。

旁路不止 `recon-doc`：`memory-maintain` 也会把 LLM 整理结果直接写 official。当前测试仍把 worker
knowledge write 保留 official 视为正确行为，因此只修改模板不构成关闭；必须在 capability/store 边界
fail closed，使普通 worker、service 与模板都不能取得 official 写权限。bootstrap seed/migration 如需 official，
必须使用与 worker capability 分离的内部 authority。

### 1.7 P0-5：Promotion 接受空来源绑定

旧计划兼容逻辑允许 `sourceBindingsDigest=""`。满足普通 provenance、双 verdict 和 plan status 的
candidate 即使 `evidence=[]` 也可通过 `canPromote()`。N29 对外部知识不得保留该兼容路径。

### 1.8 P0-6：当前身份合同不能证明 human principal

现有 PTH auth 只有 role 与字符串 principalId，service token 也可表现为 platform-admin。PTH 不能据此推断
调用者是人。M0 必须只接受 PTL Human Interface 签发、可验签且绑定 tenant/space/policy digest 的人类
decision envelope；worker、LLM、service 和 platform-admin service 都不能签发 Trust Policy。

### 1.9 边界缺口：外环尚未形成合同

Coverage Planner 只有设计文字；没有 CoverageSnapshot/Gap、DiscoveryRun、SourceCandidate、组合预算、
收敛条件或 inner→outer feedback 状态。因此本轮不得把来源自动发现塞入最小内环。

---

## 2. 最小闭环裁决

### 2.1 本轮必须完成

本轮 M0 只接受以下一条闭环：

```text
PTL-verified human-signed Trust Policy
  → explicit Subscription request matches policy
  → probing Source Subscription + nextCrawlAt
  → durable Intake Run lease
  → policy-bound HTTPS fetch
  → immutable raw Artifact + quarantined raw Source Revision
  → deterministic use-policy admission
  → distinct immutable admitted Source Revision
  → active Source Subscription
  → extractor processor
  → KnowledgeIngestor writes private draft + exact Evidence Reference
  → persistent VerificationPlan
  → domain verdict + adversarial verdict（不同 principal/execution）
  → exact-hash atomic promotion
  → official knowledge visible through production Broker/Context
  → conditional recrawl
       ├─ unchanged: record acquisition, reuse artifact, no new candidate
       └─ changed: dependent official → stale, new candidate → reverify → supersede
```

### 2.2 明确延后

- CoverageSnapshot、CoverageGap、DiscoveryCampaign/Run；
- LLM 自动寻找网页与 SourceCandidate portfolio；
- 动态审批 UI/API；
- 多来源冲突、跨版本比较和十域扩展；
- 自动分片、重平衡、扩缩容与 persistent Memory Directory；
- 外部对象存储、向量索引、浏览器渲染与认证网页 connector。

延后项不得以空接口、伪状态或 fixture 预埋进 M0。

### 2.3 完成与失败定义

M0 必须同时证明：

1. 初次摄入产生一条 official 知识；
2. official 可回放到 exact Source Revision、artifact hash、representation、locator 与 quote hash；
3. 第二次内容不变重爬不产生新 candidate/promotion；
4. 第三次内容变化重爬先撤出旧 authoritative entry，再产生 superseding official；
5. 进程/handler 在任一阶段中断后可由 PG 状态和 outbox 恢复；
6. 错误 generation、过期 lease、跨 tenant、策略过期、越权 redirect、空 evidence 均为零 side effect；
7. full regression、lint、真实 PG 组合套件全部通过。
8. 受控 TLS 来源通过生产组合测试，并对一个人类策略已批准的真实 HTTPS 来源完成 release canary。

任一项缺失，状态保持 **NO-GO**；“一次抓取成功”“写出 draft”或“测试内直接调用 promotion”均不算完成。
全部成立时也只允许记为 **MIN_INNER_LOOP_GO**；来源扩展外环和 N26 广度门尚未通过。

### 2.4 不可缩减的验收矩阵

| Gate | 必须证明 |
|---|---|
| G0 旁路 | recon、memory-maintain、processor、普通 `memory.write` 均不能写 knowledge official；只有 Promotion Service 可以 |
| G1 信任 | PTL human proof 可安装策略；service/worker/伪造主体、错 tenant/space、deny rule 均拒绝 |
| G2 调度 | 两个 scanner 对同一 due window 只建一个 Run；未过期 lease + generation + rowVersion 才能迁移 |
| G3 获取 | 逐跳 HTTPS policy、DNS/IP、字节/时间预算生效；raw bytes/hash/headers/redirect 可回放；use 前保持 quarantine |
| G4 抽取 | 生产 processor 经过 lease/inputHash/result schema；locator 与 quoteHash 由服务端重算 |
| G5 晋升 | producer/domain/adversarial/promoter 职责分离；旧 hash/digest、空 evidence、撤销 policy/revision 均失败 |
| G6 消费 | production Broker/Context 命中同一 official 及 evidence；跨 tenant/space、stale 命中为 0 |
| G7 重爬 | initial、unchanged、changed 三路径成立；V1 stale 后默认不可见但 history/asOf 可读，V2 official 明确 supersedes V1 |
| G8 故障 | CAS/outbox 原子、双进程 claim、SIGKILL/restart、handler 重放均无丢失或重复晋升 |
| G9 真实性 | 受控 TLS source 跑完整生产组合；release canary 再跑一个人类批准的真实 HTTPS 来源 |
| G10 敏感度 | 移除 trust/evidence/digest/lease/stale 任一门禁，至少一个对应 sentinel 必须翻红 |

只有 mock、offline fixture、单进程双 pool 或 direct-store smoke 时，结论必须是
`EVALUATION-INCOMPLETE`，不能据此给 `MIN_INNER_LOOP_GO`。

---

## 3. M0 领域模型

### 3.1 双环边界

- **Source Ingestion Loop（单源摄入内环）**：从已匹配人类 Trust Policy 的 Subscription 开始，
  负责持续 acquisition、revision、candidate、verification、promotion 与 recrawl。
- **Source Expansion Loop（信源扩展外环）**：根据覆盖缺口推荐新的 Source Candidate，并请求人类扩大
  Trust Policy；本轮不实现。
- 外环只能创建 proposal；只有人类策略匹配结果能够创建/激活 Subscription。
- 内环只能输出覆盖、利用率、变化率、失败和 stale 等事实，不能自行扩大策略范围。

### 3.2 最小持久实体

```typescript
interface HumanPrincipalRef {
  kind: "human";
  principalId: string;
  tenantId: string;
  issuer: "ptl-human-interface";
}

interface TrustPolicyRule {
  ruleId: string;
  effect: "allow" | "deny";
  httpsOrigin: string;
  pathPrefix: string;
  spaces: readonly string[];
  domains: readonly string[];
  sourceTypes: readonly string[];
  contentTypes: readonly string[];
  licenses: readonly string[];
  maxBytes: number;
  redirectOrigins: readonly string[];
}

interface PolicyDecisionRef {
  policyId: string;
  policyVersion: string;
  policyDigest: string;
  ruleId: string;
  decision: "allow" | "deny";
  decidedAt: string;
}

interface TrustPolicyManifest {
  policyId: string;
  version: string;
  tenantId: string;
  spaces: readonly string[];
  validFrom: string;
  validUntil: string;
  approvedBy: HumanPrincipalRef;
  approvalProof: { method: "signed-manifest"; keyId: string; signature: string };
  rules: readonly TrustPolicyRule[];
  digest: string;
}

interface SourceSubscription {
  id: string;
  tenantId: string;
  space: string;
  canonicalUri: string;
  domainId: string;
  status: "probing" | "active" | "paused" | "revoked" | "retired";
  policyId: string;
  policyVersion: string;
  policyDigest: string;
  policyRuleId: string;
  recrawlIntervalMs: number;
  nextCrawlAt: string;
  lastSuccessfulRevisionId?: string;
  rowVersion: number;
}

interface IntakeRun {
  id: string;
  tenantId: string;
  subscriptionId: string;
  reason: "initial" | "scheduled" | "manual-retry";
  stage: "fetch" | "admit" | "extract" | "verify" | "promote" | "complete";
  status: "queued" | "leased" | "waiting" | "completed" | "failed" | "dead-letter";
  attempt: number;
  leaseToken?: string;
  leaseGeneration: number;
  lockedUntil?: string;
  sourceRevisionId?: string;
  candidateId?: string;
  verificationPlanId?: string;
  rowVersion: number;
}

interface IntakeAttempt {
  runId: string;
  tenantId: string;
  stage: IntakeRun["stage"];
  attempt: number;
  leaseGeneration: number;
  leaseTokenHash: string;
  inputHash: string;
  outputHash?: string;
  disposition: "leased" | "succeeded" | "retryable-failed" | "terminal-failed" | "expired";
  principalId: string;
  executionId: string;
  createdAt: string;
}

interface SourceArtifact {
  id: string;
  tenantId: string;
  rawHash: string;
  byteLength: number;
  rawBytes: Uint8Array;
  createdAt: string;
}

interface SourceRevision {
  id: string;
  tenantId: string;
  subscriptionId: string;
  previousRevisionId?: string;
  derivedFromRevisionId?: string;
  requestedUri: string;
  finalUri: string;
  redirectChain: readonly string[];
  acquiredAt: string;
  responseStatus: number;
  contentType: string;
  etag?: string;
  lastModified?: string;
  artifactId: string;
  rawHash: string;
  normalizedTextHash: string;
  normalizedText: string;
  disposition: "raw-quarantine" | "admitted" | "unchanged" | "rejected";
  fetchPolicyDecision: PolicyDecisionRef;
  usePolicyDecision?: PolicyDecisionRef;
}

interface IntakeEvidenceReference {
  sourceSubscriptionId: string;
  sourceRevisionId: string;
  representation: "normalized-text";
  locator: { start: number; end: number };
  quoteHash: string;
  artifactHash: string;
  policyDecisionDigest: string;
}
```

`SourceRevision` 是 append-only。raw quarantine、admitted 与 unchanged 必须是彼此关联的独立行，
不得把同一 revision 从 quarantined 原地 UPDATE 为 admitted。`IntakeAttempt` 同样 append-only；重试创建
新 attempt，旧 attempt 永不覆盖。

### 3.3 最小端口

```typescript
interface TrustPolicyLoader {
  loadVerified(): Promise<VerifiedTrustPolicy>;
  authorizeFetch(input: FetchAuthorizationInput): FetchPolicyDecision;
  authorizeUse(input: UseAuthorizationInput): UsePolicyDecision;
}

interface KnowledgeIntakeRepository {
  installVerifiedPolicy(input: VerifiedTrustPolicy): Promise<void>;
  createSubscription(input: CreateSubscriptionInput): Promise<SourceSubscription>;
  createDueRuns(now: Date, limit: number): Promise<readonly IntakeRun[]>;
  claimRun(input: ClaimIntakeRunInput): Promise<IntakeRun | null>;
  transitionRun(input: TransitionIntakeRunInput): Promise<IntakeRun | null>;
  storeAcquisition(input: StoreAcquisitionInput): Promise<SourceRevision>;
  recordDependency(input: SourceDependencyInput): Promise<void>;
  markDependentsStale(input: MarkDependentsStaleInput): Promise<readonly string[]>;
}

interface SourceFetchBroker {
  acquire(input: AcquireSourceInput): Promise<SourceAcquisitionEnvelope>;
}

interface KnowledgeIngestor {
  ingest(input: IngestSourceRevisionInput): Promise<{
    candidateId: string;
    candidateRevision: number;
    planId: string;
  }>;
}
```

---

## 4. 文件结构

### 新增

- `src/pth/contracts/knowledge-intake.ts` — M0 类型与端口；不包含 PG、HTTP 或 LLM 类型。
- `src/pth/execution/knowledge-intake/trust-policy.ts` — canonical digest、Ed25519 proof、fetch/use matcher。
- `src/pth/execution/knowledge-intake/fetch-broker.ts` — policy-bound acquisition envelope。
- `src/pth/execution/knowledge-intake/knowledge-ingestor.ts` — strict evidence、draft 与 plan handoff。
- `src/pth/execution/knowledge-intake/service.ts` — 内环状态迁移，不直接执行网络/LLM。
- `src/pth/execution/knowledge-intake/due-scanner.ts` — PG due subscription scanner。
- `src/pth/execution/knowledge-intake/index.ts` — Knowledge Intake 内部公开面。
- `src/pth/kernel/storage/knowledge-intake-pg.ts` — PG repository 与事务。
- `src/pth/runner/intake-processors.ts` — extract/domain/adversarial processor adapters。
- `scripts/pth-intake-subscribe.ts` — 只安装已验签 policy 并经正式 service 创建 probing Subscription 的 ops 入口。
- `test/pth-knowledge-intake/trust-policy.test.ts`
- `test/pth-knowledge-intake/knowledge-intake-pg.test.ts`
- `test/pth-knowledge-intake/fetch-broker.test.ts`
- `test/pth-knowledge-intake/knowledge-ingestor.test.ts`
- `test/pth-knowledge-intake/minimal-loop.integration.test.ts`
- `config/pth-trust-policy.example.json` — 无私钥、无生产来源的签名 manifest 示例。

### 修改

- `src/pth/contracts/index.ts` — 导出 intake contracts。
- `src/pth/execution/index.ts` — 导出 Knowledge Intake application service ports。
- `src/pth/kernel/storage/index.ts` — 导出 PG intake repository。
- `src/pth/runner/index.ts` — 导出 processor adapters。
- `src/pth/contracts/tasking.ts` — task commit 显式携带 tenant scope，并冻结未过期 lease 语义。
- `src/pth/kernel/storage/schema.ts` — source/subscription/run/artifact/revision/dependency 表。
- `src/pth/tasking/adapters/pg-task-repository.ts` — lease expiry 与 CAS/outbox 原子性。
- `src/pth/tasking/side-effect-outbox.ts` — tenant-qualified key/CAS。
- `src/pth/bootstrap/batch-process.ts` — 注册 intake stage handlers 与 due scanner wake-up。
- `src/pth/impls/kernels/capability.ts` — 抽取可复用的安全 transport，不改变公共 `web.fetchText` 返回类型。
- `src/pth/execution/knowledge-promotion.ts` — production plan creation 与 current policy/source binding recheck。
- `src/pth/execution/knowledge-verdicts.ts` — N29 candidate 禁止空 binding。
- `packages/pth-memory/src/knowledge-provenance.ts` — IntakeEvidenceReference 解析与校验。
- `packages/pth-memory/src/memory-policy.ts` — worker knowledge write 强制 draft。
- `packages/pth-memory/src/memory-store-pg.ts`、`schema.ts` — official 写 authority、`stale` 状态与依赖撤出。
- `src/pth/kernel/templates.ts` — recon-doc 不再 direct official。
- `src/pth/kernel/extensions/memory.ts`、相关 prompt docs — worker knowledge write 面说明与强制行为一致。
- `src/pth/config/schema.ts` — Trust Policy 与 signer keyring 的只读路径配置。

---

## 5. 实施任务

### Task 1：关闭 Task/outbox 与 direct-official 安全阻断

**Files:**
- Modify: `src/pth/tasking/adapters/pg-task-repository.ts`
- Modify: `src/pth/contracts/tasking.ts`
- Modify: `src/pth/tasking/side-effect-outbox.ts`
- Modify: `src/pth/kernel/storage/schema.ts`
- Modify: `packages/pth-memory/src/memory-policy.ts`
- Modify: `packages/pth-memory/src/memory-store-pg.ts`
- Modify: `src/pth/kernel/templates.ts`
- Test: `test/pth-tasking/pg-task-repository.test.ts`
- Test: `test/pth-tasking/side-effect-outbox.test.ts`
- Test: `packages/pth-memory/test/memory-policy.test.ts`
- Test: `test/pth-kernel-assembly/templates.test.ts`

**Interfaces:**
- Produces: task commit 只在同 tenant、未过期 lease CAS 成功后写 side effects；outbox identity 为
  tenant + key + exact payload；worker knowledge writes 一律 draft。

- [ ] **Step 1: 固化两个真实 PG 反例**

```typescript
it("wrong generation does not enqueue side effects", async () => {
  const result = await repo.commit(wrongGenerationOutcome, { sideEffects: [effect] });
  expect(result).toEqual({ committed: false });
  expect(await countOutbox(TENANT, effect.key)).toBe(0);
});

it("expired lease cannot commit or enqueue", async () => {
  await expireLease(taskId);
  const result = await repo.commit(validLookingOutcome, { sideEffects: [effect] });
  expect(result).toEqual({ committed: false });
  expect(await countOutbox(TENANT, effect.key)).toBe(0);
});

it("same tenant/key with a different payload conflicts", async () => {
  await outbox.enqueue(TENANT_A, effectA);
  await expect(outbox.enqueue(TENANT_A, changedPayloadSameKey)).rejects.toThrow("conflict");
});

it("different tenants may reuse the same outbox key", async () => {
  await outbox.enqueue(TENANT_A, effectA);
  await outbox.enqueue(TENANT_B, effectA);
  expect(await countOutboxByKey(effectA.key)).toBe(2);
});
```

- [ ] **Step 2: 运行红测**

Run: `npx vitest run test/pth-tasking/pg-task-repository.test.ts test/pth-tasking/side-effect-outbox.test.ts`
Expected: 新增测试 FAIL；可观察到 outbox=1、expired commit=true，或全局 key/静默 conflict 语义。

- [ ] **Step 3: 修复 task CAS 与 side-effect 条件**

`TaskRepository.commit()` 增加服务器盖章的 tenant scope；所有 completed/retry/rejected SQL 必须包含：

```sql
AND status = 'claimed'
AND tenant_id = $tenant_id
AND lease_expires_at IS NOT NULL
AND lease_expires_at > now()
```

事务中只在 `upd.rowCount === 1` 时调用 `insertSideEffects()`；否则直接返回 `upd`。

- [ ] **Step 4: 把 outbox 改为 tenant-qualified identity**

```sql
ALTER TABLE side_effect_outbox DROP CONSTRAINT IF EXISTS side_effect_outbox_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_side_effect_outbox_tenant_key
  ON side_effect_outbox(tenant_id, key);
```

增加稳定 `payload_hash`。同 tenant/key 同 kind/hash/payload 重放返回 idempotent；同 tenant/key 不同
kind/hash/payload 返回 conflict，不得 `DO NOTHING`。`claim()`、`complete()` 与 `markFailed()` 输入必须
携带 `tenantId`，SQL 同时匹配 tenant、key、processing token。

提供显式 transaction-bound enqueue（接收调用方 `PoolClient`）；Task commit、Run transition 与下一阶段
outbox 必须复用同一 client/transaction，禁止在事务中调用另一个 pool-backed `enqueue()`。

- [ ] **Step 5: worker knowledge write 强制 draft，recon 显式 private draft**

```typescript
if (layer === "knowledge") return { ok: true, forceStatus: "draft" };
```

`recon-doc` 与 `memory-maintain` 固定 `status:"draft"`，写入 private `spaceScope`，不得接受调用方提供
arbitrary official kind。普通 `memory.write`/store write 即使由 service 或 platform-admin service 调用也不得
写 knowledge official；只有 Promotion Service 的窄 PG 方法可以晋升，seed/migration 使用独立 authority。

- [ ] **Step 6: 运行绿测与回归**

Run: `npx vitest run test/pth-tasking/pg-task-repository.test.ts test/pth-tasking/side-effect-outbox.test.ts packages/pth-memory/test/memory-policy.test.ts packages/pth-memory/test/memory-store-pg.test.ts test/pth-kernel-assembly/templates.test.ts`
Expected: 相关文件全部 PASS、无 skip。

- [ ] **Step 7: Commit**

```bash
git add src/pth/contracts/tasking.ts src/pth/tasking src/pth/kernel/storage/schema.ts packages/pth-memory/src/memory-policy.ts packages/pth-memory/src/memory-store-pg.ts src/pth/kernel/templates.ts test/pth-tasking packages/pth-memory/test/memory-policy.test.ts packages/pth-memory/test/memory-store-pg.test.ts test/pth-kernel-assembly/templates.test.ts
git commit -m "fix(intake): close lease outbox and direct official bypasses"
```

### Task 2：冻结 M0 contracts 与人类签名 Trust Policy

**Files:**
- Create: `src/pth/contracts/knowledge-intake.ts`
- Create: `src/pth/execution/knowledge-intake/trust-policy.ts`
- Create: `src/pth/execution/knowledge-intake/index.ts`
- Create: `test/pth-knowledge-intake/trust-policy.test.ts`
- Create: `config/pth-trust-policy.example.json`
- Modify: `src/pth/contracts/index.ts`
- Modify: `src/pth/execution/index.ts`
- Modify: `src/pth/config/schema.ts`

**Interfaces:**
- Produces: 本文 §3 的 types；`loadVerifiedTrustPolicy()`、`authorizeFetch()`、`authorizeUse()`。
- Consumes: Node `crypto.verify`；不消费 gateway body principal。

- [ ] **Step 1: 写 Trust Policy schema/digest/signature 红测**

```typescript
expect(await loadVerifiedTrustPolicy(validManifest, keyring, clock)).toMatchObject({
  manifest: { approvedBy: { kind: "human", tenantId: "tenant-a" } },
});
await expect(loadVerifiedTrustPolicy(serviceSigned, keyring, clock)).rejects.toThrow("human signer");
await expect(loadVerifiedTrustPolicy(tampered, keyring, clock)).rejects.toThrow("digest");
await expect(loadVerifiedTrustPolicy(expired, keyring, clock)).rejects.toThrow("expired");
```

- [ ] **Step 2: 运行红测**

Run: `npx vitest run test/pth-knowledge-intake/trust-policy.test.ts`
Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现 canonical digest 与 Ed25519 detached signature**

首版只支持 `approvalProof.method="signed-manifest"`。签名 envelope 由 PTL Human Interface 产生，PTH
验证 `principalKind=human`、issuer、tenant、space、policy digest 与有效期；不得从 role 或 principalId 字符串
推断主体类型。keyring 是只读 JSON，键为稳定 human principal，
值为 PEM public key；私钥永不进入仓库、容器镜像或运行环境。

- [ ] **Step 4: 实现双阶段 matcher**

`authorizeFetch()` 只匹配 tenant/space/exact HTTPS origin/path/redirect/bytes；`authorizeUse()` 再匹配
domain/sourceType/license/contentType。deny 优先，未命中 fail closed。

- [ ] **Step 5: 运行绿测与类型检查**

Run: `npx vitest run test/pth-knowledge-intake/trust-policy.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/pth/contracts src/pth/execution/index.ts src/pth/execution/knowledge-intake src/pth/config/schema.ts test/pth-knowledge-intake/trust-policy.test.ts config/pth-trust-policy.example.json
git commit -m "feat(intake): add signed human trust policy contract"
```

### Task 3：实现 Subscription、Run、Artifact、Revision 的 PG 真相源

**Files:**
- Create: `src/pth/kernel/storage/knowledge-intake-pg.ts`
- Create: `test/pth-knowledge-intake/knowledge-intake-pg.test.ts`
- Modify: `src/pth/kernel/storage/schema.ts`
- Modify: `src/pth/kernel/storage/index.ts`

**Interfaces:**
- Consumes: `VerifiedTrustPolicy` 与本文 `KnowledgeIntakeRepository`。
- Produces: tenant-scoped CAS repository、due scanner 所需查询。

- [ ] **Step 1: 写 schema/repository 红测**

覆盖 subscription 去重、due run 原子创建、双 scanner 无重复、lease expiry recovery、wrong token/generation/
rowVersion 无写、artifact hash 去重、raw/admitted revision 为独立 append-only 行、跨 tenant 零可见。

- [ ] **Step 2: 运行红测**

Run: `npx vitest run test/pth-knowledge-intake/knowledge-intake-pg.test.ts`
Expected: FAIL，表与 repository 尚不存在。

- [ ] **Step 3: 建立七张最小表**

```sql
knowledge_trust_policies
knowledge_source_subscriptions
knowledge_intake_runs
knowledge_intake_attempts
knowledge_source_artifacts
knowledge_source_revisions
knowledge_source_dependencies
```

所有主查询键都以 `tenant_id` 开头；所有可变聚合包含 `row_version`；verified policy manifest append-only；
artifact 与 revision 不允许 UPDATE 正文；`raw_hash` 在 tenant 内去重。

`knowledge_trust_policies` 只是已验签 manifest 的不可变审计镜像；签名 manifest 与 PTL human proof 仍是
授权事实，数据库行不能创建、扩大或替换 policy。

- [ ] **Step 4: 实现 due/CAS transaction**

`createDueRuns()` 使用 `FOR UPDATE SKIP LOCKED` 选择 active + due subscriptions，在同一事务中创建 run、
推进 `next_crawl_at` 并 enqueue `intake.fetch`。

- [ ] **Step 5: 运行真实 PG 绿测**

Run: `npx vitest run test/pth-knowledge-intake/knowledge-intake-pg.test.ts`
Expected: 全部 PASS、无 Docker skip。

- [ ] **Step 6: Commit**

```bash
git add src/pth/kernel/storage/schema.ts src/pth/kernel/storage/index.ts src/pth/kernel/storage/knowledge-intake-pg.ts test/pth-knowledge-intake/knowledge-intake-pg.test.ts
git commit -m "feat(intake): persist subscriptions runs and source revisions"
```

### Task 4：实现 policy-bound artifact fetch 与 admission

**Files:**
- Create: `src/pth/execution/knowledge-intake/fetch-broker.ts`
- Create: `test/pth-knowledge-intake/fetch-broker.test.ts`
- Modify: `src/pth/impls/kernels/capability.ts`
- Modify: `src/pth/execution/knowledge-intake/index.ts`

**Interfaces:**
- Consumes: verified fetch decision、conditional headers、现有 DNS/IP/redirect 安全 transport。
- Produces: `SourceAcquisitionEnvelope`，含 raw bytes、final URI、redirect chain、headers、hash。

- [ ] **Step 1: 写 fetch 红测**

测试 exact origin/path、每跳 redirect 重新授权、private IP、HTTP、超字节、timeout、ETag 304、
Last-Modified、raw hash、HTML normalized representation、未知 content type quarantine。

- [ ] **Step 2: 运行红测**

Run: `npx vitest run test/pth-knowledge-intake/fetch-broker.test.ts`
Expected: FAIL，broker 尚不存在。

- [ ] **Step 3: 从 `web.fetchText` 抽取安全 transport**

保留公共 `web.fetchText(): Promise<string>` 兼容；新增内部 transport 返回：

```typescript
interface SourceAcquisitionEnvelope {
  requestedUri: string;
  finalUri: string;
  redirectChain: readonly string[];
  status: number;
  headers: { contentType: string; etag?: string; lastModified?: string };
  rawBytes: Uint8Array;
  rawHash: string;
  normalizedText: string;
  normalizedTextHash: string;
}
```

- [ ] **Step 4: 实现 fetch/use 两阶段提交**

fetch 结果先插入 quarantined raw revision；deterministic inspector 与 `authorizeUse()` 成功后再插入一条
引用同 artifact 的 admitted revision。不得 UPDATE 原 raw revision。未知许可、越权 redirect 或 content type
不得进入 extractor；fetch 后、use 前撤销策略也必须拒绝。

- [ ] **Step 5: 运行绿测**

Run: `npx vitest run test/pth-kernel-interpreter/web-capability.test.ts test/pth-knowledge-intake/fetch-broker.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/pth/impls/kernels/capability.ts src/pth/execution/knowledge-intake/fetch-broker.ts src/pth/execution/knowledge-intake/index.ts test/pth-knowledge-intake/fetch-broker.test.ts
git commit -m "feat(intake): acquire immutable policy-bound artifacts"
```

### Task 5：实现 strict KnowledgeIngestor、plan creation 与双核验 handoff

**Files:**
- Create: `src/pth/execution/knowledge-intake/knowledge-ingestor.ts`
- Create: `src/pth/runner/intake-processors.ts`
- Create: `test/pth-knowledge-intake/knowledge-ingestor.test.ts`
- Create: `test/pth-runner/intake-processors.test.ts`
- Modify: `packages/pth-memory/src/knowledge-provenance.ts`
- Modify: `src/pth/execution/knowledge-promotion.ts`
- Modify: `src/pth/execution/knowledge-verdicts.ts`
- Modify: `src/pth/execution/knowledge-intake/index.ts`
- Modify: `src/pth/runner/index.ts`

**Interfaces:**
- Consumes: admitted `SourceRevision`、validated extractor result、current verified Trust Policy。
- Produces: private draft candidate、source dependency、persistent VerificationPlan、stage tasks。

- [ ] **Step 1: 写 evidence/promotion 红测**

```typescript
await expect(ingestor.ingest({ revision: quarantined, claims })).rejects.toThrow("admitted");
await expect(ingestor.ingest({ revision: admitted, claims: [claimWithoutLocator] })).rejects.toThrow("evidence");
expect(canPromote(evidenceFreeCandidate, satisfiedPlan, verdicts)).toEqual({
  ok: false,
  reason: expect.stringContaining("source binding"),
});
```

- [ ] **Step 2: 运行红测**

Run: `npx vitest run test/pth-knowledge-intake/knowledge-ingestor.test.ts test/pth-execution/knowledge-promotion.test.ts`
Expected: 新增用例 FAIL。

- [ ] **Step 3: 扩展 Evidence Reference 并强校验 quote**

Ingestor 重新从 normalized representation 读取 `[start,end)`，校验 `quoteHash`，不信任 LLM 自报文本。
每个 claim 必须至少一条 evidence，且 revision/policy/tenant/space/domain 全部一致。

- [ ] **Step 4: 原子写 candidate + dependency + plan**

candidate 固定 `status="draft"`、private scope。plan 的 hash 覆盖 content、domain、Evidence Reference、
policy decision digest 与 source revision。新增 production `createVerificationPlan()`；不允许测试手写 SQL 作为
生产路径。

- [ ] **Step 5: 发布两个职责分离的 review processor**

同一 plan 生成 domain 与 adversarial 两个 check；producer、domain reviewer、adversarial reviewer、promoter
四个 principal 不能相同。processor outcome 必须绑定 runId/planId/checkId/candidate hash/execution。

- [ ] **Step 6: promotion 重新校验 current policy/source binding**

空 `sourceBindingsDigest`、空 evidence、未知或 withdrawn SourceRevision、过期/撤销 policy、非 admitted
revision、stale evidence 一律拒绝；plan 只能由服务端从已验证 Evidence Reference 创建。旧空 digest plan
必须 invalidated 或安全迁移，不保留兼容旁路；promotion
仍在 existing locked transaction 内写 official + index/dependency outbox。

- [ ] **Step 7: 运行绿测**

Run: `npx vitest run test/pth-knowledge-intake/knowledge-ingestor.test.ts test/pth-runner/intake-processors.test.ts test/pth-execution/knowledge-verdicts.test.ts test/pth-execution/knowledge-promotion.test.ts`
Expected: 全部 PASS。

- [ ] **Step 8: Commit**

```bash
git add packages/pth-memory/src/knowledge-provenance.ts src/pth/execution/knowledge-intake src/pth/execution/knowledge-promotion.ts src/pth/execution/knowledge-verdicts.ts src/pth/runner/intake-processors.ts src/pth/runner/index.ts test/pth-knowledge-intake/knowledge-ingestor.test.ts test/pth-runner/intake-processors.test.ts test/pth-execution
git commit -m "feat(intake): ingest exact evidence through separated verification"
```

### Task 6：接通服务、due scanner、recrawl 与 stale/supersedes

**Files:**
- Create: `src/pth/execution/knowledge-intake/service.ts`
- Create: `src/pth/execution/knowledge-intake/due-scanner.ts`
- Create: `scripts/pth-intake-subscribe.ts`
- Modify: `src/pth/execution/knowledge-intake/index.ts`
- Modify: `src/pth/bootstrap/batch-process.ts`
- Modify: `packages/pth-memory/src/schema.ts`
- Modify: `packages/pth-memory/src/memory-store-pg.ts`
- Test: `test/pth-knowledge-intake/minimal-loop.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 ports。
- Produces: automatic stage progression、unchanged/changed recrawl、stale/supersedes。

- [ ] **Step 1: 写内环状态机红测**

冻结三次 acquisition：V1 初次、V1 unchanged、V2 changed。断言初次产生 official，unchanged 不产生
candidate，changed 立即把旧 entry 标 stale，随后产生 superseding official。

- [ ] **Step 2: 运行红测**

Run: `npx vitest run test/pth-knowledge-intake/minimal-loop.integration.test.ts`
Expected: FAIL，service/handlers 尚未接线。

- [ ] **Step 3: 注册 intake stage handlers**

生产 drainer 至少注册 `intake.fetch`、`intake.extract`、`intake.review-domain`、
`intake.review-adversarial`、`intake.promote`；每个 handler 只处理一个 stage 并用 run CAS 提交下一步。

- [ ] **Step 4: 实现 due scanner**

scanner 只调用 repository `createDueRuns()`；Trigger 仅 kick scanner。进程重启后由 PG `nextCrawlAt`、
expired run lease 与 pending/expired outbox 恢复。

`scripts/pth-intake-subscribe.ts` 只能加载并验证 signed manifest，然后调用同一 application service 创建
probing Subscription；不得签发/修改 policy、直接 INSERT 表或直接发布 Task。

- [ ] **Step 5: 实现 change/stale/supersedes**

raw hash 不变：记录 unchanged revision 并完成 run；只有通过 fetch/use admission 的 material change 才能在
事务内把依赖 official 标记为 `stale`、写 dependency refresh outbox，再走 extract/verify/promotion。抓取失败、
超限或未准入内容不得伪造 change。policy/subscription 撤销则直接把其依赖项标 stale 且停止重爬。
Broker/Context 默认只读 official，因此 stale 立即退出 authoritative retrieval；history/asOf 仍能读取旧 revision。

- [ ] **Step 6: 运行绿测**

Run: `npx vitest run test/pth-knowledge-intake/minimal-loop.integration.test.ts test/pth-runner/knowledge-context.test.ts test/pth-execution/knowledge-broker.test.ts`
Expected: 全部 PASS、无 skip。

- [ ] **Step 7: Commit**

```bash
git add src/pth/execution/knowledge-intake src/pth/bootstrap/batch-process.ts scripts/pth-intake-subscribe.ts packages/pth-memory/src test/pth-knowledge-intake/minimal-loop.integration.test.ts test/pth-runner/knowledge-context.test.ts test/pth-execution/knowledge-broker.test.ts
git commit -m "feat(intake): close recrawl stale and supersedes loop"
```

### Task 7：真实故障组合验收与文档收账

**Files:**
- Modify: `test/pth-knowledge-intake/minimal-loop.integration.test.ts`
- Create: `scripts/accept-n29-minimal-intake.ts`
- Create: `tsconfig.n29.json`
- Create: `docs/pth/n29-minimal-intake-acceptance.json`
- Create: `docs/pth/report/n29-minimal-intake-report.md`
- Modify: `docs/README.md`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: 完整 M0 production composition。
- Produces: 唯一 `MIN_INNER_LOOP_GO | NO-GO | EVALUATION-INCOMPLETE` acceptance envelope。

- [ ] **Step 1: 加入不可真空的正向分母**

至少记录：initial=1、unchanged=1、changed=1、stale=1、supersede=1、domain verdict=1、
adversarial verdict=1、promotion=2、Broker/Context retrieval=2。

- [ ] **Step 2: 加入负向/故障矩阵**

必须覆盖：wrong generation、expired lease、duplicate handler、process restart、dual drainer、cross tenant、
policy expiry/revocation、redirect scope escape、unknown license、empty evidence、stale verdict、同 key 不同
payload conflict、不同 tenant 同 key。每项必须触发相应 sentinel，不能直接改 metrics。

`process restart` 必须在明确 fault point 对真实 scanner/batch 子进程发送 SIGKILL 后启动新进程并读取最终 PG
状态；`dual drainer` 必须是两个独立 OS 进程，而不是同一 Vitest 进程的两个 pool。至少覆盖：artifact 写入前、
aggregate+outbox commit 后/handler 前、handler 写结果后/outbox complete 前三个故障点。

- [ ] **Step 3: 先提交 acceptance machinery**

在生成权威结果前，先提交实现、focused tests、driver 与 `tsconfig.n29.json`，并确认工作树 clean。此 commit
是 `evaluatedCommit`；driver 不得评估一个尚未包含自身或测试的旧 SHA。

```bash
git add test/pth-knowledge-intake/minimal-loop.integration.test.ts scripts/accept-n29-minimal-intake.ts tsconfig.n29.json
git commit -m "test(intake): add minimal loop acceptance machinery"
```

- [ ] **Step 4: 在 clean evaluated commit 运行 release canary**

通过正式 Intake Service 安装一份 PTL human-signed policy，只批准一个真实 HTTPS 来源；执行 initial fetch 至
official，并确认 structured evidence 可重放。canary 不扩大 policy、不写 fixture 表、不直接调用 memory store，
输出绑定 commit/policy digest/source revision/evidence 的结构化证据。网络或来源不可用记
`EVALUATION-INCOMPLETE`，不得放宽 matcher 或改用 direct-store 让它通过。

- [ ] **Step 5: 运行权威 driver 并生成 envelope**

driver 在同一 clean `evaluatedCommit` 上执行并记录：

```bash
npx vitest run test/pth-knowledge-intake/minimal-loop.integration.test.ts --reporter=json --outputFile=/tmp/n29-focused.json
npx tsc -p tsconfig.n29.json --noEmit
npx tsc --noEmit
npm test -- --reporter=json --outputFile=/tmp/n29-full.json
npm run lint
npm run build
```

focused 必须使用 Testcontainers PostgreSQL + 受控 TLS source，0 skip。`tsconfig.n29.json` 必须覆盖全部
N29 scripts、production files 与 focused tests，并把 workspace aliases 指向 source，不能依赖未跟踪的旧
`dist/*.d.ts`。所有命令 exit 0；full 只允许既有冻结 sandbox-security 9 skip，不允许新增 skip。

`accept-n29-minimal-intake.ts` 必须绑定 evaluated commit、Trust Policy digest、测试命令、exit code、skip
manifest、正向分母与负向 sentinel；任一缺失/NaN/零分母/started failure 都为 NO-GO。
PG/TLS 等受控环境在命令启动前不可用才可记 `EVALUATION-INCOMPLETE`；任何已启动门禁非零退出均为 NO-GO，
不得被后续环境不可用覆盖。
focused/full Vitest 必须使用 JSON reporter 输出到临时文件；driver 从 assertion results 生成 repo-relative、
POSIX 化且排序后的 skip manifest，不解析面向人的 stdout。

- [ ] **Step 6: 更新报告与正式索引**

只有 envelope decision=`MIN_INNER_LOOP_GO` 才能把报告标为最小内环 GO；不得写成完整 Autonomous
Knowledge Intake GO。否则报告必须列出未关闭门与最近可复现反例。

- [ ] **Step 7: 提交只读证据与文档**

```bash
git add docs/pth/n29-minimal-intake-acceptance.json docs/pth/report/n29-minimal-intake-report.md docs/README.md CONTEXT.md
git commit -m "docs(intake): record minimal trusted recrawl acceptance"
```

---

## 6. Lane 依赖与本轮停止规则

```text
L1 correctness gates
  → L2 contracts + signed policy
  → L3 PG aggregates
  → L4 artifact fetch
  → L5 ingest + verification handoff
  → L6 recrawl + stale
  → L7 composition acceptance
```

- L1 是硬前置；失败时 L2–L7 不得合并。
- L2 与 L3 可在 L1 通过后按冻结合同并行；L4 依赖 L2 与 L3；L5 依赖 L2–L4；L6 依赖 L3–L5。
- 每条 lane 使用独立 worktree；禁止多 lane 同时修改 schema、contracts barrel 或 batch composition。
- 若本轮只完成 L1–L4，状态只能是 `SAFE-TO-STORE-QUARANTINED / NO-GO-FOR-KNOWLEDGE`；
  完成 L5 后才可写 `SAFE-TO-PRODUCE-PRIVATE-DRAFT / NO-GO-FOR-OFFICIAL`。不得用半闭环报告 GO。
- 外环工作只能在 L7 `MIN_INNER_LOOP_GO` 后另立实施计划，不进入本轮补丁。

## 7. 推荐执行方式

采用 **Subagent-Driven**：L1 先独占执行；L2/L3 并行；之后 L4→L5→L6 串行；L7 由独立验收 lane
执行且不得夹带修复。每条 lane 合并前进行一次 spec compliance review 和一次 code quality review。
