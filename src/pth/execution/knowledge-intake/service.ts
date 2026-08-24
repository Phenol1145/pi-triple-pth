/**
 * knowledge-intake/service.ts — N29 Task 6：知识摄入内环状态机（application service）。
 *
 * 定位（plan §4 / §5 Task 6）：本文件只做状态迁移与编排装配；各阶段实现已按
 * fetch/extract/review/promote 拆到 intake-*-stage.ts，公共编排原语在 stage-context.ts，
 * 共享类型/常量/校验在 intake-shared.ts。
 */
export * from "./intake-shared.js";
import { createIntakeStageContext } from "./stage-context.js";
import { runFetchStage } from "./intake-fetch-stage.js";
import { runExtractStage } from "./intake-extract-stage.js";
import { runReviewStage } from "./intake-review-stage.js";
import { runPromoteStage } from "./intake-promote-stage.js";
import type { KnowledgeIntakeService, KnowledgeIntakeServiceDeps, RevokeSubscriptionInput } from "./intake-shared.js";

export function createKnowledgeIntakeService(deps: KnowledgeIntakeServiceDeps): KnowledgeIntakeService {
  const ctx = createIntakeStageContext(deps);

  async function revokeSubscription(input: RevokeSubscriptionInput) {
    const withdrawn = await ctx.withdrawDependents({
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      reason: input.reason,
    });
    // revoked / paused 都不在 due 扫描状态集合内 → 重爬立即停止。
    const subscription = await ctx.rescheduleSubscription(
      input.tenantId,
      input.subscriptionId,
      input.toStatus ?? "revoked",
    );
    return { subscription, ...withdrawn };
  }

  return {
    subscribe: (input) => ctx.subscriptions.subscribe(input),
    runFetchStage: (payload) => runFetchStage(ctx, payload),
    runExtractStage: (payload) => runExtractStage(ctx, payload),
    runDomainReviewStage: (payload) => runReviewStage(ctx, payload, "domain"),
    runAdversarialReviewStage: (payload) => runReviewStage(ctx, payload, "adversarial"),
    runPromoteStage: (payload) => runPromoteStage(ctx, payload),
    revokeSubscription,
    stageHandlers() {
      return {
        [ctx.outboxKinds.fetch]: async (payload: unknown) => {
          await runFetchStage(ctx, payload);
        },
        [ctx.outboxKinds.extract]: async (payload: unknown) => {
          await runExtractStage(ctx, payload);
        },
        [ctx.outboxKinds.reviewDomain]: async (payload: unknown) => {
          await runReviewStage(ctx, payload, "domain");
        },
        [ctx.outboxKinds.reviewAdversarial]: async (payload: unknown) => {
          await runReviewStage(ctx, payload, "adversarial");
        },
        [ctx.outboxKinds.promote]: async (payload: unknown) => {
          await runPromoteStage(ctx, payload);
        },
      };
    },
  };
}
