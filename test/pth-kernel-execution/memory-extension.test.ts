import { describe, it, expect } from "vitest";
import { memoryExtension } from "../../src/pth/kernel/extensions/memory.js";

/**
 * ts 程序 memory 白名单（2026-08-12 审计 CRITICAL-1 修复）：bindAll(store) 曾把 raw
 * incrementAggregate/get/bumpHitCount/listIds 暴露给 worker 程序——SQL 键拼接可注入。
 * 白名单 = 策略包装的 query/retrieve/write/update + 可见性过滤的 get。
 */
describe("ts 程序 memory 白名单", () => {
  function provide() {
    const store = {
      query: async () => [],
      retrieve: async () => [],
      write: async () => {},
      update: async () => {},
      get: async () => ({ id: "x", kind: "k", content: "c", meta: {} }),
      incrementAggregate: async () => {},
      bumpHitCount: async () => {},
      listIds: async () => [],
    };
    const mem = memoryExtension.provide({
      dataWorld: { memory: store },
      sessionRef: { current: { currentSpace: "ts" } },
    } as never).memory as Record<string, unknown>;
    return { mem, store };
  }

  it("不暴露 incrementAggregate/bumpHitCount/listIds（raw 方法面关闭）", () => {
    const { mem } = provide();
    expect(typeof mem.query).toBe("function");
    expect(typeof mem.retrieve).toBe("function");
    expect(typeof mem.write).toBe("function");
    expect(typeof mem.update).toBe("function");
    expect(typeof mem.get).toBe("function");
    expect(mem.incrementAggregate).toBeUndefined();
    expect(mem.bumpHitCount).toBeUndefined();
    expect(mem.listIds).toBeUndefined();
  });

  it("get 保留可见性过滤（ASP 会话态隐藏条目不可读）", async () => {
    const { mem, store } = provide();
    (store.get as unknown) = async () => ({ id: "h", kind: "k", content: "secret", meta: { spaceScope: { space: "python", visibility: "private" } } });
    // 当前空间 ts（provide 的 sessionRef）——python 私有条目不可见
    const r = await (mem.get as (id: string) => Promise<unknown>)("h");
    expect(r).toBeUndefined();
  });
});
