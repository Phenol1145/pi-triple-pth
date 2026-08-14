import { describe, it, expect, vi, beforeEach } from "vitest";

// 任务池纯化（2026-08-10 D1）：agent 循环是唯一主路径——mock runAgentTask 隔离 LLM
vi.mock("../../src/pth/kernel/execution/agent-loop.js", () => ({
  runAgentTask: vi.fn(),
}));

import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import { TaskLoop } from "../../src/pth/kernel/execution/task-loop.js";

const mockedRunAgent = vi.mocked(runAgentTask);

beforeEach(() => {
  mockedRunAgent.mockReset();
  mockedRunAgent.mockResolvedValue({ ok: true, value: "done", summary: "s", steps: 1 } as never);
});

function mockTaskStore(overrides: any = {}) {
  return {
    candidates: async () => [],
    claimTopN: async () => [],
    reject: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

/** mock WorkerKernel（ts.execute 可配——translate 降级通道断言用） */
function mockKernel(tsExecute?: any) {
  return {
    ts: { execute: vi.fn(tsExecute ?? (async () => ({ ok: true, value: "done", durationMs: 1 }))) },
    bash: { execute: async () => ({ ok: true }) },
    python: { execute: async () => ({ ok: true }) },
    llm: { complete: async () => ({ content: "ok" }) },
    dataWorld: {} as any,
    reset: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

const wsMgr = { allocate: async () => ({ dir: "/ws/t1", tenant: "default" }), archive: async () => ({ artifactPath: "/art/t1" }) } as any;

/** agent 路径 deps（llm + agentCaps 齐备 → 唯一主路径） */
function agentDeps(kernel: any, role: any, store: any) {
  return {
    kernel, role, taskStore: store, workspaceMgr: wsMgr,
    llm: { complete: async () => ({ content: "ok" }) } as any,
    agentCaps: { fs: {} } as any,
  };
}

describe("task loop（任务池纯化——agent 循环唯一主路径）", () => {
  const role = { id: "developer", tags: ["code"], prompt: "dev" };

  it("claims and executes candidate tasks（agent 路径）", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(store.candidates).toHaveBeenCalledWith("developer");
    expect(store.claimTopN).toHaveBeenCalledWith("developer", ["t1"]);
    // agent 循环收到任务正文；ts 直执行不再调用
    expect(mockedRunAgent).toHaveBeenCalledWith(expect.objectContaining({ task: { title: "x", text: "do x" } }));
    expect(kernel.ts.execute).not.toHaveBeenCalled();
    expect(store.submit).toHaveBeenCalledWith("developer", "t1", expect.anything());
    expect(kernel.reset).toHaveBeenCalled();
  });

  it("正交化：零认领（队列空/全不可认领）直接返回，不再 reject 放回池", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => []),
      reject: vi.fn(async () => {}),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(store.reject).not.toHaveBeenCalled();
  });

  it("does not claim already-claimed tasks (race is normal)", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => []),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(store.submit).not.toHaveBeenCalled();
  });

  it("rejects task on agent crash (claim=commitment)", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    mockedRunAgent.mockRejectedValue(new Error("boom"));
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", expect.stringContaining("execution-crashed"), { terminal: true });
    expect(store.submit).not.toHaveBeenCalled();
  });

  it("agent ok:false → terminal reject（失败原因透传）", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    mockedRunAgent.mockResolvedValue({ ok: false, error: "llm exploded", steps: 3 } as never);
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", "llm exploded", { terminal: true });
    expect(store.submit).not.toHaveBeenCalled();
  });

  it("agent 完成但无产物 → reject agent-no-output（完成标准强制）", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    mockedRunAgent.mockResolvedValue({ ok: true, value: null, steps: 2 } as never);
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", expect.stringContaining("agent-no-output"), { terminal: true });
  });

  it("submit passes output ref and archives", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const archive = vi.fn(async () => ({ artifactPath: "/art/t1" }));
    const kernel = mockKernel();
    const loop = new TaskLoop({ ...agentDeps(kernel, role, store), workspaceMgr: { ...wsMgr, archive } });
    await loop.runOnce();
    expect(archive).toHaveBeenCalled();
    expect(store.submit).toHaveBeenCalled();
  });

  it("降级：无 agentCaps → translate 一次性转译 → ts 直执行", async () => {
    const task = { id: "t1", text: "算 1+1", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop({
      kernel, role, taskStore: store, workspaceMgr: wsMgr,
      llm: { complete: async () => ({ content: "return { v: 2 }" }) } as any,
      // 无 agentCaps → 降级通道
    });
    await loop.runOnce();
    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(kernel.ts.execute).toHaveBeenCalledWith("return { v: 2 }", expect.objectContaining({ cwd: "/ws/t1" }));
    expect(store.submit).toHaveBeenCalled();
  });

  it("降级：转译后 ts 执行 ok:false → execution-failed reject", async () => {
    const task = { id: "t1", text: "算 1+1", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel(async () => ({ ok: false, error: { message: "Expected ';'" }, durationMs: 1 }));
    const loop = new TaskLoop({
      kernel, role, taskStore: store, workspaceMgr: wsMgr,
      llm: { complete: async () => ({ content: "return {" }) } as any,
    });
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", expect.stringContaining("execution-failed"), { terminal: true });
  });

  it("无 llm → terminal reject no-llm（纯化后无直执行路径）", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const loop = new TaskLoop({ kernel, role, taskStore: store, workspaceMgr: wsMgr });
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", expect.stringContaining("no-llm"), { terminal: true });
    expect(kernel.ts.execute).not.toHaveBeenCalled();
  });
});

