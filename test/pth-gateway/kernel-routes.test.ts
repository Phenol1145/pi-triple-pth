import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createInMemoryPromoteOfficial, installDefaultRoles } from "../helpers";
import Fastify from "fastify";
import { buildKnowledgeProvenance } from "@away_from/pth-memory";
import { registerKernelRoutes } from "../../src/pth/gateway/routes-kernel";
import { createPthGatewayFacade, type PthGatewayFacade } from "../../src/pth/application/gateway/pth-gateway-facade.js";
import type { KnowledgeVerificationRepo } from "../../src/pth/execution/knowledge-promotion.js";
import { computeCandidateHash, sourceBindingsDigestOf, type VerificationPlanRecord } from "../../src/pth/execution/knowledge-verdicts.js";
import type { KernelRuntime } from "../../src/pth/kernel/assembly";

// 简化 auth：路由测试直接构造 app 并注册 kernel 路由（不含全局 auth hook——auth 已由
// server.ts 的 createAuthHook 统一覆盖，本测试聚焦路由逻辑本身）。
beforeEach(() => installDefaultRoles());

function wrap(kernel: unknown, verificationRepo?: KnowledgeVerificationRepo): PthGatewayFacade {
  return createPthGatewayFacade(kernel as KernelRuntime, verificationRepo);
}

function buildApp(kernel: KernelRuntime | null) {
  const app = Fastify();
  registerKernelRoutes(app, kernel ? wrap(kernel) : null);
  return app;
}

/** 让 fake pool 支持 withTx（BEGIN/COMMIT/ROLLBACK + release），供 cancel 等事务路径使用。 */
function fakeTxClient(queryImpl: (sql: string, params?: unknown[]) => unknown) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") return { rows: [] };
      return queryImpl(sql, params);
    },
    release: async () => {},
  };
}

function fakePoolWithTx(queryImpl: (sql: string, params?: unknown[]) => unknown) {
  return {
    query: async (sql: string, params?: unknown[]) => queryImpl(sql, params),
    connect: async () => fakeTxClient(queryImpl),
  };
}

function fakeKernel(overrides: Partial<KernelRuntime> = {}): KernelRuntime {
  return {
    pool: fakePoolWithTx(async () => ({ rows: [{ status: "pending", n: 2 }, { status: "completed", n: 1 }] })) as any,
    dataWorld: {
      tasks: {
        publish: async (input: any) => ({ id: "t-1", ...input, status: "pending" }),
        candidates: async () => [],
        countPending: async () => 2,
      },
      memory: {} as any,
      transcripts: {} as any,
      audit: {} as any,
    } as any,
    batchManager: {
      spawnBatch: async () => ({ id: "b-1", pid: 100, workers: ["analyst"], currentTasks: new Map(), idleRatio: 1 }),
      killBatch: async () => {},
      listBatches: async () => [{ id: "b-1", pid: 100, workers: ["analyst"], currentTasks: {}, idleRatio: 1 }],
      isBatchAlive: () => true,
    } as any,
    watchdog: {
      getCrashLog: () => [],
      probe: async () => 0,
    } as any,
    shutdown: async () => {},
    ...overrides,
  };
}

