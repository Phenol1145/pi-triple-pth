import { describe, it, expect } from "vitest";
import {
  validateModificationPlanContent,
  issuePlanGrant,
  verifyPlanGrant,
  hashPlanContent,
} from "../../src/pth/execution/plan-grant.js";
import { createPlanImplementationDeriver } from "../../src/pth/execution/plan-implementation.js";
import { createExecutionGrantService, createHmacGrantKeyProvider } from "../../src/pth/execution/index.js";

function grantService() {
  return createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "plan-grant-test-secret-0123456789" }),
    clock: () => new Date("2030-01-01T00:00:00.000Z"),
  });
}

function validPlan() {
  return {
    goal: "降低失败率",
    changes: "将 PTH_AGENT_MAX_STEPS 调至 40",
    expected: "失败率下降 20%",
    rollback: "恢复原值",
    retestWindow: "1h",
    implementation: { kind: "param-change", routeHint: "PTH_AGENT_MAX_STEPS" },
  };
}

describe("W2 plan grant（modification-plan 审批与实施派生）", () => {
  it("validateModificationPlanContent：合法 plan 通过并计算 planHash；缺 implementation 拒绝", () => {
    const ok = validateModificationPlanContent(validPlan());
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.plan.planHash).toBe(hashPlanContent(validPlan()));
      expect(ok.plan.implementation.kind).toBe("param-change");
    }
    const bad = validateModificationPlanContent({ goal: "x", changes: "y", expected: "z", rollback: "r", retestWindow: "w" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("implementation");
  });

  it("issuePlanGrant + verifyPlanGrant：合法通过，错误 planHash 拒绝", () => {
    const svc = grantService();
    const plan = validPlan();
    const parsed = validateModificationPlanContent(plan);
    if (!parsed.ok) throw new Error("plan invalid");
    const grant = issuePlanGrant(svc, parsed.plan.planHash, "tenant-a");
    expect(verifyPlanGrant(svc, grant, parsed.plan.planHash)).toEqual({ ok: true });
    expect(verifyPlanGrant(svc, grant, "deadbeef").ok).toBe(false);
  });

  it("createPlanImplementationDeriver：param-change → actuator 任务携 planHash/planGrant；code-fix → developer；role-register 不派任务", async () => {
    const svc = grantService();
    const published: Array<Record<string, unknown>> = [];
    const entries = new Map<string, { content: string; meta?: Record<string, unknown> }>();
    const deriver = createPlanImplementationDeriver({
      memory: { get: async (id: string) => entries.get(id) },
      publish: async (input) => { published.push(input as unknown as Record<string, unknown>); return { id: `t-${published.length}` }; },
    });

    const paramPlan = validateModificationPlanContent(validPlan());
    if (!paramPlan.ok) throw new Error("plan invalid");
    const grant = issuePlanGrant(svc, paramPlan.plan.planHash, "tenant-a");
    entries.set("plan-1", { content: JSON.stringify(validPlan()), meta: { planHash: paramPlan.plan.planHash, planGrant: grant } });
    await deriver("plan-1");
    expect(published).toHaveLength(1);
    expect((published[0]!.payload as Record<string, unknown>).flow).toMatchObject({ stages: [{ task: { role: "actuator" } }] });
    expect((published[0]!.payload as Record<string, unknown>).implementationPlanHash).toBe(paramPlan.plan.planHash);

    const codePlan = { ...validPlan(), implementation: { kind: "code-fix" } };
    const codeParsed = validateModificationPlanContent(codePlan);
    if (!codeParsed.ok) throw new Error("plan invalid");
    const codeGrant = issuePlanGrant(svc, codeParsed.plan.planHash, "tenant-a");
    entries.set("plan-2", { content: JSON.stringify(codePlan), meta: { planHash: codeParsed.plan.planHash, planGrant: codeGrant } });
    await deriver("plan-2");
    expect(published).toHaveLength(2);
    expect((published[1]!.payload as Record<string, unknown>).flow).toMatchObject({ stages: [{ task: { role: "developer" } }] });

    const regPlan = { ...validPlan(), implementation: { kind: "role-register" } };
    const regParsed = validateModificationPlanContent(regPlan);
    if (!regParsed.ok) throw new Error("plan invalid");
    const regGrant = issuePlanGrant(svc, regParsed.plan.planHash, "tenant-a");
    entries.set("plan-3", { content: JSON.stringify(regPlan), meta: { planHash: regParsed.plan.planHash, planGrant: regGrant } });
    const regResult = await deriver("plan-3");
    expect(regResult.published).toBe(0);
    expect(published).toHaveLength(2);
  });

  it("createPlanImplementationDeriver：缺 planGrant 或 plan 不存在 → 不发布", async () => {
    const published: Array<Record<string, unknown>> = [];
    const entries = new Map<string, { content: string; meta?: Record<string, unknown> }>();
    const deriver = createPlanImplementationDeriver({
      memory: { get: async (id: string) => entries.get(id) },
      publish: async (input) => { published.push(input as unknown as Record<string, unknown>); return { id: "t" }; },
    });
    const missing = await deriver("ghost");
    expect(missing.published).toBe(0);
    entries.set("plan-no-grant", { content: JSON.stringify(validPlan()) });
    const noGrant = await deriver("plan-no-grant");
    expect(noGrant.published).toBe(0);
    expect(published).toHaveLength(0);
  });
});
