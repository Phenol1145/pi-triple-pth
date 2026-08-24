/**
 * intake-extract-stage.ts —— knowledge-intake stage 2：extract（生产 processor + strict ingestor）。
 */
import { IntakeStageRetryableError, IntakeStageResult } from "./intake-shared.js";
import type { IntakeStageContext } from "./stage-context.js";

export async function runExtractStage(ctx: IntakeStageContext, payload: unknown): Promise<IntakeStageResult> {
  const { deps } = ctx;
  const { runId, tenantId } = ctx.parsePayload(payload);
  const run = await ctx.claim(tenantId, runId, "extract", runId);
  if (!run) return { runId, stage: "extract", disposition: "skipped" };
  if (run.stage !== "admit") return ctx.releaseUnexpectedStage(run, "admit");

  if (!run.sourceRevisionId) return ctx.deadLetter(run, "extract stage requires an admitted source revision on the run");
  const revision = await deps.repository.getRevision(tenantId, run.sourceRevisionId);
  if (!revision) return ctx.deadLetter(run, `source revision ${run.sourceRevisionId} is unknown in tenant ${tenantId}`);
  if (revision.disposition !== "admitted") {
    return ctx.deadLetter(run, `source revision ${revision.id} is "${revision.disposition}"（only admitted revisions may be extracted）`);
  }
  const subscription = await deps.repository.getSubscription(tenantId, run.subscriptionId);
  if (!subscription) return ctx.deadLetter(run, `source subscription ${run.subscriptionId} is unknown in tenant ${tenantId}`);

  const extraction = await deps.extractor.extract({
    runId: run.id,
    executionId: ctx.executionIdOf("extract", run.id),
    tenantId,
    space: subscription.space,
    domainId: subscription.domainId,
    revision,
  });
  if (!extraction.ok) return ctx.retryable(run, `extractor processor rejected the result: ${extraction.error}`);
  if (extraction.outcome.claims.length === 0) {
    return ctx.deadLetter(run, "extractor processor produced no atomic claim for the admitted revision");
  }

  let ingested: Awaited<ReturnType<typeof deps.ingestor.ingest>>;
  try {
    ingested = await deps.ingestor.ingest({
      revision,
      claims: extraction.outcome.claims,
      tenantId,
      space: subscription.space,
      domainId: subscription.domainId,
      producer: {
        role: ctx.producerRole,
        model: extraction.outcome.model,
        executionId: ctx.executionIdOf("extract", run.id),
      },
      principals: deps.principals,
      runId: run.id,
    });
  } catch (error) {
    // evidence 不可信（quote/hash/locator 不符）是 extractor 的产物问题——终态失败，不无限重投。
    return ctx.deadLetter(run, `ingest rejected the extracted claims: ${error instanceof Error ? error.message : String(error)}`);
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
    executionId: ctx.executionIdOf("extract", run.id),
    outputHash: ingested.planId,
    candidateId: ingested.candidateId,
    verificationPlanId: ingested.planId,
    sideEffects: [ctx.nextStageEffect(ctx.outboxKinds.reviewDomain, run, "verify")],
  });
  if (!advanced) throw new IntakeStageRetryableError("extract", run.id, "extract transitionRun CAS failed");
  return {
    runId: run.id,
    stage: "verify",
    disposition: "advanced",
    nextKind: ctx.outboxKinds.reviewDomain,
    candidateId: ingested.candidateId,
    planId: ingested.planId,
  };
}
