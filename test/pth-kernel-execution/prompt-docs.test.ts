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

describe("API 调查技能（skill:api-investigation——探索方法论）", () => {
  it("skill 文档含调查方法（对象构成/签名/形状/读源码/试错）", async () => {
    const { API_INVESTIGATION_SKILL } = await import("../../src/pth/kernel/prompt-docs.js");
    expect(API_INVESTIGATION_SKILL).toContain("Object.keys");
    expect(API_INVESTIGATION_SKILL).toContain("fn.toString");
    expect(API_INVESTIGATION_SKILL).toContain("readSource");
    expect(API_INVESTIGATION_SKILL).toContain("先调查后调用");
    expect(API_INVESTIGATION_SKILL).toContain("错误信息是调试线索");
  });

  it("system prompt 含 API 调查技能触发指引（什么时候用+在哪读）", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt({ id: "developer", labelPatterns: [], prompt: "p" }, "t", { mode: "lazy" });
    expect(prompt).toContain("API 调查技能");
    expect(prompt).toContain("skill:api-investigation");
    expect(prompt).toContain("不要盲试");
  });

  it("skill 文档受保护（worker 不可覆盖）", async () => {
    const { isSystemDocId } = await import("../../src/pth/kernel/storage/memory-store-pg.js");
    expect(isSystemDocId("skill:api-investigation")).toBe(true);
  });
});

describe("PTH Worker 世界观（pth-worker-system——身份/工作流/框架）", () => {
  it("system prompt 含世界观（你在哪/工作流/框架事实/约束）——所有模式", async () => {
    const { buildAgentSystemPrompt, PTH_WORKER_SYSTEM } = await import("../../src/pth/kernel/execution/agent-loop.js");
    expect(PTH_WORKER_SYSTEM).toContain("PTH（Pi-Triple-Heavy）任务池的 worker");
    expect(PTH_WORKER_SYSTEM).toContain("任务池 → 角色路由 → worker 执行 → 产物提交");
    expect(PTH_WORKER_SYSTEM).toContain("先查 memory 既有资产");
    expect(PTH_WORKER_SYSTEM).toContain("不空 done");
    expect(PTH_WORKER_SYSTEM).toContain("sandbox 零敏感");
    // 注入在最前（角色之上）
    const prompt = await buildAgentSystemPrompt({ id: "developer", labelPatterns: [], prompt: "p" }, "t", { mode: "lazy" });
    expect(prompt.indexOf("PTH Worker 世界观")).toBeLessThan(prompt.indexOf("你的角色"));
  });

  it("世界观受保护（worker 不可覆盖）", async () => {
    const { isSystemDocId } = await import("../../src/pth/kernel/storage/memory-store-pg.js");
    expect(isSystemDocId("pth-worker-system")).toBe(true);
  });
});
