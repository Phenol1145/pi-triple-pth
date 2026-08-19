/**
 * contracts/knowledge-intake.ts — N29 最小可信知识摄入 M0 类型与端口（2026-08-19）。
 *
 * 本文件只包含纯类型与结构校验函数；不包含 PG、HTTP 或 LLM 实现类型。
 * 类型形状冻结自 docs/pth/n29-minimal-knowledge-intake-loop-feedback-plan.md §3.2/§3.3。
 *
 * Trust Policy 是来源抓取与使用授权的唯一事实源；LLM、worker 与 service 均只读。
 */

// ─── §3.2 最小持久实体 ───────────────────────────────────────────────

export interface HumanPrincipalRef {
  readonly kind: "human";
  readonly principalId: string;
  readonly tenantId: string;
  readonly issuer: "ptl-human-interface";
}

export interface TrustPolicyRule {
  readonly ruleId: string;
  readonly effect: "allow" | "deny";
  readonly httpsOrigin: string;
  readonly pathPrefix: string;
  readonly spaces: readonly string[];
  readonly domains: readonly string[];
  readonly sourceTypes: readonly string[];
  readonly contentTypes: readonly string[];
  readonly licenses: readonly string[];
  readonly maxBytes: number;
  readonly redirectOrigins: readonly string[];
}

export interface PolicyDecisionRef {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly ruleId: string;
  readonly decision: "allow" | "deny";
  readonly decidedAt: string;
}

export interface TrustPolicyManifest {
  readonly policyId: string;
  readonly version: string;
  readonly tenantId: string;
  readonly spaces: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string;
  readonly approvedBy: HumanPrincipalRef;
  readonly approvalProof: { readonly method: "signed-manifest"; readonly keyId: string; readonly signature: string };
  readonly rules: readonly TrustPolicyRule[];
  readonly digest: string;
}

export interface SourceSubscription {
  readonly id: string;
  readonly tenantId: string;
  readonly space: string;
  readonly canonicalUri: string;
  readonly domainId: string;
  readonly status: "probing" | "active" | "paused" | "revoked" | "retired";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly policyRuleId: string;
  readonly recrawlIntervalMs: number;
  readonly nextCrawlAt: string;
  readonly lastSuccessfulRevisionId?: string;
  readonly rowVersion: number;
}

export interface IntakeRun {
  readonly id: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly reason: "initial" | "scheduled" | "manual-retry";
  readonly stage: "fetch" | "admit" | "extract" | "verify" | "promote" | "complete";
  readonly status: "queued" | "leased" | "waiting" | "completed" | "failed" | "dead-letter";
  readonly attempt: number;
  readonly leaseToken?: string;
  readonly leaseGeneration: number;
  readonly lockedUntil?: string;
  readonly sourceRevisionId?: string;
  readonly candidateId?: string;
  readonly verificationPlanId?: string;
  readonly lastError?: string;
  readonly rowVersion: number;
}

export interface IntakeAttempt {
  readonly runId: string;
  readonly tenantId: string;
  readonly stage: IntakeRun["stage"];
  readonly attempt: number;
  readonly leaseGeneration: number;
  readonly leaseTokenHash: string;
  readonly inputHash: string;
  readonly outputHash?: string;
  readonly disposition: "leased" | "succeeded" | "retryable-failed" | "terminal-failed" | "expired";
  readonly principalId: string;
  readonly executionId: string;
  readonly createdAt: string;
}

export interface SourceArtifact {
  readonly id: string;
  readonly tenantId: string;
  readonly rawHash: string;
  readonly byteLength: number;
  readonly rawBytes: Uint8Array;
  readonly createdAt: string;
}

