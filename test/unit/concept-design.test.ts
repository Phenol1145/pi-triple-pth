import { describe, it, expect } from "vitest";
import { CONCEPT_DESIGN_TEMPLATE, validateConceptDesign, buildConceptDesignSubmit, REQUIRED_SECTIONS } from "../../src/pth/kernel/concept-design.js";

/** D3 / T9：PTL→PTH 概念设计交接 */
describe("concept-design 交接（T9/D3）", () => {
  const full = [
    "【目标】产出实施计划",
    "【背景与约束】单仓 TypeScript",
    "【现状】已有 memory 包",
    "【概念方案】先切端口再接适配器",
    "【边界 / 非目标】不做分仓",
    "【验收标准】全量测试绿",
    "【风险与未决】无",
  ].join("\n");

  it("五段齐全 → 通过；缺段报 missing", () => {
    expect(validateConceptDesign(full)).toEqual({ ok: true });
    const missing = validateConceptDesign("【目标】只有目标");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.missing).toEqual(expect.arrayContaining(["【现状】", "【验收标准】"]));
  });

  it("模板本身通过校验", () => {
    expect(validateConceptDesign(CONCEPT_DESIGN_TEMPLATE).ok).toBe(true);
  });

  it("buildConceptDesignSubmit：缺省 planner + concept-design 标签 + flow", () => {
    const built = buildConceptDesignSubmit(full);
    expect(built.tags).toContain("concept-design");
    expect(built.payload).toMatchObject({ flow: { stages: [{ task: { role: "planner" } }] } });
    expect(built.text).toContain("【概念方案】");
  });

  it("buildConceptDesignSubmit：不完整直接抛错", () => {
    expect(() => buildConceptDesignSubmit("不够完整")).toThrow(/缺少段落/);
  });

  it("REQUIRED_SECTIONS 恒定五段", () => {
    expect(REQUIRED_SECTIONS).toEqual(["【目标】", "【背景与约束】", "【现状】", "【概念方案】", "【验收标准】"]);
  });
});
