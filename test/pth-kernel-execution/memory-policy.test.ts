import { describe, it, expect } from "vitest";
import { layerOfKind, checkWrite, checkUpdate, normalizeWriteArgs } from "../../src/pth/kernel/extensions/memory-policy.js";
import { memoryExtension } from "../../src/pth/kernel/extensions/memory.js";

describe("memory-policy 层分类（layerOfKind）", () => {
  it("prompt 层：系统提示词资产", () => {
    for (const k of ["role-doc", "role-doc:developer", "capability-index", "project-map", "pth-worker-system", "self-modify-guide", "skill", "skill:api-investigation", "extension-index"]) {
      expect(layerOfKind(k)).toBe("prompt");
    }
  });

  it("config 层：系统行为配置", () => {
    expect(layerOfKind("trigger")).toBe("config");
    expect(layerOfKind("refine-task")).toBe("config");
    expect(layerOfKind("refine-task:functions")).toBe("config");
  });

  it("governance 层：治理状态机", () => {
    expect(layerOfKind("differentiation-proposal")).toBe("governance");
    expect(layerOfKind("refine-report")).toBe("governance");
  });

  it("knowledge 层：默认（共享知识）", () => {
    for (const k of ["task-insight", "tool-function", "dev-artifact", "memory", "bench-marker", "test-observation"]) {
      expect(layerOfKind(k)).toBe("knowledge");
    }
  });
});

describe("memory-policy write 规则", () => {
  it("prompt 层拒写（role-doc/capability-index）", () => {
    expect(checkWrite("role-doc", "official").ok).toBe(false);
    expect(checkWrite("capability-index").ok).toBe(false);
  });

  it("config 层拒写（trigger——防 worker 自开触发器）", () => {
    const r = checkWrite("trigger", "official");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("config");
  });

  it("governance 层强制 draft（可提交草案，不可自批 official）", () => {
    const r1 = checkWrite("differentiation-proposal", "official");
    expect(r1).toEqual({ ok: true, forceStatus: "draft" });
    const r2 = checkWrite("differentiation-proposal");   // 未传 status 也强制
    expect(r2.forceStatus).toBe("draft");
  });

  it("knowledge 层放行", () => {
    expect(checkWrite("task-insight", "official")).toEqual({ ok: true });
  });
});

describe("memory-policy update 规则（补 isSystemDocId 不到 update 的洞）", () => {
  it("prompt/config 层拒绝 update", () => {
    expect(checkUpdate("role-doc", "official").ok).toBe(false);
    expect(checkUpdate("capability-index").ok).toBe(false);
    expect(checkUpdate("trigger").ok).toBe(false);
  });

  it("governance 层禁状态流转（draft 内容修正允许）", () => {
    expect(checkUpdate("differentiation-proposal", "official").ok).toBe(false);
    expect(checkUpdate("differentiation-proposal").ok).toBe(true);   // 只改 content
  });

  it("knowledge 层放行", () => {
    expect(checkUpdate("task-insight", "archived").ok).toBe(true);
  });
});

describe("normalizeWriteArgs（双签名归一）", () => {
  it("位置形 write(kind, content, opts) → 对象", () => {
    expect(normalizeWriteArgs("task-insight", "内容", { anchors: ["a"] }))
      .toMatchObject({ kind: "task-insight", content: "内容", anchors: ["a"] });
  });

  it("对象形 write({kind, content}) → 原样", () => {
    expect(normalizeWriteArgs({ kind: "task-insight", content: "x" }, undefined, undefined))
      .toMatchObject({ kind: "task-insight", content: "x" });
  });
});

