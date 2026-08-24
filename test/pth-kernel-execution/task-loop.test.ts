import { describe, it, expect, vi, beforeEach } from "vitest";

// 任务池纯化（2026-08-10 D1）：agent 循环是唯一主路径——mock runAgentTask 隔离 LLM
vi.mock("@away_from/pth-kernel-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@away_from/pth-kernel-execution")>();
  return { ...actual, runAgentTask: vi.fn() };
});

import { runAgentTask } from "@away_from/pth-kernel-execution";
import { TaskLoop } from "../../src/pth/bootstrap/task-loop.js";
import { createWorkerReplica, roleDefinitionRevision } from "@away_from/pth-kernel-execution";

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

  it("W2：实施任务 done.result.planHash 匹配 → submit 通过", async () => {
    const task = { id: "t-impl-ok", title: "实施", text: "x", tags: ["code"], payload: { implementationPlanHash: "abc" } };
    mockedRunAgent.mockResolvedValue({ ok: true, value: { planHash: "abc" }, summary: "s", steps: 1 } as never);
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const loop = new TaskLoop(agentDeps(mockKernel(), role, store));
    await loop.runOnce();
    expect(store.submit).toHaveBeenCalled();
    expect(store.reject).not.toHaveBeenCalled();
  });

  it("W2/W3：实施任务 done.result.planHash 缺失/不匹配 → reject + task.terminal-reject 活动事件，不 submit", async () => {
    const task = { id: "t-impl-bad", title: "实施", text: "x", tags: ["code"], payload: { implementationPlanHash: "abc" } };
    mockedRunAgent.mockResolvedValue({ ok: true, value: { foo: 1 }, summary: "s", steps: 1 } as never);
    const activities: Array<{ kind: string }> = [];
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const deps = agentDeps(mockKernel(), role, store);
    deps.onActivity = (e) => activities.push(e);
    const loop = new TaskLoop(deps);
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalled();
    expect(store.submit).not.toHaveBeenCalled();
    expect(activities.some((e) => e.kind === "task.terminal-reject")).toBe(true);
  });

  it("P3.6：developer fix 任务完成 → 自动派发 debug-case-writer（自修正闭环）", async () => {
    const task = { id: "t1", text: "bug: 计数偶发错误", title: "fix counter", tags: ["fix"], payload: {} };
    const publish = vi.fn(async () => ({ id: "dc1", title: "【debug-case】", text: "x", tags: ["debug-case"], payload: {} }));
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
      publish,
    });
    const kernel = mockKernel();
    const loop = new TaskLoop(agentDeps(kernel, { id: "developer", tags: ["fix"], prompt: "dev" }, store));
    await loop.runOnce();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      tags: ["debug-case"],
      payload: expect.objectContaining({ source: "developer-fix-completed", parentTaskId: "t1" }),
    }));
    const publishCall = (publish.mock.calls[0] as unknown as Array<{ text?: string }>)[0];
    expect(String(publishCall?.text ?? "")).toContain("bug: 计数偶发错误");
  });

  it("P3.6：payload.debugCases=off 关闭自动派发", async () => {
    const task = { id: "t1", text: "bug", title: "fix x", tags: ["fix"], payload: { debugCases: "off" } };
    const publish = vi.fn(async () => ({}));
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
      publish,
    });
    const loop = new TaskLoop(agentDeps(mockKernel(), { id: "developer", tags: ["fix"], prompt: "dev" }, store));
    await loop.runOnce();
    expect(publish).not.toHaveBeenCalled();
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

  it("D5：软终止/警告闭合 → 非终态 requeue（回池重试）", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    mockedRunAgent.mockResolvedValue({ ok: true, value: null, steps: 2, warning: "达到 maxSteps(10) 强制终止" } as never);
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const activity: Array<{ kind: string }> = [];
    const loop = new TaskLoop({ ...agentDeps(kernel, role, store), onActivity: (e) => activity.push({ kind: e.kind }) });
    await loop.runOnce();
    expect(store.reject).toHaveBeenCalledWith("developer", "t1", expect.stringContaining("soft-terminated"), { terminal: false });
    expect(store.submit).not.toHaveBeenCalled();
    expect(activity.some((a) => a.kind === "task.requeued")).toBe(true);
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
      { kernel, role, taskStore: store as any, workspaceMgr: wsMgr, llm: { complete: async () => ({ content: "ok" }) } as any, agentCaps: {} as any, refiner },
    );
    return loop.runOnce();
  }

  it("payload.refine=off → 不调用 refiner", async () => {
    const refiner = { refine: vi.fn(async () => ({})) };
    await runOnceWith({ id: "t1", text: "x", title: "t", payload: { refine: "off" } }, refiner);
    expect(refiner.refine).not.toHaveBeenCalled();
  });

  it("无 refine 字段 → 调用 refiner（默认 auto）并传 scope", async () => {
    const refiner = { refine: vi.fn(async () => ({})) };
    await runOnceWith({ id: "t1", text: "x", title: "t", payload: {} }, refiner);
    expect(refiner.refine).toHaveBeenCalled();
    expect(refiner.refine).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: "t1" }),
      scope: { tenantId: "default", space: "meta" },
    }));
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
      { kernel, role, taskStore: store as any, workspaceMgr: wsMgr, llm: { complete: async () => ({ content: "ok" }) } as any, agentCaps: {} as any, refiner },
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


