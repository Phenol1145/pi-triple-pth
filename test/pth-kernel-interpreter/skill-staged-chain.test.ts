import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCapabilities } from "../../src/pth/impls/kernels/capability.js";
import { TriggerEngine } from "../../src/pth/kernel/execution/trigger-engine.js";
import { registerSystemTriggers } from "../../src/pth/kernel/execution/system-triggers.js";
import { resetPthConfig } from "../../src/pth/config/config-center.js";
import { approveSkillProposal, buildKnowledgeProvenance, executeApprovedSkillProposal } from "@away_from/pth-memory";
import {
  computeCandidateHash,
  sourceBindingsDigestOf,
  type KnowledgeVerdictRowRecord,
  type VerificationPlanRecord,
} from "../../src/pth/execution/knowledge-verdicts.js";
import type { KnowledgeVerificationRepo } from "../../src/pth/execution/knowledge-promotion.js";
import { createInMemoryPromoteOfficial } from "../helpers";

/**
 * L2（2026-08-18）：skill staged 审核流端到端链路。
 * 用户裁决：Q1 write 拒绝 + 引导 propose；Q2 事件驱动自动派发审核任务。
 *
 * 链路：memory-keeper skills.maintain.propose（staged 策略）
 *   → skill.proposal.created 事件（capability 发出）
 *   → trigger-engine 监听 → 自动派发 controller:adversarial 审核任务
 *   → adversarial skills.review(pass/reject)
 *   → 监督批准（approveSkillProposal + executeApprovedSkillProposal——gateway 通道同款调用）
 *   → skill 条目 official 落库
 */

/** 共享内存 store（与 pth-memory staged 测试同款形状 + retrieve） */
function makeStore() {
  const rows = new Map<string, { id: string; kind: string; content: string; status: string; anchors?: string[]; meta?: Record<string, unknown> }>();
  return {
    rows,
    listIds: async () => [...rows.keys()],
    get: async (id: string) => rows.get(id),
    retrieve: async (opts: { kinds?: string[]; status?: string[] } = {}) =>
      [...rows.values()].filter((r) =>
        (!opts.kinds || opts.kinds.includes(r.kind)) && (!opts.status || opts.status.includes(r.status))),
    write: async (entry: never, opts?: { force?: boolean }) => {
      const e = entry as { id: string };
      if (e.id.startsWith("skill:") && !opts?.force) throw new Error("系统文档受保护");
      rows.set(e.id, entry as never);
    },
    update: async (id: string, patch: Record<string, unknown>, opts?: { force?: boolean }) => {
      if (id.startsWith("skill:") && !opts?.force) throw new Error("skill 条目不可变");
      const old = rows.get(id);
      if (!old) throw new Error("entry not found");
      rows.set(id, { ...old, ...patch, meta: { ...(old.meta ?? {}), ...((patch.meta ?? {}) as Record<string, unknown>) } } as never);
    },
    promoteOfficial: createInMemoryPromoteOfficial(rows),
  };
}

function fakeDataWorld(store: ReturnType<typeof makeStore>) {
  return {
    memory: store,
    tasks: { publish: async () => ({}) },
    queryReadOnly: async () => [],
    queryTemplate: async () => [],
    pgStat: async () => [],
  };
}

const fakeToolstore = { readText: async () => "", list: async () => [], listDirs: async () => [] };

