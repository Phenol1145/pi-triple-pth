import { describe, it, expect } from "vitest";
import { buildSkillContent, listSkills, getSkill, parseSkillSummary, parseSkillMarkdown, maintainSkillWrite, maintainSkillArchive } from "@away_from/pth-memory";

const seed = {
  id: "test-sop",
  anchor: "执行测试任务",
  whenToUse: "需要验证时",
  effect: "得到可验证结果",
  procedure: [{ step: "跑测试", cost: "1×bash.run" }],
  pitfalls: ["不跑就交"],
  verification: ["全绿"],
};

/** B4 Phase 2：skill 检索面——Level 0 清单 / Level 1 全文（B4-3 已裁 C 两级检索） */
describe("skills 检索面（B4 Phase 2）", () => {
  const content = buildSkillContent(seed);

  it("parseSkillSummary 提取三要素", () => {
    const summary = parseSkillSummary({ id: "skill:test-sop", kind: "skill:test-sop", content, status: "official" });
    expect(summary).toMatchObject({ anchor: "执行测试任务", whenToUse: "需要验证时", effect: "得到可验证结果" });
  });

  it("listSkills 只列 skill: 前缀条目并稳定排序（Level 0）", async () => {
    const store = {
      listIds: async () => ["skill:b-sop", "task-insight", "skill:a-sop"],
      get: async (id: string) =>
        id.startsWith("skill:")
          ? { id, kind: id, content: buildSkillContent({ ...seed, id: id.slice(6) }), status: "official" }
          : undefined,
    };
    const list = await listSkills(store);
    expect(list.map((s) => s.id)).toEqual(["skill:a-sop", "skill:b-sop"]);
    expect(list[0]).toHaveProperty("anchor");
  });

  it("getSkill 自动补 skill: 前缀并返回全文（Level 1）", async () => {
    const store = {
      listIds: async () => ["skill:test-sop"],
      get: async (id: string) => ({ id, kind: id, content, status: "official" }),
    };
    expect((await getSkill(store, "test-sop"))?.content).toContain("【场景锚点】执行测试任务");
    expect((await getSkill(store, "skill:test-sop"))?.id).toBe("skill:test-sop");
  });
});

/** B4 Phase 3：skill 不可变 + memory-keeper 维护面 */
describe("skills.maintain（B4 Phase 3）", () => {
  function makeStore(initial: Record<string, { id: string; kind: string; content: string; status: string; meta: Record<string, unknown> }> = {}) {
    const rows = new Map(Object.entries(initial));
    return {
      listIds: async () => [...rows.keys()],
      get: async (id: string) => rows.get(id),
      write: async (entry: any, opts?: { force?: boolean }) => {
        if (entry.id.startsWith("skill:") && !opts?.force) throw new Error("系统文档受保护");
        rows.set(entry.id, entry);
      },
      update: async (id: string, patch: any, opts?: { force?: boolean }) => {
        if (id.startsWith("skill:") && !opts?.force) throw new Error("skill 条目不可变");
        const old = rows.get(id);
        if (!old) throw new Error("entry not found");
        rows.set(id, { ...old, ...patch, meta: { ...(old.meta ?? {}), ...(patch.meta ?? {}) } });
      },
      rows,
    };
  }

  it("新条目直写；已存在未 force → 拒绝；force 覆写 revision+1 留痕", async () => {
    const store = makeStore();
    const r1 = await maintainSkillWrite(store, { name: "test-sop", content: "v1" });
    expect(r1.ok).toBe(true);
    const after1 = await store.get("skill:test-sop");
    expect(after1?.meta).toMatchObject({ revision: 1, maintainedBy: "memory-keeper" });

    const r2 = await maintainSkillWrite(store, { name: "test-sop", content: "v2" });
    expect(r2.ok).toBe(false);
    const r3 = await maintainSkillWrite(store, { name: "test-sop", content: "v2", force: true, audit: "修正" });
    expect(r3.ok).toBe(true);
    expect((await store.get("skill:test-sop"))?.meta).toMatchObject({ revision: 2, auditNote: "修正" });
  });

  it("archive 旧条目（修订 = archive + 新条目）", async () => {
    const store = makeStore({ "skill:old": { id: "skill:old", kind: "skill:old", content: "old", status: "official", meta: {} } });
    const r = await maintainSkillArchive(store, "old", "被 new 取代");
    expect(r.ok).toBe(true);
    expect(store.rows.get("skill:old")?.status).toBe("archived");
  });
});

/** B4 Phase 4：SKILL.md → 条目映射（0.13 转化落点） */
describe("SKILL.md → skill 条目映射（B4 Phase 4）", () => {
  it("四段式完整 → 解析为 seed，且与 buildSkillContent 往返一致", () => {
    const md = buildSkillContent(seed);
    const parsed = parseSkillMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.seed).toMatchObject({
      id: "test-sop",
      anchor: "执行测试任务",
      whenToUse: "需要验证时",
      effect: "得到可验证结果",
      procedure: [{ step: "跑测试", cost: "1×bash.run" }],
      pitfalls: ["不跑就交"],
      verification: ["全绿"],
    });
  });

  it("四段式缺段 → 失败（N4 pipeline 必须完整）", () => {
    expect(parseSkillMarkdown("# skill:bad\n【场景锚点】a\n【何时用】b\n【效果】c").ok).toBe(false);
  });
});