export interface SourceRevision {
  readonly id: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly runId?: string;
  readonly previousRevisionId?: string;
  readonly derivedFromRevisionId?: string;
  readonly requestedUri: string;
  readonly finalUri: string;
  readonly redirectChain: readonly string[];
  readonly acquiredAt: string;
  readonly responseStatus: number;
  readonly contentType: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly artifactId: string;
  readonly rawHash: string;
  readonly normalizedTextHash: string;
  readonly normalizedText: string;
  readonly disposition: "raw-quarantine" | "admitted" | "unchanged" | "rejected";
  readonly fetchPolicyDecision: PolicyDecisionRef;
  readonly usePolicyDecision?: PolicyDecisionRef;
}

// ─── 冻结联合别名（L3 PG 语义按名引用） ──────────────────────────────

export type SubscriptionStatus = SourceSubscription["status"];
export type IntakeRunStage = IntakeRun["stage"];
export type IntakeRunStatus = IntakeRun["status"];
export type IntakeRunReason = IntakeRun["reason"];
export type IntakeAttemptDisposition = IntakeAttempt["disposition"];
export type SourceRevisionDisposition = SourceRevision["disposition"];

/** 依赖边 append-only 行（tenant+subscription 作用域；只有 stale 状态可迁移）。 */
export interface SourceDependency {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly sourceRevisionId: string;
  readonly dependentKind: "knowledge-entry" | "candidate";
  readonly dependentId: string;
  readonly dependentRevision?: number;
  readonly space: string;
  readonly evidenceDigest: string;
  readonly stale: boolean;
  readonly staleAt?: string;
  readonly staleReason?: string;
  readonly rowVersion: number;
}

export interface IntakeEvidenceReference {
  readonly sourceSubscriptionId: string;
  readonly sourceRevisionId: string;
  readonly representation: "normalized-text";
  readonly locator: { readonly start: number; readonly end: number };
  readonly quoteHash: string;
  readonly artifactHash: string;
  readonly policyDecisionDigest: string;
}

// ─── Trust Policy 决策面 ─────────────────────────────────────────────

/** fetch 阶段授权输入：只拿得到什么就匹配什么，未命中即 fail closed。 */
export interface FetchAuthorizationInput {
  readonly tenantId: string;
  readonly space: string;
  /** 本次实际要抓取的完整 URL；必须是 https: 且 origin 与规则 httpsOrigin 精确相等。 */
  readonly url: string;
  readonly redirectOrigins: readonly string[];
  readonly sourceType: string;
  readonly contentType: string;
  readonly license: string;
  readonly byteLength: number;
}

/** use 阶段在 fetch 基础上追加 domain 与订阅时效/撤销状态。 */
export interface UseAuthorizationInput extends FetchAuthorizationInput {
  readonly domain: string;
  /** 订阅状态（L3 起由 SourceSubscription 提供）；revoked/paused 拒绝 use。 */
  readonly subscriptionStatus?: SourceSubscription["status"];
  /** 订阅有效期（L3 起由 SourceSubscription 提供）；过期拒绝 use。 */
  readonly subscriptionValidUntil?: string;
}

export interface FetchPolicyDecision extends PolicyDecisionRef {
  readonly reason: string;
}

export interface UsePolicyDecision extends PolicyDecisionRef {
  readonly reason: string;
}

/**
 * 已验签 Trust Policy（人类签名 manifest + 双阶段 matcher）。
 *
 * ⚠️ 这是**结构**接口，本身不构成信任边界：满足该结构的普通对象随处可造。
 * “已验证” 的唯一事实是运行时 attestation（`contracts/knowledge-intake-attestation.ts`
 * 的 `POLICY_VERIFIED_BRAND`，故意不从本 barrel 导出）：只有
 * `execution/knowledge-intake/trust-policy.ts` 的 `loadVerifiedTrustPolicy()` 会盖章，
 * `KnowledgeIntakeRepository.installVerifiedPolicy()` 在写库前必须校验该 attestation。
 */
