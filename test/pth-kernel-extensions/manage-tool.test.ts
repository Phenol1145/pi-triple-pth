import { afterEach, describe, expect, it } from "vitest";
import { buildExtensions } from "@away_from/pth-kernel-interpreter";
import { resetConfig } from "@away_from/pth-kernel-interpreter";
import { toolFaceBudgetCheck } from "@away_from/pth-kernel-execution";
import type { ToolRegSpec } from "@away_from/pth-memory";

/**
 * N14 P3：manage.tool.* 调节面（manage 扩展的 tool 注册通道）。
 * 设计：docs/pth/n14-sensor-controller-four-dims.md §3.3/§3.4/§6 P3——
 * 预算守卫调用即校验；PTH_TOOL_WRITE_POLICY=manual 直写 official / staged 落 draft 提案。
 */

function spec(name: string, overrides: Partial<ToolRegSpec> = {}): ToolRegSpec {
  return {
    name,
    version: 1,
    description: { anchor: `${name} 场景`, whenToUse: `${name} 何时用`, effect: `${name} 效果` },
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    executor: { type: "program", source: "return String(args.text).toUpperCase();" },
    visibility: { roles: ["developer"], pack: "util" },
    promotedFrom: "tool-function:fn-1",
    ...overrides,
  };
}

type Row = { id: string; kind: string; status: string; content: string; anchors?: string[]; meta?: Record<string, unknown> };
interface ManageTool {
  tool: {
    list: () => Promise<{ version: string; budget: number; policy: string; tools: Array<{ name: string; version: number }> }>;
    register: (o: { spec?: unknown; rationale?: string; planHash?: string; planGrant?: unknown }) => Promise<{ ok: boolean; id?: string; status?: string; error?: string }>;
    revise: (o: { spec?: unknown; rationale?: string; planHash?: string; planGrant?: unknown }) => Promise<{ ok: boolean; id?: string; version?: number; status?: string; error?: string }>;
    importMcp: (o: { bundle?: unknown }) => Promise<{ ok: boolean; errors?: string[]; imported?: Array<{ name: string; proposalId: string }>; failed?: Array<{ name: string; error: string }> }>;
  };
}

function makeCtx() {
  const rows = new Map<string, Row>();
  const activities: Array<{ kind: string; detail?: string }> = [];
  const memory = {
    listIds: async () => [...rows.keys()],
    get: async (id: string) => rows.get(id) ?? null,
    write: async (entry: Row, opts?: { force?: boolean }) => {
      if (rows.has(entry.id) && !opts?.force) throw new Error("entry exists");
      rows.set(entry.id, { ...entry, status: entry.status ?? "draft" });
    },
    update: async (id: string, patch: Partial<Row>) => {
      const old = rows.get(id);
      if (!old) throw new Error("entry not found");
      rows.set(id, { ...old, ...patch, meta: { ...(old.meta ?? {}), ...((patch.meta ?? {}) as Record<string, unknown>) } });
    },
    retrieve: async () => [],
  };
  const ctx = {
    dataWorld: { memory, tasks: { publish: async () => ({}) }, queryReadOnly: async () => [], queryTemplate: async () => [], pgStat: async () => [] },
    toolstore: { readText: async () => "", list: async () => [] },
    strategiesDir: "/tmp/pth-manage-tool-test-strategies",
    sessionRef: { current: null },
    onActivity: (e: { kind: string; detail?: string }) => activities.push(e),
    toolFaceBudgetCheck,
    planGrantVerify: () => ({ ok: true } as const),
  } as never;
  return {
    rows,
    activities,
    tool: ((buildExtensions(ctx).capabilities as Record<string, unknown>)["manage"] as ManageTool).tool,
  };
}

afterEach(() => resetConfig(process.env));

