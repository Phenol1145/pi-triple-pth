import { describe, it, expect } from "vitest";
import {
  Optimizer,
  createJitOptimizationLoopHandler,
  jitOptimizationLoopSpec,
  runOptimizationLoop,
  validateOptimizationLoopSpec,
} from "@away_from/pth-kernel-execution";
import type { WorkerScorecard } from "@away_from/pth-kernel-execution";

function sc(partial: Partial<WorkerScorecard> & { toolFreq?: Record<string, number> }): WorkerScorecard {
  return {
    steps: 10, toolFreq: {}, tokens: { input: 0, output: 0 }, failedActions: 0, gatedActions: 0,
    aspNav: { cds: 0, indexes: 0 },
    ...partial,
  };
}

describe("JIT Optimizer 规范化 loop 登记", () => {
  it("jitOptimizationLoopSpec 合法且为 wrapped", () => {
    const r = validateOptimizationLoopSpec(jitOptimizationLoopSpec);
    expect(r.ok).toBe(true);
    expect(jitOptimizationLoopSpec.migrationStatus).toBe("wrapped");
  });

  it("handler.detect 把 Optimizer.detect 的 suggestion 映射为 proposal", async () => {
    const optimizer = new Optimizer({ windowSize: 10 });
    const handler = createJitOptimizationLoopHandler(optimizer);
    const proposals = await handler.detect([
      sc({ steps: 12, gatedActions: 5 }),
      sc({ steps: 8, gatedActions: 4 }),
    ], { loopId: jitOptimizationLoopSpec.id, startedAt: 0, trace: [] });
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]!.kind).toBe("rule");
    expect(proposals[0]!.target).toBe("capability-index");
  });

  it("默认 govern 返回 pending（保持 draft 语义）", async () => {
    const optimizer = new Optimizer({ windowSize: 10 });
    const handler = createJitOptimizationLoopHandler(optimizer);
    const proposals = await handler.detect([
      sc({ steps: 12, gatedActions: 5 }),
      sc({ steps: 8, gatedActions: 4 }),
    ], { loopId: "x", startedAt: 0, trace: [] });
    const governed = await handler.govern(proposals, { loopId: "x", startedAt: 0, trace: [] });
    expect(governed.every((g) => g.decision.decision === "pending")).toBe(true);
  });

  it("approveAll 可跑通完整骨架", async () => {
    const optimizer = new Optimizer({ windowSize: 10 });
    const apply = vi.fn(async (id: string) => ({ ok: true }));
    const handler = createJitOptimizationLoopHandler(optimizer, {
      approveAll: true,
      applySuggestion: apply,
      verifySuggestion: async () => ({ status: "verified" as const }),
    });
    const window = [sc({ steps: 12, gatedActions: 5 }), sc({ steps: 8, gatedActions: 4 })];
    const result = await runOptimizationLoop(jitOptimizationLoopSpec, handler, window);
    expect(result.approved.length).toBeGreaterThan(0);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(apply).toHaveBeenCalled();
    expect(result.verified.every((v) => v.status === "verified")).toBe(true);
  });
});
