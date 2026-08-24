/**
 * knowledge-verdicts-types.ts —— K4 Phase 4（N22 1）候选验证 verdict 的类型契约。
 *
 * 从 `knowledge-verdicts.ts` 非破坏性拆分：类型集中于此，原文件作为 barrel 再导出。
 */

export type KnowledgeVerdictKind = "domain" | "adversarial";

export interface KnowledgeVerdict {
  kind: KnowledgeVerdictKind;
  verdict: "pass" | "reject";
  /** domain:<id> 或 controller:adversarial 或 memory-keeper */
  reviewerRole: string;
  /** 非空 */
  note: string;
  at: number;
  /** F3：签发主体（HTTP 取自 auth，能力面取自 worker 身份；不可伪造） */
  principalId?: string;
  /** F3：执行上下文（task/run id，HTTP 可缺省） */
  executionId?: string;
  /** R3：绑定 plan 的 candidateRevision——由 service 盖章，调用方不可覆盖 */
  candidateRevision?: number;
  /** F3：domain 类 verdict 必填；adversarial 不填 */
  domainId?: string;
  /** F3：可选证据——字符串数组且元素非空 */
  evidence?: string[];
}

/** 持久 VerificationPlan 的最小形状（R3/P1-2）。 */
export type VerificationPlanStatus = "open" | "satisfied" | "rejected" | "invalidated";

export interface VerificationCheckRecord {
  checkId: string;
  kind: KnowledgeVerdictKind;
  domainId?: string;
  quorum: number;
  eligiblePrincipals: string[];
  separationFrom: string[];
}

export interface VerificationPlanRecord {
  id: string;
  tenantId: string;
  candidateId: string;
  candidateRevision: number;
  candidateHash: string;
  requiredDomains: string[];
  checks: VerificationCheckRecord[];
  sourceBindingsDigest: string;
  status: VerificationPlanStatus;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** 持久 verdict row（R3/P0-3）：与 candidate content revision 分离的 review-row。 */
export interface KnowledgeVerdictRowRecord {
  id: string | number;
  planId: string;
  tenantId: string;
  checkId: string;
  candidateId: string;
  candidateRevision: number;
  candidateHash: string;
  principalId: string;
  executionId: string;
  kind: KnowledgeVerdictKind;
  verdict: "pass" | "reject";
  reviewerRole: string;
  note: string;
  domainId?: string;
  evidence: string[];
  at: number;
  rowVersion: number;
  createdAt: string;
}

/** N29 candidate 的 meta.intake 绑定（KnowledgeIngestor 盖章；调用方不可伪造出 official）。 */
export interface CandidateIntakeBinding {
  sourceSubscriptionId: string;
  sourceRevisionId: string;
  representation: "normalized-text";
  artifactHash: string;
  policyDecisionDigest: string;
  tenantId: string;
  space: string;
  domainId: string;
  producerPrincipalId: string;
  runId?: string;
}
