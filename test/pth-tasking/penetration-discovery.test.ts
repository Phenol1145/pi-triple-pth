import { beforeAll, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";
import {
  PENETRATION_PROPOSAL_KIND,
  approvePenetrationProposal,
  discoverPenetrationProposals,
  evaluateEdge,
  executeApprovedPenetrationProposal,
  parseEdgeAggregate,
  type PenetrationDiscoveryConfig,
  type PenetrationDiscoveryMemoryEntry,
  type PenetrationDiscoveryStore,
  type PenetrationEdgeAggregate,
  type PenetrationProposalContent,
} from "../../src/pth/tasking/penetration-discovery.js";
import { parsePenetrationSkillContent } from "../../src/pth/tasking/penetration-skill.js";

beforeAll(() => {
  installDefaultRoles();
});

function edgeAggregate(over: Partial<PenetrationEdgeAggregate> = {}): PenetrationEdgeAggregate {
  return {
    parent: "developer",
    child: "coder",
    calls: 10,
    okCalls: 9,
    sumSteps: 100,
    sumDurationMs: 5_000,
    sumBudgetExceeded: 1,
    ...over,
  };
}

const DISCOVERY_CONFIG: PenetrationDiscoveryConfig = {
  minCalls: 5,
  minOkRatio: 0.8,
  maxAvgSteps: 60,
};

/** 捕获型 fake store（PgMemoryStore 结构同形） */
function fakeStore(entries: Record<string, PenetrationDiscoveryMemoryEntry> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    store: {
      get: async (id: string) => map.get(id),
      write: async (entry: PenetrationDiscoveryMemoryEntry) => { map.set(entry.id, { ...entry }); },
      update: async (id: string, patch: Partial<PenetrationDiscoveryMemoryEntry>) => {
        const prev = map.get(id);
        if (!prev) throw new Error(`entry not found: ${id}`);
        map.set(id, { ...prev, ...patch, meta: { ...(prev.meta ?? {}), ...(patch.meta ?? {}) } });
      },
    } satisfies PenetrationDiscoveryStore,
  };
}

function proposalEntry(over: Partial<PenetrationDiscoveryMemoryEntry> = {}): PenetrationDiscoveryMemoryEntry {
  const content: PenetrationProposalContent = {
    action: "register",
    spec: {
      parent: "developer",
      child: "coder",
      inputContract: "developer 提交的自包含任务描述（标题+正文）——与直投任务文本同构",
      outputContract: "done.result 为父任务验收口径的产物；失败回流错误摘要",
      anchor: "developer→coder 稳定直投路径（10 次 / 成功率 90%）",
      whenToUse: "developer 需要 coder 承接同型任务且无需任务池往返时",
      effect: "跳过派发/认领/回流三段往返——平均耗时 500ms",
      path: ["developer", "coder"],
    },
    evidence: { calls: 10, okCalls: 9, okRatio: 0.9, avgSteps: 10, avgDurationMs: 500, budgetExceeded: 1 },
  };
  return {
    id: "pp-test",
    kind: PENETRATION_PROPOSAL_KIND,
    anchors: ["penetration", "developer", "coder"],
    content: JSON.stringify(content),
    status: "draft",
    meta: { parent: "developer", child: "coder", stage: "proposed", ts: 1 },
    ...over,
  };
}