export interface VerifiedTrustPolicy {
  readonly manifest: TrustPolicyManifest;
  /** 已验签摘要（PG 审计镜像）；缺省取 manifest.digest。 */
  readonly digest?: string;
  /** 验签时间（PG 审计镜像）。 */
  readonly verifiedAt?: string;
  /** 验签者（PG 审计镜像）。 */
  readonly verifiedBy?: HumanPrincipalRef;
  /** 审计镜像安装者；缺省取 manifest.approvedBy.principalId。 */
  readonly installedBy?: string;
  authorizeFetch(input: FetchAuthorizationInput): FetchPolicyDecision;
  authorizeUse(input: UseAuthorizationInput): UsePolicyDecision;
}

// ─── §3.3 最小端口 ───────────────────────────────────────────────────

export interface TrustPolicyLoader {
  /**
   * 返回**带运行时 attestation** 的已验签策略（`POLICY_VERIFIED_BRAND`，见
   * `knowledge-intake-attestation.ts`）。实现必须真的验签（Ed25519 detached signature +
   * canonical digest + human signer + 有效期），不得直接回传调用方给的结构对象；
   * 结构拷贝（`{...policy}`、JSON round-trip）会丢失 attestation，持久化边界会拒绝。
   */
  loadVerified(): Promise<VerifiedTrustPolicy>;
  authorizeFetch(input: FetchAuthorizationInput): FetchPolicyDecision;
  authorizeUse(input: UseAuthorizationInput): UsePolicyDecision;
}

export interface CreateSubscriptionInput {
  readonly tenantId: string;
  readonly space: string;
  readonly canonicalUri: string;
  readonly domainId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly policyRuleId: string;
  readonly recrawlIntervalMs: number;
  /** 首次 next_crawl_at；缺省 now()（PG 创建语义）。 */
  readonly nextCrawlAt?: Date | string;
  /** 确定性 subscription id；缺省 uuid（PG 创建语义）。 */
  readonly id?: string;
}

export interface ClaimIntakeRunInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly principalId: string;
  readonly executionId: string;
  /** attempt 审计 input_hash；缺省空串（PG 审计语义）。 */
  readonly inputHash?: string;
  /** 可选 CAS 收窄：不符 → 零行。 */
  readonly expectedRowVersion?: number;
  readonly expectedLeaseGeneration?: number;
  /** lease TTL 覆盖（毫秒）；缺省仓库默认。 */
  readonly leaseMs?: number;
}

export interface TransitionIntakeRunInput {
  readonly tenantId: string;
  readonly runId: string;
  /**
   * 调用方声明的**当前**阶段。N29 再验收 P0-2：SQL CAS 必须包含 `stage = fromStage`，
   * 与 DB 真实 stage 不符即零行；`fromStage → toStage/status` 还必须命中冻结矩阵
   * （`RUN_STAGE_TRANSITIONS` / `isLegalRunTransition`），调用方不能声明任意跳转。
   */
  readonly fromStage: IntakeRun["stage"];
  readonly toStage: IntakeRun["stage"];
  readonly status: IntakeRun["status"];
  /** claim 时仓库签发的 lease token；CAS 必匹配。 */
  readonly leaseToken: string;
  /** CAS 必匹配 lease_generation。 */
  readonly leaseGeneration: number;
  readonly expectedRowVersion: number;
  /** attempt 审计行必填主体/执行。 */
  readonly principalId: string;
  readonly executionId: string;
  readonly disposition?: IntakeAttemptDisposition;
  readonly inputHash?: string;
  readonly outputHash?: string;
  readonly sourceRevisionId?: string;
  readonly candidateId?: string;
  readonly verificationPlanId?: string;
  readonly lastError?: string;
  /** 与状态迁移同事务入队的下一阶段 outbox（tenant 由仓库按 run 聚合盖章）。 */
  readonly sideEffects?: readonly IntakeSideEffect[];
}

// ─── N29 再验收 P0-2：Run 阶段迁移的冻结矩阵（服务端唯一事实源） ──────────

