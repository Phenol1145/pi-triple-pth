import { describe, it, expect } from "vitest";
import { isForwardableKernelEvent, toKernelActivityEvent } from "../../src/pth/kernel/execution/kernel-event-bridge.js";

describe("kernel-event-bridge（trigger 统一化事件桥上行）", () => {
  it("白名单：task.execute/submit/reject、kernel.execute、worker.* 转发", () => {
    for (const kind of [
      "task.execute.start", "task.execute.end", "task.submit", "task.reject",
      "kernel.execute.start", "kernel.execute.end",
      "worker.add", "worker.pause", "worker.resume", "worker.remove",
    ]) {
      expect(isForwardableKernelEvent(kind)).toBe(true);
    }
  });

  it("去重：task.claim/task.done/task.failed/batch.* 不重复转发（activity 通道已覆盖）", () => {
    for (const kind of ["task.claim", "task.done", "task.failed", "batch.spawn", "batch.kill", "agent.step"]) {
      expect(isForwardableKernelEvent(kind)).toBe(false);
    }
  });

  it("字段归一：task.reject 的 reason → detail；taskId/role/ok/batchPid/at 对齐 ActivityEvent", () => {
    const ev = toKernelActivityEvent(
      { type: "task.reject", payload: { taskId: "t1", role: "developer", reason: "exec-failed", durationMs: 42 }, ts: 1234 },
      999,
    );
    expect(ev.kind).toBe("task.reject");
    expect(ev.taskId).toBe("t1");
    expect(ev.role).toBe("developer");
    expect(ev.detail).toBe("exec-failed");
    expect(ev.durationMs).toBe(42);
    expect(ev.batchPid).toBe(999);
    expect(ev.at).toBe(1234);
  });

  it("字段归一：worker.add 的 copies 不进 ActivityEvent 必需字段（容忍未知 payload）", () => {
    const ev = toKernelActivityEvent({ type: "worker.add", payload: { role: "developer", copies: 2 }, ts: 1 }, 7);
    expect(ev.kind).toBe("worker.add");
    expect(ev.role).toBe("developer");
    expect(ev.batchPid).toBe(7);
  });
});
