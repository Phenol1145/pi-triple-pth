import { describe, it, expect } from "vitest";
import { buildCapabilities } from "../../src/pth/impls/kernels/capability";
import { createWorkerKernel } from "../../src/pth/impls/kernels/index";
import { TsInterpreter } from "../../src/pth/impls/kernels/ts-interpreter";

/** mock DataWorldAccess（Spec C 接口） */
function mockDataWorld() {
  return {
    // 适配说明：brief 原 mock 的 tasks 用 `peek`，但 Spec C TaskStore 真实形状是
    // `candidates`（capability 实现按 `dataWorld.tasks.candidates` 映射）——mock 对齐真实接口。
    tasks: { candidates: async () => [], submit: async () => {} },
    memory: { retrieve: async () => [], write: async () => {} },
    transcripts: {},
    audit: {},
    queryReadOnly: async () => [],
  } as any;
}

describe("capabilities", () => {
  it("buildCapabilities injects llm/memory/skills（tasks 已摘除——权限 v2 R3）", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(caps.llm).toBeDefined();
    expect(caps.memory).toBeDefined();
    expect(caps.skills).toBeDefined();
    // tasks 能力整体摘除（任务代码不可直接操作任务池——task-loop 内部走 store）
    expect(caps.tasks).toBeUndefined();
  });

  it("injects bash/python interpreters when provided", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
      bash: { execute: async () => ({}) } as any,
      python: { execute: async () => ({}) } as any,
    });
    expect(caps.bash).toBeDefined();
    expect(caps.python).toBeDefined();
  });

  it("B4 Phase 3：skills.maintain 只注入 memory-keeper 角色", () => {
    const dataWorld = {
      ...mockDataWorld(),
      memory: {
        listIds: async () => [],
        get: async () => undefined,
        write: async () => {},
        update: async () => {},
      },
    } as any;
    const keeper = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld,
      roleId: "memory-keeper",
    });
    const developer = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld,
      roleId: "developer",
    });
    expect((keeper.skills as Record<string, unknown>).maintain).toBeDefined();
    expect((developer.skills as Record<string, unknown>).maintain).toBeUndefined();
  });
});

/**
 * 带 this 依赖的 mock（Finding F1 回归）：方法体访问 this.pool（真实 PgTaskStore/PgMemoryStore
 * 均用 this.pool.query，见 task-store-pg.ts:52 / memory-store-pg.ts）。若能力注入丢失 this 绑定，
 * 调用时 this.pool 为 undefined → 抛错。旧 mock 用无 this 的箭头函数掩盖了此 bug。
 */
function mockDataWorldWithThis(records?: Array<{ agentId: string; taskId: string; outputRef: unknown }>) {
  return {
    tasks: {
      pool: {},
      async candidates(this: unknown) {
        if (!this || !(this as { pool?: unknown }).pool) {
          throw new Error("this binding lost: this.pool undefined (tasks.candidates)");
        }
        return [];
      },
      async submit(this: unknown, agentId: string, taskId: string, outputRef: unknown) {
        if (!this || !(this as { pool?: unknown }).pool) {
          throw new Error("this binding lost: this.pool undefined (tasks.submit)");
        }
        records?.push({ agentId, taskId, outputRef });
      },
    },
    memory: {
      pool: {},
      async retrieve(this: unknown) {
        if (!this || !(this as { pool?: unknown }).pool) {
          throw new Error("this binding lost: this.pool undefined (memory.retrieve)");
        }
        return [];
      },
      async write(this: unknown) {
        if (!this || !(this as { pool?: unknown }).pool) {
          throw new Error("this binding lost: this.pool undefined (memory.write)");
        }
      },
      async bumpHitCount(this: unknown) {
        if (!this || !(this as { pool?: unknown }).pool) {
          throw new Error("this binding lost: this.pool undefined (memory.bumpHitCount)");
        }
      },
    },
    transcripts: {},
    audit: {},
    queryReadOnly: async () => [],
  } as any;
}

describe("capability this-binding (F1)", () => {
  it("memory capability methods are closure-bound (survive method extraction) + 白名单面（2026-08-12 审计 CRITICAL-1）", async () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorldWithThis(),
    });
    const { retrieve, write } = caps.memory as {
      retrieve: () => Promise<unknown[]>;
      write: () => Promise<void>;
    };
    // 解构后裸调用——白名单方法用闭包捕获 store（this 无关）；raw 方法（bumpHitCount/incrementAggregate）不再暴露
    await expect(retrieve()).resolves.toEqual([]);
    await expect(write({ kind: "memory", content: "x", meta: { visibility: "public" } } as never)).resolves.toBeUndefined();   // 权限 v2：kind 必填 + ASP 可见性声明
    expect((caps.memory as Record<string, unknown>)["bumpHitCount"]).toBeUndefined();
    expect((caps.memory as Record<string, unknown>)["incrementAggregate"]).toBeUndefined();
  });

  it("memory.retrieve from VM program still works via bound wrapper", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorldWithThis(),
    });
    const res = await kernel.ts.execute("await memory.retrieve()");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([]);
  });
});