/**
 * `fromStage → 允许的 toStage` 冻结矩阵（`Object.freeze`，运行时不可改写）。
 *
 * 矩阵**精确等于**最小内环的真实阶段图（`src/pth/execution/knowledge-intake/service.ts`），
 * 不留任何"没有 handler 服务"的合法边——否则调用方可以把 run 停在无人处理的 stage 造成活锁：
 *  - `fetch`   → `admit`（外部字节已 quarantine + admitted 落库，交给 extract handler）
 *              / `complete`（unchanged 重爬直接完成）
 *              / `fetch`（自边：retryable 回 queued、dead-letter、阶段错投释放）；
 *  - `admit`   → `verify`（extract handler 在 stage=admit 上运行，写 candidate/plan 后进入双核验）
 *              / `admit`（自边失败/释放）；
 *  - `verify`  → `promote`（domain + adversarial 双 verdict 均通过、plan satisfied）
 *              / `verify`（**同 stage 特例**：domain 通过后转 adversarial；以及失败/释放）；
 *  - `promote` → `complete`（official 晋升完成）/ `promote`（自边失败/释放）；
 *  - `complete`→ **终态，零出边**（含自边）：任何重放都零行；
 *  - `extract` → **当前不可达**（抽取发生在 `admit` 阶段）：零入边、零出边。把抽取拆成独立 stage
 *    需要同时改本矩阵与 handler 的期望 stage，属于显式合同变更，不能由调用方声明。
 *
 * 未列出的边一律非法（跳阶段、回退、终态复活）；`transitionRun()` 在开事务前直接返回 null。
 */
export const RUN_STAGE_TRANSITIONS: Readonly<Record<IntakeRunStage, readonly IntakeRunStage[]>> = Object.freeze({
  fetch: Object.freeze(["fetch", "admit", "complete"] as const),
  admit: Object.freeze(["admit", "verify"] as const),
  extract: Object.freeze([] as const),
  verify: Object.freeze(["verify", "promote"] as const),
  promote: Object.freeze(["promote", "complete"] as const),
  complete: Object.freeze([] as const),
}) as Readonly<Record<IntakeRunStage, readonly IntakeRunStage[]>>;

/**
 * `status` 侧的冻结规则（与 stage 边联合判定，调用方不能自由组合）：
 *  - `completed` ⟺ `toStage === "complete"`（唯一的成功终点；complete 也只接受 completed）；
 *  - `failed` / `dead-letter` 只允许**自边**（`toStage === fromStage`）——失败必须停在出事的阶段，
 *    不得借失败状态顺带跨阶段推进；
 *  - `queued` 允许任何非 `complete` 的合法 toStage（推进下一阶段或原地重排）；
 *  - `leased` / `waiting` 不可由 `transitionRun()` 设置（lease 只能由 `claimRun()` 签发）。
 */
export const RUN_TRANSITION_STATUSES: readonly IntakeRunStatus[] = Object.freeze([
  "queued",
  "completed",
  "failed",
  "dead-letter",
] as const);

/** 冻结矩阵判据：stage 边 + status 规则同时成立才算合法迁移（仓库在 CAS 前调用）。 */
export function isLegalRunTransition(
  fromStage: IntakeRunStage,
  toStage: IntakeRunStage,
  status: IntakeRunStatus,
): boolean {
  const allowed = RUN_STAGE_TRANSITIONS[fromStage];
  if (!allowed || !allowed.includes(toStage)) return false;
  if (!RUN_TRANSITION_STATUSES.includes(status)) return false;
  // `complete` 是唯一成功终点，且只接受 `completed`；反之 `completed` 也只能落在 `complete`。
  if (toStage === "complete") return status === "completed";
  if (status === "completed") return false;
  // 失败必须停在出事的阶段——不得借失败状态顺带跨阶段推进。
  if (status === "failed" || status === "dead-letter") return toStage === fromStage;
  return true;
}

export interface SourceAcquisitionEnvelope {
  readonly requestedUri: string;
  readonly finalUri: string;
  readonly redirectChain: readonly string[];
  readonly status: number;
  readonly headers: { readonly contentType: string; readonly etag?: string; readonly lastModified?: string };
  readonly rawBytes: Uint8Array;
  readonly rawHash: string;
  readonly normalizedText: string;
  readonly normalizedTextHash: string;
}

