import { describe, it, expect } from "vitest";
import { parsePthArgs, renderBatchStatus, renderBatchSuggestion, type PthCommand } from "../../src/pth/kernel/commands";

describe("pth batch command parsing", () => {
  it("add 无参 → 1 个 batch", () => {
    const c = parsePthArgs("batch add");
    expect(c.kind).toBe("batch");
    expect((c as Extract<PthCommand, { action: "add" }>).count).toBe(1);
  });

  it("add 3 → 3 个 batch", () => {
    const c = parsePthArgs("batch add 3");
    expect((c as Extract<PthCommand, { action: "add" }>).count).toBe(3);
  });

  it("remove 2 → 2 个 batch", () => {
    const c = parsePthArgs("batch remove 2");
    expect((c as Extract<PthCommand, { action: "remove" }>).count).toBe(2);
  });

  it("status/suggest/stats 无参解析", () => {
    for (const a of ["batch status", "batch suggest", "batch stats"] as const) {
      expect(parsePthArgs(a).kind).toBe("batch");
    }
  });

  it("未知子命令 → help", () => {
    const c = parsePthArgs("batch frobnicate");
    expect(c.kind).toBe("help");
  });
});

describe("pth batch rendering", () => {
  it("renderBatchStatus 列出批次与工人", () => {
    const out = renderBatchStatus([
      { id: "b1", pid: 1234, workers: ["analyst", "planner"], currentTasks: { analyst: "t1" }, idleRatio: 0.5 },
    ]);
    expect(out).toContain("b1");
    expect(out).toContain("1234");
    expect(out).toContain("analyst");
    expect(out).toContain("t1");
  });

  it("renderBatchSuggestion 展示动作与理由", () => {
    const out = renderBatchSuggestion({ action: "spawn", reason: "任务积压", data: { pendingCount: 5, idleRatio: 0, batchCount: 1 } });
    expect(out).toContain("spawn");
    expect(out).toContain("任务积压");
  });
});
