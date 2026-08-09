import { describe, it, expect, beforeEach } from "vitest";
import { KernelEventBus, getEventBus, resetEventBus, type KernelEvent } from "../../src/pth/kernel/execution/event-bus.js";

describe("PTH 事件总线（兼容性扩展接口 P1）", () => {
  beforeEach(() => resetEventBus());

  it("域×动作订阅 + emit 分发", async () => {
    const bus = new KernelEventBus();
    const got: KernelEvent[] = [];
    bus.on("task.execute.start", async (e) => { got.push(e); });
    bus.emit("task.execute.start", { taskId: "t1", role: "developer" });
    await new Promise((r) => setTimeout(r, 10));   // fire-and-forget——等微任务
    expect(got).toHaveLength(1);
    expect(got[0]!.type).toBe("task.execute.start");
    expect(got[0]!.payload).toMatchObject({ taskId: "t1" });
  });

  it("前缀通配（task.* 订阅域全部）", async () => {
    const bus = new KernelEventBus();
    const got: string[] = [];
    bus.on("task.*", async (e) => { got.push(e.type); });
    bus.emit("task.claim", { taskId: "t1" });
    bus.emit("task.execute.start", { taskId: "t1" });
    bus.emit("kernel.acquire", { kernelId: "k1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toContain("task.claim");
    expect(got).toContain("task.execute.start");
    expect(got).not.toContain("kernel.acquire");
  });

  it("handler 失败不影响主流程（fire-and-forget——emit 不抛）", () => {
    const bus = new KernelEventBus({
      onError: () => { /* 捕获 */ },
    });
    bus.on("task.claim", () => { throw new Error("handler 崩了"); });
    expect(() => bus.emit("task.claim", { taskId: "t1" })).not.toThrow();   // emit 同步返回不抛
  });

  it("递归防护：handler 内再 emit 同事件被阻断（深度限 1）", async () => {
    const bus = new KernelEventBus();
    let count = 0;
    bus.on("task.claim", async () => {
      count++;
      bus.emit("task.claim", { taskId: "nested" });   // 递归——应被阻断
    });
    bus.emit("task.claim", { taskId: "t1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(count).toBe(1);   // 只触发一次（递归阻断）
  });

  it("off 退订", async () => {
    const bus = new KernelEventBus();
    const got: string[] = [];
    const handler = async (e: KernelEvent) => { got.push(e.type); };
    bus.on("task.claim", handler);
    bus.off("task.claim", handler);
    bus.emit("task.claim", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(0);
  });

  it("单例：getEventBus 共享（batch 内一份）；resetEventBus 重置", () => {
    const b1 = getEventBus();
    const b2 = getEventBus();
    expect(b1).toBe(b2);
    resetEventBus();
    expect(getEventBus()).not.toBe(b1);
  });

  it("handlerCount 监控", () => {
    const bus = new KernelEventBus();
    bus.on("task.claim", async () => {});
    bus.on("task.*", async () => {});
    bus.on("*", async () => {});
    expect(bus.handlerCount).toBe(3);
  });
});