describe("kernel routes", () => {
  let app: ReturnType<typeof buildApp>;

  afterAll(async () => {
    if (app) await app.close();
  });

  it("kernel=null → 503", async () => {
    app = buildApp(null);
    const res = await app.inject({ method: "GET", url: "/api/v1/kernel/status" });
    expect(res.statusCode).toBe(503);
  });

  describe("kernel present", () => {
    beforeAll(() => {
      app = buildApp(fakeKernel());
    });

    it("POST /api/v1/kernel/tasks 发布任务 → 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", tags: ["code"] },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBe("t-1");
      expect(body.status).toBe("pending");
    });

    it("POST /api/v1/kernel/tasks 直接发布透传 payload（任务链 flow 声明）", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: {
          title: "链任务", text: "code", createdBy: "tester",
          payload: { flow: { stages: [{ id: "s1", transform: { role: "developer" } }] }, resolvedStages: [] },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.payload.flow.stages[0].id).toBe("s1");
    });

    it("POST /api/v1/kernel/tasks 透传顶层 domains（字符串数组）", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", tags: ["code"], domains: ["mathematics", "statistics"] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().domains).toEqual(["mathematics", "statistics"]);
    });

    it("POST /api/v1/kernel/tasks domains 非字符串数组 → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", domains: ["ok", 7] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("domains");
    });

    it("POST /api/v1/kernel/tasks domains 元素为空字符串 → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { title: "测试", text: "1+1", createdBy: "tester", domains: ["ok", "  "] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/v1/kernel/tasks 缺 title → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { text: "1+1", createdBy: "tester" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /api/v1/kernel/tasks 模板发布（recon-doc）→ 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { template: "recon-doc", params: { url: "https://go.dev/ref/spec" }, createdBy: "tester" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.title).toContain("recon-doc");
      expect(body.text).toContain("web.fetchText");
    });

    it("POST /api/v1/kernel/tasks 模板缺必填参数 → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { template: "recon-doc", params: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("url");
    });

    it("POST /api/v1/kernel/tasks 未知模板 → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks",
        payload: { template: "nope", params: {} },
      });
      expect(res.statusCode).toBe(404);
    });

    it("GET /api/v1/kernel/templates → 模板列表", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/templates" });
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as Array<{ id: string }>).map((t) => t.id);
      expect(ids).toContain("recon-doc");
      expect(ids).toContain("memory-maintain");
      expect(ids).toContain("dev-task");
      expect(ids).not.toContain("memory-sweep");   // hidden 系统内部模板不外显（模板统一收口 A+）
    });

    it("GET /api/v1/kernel/tasks → 任务列表", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/tasks" });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it("GET /api/v1/kernel/status → 运行状态全景（监控面板铺垫）", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kernel.connected).toBe(true);
      expect(Array.isArray(body.batches)).toBe(true);
      expect(body.tasks.pending).toBe(2);
      expect(Array.isArray(body.watchdog.crashLog)).toBe(true);
    });

    it("POST /api/v1/kernel/batch/add → 启动 batch", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/kernel/batch/add", payload: { count: 1 } });
      expect(res.statusCode).toBe(200);
      expect(res.json().spawned).toBe(1);
    });

    it("POST /api/v1/kernel/batch/remove → 停止 batch", async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/kernel/batch/remove", payload: { count: 1 } });
      expect(res.statusCode).toBe(200);
      expect(res.json().stopped).toBe(1);
    });

    it("GET /api/v1/kernel/batch → batch 列表", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/batch" });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0].id).toBe("b-1");
    });

    it("POST /api/v1/kernel/tasks/:id/cancel → 取消并支持递归传播（W8 P2）", async () => {
      const cancelApp = buildApp(fakeKernel({
        pool: fakePoolWithTx(async (sql: string) => {
          if (sql.includes("UPDATE task_dependencies")) return { rows: [], rowCount: 0 };
          return { rows: [{ id: "t-1" }], rowCount: 1 };
        }) as any,
      }));
      const res = await cancelApp.inject({
        method: "POST",
        url: "/api/v1/kernel/tasks/t-1/cancel",
        payload: { recursive: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cancelled: 1, taskIds: ["t-1"] });
      await cancelApp.close();
    });
  });
});

describe("flow role 路由（body.flow 顶层——发布即路由到指定角色）", () => {
  it("顶层 flow 并入 payload——routeTaskRole 命中显式 role", async () => {
    const { PgTaskStore } = await import("@away_from/pth-kernel-storage");
    const { routeTaskRole } = await import("@away_from/pth-kernel-execution");
    const { allWorkerRoles } = await import("@away_from/pth-kernel-execution");
    const roles = allWorkerRoles();
    // 模拟 routes-kernel 的 payload 构造（body.flow 顶层并入）
    const bodyFlow = { stages: [{ task: { role: "developer" } }] };
    const payload = { ...{}, ...(bodyFlow ? { flow: bodyFlow } : {}) };
    const assigned = routeTaskRole({ id: "test-123", tags: [], payload });
    expect(assigned).toBe("developer");
    expect(roles.some((r) => r.id === assigned)).toBe(true);
  });
});