describe("N14 P3：manage.tool.*（manual 策略——直写 official + 预算守卫）", () => {
  it("register：合法 spec 直写 official，list 快照可见；重复/版本≠1 拒绝", async () => {
    resetConfig({ PTH_TOOL_FACE_BUDGET: "100" });
    const { rows, tool } = makeCtx();
    const s = spec("util_upper");
    const r = await tool.register({ spec: s, rationale: "tool-function 晋升", planHash: "test-plan", planGrant: {} });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("official");
    expect(rows.get("tool:util_upper")?.kind).toBe("tool-reg");
    expect(rows.get("tool:util_upper")?.meta).toMatchObject({ registeredBy: "manage.tool.register", version: 1 });
    const list = await tool.list();
    expect(list.tools.map((t) => t.name)).toContain("util_upper");
    expect(list.budget).toBe(100);
    expect(list.policy).toBe("manual");
    // 重复注册（不可变）
    const dup = await tool.register({ spec: s, planHash: "test-plan", planGrant: {} });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("已存在");
    // register 新条目版本必须为 1
    const v2 = await tool.register({ spec: { ...s, name: "util_upper2", version: 2 }, planHash: "test-plan", planGrant: {} });
    expect(v2.ok).toBe(false);
    expect(v2.error).toContain("版本必须为 1");
  });

  it("revise：版本必须递增 + promotedFrom 自动承继（修订=新版本链）", async () => {
    resetConfig({ PTH_TOOL_FACE_BUDGET: "100" });
    const { rows, tool } = makeCtx();
    await tool.register({ spec: spec("util_upper"), planHash: "test-plan", planGrant: {} });
    // 版本不递增 → 拒
    const bad = await tool.revise({ spec: spec("util_upper"), planHash: "test-plan", planGrant: {} });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("递增");
    // v2 修订（不显式带 promotedFrom——从现条目承继）
    const v2 = spec("util_upper", { version: 2, description: { anchor: "大写转换", whenToUse: "转大写时", effect: "大写结果" } });
    const r = await tool.revise({ spec: v2, rationale: "描述修订", planHash: "test-plan", planGrant: {} });
    expect(r.ok).toBe(true);
    expect(r.version).toBe(2);
    expect(rows.get("tool:util_upper")?.meta).toMatchObject({ version: 2, promotedFrom: "tool-function:fn-1", registeredBy: "manage.tool.revise" });
    // 不存在 → 拒
    const missing = await tool.revise({ spec: spec("util_missing", { version: 2 }), planHash: "test-plan", planGrant: {} });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("不存在");
  });

  it("预算守卫：候选角色投影面超 PTH_TOOL_FACE_BUDGET → 注册拒绝（命题 3 防线）", async () => {
    resetConfig({ PTH_TOOL_FACE_BUDGET: "1" });
    const { tool } = makeCtx();
    const r = await tool.register({ spec: spec("util_upper"), planHash: "test-plan", planGrant: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("预算守卫");
    expect(r.error).toContain("developer");
  });
});

describe("D1 manage.tool.importMcp：MCP 拆解 bundle → tool-proposal draft", () => {
  it("合法 bundle → 逐条 draft 提案 + tool.proposal.created 事件；official 面不可见", async () => {
    const { rows, activities, tool } = makeCtx();
    const bundle = {
      format: "mcp-tool-bundle-v1",
      server: "example-server",
      tools: [
        {
          name: "parse_log",
          description: "解析日志首列时间戳",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          source: "function parseLog(text) { return text; }",
          call: "parseLog(String(args.text))",
        },
        {
          name: "upper",
          description: "转大写",
          source: "function upper(text) { return String(text).toUpperCase(); }",
          call: "upper(String(args.text))",
        },
      ],
    };
    const r = await tool.importMcp({ bundle });
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.imported).toHaveLength(2);
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({ kind: "tool.proposal.created", detail: r.imported![0]!.proposalId });
    expect(activities[0]!.at).toBeTypeOf("number");
    expect(activities[1]).toMatchObject({ kind: "tool.proposal.created", detail: r.imported![1]!.proposalId });

    const proposalIds = r.imported!.map((x) => x.proposalId);
    for (const id of proposalIds) {
      expect(rows.get(id)?.kind).toBe("tool-proposal");
      expect(rows.get(id)?.status).toBe("draft");
    }
    // draft 提案 ≠ 注册条目——不落 tool-reg official
    expect(rows.get("tool:parse_log")).toBeUndefined();
    expect(rows.get("tool:upper")).toBeUndefined();
    expect([...rows.values()].some((row) => row.kind === "tool-reg")).toBe(false);
  });

  it("非法 bundle → {ok:false, errors} 且不发事件", async () => {
    const { rows, activities, tool } = makeCtx();
    const r = await tool.importMcp({ bundle: { format: "bad", server: "Example", tools: [] } });
    expect(r.ok).toBe(false);
    expect(r.errors?.join("\n")).toContain("format");
    expect(r.errors?.join("\n")).toContain("server 非法");
    expect(r.errors?.join("\n")).toContain("tools 必须为非空数组");
    expect(activities).toEqual([]);
    expect(rows.size).toBe(0);
  });
});

describe("N14 P3：manage.tool.*（staged 策略——提案 draft + 事件源）", () => {
  it("register staged：落 draft 提案 + tool.proposal.created 事件；official 面不可见", async () => {
    resetConfig({ PTH_TOOL_WRITE_POLICY: "staged", PTH_TOOL_FACE_BUDGET: "100" });
    const { rows, activities, tool } = makeCtx();
    const r = await tool.register({ spec: spec("util_upper"), rationale: "晋升候选" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("draft");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: "tool.proposal.created", detail: r.id });
    const proposal = rows.get(r.id!)!;
    expect(proposal.kind).toBe("tool-proposal");
    expect(proposal.status).toBe("draft");
    // draft 提案 ≠ 注册条目——快照不可见（§7-4）
    expect((await tool.list()).tools).toEqual([]);
  });
});
