/**
 * knowledge-intake/service.ts — N29 Task 6：知识摄入内环状态机（application service）。
 *
 * 定位（plan §4 / §5 Task 6）：本文件**只做状态迁移与编排**，不直接执行网络或 LLM。
 * 每个阶段都是「claimRun（lease CAS）→ 调注入端口 → transitionRun（lease+generation+rowVersion CAS
 * 且同事务写下一阶段 outbox）」；任何一步 CAS 不命中即零写、零 side effect。
 *
 * 内环（plan §2.1）：
 * ```
 * intake.fetch              claim → authorizeFetch → broker.acquire → raw-quarantine revision
 *                           → decideSourceAdmission → admitted revision → stage "admit"
 *                             ├─ unchanged（rawHash 不变 / 304）: 只落 unchanged revision → run complete
 *                             └─ changed: 同事务把旧 official 标 stale + dependency refresh outbox
 * intake.extract            claim → extractor processor → KnowledgeIngestor.ingest（draft+plan+dep）
 *                           → stage "verify"
 * intake.review-domain      claim → domain processor → recordKnowledgeVerdict → 排下一个 check
 * intake.review-adversarial claim → adversarial processor → recordKnowledgeVerdict → stage "promote"
 * intake.promote            claim → promoteKnowledgeEntry（锁内 policy/source binding 复检）
 *                           → knowledge-entry 依赖边 → subscription active + nextCrawlAt → run complete
 * ```
 *
 * 硬约束：
 *  - 只有 Promotion Service 能写 official；stale 只能经 `PgMemoryStore.markKnowledgeStaleInTx()`；
 *  - 抓取失败 / 超限 / 未准入内容**不得**伪造 change（不写 admitted、不标 stale）；
 *  - 可重试失败：run 回到 `queued` 并记录 lastError，然后抛错让 outbox backoff 重投；
 *    终态失败：run 置 `dead-letter`，outbox 正常 complete（不无限重试）；
 *  - policy/subscription 撤销：依赖项标 stale 且停止重爬（subscription 迁出 due 扫描状态）。
 */

import type pg from "pg";
import {
  type KnowledgeOfficialAuthority,
  type MemoryEntry,
  type PgMemoryStore,
} from "@away_from/pth-memory";

import type {
  IntakeClaimInput,
  IntakeRun,
  IntakeRunStage,
  IntakeRunStatus,
  IntakeSideEffect,
  IntakeVerificationPrincipals,
  KnowledgeIngestor,
  KnowledgeIntakeRepository,
  MarkDependentsStaleInput,
  SourceDependencyInput,
  SourceRevision,
  SourceSubscription,
  SubscriptionStatus,
  VerifiedTrustPolicy,
} from "@away_from/pth-contracts";
import { withTx, enqueueSideEffectInTx } from "@away_from/pth-kernel-storage";
import {
  createPgKnowledgeVerificationRepo,
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
  type KnowledgeVerificationRepo,
} from "../knowledge-promotion.js";
import {
  evaluatePlanVerdicts,
  type KnowledgeVerdict,
  type KnowledgeVerdictKind,
  type VerificationPlanRecord,
} from "../knowledge-verdicts.js";
import { decideSourceAdmission, type SourceAdmissionVerdict } from "./admission.js";
import {
  sha256Hex,
  type DeclaredSourceAttributes,
  type PolicyBoundSourceAcquisitionEnvelope,
  type PolicyBoundSourceFetchBroker,
} from "./fetch-broker.js";
import { createIntakeSourceBindingRecheck } from "./knowledge-ingestor.js";
import type { TrustPolicyClock } from "./trust-policy.js";

export type { IntakeRun, IntakeSideEffect, MarkDependentsStaleInput, SourceSubscription, SubscriptionStatus } from "@away_from/pth-contracts";
export type { PolicyBoundSourceAcquisitionEnvelope } from "./fetch-broker.js";

// ─── outbox kinds（生产 drainer 注册面的唯一事实源） ───────────────────

/**
 * intake 阶段 outbox kind。`fetch` 必须与 L3 `createDueRuns()` 的默认 kind 一致
 * （due scanner 只 enqueue 这一个 kind，其余由本 service 在阶段迁移中同事务串起来）。
 */
