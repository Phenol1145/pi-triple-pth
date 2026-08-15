import { describe, it, expect } from "vitest";
import { applyOptimizerSuggestion, extractRuleLine } from "../../src/pth/kernel/execution/optimizer-apply.js";
import type { PgMemoryStore } from "@away_from/pth-memory";

/** 内存 fake store（get/update 语义对齐 PgMemoryStore） */
/** 每个测试独立建议对象（防共享对象状态污染——update 会改引用） */
function sug(over: Record<string, unknown> = {}): { id: string; kind: string; status: string; content: unknown; meta: Record<string, unknown> } {
  return { ...structuredClone(SUGGESTION), ...over };
}

function fakeStore(init: Array<{ id: string; kind: string; status: string; content: unknown; meta?: Record<string, unknown> }>) {
  const rows = [...init];
  return {
    _rows: rows,
    get: async (id: string) => rows.find((r) => r.id === id),
    update: async (id: string, patch: { content?: unknown; status?: string; meta?: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error(`update: id ${id} 不存在`);
      if (patch.content !== undefined) r.content = patch.content;
      if (patch.status !== undefined) r.status = patch.status;
      if (patch.meta !== undefined) r.meta = { ...(r.meta ?? {}), ...patch.meta };
    },
    write: async () => ({ ok: true }),
  } as unknown as PgMemoryStore;
}

const SUGGESTION = {
  id: "opt-test-1",
  kind: "optimizer-suggestion",
  status: "draft",
  content: {
    id: "opt-test-1",
    kind: "rule",
    target: "capability-index",
    section: "## 空间协议",
    content: "【优化建议 · gate-heavy】（窗口 10 任务 · 空间门控命中率高）\n证据: gated=9 steps=20\n建议规则: 空间工具使用前先 asp.index 确认当前空间工具面；门控消息即导航提示（不要重复尝试被拒工具）\n写入目标: capability-index §## 空间协议",
    evidence: { pattern: "gate-heavy", tasks: 10, metric: { gated: 9 } },
    status: "draft",
    ts: Date.now(),
  } as never,
  meta: {},
};

describe("优化建议批准应用器（闭环部署动作——2026-08-12）", () => {
  it("extractRuleLine：提取'建议规则:'行", () => {
    const text = "【优化建议 · gate-heavy】\n证据: x\n建议规则: 空间工具使用前先 asp.index\n写入目标: cap";
    expect(extractRuleLine(text)).toBe("空间工具使用前先 asp.index");
  });

  it("批准应用：capability-index 追加规则段落 + 建议转 official", async () => {
    const store = fakeStore([
      { id: "capability-index", kind: "capability-index", status: "official", content: "# PTH 能力索引\n## 基础" },
      sug(),
    ]);
    const r = await applyOptimizerSuggestion(store, "opt-test-1");
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual({ target: "capability-index", pattern: "gate-heavy" });
    const idx = store._rows.find((x) => x.id === "capability-index")!;
    expect(String(idx.content)).toContain("【优化规则 · gate-heavy");
    expect(String(idx.content)).toContain("空间工具使用前先 asp.index");
    expect(String(idx.content)).toContain("# PTH 能力索引\n## 基础");   // 原内容保留
    expect(store._rows.find((x) => x.id === "opt-test-1")!.status).toBe("official");
  });

  it("幂等：非 draft 拒绝；已应用规则去重不堆积", async () => {
    const store = fakeStore([
      { id: "capability-index", kind: "capability-index", status: "official", content: "base" },
      sug({ id: "opt-done", status: "official" }),
    ]);
    const r1 = await applyOptimizerSuggestion(store, "opt-done");
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("仅 draft 可批准");
    // 同规则二次应用：content 已含规则 → 去重（不追加）
    // 已应用场景：base 含完整规则行（前 40 字符命中→去重不追加）
    const fullRule = "空间工具使用前先 asp.index 确认当前空间工具面；门控消息即导航提示（不要重复尝试被拒工具）";
    const store2 = fakeStore([
      { id: "capability-index", kind: "capability-index", status: "official", content: `base【优化规则 · gate-heavy】${fullRule}` },
      sug({ id: "opt-dup" }),
    ]);
    const r2 = await applyOptimizerSuggestion(store2, "opt-dup");
    expect(r2.ok).toBe(true);
    const idx2 = store2._rows.find((x) => x.id === "capability-index")!;
    expect(String(idx2.content)).toBe(`base【优化规则 · gate-heavy】${fullRule}`);   // 无重复追加
  });

  it("text 列形态：content 为 JSON 字符串（真实存储——get 返回字符串）", async () => {
    const store = fakeStore([
      { id: "capability-index", kind: "capability-index", status: "official", content: "base" },
      { ...sug(), id: "opt-str", content: JSON.stringify(SUGGESTION.content) },
    ]);
    const r = await applyOptimizerSuggestion(store, "opt-str");
    expect(r.ok).toBe(true);
    expect(String(store._rows.find((x) => x.id === "capability-index")!.content)).toContain("优化规则");
  });

  it("role-doc 目标：role-doc:<role> 追加规则", async () => {
    const store = fakeStore([
      { id: "role-doc:executor", kind: "role-doc", status: "official", content: "你是执行者。" },
      sug({ id: "opt-role", content: { ...(SUGGESTION.content as never as Record<string, unknown>), target: "role-doc:executor" } }),
    ]);
    const r = await applyOptimizerSuggestion(store, "opt-role");
    expect(r.ok).toBe(true);
    expect(r.applied?.target).toBe("role-doc:executor");
    expect(String(store._rows.find((x) => x.id === "role-doc:executor")!.content)).toContain("优化规则");
  });

  it("不支持的目标拒绝（人工部署）", async () => {
    const store = fakeStore([
      sug({ id: "opt-x", content: { ...(SUGGESTION.content as never as Record<string, unknown>), target: "lineage:executor" } }),
    ]);
    const r = await applyOptimizerSuggestion(store, "opt-x");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不可逆大变");
  });

  it("建议不存在拒绝", async () => {
    const r = await applyOptimizerSuggestion(fakeStore([]), "nope");
    expect(r.ok).toBe(false);
  });
});


describe("复测任务派发（2026-08-14 N6 一等化——apply 后受控复现）", () => {
  it("role-doc 目标：派发复测任务（flow 路由到目标角色 + verifyOf payload）", async () => {
    const roleSug = sug({
      content: {
        ...(structuredClone(SUGGESTION.content as Record<string, unknown>)),
        target: "role-doc:developer",
        evidence: { pattern: "rep-fail", tasks: 10, metric: { fails: 8 } },
        content: "【优化建议 · rep-fail】\n建议规则: 失败一次后先读错误信息再重试\n写入目标: role-doc:developer",
      },
    });
    const store = fakeStore([
      roleSug,
      { id: "role-doc:developer", kind: "role-doc", status: "official", content: "前文" },
    ]);
    const published: Array<Record<string, unknown>> = [];
    const r = await applyOptimizerSuggestion(store, "opt-test-1", undefined, async (t) => { published.push(t); });
    expect(r.ok).toBe(true);
    expect(published).toHaveLength(1);
    const p = published[0]!;
    expect(p.title).toContain("复测");
    expect(p.title).toContain("rep-fail");
    expect(p.text).toContain("受控复现");
    expect((p.payload as Record<string, unknown>).verifyOf).toBe("opt-test-1");
    expect(JSON.stringify(p.payload)).toContain("developer");   // flow 路由到目标角色
    // verifyTaskPublished 落 meta
    expect(roleSug.meta["verifyTaskPublished"]).toBe(true);
    expect(roleSug.status).toBe("official");
  });

  it("capability-index 目标：不派发任务（无单一角色——走全局聚合复测）", async () => {
    const store = fakeStore([
      sug(),
      { id: "capability-index", kind: "capability-index", status: "official", content: "前文" },
    ]);
    const published: Array<Record<string, unknown>> = [];
    const r = await applyOptimizerSuggestion(store, "opt-test-1", undefined, async (t) => { published.push(t); });
    expect(r.ok).toBe(true);
    expect(published).toHaveLength(0);
  });

  it("派发失败 → 降级有机窗口复测（apply 不失败）", async () => {
    const store = fakeStore([
      sug({
        content: { ...(structuredClone(SUGGESTION.content as Record<string, unknown>)), target: "role-doc:developer", evidence: { pattern: "p", tasks: 1, metric: {} }, content: "【优化建议 · p】\n建议规则: 规则\n写入目标: role-doc:developer" },
      }),
      { id: "role-doc:developer", kind: "role-doc", status: "official", content: "前文" },
    ]);
    const r = await applyOptimizerSuggestion(store, "opt-test-1", undefined, async () => { throw new Error("publish down"); });
    expect(r.ok).toBe(true);   // 派发失败不阻断 apply
    expect((store._rows.find((x) => x.id === "opt-test-1") as { meta: Record<string, unknown> }).meta["verifyTaskPublished"]).toBe(false);
  });
});
