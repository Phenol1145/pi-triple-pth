import { describe, it, expect, vi } from "vitest";
import { createBridge } from "../../src/pth/core/async-iterable-bridge.js";

describe("AsyncIterableBridge", () => {
  it("push items are received by pull", async () => {
    const bridge = createBridge<string>({ maxQueueSize: 10 });
    bridge.push("a");
    bridge.push("b");
    bridge.push("c");
    bridge.done();

    const items: string[] = [];
    for await (const item of bridge.iterable) {
      items.push(item);
    }
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("done() terminates iteration", async () => {
    const bridge = createBridge<number>({ maxQueueSize: 10 });
    bridge.push(1);
    bridge.done();

    const items: number[] = [];
    for await (const item of bridge.iterable) {
      items.push(item);
    }
    expect(items).toEqual([1]);
  });

  it("push after done() is ignored", async () => {
    const bridge = createBridge<string>({ maxQueueSize: 10 });
    bridge.push("x");
    bridge.done();
    bridge.push("should-be-ignored");

    const items: string[] = [];
    for await (const item of bridge.iterable) {
      items.push(item);
    }
    expect(items).toEqual(["x"]);
  });

  it("error() causes iteration to throw", async () => {
    const bridge = createBridge<string>({ maxQueueSize: 10 });
    bridge.push("before-error");
    bridge.error(new Error("test error"));

    const items: string[] = [];
    try {
      for await (const item of bridge.iterable) {
        items.push(item);
      }
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).toBe("test error");
      expect(items).toEqual(["before-error"]);
    }
  });

  it("overflow: maxQueueSize exceeded sets overflowed flag", () => {
    const bridge = createBridge<number>({ maxQueueSize: 3 });
    bridge.push(1);
    bridge.push(2);
    bridge.push(3);
    expect(bridge.isOverflowed()).toBe(false);
    bridge.push(4); // over limit
    expect(bridge.isOverflowed()).toBe(true);
  });

  it("overflow: items beyond limit are dropped", async () => {
    const bridge = createBridge<number>({ maxQueueSize: 2 });
    bridge.push(1);
    bridge.push(2);
    bridge.push(3); // dropped
    bridge.push(4); // dropped
    bridge.done();

    const items: number[] = [];
    for await (const item of bridge.iterable) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
  });

  it("error is delivered even when queue has items", async () => {
    const bridge = createBridge<string>({ maxQueueSize: 10 });
    bridge.push("item1");
    bridge.error(new Error("boom"));

    // After draining the queue, next pull throws
    try {
      for await (const _ of bridge.iterable) {
        // consume until error
      }
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).toBe("boom");
    }
  });

  it("empty bridge with done() returns immediately", async () => {
    const bridge = createBridge<string>({ maxQueueSize: 10 });
    bridge.done();

    const items: string[] = [];
    for await (const item of bridge.iterable) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });
});