export const INTAKE_STAGE_OUTBOX_KINDS = {
  fetch: "intake.fetch",
  extract: "intake.extract",
  reviewDomain: "intake.review-domain",
  reviewAdversarial: "intake.review-adversarial",
  promote: "intake.promote",
  /** 变化重爬的依赖刷新 fan-out（下游消费者由 L7 组合，本 lane 只保证原子写出）。 */
  dependencyRefresh: "knowledge.dependency-refresh",
} as const;

export type IntakeStageOutboxKind = (typeof INTAKE_STAGE_OUTBOX_KINDS)[keyof typeof INTAKE_STAGE_OUTBOX_KINDS];

/** 阶段 outbox payload（handler 只需要 tenant + runId；其余字段为可读审计信息）。 */
export interface IntakeStagePayload {
  readonly runId: string;
  readonly tenantId: string;
  readonly subscriptionId?: string;
  readonly stage?: IntakeRunStage;
  readonly attempt?: number;
  readonly reason?: string;
}

// ─── 注入端口（结构化；生产 processor 直接满足） ───────────────────────

export interface IntakeExtractionPortRequest {
  readonly runId: string;
  readonly executionId: string;
  readonly tenantId: string;
  readonly space: string;
  readonly domainId: string;
  /** 已落库的 admitted SourceRevision（processor 只能从它的 normalized representation 取证）。 */
  readonly revision: SourceRevision;
}

export interface IntakeExtractionPortOutcome {
  readonly claims: readonly IntakeClaimInput[];
  readonly model: string;
}

export type IntakeExtractionPortResult =
  | { readonly ok: true; readonly outcome: IntakeExtractionPortOutcome }
  | { readonly ok: false; readonly error: string };

/** extract processor 端口（`runner/intake-processors.ts` 的生产 adapter 按结构满足）。 */
export interface IntakeExtractionPort {
  extract(request: IntakeExtractionPortRequest): Promise<IntakeExtractionPortResult>;
}

export interface IntakeReviewPortRequest {
  readonly runId: string;
  readonly executionId: string;
  readonly plan: VerificationPlanRecord;
  readonly principals: IntakeVerificationPrincipals;
  readonly candidateContent: string;
  readonly evidence: readonly unknown[];
  /** 服务端从 admitted revision 重算的 quote（模型只能据此判断）。 */
  readonly evidenceQuotes: readonly string[];
}

export interface IntakeReviewPortOutcome {
  readonly planId: string;
  readonly checkId: string;
  readonly candidateRevision: number;
  readonly principalId: string;
  readonly executionId: string;
  readonly verdict: KnowledgeVerdict;
}

export type IntakeReviewPortResult =
  | { readonly ok: true; readonly outcome: IntakeReviewPortOutcome }
  | { readonly ok: false; readonly error: string };

/** review processor 端口（`runner/intake-processors.ts` 的生产 adapter 按结构满足）。 */
export interface IntakeReviewPort {
  readonly kind: KnowledgeVerdictKind;
  review(request: IntakeReviewPortRequest): Promise<IntakeReviewPortResult>;
}

/**
 * service 需要的仓库面：冻结合同 + PG 适配器的事务绑定写入。
 * M0 contracts 不得出现 `pg` 类型，故事务面按结构消费（与 KnowledgeIngestor 同款做法）。
 */
export interface KnowledgeIntakeServiceRepository extends KnowledgeIntakeRepository {
  recordDependencyInTx(client: pg.PoolClient, input: SourceDependencyInput): Promise<void>;
  markDependentsStaleInTx(
    client: pg.PoolClient,
    input: MarkDependentsStaleInput,
  ): Promise<readonly { dependentId: string; dependentKind: "knowledge-entry" | "candidate"; sourceRevisionId: string; space: string }[]>;
  getArtifactMeta(
    tenantId: string,
    rawHash: string,
  ): Promise<{ id: string; rawHash: string; byteLength: number; contentType: string } | null>;
}

/** service 需要的 store 面（stale 撤出 + 读；official 只能由 promotion 写）。 */
export type KnowledgeIntakeServiceStore = Pick<
  PgMemoryStore,
  "get" | "update" | "promoteOfficial" | "markKnowledgeStaleInTx"
