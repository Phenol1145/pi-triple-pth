import { describe, it, expect } from "vitest";
import { validateWikiWrite } from "@away_from/pth-memory";

/** B5 / N1b：百科写入矛盾检测（词表校验） */
function entry(over: Record<string, unknown> = {}) {
  return {
    id: "wiki:test-term",
    kind: "pth-wiki",
    anchors: ["pth-wiki", "test-term"],
    content: "术语：test-term\n域：域 B · 知识\n来源：concepts.md §2",
    ...over,
  };
}

describe("validateWikiWrite（N1b）", () => {
  it("合法条目通过", async () => {
    const store = { listIds: async () => ["wiki:test-term"], get: async () => entry() };
    expect(await validateWikiWrite(store as never, entry())).toEqual({ ok: true });
  });

  it("id 与术语不符 → 拒绝", async () => {
    const store = { listIds: async () => [], get: async () => undefined };
    expect(await validateWikiWrite(store as never, entry({ id: "wiki:other" }))).toMatchObject({ ok: false });
  });

  it("anchors 缺术语 → 拒绝", async () => {
    const store = { listIds: async () => [], get: async () => undefined };
    expect(await validateWikiWrite(store as never, entry({ anchors: ["pth-wiki"] }))).toMatchObject({ ok: false });
  });

  it("content 三要素缺失 → 拒绝", async () => {
    const store = { listIds: async () => [], get: async () => undefined };
    expect(await validateWikiWrite(store as never, entry({ content: "只有一句" }))).toMatchObject({ ok: false });
  });

  it("同术语被其他条目占用 → 矛盾拒绝", async () => {
    const store = {
      listIds: async () => ["wiki:test-term", "wiki:other"],
      get: async (id: string) => (id === "wiki:other" ? entry({ id: "wiki:other" }) : entry()),
    };
    expect(await validateWikiWrite(store as never, entry())).toMatchObject({ ok: false, reason: expect.stringContaining("已被") });
  });

  it("非 wiki 条目跳过校验", async () => {
    const store = { listIds: async () => { throw new Error("不应触达"); }, get: async () => undefined };
    expect(await validateWikiWrite(store as never, entry({ kind: "task-insight" }))).toEqual({ ok: true });
  });
});
