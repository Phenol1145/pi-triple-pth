/**
 * intake-promote-stage.ts —— knowledge-intake stage 5：promote（exact hash 原子晋升 + supersedes 关系）。
 */
import type { MemoryEntry } from "@away_from/pth-memory";
import { IntakeStageRetryableError, IntakeStageResult } from "./intake-shared.js";
import { promoteKnowledgeEntry } from "../knowledge-promotion.js";
import type { IntakeStageContext } from "./stage-context.js";

export async function runPromoteStage(ctx: IntakeStageContext, payload: unknown): Promise<IntakeStageResult> {
  const { deps } = ctx;
  const { runId, tenantId } = ctx.parsePayload(payload);
  const run = await ctx.claim(tenantId, runId, "promote", runId);
  if (!run) return { runId, stage: "promote", disposition: "skipped" };
  if (run.stage !== "promote") return ctx.releaseUnexpectedStage(run, "promote");

  if (!run.verificationPlanId || !run.candidateId || !run.sourceRevisionId) {
    return ctx.deadLetter(run, "promote stage requires candidateId / verificationPlanId / sourceRevisionId on the run");
  }
  const plan = await ctx.verification.getPlan(run.verificationPlanId, tenantId);
  if (!plan) return ctx.deadLetter(run, `verification plan ${run.verificationPlanId} is unknown in tenant ${tenantId}`);
  const subscription = await deps.repository.getSubscription(tenantId, run.subscriptionId);
  if (!subscription) return ctx.deadLetter(run, `source subscription ${run.subscriptionId} is unknown in tenant ${tenantId}`);

  const promoted = await promoteKnowledgeEntry(
    deps.store,
    ctx.verification,
    plan.candidateId,
    plan.id,
    plan.candidateRevision,
    { principalId: deps.principals.promoter, executionId: ctx.executionIdOf("promote", run.id) },
    { tenantId, promoterRole: ctx.promoterRole, intakeBinding: ctx.recheck, note: `intake run ${run.id}` },
  );
  if (!promoted.ok) return ctx.deadLetter(run, `promotion refused: ${promoted.error}`);

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
        { tenantId, createdBy: ctx.promoterRole, reason: "intake-supersedes" },
      );
    }
    for (const staleId of supersedes) {
      const stale: MemoryEntry | undefined = await deps.store.get(staleId, { tenantId });
      if (!stale || stale.meta?.["supersededBy"] === plan.candidateId) continue;
      await deps.store.update(
        staleId,
        { meta: { supersededBy: plan.candidateId } },
        { tenantId, createdBy: ctx.promoterRole, reason: "intake-superseded-by" },
      );
    }
  }

  // probing → active（首轮成功即转正）；记录 lastSuccessfulRevisionId 并推进 nextCrawlAt。
  await ctx.rescheduleSubscription(tenantId, subscription.id, "active", {
    nextCrawlAt: new Date(ctx.now().getTime() + subscription.recrawlIntervalMs),
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
    executionId: ctx.executionIdOf("promote", run.id),
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
