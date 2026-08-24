/**
 * stage-context.ts —— knowledge-intake 内环 stage 公共上下文与装配。
 *
 * 收敛 service 闭包内的 claim/deadLetter/retryable/withdrawDependents 等编排原语，
 * 让 fetch/extract/review/promote 阶段可独立成模块而保持同一套 CAS/事务语义。
 */
import { withTx, enqueueSideEffectInTx } from "@away_from/pth-kernel-storage";
import { createPgKnowledgeVerificationRepo, type KnowledgeVerificationRepo } from "../knowledge-promotion.js";
import { createIntakeSourceBindingRecheck } from "./knowledge-ingestor.js";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  DEFAULT_PRODUCER_ROLE,
  DEFAULT_PROMOTER_ROLE,
  INTAKE_STAGE_OUTBOX_KINDS,
  IntakeStageOutboxKind,
  IntakeStageRetryableError,
  KnowledgeIntakeServiceDeps,
  KnowledgeIntakeSubscriptionService,
  IntakeStagePayload,
  IntakeStageResult,
  IntakeSideEffect,
  IntakeRun,
  MarkDependentsStaleInput,
  PROMOTION_AUTHORITY,
  SourceSubscription,
  SubscriptionStatus,
  EvidenceQuoteVerifier,
  selectEvidenceQuoteVerifier,
  nowOf,
  parsePayload,
  resolvePolicy,
} from "./intake-shared.js";
import { createKnowledgeIntakeSubscriptionService } from "./intake-shared.js";

export interface IntakeStageContext {
  readonly deps: KnowledgeIntakeServiceDeps;
  readonly verification: KnowledgeVerificationRepo;
  readonly producerRole: string;
  readonly promoterRole: string;
  readonly subscriptions: KnowledgeIntakeSubscriptionService;
  readonly recheck: ReturnType<typeof createIntakeSourceBindingRecheck>;
  readonly evidenceQuoteVerifier: EvidenceQuoteVerifier;
  readonly outboxKinds: typeof INTAKE_STAGE_OUTBOX_KINDS;
  readonly activeSubscriptionStatuses: readonly SubscriptionStatus[];
  executionIdOf(stage: string, runId: string): string;
  nextStageEffect(kind: IntakeStageOutboxKind, run: IntakeRun, stage: IntakeRun["stage"]): IntakeSideEffect;
  parsePayload(payload: unknown): IntakeStagePayload;
  now(): Date;
  claim(tenantId: string, runId: string, stage: string, inputHash: string): Promise<IntakeRun | null>;
  deadLetter(run: IntakeRun, error: string): Promise<IntakeStageResult>;
  retryable(run: IntakeRun, error: string): Promise<never>;
  releaseUnexpectedStage(run: IntakeRun, expected: IntakeRun["stage"]): Promise<IntakeStageResult>;
  rescheduleSubscription(
    tenantId: string,
    subscriptionId: string,
    toStatus: SubscriptionStatus,
    opts?: { nextCrawlAt?: Date; lastSuccessfulRevisionId?: string },
  ): Promise<SourceSubscription | null>;
  withdrawDependents(input: {
    tenantId: string;
    subscriptionId: string;
    reason: MarkDependentsStaleInput["reason"];
    exceptSourceRevisionId?: string;
    supersededByRevisionId?: string;
  }): Promise<{ staleEntryIds: readonly string[]; staleDependentIds: readonly string[] }>;
}

export function createIntakeStageContext(deps: KnowledgeIntakeServiceDeps): IntakeStageContext {
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
    stage: IntakeRun["stage"],
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
  async function releaseUnexpectedStage(run: IntakeRun, expected: IntakeRun["stage"]): Promise<IntakeStageResult> {
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
   * ① 依赖边 stale（可排除新 revision）→ ② 旧 official 知识条目 stale
   * → ③ dependency refresh outbox。任一步失败即整体回滚（不留半撤出状态）。
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

  return {
    deps,
    verification,
    producerRole,
    promoterRole,
    subscriptions,
    recheck,
    evidenceQuoteVerifier,
    outboxKinds: INTAKE_STAGE_OUTBOX_KINDS,
    activeSubscriptionStatuses: ACTIVE_SUBSCRIPTION_STATUSES,
    executionIdOf,
    nextStageEffect,
    parsePayload,
    now: () => nowOf(deps.clock),
    claim,
    deadLetter,
    retryable,
    releaseUnexpectedStage,
    rescheduleSubscription,
    withdrawDependents,
  };
}
