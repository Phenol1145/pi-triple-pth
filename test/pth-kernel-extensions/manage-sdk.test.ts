import { describe, it, expect, vi } from "vitest";
import { buildExtensions } from "../../src/pth/kernel/extensions/index.js";
import { runReadOnlyPgView } from "../../src/pth/kernel/storage/index.js";
import type pg from "pg";

/** 构造测试 ExtContext（内存 fake memory store） */
function fakeCtx(overrides: Record<string, unknown> = {}) {
  const entries: Array<{ id: string; kind: string; status: string; content: unknown; anchors: unknown[]; hit_count: number; created_at: string }> = [];
  const published: Array<Record<string, unknown>> = [];
  const memory = {
    write: async (e: { id?: string; kind: string; status?: string; anchors?: unknown[]; content: unknown; meta?: Record<string, unknown> }) => {
      entries.push({ id: e.id ?? `m${entries.length}`, kind: e.kind, status: e.status ?? "draft", content: e.content, anchors: e.anchors ?? [], hit_count: 0, created_at: new Date().toISOString() });
      return { ok: true };
    },
    get: async (id: string) => entries.find((e) => e.id === id) ?? null,
    update: async () => ({ ok: true }),
    retrieve: async () => [],
    _entries: entries,
  };
  const tasks = {
    publish: async (input: Record<string, unknown>) => { published.push(input); return { id: `task-${published.length}` }; },
    _published: published,
  };
  const queryReadOnly = async (sql: string) => {
    // 仅测试用：按 kind 返回
    if (sql.includes("memory_entries")) {
      return entries.map((e) => ({ ...e, meta: { role: "executor" } }));
    }
    return [];
  };
  return {
    dataWorld: { memory, tasks, queryReadOnly, pgStat: async () => [{ state: "idle", n: 3 }] },
    toolstore: { readText: async () => "", list: async () => [] },
    strategiesDir: "/tmp/pth-sdk-test-strategies",
    sessionRef: { current: null },
    ...overrides,
  } as never;
}

