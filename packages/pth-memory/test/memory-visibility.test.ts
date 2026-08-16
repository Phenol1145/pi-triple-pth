import { describe, it, expect } from "vitest";
import { filterVisibleEntries, filterVisibleRows, requireMetaRows, isVisible, setSpaceLookup } from "@away_from/pth-memory";

describe("可见性过滤单一入口（H5）", () => {
  setSpaceLookup({
    get: (id) => id === "dev" ? { parent: "meta" } : id === "child" ? { parent: "dev" } : undefined,
  });

  const entries = [
    { id: "a", meta: { spaceScope: { space: "meta", visibility: "public" as const } } },
    { id: "b", meta: { spaceScope: { space: "dev", visibility: "private" as const } } },
    { id: "c", meta: undefined },
  ];

  it("filterVisibleEntries 按空间过滤（public 沿树向下 / private 仅本空间）", () => {
    expect(filterVisibleEntries(entries, "dev").map((e) => e.id)).toEqual(["a", "b", "c"]); // c 存量默认 meta+public
    expect(filterVisibleEntries(entries, "child").map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterVisibleEntries(entries).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("filterVisibleRows 与 requireMetaRows 组合", () => {
    const rows = entries as Array<{ id: string; meta?: unknown }>;
    expect(filterVisibleRows(rows, "dev").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(() => requireMetaRows([{ id: "x" }, null])).toThrow(/meta 列/);
    expect(requireMetaRows([{ id: "x", meta: {} }])).toHaveLength(1);
  });

  it("isVisible 语义不变", () => {
    expect(isVisible({ spaceScope: { space: "meta", visibility: "public" } }, "child")).toBe(true);
    expect(isVisible({ spaceScope: { space: "dev", visibility: "private" } }, "child")).toBe(false);
  });
});
