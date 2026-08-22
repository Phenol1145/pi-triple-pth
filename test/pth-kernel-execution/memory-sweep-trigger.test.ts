import { describe, it, expect } from "vitest";
import { buildMemorySweepTrigger, memorySweepSeconds, MEMORY_SWEEP_TRIGGER_NAME } from "@away_from/pth-kernel-execution";
import { renderTaskTemplate } from "@away_from/pth-kernel-interpreter";

/** B1 / N7：记忆维护定期触发接线 */
describe("memory-sweep-trigger（B1/N7）", () => {
  it("默认每天启用；PTH_MEMORY_SWEEP_SECONDS=0 禁用", () => {
    expect(memorySweepSeconds({})).toBe(24 * 60 * 60);
    expect(memorySweepSeconds({ PTH_MEMORY_SWEEP_SECONDS: "0" })).toBe(0);
    expect(buildMemorySweepTrigger({ PTH_MEMORY_SWEEP_SECONDS: "0" })).toBeNull();
  });

  it("巡检任务引用 hidden 模板 memory-sweep，路由 memory-keeper；渲染内容仍含提案说明", () => {
    const t = buildMemorySweepTrigger({ PTH_MEMORY_SWEEP_SECONDS: "3600" })!;
    expect(t.name).toBe(MEMORY_SWEEP_TRIGGER_NAME);
    expect(t.schedule).toEqual({ everySec: 3600 });
    expect(t.task.template).toBe("memory-sweep");
    expect(t.task.role).toBe("memory-keeper");
    expect(t.task.tags).toEqual(["memory", "organize"]);   // 全部为已注册标签（auto-sweep 未注册会 400——2026-08-15 修复）
    const text = renderTaskTemplate("memory-sweep", {})!;
    expect(text).toContain("memory-admin-proposal");
    expect(text).toContain("不要直接归档/删除");
  });
});
