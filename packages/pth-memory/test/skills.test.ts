import { describe, it, expect } from "vitest";
import { buildSkillContent, listSkills, getSkill, parseSkillSummary, parseSkillMarkdown, maintainSkillWrite, maintainSkillArchive, proposeSkillMaintenance, reviewSkillProposal, approveSkillProposal, executeApprovedSkillProposal, importSkillMarkdown } from "@away_from/pth-memory";

const seed = {
  id: "test-sop",
  anchor: "执行测试任务",
  whenToUse: "需要验证时",
  effect: "得到可验证结果",
  procedure: [{ step: "跑测试", cost: "1×bash.run" }],
  pitfalls: ["不跑就交"],
  verification: ["全绿"],
};

/** B4 Phase 2：skill 检索面——Level 0 清单 / Level 1 全文（B4-3 已裁 C 两级检索） */
describe("skills 检索面（B4 Phase 2）", () => {
  const content = buildSkillContent(seed);

  it("parseSkillSummary 提取三要素", () => {
    const summary = parseSkillSummary({ id: "skill:test-sop", kind: "skill:test-sop", content, status: "official" });
    expect(summary).toMatchObject({ anchor: "执行测试任务", whenToUse: "需要验证时", effect: "得到可验证结果" });
  });

  it("listSkills 只列 skill: 前缀条目并稳定排序（Level 0）", async () => {
    const store = {
      listIds: async () => ["skill:b-sop", "task-insight", "skill:a-sop"],
      get: async (id: string) =>
        id.startsWith("skill:")
          ? { id, kind: id, content: buildSkillContent({ ...seed, id: id.slice(6) }), status: "official" }
          : undefined,
    };
    const list = await listSkills(store);
    expect(list.map((s) => s.id)).toEqual(["skill:a-sop", "skill:b-sop"]);
    expect(list[0]).toHaveProperty("anchor");
  });

  it("getSkill 自动补 skill: 前缀并返回全文（Level 1）", async () => {
    const store = {
      listIds: async () => ["skill:test-sop"],
      get: async (id: string) => ({ id, kind: id, content, status: "official" }),
    };
    expect((await getSkill(store, "test-sop"))?.content).toContain("【场景锚点】执行测试任务");
    expect((await getSkill(store, "skill:test-sop"))?.id).toBe("skill:test-sop");
  });
});

