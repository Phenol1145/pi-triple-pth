import { describe, it, expect } from "vitest";
import { buildMemoryIndex } from "../../src/pth/kernel/execution/memory-index.js";
import { isVisible, scopeOf, checkVisibilityDeclaration, stampScope, isDescendantOrSelf } from "../../src/pth/kernel/execution/memory-visibility.js";

const ENTRIES = [
  { id: "e1", kind: "task-insight", anchors: ["auth", "login"], content: "认证模块洞察：token 刷新逻辑在…", meta: { spaceScope: { space: "meta", visibility: "public" } } },
  { id: "e2", kind: "task-insight", anchors: ["auth"], content: "第二个认证洞察", meta: { spaceScope: { space: "ts", visibility: "private" } } },
  { id: "e3", kind: "role-doc", anchors: ["role"], content: "角色文档", meta: { spaceScope: { space: "ts", visibility: "public" } } },
];

function mockMemory() {
  return {
    query: async (sql: string) => {
      if (sql.includes("GROUP BY kind")) return [{ kind: "task-insight", n: 2 }, { kind: "role-doc", n: 1 }];
      return [{ tag: "auth", n: 2 }, { tag: "login", n: 1 }];
    },
    retrieve: async (opts: { anchors?: string[] }) =>
      ENTRIES.filter((e) => opts.anchors?.some((a) => e.anchors.includes(a))),
    get: async (id: string) => ENTRIES.find((e) => e.id === id),
  };
}

describe("memory-visibility（可见性规则）", () => {
  it("scopeOf：无声明条目 → meta+public（存量兼容）", () => {
    expect(scopeOf({})).toEqual({ space: "meta", visibility: "public" });
    expect(scopeOf({ spaceScope: { space: "ts", visibility: "private" } })).toEqual({ space: "ts", visibility: "private" });
  });

  it("public 向下流动：meta public 全空间可见；ts public 仅 ts 及后代", () => {
    expect(isVisible(ENTRIES[0]!.meta, "meta")).toBe(true);
    expect(isVisible(ENTRIES[0]!.meta, "python")).toBe(true);    // meta public → python 可见
    expect(isVisible(ENTRIES[2]!.meta, "ts")).toBe(true);        // ts public → ts 可见
    expect(isVisible(ENTRIES[2]!.meta, "meta")).toBe(false);     // 父空间看不到子空间条目
    expect(isVisible(ENTRIES[2]!.meta, "python")).toBe(false);   // 兄弟空间不可见
  });

  it("private 仅本空间", () => {
    expect(isVisible(ENTRIES[1]!.meta, "ts")).toBe(true);
    expect(isVisible(ENTRIES[1]!.meta, "meta")).toBe(false);
  });

  it("isDescendantOrSelf：沿 parent 链", () => {
    expect(isDescendantOrSelf("ts", "meta")).toBe(true);
    expect(isDescendantOrSelf("meta", "ts")).toBe(false);
    expect(isDescendantOrSelf("ts", "ts")).toBe(true);
  });

  it("写入必显式声明（缺省拒绝）+ 系统盖章", () => {
    expect(checkVisibilityDeclaration({}).ok).toBe(false);
    expect(checkVisibilityDeclaration({ visibility: "public" }).ok).toBe(true);
    const stamped = stampScope({ visibility: "private", other: 1 }, "ts");
    expect(stamped).toMatchObject({ spaceScope: { space: "ts", visibility: "private" }, other: 1 });
    expect(stamped["visibility"]).toBeUndefined();   // 声明位移入 spaceScope
  });
});

describe("memory.index（图单跳导航）", () => {
  it("无参 → 顶层视图（层分组 + tag 词表——不列条目）", async () => {
    const out = await buildMemoryIndex({}, { memory: mockMemory() as never, currentSpace: "meta" });
    expect(out).toContain("knowledge: task-insight(2)");
    expect(out).toContain("prompt: role-doc(1)");
    expect(out).toContain("auth(2)");
    expect(out).not.toContain("e1 [");   // 顶层不列条目
  });

  it("{tag} → 条目清单（id+kind+摘要）", async () => {
    const out = await buildMemoryIndex({ tag: "auth" }, { memory: mockMemory() as never, currentSpace: "ts" });
    expect(out).toContain("e1 [task-insight]");
    expect(out).toContain("e2 [task-insight]");
    expect(out).not.toContain("login");   // 单跳——不附条目的其他 tag
  });

  it("{id} → 条目出边（tag 列表）", async () => {
    const out = await buildMemoryIndex({ id: "e1" }, { memory: mockMemory() as never, currentSpace: "meta" });
    expect(out).toContain("tags: auth, login");
    expect(out).toContain("认证模块洞察");
  });

  it("{id} 不可见条目（private 他空间）→ 提示不可见", async () => {
    const out = await buildMemoryIndex({ id: "e2" }, { memory: mockMemory() as never, currentSpace: "meta" });
    expect(out).toContain("不可见");
  });

  it("{tag} 无结果 → 空态", async () => {
    const out = await buildMemoryIndex({ tag: "ghost" }, { memory: mockMemory() as never, currentSpace: "meta" });
    expect(out).toContain("无可见条目");
  });
});
