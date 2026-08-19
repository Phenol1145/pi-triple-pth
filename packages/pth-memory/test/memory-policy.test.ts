import { describe, it, expect } from "vitest";
import { layerOfKind, checkWrite, checkUpdate, normalizeWriteArgs } from "@away_from/pth-memory";

/**
 * memory-policy（用途层权限）包级测试——原 test/pth-kernel-execution/memory-policy.test.ts 迁入。
 * core 扩展包装（memoryExtension）相关用例保留在 test/pth-kernel-execution/memory-extension-policy.test.ts。
 */
describe("memory-policy 层分类（layerOfKind）", () => {
  it("prompt 层：系统提示词资产", () => {
    for (const k of ["role-doc", "role-doc:developer", "capability-index", "project-map", "pth-worker-system", "self-modify-guide", "skill", "skill:api-investigation", "extension-index"]) {
      expect(layerOfKind(k)).toBe("prompt");
    }
  });

  it("2026-08-15 筛查 H7：worker-role/space-reg/worker-index 系统恢复源 → prompt 层拒写", () => {
    for (const k of ["worker-role", "space-reg", "worker-index"]) {
      expect(layerOfKind(k)).toBe("prompt");
      expect(checkWrite(k, "official").ok).toBe(false);
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
    // N14 P3：工具注册提案——worker 可提交草案，强制 draft（流转走监督层）
    expect(layerOfKind("tool-proposal")).toBe("governance");
    expect(layerOfKind("tool-proposal:uuid")).toBe("governance");
  });

  it("knowledge 层：默认（共享知识）", () => {
    for (const k of ["task-insight", "tool-function", "dev-artifact", "memory", "bench-marker", "test-observation"]) {
      expect(layerOfKind(k)).toBe("knowledge");
    }
  });

  it("Index Memory 三类 kind 归 knowledge 层（导航元数据也走知识层写入门禁）", () => {
    for (const k of ["source-index", "symbol-index", "memory-collection-index"]) {
      expect(layerOfKind(k), k).toBe("knowledge");
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
    // N14 P3：tool-proposal 同款治理层——不可自批 official
    expect(checkWrite("tool-proposal", "official")).toEqual({ ok: true, forceStatus: "draft" });
  });

  it("knowledge 层放行（N29 P0-4：写入放行但强制 draft）", () => {
    expect(checkWrite("task-insight", "official")).toEqual({ ok: true, forceStatus: "draft" });
  });
});

/**
 * N29 L1（§1.6 P0-4）：worker/service/模板都不能取得 knowledge official 写权限。
 * 反例来源：docs/pth/n29-minimal-knowledge-intake-loop-feedback-plan.md §5 Task 1 Step 5。
 */
describe("N29 P0-4：worker knowledge write 强制 draft", () => {
  it("knowledge 层任意 kind/status 一律强制 draft（不再 direct official）", () => {
    for (const kind of ["task-insight", "domain-fact", "domain-method", "research-note", "tool-function", "pth-wiki"]) {
      expect(layerOfKind(kind), kind).toBe("knowledge");
      expect(checkWrite(kind, "official"), kind).toEqual({ ok: true, forceStatus: "draft" });
      expect(checkWrite(kind), kind).toEqual({ ok: true, forceStatus: "draft" });
      expect(checkWrite(kind, "archived"), kind).toEqual({ ok: true, forceStatus: "draft" });
      expect(checkWrite(kind, "draft"), kind).toEqual({ ok: true, forceStatus: "draft" });
    }
  });

  it("Index Memory 三类 kind 不能经 worker memory.write 自声明 official（强制 draft）", () => {
    for (const kind of ["source-index", "symbol-index", "memory-collection-index"]) {
      expect(layerOfKind(kind), kind).toBe("knowledge");
      expect(checkWrite(kind, "official"), kind).toEqual({ ok: true, forceStatus: "draft" });
      expect(checkWrite(kind), kind).toEqual({ ok: true, forceStatus: "draft" });
      expect(checkWrite(kind, "archived"), kind).toEqual({ ok: true, forceStatus: "draft" });
      expect(checkWrite(kind, "draft"), kind).toEqual({ ok: true, forceStatus: "draft" });
    }
  });

  it("策略不接受 principal/role 入参——service 与 platform-admin service 无法绕过", () => {
    // checkWrite 只按 (kind, status) 判定：任何调用主体（worker / service / platform-admin service）
    // 得到同一结论，不存在按角色放行 official 的分支。
    const asWorker = checkWrite("domain-fact", "official");
    const asService = checkWrite("domain-fact", "official");
    expect(asWorker).toEqual(asService);
    expect(asWorker.forceStatus).toBe("draft");
    expect(checkWrite.length).toBe(2);   // (kind, status) —— 无第三个 principal 参数
  });

  it("knowledge 层 update 不能把 draft 流转为 official（补 write 强制 draft 的同款洞）", () => {
    expect(checkUpdate("task-insight", "official").ok).toBe(false);
    expect(checkUpdate("domain-fact", "official").ok).toBe(false);
    // 非 official 的状态流转与纯内容修正不受影响
    expect(checkUpdate("task-insight", "archived").ok).toBe(true);
    expect(checkUpdate("task-insight").ok).toBe(true);
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
    expect(checkUpdate("differentiation-proposal").ok).toBe(true);   // 只改 content（未限定现状）
  });

  it("2026-08-15 筛查 H6：governance 层 official 条目内容冻结", () => {
    expect(checkUpdate("differentiation-proposal", undefined, "official").ok).toBe(false);
    expect(checkUpdate("differentiation-proposal", undefined, "draft").ok).toBe(true);
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