describe("memory 能力包装（worker 面端到端）", () => {
  function makeMemory() {
    const written: Array<Record<string, unknown>> = [];
    const store = {
      write: async (e: Record<string, unknown>) => { written.push(e); },
      get: async (id: string) => (id === "role-doc:developer" ? { id, kind: "role-doc", anchors: [], content: "c", status: "official", meta: {} } : undefined),
      update: async () => {},
      retrieve: async () => [],
      listIds: async () => [],
      bumpHitCount: async () => {},
    };
    const ctx = {
      dataWorld: {
        memory: store,
        queryReadOnly: async () => [],
      },
    } as never;
    const caps = memoryExtension.provide(ctx as never) as { memory: Record<string, Function> };
    return { memory: caps.memory, written };
  }

  it("worker 写 trigger（config 层）→ 拒绝", async () => {
    const { memory, written } = makeMemory();
    await expect(memory["write"]({ kind: "trigger", content: "{}" })).rejects.toThrow(/config/);
    expect(written).toHaveLength(0);
  });

  it("worker 写分化提案 official → 强制 draft 落库", async () => {
    const { memory, written } = makeMemory();
    await memory["write"]({ kind: "differentiation-proposal", content: "{}", status: "official" });
    expect(written[0]).toMatchObject({ kind: "differentiation-proposal", status: "draft" });
  });

  it("worker 写知识层 → 原样放行", async () => {
    const { memory, written } = makeMemory();
    await memory["write"]({ kind: "task-insight", content: "洞察", status: "official" });
    expect(written[0]).toMatchObject({ status: "official" });
  });

  it("worker update 系统文档 → 拒绝（补洞）", async () => {
    const { memory } = makeMemory();
    await expect(memory["update"]("role-doc:developer", { content: "篡改" })).rejects.toThrow(/prompt/);
  });

  it("force 参数不透传（位置形第三参 force 也剥离）", async () => {
    const { memory, written } = makeMemory();
    // 位置形 + force 企图：normalize 后 force 进入 entry 字段但 store 调用不带 opts——store 层 isSystemDocId 仍生效
    await memory["write"]("task-insight", "x", { force: true, anchors: [] });
    expect(written[0]).toMatchObject({ kind: "task-insight" });
    // store.write 只收到单参 entry（无 opts.force 旁路）
  });
});

describe("queryReadOnly 表白名单（权限 v2 R2）", () => {
  it("memory_entries 放行（含 WHERE/LIMIT 加工）", async () => {
    const { buildReadOnlyQuery } = await import("../../src/pth/kernel/storage/index.js");
    expect(buildReadOnlyQuery("SELECT content FROM memory_entries WHERE kind='role-doc'")).toContain("LIMIT 50");
    expect(buildReadOnlyQuery("select id from memory_entries limit 999")).toContain("LIMIT 200");
  });

  it("业务表拒绝（tasks/transcripts/audit_log/credit_tx）+ 报错引导", async () => {
    const { buildReadOnlyQuery } = await import("../../src/pth/kernel/storage/index.js");
    await expect(async () => buildReadOnlyQuery("SELECT * FROM tasks")).rejects.toThrow(/不开放/);
    await expect(async () => buildReadOnlyQuery("SELECT body FROM transcripts LIMIT 5")).rejects.toThrow(/transcripts/);
    expect(() => buildReadOnlyQuery("SELECT * FROM audit_log")).toThrow(/obs\.tasks|obs\.search/);
    expect(() => buildReadOnlyQuery("SELECT * FROM credit_tx")).toThrow(/不开放/);
  });

  it("schema 前缀剥离（public.memory_entries 放行）+ 子查询内层表捕获", async () => {
    const { buildReadOnlyQuery } = await import("../../src/pth/kernel/storage/index.js");
    expect(buildReadOnlyQuery("SELECT id FROM public.memory_entries LIMIT 1")).toContain("memory_entries");
    expect(() => buildReadOnlyQuery("SELECT * FROM (SELECT * FROM tasks) t")).toThrow(/tasks/);
  });

  it("JOIN 表同样受检", async () => {
    const { buildReadOnlyQuery } = await import("../../src/pth/kernel/storage/index.js");
    expect(() => buildReadOnlyQuery("SELECT a.id FROM memory_entries a JOIN tasks t ON a.id = t.id")).toThrow(/tasks/);
  });
});
