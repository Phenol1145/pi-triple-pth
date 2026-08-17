import { describe, it, expect, beforeEach } from "vitest";
import { buildRoleDoc, buildCapabilityIndex } from "../../src/pth/kernel/prompt-docs.js";
import { DEFAULT_ROLES } from "../../src/pth/impls/roles/default-roles.js";
import { installDefaultRoles } from "../helpers";

beforeEach(() => installDefaultRoles());

describe("Prompt 框架化（角色文档/能力索引——memory 数据源）", () => {
  it("角色文档：覆盖全部内置角色（场景锚点三要素/人设/任务类型/工作方式——D4 2026-08-15）", () => {
    for (const role of DEFAULT_ROLES) {
      const doc = buildRoleDoc(role);
      expect(doc).toContain(`# 角色：${role.id}`);
      expect(doc).toContain(role.prompt);
      expect(doc).toContain(role.tags.join(" / "));
      expect(doc).toContain("PTC 模式");
      // D4：role-doc 文案三要素与工具 schema/能力索引同标准
      expect(doc).toContain("## 场景锚点三要素（T8）");
      expect(doc).toContain("- 【场景锚点】");
      expect(doc).toContain("- 【何时用】");
      expect(doc).toContain("- 【效果】");
    }
  });

  it("能力索引：含全部能力函数（fs 全家/执行核/扩展）——新核接入点", () => {
    const idx = buildCapabilityIndex();
    expect(idx).toContain("fs.readSource");   // 自修改读源码
    expect(idx).toContain("fs.task.write");   // 任务工作区落盘
    expect(idx).toContain("memory.query");    // 标准能力
    expect(idx).toContain("python.run");
    expect(idx).toContain("生产核");   // 2026-08-11：c.execute 撤销 → dev 空间指引
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
    const { isSystemDocId } = await import("@away_from/pth-memory");
    expect(isSystemDocId("capability-index")).toBe(true);
    expect(isSystemDocId("self-modify-guide")).toBe(true);
    expect(isSystemDocId("role-doc:developer")).toBe(true);
    expect(isSystemDocId("task-insight-123")).toBe(false);
  });

  it("worker 覆盖系统文档 → 拒绝（非 force）", async () => {
    const { PgMemoryStore } = await import("@away_from/pth-memory");
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const store = new PgMemoryStore({
      // K1b：write 事务化后走 client；fake pool 提供同形 connect/query（记录 SQL）
      connect: async () => ({
        query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; },
        release: async () => {},
      }),
      query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; },
    } as never);
    await expect(store.write({ id: "capability-index", kind: "x", anchors: ["a"], content: "污染" } as never))
      .rejects.toThrow(/受保护/);
    // 系统 force 写入通过（走 SQL）
    await store.write({ id: "capability-index", kind: "x", anchors: ["a"], content: "ok" } as never, { force: true });
    expect(queries.some((q) => q.sql.includes("INSERT INTO memory_entries"))).toBe(true);
  });
});

describe("角色 SOP 种子（B4 Phase 1 / B4-2 裁决 A——四段式 skill）", () => {
  it("injectPromptDocs 注入 3 条四段式种子（official + 受保护 + 每步代价）", async () => {
    const { injectPromptDocs } = await import("../../src/pth/kernel/prompt-docs.js");
    const written: Array<{ id?: string; kind?: string; status?: string; content?: string; meta?: Record<string, unknown> }> = [];
    const store = {
      write: async (entry: { id?: string; kind?: string; status?: string; content?: string; meta?: Record<string, unknown> }) => {
        written.push(entry);
      },
    };
    await injectPromptDocs(store as never);
    const ids = ["skill:developer-sop", "skill:scout-sop", "skill:memory-keeper-sop"];
    for (const id of ids) {
      const entry = written.find((w) => w.id === id);
      expect(entry, `缺少种子 ${id}`).toBeDefined();
      expect(entry!.kind).toBe("skill");
      expect(entry!.status).toBe("official");
      expect(entry!.meta?.source).toBe("injectPromptDocs");
      expect(entry!.meta?.format).toBe("skill-sop-v1");
      expect(entry!.content).toContain("## Procedure");
      expect(entry!.content).toContain("## Pitfalls");
      expect(entry!.content).toContain("## Verification");
      expect(entry!.content).toMatch(/（代价：.+）/);
    }
  });

  it("角色 SOP 种子受保护（worker 不可覆盖——id 前缀 skill:）", async () => {
    const { isSystemDocId } = await import("@away_from/pth-memory");
    expect(isSystemDocId("skill:developer-sop")).toBe(true);
    expect(isSystemDocId("skill:scout-sop")).toBe(true);
    expect(isSystemDocId("skill:memory-keeper-sop")).toBe(true);
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
    const prompt = await buildAgentSystemPrompt({ id: "developer", tags: [], prompt: "p" }, "t", { mode: "lazy" });
    expect(prompt).toContain("API 调查技能");
    expect(prompt).toContain("skill:api-investigation");
    expect(prompt).toContain("不要盲试");
  });

  it("skill 文档受保护（worker 不可覆盖）", async () => {
    const { isSystemDocId } = await import("@away_from/pth-memory");
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
    const prompt = await buildAgentSystemPrompt({ id: "developer", tags: [], prompt: "p" }, "t", { mode: "lazy" });
    expect(prompt.indexOf("PTH Worker 世界观")).toBeLessThan(prompt.indexOf("你的角色"));
  });

  it("世界观受保护（worker 不可覆盖）", async () => {
    const { isSystemDocId } = await import("@away_from/pth-memory");
    expect(isSystemDocId("pth-worker-system")).toBe(true);
  });
});