export interface AcquireSourceInput {
  readonly tenantId: string;
  readonly space: string;
  readonly subscriptionId: string;
  readonly requestedUri: string;
  /** 抓取前的逐跳授权决策；redirect 由 broker 在每跳重新调用 authorizeFetch。 */
  readonly fetchPolicyDecision: FetchPolicyDecision;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
}

/**
 * 落一次 acquisition：artifact（tenant 内按 raw_hash 去重复用）+ 一条 append-only revision。
 * raw-quarantine / admitted / unchanged 各自独立成行；admitted 必须带 use policy decision；
 * unchanged 用 derivedFromRevisionId/previousRevisionId 关联前一 revision。
 */
export interface StoreAcquisitionInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly runId?: string;
  /** 确定性 revision id；缺省 uuid（PG 创建语义）。 */
  readonly revisionId?: string;
  readonly artifact: {
    readonly rawHash: string;
    readonly byteLength: number;
    readonly rawBytes: Uint8Array;
    readonly contentType?: string;
  };
  readonly revision: {
    readonly requestedUri: string;
    readonly finalUri: string;
    readonly redirectChain?: readonly string[];
    readonly acquiredAt: Date | string;
    readonly responseStatus: number;
    readonly contentType: string;
    readonly etag?: string;
    readonly lastModified?: string;
    readonly normalizedText: string;
    readonly normalizedTextHash: string;
    readonly disposition: SourceRevisionDisposition;
    readonly fetchPolicyDecision: PolicyDecisionRef;
    readonly usePolicyDecision?: PolicyDecisionRef;
    readonly previousRevisionId?: string;
    readonly derivedFromRevisionId?: string;
  };
}

export interface SourceDependencyInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly sourceRevisionId: string;
  readonly dependentId: string;
  readonly dependentKind?: "knowledge-entry" | "candidate";
  readonly dependentRevision?: number;
  readonly space?: string;
  readonly evidenceDigest?: string;
}

export interface MarkDependentsStaleInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly reason: "source-changed" | "policy-revoked" | "subscription-revoked";
  /** 当前 revision 自身的 dependent 不标 stale（unchanged 重爬语义）。 */
  readonly exceptSourceRevisionId?: string;
}

/**
 * extractor processor 产出的原子 claim（L5 收紧）。
 *
 * `text` / `locator` / `quoteHash` 都是 **LLM 自报**：`KnowledgeIngestor` 必须从已落库
 * SourceRevision 的 normalized representation 重新读取 `[start,end)` 并重算 quote hash，
 * 自报值只作为 tripwire（不一致即拒），永不作为真相。
 * 每个 claim 至少一条 `IntakeEvidenceReference`（L5 起为必填）。
 */
export interface IntakeClaimInput {
  readonly text: string;
  readonly locator: { readonly start: number; readonly end: number };
  readonly quoteHash: string;
  readonly evidence: readonly IntakeEvidenceReference[];
}

/** producer 身份（写入 candidate provenance；principal 见 `IntakeVerificationPrincipals.producer`）。 */
export interface IntakeProducerRef {
  readonly role: string;
  readonly model: string;
  readonly executionId: string;
}

/**
 * 职责分离的四个 principal（L5 冻结）：producer、domain reviewer、adversarial reviewer、
 * promoter 必须互不相同；任意两个角色同一 principal → 摄入/核验/晋升一律拒绝。
 */
export interface IntakeVerificationPrincipals {
  readonly producer: string;
  readonly domainReviewer: string;
  readonly adversarialReviewer: string;
  readonly promoter: string;
}