>;

export type VerifiedPolicyProvider =
  | VerifiedTrustPolicy
  | (() => VerifiedTrustPolicy | Promise<VerifiedTrustPolicy>);

// ─── subscription service（CLI 与 service 共用同一入口） ───────────────

export interface KnowledgeIntakeSubscriptionServiceDeps {
  readonly repository: Pick<KnowledgeIntakeRepository, "installVerifiedPolicy" | "createSubscription">;
  readonly policy: VerifiedPolicyProvider;
}

export interface SubscribeSourceInput {
  readonly space: string;
  /** 规范抓取 URI（必须被当前人类签名策略 allow）。 */
  readonly canonicalUri: string;
  readonly domainId: string;
  readonly recrawlIntervalMs: number;
  readonly declared: DeclaredSourceAttributes;
  readonly nextCrawlAt?: Date | string;
  /** 确定性 subscription id（缺省 uuid）。 */
  readonly id?: string;
}

export interface KnowledgeIntakeSubscriptionService {
  /**
   * 安装已验签 policy 的审计镜像并创建 probing Subscription。
   *
   * 这是 ops 入口（`scripts/tools/pth-intake-subscribe.ts`）唯一允许调用的写路径：
   * 不签发/修改 policy、不直接 INSERT 表、不直接发布 Task。
   * 请求 URI 必须先通过 `authorizeFetch()` **和** `authorizeUse()`（domain 维度），
   * 任一未 allow 即 fail closed，不创建任何订阅。
   */
  subscribe(input: SubscribeSourceInput): Promise<SourceSubscription>;
}

/** 摄入前置条件不满足（写前 fail closed）。 */
export class KnowledgeIntakeServiceError extends Error {
  readonly code = "KNOWLEDGE_INTAKE_SERVICE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIntakeServiceError";
  }
}

/** 可重试阶段失败：run 已回到 queued 并记录 lastError，抛出让 outbox backoff 重投。 */
export class IntakeStageRetryableError extends Error {
  readonly code = "INTAKE_STAGE_RETRYABLE";
  constructor(readonly stage: IntakeRunStage, readonly runId: string, message: string) {
    super(`intake stage ${stage} failed (retryable) for run ${runId}: ${message}`);
    this.name = "IntakeStageRetryableError";
  }
}

export async function resolvePolicy(provider: VerifiedPolicyProvider): Promise<VerifiedTrustPolicy> {
  return typeof provider === "function" ? await provider() : provider;
}

