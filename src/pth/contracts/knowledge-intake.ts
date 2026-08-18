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
  /** 与状态迁移同事务入队的下一阶段 outbox。 */
  readonly sideEffects?: readonly IntakeSideEffect[];
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

export interface IntakeClaimInput {
  readonly text: string;
  readonly locator: { readonly start: number; readonly end: number };
  readonly quoteHash: string;
}

export interface IngestSourceRevisionInput {
  readonly revision: SourceRevision;
  readonly claims: readonly IntakeClaimInput[];
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

/** 与 run 状态迁移同事务入队的下一阶段 side effect（identity=(tenantId,key)）。 */
export interface IntakeSideEffect {
  readonly key: string;
  readonly kind: string;
  readonly payload: unknown;
  /** 缺省取迁移的 tenantId；跨 tenant 入队不允许。 */
  readonly tenantId?: string;
}

export interface DueScanOptions {
  /** 只扫单一 tenant（缺省 = 系统级跨 tenant 扫描）。 */
  readonly tenantId?: string;
  /** 下一阶段 outbox kind（缺省 "intake.fetch"）。 */
  readonly outboxKind?: string;
}

export interface KnowledgeIntakeRepository {
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