/** R3/P1-2：capability 注入缝使用的内存 verification repo（与 facade 可选注入同构）。 */
function makeVerificationRepo() {
  const plans = new Map<string, VerificationPlanRecord>();
  const rows = new Map<string, KnowledgeVerdictRowRecord>();
  let nextId = 1;
  const repo: KnowledgeVerificationRepo = {
    async getPlan(planId, tenantId) {
      const p = plans.get(planId);
      if (!p || p.tenantId !== tenantId) return undefined;
      return structuredClone(p);
    },
    async listVerdictRows(planId, tenantId) {
      return [...rows.values()]
        .filter((r) => r.planId === planId && r.tenantId === tenantId)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((r) => structuredClone(r));
    },
    async insertVerdictRow(row) {
      const key = `${row.planId}::${row.checkId}::${row.principalId}`;
      const existing = rows.get(key);
      if (existing) {
        const same = existing.candidateId === row.candidateId
          && existing.candidateRevision === row.candidateRevision
          && existing.candidateHash === row.candidateHash
          && existing.executionId === row.executionId
          && existing.kind === row.kind
          && existing.verdict === row.verdict
          && existing.reviewerRole === row.reviewerRole
          && existing.note === row.note
          && (existing.domainId ?? null) === (row.domainId ?? null)
          && JSON.stringify(existing.evidence) === JSON.stringify(row.evidence)
          && existing.at === row.at;
        return same
          ? { ok: true, idempotent: true }
          : { ok: false, error: "verdict conflict: same plan/check/principal with different payload" };
      }
      rows.set(key, { ...row, id: nextId++, rowVersion: 1, createdAt: new Date().toISOString() });
      return { ok: true, idempotent: false };
    },
    async setPlanStatus(planId, tenantId, status) {
      const p = plans.get(planId);
      if (p && p.tenantId === tenantId) {
        p.status = status;
        p.rowVersion += 1;
        p.updatedAt = new Date().toISOString();
      }
    },
  };
  return { repo, plans, rows };
}

/** N29 再验收 P0-5：candidate/plan 固定携带一条内部 evidence 引用（空绑定不再可晋升）。 */
const KNOWLEDGE_EVIDENCE = [{ sourceId: "task:task-1", locator: "task-output#1" }];

function makePlanFor(entryId: string, overrides: Partial<VerificationPlanRecord> = {}): VerificationPlanRecord {
  const content = "Earth orbits the Sun.";
  return {
    id: `plan-${entryId}`,
    tenantId: "default",
    candidateId: entryId,
    candidateRevision: 1,
    candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence: KNOWLEDGE_EVIDENCE, effect: null }),
    requiredDomains: ["mathematics"],
    checks: [
      { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: ["tenant:tenant-a:platform-admin"], separationFrom: ["producer", "other-verifier"] },
      { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: ["worker:controller:adversarial"], separationFrom: ["producer", "other-verifier"] },
    ],
    sourceBindingsDigest: sourceBindingsDigestOf(KNOWLEDGE_EVIDENCE),
    status: "open",
    rowVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function keeperCaps(store: ReturnType<typeof makeStore>, events: Array<{ kind: string; detail?: string }>) {
  return buildCapabilities({
    llm: async () => ({ text: "" }) as never,
    dataWorld: fakeDataWorld(store) as never,
    toolstore: fakeToolstore as never,
    roleId: "memory-keeper",
    onActivity: (e) => events.push(e),
  });
}