describe("B1 穿透自动发现：parse/evaluate/discover 纯逻辑", () => {
  it("parseEdgeAggregate：合法 JSON 解析；坏行返回 null（跳过不报错）", () => {
    expect(parseEdgeAggregate(JSON.stringify(edgeAggregate()))).toEqual(edgeAggregate());
    expect(parseEdgeAggregate(null)).toBeNull();
    expect(parseEdgeAggregate("not-json")).toBeNull();
    expect(parseEdgeAggregate("{}")).toBeNull();
    expect(parseEdgeAggregate(JSON.stringify({ ...edgeAggregate(), calls: "many" }))).toBeNull();
  });

  it("evaluateEdge：合法边 → 生成四段式三要素 + 证据", () => {
    const r = evaluateEdge(edgeAggregate(), DISCOVERY_CONFIG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec).toEqual({
      parent: "developer",
      child: "coder",
      inputContract: "developer 提交的自包含任务描述（标题+正文）——与直投任务文本同构",
      outputContract: "done.result 为父任务验收口径的产物；失败回流错误摘要",
      anchor: "developer→coder 稳定直投路径（10 次 / 成功率 90%）",
      whenToUse: "developer 需要 coder 承接同型任务且无需任务池往返时",
      effect: "跳过派发/认领/回流三段往返——平均耗时 500ms",
      path: ["developer", "coder"],
    });
    expect(r.evidence).toEqual({ calls: 10, okCalls: 9, okRatio: 0.9, avgSteps: 10, avgDurationMs: 500, budgetExceeded: 1 });
  });

  it("evaluateEdge：calls 不足 / 成功率不足 / 平均步数超限 → 各失败路径", () => {
    const insufficientCalls = evaluateEdge(edgeAggregate({ calls: 4 }), DISCOVERY_CONFIG);
    expect(insufficientCalls).toMatchObject({ ok: false, reason: expect.stringMatching(/calls 不足/) });

    const lowRatio = evaluateEdge(edgeAggregate({ calls: 10, okCalls: 7 }), DISCOVERY_CONFIG);
    expect(lowRatio).toMatchObject({ ok: false, reason: expect.stringMatching(/成功率不足/) });

    const expensive = evaluateEdge(edgeAggregate({ calls: 10, sumSteps: 650 }), DISCOVERY_CONFIG);
    expect(expensive).toMatchObject({ ok: false, reason: expect.stringMatching(/平均步数超限/) });
  });

  it("evaluateEdge：组织权拒绝（未知角色 / 不可投递）", () => {
    const unknown = evaluateEdge(edgeAggregate({ parent: "no-such-role" }), DISCOVERY_CONFIG);
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringMatching(/未注册/) });

    const denied = evaluateEdge(edgeAggregate({ child: "scout" }), DISCOVERY_CONFIG);
    expect(denied).toMatchObject({ ok: false, reason: expect.stringMatching(/组织权拒绝/) });
  });

  it("discoverPenetrationProposals：成功生成 pp-<uuid> draft 提案（三要素与证据可解析）", async () => {
    const written: PenetrationDiscoveryMemoryEntry[] = [];
    const deps = {
      queryReadOnly: async (sql: string) => {
        if (sql.includes("kind='penetration-edge'")) {
          return [{ content: JSON.stringify(edgeAggregate()) }];
        }
        if (sql.includes("skill:penetrate:")) return [] as Array<{ id: string }>;
        if (sql.includes("kind='penetration-proposal'")) return [] as Array<{ content: string }>;
        return [];
      },
      memory: { write: async (entry: PenetrationDiscoveryMemoryEntry) => { written.push(entry); } },
      config: DISCOVERY_CONFIG,
    };
    const r = await discoverPenetrationProposals(deps);
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toEqual([]);
    const entry = written[0]!;
    expect(entry.id).toMatch(/^pp-[0-9a-f-]{36}$/);
    expect(entry.kind).toBe(PENETRATION_PROPOSAL_KIND);
    expect(entry.status).toBe("draft");
    expect(entry.anchors).toEqual(["penetration", "developer", "coder"]);
    expect(entry.meta).toMatchObject({ parent: "developer", child: "coder", stage: "proposed" });
    const content = JSON.parse(entry.content) as PenetrationProposalContent;
    expect(content.action).toBe("register");
    expect(content.spec.anchor).toBe("developer→coder 稳定直投路径（10 次 / 成功率 90%）");
    expect(content.evidence.avgDurationMs).toBe(500);
  });

  it("discoverPenetrationProposals：已存在 skill:penetrate:<child>（含 draft/archived）→ 跳过该 child", async () => {
    const written: PenetrationDiscoveryMemoryEntry[] = [];
    const deps = {
      queryReadOnly: async (sql: string) => {
        if (sql.includes("kind='penetration-edge'")) {
          return [
            { content: JSON.stringify(edgeAggregate()) },
            { content: JSON.stringify(edgeAggregate({ child: "tester" })) },
          ];
        }
        if (sql.includes("skill:penetrate:")) return [{ id: "skill:penetrate:coder" }];
        if (sql.includes("kind='penetration-proposal'")) return [] as Array<{ content: string }>;
        return [];
      },
      memory: { write: async (entry: PenetrationDiscoveryMemoryEntry) => { written.push(entry); } },
      config: DISCOVERY_CONFIG,
    };
    const r = await discoverPenetrationProposals(deps);
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toContainEqual({ parent: "developer", child: "coder", reason: expect.stringMatching(/skill:penetrate:coder/) as never });
    expect(written[0]!.id).toBeDefined();
    const writtenContent = JSON.parse(written[0]!.content) as PenetrationProposalContent;
    expect(writtenContent.spec.child).toBe("tester");
  });

  it("discoverPenetrationProposals：已有 draft penetration-proposal（同 parent+child）→ 去重跳过", async () => {
    const written: PenetrationDiscoveryMemoryEntry[] = [];
    const existingDraft: PenetrationProposalContent = {
      action: "register",
      spec: {
        parent: "developer",
        child: "coder",
        inputContract: "旧",
        outputContract: "旧",
        anchor: "旧",
        whenToUse: "旧",
        effect: "旧",
        path: ["developer", "coder"],
      },
      evidence: { calls: 6, okCalls: 6, okRatio: 1, avgSteps: 8, avgDurationMs: 300, budgetExceeded: 0 },
    };
    const deps = {
      queryReadOnly: async (sql: string) => {
        if (sql.includes("kind='penetration-edge'")) {
          return [{ content: JSON.stringify(edgeAggregate()) }];
        }
        if (sql.includes("skill:penetrate:")) return [] as Array<{ id: string }>;
        if (sql.includes("kind='penetration-proposal'")) {
          return [{ content: JSON.stringify(existingDraft) }];
        }
        return [];
      },
      memory: { write: async (entry: PenetrationDiscoveryMemoryEntry) => { written.push(entry); } },
      config: DISCOVERY_CONFIG,
    };
    const r = await discoverPenetrationProposals(deps);
    expect(r.created).toEqual([]);
    expect(r.skipped).toContainEqual({ parent: "developer", child: "coder", reason: expect.stringMatching(/已有 draft/) as never });
    expect(written).toEqual([]);
  });
});

