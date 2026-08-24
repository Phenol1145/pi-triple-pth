/**
 * intake-fetch-stage.ts —— knowledge-intake stage 1：fetch + admission + unchanged/changed 分流。
 */
import { IntakeStageRetryableError, resolvePolicy } from "./intake-shared.js";
import type { IntakeStageResult, PolicyBoundSourceAcquisitionEnvelope } from "./intake-shared.js";
import { decideSourceAdmission, type SourceAdmissionVerdict } from "./admission.js";
import type { IntakeStageContext } from "./stage-context.js";

export async function runFetchStage(ctx: IntakeStageContext, payload: unknown): Promise<IntakeStageResult> {
  const { deps } = ctx;
  const { runId, tenantId } = ctx.parsePayload(payload);
  const run = await ctx.claim(tenantId, runId, "fetch", runId);
  if (!run) return { runId, stage: "fetch", disposition: "skipped" };
  if (run.stage !== "fetch") return ctx.releaseUnexpectedStage(run, "fetch");

  const subscription = await deps.repository.getSubscription(tenantId, run.subscriptionId);
  if (!subscription) {
    return ctx.deadLetter(run, `source subscription ${run.subscriptionId} is unknown in tenant ${tenantId}`);
  }
  // ① 订阅撤销/暂停/退役：撤出依赖并停止重爬（不抓取、不伪造 change）。
  if (!ctx.activeSubscriptionStatuses.includes(subscription.status)) {
    const withdrawn = await ctx.withdrawDependents({
      tenantId,
      subscriptionId: subscription.id,
      reason: "subscription-revoked",
    });
    return {
      ...(await ctx.deadLetter(run, `subscription status "${subscription.status}" does not allow crawling`)),
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
    const withdrawn = await ctx.withdrawDependents({
      tenantId,
      subscriptionId: subscription.id,
      reason: "policy-revoked",
    });
    await ctx.rescheduleSubscription(tenantId, subscription.id, "paused");
    return {
      ...(await ctx.deadLetter(run, `current trust policy no longer authorizes fetch: ${fetchDecision.reason}`)),
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
    return ctx.retryable(run, error instanceof Error ? error.message : String(error));
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
      await ctx.withdrawDependents({
        tenantId,
        subscriptionId: subscription.id,
        reason: "policy-revoked",
      });
      return await ctx.deadLetter(run, `unchanged recrawl denied by current use-policy [${verdict.denyCodes.join(",")}]: ${verdict.reasons.join("; ")}`);
    }
    const artifact = envelope.notModified
      ? await deps.repository.getArtifactMeta(tenantId, envelope.rawHash)
      : null;
    if (envelope.notModified && !artifact) {
      return ctx.retryable(run, `304 unchanged recrawl cannot reuse artifact ${envelope.rawHash}（artifact row missing）`);
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
    await ctx.rescheduleSubscription(tenantId, subscription.id, subscription.status === "probing" ? "probing" : "active", {
      nextCrawlAt: new Date(ctx.now().getTime() + subscription.recrawlIntervalMs),
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
      executionId: ctx.executionIdOf("fetch", run.id),
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
      ...(await ctx.deadLetter(run, `admission denied [${verdict.denyCodes.join(",")}]: ${verdict.reasons.join("; ")}`)),
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
    const withdrawn = await ctx.withdrawDependents({
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
    executionId: ctx.executionIdOf("fetch", run.id),
    outputHash: envelope.rawHash,
    sourceRevisionId: admitted.id,
    sideEffects: [ctx.nextStageEffect(ctx.outboxKinds.extract, run, "admit")],
  });
  if (!advanced) {
    // P0-8 修复：CAS 未命中（lease 过期/被抢占）→ domain 写在重试时幂等，必须抛错回滚。
    throw new IntakeStageRetryableError("fetch", run.id, "fetch admission transitionRun CAS failed");
  }
  return {
    runId: run.id,
    stage: "admit",
    disposition: "advanced",
    nextKind: ctx.outboxKinds.extract,
    sourceRevisionId: admitted.id,
    staleEntryIds,
  };
}