export interface IngestSourceRevisionInput {
  readonly revision: SourceRevision;
  readonly claims: readonly IntakeClaimInput[];
  /** 声明的 tenant——必须与 revision 与已落库行严格一致（跨 tenant 零可见）。 */
  readonly tenantId: string;
  /** 声明的 space——必须与 SourceSubscription 一致。 */
  readonly space: string;
  /** 声明的 domain——必须与 SourceSubscription 一致。 */
  readonly domainId: string;
  readonly producer: IntakeProducerRef;
  readonly principals: IntakeVerificationPrincipals;
  /** 产出该 claim 的 IntakeRun（写入 provenance.sourceTaskId）。 */
  readonly runId?: string;
  /** 确定性 candidate id 覆盖（缺省由 revision + evidence digest 派生 → 重放幂等）。 */
  readonly candidateId?: string;
  /** 确定性 plan id 覆盖（缺省由 candidate id + candidate revision 派生）。 */
  readonly planId?: string;
}

/** subscription 状态迁移 / 重排程：rowVersion CAS + 合法迁移矩阵。 */
export interface TransitionSubscriptionInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly expectedRowVersion: number;
  readonly toStatus: SourceSubscription["status"];
  readonly nextCrawlAt?: Date | string;
  readonly lastSuccessfulRevisionId?: string;
}

/**
 * 与 run 状态迁移同事务入队的下一阶段 side effect（identity=(tenantId,key)）。
 *
 * N29 再验收 P0-1（docs/pth/n29-minimal-intake-reacceptance-feedback.md §3 P0-1 / §8 条件 1）：
 * **outbox 行的 tenant 由仓库从聚合上下文盖章**——即通过 Run CAS 的那一行
 * `knowledge_intake_runs.tenant_id`。调用方不再是 tenant 的事实源：
 *  - 缺省（推荐）：仓库盖章为 run 自身 tenant；
 *  - 提供且等于 run tenant：允许（向后兼容既有装配点），仍以仓库盖章值落库；
 *  - 提供且不等于 run tenant：`transitionRun()` 在写 outbox 前抛 `KNOWLEDGE_INTAKE_INVALID`，
 *    整个事务回滚（零迁移、零 attempt、零 outbox）。
 */
export interface IntakeSideEffect {
  readonly key: string;
  readonly kind: string;
  readonly payload: unknown;
  /** @deprecated 由仓库从通过 CAS 的 run `tenant_id` 盖章；提供不相等值 → fail closed（抛错整体回滚）。 */
  readonly tenantId?: string;
}

export interface DueScanOptions {
  /** 只扫单一 tenant（缺省 = 系统级跨 tenant 扫描）。 */
  readonly tenantId?: string;
  /** 下一阶段 outbox kind（缺省 "intake.fetch"）。 */
  readonly outboxKind?: string;
}

export interface KnowledgeIntakeRepository {
  /**
   * 写入已验签 manifest 的 append-only 审计镜像。
   *
   * 实现必须在写事务之前校验运行时 attestation（`POLICY_VERIFIED_BRAND`）：
   * 只有 `loadVerifiedTrustPolicy()` 签发的对象可被安装；同形普通对象、结构拷贝、
   * service/worker principal 一律零行 fail closed。
   */
  installVerifiedPolicy(input: VerifiedTrustPolicy): Promise<void>;
  createSubscription(input: CreateSubscriptionInput): Promise<SourceSubscription>;
  transitionSubscription(input: TransitionSubscriptionInput): Promise<SourceSubscription | null>;
  createDueRuns(now: Date, limit: number, opts?: DueScanOptions): Promise<readonly IntakeRun[]>;
  claimRun(input: ClaimIntakeRunInput): Promise<IntakeRun | null>;
  transitionRun(input: TransitionIntakeRunInput): Promise<IntakeRun | null>;
  storeAcquisition(input: StoreAcquisitionInput): Promise<SourceRevision>;
  recordDependency(input: SourceDependencyInput): Promise<void>;
  markDependentsStale(input: MarkDependentsStaleInput): Promise<readonly string[]>;
  getSubscription(tenantId: string, subscriptionId: string): Promise<SourceSubscription | null>;
  getRun(tenantId: string, runId: string): Promise<IntakeRun | null>;
  getRevision(tenantId: string, revisionId: string): Promise<SourceRevision | null>;
  listRevisions(tenantId: string, subscriptionId: string): Promise<readonly SourceRevision[]>;
  listAttempts(tenantId: string, runId: string): Promise<readonly IntakeAttempt[]>;
  listDependencies(tenantId: string, subscriptionId: string): Promise<readonly SourceDependency[]>;
  /** P0-7 修复：读取 artifact 元数据（不含正文字节），用于 promotion source guard 重算真实 byteLength。 */
  getArtifactMeta(tenantId: string, rawHash: string): Promise<{ id: string; rawHash: string; byteLength: number; contentType: string } | null>;
}

