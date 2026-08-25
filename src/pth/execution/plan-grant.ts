/**
 * execution/plan-grant.ts —— W2 三源重构：modification-plan 的 schema 校验 + plan grant。
 *
 * plan grant 复用 N28 ExecutionGrantService：以 `workspace.workspaceId = "plan:<sha256>"`
 * 编码方案作用域，capabilities 携带 `plan.execute`。批准 modification-plan 时签发，
 * 实施任务与即时生效工具（manage.params.set / scheme.apply / manual tool 直写）校验同一 grant。
 */

import { createHash, randomUUID } from "node:crypto";
import type { ExecutionGrant, TenantScope } from "@away_from/pth-contracts";
import type { ExecutionGrantService } from "./authorization/execution-grant-service.js";

export const PLAN_GRANT_CAPABILITY = "plan.execute" as const;
export const PLAN_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export function planScope(planHash: string): string {
  return `plan:${planHash}`;
}

/** 稳定序列化（键排序——与 ExecutionGrant canonical 同思路；用于 planHash 与 schema 校验） */
function stableStringify(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = stable((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(stable(value));
}

export function hashPlanContent(content: unknown): string {
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

export interface ModificationPlanImplementation {
  kind: "param-change" | "code-fix" | "storage-cleanup" | "role-register" | (string & {});
  routeHint?: string;
}

export interface ParsedModificationPlan {
  planHash: string;
  goal: string;
  changes: string;
  expected: string;
  rollback: string;
  retestWindow: string;
  implementation: ModificationPlanImplementation;
}

const PLAN_IMPL_KINDS = new Set(["param-change", "code-fix", "storage-cleanup", "role-register"]);

/** modification-plan 审批 schema 校验（W2——审批闸处强制）。 */
export function validateModificationPlanContent(content: unknown): { ok: true; plan: ParsedModificationPlan } | { ok: false; error: string } {
  const c = (content ?? {}) as Record<string, unknown>;
  const requireString = (key: string): string | null => {
    const v = c[key];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  };
  const goal = requireString("goal");
  const changes = requireString("changes");
  const expected = requireString("expected");
  const rollback = requireString("rollback");
  const retestWindow = requireString("retestWindow");
  if (!goal || !changes || !expected || !rollback || !retestWindow) {
    return { ok: false, error: "modification-plan 必填字段缺失：goal/changes/expected/rollback/retestWindow" };
  }
  const impl = c["implementation"] as Record<string, unknown> | undefined;
  if (!impl || typeof impl !== "object") {
    return { ok: false, error: "modification-plan 缺少 implementation（实施路由声明）" };
  }
  const kind = typeof impl.kind === "string" ? impl.kind : "";
  if (!PLAN_IMPL_KINDS.has(kind)) {
    return { ok: false, error: `modification-plan implementation.kind 非法：${kind || "(空)"}（可选: ${[...PLAN_IMPL_KINDS].join("/")}）` };
  }
  const routeHint = typeof impl.routeHint === "string" ? impl.routeHint : undefined;
  return {
    ok: true,
    plan: {
      planHash: hashPlanContent(c),
      goal,
      changes,
      expected,
      rollback,
      retestWindow,
      implementation: { kind, ...(routeHint ? { routeHint } : {}) },
    },
  };
}

export interface PlanGrantVerifyInput {
  grant: unknown;
  planHash: string;
}

export type PlanGrantVerify = (input: PlanGrantVerifyInput) => { ok: true } | { ok: false; error: string };

/** 签发 plan grant（批准 modification-plan 时调用）。 */
export function issuePlanGrant(
  grantService: ExecutionGrantService,
  planHash: string,
  tenantId: string,
  ttlMs: number = PLAN_GRANT_TTL_MS,
): ExecutionGrant {
  const scope: TenantScope = {
    tenantId,
    principalId: `plan-grant:${planHash}`,
    roles: ["controller"],
    traceId: `plan:${planHash}`,
  };
  return grantService.issue({
    lease: {
      taskId: `plan:${planHash}`,
      leaseId: randomUUID(),
      generation: 1,
    },
    scope,
    workspace: {
      tenantId,
      workspaceId: planScope(planHash),
      taskId: `plan:${planHash}`,
    },
    language: "ts",
    capabilities: [PLAN_GRANT_CAPABILITY],
    ttlMs,
  });
}

/** 校验 plan grant（manage 即时工具与实施任务派生共用）。 */
export function verifyPlanGrant(
  grantService: ExecutionGrantService,
  grant: unknown,
  planHash: string,
): { ok: true } | { ok: false; error: string } {
  const v = grantService.verify(grant);
  if (!v.ok) return { ok: false, error: `plan grant 验签失败：${v.error}` };
  if (v.grant.workspace.workspaceId !== planScope(planHash)) {
    return { ok: false, error: "plan grant 作用域不匹配（workspaceId ≠ plan:<sha256>）" };
  }
  if (!v.grant.capabilities.includes(PLAN_GRANT_CAPABILITY)) {
    return { ok: false, error: "plan grant 缺少 plan.execute 能力" };
  }
  return { ok: true };
}

/** 由 ExecutionGrantService 构造可直接注入 worker 面的 planGrantVerify 闭包。 */
export function createPlanGrantVerify(grantService: ExecutionGrantService | undefined): PlanGrantVerify | undefined {
  if (!grantService) return undefined;
  return (input) => verifyPlanGrant(grantService, input.grant, input.planHash);
}