/** B4 Phase 3：skill 不可变 + memory-keeper 维护面 */
describe("skills.maintain（B4 Phase 3）", () => {
  function makeStore(initial: Record<string, { id: string; kind: string; content: string; status: string; meta: Record<string, unknown> }> = {}) {
    const rows = new Map(Object.entries(initial));
    return {
      listIds: async () => [...rows.keys()],
      get: async (id: string) => rows.get(id),
      write: async (entry: any, opts?: { force?: boolean }) => {
        if (entry.id.startsWith("skill:") && !opts?.force) throw new Error("系统文档受保护");
        rows.set(entry.id, entry);
      },
      update: async (id: string, patch: any, opts?: { force?: boolean }) => {
        if (id.startsWith("skill:") && !opts?.force) throw new Error("skill 条目不可变");
        const old = rows.get(id);
        if (!old) throw new Error("entry not found");
        rows.set(id, { ...old, ...patch, meta: { ...(old.meta ?? {}), ...(patch.meta ?? {}) } });
      },
      rows,
    };
  }

  it("新条目直写；已存在未 force → 拒绝；force 覆写 revision+1 留痕", async () => {
    const store = makeStore();
    const r1 = await maintainSkillWrite(store, { name: "test-sop", content: "v1" });
    expect(r1.ok).toBe(true);
    const after1 = await store.get("skill:test-sop");
    expect(after1?.meta).toMatchObject({ revision: 1, maintainedBy: "memory-keeper" });

    const r2 = await maintainSkillWrite(store, { name: "test-sop", content: "v2" });
    expect(r2.ok).toBe(false);
    const r3 = await maintainSkillWrite(store, { name: "test-sop", content: "v2", force: true, audit: "修正" });
    expect(r3.ok).toBe(true);
    expect((await store.get("skill:test-sop"))?.meta).toMatchObject({ revision: 2, auditNote: "修正" });
  });

  it("archive 旧条目（修订 = archive + 新条目）", async () => {
    const store = makeStore({ "skill:old": { id: "skill:old", kind: "skill:old", content: "old", status: "official", meta: {} } });
    const r = await maintainSkillArchive(store, "old", "被 new 取代");
    expect(r.ok).toBe(true);
    expect(store.rows.get("skill:old")?.status).toBe("archived");
  });

  it("W5 staged：提案 → adversarial pass → 批准 → 执行写", async () => {
    const store = makeStore();
    const proposal = await proposeSkillMaintenance(store, { action: "write", name: "staged-sop", content: "v1", audit: "固化" });
    expect(proposal.ok).toBe(true);

    const before = await maintainSkillWrite(store, { name: "staged-sop", content: "v1", proposalId: proposal.id }, { policy: "staged" });
    expect(before.ok).toBe(false);

    expect((await reviewSkillProposal(store, proposal.id!, "pass", "Pitfalls/Verification 可测，无作弊捷径")).ok).toBe(true);
    expect((await approveSkillProposal(store, proposal.id!)).ok).toBe(true);

    const after = await maintainSkillWrite(store, { name: "staged-sop", content: "v1", proposalId: proposal.id }, { policy: "staged" });
    expect(after.ok).toBe(true);
    expect(store.rows.get("skill:staged-sop")?.meta).toMatchObject({ proposalId: proposal.id });
  });

  it("W5 staged：未经 adversarial pass 不可批准", async () => {
    const store = makeStore();
    const proposal = await proposeSkillMaintenance(store, { action: "write", name: "x", content: "x" });
    expect((await approveSkillProposal(store, proposal.id!)).ok).toBe(false);
  });

  it("W5 staged：write 无 proposalId → 拒绝并明确引导走 propose（2026-08-18 L2 Q1 裁决）", async () => {
    const store = makeStore();
    const r = await maintainSkillWrite(store, { name: "no-proposal", content: "v1" }, { policy: "staged" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("proposalId");
    expect(r.error).toContain("skills.maintain.propose");   // 引导：staged 下 worker 必经治理入口
  });

  it("W5 staged：批准后 executeApprovedSkillProposal 执行 archive", async () => {
    const store = makeStore({ "skill:old": { id: "skill:old", kind: "skill:old", content: "old", status: "official", meta: {} } });
    const proposal = await proposeSkillMaintenance(store, { action: "archive", name: "old", audit: "废弃" });
    expect((await reviewSkillProposal(store, proposal.id!, "pass")).ok).toBe(true);
    expect((await approveSkillProposal(store, proposal.id!)).ok).toBe(true);
    const r = await executeApprovedSkillProposal(store, proposal.id!);
    expect(r.ok).toBe(true);
    expect(store.rows.get("skill:old")?.status).toBe("archived");
    expect(store.rows.get(proposal.id!)?.meta).toMatchObject({ stage: "executed" });
  });
});

/** B4 Phase 4：SKILL.md → 条目映射（0.13 转化落点） */
describe("SKILL.md → skill 条目映射（B4 Phase 4）", () => {
  it("四段式完整 → 解析为 seed，且与 buildSkillContent 往返一致", () => {
    const md = buildSkillContent(seed);
    const parsed = parseSkillMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.seed).toMatchObject({
      id: "test-sop",
      anchor: "执行测试任务",
      whenToUse: "需要验证时",
      effect: "得到可验证结果",
      procedure: [{ step: "跑测试", cost: "1×bash.run" }],
      pitfalls: ["不跑就交"],
      verification: ["全绿"],
    });
  });

  it("四段式缺段 → 失败（N4 pipeline 必须完整）", () => {
    expect(parseSkillMarkdown("# skill:bad\n【场景锚点】a\n【何时用】b\n【效果】c").ok).toBe(false);
  });
});

/** B3 / N4：SKILL.md → memory 条目转化 */
describe("importSkillMarkdown（N4 知识型分支）", () => {
  function makeStore() {
    const rows = new Map<string, any>();
    return {
      rows,
      listIds: async () => [...rows.keys()],
      get: async (id: string) => rows.get(id),
      write: async (entry: any, opts?: { force?: boolean }) => {
        if (entry.id.startsWith("skill:") && !opts?.force) throw new Error("系统文档受保护");
        rows.set(entry.id, entry);
      },
      update: async (id: string, patch: any, opts?: { force?: boolean }) => {
        if (id.startsWith("skill:") && !opts?.force) throw new Error("skill 不可变");
        const old = rows.get(id);
        if (!old) throw new Error("entry not found");
        rows.set(id, { ...old, ...patch, meta: { ...(old.meta ?? {}), ...(patch.meta ?? {}) } });
      },
    };
  }

  it("SKILL.md 完整 → 规范化为四段式并写入 skill:<name>", async () => {
    const store = makeStore();
    const r = await importSkillMarkdown(store, buildSkillContent(seed), { audit: "n4 导入" });
    expect(r.ok).toBe(true);
    const entry = store.rows.get("skill:test-sop");
    expect(entry?.content).toContain("【场景锚点】执行测试任务");
    expect(entry?.meta).toMatchObject({ maintainedBy: "memory-keeper", revision: 1, auditNote: "n4 导入" });
  });

  it("不完整 SKILL.md → 失败（不落库）", async () => {
    const store = makeStore();
    const r = await importSkillMarkdown(store, "# skill:bad\n【场景锚点】a\n【何时用】b\n【效果】c");
    expect(r.ok).toBe(false);
    expect(store.rows.size).toBe(0);
  });
});