export interface SourceFetchBroker {
  acquire(input: AcquireSourceInput): Promise<SourceAcquisitionEnvelope>;
}

export interface KnowledgeIngestor {
  ingest(input: IngestSourceRevisionInput): Promise<{
    candidateId: string;
    candidateRevision: number;
    planId: string;
  }>;
}

// ─── 结构校验（纯类型守卫；本层不产生授权） ───────────────────────────

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const NON_EMPTY_STRING_ARRAY = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.length > 0 && v.every(NON_EMPTY_STRING);
const FINITE_NUMBER = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isHumanPrincipalRefStructurallyValid(v: unknown): v is HumanPrincipalRef {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    p.kind === "human" &&
    NON_EMPTY_STRING(p.principalId) &&
    NON_EMPTY_STRING(p.tenantId) &&
    p.issuer === "ptl-human-interface"
  );
}

export function isTrustPolicyRuleStructurallyValid(v: unknown): v is TrustPolicyRule {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    NON_EMPTY_STRING(r.ruleId) &&
    (r.effect === "allow" || r.effect === "deny") &&
    NON_EMPTY_STRING(r.httpsOrigin) &&
    typeof r.pathPrefix === "string" &&
    NON_EMPTY_STRING_ARRAY(r.spaces) &&
    Array.isArray(r.domains) && r.domains.every(NON_EMPTY_STRING) &&
    NON_EMPTY_STRING_ARRAY(r.sourceTypes) &&
    NON_EMPTY_STRING_ARRAY(r.contentTypes) &&
    NON_EMPTY_STRING_ARRAY(r.licenses) &&
    FINITE_NUMBER(r.maxBytes) && (r.maxBytes as number) > 0 &&
    NON_EMPTY_STRING_ARRAY(r.redirectOrigins)
  );
}

export function isTrustPolicyManifestStructurallyValid(v: unknown): v is TrustPolicyManifest {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  const proof = m.approvalProof as Record<string, unknown> | undefined;
  return (
    NON_EMPTY_STRING(m.policyId) &&
    NON_EMPTY_STRING(m.version) &&
    NON_EMPTY_STRING(m.tenantId) &&
    NON_EMPTY_STRING_ARRAY(m.spaces) &&
    typeof m.validFrom === "string" && Number.isFinite(Date.parse(m.validFrom)) &&
    typeof m.validUntil === "string" && Number.isFinite(Date.parse(m.validUntil)) &&
    isHumanPrincipalRefStructurallyValid(m.approvedBy) &&
    typeof proof === "object" && proof !== null &&
    proof.method === "signed-manifest" &&
    NON_EMPTY_STRING(proof.keyId) &&
    typeof proof.signature === "string" &&
    Array.isArray(m.rules) && m.rules.length > 0 && m.rules.every(isTrustPolicyRuleStructurallyValid) &&
    typeof m.digest === "string"
  );
}

export function isPolicyDecisionRefStructurallyValid(v: unknown): v is PolicyDecisionRef {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    NON_EMPTY_STRING(d.policyId) &&
    NON_EMPTY_STRING(d.policyVersion) &&
    NON_EMPTY_STRING(d.policyDigest) &&
    NON_EMPTY_STRING(d.ruleId) &&
    (d.decision === "allow" || d.decision === "deny") &&
    typeof d.decidedAt === "string" && Number.isFinite(Date.parse(d.decidedAt))
  );
}
