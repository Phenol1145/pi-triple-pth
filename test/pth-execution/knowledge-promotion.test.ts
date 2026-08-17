import { describe, expect, it } from "vitest";
import { buildKnowledgeProvenance, type MemoryEntry } from "@away_from/pth-memory";
import {
  canPromote,
  validateKnowledgeVerdict,
  type KnowledgeVerdict,
} from "../../src/pth/execution/knowledge-verdicts.js";
import {
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
  rejectKnowledgeEntry,
} from "../../src/pth/execution/knowledge-promotion.js";

/**
 * K4 Phase 4（N22）：候选验证与晋升闭环。
 * fake store 支持 get/update/write——write 时把 status/meta 更新（对齐设计 5 的 fake store 契约）。
 */
function makeStore(initial: MemoryEntry[] = []) {
  const rows = new Map<string, MemoryEntry>();
  const writeCalls: Array<{ entry: MemoryEntry; opts?: { force?: boolean; reason?: string; createdBy?: string } }> = [];
  for (const e of initial) rows.set(e.id, structuredClone(e));
  return {
    rows,
    writeCalls,
    async get(id: string, opts?: { tenantId?: string }) {
      const e = rows.get(id);
      if (!e) return undefined;
      if (opts?.tenantId && e.tenantId && e.tenantId !== opts.tenantId) return undefined;
      return structuredClone(e);
    },
    async update(
      id: string,
      patch: Partial<MemoryEntry> & { meta?: Record<string, unknown> },
      opts?: { tenantId?: string },
    ) {
      const e = rows.get(id);
      if (!e) throw new Error(`entry not found in tenant ${opts?.tenantId ?? "default"}`);
      if (opts?.tenantId && e.tenantId && e.tenantId !== opts.tenantId) {
        throw new Error(`entry not found in tenant ${opts.tenantId}`);
      }
      if (patch.content !== undefined) e.content = patch.content;
      if (patch.status !== undefined) e.status = patch.status;
      if (patch.meta !== undefined) e.meta = { ...(e.meta ?? {}), ...patch.meta };
    },
    async write(entry: MemoryEntry, opts?: { force?: boolean; reason?: string; createdBy?: string }) {
      writeCalls.push({ entry: structuredClone(entry), opts });
      rows.set(entry.id, structuredClone(entry));
    },
  };
}

function makeDraft(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const content = overrides.content ?? "The Earth orbits the Sun.";
  const producerRole = "developer";
  return {
    id: "cand-1",
    tenantId: "default",
    kind: "task-insight",
    anchors: ["science"],
    content,
    status: "draft",
    meta: {
      provenance: buildKnowledgeProvenance({
        content,
        sourceTaskId: "task-1",
        producerRole,
        producerModel: "deepseek-v4-flash",
        sourceRefs: ["task:task-1"],
      }),
      verdicts: [] as KnowledgeVerdict[],
    },
    ...overrides,
  };
}

function domainPass(reviewerRole = "domain:expert"): KnowledgeVerdict {
  return { kind: "domain", verdict: "pass", reviewerRole, note: "domain evidence verified", at: 1 };
}

function adversarialPass(reviewerRole = "controller:adversarial"): KnowledgeVerdict {
  return { kind: "adversarial", verdict: "pass", reviewerRole, note: "no shortcut / pitfall covered", at: 2 };
}

describe("validateKnowledgeVerdict（N22 1）", () => {
  it("合法 verdict 通过并返回规整对象", () => {
    const v = domainPass();
    const r = validateKnowledgeVerdict(v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toEqual(v);
  });

  it("kind/verdict/reviewerRole/note/at 非法 → 拒绝", () => {
    expect(validateKnowledgeVerdict({ ...domainPass(), kind: "bad" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), verdict: "maybe" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), reviewerRole: "" }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), note: "  " }).ok).toBe(false);
    expect(validateKnowledgeVerdict({ ...domainPass(), at: Number.NaN }).ok).toBe(false);
    expect(validateKnowledgeVerdict(null).ok).toBe(false);
    expect(validateKnowledgeVerdict("x").ok).toBe(false);
  });
});

