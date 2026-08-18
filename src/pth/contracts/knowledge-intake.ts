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
}

export interface ClaimIntakeRunInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly lockedUntil: string;
  readonly principalId: string;
  readonly executionId: string;
}

export interface TransitionIntakeRunInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly fromStage: IntakeRun["stage"];
  readonly toStage: IntakeRun["stage"];
  readonly status: IntakeRun["status"];
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly expectedRowVersion: number;
  readonly sourceRevisionId?: string;
  readonly candidateId?: string;
  readonly verificationPlanId?: string;
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

export interface StoreAcquisitionInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly envelope: SourceAcquisitionEnvelope;
  readonly fetchPolicyDecision: FetchPolicyDecision;
  readonly usePolicyDecision?: UsePolicyDecision;
  readonly previousRevisionId?: string;
}

export interface SourceDependencyInput {
  readonly tenantId: string;
  readonly dependentRevisionId: string;
  readonly dependencyRevisionId: string;
  readonly dependencyKind: "derived-from" | "unchanged-of" | "supersedes";
}

export interface MarkDependentsStaleInput {
  readonly tenantId: string;
  readonly sourceRevisionId: string;
  readonly reason: "source-changed" | "policy-revoked" | "subscription-revoked";
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

export interface KnowledgeIntakeRepository {
  installVerifiedPolicy(input: VerifiedTrustPolicy): Promise<void>;
  createSubscription(input: CreateSubscriptionInput): Promise<SourceSubscription>;
  createDueRuns(now: Date, limit: number): Promise<readonly IntakeRun[]>;
  claimRun(input: ClaimIntakeRunInput): Promise<IntakeRun | null>;
  transitionRun(input: TransitionIntakeRunInput): Promise<IntakeRun | null>;
  storeAcquisition(input: StoreAcquisitionInput): Promise<SourceRevision>;
  recordDependency(input: SourceDependencyInput): Promise<void>;
  markDependentsStale(input: MarkDependentsStaleInput): Promise<readonly string[]>;
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
