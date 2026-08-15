import { describe, it, expect } from "vitest";
import { buildMemorySweepTrigger, memorySweepSeconds, MEMORY_SWEEP_TRIGGER_NAME } from "../../src/pth/kernel/execution/memory-sweep-trigger.js";

/** B1 / N7：记忆维护定期触发接线 */
describe("memory-sweep-trigger（B1/N7）", () => {
  it("默认每天启用；PTH_MEMORY_SWEEP_SECONDS=0 禁用", () => {
    expect(memorySweepSeconds({})).toBe(24 * 60 * 60);
    expect(memorySweepSeconds({ PTH_MEMORY_SWEEP_SECONDS: "0" })).toBe(0);
    expect(buildMemorySweepTrigger({ PTH_MEMORY_SWEEP_SECONDS: "0" })).toBeNull();
  });

  it("巡检任务路由 memory-keeper，产出 archive 提案说明（不直接归档）", () => {
    const t = buildMemorySweepTrigger({ PTH_MEMORY_SWEEP_SECONDS: "3600" })!;
    expect(t.name).toBe(MEMORY_SWEEP_TRIGGER_NAME);
    expect(t.schedule).toEqual({ everySec: 3600 });
    expect(t.task.role).toBe("memory-keeper");
    expect(t.task.tags).toContain("auto-sweep");
    expect(t.task.text).toContain("memory-admin-proposal");
    expect(t.task.text).toContain("不要直接归档/删除");
  });
});