describe("项目全貌（project-map——代码库结构——worker 一次读知道在哪读什么）", () => {
  it("buildProjectMap 生成全貌（任务流/代码库结构/职责映射）", async () => {
    const { buildProjectMap } = await import("../../src/pth/kernel/prompt-docs.js");
    const map = await buildProjectMap();
    expect(map).toContain("PTH 项目全貌");
    expect(map).toContain("任务流");
    expect(map).toContain("agent-loop.ts");
    expect(map).toContain("执行层");
    expect(map).toContain("agent-loop");
    expect(map.length).toBeGreaterThan(1000);
  });

  it("project-map 受保护（worker 不可覆盖）", async () => {
    const { isSystemDocId } = await import("@away_from/pth-memory");
    expect(isSystemDocId("project-map")).toBe(true);
  });
});

describe("指针正确性回归（2026-08-10 bug——kind 误用导致 role-doc 从未生效）", () => {
  it("lazy roleBlock 指针按 id 查询（role-doc 存储结构：kind='role-doc' + id='role-doc:<id>'）", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt({ id: "developer", tags: [], prompt: "p" }, "t", { mode: "lazy" });
    expect(prompt).toContain("id='role-doc:developer'");
    expect(prompt).not.toContain("kind='role-doc:developer'");
  });

  it("eager 角色文档加载按 id 查询（能真正命中存储）", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    let capturedSql: string[] = [];
    const memory = { query: async (sql: string) => { capturedSql.push(sql); return [{ content: "角色文档全文" }]; } };
    const prompt = await buildAgentSystemPrompt({ id: "tester", tags: [], prompt: "p" }, "t", { mode: "eager", memory });
    const roleDocQuery = capturedSql.find((q) => q.includes("role-doc")) ?? "";
    expect(roleDocQuery).toContain("id='role-doc:tester'");
    expect(roleDocQuery).not.toContain("kind='role-doc:");
    expect(prompt).toContain("角色文档全文");   // eager 真正注入文档全文（不再静默回退 role.prompt）
  });

  it("skill 指针按 id 查询（skill:api-investigation 存储 kind='skill'）", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt({ id: "developer", tags: [], prompt: "p" }, "t", { mode: "lazy" });
    expect(prompt).toContain("id='skill:api-investigation'");
    expect(prompt).not.toContain("kind='skill:");
  });
});

describe("buildCapabilityIndex 分节（Agent-JIT 路径 B——filterCapabilityDoc 裁剪契约）", () => {
  it("含按包分节（基础/memory/fs/探索核/web-llm/扩展注册）", async () => {
    const { buildCapabilityIndex } = await import("../../src/pth/kernel/prompt-docs.js");
    const doc = buildCapabilityIndex();
    for (const sec of ["## 基础（全角色", "## memory", "## fs", "## 探索核", "## web/llm/state/ext/env", "## 扩展注册"]) {
      expect(doc).toContain(sec);
    }
    // 与 filterCapabilityDoc 契约：memory 角色裁剪后只留基础+memory
    const { filterCapabilityDoc } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const out = filterCapabilityDoc(doc, ["memory"]);
    expect(out).toContain("memory.query");
    expect(out).not.toContain("fs.readText");
    expect(out).not.toContain("python.run");
    expect(out).toContain("results（预置对象——步骤结果注册表）");
  });
});