describe("B1 穿透提案治理链（fake store 全链 approve→execute→official）", () => {
  it("未批准 execute → 拒绝", async () => {
    const { store } = fakeStore({ "pp-test": proposalEntry() });
    const r = await executeApprovedPenetrationProposal(store, "pp-test");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未批准");
  });

  it("approve → execute：skill official 可 parse、提案 meta.stage=executed；重复 execute 拒绝", async () => {
    const { store } = fakeStore({ "pp-test": proposalEntry() });
    const approved = await approvePenetrationProposal(store, "pp-test");
    expect(approved).toEqual({ ok: true, id: "pp-test" });

    const executed = await executeApprovedPenetrationProposal(store, "pp-test");
    expect(executed).toEqual({ ok: true, id: "skill:penetrate:coder" });

    const skill = await store.get("skill:penetrate:coder");
    expect(skill?.status).toBe("official");
    expect(skill?.kind).toBe("skill");
    expect(skill?.anchors).toContain("penetration");
    const parsed = parsePenetrationSkillContent(skill!.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec.parent).toBe("developer");
      expect(parsed.spec.child).toBe("coder");
    }
    const proposalAfter = await store.get("pp-test");
    expect(proposalAfter?.status).toBe("official");
    expect(proposalAfter?.meta.stage).toBe("executed");

    const repeated = await executeApprovedPenetrationProposal(store, "pp-test");
    expect(repeated.ok).toBe(false);
    expect(repeated.error).toContain("已存在 official");
  });

  it("approve：非 draft 提案拒绝", async () => {
    const { store } = fakeStore({ "pp-test": proposalEntry({ status: "official" }) });
    const r = await approvePenetrationProposal(store, "pp-test");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("仅 draft 可批准");
  });
});
