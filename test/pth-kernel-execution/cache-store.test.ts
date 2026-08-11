import { describe, it, expect } from "vitest";
import { CacheStore } from "../../src/pth/kernel/execution/cache-store.js";

describe("CacheStore（随身缓存——硬容量限制）", () => {
  it("load/get/cancel 基本循环", () => {
    const c = new CacheStore({ maxChars: 1000, maxEntries: 5 });
    expect(c.load("k1", "内容一", "memory:e1")).toEqual({ ok: true });
    expect(c.get("k1")).toBe("内容一");
    expect(c.cancel("k1")).toBe(true);
    expect(c.get("k1")).toBeUndefined();
  });

  it("字符硬上限：超容拒绝 + 引导 cancel", () => {
    const c = new CacheStore({ maxChars: 100, maxEntries: 10 });
    c.load("a", "x".repeat(60), "m:a");
    const r = c.load("b", "y".repeat(60), "m:b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cache.cancel");
    c.cancel("a");
    expect(c.load("b", "y".repeat(60), "m:b").ok).toBe(true);   // 腾位后成功
  });

  it("条目数硬上限", () => {
    const c = new CacheStore({ maxChars: 10000, maxEntries: 2 });
    c.load("a", "1", "s"); c.load("b", "2", "s");
    const r = c.load("c", "3", "s");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("上限");
  });

  it("单条目超总容量 → 拒绝", () => {
    const c = new CacheStore({ maxChars: 50, maxEntries: 10 });
    expect(c.load("big", "x".repeat(60), "s").ok).toBe(false);
  });

  it("同键覆盖（先释放旧占用）", () => {
    const c = new CacheStore({ maxChars: 100, maxEntries: 5 });
    c.load("k", "x".repeat(80), "s");
    expect(c.load("k", "y".repeat(90), "s2").ok).toBe(true);   // 覆盖不受旧占用阻塞
    expect(c.get("k")).toBe("y".repeat(90));
  });

  it("index 自检视图（条目/容量）", () => {
    const c = new CacheStore({ maxChars: 500, maxEntries: 5 });
    c.load("k1", "abc", "memory:e1");
    const view = c.index();
    expect(view).toContain("1/5 条目");
    expect(view).toContain("k1");
    expect(view).toContain("memory:e1");
  });
});
