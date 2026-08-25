/**
 * execution/plan-implementation.ts —— W2：modification-plan official 事件 → 实施任务派生器。
 *
 * 按 implementation.kind 路由：
 *  - param-change / storage-cleanup → actuator 实施任务（携 plan grant + planHash）
 *  - code-fix → developer 实施任务
 *  - role-register → 治理面系统件，不派任务（注册生效路径由审批面直接完成）
 */

import { validateModificationPlanContent } from "./plan-grant.js";

export interface PlanImplementationPublishInput {
  title: string;
  text: string;
  createdBy: string;
  tags?: string[];
  payload?: unknown;
}

export interface PlanImplementationDeriverDeps {
  memory: {
    get(id: string): Promise<{ content: string; meta?: Record<string, unknown> } | undefined>;
  };
  publish(input: PlanImplementationPublishInput): Promise<{ id: string }>;
  log?: (msg: string) => void;
}

export type PlanImplementationDeriver = (planId: string) => Promise<{ published: number }>;

export function createPlanImplementationDeriver(deps: PlanImplementationDeriverDeps): PlanImplementationDeriver {
  return async (planId: string) => {
    const entry = await deps.memory.get(planId);
    if (!entry) {
      deps.log?.(`[plan-implementation] 方案不存在：${planId}`);
      return { published: 0 };
    }
    let content: unknown;
    try {
      content = JSON.parse(String(entry.content ?? "{}"));
    } catch {
      deps.log?.(`[plan-implementation] 方案内容非法 JSON：${planId}`);
      return { published: 0 };
    }
    const parsed = validateModificationPlanContent(content);
    if (!parsed.ok) {
      deps.log?.(`[plan-implementation] 方案 schema 校验失败：${planId}（${parsed.error}）`);
      return { published: 0 };
    }
    const planHash = parsed.plan.planHash;
    const meta = (entry.meta ?? {}) as Record<string, unknown>;
    const planGrant = meta["planGrant"];
    if (!planGrant) {
      deps.log?.(`[plan-implementation] 方案缺少 planGrant：${planId}`);
      return { published: 0 };
    }
    const kind = parsed.plan.implementation.kind;
    // role-register：治理面系统件，不走任务派生（注册生效路径由审批面直接完成）
    if (kind === "role-register") return { published: 0 };
    const role = kind === "code-fix" ? "developer" : "actuator";
    const title = `实施 modification-plan ${planHash.slice(0, 8)}（${kind}）`;
    const text = [
      `按已批准方案实施。implementation.kind=${kind}；planHash=${planHash}。`,
      `完成后 done.result 必须携带 planHash（与上方一致），否则服务端拒绝。`,
      ``,
      `【方案变更内容】${parsed.plan.changes}`,
      `【回滚条件】${parsed.plan.rollback}`,
      `【复测窗口】${parsed.plan.retestWindow}`,
    ].join("\n");
    await deps.publish({
      title,
      text,
      createdBy: "trigger:modification-plan-implementation",
      tags: [],
      payload: {
        flow: { stages: [{ task: { role } }] },
        implementationPlanHash: planHash,
        planGrant,
        planId,
      },
    });
    return { published: 1 };
  };
}