describe("task loop dispatcher 路径（P1-6）", () => {
  const role = { id: "developer", tags: ["code"], prompt: "dev" };

  function dispatchedDeps(kernel: any, store: any, repository: any) {
    return { ...agentDeps(kernel, role, store), repository };
  }

  function mockRepository(task: any) {
    const lease = {
      taskId: task.id,
      leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6",
      generation: 1,
      scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" },
      workspace: { tenantId: "tenant-a", workspaceId: `task:${task.id}`, taskId: task.id },
      roleId: "developer",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const work = {
      taskId: task.id,
      scope: lease.scope,
      title: task.title,
      text: task.text,
      tags: [],
      payload: task.payload ?? {},
      assignedRole: "developer",
      domains: [],
    };
    return {
      claim: vi.fn(async () => [{ lease, work }]),
      commit: vi.fn(async () => ({ committed: true })),
    };
  }

  it("F5 audit binding：捕获 audit store 对象后 (ev)=>audit.write(ev)，this 绑定生效且事件落库", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
    });
    const kernel = mockKernel();
    const auditStore = {
      events: [] as unknown[],
      async write(ev: unknown) { this.events.push(ev); },
    };
    kernel.dataWorld = { audit: auditStore };
    const repository = mockRepository(task);
    const loop = new TaskLoop(dispatchedDeps(kernel, store, repository));
    await loop.runOnce();
    expect(repository.claim).toHaveBeenCalled();
    expect(repository.commit).toHaveBeenCalled();
    expect(auditStore.events).toHaveLength(1);
    expect(auditStore.events[0]).toMatchObject({ eventType: "task_completed", taskId: "t1", tenantId: "tenant-a" });
  });

  it("F5 drainSideEffects：每轮 claim 前 kick 一次（sync 回调）", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({
      candidates: vi.fn(async () => [task]),
      claimTopN: vi.fn(async () => [task]),
    });
    const drain = vi.fn();
    const kernel = mockKernel();
    const loop = new TaskLoop({ ...agentDeps(kernel, role, store), drainSideEffects: drain });
    await loop.runOnce();
    expect(drain).toHaveBeenCalledTimes(1);
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

describe("N28 T2：replica 生命周期与身份戳记（TaskLoop）", () => {
  const role = { id: "developer", tags: ["code"], prompt: "dev" };
  const workerId = "10000000-0000-4000-8000-000000000051";
  const makeReplica = () => createWorkerReplica("developer", roleDefinitionRevision(role), "batch-a", () => workerId);

  async function waitUntil(cond: () => boolean): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > 2000) throw new Error("waitUntil timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("claim=0：replica 保持 idle（不 startTask）", async () => {
    const store = mockTaskStore({ candidates: vi.fn(async () => []), claimTopN: vi.fn(async () => []) });
    const replica = makeReplica();
    const loop = new TaskLoop({ ...agentDeps(mockKernel(), role, store), replica });
    expect(await loop.runOnce()).toBe(false);
    expect(replica.snapshot().state).toBe("idle");
  });

  it("completed：dispatch/grant/activity/audit 全链路 worker 与 role 分字段，finally 回 idle", async () => {
    const task = { id: "t1", text: "do x", title: "x" };
    const store = mockTaskStore({ candidates: vi.fn(async () => [task]), claimTopN: vi.fn(async () => [task]) });
    const dispatch: unknown[] = [];
    const grants: unknown[] = [];
    const activities: unknown[] = [];
    const auditWrite = vi.fn(async () => {});
    const kernel = {
      ...mockKernel(),
      setTaskDispatchContext: (ctx: unknown) => { dispatch.push(ctx); },
      setExecutionGrantContext: (ctx: unknown) => { grants.push(ctx); },
      dataWorld: { audit: { write: auditWrite } },
    };
    const replica = makeReplica();
    const loop = new TaskLoop({
      ...agentDeps(kernel as never, role, store),
      replica,
      onActivity: (e) => activities.push(e),
    });
    expect(await loop.runOnce()).toBe(true);
    expect(replica.snapshot()).toMatchObject({ state: "idle", currentTaskId: undefined });
    expect(dispatch[0]).toMatchObject({ taskId: "t1", roleId: "developer", worker: replica.ref });
    expect(grants[0]).toMatchObject({ taskId: "t1", principalId: `worker:${workerId}` });
    expect(activities.some((e) => (e as { kind: string }).kind === "task.claim" && (e as { workerId?: string }).workerId === workerId)).toBe(true);
    const auditCall = (auditWrite.mock.calls as unknown as Array<Array<{ actor?: string; workerId?: string; payload?: { roleId?: string } }>>).at(-1)?.[0];
    expect(auditCall).toMatchObject({ actor: `worker:${workerId}`, workerId, payload: { roleId: "developer" } });
  });

  it("throw / ok:false 都经同一 finally 回 idle", async () => {
    const task = { id: "t2", text: "boom", title: "b" };
    const store = mockTaskStore({ candidates: vi.fn(async () => [task]), claimTopN: vi.fn(async () => [task]) });
    const replica = makeReplica();
    mockedRunAgent.mockRejectedValue(new Error("boom"));
    const loop = new TaskLoop({ ...agentDeps(mockKernel(), role, store), replica });
    await loop.runOnce();
    expect(replica.snapshot().state).toBe("idle");

    mockedRunAgent.mockResolvedValue({ ok: false, error: "agent-rejected" } as never);
    const task2 = { id: "t3", text: "reject", title: "r" };
    const store2 = mockTaskStore({ candidates: vi.fn(async () => [task2]), claimTopN: vi.fn(async () => [task2]) });
    const replica2 = makeReplica();
    const loop2 = new TaskLoop({ ...agentDeps(mockKernel(), role, store2), replica: replica2 });
    await loop2.runOnce();
    expect(replica2.snapshot().state).toBe("idle");
  });

  it("busy 任务中 pause → draining，任务完成后 paused", async () => {
    const task = { id: "t4", text: "slow", title: "s" };
    const store = mockTaskStore({ candidates: vi.fn(async () => [task]), claimTopN: vi.fn(async () => [task]) });
    let release!: (v: unknown) => void;
    mockedRunAgent.mockImplementation(() => new Promise<any>((resolve) => { release = resolve; }));
    const replica = makeReplica();
    const loop = new TaskLoop({ ...agentDeps(mockKernel(), role, store), replica });
    const run = loop.runOnce();
    await waitUntil(() => replica.snapshot().state === "busy");
    replica.pause();
    expect(replica.snapshot()).toMatchObject({ state: "draining", currentTaskId: "t4" });
    release({ ok: true, value: "done", summary: "s", steps: 1 });
    await run;
    expect(replica.snapshot()).toMatchObject({ state: "paused", currentTaskId: undefined });
  });
});