describe("管理 SDK（2026-08-12 第二步）——manage 扩展", () => {
  it("注入 manage.params.get/set（PTH_* 热调参）", async () => {
    const ext = buildExtensions(fakeCtx());
    const manage = (ext.capabilities as Record<string, unknown>)["manage"] as Record<string, unknown>;
    expect(manage).toBeDefined();
    const params = manage["params"] as { get: () => Record<string, unknown>; set: (o: { key: string; value: string | number }) => { ok: boolean } };
    // set→get 验证（测试进程 env 无 PTH_ 参数——配置中心启动快照为空——不依赖 env）
    const r = params.set({ key: "PTH_BATCH_TICK_MS", value: 500 });
    expect(r.ok).toBe(true);
    expect(params.get()["PTH_BATCH_TICK_MS"]).toBe("500");
    // 非 PTH_* 拒绝
    expect(params.set({ key: "EVIL", value: "1" }).ok).toBe(false);
  });

  it("manage.resource.config：重启级参数 → draft（kind=resource-config）", async () => {
    const ctx = fakeCtx();
    const ext = buildExtensions(ctx);
    const manage = (ext.capabilities as Record<string, unknown>)["manage"] as Record<string, unknown>;
    const resource = manage["resource"] as { config: (o: Record<string, unknown>) => Promise<{ ok: boolean; status?: string; domain?: string }> };
    const r = await resource.config({ domain: "v8", key: "NODE_OPTIONS", value: "--max-old-space-size=1024", rationale: "压测后内存峰值高" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("draft");
    const entries = (ctx.dataWorld as { memory: { _entries: Array<{ kind: string; status: string; content: unknown }> } }).memory._entries;
    expect(entries[0]?.kind).toBe("resource-config");
    expect(entries[0]?.status).toBe("draft");
    expect((entries[0]?.content as { key: string }).key).toBe("NODE_OPTIONS");
    // 非法 domain 拒绝
    const bad = await resource.config({ domain: "evil", key: "X", value: "1" });
    expect(bad.ok).toBe(false);
  });

  it("manage.resource.scheme：publish/apply 方案闭环（PTH_* 校验 + id 防穿越）", async () => {
    const ext = buildExtensions(fakeCtx());
    const manage = (ext.capabilities as Record<string, unknown>)["manage"] as Record<string, unknown>;
    const scheme = manage["scheme"] as {
      publish: (o: { id?: string; name: string; params: Record<string, string> }) => Promise<{ ok: boolean; id?: string; error?: string }>;
      apply: (o: { id: string }) => Promise<{ ok: boolean }>;
      list: () => Promise<unknown[]>;
    };
    const bad = await scheme.publish({ name: "s1", params: { EVIL: "1" } });
    expect(bad.ok).toBe(false);   // 非 PTH_* 拒
    // 2026-08-15 审计修复：id 进入文件名——路径穿越/非法字符拒绝
    const traversal = await scheme.publish({ id: "../evil", name: "s1", params: { PTH_BATCH_TICK_MS: "700" } });
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toContain("id 非法");
    const slash = await scheme.publish({ id: "a/b", name: "s1", params: { PTH_BATCH_TICK_MS: "700" } });
    expect(slash.ok).toBe(false);
    const pub = await scheme.publish({ id: "strategy-s1.v2", name: "s1", params: { PTH_BATCH_TICK_MS: "700" } });
    expect(pub.ok).toBe(true);
    expect((await scheme.list()).length).toBeGreaterThanOrEqual(1);
    const apply = await scheme.apply({ id: pub.id! });
    expect(apply.ok).toBe(true);
  });

  it("manage.fix.approve：修复批准 → 派发 debug-case-writer（P3.6 controller 触发）", async () => {
    const ctx = fakeCtx();
    const ext = buildExtensions(ctx);
    const manage = (ext.capabilities as Record<string, unknown>)["manage"] as Record<string, unknown>;
    const fix = manage["fix"] as { approve: (o: { bugReport: string; fixSummary?: string; parentTaskId?: string }) => Promise<{ ok: boolean; id?: string; role?: string; error?: string }> };
    const r = await fix.approve({ bugReport: "计数偶发错误", fixSummary: "diff: 修初始化", parentTaskId: "t1" });
    expect(r.ok).toBe(true);
    expect(r.role).toBe("debug-case-writer");
    const published = (ctx.dataWorld as { tasks: { _published: Array<Record<string, unknown>> } }).tasks._published;
    expect(published).toHaveLength(1);
    expect(published[0]!.tags).toEqual(["debug-case"]);
    expect(published[0]!.payload).toMatchObject({ source: "controller-fix-approved", parentTaskId: "t1" });
    expect(String(published[0]!.text)).toContain("最小复现");
    // bugReport 必填
    const bad = await fix.approve({ bugReport: "" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("bugReport 必填");
  });

  it("manage.memory.archive：系统资产拒；普通条目落 draft 提案", async () => {
    const ctx = fakeCtx();
    // 预置一条 role-doc（系统资产）+ 一条 task-insight
    const m = (ctx.dataWorld as { memory: { _entries: Array<{ id: string; kind: string }> } }).memory;
    m._entries.push({ id: "role-doc:executor", kind: "role-doc", status: "official", content: "x", anchors: [], hit_count: 0, created_at: "" });
    m._entries.push({ id: "m-1", kind: "task-insight", status: "official", content: "x", anchors: [], hit_count: 0, created_at: "" });
    const ext = buildExtensions(ctx);
    const manage = (ext.capabilities as Record<string, unknown>)["manage"] as Record<string, unknown>;
    const archive = manage["memory"] as { archive: (o: { id: string }) => Promise<{ ok: boolean; status?: string }> };
    const sys = await archive.archive({ id: "role-doc:executor" });
    expect(sys.ok).toBe(false);   // 系统资产不可归档
    const ok = await archive.archive({ id: "m-1" });
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe("draft");
  });

  it("manage.worker.propose：分化提案 draft（校验 id 形态）", async () => {
    const ctx = fakeCtx();
    const ext = buildExtensions(ctx);
    const manage = (ext.capabilities as Record<string, unknown>)["manage"] as Record<string, unknown>;
    const worker = manage["worker"] as { propose: (o: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; status?: string }> };
    const r = await worker.propose({ suggestedRoleId: "reviewer-py", parent: "executor", specialization: "python 审查", rationale: "内环 sensor 观察" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("draft");
    const entries = (ctx.dataWorld as { memory: { _entries: Array<{ kind: string }> } }).memory._entries;
    expect(entries.some((e) => e.kind === "differentiation-proposal")).toBe(true);
    // 非法 id
    const bad = await worker.propose({ suggestedRoleId: "Bad ID", parent: "executor", specialization: "x", rationale: "y" });
    expect(bad.ok).toBe(false);
  });
});

describe("管理 SDK——obs 观测面扩展", () => {
  it("obs.pg：视图白名单（固定模板——未知视图拒绝）", async () => {
    const seen: string[] = [];
    const ctx = fakeCtx({
      dataWorld: { memory: { write: async () => ({ ok: true }), get: async () => null, update: async () => ({ ok: true }), retrieve: async () => [] }, queryReadOnly: async () => [], pgStat: async (v: string) => { seen.push(v); return [{ n: 1 }]; } },
    });
    const ext = buildExtensions(ctx);
    const obs = (ext.capabilities as Record<string, unknown>)["obs"] as Record<string, unknown>;
    const pg = obs["pg"] as (o: Record<string, unknown>) => Promise<{ error?: string }>;
    const ok = await pg({ view: "activity" });
    expect(ok.error).toBeUndefined();
    expect(seen).toEqual(["activity"]);
    const bad = await pg({ view: "pg_tables" });
    expect(bad.error).toContain("未知视图");
  });

  it("obs.memory：记忆质量聚合（kind/status/hit_count）", async () => {
    const rows = [
      { kind: "task-insight", status: "official", n: 125, avg_hits: 3.5 },
      { kind: "role-doc", status: "official", n: 14, avg_hits: 12.0 },
    ];
    const ctx = fakeCtx({
      dataWorld: { memory: { write: async () => ({ ok: true }), get: async () => null, update: async () => ({ ok: true }), retrieve: async () => [] }, queryReadOnly: async () => rows, pgStat: async () => [] },
    });
    const ext = buildExtensions(ctx);
    const obs = (ext.capabilities as Record<string, unknown>)["obs"] as Record<string, unknown>;
    const memory = obs["memory"] as () => Promise<{ byKind: typeof rows; total?: unknown }>;
    const r = await memory();
    expect(r.byKind[0]?.kind).toBe("task-insight");
    expect(r.byKind[0]?.avg_hits).toBe(3.5);
  });

  it("obs.storage：df + compiled-cache 用量（不抛错）", async () => {
    const ctx = fakeCtx({
      dataWorld: { memory: { write: async () => ({ ok: true }), get: async () => null, update: async () => ({ ok: true }), retrieve: async () => [] }, queryReadOnly: async () => [], pgStat: async () => [] },
    });
    const ext = buildExtensions(ctx);
    const obs = (ext.capabilities as Record<string, unknown>)["obs"] as Record<string, unknown>;
    const storage = obs["storage"] as () => Promise<{ compiledCacheBytes: number; compiledCacheDir: string }>;
    const r = await storage();
    expect(typeof r.compiledCacheBytes).toBe("number");
    expect(r.compiledCacheDir.length).toBeGreaterThan(0);
  });

  it("obs.container：cgroup 容器级观测（不抛错——非容器环境降级 available:false）", async () => {
    const ctx = fakeCtx({
      dataWorld: { memory: { write: async () => ({ ok: true }), get: async () => null, update: async () => ({ ok: true }), retrieve: async () => [] }, queryReadOnly: async () => [], pgStat: async () => [] },
    });
    const ext = buildExtensions(ctx);
    const obs = (ext.capabilities as Record<string, unknown>)["obs"] as Record<string, unknown>;
    const container = obs["container"] as () => Promise<Record<string, unknown>>;
    const r = await container();
    expect(r.error).toBeUndefined();
    expect("available" in r).toBe(true);
    if (r.available === true) {
      expect(typeof r.hostname).toBe("string");
      expect(r.cpu).toHaveProperty("quotaCores");
      expect(r.memory).toHaveProperty("currentMb");
      expect(r.pids).toHaveProperty("current");
    } else {
      expect(String(r.note)).toContain("非容器");
    }
  });

  it("obs.resource：资源环聚合（container+pg+storage+batches）", async () => {
    const seen: string[] = [];
    const ctx = fakeCtx({
      dataWorld: {
        memory: { write: async () => ({ ok: true }), get: async () => null, update: async () => ({ ok: true }), retrieve: async () => [] },
        queryReadOnly: async () => [],
        pgStat: async (v: string) => { seen.push(v); return [{ v }]; },
      },
    });
    const ext = buildExtensions(ctx);
    const obs = (ext.capabilities as Record<string, unknown>)["obs"] as Record<string, unknown>;
    const resource = obs["resource"] as () => Promise<Record<string, unknown>>;
    const r = await resource();
    expect(r.pg).toHaveProperty("slow");
    expect(seen).toEqual(["activity", "database", "slow"]);
    expect(r.container).toHaveProperty("available");
    expect(r.storage).toHaveProperty("compiledCacheBytes");
    expect(r.batches).toBeDefined();
  });

  it("runReadOnlyPgView：固定模板执行（fake pool）", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ state: "active", n: 2 }] })),
    } as unknown as pg.Pool;
    const r = await runReadOnlyPgView(pool, "activity");
    expect((r as Array<{ state: string }>)[0]?.state).toBe("active");
    await expect(runReadOnlyPgView(pool, "evil" as never)).rejects.toThrow(/未知视图/);
  });
});

