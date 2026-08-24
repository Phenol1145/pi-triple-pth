import { describe, it, expect, vi } from "vitest";
import {
  BUILTIN_OPTIMIZATION_LOOP_SPECS,
  OptimizationLoopRegistry,
  registerBuiltinOptimizationLoops,
  runOptimizationLoop,
  validateOptimizationLoopSpec,
  type OptimizationLoopHandler,
  type OptimizationLoopSpec,
} from "@away_from/pth-kernel-execution";

const baseSpec: OptimizationLoopSpec = {
  id: "loop:test",
  name: "test loop",
  sensor: { kind: "code", ref: "sensor-a", readOnly: true },
  schedule: { kind: "interval", intervalMs: 60_000 },
  governance: { applyChannel: "approval" },
  verify: { required: true, baselineRef: "baseline:a", timeoutMs: 1000 },
  migrationStatus: "native",
};

describe("OptimizationLoopSpec 校验", () => {
  it("合法 spec 通过", () => {
    expect(validateOptimizationLoopSpec(baseSpec).ok).toBe(true);
  });

  it("sensor 必须 readOnly", () => {
    const r = validateOptimizationLoopSpec({
      ...baseSpec,
      sensor: { kind: "code", ref: "sensor-a", readOnly: false as never },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join("; ")).toContain("readOnly");
  });

  it("auto-reversible 必须声明 rollbackRef", () => {
    const r = validateOptimizationLoopSpec({
      ...baseSpec,
      governance: { applyChannel: "auto-reversible" },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join("; ")).toContain("rollbackRef");
  });

  it("safety-sensitive 不得 auto-reversible", () => {
    const r = validateOptimizationLoopSpec({
      ...baseSpec,
      governance: { applyChannel: "auto-reversible", safetySensitive: true, rollbackRef: "rollback:a" },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join("; ")).toContain("safety-sensitive");
  });

  it("verify required 但无基线/证据/超时 → 拒绝；registered-only 可后置", () => {
    const bad = validateOptimizationLoopSpec({ ...baseSpec, verify: { required: true } });
    expect(bad.ok).toBe(false);
    const deferred = validateOptimizationLoopSpec({
      ...baseSpec,
      verify: { required: true },
      migrationStatus: "registered-only",
    });
    expect(deferred.ok).toBe(true);
  });

  it("window schedule 需要正整数的 windowSize", () => {
    const r = validateOptimizationLoopSpec({
      ...baseSpec,
      schedule: { kind: "window", windowSize: 0 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("OptimizationLoopRegistry", () => {
  it("注册/重复/获取/列出", () => {
    const reg = new OptimizationLoopRegistry();
    reg.register({ spec: baseSpec, handler: {} as OptimizationLoopHandler });
    expect(reg.has(baseSpec.id)).toBe(true);
    expect(reg.get(baseSpec.id)?.spec.id).toBe(baseSpec.id);
    expect(reg.list()).toHaveLength(1);
    expect(() => reg.register({ spec: baseSpec, handler: {} as OptimizationLoopHandler })).toThrow(/already registered/);
  });
});

describe("内置优化循环登记", () => {
  it("JIT 之外至少登记 refiner/perf/tool-skill/intake，且全部为 registered-only", () => {
    expect(BUILTIN_OPTIMIZATION_LOOP_SPECS.length).toBeGreaterThanOrEqual(4);
    for (const spec of BUILTIN_OPTIMIZATION_LOOP_SPECS) {
      expect(validateOptimizationLoopSpec(spec).ok).toBe(true);
      expect(spec.migrationStatus).toBe("registered-only");
    }
    const reg = new OptimizationLoopRegistry();
    registerBuiltinOptimizationLoops(reg);
    expect(reg.has("optimization-loop:refiner")).toBe(true);
    expect(reg.has("optimization-loop:perf-autopilot")).toBe(true);
    expect(reg.has("optimization-loop:tool-skill-governance")).toBe(true);
    expect(reg.has("optimization-loop:intake-feedback")).toBe(true);
  });
});

describe("runOptimizationLoop 完整骨架", () => {
  it("按 Sense→Detect→Propose→Govern→Apply→Verify→Deopt 顺序执行并返回各阶段产物", async () => {
    const calls: string[] = [];
    const handler: OptimizationLoopHandler = {
      async sense() {
        calls.push("sense");
        return { samples: [1, 2, 3] };
      },
      async detect(sensed) {
        calls.push("detect");
        expect((sensed as { samples: number[] }).samples).toEqual([1, 2, 3]);
        return [{ id: "p1", kind: "rule", target: "capability-index", content: { text: "x" }, evidence: { n: 3 } }];
      },
      async govern(proposals) {
        calls.push("govern");
        return [{ proposal: proposals[0]!, decision: { decision: "approved" } }];
      },
      async apply(approved) {
        calls.push("apply");
        return [{ proposalId: approved[0]!.proposal.id, ok: true, rollbackRef: "rb:1" }];
      },
      async verify(applied) {
        calls.push("verify");
        return [{ proposalId: applied[0]!.proposalId, status: "verified", evidence: { ok: true } }];
      },
      async deopt(verifyResults) {
        calls.push("deopt");
        expect(verifyResults).toHaveLength(1);
        return [{ proposalId: verifyResults[0]!.proposalId, rolledBack: false }];
      },
    };

    const result = await runOptimizationLoop(baseSpec, handler);
    expect(calls).toEqual(["sense", "detect", "govern", "apply", "verify", "deopt"]);
    expect(result.approved).toHaveLength(1);
    expect(result.applied[0]?.ok).toBe(true);
    expect(result.deopted[0]?.rolledBack).toBe(false);
    expect(result.ctx.trace).toHaveLength(5);
  });

  it("denied proposal 不进入 apply", async () => {
    const handler: OptimizationLoopHandler = {
      async sense() { return undefined; },
      async detect() {
        return [{ id: "p1", kind: "role", target: "role-doc:x", content: {} }];
      },
      async govern() {
        return [{ proposal: { id: "p1", kind: "role", target: "role-doc:x", content: {} }, decision: { decision: "denied", reason: "no" } }];
      },
      async apply(approved) {
        expect(approved).toHaveLength(0);
        return [];
      },
      async verify() { return []; },
      async deopt() { return []; },
    };
    const r = await runOptimizationLoop(baseSpec, handler);
    expect(r.applied).toHaveLength(0);
  });

  it("signal 注入 ctx", async () => {
    const ac = new AbortController();
    const handler: OptimizationLoopHandler = {
      async sense(ctx) { expect(ctx.signal).toBe(ac.signal); return undefined; },
      async detect() { return []; },
      async govern() { return []; },
      async apply() { return []; },
      async verify() { return []; },
      async deopt() { return []; },
    };
    await runOptimizationLoop(baseSpec, handler, undefined, { signal: ac.signal });
  });
});
