import { describe, it, expect } from "vitest";
import { buildRoleDoc, buildCapabilityIndex } from "../../src/pth/kernel/prompt-docs.js";
import { DEFAULT_ROLES } from "../../src/pth/kernel/execution/worker-cluster.js";

describe("Prompt 框架化（角色文档/能力索引——memory 数据源）", () => {
  it("角色文档：覆盖全部内置角色（人设/任务类型/工作方式）", () => {
    for (const role of DEFAULT_ROLES) {
      const doc = buildRoleDoc(role);
      expect(doc).toContain(`# 角色：${role.id}`);
      expect(doc).toContain(role.prompt);
      expect(doc).toContain(role.labelPatterns.join(" / "));
      expect(doc).toContain("PTC 模式");
    }
  });

  it("能力索引：含全部能力函数（fs 全家/执行核/扩展）——新核接入点", () => {
    const idx = buildCapabilityIndex();
    expect(idx).toContain("fs.readSource");   // 自修改读源码
    expect(idx).toContain("fs.task.write");   // 任务工作区落盘
    expect(idx).toContain("memory.query");    // 标准能力
    expect(idx).toContain("python.execute");
    expect(idx).toContain("c.execute");
    expect(idx).toContain("ext");
    expect(idx).toContain("新能力接入");       // 扩展指引
  });

  it("能力索引与扩展 doc 聚合（buildDoc 同步）", () => {
    const idx = buildCapabilityIndex();
    expect(idx).toContain("results");
    expect(idx).toContain("context");
  });
});

describe("系统文档保护（静态上下文——worker 不可覆盖）", () => {
  it("isSystemDocId：角色文档/能力索引/自修改指南命中", async () => {
    const { isSystemDocId } = await import("../../src/pth/kernel/storage/memory-store-pg.js");
    expect(isSystemDocId("capability-index")).toBe(true);
    expect(isSystemDocId("self-modify-guide")).toBe(true);
    expect(isSystemDocId("role-doc:developer")).toBe(true);
    expect(isSystemDocId("task-insight-123")).toBe(false);
  });

  it("worker 覆盖系统文档 → 拒绝（非 force）", async () => {
    const { PgMemoryStore } = await import("../../src/pth/kernel/storage/memory-store-pg.js");
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const store = new PgMemoryStore({
      query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; },
    } as never);
    await expect(store.write({ id: "capability-index", kind: "x", anchors: ["a"], content: "污染" } as never))
      .rejects.toThrow(/受保护/);
    // 系统 force 写入通过（走 SQL）
    await store.write({ id: "capability-index", kind: "x", anchors: ["a"], content: "ok" } as never, { force: true });
    expect(queries.some((q) => q.sql.includes("INSERT INTO memory_entries"))).toBe(true);
  });
});
