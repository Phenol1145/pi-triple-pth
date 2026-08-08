import { describe, it, expect, vi } from "vitest";
import { TaskLoop } from "../../src/pth/kernel/execution/task-loop";

/** mock TaskStore（对齐 Spec C TaskStore 接口） */
function mockTaskStore(overrides: Partial<any> = {}) {
  return {
    candidates: vi.fn(async () => []),
    claimTopN: vi.fn(async () => []),
    reject: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    ...overrides,
  };
}

/** mock WorkerKernel（ts.execute 可配） */
function mockKernel(tsExecute?: any) {
  return {
    // 适配：brief 原 helper 的 ts.execute 是裸 async 函数，vitest 的 toHaveBeenCalledWith 要求 spy——
    // 用 vi.fn 包裹（不改默认行为/抛错传播，仅使断言可执行）
    ts: { execute: vi.fn(tsExecute ?? (async () => ({ ok: true, value: "done", durationMs: 1 }))) },
    bash: { execute: async () => ({ ok: true }) },
    python: { execute: async () => ({ ok: true }) },
    llm: { complete: async () => ({ content: "ok" }) },
    dataWorld: {} as any,
    reset: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

describe("task loop", () => {
  const role = { id: "developer", labelPatterns: ["code"], prompt: "dev" };

  it("claims and executes candidate tasks", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop({ kernel, role, taskStore: store, workspaceMgr: { allocate: async () => ({ dir: "/ws/t1", tenant: "default" }), archive: async () => ({ artifactPath: "/art/t1" }) } as any });
    await loop.runOnce();
    expect(store.candidates).toHaveBeenCalledWith("developer");
    expect(store.claimTopN).toHaveBeenCalledWith("developer", ["t1"]);
    expect(kernel.ts.execute).toHaveBeenCalledWith("do x", expect.objectContaining({ cwd: "/ws/t1" }));
    expect(store.submit).toHaveBeenCalledWith("developer", "t1", expect.anything());
    expect(kernel.reset).toHaveBeenCalled();
  });

  it("rejects tasks assessed as unfit", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => []),   // assess 判定不认领
      reject: vi.fn(async () => {}),
    });
    // 需要 assess 返回 reject——通过 monkey-patch 或让 claimTopN 返回空触发空转防护？
    // 空转防护：claim/reject 都空 → 全部 reject（对抗性审核 I4）
    const kernel = mockKernel();
    const loop = new TaskLoop({ kernel, role, taskStore: store, workspaceMgr: {} as any });
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", "assessed-as-unfit");
  });

  it("does not claim already-claimed tasks (race is normal)", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => []),   // 竞态：已被他人认领
    });
    const kernel = mockKernel();
    const loop = new TaskLoop({ kernel, role, taskStore: store, workspaceMgr: {} as any });
    await loop.runOnce();
    expect(kernel.ts.execute).not.toHaveBeenCalled();
    expect(store.submit).not.toHaveBeenCalled();
  });

  it("rejects task on execution crash (claim=commitment)", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel(async () => { throw new Error("boom"); });
    const loop = new TaskLoop({ kernel, role, taskStore: store, workspaceMgr: { allocate: async () => ({ dir: "/ws/t1", tenant: "default" }), archive: async () => ({ artifactPath: "/art/t1" }) } as any });
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", expect.stringContaining("execution-crashed"));
    expect(store.submit).not.toHaveBeenCalled();
  });

  it("rejects task on interpreter ok:false (试运行发现 SyntaxError 误标 completed)", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel(async () => ({ ok: false, error: { message: "Expected ',', got 'string literal'" }, durationMs: 1 }));
    const loop = new TaskLoop({ kernel, role, taskStore: store, workspaceMgr: { allocate: async () => ({ dir: "/ws/t1", tenant: "default" }), archive: async () => ({ artifactPath: "/art/t1" }) } as any });
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", expect.stringContaining("execution-failed"));
    expect(store.submit).not.toHaveBeenCalled();
  });

  it("submit passes output ref and archives", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const archive = vi.fn(async () => ({ artifactPath: "/art/t1" }));
    const kernel = mockKernel();
    const loop = new TaskLoop({ kernel, role, taskStore: store, workspaceMgr: { allocate: async () => ({ dir: "/ws/t1", tenant: "default" }), archive } as any });
    await loop.runOnce();
    expect(archive).toHaveBeenCalled();
    expect(store.submit).toHaveBeenCalled();
  });
});

describe("task loop refiner 钩子", () => {
  const role = { id: "developer", labelPatterns: ["code"], prompt: "dev" };

  function runOnceWith(task: any, refiner: any) {
    const store = {
      candidates: async () => [task],
      claimTopN: async () => [task],
      reject: async () => {},
      submit: async () => {},
    };
    const kernel = {
      ts: { execute: async () => ({ ok: true, value: "done", durationMs: 1 }) },
      bash: { execute: async () => ({ ok: true }) },
      python: { execute: async () => ({ ok: true }) },
      llm: { complete: async () => ({ content: "ok" }) },
      dataWorld: {} as any,
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset: () => {},
      dispose: () => {},
    } as any;
    const loop = new TaskLoop(
      { kernel, role, taskStore: store, workspaceMgr: { allocate: async () => ({ dir: "/ws/t1", tenant: "default" }), archive: async () => ({ artifactPath: "/art/t1" }) }, refiner },
    );
    return loop.runOnce();
  }

  it("payload.refine=off → 不调用 refiner", async () => {
    const refiner = { refine: vi.fn(async () => ({})) };
    await runOnceWith({ id: "t1", text: "x", title: "t", payload: { refine: "off" } }, refiner);
    expect(refiner.refine).not.toHaveBeenCalled();
  });

  it("无 refine 字段 → 调用 refiner（默认 auto）", async () => {
    const refiner = { refine: vi.fn(async () => ({})) };
    await runOnceWith({ id: "t1", text: "x", title: "t", payload: {} }, refiner);
    expect(refiner.refine).toHaveBeenCalled();
  });

  it("refine 抛错 → 任务仍 completed（旁路降级）", async () => {
    const refiner = { refine: vi.fn(async () => { throw new Error("llm down"); }) };
    const store = {
      candidates: async () => [{ id: "t1", text: "x", title: "t", payload: {} }],
      claimTopN: async () => [{ id: "t1", text: "x", title: "t", payload: {} }],
      reject: vi.fn(async () => {}),
      submit: vi.fn(async () => {}),
    };
    const kernel = {
      ts: { execute: async () => ({ ok: true, value: "done", durationMs: 1 }) },
      bash: { execute: async () => ({ ok: true }) },
      python: { execute: async () => ({ ok: true }) },
      llm: { complete: async () => ({ content: "ok" }) },
      dataWorld: {} as any,
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset: () => {},
      dispose: () => {},
    } as any;
    const loop = new TaskLoop(
      { kernel, role, taskStore: store, workspaceMgr: { allocate: async () => ({ dir: "/ws/t1", tenant: "default" }), archive: async () => ({ artifactPath: "/art/t1" }) }, refiner },
    );
    await loop.runOnce();
    expect(store.submit).toHaveBeenCalled();   // 任务仍提交（completed）
  });
});
