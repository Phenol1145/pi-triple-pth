import { describe, it, expect } from "vitest";
import { memoryExtension } from "@away_from/pth-kernel-interpreter";

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

  it("2026-08-15 筛查 H3：会话空间下 query 缺 meta 列 → fail-closed", async () => {
    const { store } = provide();
    const ctx = {
      dataWorld: {
        memory: store,
        queryReadOnly: async () => [{ id: "a", kind: "task-insight", content: "secret" }],
      },
      sessionRef: { current: { currentSpace: "ts" } },
    };
    const m = memoryExtension.provide(ctx as never).memory as { query: (sql: string) => Promise<unknown> };
    await expect(m.query("SELECT id, kind, content FROM memory_entries")).rejects.toThrow(/meta/);
  });

  it("2026-08-15 筛查 H6：update 额外字段（meta 提权）→ 拒绝", async () => {
    const { mem, store } = provide();
    (store.get as unknown) = async () => ({ id: "x", kind: "task-insight", status: "official", content: "c", meta: {} });
    await expect((mem.update as (id: string, patch: Record<string, unknown>) => Promise<unknown>)("x", { content: "new", meta: { spaceScope: { space: "meta", visibility: "public" } } }))
      .rejects.toThrow(/仅允许 content\/status/);
  });
});

describe("环境断言守卫（2026-08-13 洞察污染防线）", () => {
  function provide() {
    const store = {
      query: async () => [], retrieve: async () => [], write: async () => {},
      update: async () => {}, get: async () => undefined,
    };
    const mem = memoryExtension.provide({
      dataWorld: { memory: store },
      sessionRef: { current: { currentSpace: "ts" } },
    } as never).memory as { write: (e: Record<string, unknown>) => Promise<void> };
    return { mem, store };
  }

  it("与系统事实矛盾的否定断言被拒（write 空间有工具——'无注册工具'拒写）", async () => {
    const { mem } = provide();
    await expect(mem.write({
      kind: "task-insight", status: "draft",
      anchors: ["洞察"],
      content: "环境洞察：write 空间无注册工具，文档产物走 fs.task",
      meta: { visibility: "public" },
    })).rejects.toThrow(/污染防线/);
  });

  it("合理的环境断言放行（不存在的空间）", async () => {
    const { mem, store } = provide();
    let written: unknown;
    (store.write as unknown) = async (e: unknown) => { written = e; };
    await mem.write({
      kind: "task-insight", status: "draft",
      anchors: ["洞察"],
      content: "环境洞察：nosuch 空间无注册工具",
      meta: { visibility: "public" },
    });
    expect(written).toBeDefined();
  });
});
