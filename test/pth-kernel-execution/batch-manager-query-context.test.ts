import { describe, it, expect, vi, afterEach } from "vitest";
import { BatchManager } from "@away_from/pth-kernel-execution";

/**
 * W-c：BatchManager.queryWorkerContext 的 fake child 单测。
 * 不 spawn 真实子进程——直接向 private batches 注入 fake child，
 * 验证 requestId 回执结算与 5s 超时降级空数组。
 */

function fakeRecord(childOverrides: { send?: (msg: any) => void } = {}) {
  const child = {
    connected: true,
    exitCode: null as number | null,
    send: vi.fn((msg: any) => childOverrides.send?.(msg)),
  };
  return {
    id: "batch-ctx-1",
    child,
    workers: ["developer"],
    currentTasks: new Map<string, string>(),
    lastHeartbeat: Date.now(),
    pendingCtl: new Map(),
    pendingRemovalCtl: new Map(),
    replicas: [],
    activity: [],
    pendingQueries: new Map(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BatchManager.queryWorkerContext（W-c）", () => {
  it("发送 worker-context-query 并按 requestId 结算回执", async () => {
    const mgr = new BatchManager({ batchProcessPath: "stub" });
    const record = fakeRecord({
      send: (msg: any) => {
        // 模拟子进程立即回执：直接结算 pendingQueries（查询方法先登记再 send）。
        const resolve = record.pendingQueries.get(msg.requestId);
        resolve?.([{ role: "developer", taskId: "t1", messages: [] }]);
      },
    });
    (mgr as unknown as { batches: Map<string, unknown> }).batches.set(record.id, record);

    const tasks = await mgr.queryWorkerContext(record.id, "developer", { last: 5 });
    expect(tasks).toEqual([{ role: "developer", taskId: "t1", messages: [] }]);
    expect(record.child.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "worker-context-query", role: "developer", last: 5, requestId: expect.any(String) }),
    );
    // 回执结算后等待表清空（防泄漏）。
    expect(record.pendingQueries.size).toBe(0);
  });

  it("last 有界化：默认 10，上限 100", async () => {
    const mgr = new BatchManager({ batchProcessPath: "stub" });
    const record = fakeRecord({
      send: (msg: any) => {
        const resolve = record.pendingQueries.get(msg.requestId);
        resolve?.([]);
      },
    });
    (mgr as unknown as { batches: Map<string, unknown> }).batches.set(record.id, record);

    await mgr.queryWorkerContext(record.id, "developer");
    const sentDefault = record.child.send.mock.calls.at(-1)![0] as { last: number };
    expect(sentDefault.last).toBe(10);
    await mgr.queryWorkerContext(record.id, "developer", { last: 999 });
    const sentCap = record.child.send.mock.calls.at(-1)![0] as { last: number };
    expect(sentCap.last).toBe(100);
    expect(record.pendingQueries.size).toBe(0);
  });

  it("5s 超时无回执 → resolve 空数组并清理等待表", async () => {
    vi.useFakeTimers();
    const mgr = new BatchManager({ batchProcessPath: "stub" });
    const record = fakeRecord();
    (mgr as unknown as { batches: Map<string, unknown> }).batches.set(record.id, record);

    const p = mgr.queryWorkerContext(record.id, "developer");
    let settled = false;
    void p.then((tasks) => {
      expect(tasks).toEqual([]);
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(true);
    expect(record.pendingQueries.size).toBe(0);
  });

  it("batch 不存在 / IPC 不可用 → 立即降级空数组", async () => {
    const mgr = new BatchManager({ batchProcessPath: "stub" });
    expect(await mgr.queryWorkerContext("missing", "developer")).toEqual([]);

    const record = fakeRecord();
    (mgr as unknown as { batches: Map<string, unknown> }).batches.set(record.id, record);
    record.child.connected = false;
    expect(await mgr.queryWorkerContext(record.id, "developer")).toEqual([]);
  });
});
