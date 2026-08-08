import { describe, it, expect } from "vitest";
import { buildCapabilities } from "../../src/pth/kernel/interpreter/capability";
import { createWorkerKernel } from "../../src/pth/kernel/interpreter/index";
import { TsInterpreter } from "../../src/pth/kernel/interpreter/ts-interpreter";

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
  it("buildCapabilities injects llm/memory/skills/tasks", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(caps.llm).toBeDefined();
    expect(caps.memory).toBeDefined();
    expect(caps.skills).toBeDefined();
    expect(caps.tasks).toBeDefined();
  });

  it("tasks capability only exposes peek/submit (not claim/reject)", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(caps.tasks.peek).toBeDefined();
    expect(caps.tasks.submit).toBeDefined();
    expect(caps.tasks.claim).toBeUndefined();   // 认领由 TaskLoop 机械控制
    expect(caps.tasks.reject).toBeUndefined();
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
  it("tasks.peek from VM program keeps this bound to TaskStore", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorldWithThis(),
    });
    const res = await kernel.ts.execute("tasks.peek()");
    // 未 bind 前：this = capabilities.tasks 对象 → this.pool undefined → throw → res.ok false
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([]);
  });

  it("tasks.submit from VM program keeps this bound and passes arguments", async () => {
    const records: Array<{ agentId: string; taskId: string; outputRef: unknown }> = [];
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorldWithThis(records),
    });
    const res = await kernel.ts.execute("await tasks.submit('agent-1', 'task-42', { ref: 'out-1' })");
    expect(res.ok).toBe(true);
    expect(records).toEqual([{ agentId: "agent-1", taskId: "task-42", outputRef: { ref: "out-1" } }]);
  });

  it("memory capability methods are this-bound (survive method extraction)", async () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorldWithThis(),
    });
    const { retrieve, write, bumpHitCount } = caps.memory as {
      retrieve: () => Promise<unknown[]>;
      write: () => Promise<void>;
      bumpHitCount: () => Promise<void>;
    };
    // 解构后裸调用——未 bindAll 前 this = undefined → this.pool undefined → reject
    await expect(retrieve()).resolves.toEqual([]);
    await expect(write()).resolves.toBeUndefined();
    await expect(bumpHitCount()).resolves.toBeUndefined();
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
    const res = await kernel.ts.execute("tasks.peek()");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([]);
  });
});