describe("task loop refiner 钩子", () => {
  const role = { id: "developer", tags: ["code"], prompt: "dev" };

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
      { kernel, role, taskStore: store, workspaceMgr: wsMgr, llm: { complete: async () => ({ content: "ok" }) } as any, agentCaps: {} as any, refiner },
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
      { kernel, role, taskStore: store, workspaceMgr: wsMgr, llm: { complete: async () => ({ content: "ok" }) } as any, agentCaps: {} as any, refiner },
    );
    await loop.runOnce();
    expect(store.submit).toHaveBeenCalled();   // 任务仍提交（completed）
  });
});

describe("任务终态审计（A2 Phase 3——审计两平面接线：PG audit_log）", () => {
  const role = { id: "developer", tags: ["code"], prompt: "dev" };

  it("completed → audit.write task_completed（actor/taskId/payload）", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
      submit: vi.fn(async () => 1),
    });
    const write = vi.fn(async () => {});
    const kernel = mockKernel();
    kernel.dataWorld = { audit: { write } };
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(write).toHaveBeenCalledWith({ eventType: "task_completed", actor: "developer", taskId: "t1", payload: { submitAffected: 1 } });
  });

  it("rejected → audit.write task_rejected（含原因摘要）", async () => {
    const task = { id: "t2", text: "do y", title: "y" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
      reject: vi.fn(async () => 1),
    });
    const write = vi.fn(async () => {});
    const kernel = mockKernel();
    kernel.dataWorld = { audit: { write } };
    mockedRunAgent.mockResolvedValueOnce({ ok: false, error: "boom" } as never);
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(write).toHaveBeenCalledWith({ eventType: "task_rejected", actor: "developer", taskId: "t2", payload: { reason: "boom" } });
  });

  it("审计失败不阻断任务流（write 抛错——任务照常 submit）", async () => {
    const task = { id: "t3", text: "do z", title: "z" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
      submit: vi.fn(async () => 1),
    });
    const kernel = mockKernel();
    kernel.dataWorld = { audit: { write: vi.fn(async () => { throw new Error("pg down"); }) } };
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(store.submit).toHaveBeenCalled();
  });

  it("dataWorld 无 audit（存量 mock 兼容）——跳过不抛", async () => {
    const task = { id: "t4", text: "do w", title: "w" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();   // dataWorld = {}
    const loop = new TaskLoop(agentDeps(kernel, role, store));
    await loop.runOnce();
    expect(store.submit).toHaveBeenCalled();
  });
});


describe("复测任务透传（2026-08-14 N6 一等化）", () => {
  const role = { id: "developer", tags: ["code"], prompt: "dev" };

  it("payload.verifyOf → optimizer.collect 携带（受控证据通道）", async () => {
    const task = { id: "tv1", text: "verify x", title: "v", payload: { verifyOf: "sug-v" } };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const collect = vi.fn();
    const kernel = mockKernel();
    const loop = new TaskLoop({ ...agentDeps(kernel, role, store), optimizer: { collect } as never });
    await loop.runOnce();
    expect(collect).toHaveBeenCalled();
    const call = collect.mock.calls[0] as unknown as [unknown, { verifyOf?: string }];
    expect(call[1].verifyOf).toBe("sug-v");
  });

  it("普通任务 → verifyOf undefined（不误标）", async () => {
    const task = { id: "tv2", text: "normal", title: "n" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const collect = vi.fn();
    const loop = new TaskLoop({ ...agentDeps(mockKernel(), role, store), optimizer: { collect } as never });
    await loop.runOnce();
    const call = collect.mock.calls[0] as unknown as [unknown, { verifyOf?: string }];
    expect(call[1].verifyOf).toBeUndefined();
  });
});