describe("L2：skill staged 审核流端到端（提案 → 事件派发 → 对抗性审核 → 批准 → 落库）", () => {
  beforeEach(() => {
    resetPthConfig({ ...process.env, PTH_SKILL_WRITE_POLICY: "staged" });
  });
  afterEach(() => {
    resetPthConfig(process.env);
  });

  it("staged 下 maintain.write 无 proposalId → 拒绝并引导 propose（Q1）", async () => {
    const store = makeStore();
    const caps = keeperCaps(store, []);
    const maintain = (caps["skills"] as { maintain: { write: (i: unknown) => Promise<{ ok: boolean; error?: string }> } }).maintain;
    const r = await maintain.write({ name: "direct-write", content: "v1" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("skills.maintain.propose");
  });

  it("全链 pass：propose → skill.proposal.created 事件 → trigger 派发审核任务 → review pass → 批准执行 → 条目 official", async () => {
    const store = makeStore();
    const events: Array<{ kind: string; detail?: string }> = [];
    // ① memory-keeper 提案（staged 策略——write 被拒，propose 是入口）
    const caps = keeperCaps(store, events);
    const maintain = (caps["skills"] as {
      maintain: { propose: (i: unknown) => Promise<{ ok: boolean; id?: string }> };
    }).maintain;
    const proposal = await maintain.propose({ action: "write", name: "chain-sop", content: "四段式内容", audit: "固化" });
    expect(proposal.ok).toBe(true);
    // ② 事件发出（detail = 提案 id）
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "skill.proposal.created", role: "memory-keeper", detail: proposal.id });

    // ③ trigger-engine 事件驱动派发（真实引擎 + fake hub/tasks）
    const published: Array<{ title: string; text: string; tags: string[] }> = [];
    let handler: ((e: { kind: string; detail?: string; at: number }) => void) | null = null;
    const hub = {
      publish: (e: { kind: string; detail?: string; at: number }) => handler?.(e),
      subscribe: (h: typeof handler) => { handler = h; return () => { handler = null; }; },
    };
    const engine = new TriggerEngine({
      activityHub: hub as never,
      tasks: {
        publish: async (t: { title: string; text: string; tags: string[] }) => { published.push(t); return { id: "task-review-1" }; },
        getById: async () => null,
      } as never,
      memory: store as never,
      scheduleTickMs: 10_000,
    });
    registerSystemTriggers(engine as never, {
      env: {},
      claimTimeoutMs: 600_000, claimReapMs: 30_000,
      watchdogIntervalMs: 30_000, resolverIntervalMs: 2_000,
    });
    await engine.start();
    hub.publish(events[0] as { kind: string; detail?: string; at: number });
    await new Promise((r) => setTimeout(r, 50));   // onEvent 异步 publish 落定
    engine.stop();
    expect(published).toHaveLength(1);
    expect(published[0].tags).toEqual(["adversarial"]);
    expect(published[0].text).toContain(proposal.id!);
    expect(published[0].text).toContain("skills.review");

    // ④ controller:adversarial 审核 pass（capability 注入面）
    const advCaps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "controller:adversarial",
    });
    const review = (advCaps["skills"] as { review: (id: string, verdict: "pass" | "reject", note?: string) => Promise<{ ok: boolean }> }).review;
    expect((await review(proposal.id!, "pass", "Pitfalls 完整 / Verification 可证伪 / 无作弊捷径")).ok).toBe(true);

    // ⑤ 监督批准 + 执行（gateway approveMemoryAdmin 同款调用序列）
    expect((await approveSkillProposal(store as never, proposal.id!)).ok).toBe(true);
    const executed = await executeApprovedSkillProposal(store as never, proposal.id!);
    expect(executed.ok).toBe(true);
    const entry = store.rows.get("skill:chain-sop")!;
    expect(entry.status).toBe("official");
    expect(entry.content).toBe("四段式内容");
    expect(entry.meta).toMatchObject({ proposalId: proposal.id, maintainedBy: "memory-keeper" });
  });

  it("reject 分支：adversarial 拒绝 → 监督不可批准（链路在审核处闭合）", async () => {
    const store = makeStore();
    const caps = keeperCaps(store, []);
    const maintain = (caps["skills"] as {
      maintain: { propose: (i: unknown) => Promise<{ ok: boolean; id?: string }> };
    }).maintain;
    const proposal = await maintain.propose({ action: "write", name: "bad-sop", content: "作弊捷径内容" });
    const advCaps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "controller:adversarial",
    });
    const review = (advCaps["skills"] as { review: (id: string, verdict: "pass" | "reject", note?: string) => Promise<{ ok: boolean; error?: string }> }).review;
    const r = await review(proposal.id!, "reject", "Pitfalls 缺失——未覆盖已知失败模式");
    expect(r.ok).toBe(false);
    // 拒绝后不可批准（approveSkillProposal 要求 verdict=pass）
    const approved = await approveSkillProposal(store as never, proposal.id!);
    expect(approved.ok).toBe(false);
    expect(store.rows.has("skill:bad-sop")).toBe(false);
  });

  it("非 adversarial 角色无 skills.review 注入（审核面按角色收窄）", () => {
    const store = makeStore();
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "developer",
    });
    expect((caps["skills"] as Record<string, unknown>)["review"]).toBeUndefined();
  });
});

