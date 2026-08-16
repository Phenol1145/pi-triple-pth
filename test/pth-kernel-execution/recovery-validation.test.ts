import { describe, it, expect } from "vitest";
import { parseWorkerRoleRecovery, parseSpaceRecovery } from "../../src/pth/kernel/execution/recovery-validation.js";

describe("装配恢复来源校验（H7）", () => {
  const role = { id: "auditor", parent: "origin", tags: ["audit"], prompt: "p" };

  it("worker-role：可信来源 + 合法形状通过", () => {
    const r = parseWorkerRoleRecovery({ content: JSON.stringify(role), meta: { source: "lineage-approve" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe("auditor");
  });

  it("worker-role：来源缺失/伪造 official 拒绝", () => {
    expect(parseWorkerRoleRecovery({ content: JSON.stringify(role), meta: {} }).ok).toBe(false);
    expect(parseWorkerRoleRecovery({ content: JSON.stringify(role), meta: { source: "worker" } }).ok).toBe(false);
  });

  it("worker-role：结构非法拒绝（id/tags/prompt）", () => {
    for (const bad of [
      { ...role, id: "BAD ID" },
      { ...role, tags: [] },
      { ...role, prompt: "" },
    ]) {
      expect(parseWorkerRoleRecovery({ content: JSON.stringify(bad), meta: { source: "lineage-approve" } }).ok).toBe(false);
    }
    expect(parseWorkerRoleRecovery({ content: "not-json", meta: { source: "lineage-approve" } }).ok).toBe(false);
  });

  it("space-reg：父空间必须存在且 execTool 白名单", () => {
    const hasParent = (id: string) => id === "dev";
    const good = { id: "sandboxed", parent: "dev", execTool: "ts" };
    const r = parseSpaceRecovery({ content: JSON.stringify(good), meta: {} }, hasParent);
    expect(r.ok).toBe(true);
    expect(parseSpaceRecovery({ content: JSON.stringify({ ...good, parent: "ghost" }), meta: {} }, hasParent).ok).toBe(false);
    expect(parseSpaceRecovery({ content: JSON.stringify({ ...good, execTool: "rust" }), meta: {} }, hasParent).ok).toBe(false);
  });
});