export function originOf(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function createKnowledgeIntakeSubscriptionService(
  deps: KnowledgeIntakeSubscriptionServiceDeps,
): KnowledgeIntakeSubscriptionService {
  return {
    async subscribe(input: SubscribeSourceInput): Promise<SourceSubscription> {
      for (const key of ["space", "canonicalUri", "domainId"] as const) {
        if (typeof input?.[key] !== "string" || input[key].trim() === "") {
          throw new KnowledgeIntakeServiceError(`subscribe requires a non-empty ${key}`);
        }
      }
      if (!Number.isFinite(input.recrawlIntervalMs) || input.recrawlIntervalMs <= 0) {
        throw new KnowledgeIntakeServiceError("subscribe requires a positive recrawlIntervalMs");
      }
      if (originOf(input.canonicalUri) === null) {
        throw new KnowledgeIntakeServiceError(`subscribe requires an https canonicalUri (got ${input.canonicalUri})`);
      }

      const policy = await resolvePolicy(deps.policy);
      const tenantId = policy.manifest.tenantId;
      const fetchDecision = policy.authorizeFetch({
        tenantId,
        space: input.space,
        url: input.canonicalUri,
        redirectOrigins: [],
        sourceType: input.declared.sourceType,
        contentType: input.declared.contentType,
        license: input.declared.license,
        byteLength: 0,
      });
      if (fetchDecision.decision !== "allow") {
        throw new KnowledgeIntakeServiceError(
          `subscribe denied: the signed trust policy does not authorize fetching ${input.canonicalUri}`
          + `（${fetchDecision.reason}）`,
        );
      }
      const useDecision = policy.authorizeUse({
        tenantId,
        space: input.space,
        url: input.canonicalUri,
        redirectOrigins: [],
        sourceType: input.declared.sourceType,
        contentType: input.declared.contentType,
        license: input.declared.license,
        byteLength: 0,
        domain: input.domainId,
        subscriptionStatus: "probing",
      });
      if (useDecision.decision !== "allow") {
        throw new KnowledgeIntakeServiceError(
          `subscribe denied: the signed trust policy does not authorize using ${input.canonicalUri}`
          + ` in domain ${input.domainId}（${useDecision.reason}）`,
        );
      }

      // 已验签 manifest 的不可变审计镜像（DB 行不能创建、扩大或替换 policy）。
      await deps.repository.installVerifiedPolicy(policy);

      return deps.repository.createSubscription({
        tenantId,
        space: input.space,
        canonicalUri: input.canonicalUri,
        domainId: input.domainId,
        policyId: policy.manifest.policyId,
        policyVersion: policy.manifest.version,
        policyDigest: policy.digest ?? policy.manifest.digest,
        policyRuleId: fetchDecision.ruleId,
        recrawlIntervalMs: input.recrawlIntervalMs,
        ...(input.nextCrawlAt === undefined ? {} : { nextCrawlAt: input.nextCrawlAt }),
        ...(input.id === undefined ? {} : { id: input.id }),
      });
    },
  };
}

// ─── 内环 service ─────────────────────────────────────────────────────

export interface KnowledgeIntakeServiceDeps {
  readonly pool: pg.Pool;
  readonly repository: KnowledgeIntakeServiceRepository;
  readonly store: KnowledgeIntakeServiceStore;
  /** 持久 VerificationPlan / verdict rows 仓库（缺省用 pool 自建生产实现）。 */
  readonly verification?: KnowledgeVerificationRepo;
  readonly policy: VerifiedPolicyProvider;
  readonly broker: PolicyBoundSourceFetchBroker;
  readonly ingestor: KnowledgeIngestor;
  readonly extractor: IntakeExtractionPort;
  readonly domainReview: IntakeReviewPort;
  readonly adversarialReview: IntakeReviewPort;
  /** 四个职责分离的 principal（producer/domain/adversarial/promoter 必须互不相同）。 */
  readonly principals: IntakeVerificationPrincipals;
  readonly declared: DeclaredSourceAttributes;
  /** candidate provenance 的 producer role（默认 "recon-doc"）。 */
  readonly producerRole?: string;
  /** promotion meta 的 promotedBy（默认 "memory-keeper"）。 */
  readonly promoterRole?: string;
  readonly clock?: TrustPolicyClock;
  /** run lease TTL 覆盖（毫秒）。 */
  readonly leaseMs?: number;
  /**
   * evidence quote 复算器（缺省 = 服务端严格复算）。仅 G10 sabotage 敏感度测试注入
   * 恒接受实现以证明 `evidenceQuoteRecheck` sentinel 会翻红；生产组合必须省略。
   */
  readonly evidenceQuoteVerifier?: EvidenceQuoteVerifier;
}

export type IntakeStageDisposition =
  | "advanced"
  | "unchanged-complete"
  | "completed"
  | "dead-letter"
  | "skipped";

export interface IntakeStageResult {
  readonly runId: string;
  readonly stage: IntakeRunStage;
  readonly disposition: IntakeStageDisposition;
  readonly nextKind?: IntakeStageOutboxKind;
  readonly sourceRevisionId?: string;
  readonly candidateId?: string;
  readonly planId?: string;
  readonly staleEntryIds?: readonly string[];
  readonly error?: string;
}

export interface RevokeSubscriptionInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly reason: MarkDependentsStaleInput["reason"];
  /** 撤销后的目标状态（缺省 revoked；policy 轮换可用 paused）。 */
  readonly toStatus?: Extract<SubscriptionStatus, "revoked" | "paused">;
}

export interface RevokeSubscriptionResult {
  readonly subscription: SourceSubscription | null;
  readonly staleEntryIds: readonly string[];
  readonly staleDependentIds: readonly string[];
}