describe("obs.callpoint SQL（2026-08-12 sensor 上报的基础设施缺陷修复）", () => {
  it("content 是 text 列——::jsonb 转换后字段可读（修复前 jsonb 操作符报错）", async () => {
    const sql = await (await import("../../src/pth/kernel/extensions/obs.js")).default;
    // 直接验证 SQL 字符串形态（content::jsonb 转换存在——避免对 DB 的依赖）
    const src = (await (await import("node:fs/promises")).readFile("src/pth/kernel/extensions/obs.ts", "utf8"));
    expect(src).toContain("content::jsonb->>'steps'");
    expect(src).toContain("content::jsonb->'tokens'");
  });
});

describe("token 缓存命中率链路（2026-08-12 用户问询补齐）", () => {
  it("scorecard 聚合 cacheRead/cacheWrite（llm-call usage 透传）", async () => {
    const { buildScorecard } = await import("../../src/pth/kernel/execution/worker-scorecard.js");
    const sc = buildScorecard([
      { type: "llm-call", step: 1, contentPreview: "", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 200 } },
      { type: "llm-call", step: 2, contentPreview: "", usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0 } },
      { type: "finish", ok: true, steps: 2 },
    ]);
    expect(sc.tokens).toEqual({ input: 1500, output: 150, cacheRead: 1100, cacheWrite: 200 });
    // 命中率 = 1100 / (1100 + 1500 - 1100 - 200) = 1100/400 = 73.3%
    const fresh = sc.tokens.input - sc.tokens.cacheRead - sc.tokens.cacheWrite;
    expect(Math.round((sc.tokens.cacheRead / (sc.tokens.cacheRead + fresh)) * 100)).toBe(85);
  });

  it("obs.callpoint 查询含 cache_hit_pct（观测面）", async () => {
    const src = (await (await import("node:fs/promises")).readFile("src/pth/kernel/extensions/obs.ts", "utf8"));
    expect(src).toContain("cache_hit_pct");
  });
});
