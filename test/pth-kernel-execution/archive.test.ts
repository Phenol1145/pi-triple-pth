import { describe, it, expect, vi } from "vitest";
import { archiveTask } from "../../src/pth/kernel/execution/archive";

describe("archive task", () => {
  it("creates transcript with program/result/summary and artifact path", async () => {
    const create = vi.fn(async () => "transcript-1");
    const archive = vi.fn(async () => ({ artifactPath: "/art/t1" }));
    const emit = vi.fn();
    await archiveTask(
      { id: "t1", text: "do x", claimed_by: "developer" } as any,
      { dir: "/ws/t1" },
      { ok: true, value: "result-value", stdout: "out", stderr: "", durationMs: 10 },
      { transcriptStore: { create } as any, workspaceMgr: { archive } as any, emitCleanup: emit },
    );
    expect(archive).toHaveBeenCalledWith("t1", "/ws/t1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "t1",
      agentId: "developer",
      artifactPath: "/art/t1",
    }));
    // body 包含 program/result/summary
    const arg = create.mock.calls[0][0];
    expect(arg.body[0]).toEqual({ type: "program", program: "do x" });
    expect(arg.body[1]).toEqual({ type: "result", result: "result-value", stdout: "out", stderr: "" });
    expect(arg.body[2].type).toBe("summary");
    // 清理提示（不自动删——裁决 17）
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ artifactPath: "/art/t1", taskId: "t1" }));
  });

  it("archives failed result too (ok:false)", async () => {
    const create = vi.fn(async () => "transcript-2");
    const archive = vi.fn(async () => ({ artifactPath: "/art/t2" }));
    await archiveTask(
      { id: "t2", text: "do y", claimed_by: "developer" } as any,
      { dir: "/ws/t2" },
      { ok: false, error: { message: "boom" }, durationMs: 5 },
      { transcriptStore: { create } as any, workspaceMgr: { archive } as any, emitCleanup: () => {} },
    );
    const arg = create.mock.calls[0][0];
    expect(arg.body[1]).toEqual({ type: "result", ok: false, error: { message: "boom" } });
  });
});