export interface KnowledgeIntakeService extends KnowledgeIntakeSubscriptionService {
  runFetchStage(payload: unknown): Promise<IntakeStageResult>;
  runExtractStage(payload: unknown): Promise<IntakeStageResult>;
  runDomainReviewStage(payload: unknown): Promise<IntakeStageResult>;
  runAdversarialReviewStage(payload: unknown): Promise<IntakeStageResult>;
  runPromoteStage(payload: unknown): Promise<IntakeStageResult>;
  /** policy/subscription 撤销：依赖项标 stale 且停止重爬。 */
  revokeSubscription(input: RevokeSubscriptionInput): Promise<RevokeSubscriptionResult>;
  /** 生产 drainer 注册面（`createSideEffectDrainer({ handlers })`）。 */
  stageHandlers(): Record<string, (payload: unknown) => Promise<void>>;
}

export const DEFAULT_PRODUCER_ROLE = "recon-doc";
export const DEFAULT_PROMOTER_ROLE = "memory-keeper";
/** stale/official 的内部写 authority（与 worker capability 完全分离）。 */
export const PROMOTION_AUTHORITY: KnowledgeOfficialAuthority = "promotion-service";
export const ACTIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["probing", "active"];

export function nowOf(clock: TrustPolicyClock | undefined): Date {
  if (!clock) return new Date();
  return typeof clock === "function" ? clock() : clock.now();
}

export function parsePayload(payload: unknown): IntakeStagePayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const runId = typeof p.runId === "string" ? p.runId.trim() : "";
  const tenantId = typeof p.tenantId === "string" ? p.tenantId.trim() : "";
  if (runId === "" || tenantId === "") {
    throw new KnowledgeIntakeServiceError("intake stage payload requires non-empty runId and tenantId");
  }
  return {
    runId,
    tenantId,
    ...(typeof p.subscriptionId === "string" ? { subscriptionId: p.subscriptionId } : {}),
    ...(typeof p.attempt === "number" ? { attempt: p.attempt } : {}),
  };
}

/**
 * 服务端 quote 复算：evidence 只能指向已落库 revision 的 `[start,end)`，且
 * `sha256(quote)` 必须等于证据自带的 `quoteHash`。任何不符 → 该阶段 fail closed，
 * 证据不能进入 domain/adversarial review。
 */
export interface EvidenceQuoteRecheckInput {
  readonly revision: Pick<SourceRevision, "id" | "normalizedText">;
  readonly evidence: readonly unknown[];
}

export type EvidenceQuoteVerifier = (
  input: EvidenceQuoteRecheckInput,
) => readonly string[] | Promise<readonly string[]>;

export function verifyIntakeEvidenceQuotes(input: EvidenceQuoteRecheckInput): string[] {
  const { revision, evidence } = input;
  const quotes: string[] = [];
  for (const [index, raw] of evidence.entries()) {
    const ref = raw as { locator?: { start?: number; end?: number }; quoteHash?: string; sourceRevisionId?: string };
    const start = ref?.locator?.start;
    const end = ref?.locator?.end;
    if (ref?.sourceRevisionId !== revision.id) {
      throw new KnowledgeIntakeServiceError(`evidence[${index}] does not point at source revision ${revision.id}`);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 0 || end! <= start! || end! > revision.normalizedText.length) {
      throw new KnowledgeIntakeServiceError(`evidence[${index}] locator no longer addresses the normalized representation`);
    }
    const quote = revision.normalizedText.slice(start!, end!);
    if (sha256Hex(quote) !== ref.quoteHash) {
      throw new KnowledgeIntakeServiceError(`evidence[${index}] quote hash does not match the stored source revision`);
    }
    quotes.push(quote);
  }
  return quotes;
}

/**
 * 选择 evidence quote 复算器：缺省永远是服务端严格复算 `verifyIntakeEvidenceQuotes`。
 * `override` 只用于 G10 sabotage 敏感度证明（通过依赖缝注入恒接受复算器，证明
 * `evidenceQuoteRecheck` sentinel 会翻红）；生产组合不得注入。
 */
export function selectEvidenceQuoteVerifier(override?: EvidenceQuoteVerifier): EvidenceQuoteVerifier {
  return override ?? verifyIntakeEvidenceQuotes;
}
