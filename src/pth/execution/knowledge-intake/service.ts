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
} from "../../contracts/index.js";
import { withTx } from "../../kernel/storage/pg.js";
import { enqueueSideEffectInTx } from "../../tasking/index.js";
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
   * 这是 ops 入口（`scripts/pth-intake-subscribe.ts`）唯一允许调用的写路径：
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

async function resolvePolicy(provider: VerifiedPolicyProvider): Promise<VerifiedTrustPolicy> {
  return typeof provider === "function" ? await provider() : provider;
}

function originOf(uri: string): string | null {
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

const DEFAULT_PRODUCER_ROLE = "recon-doc";
const DEFAULT_PROMOTER_ROLE = "memory-keeper";
/** stale/official 的内部写 authority（与 worker capability 完全分离）。 */
const PROMOTION_AUTHORITY: KnowledgeOfficialAuthority = "promotion-service";
const ACTIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["probing", "active"];

function nowOf(clock: TrustPolicyClock | undefined): Date {
  if (!clock) return new Date();
  return typeof clock === "function" ? clock() : clock.now();
}

function parsePayload(payload: unknown): IntakeStagePayload {
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

export function createKnowledgeIntakeService(deps: KnowledgeIntakeServiceDeps): KnowledgeIntakeService {
  const verification = deps.verification ?? createPgKnowledgeVerificationRepo(deps.pool);
  const producerRole = deps.producerRole ?? DEFAULT_PRODUCER_ROLE;
  const promoterRole = deps.promoterRole ?? DEFAULT_PROMOTER_ROLE;
  const subscriptions = createKnowledgeIntakeSubscriptionService({
    repository: deps.repository,
    policy: deps.policy,
  });
  const recheck = createIntakeSourceBindingRecheck({
    intake: deps.repository,
    policy: () => resolvePolicy(deps.policy),
    declared: { sourceType: deps.declared.sourceType, license: deps.declared.license },
  });
  const evidenceQuoteVerifier = selectEvidenceQuoteVerifier(deps.evidenceQuoteVerifier);

  /** 阶段 executionId 稳定派生（同 run 同阶段跨重试一致——verdict 行可幂等重放）。 */
  const executionIdOf = (stage: string, runId: string): string => `intake:${stage}:${runId}`;

  /** 下一阶段 outbox：key 带 attempt，保证重试产生新行而不是撞上已 done 的旧行。 */
  const nextStageEffect = (
    kind: IntakeStageOutboxKind,
    run: IntakeRun,
    stage: IntakeRunStage,
  ): IntakeSideEffect => ({
    key: `${kind}:${run.id}:${run.attempt}`,
    kind,
    tenantId: run.tenantId,
    payload: {
      runId: run.id,
      tenantId: run.tenantId,
      subscriptionId: run.subscriptionId,
      stage,
      attempt: run.attempt,
    },
  });

  async function claim(
    tenantId: string,
    runId: string,
    stage: string,
    inputHash: string,
  ): Promise<IntakeRun | null> {
    return deps.repository.claimRun({
      tenantId,
      runId,
      principalId: deps.principals.producer,
      executionId: executionIdOf(stage, runId),
      inputHash,
      ...(deps.leaseMs === undefined ? {} : { leaseMs: deps.leaseMs }),
    });
  }

  /** 终态失败：run → dead-letter（不再重投；outbox 正常 complete）。 */
  async function deadLetter(run: IntakeRun, error: string): Promise<IntakeStageResult> {
    await deps.repository.transitionRun({
      tenantId: run.tenantId,
      runId: run.id,
      fromStage: run.stage,
      toStage: run.stage,
      status: "dead-letter",
      leaseToken: run.leaseToken!,
      leaseGeneration: run.leaseGeneration,
      expectedRowVersion: run.rowVersion,
      principalId: deps.principals.producer,
      executionId: executionIdOf(run.stage, run.id),
      disposition: "terminal-failed",
      lastError: error.slice(0, 2000),
    });
    return { runId: run.id, stage: run.stage, disposition: "dead-letter", error };
  }

  /** 可重试失败：run 回到 queued（可再次 claim）并记录 lastError，然后抛错让 outbox backoff。 */
  async function retryable(run: IntakeRun, error: string): Promise<never> {
    await deps.repository.transitionRun({
      tenantId: run.tenantId,
      runId: run.id,
      fromStage: run.stage,
      toStage: run.stage,
      status: "queued",
      leaseToken: run.leaseToken!,
      leaseGeneration: run.leaseGeneration,
      expectedRowVersion: run.rowVersion,
      principalId: deps.principals.producer,
      executionId: executionIdOf(run.stage, run.id),
      disposition: "retryable-failed",
      lastError: error.slice(0, 2000),
    });
    throw new IntakeStageRetryableError(run.stage, run.id, error);
  }

  /** 阶段错投/重放：把 run 放回 queued（不写 side effect），由正确 kind 的行接管。 */
  async function releaseUnexpectedStage(run: IntakeRun, expected: IntakeRunStage): Promise<IntakeStageResult> {
    await deps.repository.transitionRun({
      tenantId: run.tenantId,
      runId: run.id,
      fromStage: run.stage,
      toStage: run.stage,
      status: "queued",
      leaseToken: run.leaseToken!,
      leaseGeneration: run.leaseGeneration,
      expectedRowVersion: run.rowVersion,
      principalId: deps.principals.producer,
      executionId: executionIdOf(run.stage, run.id),
      disposition: "expired",
      lastError: `stage ${run.stage} does not match handler stage ${expected}（replayed outbox row）`,
    });
    return { runId: run.id, stage: run.stage, disposition: "skipped" };
  }

  /** CAS 重排程 / 状态迁移（读回最新 rowVersion 后再 CAS——避免陈旧期望值）。 */
  async function rescheduleSubscription(
    tenantId: string,
    subscriptionId: string,
    toStatus: SubscriptionStatus,
    opts: { nextCrawlAt?: Date; lastSuccessfulRevisionId?: string } = {},
  ): Promise<SourceSubscription | null> {
    const current = await deps.repository.getSubscription(tenantId, subscriptionId);
    if (!current) return null;
    return deps.repository.transitionSubscription({
      tenantId,
      subscriptionId,
      expectedRowVersion: current.rowVersion,
      toStatus,
      ...(opts.nextCrawlAt === undefined ? {} : { nextCrawlAt: opts.nextCrawlAt }),
      ...(opts.lastSuccessfulRevisionId === undefined ? {} : { lastSuccessfulRevisionId: opts.lastSuccessfulRevisionId }),
    });
  }

  /**
   * 变化重爬 / 撤销的原子撤出（plan §5 Task 6 Step 5）：单事务内
   *  ① 依赖边 stale（可排除新 revision）→ ② 旧 official 知识条目 stale
   *  → ③ dependency refresh outbox。任一步失败即整体回滚（不留半撤出状态）。
   */
  async function withdrawDependents(input: {
    tenantId: string;
    subscriptionId: string;
    reason: MarkDependentsStaleInput["reason"];
    exceptSourceRevisionId?: string;
    supersededByRevisionId?: string;
  }): Promise<{ staleEntryIds: readonly string[]; staleDependentIds: readonly string[] }> {
    return withTx(deps.pool, async (client) => {
      const rows = await deps.repository.markDependentsStaleInTx(client, {
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        reason: input.reason,
        ...(input.exceptSourceRevisionId === undefined ? {} : { exceptSourceRevisionId: input.exceptSourceRevisionId }),
      });
      const staleEntryIds: string[] = [];
      for (const row of rows) {
        if (row.dependentKind !== "knowledge-entry") continue;
        const marked = await deps.store.markKnowledgeStaleInTx(client, row.dependentId, input.tenantId, {
          reason: input.reason,
          sourceRevisionId: row.sourceRevisionId,
          ...(input.supersededByRevisionId === undefined ? {} : { supersededByRevisionId: input.supersededByRevisionId }),
          createdBy: promoterRole,
          knowledgeOfficialAuthority: PROMOTION_AUTHORITY,
        });
        if (marked.disposition === "marked-stale") staleEntryIds.push(row.dependentId);
      }
      if (rows.length > 0) {
        await enqueueSideEffectInTx(client, {
          key: `${INTAKE_STAGE_OUTBOX_KINDS.dependencyRefresh}:${input.tenantId}:${input.subscriptionId}`
            + `:${input.exceptSourceRevisionId ?? input.reason}`,
          tenantId: input.tenantId,
          kind: INTAKE_STAGE_OUTBOX_KINDS.dependencyRefresh,
          payload: {
            tenantId: input.tenantId,
            subscriptionId: input.subscriptionId,
            reason: input.reason,
            staleDependentIds: rows.map((r) => r.dependentId).sort(),
            ...(input.exceptSourceRevisionId === undefined ? {} : { supersedingSourceRevisionId: input.exceptSourceRevisionId }),
          },
        });
      }
      return { staleEntryIds, staleDependentIds: rows.map((r) => r.dependentId).sort() };
    });
  }

  // ── stage 1：fetch + admission + unchanged/changed 分流 ─────────────

  async function runFetchStage(payload: unknown): Promise<IntakeStageResult> {
    const { runId, tenantId } = parsePayload(payload);
    const run = await claim(tenantId, runId, "fetch", runId);
    if (!run) return { runId, stage: "fetch", disposition: "skipped" };
    if (run.stage !== "fetch") return releaseUnexpectedStage(run, "fetch");

    const subscription = await deps.repository.getSubscription(tenantId, run.subscriptionId);
    if (!subscription) {
      return deadLetter(run, `source subscription ${run.subscriptionId} is unknown in tenant ${tenantId}`);
    }
    // ① 订阅撤销/暂停/退役：撤出依赖并停止重爬（不抓取、不伪造 change）。
    if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
      const withdrawn = await withdrawDependents({
        tenantId,
        subscriptionId: subscription.id,
        reason: "subscription-revoked",
      });
      return {
        ...(await deadLetter(run, `subscription status "${subscription.status}" does not allow crawling`)),
        staleEntryIds: withdrawn.staleEntryIds,
      };
    }

    const policy = await resolvePolicy(deps.policy);
    const fetchDecision = policy.authorizeFetch({
      tenantId,
      space: subscription.space,
      url: subscription.canonicalUri,
      redirectOrigins: [],
      sourceType: deps.declared.sourceType,
      contentType: deps.declared.contentType,
      license: deps.declared.license,
      byteLength: 0,
    });
    // ② policy 过期/轮换/撤销：撤出依赖 + 暂停订阅（停止重爬），run 终态。
    if (fetchDecision.decision !== "allow") {
      const withdrawn = await withdrawDependents({
        tenantId,
        subscriptionId: subscription.id,
        reason: "policy-revoked",
      });
      await rescheduleSubscription(tenantId, subscription.id, "paused");
      return {
        ...(await deadLetter(run, `current trust policy no longer authorizes fetch: ${fetchDecision.reason}`)),
        staleEntryIds: withdrawn.staleEntryIds,
      };
    }

    const previous = subscription.lastSuccessfulRevisionId
      ? await deps.repository.getRevision(tenantId, subscription.lastSuccessfulRevisionId)
      : null;

    let envelope: PolicyBoundSourceAcquisitionEnvelope;
    try {
      envelope = await deps.broker.acquire({
        tenantId,
        space: subscription.space,
        subscriptionId: subscription.id,
        requestedUri: subscription.canonicalUri,
        fetchPolicyDecision: fetchDecision,
        // 条件重爬：只在已有成功 revision 时携带（304 走零成本 unchanged 路径）。
        ...(previous?.etag ? { ifNoneMatch: previous.etag } : {}),
        ...(previous?.lastModified ? { ifModifiedSince: previous.lastModified } : {}),
        ...(previous
          ? {
              knownRawHash: previous.rawHash,
              knownNormalizedText: previous.normalizedText,
              knownNormalizedTextHash: previous.normalizedTextHash,
              knownContentType: previous.contentType,
            }
          : {}),
      });
    } catch (error) {
      // 抓取失败（超限/超时/越权 redirect/传输错误）绝不伪造 change：零 revision、零 stale。
      return retryable(run, error instanceof Error ? error.message : String(error));
    }

    const verdict: SourceAdmissionVerdict = decideSourceAdmission(
      { policy, ...(deps.clock === undefined ? {} : { clock: deps.clock }) },
      {
        envelope,
        tenantId,
        space: subscription.space,
        subscriptionId: subscription.id,
        domain: subscription.domainId,
        sourceType: deps.declared.sourceType,
        license: deps.declared.license,
        subscriptionStatus: subscription.status,
      },
    );

    const unchanged =
      verdict.verdict === "reuse-unchanged"
      || (previous !== null && previous.rawHash === envelope.rawHash);

    // ③ unchanged：只落一条 unchanged revision，不产生 candidate、不晋升。
    // P0-6 修复：unchanged/reuse 必须先通过当前 use-policy；verdict=deny（策略过期/撤销/收紧）
    // 时不得返回 unchanged-success——撤出依赖 official 并 dead-letter，quarantine 留审计。
    if (unchanged && previous !== null) {
      if (verdict.verdict === "deny") {
        await withdrawDependents({
          tenantId,
          subscriptionId: subscription.id,
          reason: "policy-revoked",
        });
        return await deadLetter(run, `unchanged recrawl denied by current use-policy [${verdict.denyCodes.join(",")}]: ${verdict.reasons.join("; ")}`);
      }
      const artifact = envelope.notModified
        ? await deps.repository.getArtifactMeta(tenantId, envelope.rawHash)
        : null;
      if (envelope.notModified && !artifact) {
        return retryable(run, `304 unchanged recrawl cannot reuse artifact ${envelope.rawHash}（artifact row missing）`);
      }
      const unchangedRevision = await deps.repository.storeAcquisition({
        tenantId,
        subscriptionId: subscription.id,
        runId: run.id,
        artifact: {
          rawHash: envelope.rawHash,
          byteLength: artifact?.byteLength ?? envelope.byteLength,
          rawBytes: envelope.rawBytes,
          contentType: envelope.headers.contentType || previous.contentType,
        },
        revision: {
          requestedUri: envelope.requestedUri,
          finalUri: envelope.finalUri,
          redirectChain: envelope.redirectChain,
          acquiredAt: envelope.acquiredAt,
          responseStatus: envelope.status,
          contentType: envelope.headers.contentType || previous.contentType,
          ...(envelope.headers.etag === undefined ? {} : { etag: envelope.headers.etag }),
          ...(envelope.headers.lastModified === undefined ? {} : { lastModified: envelope.headers.lastModified }),
          normalizedText: previous.normalizedText,
          normalizedTextHash: previous.normalizedTextHash,
          disposition: "unchanged",
          fetchPolicyDecision: verdict.fetchPolicyDecision,
          previousRevisionId: previous.id,
          derivedFromRevisionId: previous.id,
        },
      });
      await rescheduleSubscription(tenantId, subscription.id, subscription.status === "probing" ? "probing" : "active", {
        nextCrawlAt: new Date(nowOf(deps.clock).getTime() + subscription.recrawlIntervalMs),
      });
      const transitioned = await deps.repository.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "fetch",
        toStage: "complete",
        status: "completed",
        leaseToken: run.leaseToken!,
        leaseGeneration: run.leaseGeneration,
        expectedRowVersion: run.rowVersion,
        principalId: deps.principals.producer,
        executionId: executionIdOf("fetch", run.id),
        outputHash: envelope.rawHash,
        sourceRevisionId: unchangedRevision.id,
      });
      // P0-8 修复：transitionRun 返回 null 表示 CAS 失败（lease 过期/被抢占），
      // 必须抛错让 handler 重试；domain 写（storeAcquisition）在重试时幂等。
      if (!transitioned) {
        throw new IntakeStageRetryableError("fetch", run.id, "unchanged transitionRun CAS failed");
      }
      return {
        runId: run.id,
        stage: "fetch",
        disposition: "unchanged-complete",
        sourceRevisionId: unchangedRevision.id,
      };
    }

    // ④ 外部字节先且只能以 raw-quarantine 落库（append-only；永不原地改写为 admitted）。
    const quarantined = await deps.repository.storeAcquisition({
      tenantId,
      subscriptionId: subscription.id,
      runId: run.id,
      artifact: {
        rawHash: envelope.rawHash,
        byteLength: envelope.byteLength,
        rawBytes: envelope.rawBytes,
        contentType: envelope.headers.contentType,
      },
      revision: {
        requestedUri: envelope.requestedUri,
        finalUri: envelope.finalUri,
        redirectChain: envelope.redirectChain,
        acquiredAt: envelope.acquiredAt,
        responseStatus: envelope.status,
        contentType: envelope.headers.contentType,
        ...(envelope.headers.etag === undefined ? {} : { etag: envelope.headers.etag }),
        ...(envelope.headers.lastModified === undefined ? {} : { lastModified: envelope.headers.lastModified }),
        normalizedText: envelope.normalizedText,
        normalizedTextHash: envelope.normalizedTextHash,
        disposition: verdict.quarantinedDisposition,
        fetchPolicyDecision: verdict.fetchPolicyDecision,
        ...(previous ? { previousRevisionId: previous.id } : {}),
      },
    });

    // ⑤ 未准入：quarantine 保留，不产生 admitted revision，不标 stale（不伪造 change）。
    if (!verdict.mayStoreAdmittedRevision) {
      return {
        ...(await deadLetter(run, `admission denied [${verdict.denyCodes.join(",")}]: ${verdict.reasons.join("; ")}`)),
        sourceRevisionId: quarantined.id,
      };
    }

    const admitted = await deps.repository.storeAcquisition({
      tenantId,
      subscriptionId: subscription.id,
      runId: run.id,
      artifact: {
        rawHash: envelope.rawHash,
        byteLength: envelope.byteLength,
        rawBytes: envelope.rawBytes,
        contentType: envelope.headers.contentType,
      },
      revision: {
        requestedUri: envelope.requestedUri,
        finalUri: envelope.finalUri,
        redirectChain: envelope.redirectChain,
        acquiredAt: envelope.acquiredAt,
        responseStatus: envelope.status,
        contentType: envelope.headers.contentType,
        ...(envelope.headers.etag === undefined ? {} : { etag: envelope.headers.etag }),
        ...(envelope.headers.lastModified === undefined ? {} : { lastModified: envelope.headers.lastModified }),
        normalizedText: envelope.normalizedText,
        normalizedTextHash: envelope.normalizedTextHash,
        disposition: "admitted",
        fetchPolicyDecision: verdict.fetchPolicyDecision,
        usePolicyDecision: verdict.usePolicyDecision,
        derivedFromRevisionId: quarantined.id,
        ...(previous ? { previousRevisionId: previous.id } : {}),
      },
    });

    // ⑥ 变化重爬：**先**把旧 authoritative entry 撤出，再让新 candidate 走 extract/verify/promote。
    let staleEntryIds: readonly string[] = [];
    if (previous !== null && previous.rawHash !== envelope.rawHash) {
      const withdrawn = await withdrawDependents({
        tenantId,
        subscriptionId: subscription.id,
        reason: "source-changed",
        exceptSourceRevisionId: admitted.id,
        supersededByRevisionId: admitted.id,
      });
      staleEntryIds = withdrawn.staleEntryIds;
    }

    const advanced = await deps.repository.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      toStage: "admit",
      status: "queued",
      leaseToken: run.leaseToken!,
      leaseGeneration: run.leaseGeneration,
      expectedRowVersion: run.rowVersion,
      principalId: deps.principals.producer,
      executionId: executionIdOf("fetch", run.id),
      outputHash: envelope.rawHash,
      sourceRevisionId: admitted.id,
      sideEffects: [nextStageEffect(INTAKE_STAGE_OUTBOX_KINDS.extract, run, "admit")],
    });
    if (!advanced) {
      // P0-8 修复：CAS 未命中（lease 过期/被抢占）→ domain 写在重试时幂等，必须抛错回滚。
      throw new IntakeStageRetryableError("fetch", run.id, "fetch admission transitionRun CAS failed");
    }
    return {
      runId: run.id,
      stage: "admit",
      disposition: "advanced",
      nextKind: INTAKE_STAGE_OUTBOX_KINDS.extract,
      sourceRevisionId: admitted.id,
      staleEntryIds,
    };
  }

  // ── stage 2：extract（生产 processor + strict ingestor） ────────────

  async function runExtractStage(payload: unknown): Promise<IntakeStageResult> {
    const { runId, tenantId } = parsePayload(payload);
    const run = await claim(tenantId, runId, "extract", runId);
    if (!run) return { runId, stage: "extract", disposition: "skipped" };
    if (run.stage !== "admit") return releaseUnexpectedStage(run, "admit");

    if (!run.sourceRevisionId) return deadLetter(run, "extract stage requires an admitted source revision on the run");
    const revision = await deps.repository.getRevision(tenantId, run.sourceRevisionId);
    if (!revision) return deadLetter(run, `source revision ${run.sourceRevisionId} is unknown in tenant ${tenantId}`);
    if (revision.disposition !== "admitted") {
      return deadLetter(run, `source revision ${revision.id} is "${revision.disposition}"（only admitted revisions may be extracted）`);
    }
    const subscription = await deps.repository.getSubscription(tenantId, run.subscriptionId);
    if (!subscription) return deadLetter(run, `source subscription ${run.subscriptionId} is unknown in tenant ${tenantId}`);

    const extraction = await deps.extractor.extract({
      runId: run.id,
      executionId: executionIdOf("extract", run.id),
      tenantId,
      space: subscription.space,
      domainId: subscription.domainId,
      revision,
    });
    if (!extraction.ok) return retryable(run, `extractor processor rejected the result: ${extraction.error}`);
    if (extraction.outcome.claims.length === 0) {
      return deadLetter(run, "extractor processor produced no atomic claim for the admitted revision");
    }

    let ingested: Awaited<ReturnType<KnowledgeIngestor["ingest"]>>;
    try {
      ingested = await deps.ingestor.ingest({
        revision,
        claims: extraction.outcome.claims,
        tenantId,
        space: subscription.space,
        domainId: subscription.domainId,
        producer: {
          role: producerRole,
          model: extraction.outcome.model,
          executionId: executionIdOf("extract", run.id),
        },
        principals: deps.principals,
        runId: run.id,
      });
    } catch (error) {
      // evidence 不可信（quote/hash/locator 不符）是 extractor 的产物问题——终态失败，不无限重投。
      return deadLetter(run, `ingest rejected the extracted claims: ${error instanceof Error ? error.message : String(error)}`);
    }

    const advanced = await deps.repository.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "admit",
      toStage: "verify",
      status: "queued",
      leaseToken: run.leaseToken!,
      leaseGeneration: run.leaseGeneration,
      expectedRowVersion: run.rowVersion,
      principalId: deps.principals.producer,
      executionId: executionIdOf("extract", run.id),
      outputHash: ingested.planId,
      candidateId: ingested.candidateId,
      verificationPlanId: ingested.planId,
      sideEffects: [nextStageEffect(INTAKE_STAGE_OUTBOX_KINDS.reviewDomain, run, "verify")],
    });
    if (!advanced) throw new IntakeStageRetryableError("extract", run.id, "extract transitionRun CAS failed");
    return {
      runId: run.id,
      stage: "verify",
      disposition: "advanced",
      nextKind: INTAKE_STAGE_OUTBOX_KINDS.reviewDomain,
      candidateId: ingested.candidateId,
      planId: ingested.planId,
    };
  }

  // ── stage 3/4：domain + adversarial（两个独立 principal/execution） ─

  async function runReviewStage(
    payload: unknown,
    kind: KnowledgeVerdictKind,
  ): Promise<IntakeStageResult> {
    const stageLabel = kind === "domain" ? "review-domain" : "review-adversarial";
    const { runId, tenantId } = parsePayload(payload);
    const run = await claim(tenantId, runId, stageLabel, runId);
    if (!run) return { runId, stage: "verify", disposition: "skipped" };
    if (run.stage !== "verify") return releaseUnexpectedStage(run, "verify");

    if (!run.verificationPlanId || !run.candidateId || !run.sourceRevisionId) {
      return deadLetter(run, `${stageLabel} requires candidateId / verificationPlanId / sourceRevisionId on the run`);
    }
    const plan = await verification.getPlan(run.verificationPlanId, tenantId);
    if (!plan) return deadLetter(run, `verification plan ${run.verificationPlanId} is unknown in tenant ${tenantId}`);
    const entry = await deps.store.get(plan.candidateId, { tenantId });
    if (!entry) return deadLetter(run, `candidate ${plan.candidateId} is unknown in tenant ${tenantId}`);
    const revision = await deps.repository.getRevision(tenantId, run.sourceRevisionId);
    if (!revision) return deadLetter(run, `source revision ${run.sourceRevisionId} is unknown in tenant ${tenantId}`);

    const check = plan.checks.find((c) => c.kind === kind);
    if (!check) return deadLetter(run, `verification plan ${plan.id} has no ${kind} check`);
    const reviewerPrincipal = kind === "domain" ? deps.principals.domainReviewer : deps.principals.adversarialReviewer;

    // 幂等：该 check + principal 的 verdict 已落库 → 不再调用 LLM，直接推进。
    const existing = await verification.listVerdictRows(plan.id, tenantId);
    const already = existing.find((r) => r.checkId === check.checkId && r.principalId === reviewerPrincipal);
    if (!already) {
      const evidence = Array.isArray(entry.meta?.["evidence"]) ? (entry.meta["evidence"] as unknown[]) : [];
      let quotes: string[];
      try {
        quotes = [...(await evidenceQuoteVerifier({ revision, evidence }))];
      } catch (error) {
        return deadLetter(run, error instanceof Error ? error.message : String(error));
      }
      const processor = kind === "domain" ? deps.domainReview : deps.adversarialReview;
      const reviewed = await processor.review({
        runId: run.id,
        executionId: executionIdOf(stageLabel, run.id),
        plan,
        principals: deps.principals,
        candidateContent: entry.content,
        evidence,
        evidenceQuotes: quotes,
      });
      if (!reviewed.ok) return retryable(run, `${kind} review processor rejected the result: ${reviewed.error}`);

      const recorded = await recordKnowledgeVerdict(
        deps.store,
        verification,
        plan.id,
        reviewed.outcome.checkId,
        plan.candidateRevision,
        reviewed.outcome.verdict,
        { principalId: reviewed.outcome.principalId, executionId: reviewed.outcome.executionId },
        { tenantId },
      );
      if (!recorded.ok) return deadLetter(run, `${kind} verdict rejected: ${recorded.error}`);
      if (reviewed.outcome.verdict.verdict === "reject") {
        return deadLetter(run, `${kind} reviewer rejected the candidate: ${reviewed.outcome.verdict.note}`);
      }
    } else if (already.verdict === "reject") {
      return deadLetter(run, `${kind} reviewer already rejected the candidate: ${already.note}`);
    }

    if (kind === "domain") {
      const advanced = await deps.repository.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "verify",
        toStage: "verify",
        status: "queued",
        leaseToken: run.leaseToken!,
        leaseGeneration: run.leaseGeneration,
        expectedRowVersion: run.rowVersion,
        principalId: deps.principals.domainReviewer,
        executionId: executionIdOf(stageLabel, run.id),
        outputHash: plan.candidateHash,
        sideEffects: [nextStageEffect(INTAKE_STAGE_OUTBOX_KINDS.reviewAdversarial, run, "verify")],
      });
      if (!advanced) throw new IntakeStageRetryableError("verify", run.id, "domain review transitionRun CAS failed");
      return {
        runId: run.id,
        stage: "verify",
        disposition: "advanced",
        nextKind: INTAKE_STAGE_OUTBOX_KINDS.reviewAdversarial,
        candidateId: plan.candidateId,
        planId: plan.id,
      };
    }

    // adversarial 之后：plan 必须 satisfied 才允许进入 promote（否则终态失败）。
    let refreshed = await verification.getPlan(plan.id, tenantId);
    if (refreshed && refreshed.status !== "satisfied") {
      // 崩溃窗口（verdict 已写、plan status 未刷新）用生产判据补齐一次。
      const rows = await verification.listVerdictRows(plan.id, tenantId);
      const producerFromMeta = (entry.meta?.["provenance"] as { producerRole?: unknown } | undefined)?.producerRole;
      const decision = evaluatePlanVerdicts(
        refreshed,
        rows,
        typeof producerFromMeta === "string" ? producerFromMeta : undefined,
      );
      if (decision.ok) {
        await verification.setPlanStatus(plan.id, tenantId, "satisfied");
        refreshed = await verification.getPlan(plan.id, tenantId);
      }
    }
    if (!refreshed || refreshed.status !== "satisfied") {
      return deadLetter(run, `verification plan ${plan.id} is "${refreshed?.status ?? "missing"}"（domain + adversarial must both pass）`);
    }

    const advanced = await deps.repository.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "verify",
      toStage: "promote",
      status: "queued",
      leaseToken: run.leaseToken!,
      leaseGeneration: run.leaseGeneration,
      expectedRowVersion: run.rowVersion,
      principalId: deps.principals.adversarialReviewer,
      executionId: executionIdOf(stageLabel, run.id),
      outputHash: refreshed.candidateHash,
      sideEffects: [nextStageEffect(INTAKE_STAGE_OUTBOX_KINDS.promote, run, "promote")],
    });
    if (!advanced) throw new IntakeStageRetryableError("verify", run.id, "domain review transitionRun CAS failed");
    return {
      runId: run.id,
      stage: "promote",
      disposition: "advanced",
      nextKind: INTAKE_STAGE_OUTBOX_KINDS.promote,
      candidateId: refreshed.candidateId,
      planId: refreshed.id,
    };
  }

  // ── stage 5：promote（exact hash 原子晋升 + supersedes 关系） ────────

  async function runPromoteStage(payload: unknown): Promise<IntakeStageResult> {
    const { runId, tenantId } = parsePayload(payload);
    const run = await claim(tenantId, runId, "promote", runId);
    if (!run) return { runId, stage: "promote", disposition: "skipped" };
    if (run.stage !== "promote") return releaseUnexpectedStage(run, "promote");

    if (!run.verificationPlanId || !run.candidateId || !run.sourceRevisionId) {
      return deadLetter(run, "promote stage requires candidateId / verificationPlanId / sourceRevisionId on the run");
    }
    const plan = await verification.getPlan(run.verificationPlanId, tenantId);
    if (!plan) return deadLetter(run, `verification plan ${run.verificationPlanId} is unknown in tenant ${tenantId}`);
    const subscription = await deps.repository.getSubscription(tenantId, run.subscriptionId);
    if (!subscription) return deadLetter(run, `source subscription ${run.subscriptionId} is unknown in tenant ${tenantId}`);

    const promoted = await promoteKnowledgeEntry(
      deps.store,
      verification,
      plan.candidateId,
      plan.id,
      plan.candidateRevision,
      { principalId: deps.principals.promoter, executionId: executionIdOf("promote", run.id) },
      { tenantId, promoterRole, intakeBinding: recheck, note: `intake run ${run.id}` },
    );
    if (!promoted.ok) return deadLetter(run, `promotion refused: ${promoted.error}`);

    // official ← revision 的依赖边（重爬时据此定位需要撤出的 authoritative entry）。
    await deps.repository.recordDependency({
      tenantId,
      subscriptionId: subscription.id,
      sourceRevisionId: run.sourceRevisionId,
      dependentKind: "knowledge-entry",
      dependentId: plan.candidateId,
      dependentRevision: plan.candidateRevision + 1,
      space: subscription.space,
      evidenceDigest: plan.sourceBindingsDigest,
    });

    // supersedes 关系显式双向（G7：V2 official 明确 supersedes V1）。
    const superseded = (await deps.repository.listDependencies(tenantId, subscription.id))
      .filter((d) => d.stale && d.dependentKind === "knowledge-entry" && d.dependentId !== plan.candidateId)
      .map((d) => d.dependentId);
    const supersedes = [...new Set(superseded)].sort();
    if (supersedes.length > 0) {
      const current = await deps.store.get(plan.candidateId, { tenantId });
      const existing = Array.isArray(current?.meta?.["supersedes"]) ? (current!.meta["supersedes"] as unknown[]) : [];
      if (JSON.stringify(existing) !== JSON.stringify(supersedes)) {
        await deps.store.update(
          plan.candidateId,
          { meta: { supersedes } },
          { tenantId, createdBy: promoterRole, reason: "intake-supersedes" },
        );
      }
      for (const staleId of supersedes) {
        const stale: MemoryEntry | undefined = await deps.store.get(staleId, { tenantId });
        if (!stale || stale.meta?.["supersededBy"] === plan.candidateId) continue;
        await deps.store.update(
          staleId,
          { meta: { supersededBy: plan.candidateId } },
          { tenantId, createdBy: promoterRole, reason: "intake-superseded-by" },
        );
      }
    }

    // probing → active（首轮成功即转正）；记录 lastSuccessfulRevisionId 并推进 nextCrawlAt。
    await rescheduleSubscription(tenantId, subscription.id, "active", {
      nextCrawlAt: new Date(nowOf(deps.clock).getTime() + subscription.recrawlIntervalMs),
      lastSuccessfulRevisionId: run.sourceRevisionId,
    });

    const completed = await deps.repository.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "promote",
      toStage: "complete",
      status: "completed",
      leaseToken: run.leaseToken!,
      leaseGeneration: run.leaseGeneration,
      expectedRowVersion: run.rowVersion,
      principalId: deps.principals.promoter,
      executionId: executionIdOf("promote", run.id),
      outputHash: plan.candidateHash,
    });
    if (!completed) throw new IntakeStageRetryableError("promote", run.id, "promote transitionRun CAS failed");
    return {
      runId: run.id,
      stage: "complete",
      disposition: "completed",
      candidateId: plan.candidateId,
      planId: plan.id,
      sourceRevisionId: run.sourceRevisionId,
      ...(supersedes.length > 0 ? { staleEntryIds: supersedes } : {}),
    };
  }

  // ── 撤销 ───────────────────────────────────────────────────────────

  async function revokeSubscription(input: RevokeSubscriptionInput): Promise<RevokeSubscriptionResult> {
    const withdrawn = await withdrawDependents({
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      reason: input.reason,
    });
    // revoked / paused 都不在 due 扫描状态集合内 → 重爬立即停止。
    const subscription = await rescheduleSubscription(
      input.tenantId,
      input.subscriptionId,
      input.toStatus ?? "revoked",
    );
    return { subscription, ...withdrawn };
  }

  return {
    subscribe: (input) => subscriptions.subscribe(input),
    runFetchStage,
    runExtractStage,
    runDomainReviewStage: (payload) => runReviewStage(payload, "domain"),
    runAdversarialReviewStage: (payload) => runReviewStage(payload, "adversarial"),
    runPromoteStage,
    revokeSubscription,
    stageHandlers() {
      return {
        [INTAKE_STAGE_OUTBOX_KINDS.fetch]: async (payload: unknown) => {
          await runFetchStage(payload);
        },
        [INTAKE_STAGE_OUTBOX_KINDS.extract]: async (payload: unknown) => {
          await runExtractStage(payload);
        },
        [INTAKE_STAGE_OUTBOX_KINDS.reviewDomain]: async (payload: unknown) => {
          await runReviewStage(payload, "domain");
        },
        [INTAKE_STAGE_OUTBOX_KINDS.reviewAdversarial]: async (payload: unknown) => {
          await runReviewStage(payload, "adversarial");
        },
        [INTAKE_STAGE_OUTBOX_KINDS.promote]: async (payload: unknown) => {
          await runPromoteStage(payload);
        },
      };
    },
  };
}