describe("worker kernel", () => {
  it("createWorkerKernel assembles all interpreters + llm + dataWorld", () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(kernel.ts).toBeInstanceOf(TsInterpreter);
    expect(kernel.bash).toBeDefined();
    expect(kernel.python).toBeDefined();
    expect(kernel.llm).toBeDefined();
    expect(kernel.dataWorld).toBeDefined();
  });

  it("kernel.reset resets all interpreters", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    await kernel.ts.execute("let x = 42");
    kernel.reset();
    const res = await kernel.ts.execute("typeof x");
    expect(res.value).toBe("undefined");
  });

  it("kernel exposes capabilities usable from TS program", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    // tasks 已摘除（权限 v2 R3）——改用 memory.retrieve 验证能力可用性
    const res = await kernel.ts.execute("await memory.retrieve({ kinds: ['task-insight'] })");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([]);
    // tasks 不再可表达（不是禁止——是不存在）
    const res2 = await kernel.ts.execute("typeof tasks");
    expect(res2.value).toBe("undefined");
  });
});

describe("exec 执行模式（2026-08-11 元命令拆分——single/program/auto）", () => {
  function mk() {
    // createWorkerKernel 内部自建 capabilities（不接收 capabilities 参数）
    return createWorkerKernel({ dataWorld: mockDataWorld() } as any);
  }

  it("single：单表达式强制 return 包装——completion value 必回", async () => {
    const k = mk();
    // 含尾分号（旧启发式会误判多语句）
    const r1 = await k.ts.execute("await Promise.resolve(42);", { exec: "single" });
    expect(r1.ok).toBe(true);
    expect(r1.value).toBe(42);
    // 对象字面量（旧启发式按块解析）
    const r2 = await k.ts.execute("({ total: 7 })", { exec: "single" });
    expect(r2.ok).toBe(true);
    expect((r2.value as any).total).toBe(7);
    // 字符串字面量含分号（旧启发式命中多语句分隔符）
    const r3 = await k.ts.execute('"a;b"', { exec: "single" });
    expect(r3.ok).toBe(true);
    expect(r3.value).toBe("a;b");
    // 模板串内换行（旧启发式命中 \\n 分隔符）
    const r4 = await k.ts.execute("`line1\nline2`", { exec: "single" });
    expect(r4.ok).toBe(true);
    expect(r4.value).toBe("line1\nline2");
  });

  it("single：声明语句 → 语法错误（显式声明语义——调用方负责单表达式）", async () => {
    const k = mk();
    const r = await k.ts.execute("const a = 1", { exec: "single" });
    expect(r.ok).toBe(false);
    expect((r.error?.message ?? "").length).toBeGreaterThan(0);
  });

  it("program：完整程序块包装（声明/多语句/尾表达式捕获）", async () => {
    const k = mk();
    const r1 = await k.ts.execute("const a = 40; const b = 2; a + b", { exec: "program" });
    expect(r1.ok).toBe(true);
    expect(r1.value).toBe(42);
    // 单表达式也按程序执行（块包装——值捕获走尾表达式）
    const r2 = await k.ts.execute("await Promise.resolve(42)", { exec: "program" });
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(42);
    // 控制流
    const r3 = await k.ts.execute("let n = 0; for (let i = 0; i < 3; i++) n += i; n", { exec: "program" });
    expect(r3.ok).toBe(true);
    expect(r3.value).toBe(3);
  });

  it("auto（默认）：旧启发式行为不变（回归）", async () => {
    const k = mk();
    const r1 = await k.ts.execute("await Promise.resolve(42);");
    expect(r1.ok).toBe(true);
    expect(r1.value).toBe(42);
    const r2 = await k.ts.execute("const a = 1; a");
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(1);
    // 无 await/return 的纯语句程序：裸执行
    const r3 = await k.ts.execute("globalThis.__side = 5");
    expect(r3.ok).toBe(true);
  });
});

describe("SandboxKernel 自愈（2026-08-12 复测发现）", () => {
  it("disposed 后 execute 自动重建（重新 acquire——不再永久失败）", async () => {
    const { SandboxKernel } = await import("@away_from/pth-sandbox");
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      calls.push(u.split("/").pop() ?? "");
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      if (u.endsWith("/kernel/acquire")) return new Response(JSON.stringify({ lease: { id: `4f5e3f44-ec85-4e83-9c99-2d17d343d0e${calls.length}`, generation: 1, expiresAt: "2099-01-01T00:00:00.000Z" } }), { status: 200 });
      if (u.endsWith("/kernel/execute")) return new Response(JSON.stringify({ ok: true, value: 1, stdout: "1", durationMs: 1, language: "python" }), { status: 200 });
      if (u.endsWith("/kernel/release")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const k = new SandboxKernel({ url: "http://mock", secret: "s", language: "python", acquireOnInit: false });
      const r1 = await k.execute("1+1");
      expect(r1.ok).toBe(true);
      k.dispose();   // 模拟 dispose 事件（shutdown 竞态）
      const r2 = await k.execute("1+1");   // 自愈：不抛 disposed——重新 acquire
      expect(r2.ok).toBe(true);
      expect(calls.filter((c) => c === "acquire").length).toBe(2);   // 第二次重新 acquire
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
