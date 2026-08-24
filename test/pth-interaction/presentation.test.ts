import { describe, it, expect } from "vitest";
import { composePresentation, composeTaskResult } from "../../src/pth/interaction/presentation.js";

describe("N25 Presentation / Output Composer", () => {
  it("对象转用户可读文本", () => {
    const text = composePresentation({ sum: 5050, ok: true });
    expect(text).toContain("sum: 5050");
  });

  it("JSON 格式保留结构", () => {
    const json = composePresentation({ a: 1 }, { format: "json" });
    expect(JSON.parse(json)).toEqual({ a: 1 });
  });

  it("任务结果 summary 优先", () => {
    expect(composeTaskResult({ ok: true, value: { x: 1 }, summary: "完成" })).toBe("完成");
    expect(composeTaskResult({ ok: false, summary: "失败" })).toBe("执行失败：失败");
  });
});