describe("memory-bridge（P0-1：Bearer 鉴权 + token 声明 space）", () => {
  const visibleMeta = { spaceScope: { space: "public", visibility: "public" } };

  function bridgeApp(auth?: { tenantId?: string; role?: string; space?: string }) {
    const app = Fastify();
    if (auth) {
      app.addHook("onRequest", async (req) => {
        (req as unknown as { auth: unknown }).auth = auth;
      });
    }
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        queryReadOnly: async () => [
          { meta: { spaceScope: { space: "meta", visibility: "public" } } },
          { meta: { spaceScope: { space: "ts", visibility: "private" } } },
        ],
        memory: {
          retrieve: async ({ anchors }: any) =>
            anchors.includes("absent") ? [] : [{ id: "m1", kind: "note", meta: visibleMeta }],
          get: async (id: string) => (id === "m1" ? { id: "m1", kind: "note", status: "official", meta: visibleMeta } : null),
        } as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    }));
    return app;
  }

  it("无全局 auth hook（未认证）→ 401；旧 SANDBOX_SHARED_SECRET 不再有效", async () => {
    const app = bridgeApp();
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      headers: { authorization: "Bearer sandbox-dev-secret" },
      payload: { op: "query", sql: "SELECT 1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("token 无 space 声明 → 401（fail-closed）", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "retrieve", anchors: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("body 自报 space → 400（space 只能来自 auth token）", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "get", id: "m1", space: "meta" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("query：tenant-agent → 403（raw query 仅 platform-admin）", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "query", sql: "SELECT kind, meta FROM memory_entries LIMIT 3" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("query：platform-admin 按 token space 过滤可见性，缺 meta 行 fail-closed", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "platform-admin", space: "meta" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "query", sql: "SELECT kind, meta FROM memory_entries LIMIT 3" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1); // 仅 meta-public 可见；无 meta 行直接 400
  });

  it("query：缺 meta 行 → 400", async () => {
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { auth: unknown }).auth = { tenantId: "tenant-a", role: "platform-admin", space: "meta" };
    });
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        queryReadOnly: async () => [{ value: 1 }],
        memory: {} as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    }));
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "query", sql: "SELECT 1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("get：跨空间不可见 → 404", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "private-other" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "get", id: "m1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("retrieve：按 token space 过滤可见性", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "public" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "retrieve", anchors: ["a"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("F2：retrieve 固定 official + 传 auth.tenantId（draft/archived 不回）", async () => {
    const metaVisible = { spaceScope: { space: "meta", visibility: "public" } };
    const retrieveCalls: Array<{ anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }> = [];
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { auth: unknown }).auth = { tenantId: "tenant-a", role: "tenant-agent", space: "meta" };
    });
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        queryReadOnly: async () => [],
        memory: {
          retrieve: async (opts: any) => {
            retrieveCalls.push(opts);
            const all = [
              { id: "official-1", kind: "note", status: "official", meta: metaVisible },
              { id: "draft-1", kind: "note", status: "draft", meta: metaVisible },
              { id: "archived-1", kind: "note", status: "archived", meta: metaVisible },
            ];
            return all.filter((e) => !opts.status || opts.status.includes(e.status));
          },
          get: async () => null,
        } as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    }));
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "retrieve", anchors: ["a"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: "official-1", kind: "note", status: "official", meta: metaVisible }]);
    expect(retrieveCalls[0]).toMatchObject({ anchors: ["a"], status: ["official"], tenantId: "tenant-a" });
  });

  it("F2：get 传 auth.tenantId（跨 tenant 读取隔离）", async () => {
    const metaVisible = { spaceScope: { space: "meta", visibility: "public" } };
    const getCalls: Array<{ id: string; opts?: { tenantId?: string } }> = [];
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { auth: unknown }).auth = { tenantId: "tenant-a", role: "tenant-agent", space: "meta" };
    });
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: { publish: async () => ({}), candidates: async () => [], countPending: async () => 0 } as any,
        queryReadOnly: async () => [],
        memory: {
          retrieve: async () => [],
          get: async (id: string, opts?: { tenantId?: string }) => {
            getCalls.push({ id, opts });
            return opts?.tenantId === "tenant-a"
              ? { id: "m1", kind: "note", status: "official", meta: metaVisible }
              : null;
          },
        } as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    }));
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "get", id: "m1" },
    });
    expect(res.statusCode).toBe(200);
    expect(getCalls[0]).toEqual({ id: "m1", opts: { tenantId: "tenant-a" } });
  });

  it("op 非法 → 400", async () => {
    const app = bridgeApp({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" });
    const res = await app.inject({
      method: "POST", url: "/api/v1/kernel/memory-bridge",
      payload: { op: "write" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("K4 Phase 4：knowledge verify/promote 监督通道（N22 4 / R3）", () => {
  function makeMemoryStore() {
    const rows = new Map<string, any>();
    const getCalls: Array<{ id: string; opts?: { tenantId?: string } }> = [];
    return {
      rows,
      getCalls,
      get: async (id: string, opts?: { tenantId?: string }) => {
        getCalls.push({ id, opts });
        return rows.has(id) ? structuredClone(rows.get(id)) : undefined;
      },
      update: async (id: string, patch: { status?: string; meta?: Record<string, unknown> }) => {
        const e = rows.get(id);
        if (!e) throw new Error("entry not found");
        if (patch.status !== undefined) e.status = patch.status;
        if (patch.meta !== undefined) e.meta = { ...(e.meta ?? {}), ...patch.meta };
      },
      write: async (entry: { id: string; status?: string; meta?: Record<string, unknown>; content?: string; kind?: string; anchors?: string[]; tenantId?: string }) => {
        rows.set(entry.id, structuredClone(entry));
      },
      promoteOfficial: createInMemoryPromoteOfficial(rows),
    };
  }

  /**
   * N29 再验收 P0-5：candidate 必须显式携带来源绑定（空 evidence + 空 digest 的 legacy
   * 兼容路径已从 canPromote 删除），因此 seed 的 draft 固定带一条内部 evidence 引用。
   */
  const KNOWLEDGE_EVIDENCE = [{ sourceId: "task:task-1", locator: "task-output#1" }];

  function seedDraft(store: ReturnType<typeof makeMemoryStore>, id = "cand-1") {
    const content = "Earth orbits the Sun.";
    store.rows.set(id, {
      id,
      kind: "task-insight",
      anchors: ["science"],
      content,
      status: "draft",
      tenantId: "tenant-a",
      meta: {
        version: 1,
        provenance: buildKnowledgeProvenance({
          content,
          sourceTaskId: "task-1",
          producerRole: "developer",
          producerModel: "deepseek-v4-flash",
          sourceRefs: ["task:task-1"],
        }),
        evidence: KNOWLEDGE_EVIDENCE,
        verdicts: [],
      },
    });
    return id;
  }

  function makeVerificationRepo() {
    const plans = new Map<string, VerificationPlanRecord>();
    const rows = new Map<string, any>();
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

  function makePlanFor(id: string, overrides: Partial<VerificationPlanRecord> = {}): VerificationPlanRecord {
    const content = "Earth orbits the Sun.";
    return {
      id: `plan-${id}`,
      tenantId: "tenant-a",
      candidateId: id,
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content, domains: ["mathematics"], evidence: KNOWLEDGE_EVIDENCE, effect: null }),
      requiredDomains: ["mathematics"],
      checks: [
        { checkId: "domain-1", kind: "domain", domainId: "mathematics", quorum: 1, eligiblePrincipals: ["tenant:tenant-a:platform-admin", "tenant:tenant-a:domain-expert"], separationFrom: ["producer", "other-verifier"] },
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

  const ADMIN_AUTH = { tenantId: "tenant-a", role: "platform-admin", principalId: "tenant:tenant-a:platform-admin" };

  function knowledgeApp(store = makeMemoryStore(), auth?: { tenantId?: string; role?: string; principalId?: string }, verificationRepo?: KnowledgeVerificationRepo) {
    const app = Fastify();
    if (auth) {
      app.addHook("onRequest", async (req) => {
        (req as unknown as { auth: unknown }).auth = auth;
      });
    }
    registerKernelRoutes(app, wrap(fakeKernel({
      dataWorld: {
        tasks: {
          publish: async (input: any) => ({ id: "t-1", ...input, status: "pending" }),
          candidates: async () => [],
          countPending: async () => 2,
        },
        memory: store,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
    }), verificationRepo));
    return { app, store };
  }

  it("F3：verify 仅 platform-admin——tenant-agent 403", async () => {
    const { app, store } = knowledgeApp(makeMemoryStore(), { tenantId: "tenant-a", role: "tenant-agent", principalId: "tenant:tenant-a:tenant-agent" });
    seedDraft(store);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/verify",
      payload: { planId: "plan-cand-1", checkId: "domain-1", expectedCandidateRevision: 1, kind: "domain", verdict: "pass", note: "evidence verified", domainId: "mathematics" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("F3：promote 仅 platform-admin——tenant-agent 403", async () => {
    const { app, store } = knowledgeApp(makeMemoryStore(), { tenantId: "tenant-a", role: "tenant-agent", principalId: "tenant:tenant-a:tenant-agent" });
    seedDraft(store);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/promote",
      payload: { entryId: "cand-1", planId: "plan-cand-1", expectedCandidateRevision: 1 },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("verify：body 形状非法（缺 planId/checkId/expectedCandidateRevision）→ 400", async () => {
    const { app } = knowledgeApp(makeMemoryStore(), ADMIN_AUTH);
    for (const payload of [
      { checkId: "domain-1", expectedCandidateRevision: 1, kind: "domain", verdict: "pass", note: "ok", domainId: "mathematics" },
      { planId: "plan-1", expectedCandidateRevision: 1, kind: "domain", verdict: "pass", note: "ok", domainId: "mathematics" },
      { planId: "plan-1", checkId: "domain-1", kind: "domain", verdict: "pass", note: "ok", domainId: "mathematics" },
      { planId: "plan-1", checkId: "domain-1", expectedCandidateRevision: 1, kind: "bad", verdict: "pass", note: "ok", domainId: "mathematics" },
      { planId: "plan-1", checkId: "domain-1", expectedCandidateRevision: 1, kind: "domain", verdict: "maybe", note: "ok", domainId: "mathematics" },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/kernel/knowledge/verify", payload });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("F3：domain verify 必须带 domainId；adversarial 不接收 body.domainId", async () => {
    const { app } = knowledgeApp(makeMemoryStore(), ADMIN_AUTH);
    const noDomain = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/verify",
      payload: { planId: "plan-1", checkId: "domain-1", expectedCandidateRevision: 1, kind: "domain", verdict: "pass", note: "ok" },
    });
    expect(noDomain.statusCode).toBe(400);
    expect(noDomain.json().error).toContain("domainId");

    const advWithDomain = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/verify",
      payload: { planId: "plan-1", checkId: "adv-1", expectedCandidateRevision: 1, kind: "adversarial", verdict: "pass", note: "ok", domainId: "mathematics" },
    });
    expect(advWithDomain.statusCode).toBe(400);
    expect(advWithDomain.json().error).toContain("domainId");
    await app.close();
  });

  it("verify：合法 domain pass（platform-admin）→ 200 且 verdict 落 plan 表（不 append meta.verdicts）", async () => {
    const store = makeMemoryStore();
    const { repo, plans, rows: verdictRows } = makeVerificationRepo();
    seedDraft(store, "cand-1");
    const plan = makePlanFor("cand-1", { status: "open" });
    plans.set(plan.id, plan);
    const { app } = knowledgeApp(store, ADMIN_AUTH, repo);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/verify",
      payload: { planId: plan.id, checkId: "domain-1", expectedCandidateRevision: 1, kind: "domain", verdict: "pass", note: "evidence verified", domainId: "mathematics" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((store.rows.get("cand-1").meta as { verdicts?: unknown[] }).verdicts).toHaveLength(0);
    expect([...verdictRows.values()]).toHaveLength(1);
    expect(store.getCalls[0].opts).toEqual({ tenantId: "tenant-a" });
    await app.close();
  });

  it("verify：recordKnowledgeVerdict 拒绝（非 draft）→ 400", async () => {
    const store = makeMemoryStore();
    const { repo, plans } = makeVerificationRepo();
    const id = seedDraft(store);
    const plan = makePlanFor(id, { status: "open" });
    plans.set(plan.id, plan);
    store.rows.get(id).status = "official";
    const { app } = knowledgeApp(store, ADMIN_AUTH, repo);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/verify",
      payload: { planId: plan.id, checkId: "domain-1", expectedCandidateRevision: 1, kind: "domain", verdict: "pass", note: "too late", domainId: "mathematics" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    await app.close();
  });

  it("promote：合规候选（platform-admin）→ 200 且写 official + promotion.principalId + planId", async () => {
    const store = makeMemoryStore();
    const { repo, plans } = makeVerificationRepo();
    const id = seedDraft(store);
    const plan = makePlanFor(id, { status: "satisfied" });
    plans.set(plan.id, plan);
    repo.insertVerdictRow({
      planId: plan.id, tenantId: "tenant-a", checkId: "domain-1", candidateId: id,
      candidateRevision: 1, candidateHash: plan.candidateHash,
      principalId: "tenant:tenant-a:domain-expert", executionId: "task-d",
      kind: "domain", verdict: "pass", reviewerRole: "domain:expert", note: "verified",
      domainId: "mathematics", evidence: [], at: 1,
    });
    repo.insertVerdictRow({
      planId: plan.id, tenantId: "tenant-a", checkId: "adv-1", candidateId: id,
      candidateRevision: 1, candidateHash: plan.candidateHash,
      principalId: "worker:controller:adversarial", executionId: "task-a",
      kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial", note: "no shortcut",
      evidence: [], at: 2,
    });
    const { app } = knowledgeApp(store, ADMIN_AUTH, repo);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/promote",
      payload: { entryId: id, planId: plan.id, expectedCandidateRevision: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id });
    expect(store.rows.get(id).status).toBe("official");
    expect(store.rows.get(id).meta).toMatchObject({
      promotion: { promotedBy: "memory-keeper", principalId: "tenant:tenant-a:platform-admin", planId: plan.id },
    });
    await app.close();
  });

  it("promote：entryId/planId/expectedCandidateRevision 缺失 → 400（platform-admin）", async () => {
    const { app } = knowledgeApp(makeMemoryStore(), ADMIN_AUTH);
    for (const payload of [
      {},
      { planId: "plan-1", expectedCandidateRevision: 1 },
      { entryId: "cand-1", expectedCandidateRevision: 1 },
      { entryId: "cand-1", planId: "plan-1" },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/kernel/knowledge/promote", payload });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("promote：canPromote 拒绝（缺 adversarial pass）→ 400", async () => {
    const store = makeMemoryStore();
    const { repo, plans } = makeVerificationRepo();
    const id = seedDraft(store);
    const plan = makePlanFor(id, { status: "satisfied" });
    plans.set(plan.id, plan);
    repo.insertVerdictRow({
      planId: plan.id, tenantId: "tenant-a", checkId: "domain-1", candidateId: id,
      candidateRevision: 1, candidateHash: plan.candidateHash,
      principalId: "tenant:tenant-a:domain-expert", executionId: "task-d",
      kind: "domain", verdict: "pass", reviewerRole: "domain:expert", note: "verified",
      domainId: "mathematics", evidence: [], at: 1,
    });
    const { app } = knowledgeApp(store, ADMIN_AUTH, repo);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/knowledge/promote",
      payload: { entryId: id, planId: plan.id, expectedCandidateRevision: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    await app.close();
  });
});

describe("P0-3：任务发布的 tenant 只来自 auth token", () => {
  it("publish 携带 req.auth.tenantId，body.tenant 无效", async () => {
    const published: unknown[] = [];
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { auth: unknown }).auth = { tenantId: "tenant-b", role: "tenant-agent" };
    });
    registerKernelRoutes(app, wrap({
      dataWorld: {
        tasks: {
          publish: async (input: Record<string, unknown>) => {
            published.push(input);
            return { id: "t-tenant", status: "pending", ...input };
          },
          candidates: async () => [],
          countPending: async () => 0,
        } as any,
        memory: {} as any,
        transcripts: {} as any,
        audit: {} as any,
      } as any,
      pool: { query: async () => ({ rows: [] }) } as any,
      batchManager: {
        listBatches: async () => [],
        isBatchAlive: () => false,
      } as any,
      watchdog: { getCrashLog: () => [] } as any,
      shutdown: async () => {},
    }));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/tasks",
      payload: { title: "t", text: "x", createdBy: "user", tenant: "tenant-forged" },
    });
    expect(res.statusCode).toBe(201);
    expect(published[0]).toMatchObject({ tenantId: "tenant-b" });
    expect(published[0]).not.toMatchObject({ tenant: "tenant-forged" });
  });
});

describe("N33 Task 5：optimizer 建议/应用 tenant 域化", () => {
  function optimizerKernel(spies: {
    poolQueries: Array<{ sql: string; params: unknown[] }>;
    memoryGets: Array<{ id: string; opts: unknown }>;
    readOnlySql: string[];
  }): KernelRuntime {
    return {
      pool: {
        query: async (sql: string, params: unknown[] = []) => {
          spies.poolQueries.push({ sql, params });
          return { rows: [] };
        },
      } as any,
      dataWorld: {
        tasks: { publish: async () => ({ id: "t-x" }), candidates: async () => [], countPending: async () => 0 },
        memory: {
          get: async (id: string, opts: unknown) => {
            spies.memoryGets.push({ id, opts });
            return null; // 建议不存在 → apply 返回 !ok（只验证 tenant 钉定）
          },
        } as any,
        queryReadOnly: async (sql: string) => {
          spies.readOnlySql.push(sql);
          return [];
        },
        transcripts: {} as any,
        audit: {} as any,
      } as any,
      batchManager: { listBatches: async () => [], isBatchAlive: () => false } as any,
      watchdog: { getCrashLog: () => [] } as any,
      shutdown: async () => {},
    };
  }

  function optimizerApp(spies: Parameters<typeof optimizerKernel>[0], auth: unknown): ReturnType<typeof Fastify> {
    const app = Fastify();
    if (auth) {
      app.addHook("onRequest", async (req) => {
        (req as unknown as { auth: unknown }).auth = auth;
      });
    }
    registerKernelRoutes(app, wrap(optimizerKernel(spies)));
    return app;
  }

  it("GET /kernel/optimizer/suggestions 带 auth tenant → 参数化 tenant 过滤（不经 queryReadOnly）", async () => {
    const spies = { poolQueries: [] as Array<{ sql: string; params: unknown[] }>, memoryGets: [] as Array<{ id: string; opts: unknown }>, readOnlySql: [] as string[] };
    const app = optimizerApp(spies, { tenantId: "tenant-b", role: "platform-admin" });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/optimizer/suggestions" });
      expect(res.statusCode).toBe(200);
      expect(spies.readOnlySql).toHaveLength(0);
      expect(spies.poolQueries).toHaveLength(1);
      expect(spies.poolQueries[0]!.sql).toContain("tenant_id = $1");
      expect(spies.poolQueries[0]!.params).toEqual(["tenant-b"]);
    } finally {
      await app.close();
    }
  });

  it("POST /kernel/optimizer/apply 带 auth tenant → memory store 钉到该 tenant", async () => {
    const spies = { poolQueries: [] as Array<{ sql: string; params: unknown[] }>, memoryGets: [] as Array<{ id: string; opts: unknown }>, readOnlySql: [] as string[] };
    const app = optimizerApp(spies, { tenantId: "tenant-b", role: "platform-admin" });
    try {
      const res = await app.inject({ method: "POST", url: "/api/v1/kernel/optimizer/apply", payload: { id: "sug-1" } });
      expect(res.statusCode).toBe(400); // 建议不存在（fake get → null）
      expect(spies.memoryGets).toHaveLength(1);
      expect(spies.memoryGets[0]).toMatchObject({ id: "sug-1", opts: { tenantId: "tenant-b" } });
    } finally {
      await app.close();
    }
  });

  it("无 auth → 缺省路径（queryReadOnly 无 tenant 过滤，行为与既有版本一致）", async () => {
    const spies = { poolQueries: [] as Array<{ sql: string; params: unknown[] }>, memoryGets: [] as Array<{ id: string; opts: unknown }>, readOnlySql: [] as string[] };
    const app = optimizerApp(spies, null);
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/kernel/optimizer/suggestions" });
      expect(res.statusCode).toBe(200);
      expect(spies.poolQueries).toHaveLength(0);
      expect(spies.readOnlySql).toHaveLength(1);
      expect(spies.readOnlySql[0]).not.toContain("tenant_id = $1");
    } finally {
      await app.close();
    }
  });
});