describe("recordKnowledgeVerdict（N22 2）", () => {
  it("仅 draft 可审：official/archived 拒绝", async () => {
    const store = makeStore([makeDraft({ status: "official" as const })]);
    const r = await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("draft");
  });

  it("非法 verdict 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    const r = await recordKnowledgeVerdict(store as never, "cand-1", { ...domainPass(), note: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("note");
  });

  it("同 kind + reviewer 重复提交 → 幂等 ok 且不重复 append", async () => {
    const store = makeStore([makeDraft()]);
    const first = await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    const second = await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    const entry = store.rows.get("cand-1")!;
    const verdicts = entry.meta.verdicts as unknown[];
    expect(verdicts).toHaveLength(1);
  });

  it("producer 自审 → 拒绝（reviewerRole === provenance.producerRole）", async () => {
    const store = makeStore([makeDraft()]);
    const r = await recordKnowledgeVerdict(store as never, "cand-1", domainPass("developer"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("producer");
    expect((store.rows.get("cand-1")!.meta.verdicts as unknown[])).toHaveLength(0);
  });

  it("entry 不存在 → 拒绝", async () => {
    const store = makeStore();
    const r = await recordKnowledgeVerdict(store as never, "nope", domainPass());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });
});

describe("canPromote / promoteKnowledgeEntry（N22 1/2）", () => {
  it("缺任一 pass → promote 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("adversarial");
  });

  it("有 reject → promote 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    await recordKnowledgeVerdict(store as never, "cand-1", { kind: "adversarial", verdict: "reject", reviewerRole: "controller:adversarial", note: "pitfall missing", at: 3 });
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reject");
  });

  it("domain 与 adversarial reviewer 相同 → promote 拒绝", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass("controller:adversarial"));
    await recordKnowledgeVerdict(store as never, "cand-1", adversarialPass("controller:adversarial"));
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("differ");
  });

  it("producer 自核验（producerRole 等于 pass reviewer）→ promote 拒绝", async () => {
    const entry = makeDraft();
    entry.meta = {
      ...entry.meta,
      verdicts: [domainPass("developer"), adversarialPass()],
    };
    const store = makeStore([entry]);
    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("producer");
  });

  it("provenance 缺失/哈希不匹配 → canPromote 拒绝", () => {
    const good = makeDraft();
    const noVerdict = canPromote(good);
    expect(noVerdict.ok).toBe(false);
    if (!noVerdict.ok) expect(noVerdict.reason).toContain("domain");
    const noProv = makeDraft();
    (noProv.meta as Record<string, unknown>).provenance = undefined;
    const r = canPromote(noProv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("provenance");

    const badHash = makeDraft();
    (badHash.meta as Record<string, unknown>).provenance = buildKnowledgeProvenance({
      content: "tampered content",
      sourceTaskId: "task-1",
      producerRole: "developer",
      producerModel: "deepseek-v4-flash",
      sourceRefs: ["task:task-1"],
    });
    const r2 = canPromote(badHash);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("provenance");
  });

  it("全链：两个不同 reviewer pass → promote → official + promotion meta + write force 调用", async () => {
    const store = makeStore([makeDraft()]);
    expect((await recordKnowledgeVerdict(store as never, "cand-1", domainPass())).ok).toBe(true);
    expect((await recordKnowledgeVerdict(store as never, "cand-1", adversarialPass())).ok).toBe(true);

    const r = await promoteKnowledgeEntry(store as never, "cand-1");
    expect(r).toEqual({ ok: true, id: "cand-1" });

    const entry = store.rows.get("cand-1")!;
    expect(entry.status).toBe("official");
    expect(entry.meta.promotion).toMatchObject({
      promotedBy: "memory-keeper",
      verdicts: [domainPass(), adversarialPass()],
    });
    expect((entry.meta.promotion as { promotedAt?: unknown }).promotedAt).toEqual(expect.any(Number));

    expect(store.writeCalls).toHaveLength(1);
    expect(store.writeCalls[0].opts).toEqual({ force: true, reason: "knowledge-promotion", createdBy: "memory-keeper" });
    expect(store.writeCalls[0].entry.status).toBe("official");
    expect(store.writeCalls[0].entry.meta).toMatchObject({
      promotion: { promotedBy: "memory-keeper", promotedAt: expect.any(Number) },
    });
  });

  it("promoterRole 显式传入 → 写入 createdBy/promotedBy", async () => {
    const store = makeStore([makeDraft()]);
    await recordKnowledgeVerdict(store as never, "cand-1", domainPass());
    await recordKnowledgeVerdict(store as never, "cand-1", adversarialPass());
    const r = await promoteKnowledgeEntry(store as never, "cand-1", { promoterRole: "memory-keeper" });
    expect(r).toEqual({ ok: true, id: "cand-1" });
    expect((store.rows.get("cand-1")!.meta.promotion as { promotedBy?: unknown }).promotedBy).toBe("memory-keeper");
  });
});

describe("rejectKnowledgeEntry（N22 2）", () => {
  it("draft → 追加 reject verdict + status archived（不删内容）", async () => {
    const store = makeStore([makeDraft()]);
    const r = await rejectKnowledgeEntry(store as never, "cand-1", "domain:supervisor", "evidence insufficient");
    expect(r).toEqual({ ok: true });
    const entry = store.rows.get("cand-1")!;
    expect(entry.status).toBe("archived");
    expect(entry.content).toBe("The Earth orbits the Sun.");
    const verdicts = entry.meta.verdicts as unknown[];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      kind: "domain",
      verdict: "reject",
      reviewerRole: "domain:supervisor",
      note: "evidence insufficient",
    });
  });

  it("非 draft → 拒绝", async () => {
    const store = makeStore([makeDraft({ status: "official" as const })]);
    const r = await rejectKnowledgeEntry(store as never, "cand-1", "domain:supervisor", "late reject");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("draft");
  });

  it("controller:adversarial 的 reject → kind=adversarial", async () => {
    const store = makeStore([makeDraft()]);
    await rejectKnowledgeEntry(store as never, "cand-1", "controller:adversarial", "pitfall missing");
    const verdicts = store.rows.get("cand-1")!.meta.verdicts as unknown[];
    expect(verdicts[0]).toMatchObject({ kind: "adversarial", verdict: "reject" });
  });
});
