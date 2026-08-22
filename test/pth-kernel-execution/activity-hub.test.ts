import { describe, it, expect } from "vitest";
import { ActivityHub, type ActivityEvent } from "@away_from/pth-kernel-execution";

describe("ActivityHub（流式活动状态——console --follow 数据源）", () => {
  it("publish → subscribe 实时收到", () => {
    const hub = new ActivityHub();
    const got: ActivityEvent[] = [];
    hub.subscribe((e) => got.push(e));
    hub.publish({ kind: "task.claim", role: "developer", taskId: "t1", at: Date.now() });
    hub.publish({ kind: "agent.step", role: "developer", taskId: "t1", step: 1, usage: { inputTokens: 100, outputTokens: 50 }, at: Date.now() });
    expect(got).toHaveLength(2);
    expect(got[1].usage?.outputTokens).toBe(50);
  });

  it("replay 回放历史（新订阅者补缓冲）", () => {
    const hub = new ActivityHub();
    hub.publish({ kind: "task.claim", taskId: "t1", at: 1 });
    hub.publish({ kind: "task.done", taskId: "t1", at: 2 });
    const replayed = hub.replay();
    expect(replayed).toHaveLength(2);
    expect(replayed[0].kind).toBe("task.claim");
  });

  it("stream AsyncIterable——先回放后实时（writeSSE 消费形态）", async () => {
    const hub = new ActivityHub();
    hub.publish({ kind: "task.claim", taskId: "t1", at: 1 });
    const events: ActivityEvent[] = [];
    const iter = hub.stream()[Symbol.asyncIterator]();
    // 回放
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value.kind).toBe("task.claim");
    // 实时
    setTimeout(() => hub.publish({ kind: "agent.step", taskId: "t1", step: 1, at: 2 }), 10);
    const second = await iter.next();
    expect(second.value.kind).toBe("agent.step");
    await iter.return!();
  });

  it("退订后不再收到（return 清理）", async () => {
    const hub = new ActivityHub();
    const got: ActivityEvent[] = [];
    const unsub = hub.subscribe((e) => got.push(e));
    hub.publish({ kind: "a", at: 1 });
    unsub();
    hub.publish({ kind: "b", at: 2 });
    expect(got).toHaveLength(1);
  });
});