describe("K4 Phase 4：knowledge 写能力按角色注入（N22 3）", () => {
  function seedCandidate(store: ReturnType<typeof makeStore>) {
    const content = "Earth orbits the Sun.";
    store.rows.set("cand-1", {
      id: "cand-1",
      kind: "task-insight",
      content,
      status: "draft",
      anchors: ["science"],
      meta: {
        version: 1,
        provenance: buildKnowledgeProvenance({
          content,
          sourceTaskId: "task-1",
          producerRole: "developer",
          producerModel: "deepseek-v4-flash",
          sourceRefs: ["task:task-1"],
        }),
        // N29 再验收 P0-5：canPromote 删除了空 evidence/空 digest 兼容路径——candidate 必须显式声明来源绑定。
        evidence: KNOWLEDGE_EVIDENCE,
        verdicts: [],
      },
    });
    return "cand-1";
  }

  it("controller:adversarial 有 knowledge.review，且落 verdict 为 adversarial", async () => {
    const store = makeStore();
    const entryId = seedCandidate(store);
    const { repo, plans, rows: verdictRows } = makeVerificationRepo();
    const plan = makePlanFor(entryId, { status: "open" });
    plans.set(plan.id, plan);
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "controller:adversarial",
      verificationRepo: repo,
    });
    const review = (caps["knowledge"] as {
      review: (i: { planId: string; checkId: string; expectedCandidateRevision: number; verdict: "pass" | "reject"; note: string }) => Promise<{ ok: boolean; error?: string }>;
    }).review;
    const r = await review({ planId: plan.id, checkId: "adv-1", expectedCandidateRevision: 1, verdict: "pass", note: "no shortcut" });
    expect(r).toEqual({ ok: true });
    // 新模型：verdict 落 plan 行，不 append entry.meta.verdicts。
    expect((store.rows.get(entryId)!.meta as { verdicts?: unknown[] }).verdicts ?? []).toHaveLength(0);
    expect([...verdictRows.values()]).toHaveLength(1);
    expect([...verdictRows.values()][0]).toMatchObject({
      planId: plan.id,
      checkId: "adv-1",
      kind: "adversarial",
      verdict: "pass",
      reviewerRole: "controller:adversarial",
      candidateRevision: 1,
    });
  });

  it("memory-keeper 有 knowledge.promote，可把合规候选晋升 official", async () => {
    const store = makeStore();
    const entryId = seedCandidate(store);
    const { repo, plans } = makeVerificationRepo();
    const plan = makePlanFor(entryId, { status: "satisfied" });
    plans.set(plan.id, plan);
    await repo.insertVerdictRow({
      planId: plan.id,
      tenantId: plan.tenantId,
      checkId: "domain-1",
      candidateId: entryId,
      candidateRevision: 1,
      candidateHash: plan.candidateHash,
      principalId: "tenant:tenant-a:platform-admin",
      executionId: "task-d",
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "verified",
      domainId: "mathematics",
      evidence: [],
      at: 1,
    });
    await repo.insertVerdictRow({
      planId: plan.id,
      tenantId: plan.tenantId,
      checkId: "adv-1",
      candidateId: entryId,
      candidateRevision: 1,
      candidateHash: plan.candidateHash,
      principalId: "worker:controller:adversarial",
      executionId: "task-a",
      kind: "adversarial",
      verdict: "pass",
      reviewerRole: "controller:adversarial",
      note: "no shortcut",
      evidence: [],
      at: 2,
    });
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "memory-keeper",
      verificationRepo: repo,
    });
    const promote = (caps["knowledge"] as {
      promote: (i: { entryId: string; planId: string; expectedCandidateRevision: number }) => Promise<{ ok: boolean; id?: string; error?: string }>;
    }).promote;
    const r = await promote({ entryId, planId: plan.id, expectedCandidateRevision: 1 });
    expect(r).toEqual({ ok: true, id: entryId });
    expect(store.rows.get(entryId)!.status).toBe("official");
    expect(store.rows.get(entryId)!.meta).toMatchObject({
      promotion: { promotedBy: "memory-keeper" },
    });
  });

  it("developer 无 knowledge 写能力注入", () => {
    const store = makeStore();
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "developer",
    });
    expect(caps["knowledge"]).toBeUndefined();
  });
});
