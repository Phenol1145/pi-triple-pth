/**
 * intake-review-stage.ts —— knowledge-intake stage 3/4：domain + adversarial review。
 */
import { IntakeStageRetryableError, IntakeStageResult } from "./intake-shared.js";
import type { KnowledgeVerdictKind } from "../knowledge-verdicts.js";
import { evaluatePlanVerdicts } from "../knowledge-verdicts.js";
import { recordKnowledgeVerdict } from "../knowledge-promotion.js";
import type { IntakeStageContext } from "./stage-context.js";

export async function runReviewStage(
  ctx: IntakeStageContext,
  payload: unknown,
  kind: KnowledgeVerdictKind,
): Promise<IntakeStageResult> {
  const { deps } = ctx;
  const stageLabel = kind === "domain" ? "review-domain" : "review-adversarial";
  const { runId, tenantId } = ctx.parsePayload(payload);
  const run = await ctx.claim(tenantId, runId, stageLabel, runId);
  if (!run) return { runId, stage: "verify", disposition: "skipped" };
  if (run.stage !== "verify") return ctx.releaseUnexpectedStage(run, "verify");

  if (!run.verificationPlanId || !run.candidateId || !run.sourceRevisionId) {
    return ctx.deadLetter(run, `${stageLabel} requires candidateId / verificationPlanId / sourceRevisionId on the run`);
  }
  const plan = await ctx.verification.getPlan(run.verificationPlanId, tenantId);
  if (!plan) return ctx.deadLetter(run, `verification plan ${run.verificationPlanId} is unknown in tenant ${tenantId}`);
  const entry = await deps.store.get(plan.candidateId, { tenantId });
  if (!entry) return ctx.deadLetter(run, `candidate ${plan.candidateId} is unknown in tenant ${tenantId}`);
  const revision = await deps.repository.getRevision(tenantId, run.sourceRevisionId);
  if (!revision) return ctx.deadLetter(run, `source revision ${run.sourceRevisionId} is unknown in tenant ${tenantId}`);

  const check = plan.checks.find((c) => c.kind === kind);
  if (!check) return ctx.deadLetter(run, `verification plan ${plan.id} has no ${kind} check`);
  const reviewerPrincipal = kind === "domain" ? deps.principals.domainReviewer : deps.principals.adversarialReviewer;

  // 幂等：该 check + principal 的 verdict 已落库 → 不再调用 LLM，直接推进。
  const existing = await ctx.verification.listVerdictRows(plan.id, tenantId);
  const already = existing.find((r) => r.checkId === check.checkId && r.principalId === reviewerPrincipal);
  if (!already) {
    const evidence = Array.isArray(entry.meta?.["evidence"]) ? (entry.meta["evidence"] as unknown[]) : [];
    let quotes: string[];
    try {
      quotes = [...(await ctx.evidenceQuoteVerifier({ revision, evidence }))];
    } catch (error) {
      return ctx.deadLetter(run, error instanceof Error ? error.message : String(error));
    }
    const processor = kind === "domain" ? deps.domainReview : deps.adversarialReview;
    const reviewed = await processor.review({
      runId: run.id,
      executionId: ctx.executionIdOf(stageLabel, run.id),
      plan,
      principals: deps.principals,
      candidateContent: entry.content,
      evidence,
      evidenceQuotes: quotes,
    });
    if (!reviewed.ok) return ctx.retryable(run, `${kind} review processor rejected the result: ${reviewed.error}`);

    const recorded = await recordKnowledgeVerdict(
      deps.store,
      ctx.verification,
      plan.id,
      reviewed.outcome.checkId,
      plan.candidateRevision,
      reviewed.outcome.verdict,
      { principalId: reviewed.outcome.principalId, executionId: reviewed.outcome.executionId },
      { tenantId },
    );
    if (!recorded.ok) return ctx.deadLetter(run, `${kind} verdict rejected: ${recorded.error}`);
    if (reviewed.outcome.verdict.verdict === "reject") {
      return ctx.deadLetter(run, `${kind} reviewer rejected the candidate: ${reviewed.outcome.verdict.note}`);
    }
  } else if (already.verdict === "reject") {
    return ctx.deadLetter(run, `${kind} reviewer already rejected the candidate: ${already.note}`);
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
      executionId: ctx.executionIdOf(stageLabel, run.id),
      outputHash: plan.candidateHash,
      sideEffects: [ctx.nextStageEffect(ctx.outboxKinds.reviewAdversarial, run, "verify")],
    });
    if (!advanced) throw new IntakeStageRetryableError("verify", run.id, "domain review transitionRun CAS failed");
    return {
      runId: run.id,
      stage: "verify",
      disposition: "advanced",
      nextKind: ctx.outboxKinds.reviewAdversarial,
      candidateId: plan.candidateId,
      planId: plan.id,
    };
  }

  // adversarial 之后：plan 必须 satisfied 才允许进入 promote（否则终态失败）。
  let refreshed = await ctx.verification.getPlan(plan.id, tenantId);
  if (refreshed && refreshed.status !== "satisfied") {
    // 崩溃窗口（verdict 已写、plan status 未刷新）用生产判据补齐一次。
    const rows = await ctx.verification.listVerdictRows(plan.id, tenantId);
    const producerFromMeta = (entry.meta?.["provenance"] as { producerRole?: unknown } | undefined)?.producerRole;
    const decision = evaluatePlanVerdicts(
      refreshed,
      rows,
      typeof producerFromMeta === "string" ? producerFromMeta : undefined,
    );
    if (decision.ok) {
      await ctx.verification.setPlanStatus(plan.id, tenantId, "satisfied");
      refreshed = await ctx.verification.getPlan(plan.id, tenantId);
    }
  }
  if (!refreshed || refreshed.status !== "satisfied") {
    return ctx.deadLetter(run, `verification plan ${plan.id} is "${refreshed?.status ?? "missing"}"（domain + adversarial must both pass）`);
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
    executionId: ctx.executionIdOf(stageLabel, run.id),
    outputHash: refreshed.candidateHash,
    sideEffects: [ctx.nextStageEffect(ctx.outboxKinds.promote, run, "promote")],
  });
  if (!advanced) throw new IntakeStageRetryableError("verify", run.id, "domain review transitionRun CAS failed");
  return {
    runId: run.id,
    stage: "promote",
    disposition: "advanced",
    nextKind: ctx.outboxKinds.promote,
    candidateId: refreshed.candidateId,
    planId: refreshed.id,
  };
}
