import { describe, it, expect } from "vitest";
import {
  SKILL_FORMAT_SECTIONS,
  SKILL_SOP_TEMPLATE,
  buildSkillContent,
  SEED_SKILL_SOPS,
  SEED_OPT_SOPS,
} from "@away_from/pth-memory";

describe("skill 四段式格式（B4 Phase 1 / W1）", () => {
  it("格式模板含四段：场景锚点 / Procedure / Pitfalls / Verification", () => {
    expect(SKILL_FORMAT_SECTIONS).toEqual(["场景锚点", "Procedure", "Pitfalls", "Verification"]);
    for (const sec of ["【场景锚点】", "## Procedure", "## Pitfalls", "## Verification"]) {
      expect(SKILL_SOP_TEMPLATE).toContain(sec);
    }
  });

  it("buildSkillContent 产出四段式，Procedure 每步标注调用代价（W3 质检项）", () => {
    const content = buildSkillContent({
      id: "demo-sop",
      anchor: "演示任务",
      whenToUse: "演示时",
      effect: "得到演示结果",
      procedure: [{ step: "做第一步", cost: "1×memory.query" }],
      pitfalls: ["不要盲试"],
      verification: ["结果可复现"],
    });
    expect(content).toContain("# skill:demo-sop");
    expect(content).toContain("【场景锚点】演示任务");
    expect(content).toContain("【何时用】演示时");
    expect(content).toContain("【效果】得到演示结果");
    expect(content).toContain("1. 做第一步（代价：1×memory.query）");
    expect(content).toContain("## Pitfalls");
    expect(content).toContain("- 不要盲试");
    expect(content).toContain("## Verification");
    expect(content).toContain("- 结果可复现");
  });

  it("B4-2 裁决 A：首批恰为 3 条角色 SOP（developer/scout/memory-keeper）", () => {
    expect(SEED_SKILL_SOPS.map((s) => s.id)).toEqual([
      "developer-sop",
      "scout-sop",
      "memory-keeper-sop",
    ]);
  });

  it("每条种子都是完整四段式且 Procedure 每步带代价", () => {
    for (const seed of SEED_SKILL_SOPS) {
      const content = buildSkillContent(seed);
      for (const sec of ["【场景锚点】", "【何时用】", "【效果】", "## Procedure", "## Pitfalls", "## Verification"]) {
        expect(content).toContain(sec);
      }
      expect(seed.procedure.length).toBeGreaterThan(0);
      for (const p of seed.procedure) {
        expect(p.cost).not.toBe("");
      }
      expect(content).toMatch(/1\. .+（代价：.+）/);
      expect(seed.pitfalls.length).toBeGreaterThan(0);
      expect(seed.verification.length).toBeGreaterThan(0);
    }
  });

  it("memory-keeper 沉淀合并拆三步：一致性/矛盾 → 重复率 → 引用降重", () => {
    const keeper = SEED_SKILL_SOPS.find((s) => s.id === "memory-keeper-sop")!;
    const content = buildSkillContent(keeper);
    expect(content).toContain("检查一致性/矛盾");
    expect(content).toContain("检查重复率");
    expect(content).toContain("使用引用降重");
    expect(content).toContain("promotedFrom");
    expect(content).toContain("不静默覆盖");
    // 三步在 Procedure 中按顺序出现
    const i1 = content.indexOf("检查一致性/矛盾");
    const i2 = content.indexOf("检查重复率");
    const i3 = content.indexOf("使用引用降重");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it("N14 P3：分层 SOP × 4 固化（opt-tool-face/tool-single/memory/rule——0.17.4 四层次）", () => {
    expect(SEED_OPT_SOPS.map((s) => s.id)).toEqual([
      "opt-tool-face",
      "opt-tool-single",
      "opt-memory",
      "opt-rule",
    ]);
    for (const seed of SEED_OPT_SOPS) {
      const content = buildSkillContent(seed);
      for (const sec of ["【场景锚点】", "【何时用】", "【效果】", "## Procedure", "## Pitfalls", "## Verification"]) {
        expect(content, seed.id).toContain(sec);
      }
      expect(seed.procedure.length).toBeGreaterThan(0);
      expect(seed.pitfalls.length).toBeGreaterThan(0);
      expect(seed.verification.length).toBeGreaterThan(0);
      for (const p of seed.procedure) expect(p.cost).not.toBe("");
    }
    // 各 SOP 的调节手段与设计 §4 一致（manage.tool.* / manage.params.set / manage.memory.archive）
    const face = SEED_OPT_SOPS.find((s) => s.id === "opt-tool-face")!;
    expect(buildSkillContent(face)).toContain("manage.tool.register");
    const rule = SEED_OPT_SOPS.find((s) => s.id === "opt-rule")!;
    expect(buildSkillContent(rule)).toContain("manage.params.set");
    expect(buildSkillContent(rule)).toContain("PTH_GUARD_*");
  });
});
