import { afterEach, describe, expect, it } from "vitest";
import { buildCapabilities } from "../../src/pth/impls/kernels/capability.js";
import { buildExtensions } from "../../src/pth/kernel/extensions/index.js";
import { resetConfig } from "../../src/pth/kernel/extensions/perf-params.js";
import { TriggerEngine } from "../../src/pth/kernel/execution/trigger-engine.js";
import { registerSystemTriggers } from "../../src/pth/kernel/execution/system-triggers.js";
import { loadToolRegSnapshot } from "../../src/pth/kernel/execution/tool-registry.js";
import { approveToolProposal, executeApprovedToolProposal, type ToolRegSpec } from "@away_from/pth-memory";

/**
 * N14 P3：tool-reg staged 审核流端到端链路（与 L2 skill staged 同构）。
 *
 * 链路：controller:tool-face manage.tool.register（staged 策略）
 *   → tool.proposal.created 事件（manage 扩展发出）
 *   → trigger-engine 监听 → 自动派发 controller:adversarial 审核任务
 *   → adversarial tools.review(pass/reject)
 *   → 监督批准（approveToolProposal + executeApprovedToolProposal——gateway 通道同款调用）
 *   → tool-reg 条目 official 落库 + 快照可见
 */

function spec(name: string, overrides: Partial<ToolRegSpec> = {}): ToolRegSpec {
  return {
    name,
    version: 1,
    description: { anchor: `${name} 场景`, whenToUse: `${name} 何时用`, effect: `${name} 效果` },
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    executor: { type: "program", source: "return String(args.text).toUpperCase();" },
    visibility: { roles: ["developer"], pack: "util" },
    promotedFrom: "tool-function:fn-chain",
    ...overrides,
  };
}

type Row = { id: string; kind: string; content: string; status: string; anchors?: string[]; meta?: Record<string, unknown> };

function makeStore() {
  const rows = new Map<string, Row>();
  return {
    rows,
    listIds: async () => [...rows.keys()],
    get: async (id: string) => rows.get(id),
    retrieve: async () => [...rows.values()],
    write: async (entry: Row, opts?: { force?: boolean }) => {
      if (rows.has(entry.id) && !opts?.force) throw new Error("entry exists");
      rows.set(entry.id, { ...entry, status: entry.status ?? "draft" });
    },
    update: async (id: string, patch: Partial<Row>) => {
      const old = rows.get(id);
      if (!old) throw new Error("entry not found");
      rows.set(id, { ...old, ...patch, meta: { ...(old.meta ?? {}), ...((patch.meta ?? {}) as Record<string, unknown>) } });
    },
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

function manageTool(store: ReturnType<typeof makeStore>, events: Array<{ kind: string; detail?: string }>) {
  const ext = buildExtensions({
    dataWorld: fakeDataWorld(store),
    toolstore: fakeToolstore,
    sessionRef: { current: null },
    onActivity: (e) => events.push(e),
  } as never);
  return (ext.capabilities as Record<string, unknown>)["manage"] as {
    tool: {
      register: (o: { spec?: unknown; rationale?: string }) => Promise<{ ok: boolean; id?: string; status?: string; error?: string }>;
    };
  };
}

describe("N14 P3：tool-reg staged 审核流端到端（提案 → 事件派发 → 对抗性审核 → 批准 → 落库）", () => {
  afterEach(() => resetConfig(process.env));

  it("全链 pass：propose → tool.proposal.created 事件 → trigger 派发审核任务 → review pass → 批准执行 → 条目 official 可见", async () => {
    resetConfig({ PTH_TOOL_WRITE_POLICY: "staged", PTH_TOOL_FACE_BUDGET: "100" });
    const store = makeStore();
    const events: Array<{ kind: string; detail?: string }> = [];
    // ① controller:tool-face 注册（staged 策略——落 draft 提案）
    const tool = manageTool(store, events).tool;
    const proposal = await tool.register({ spec: spec("util_chain"), rationale: "tool-function 晋升" });
    expect(proposal.ok).toBe(true);
    expect(proposal.status).toBe("draft");
    // ② 事件发出（detail = 提案 id）
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool.proposal.created", detail: proposal.id });

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
    expect(published[0].text).toContain("tools.review");
    expect(published[0].text).toContain("tool-proposal");

    // ④ controller:adversarial 审核 pass（capability 注入面）
    const advCaps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "controller:adversarial",
    });
    const review = (advCaps["tools"] as { review: (id: string, verdict: "pass" | "reject", note?: string) => Promise<{ ok: boolean }> }).review;
    expect((await review(proposal.id!, "pass", "schema 完整 / 执行体安全 / 无作弊捷径")).ok).toBe(true);

    // ⑤ 监督批准 + 执行（gateway approveMemoryAdmin 同款调用序列）
    expect((await approveToolProposal(store as never, proposal.id!)).ok).toBe(true);
    const executed = await executeApprovedToolProposal(store as never, proposal.id!);
    expect(executed.ok).toBe(true);
    const entry = store.rows.get("tool:util_chain")!;
    expect(entry.status).toBe("official");
    expect(entry.meta).toMatchObject({ proposalId: proposal.id, registeredBy: "controller:tool-face", version: 1 });

    // ⑥ 快照可见（§7-4：official 才进面）
    const snap = await loadToolRegSnapshot(store as never);
    expect(snap.entries.has("util_chain")).toBe(true);
    expect(snap.entries.get("util_chain")!.visibility.roles).toEqual(["developer"]);
  });

  it("reject 分支：adversarial 拒绝 → 监督不可批准（链路在审核处闭合）", async () => {
    resetConfig({ PTH_TOOL_WRITE_POLICY: "staged", PTH_TOOL_FACE_BUDGET: "100" });
    const store = makeStore();
    const tool = manageTool(store, []).tool;
    const proposal = await tool.register({ spec: spec("util_bad") });
    const advCaps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "controller:adversarial",
    });
    const review = (advCaps["tools"] as { review: (id: string, verdict: "pass" | "reject", note?: string) => Promise<{ ok: boolean; error?: string }> }).review;
    const r = await review(proposal.id!, "reject", "program 态可写任意文件——越权副作用");
    expect(r.ok).toBe(false);
    // 拒绝后不可批准
    const approved = await approveToolProposal(store as never, proposal.id!);
    expect(approved.ok).toBe(false);
    expect(store.rows.has("tool:util_bad")).toBe(false);
  });

  it("非 adversarial 角色无 tools.review 注入（审核面按角色收窄）", () => {
    const store = makeStore();
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld(store) as never,
      toolstore: fakeToolstore as never,
      roleId: "developer",
    });
    expect((caps["tools"] as Record<string, unknown> | undefined)?.review).toBeUndefined();
  });
});
