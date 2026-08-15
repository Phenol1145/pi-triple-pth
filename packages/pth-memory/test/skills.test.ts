import { describe, it, expect } from "vitest";
import { buildSkillContent, listSkills, getSkill, parseSkillSummary } from "@away_from/pth-memory";

/** B4 Phase 2：skill 检索面——Level 0 清单 / Level 1 全文（B4-3 已裁 C 两级检索） */
describe("skills 检索面（B4 Phase 2）", () => {
  const seed = {
    id: "test-sop",
    anchor: "执行测试任务",
    whenToUse: "需要验证时",
    effect: "得到可验证结果",
    procedure: [{ step: "跑测试", cost: "1×bash.run" }],
    pitfalls: ["不跑就交"],
    verification: ["全绿"],
  };
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
