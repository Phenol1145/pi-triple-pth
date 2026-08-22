import { describe, expect, it, vi } from "vitest";
import {
  buildCapabilities,
  type TaskDispatchPort,
} from "../../src/pth/impls/kernels/capability.js";
import { PtcContractError } from "@away_from/pth-kernel-interpreter";
import type { TaskDispatchContext } from "@away_from/pth-contracts";

function fakeDataWorld(): Record<string, unknown> {
  return {
    memory: {
      retrieve: async () => [],
    },
    tasks: { publish: async () => ({}) },
    queryReadOnly: async () => [],
    queryTemplate: async () => [],
    pgStat: async () => [],
  };
}

const fakeToolstore = {
  readText: async () => "export default () => ({});",
  list: async () => [],
  listDirs: async () => [],
};

describe("W8 P1：tasks.delegate/await 能力注入", () => {
  it("taskControl 缺省 → 不注入 tasks 键（叶子/未授权角色无投递面）", () => {
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
    });
    expect(caps["tasks"]).toBeUndefined();
  });

  it("任务上下文未盖章 → 结构化 PtcContractError（不伪造调用者）", async () => {
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: { delegate: async () => ({ taskId: "x", roleId: "coder", path: ["x"] }), awaitTask: async () => ({ status: "pending" }) },
      taskContext: { current: null },
    });
    const tasks = caps["tasks"] as { delegate: (i: unknown) => Promise<unknown>; await: (i: unknown) => Promise<unknown> };
    await expect(tasks.delegate({ to: "coder", title: "t", text: "x" })).rejects.toBeInstanceOf(PtcContractError);
    await expect(tasks.delegate({ to: "coder", title: "t", text: "x" })).rejects.toThrow(/任务上下文未就绪/);
    await expect(tasks.await({ taskId: "x" })).rejects.toThrow(/任务上下文未就绪/);
  });

  it("任务上下文盖章 → delegate/await 以服务器身份转发（scope 由上下文派生）", async () => {
    const ctx: TaskDispatchContext = {
      taskId: "parent-1",
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: "root-1" },
      dispatchWait: { "child-9": { at: "2026-08-17T00:00:00.000Z" } },
      childResult: { "child-8": { status: "completed", result: { value: 7 }, artifactRef: null } },
    };
    const delegate = vi.fn(async () => ({ taskId: "child-1", roleId: "coder", path: ["developer", "coder"] }));
    const awaitTask = vi.fn(async () => ({ status: "completed", result: { value: 7 }, artifactRef: null }));
    const port: TaskDispatchPort = { delegate, awaitTask };
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: port,
      taskContext: { current: ctx },
    });
    const tasks = caps["tasks"] as {
      delegate: (i: { to: string; title: string; text: string }) => Promise<unknown>;
      await: (i: { taskId: string }) => Promise<unknown>;
      resume: () => Promise<unknown>;
    };

    const delegated = await tasks.delegate({ to: "coder", title: "t", text: "x" });
    expect(delegated).toEqual({ taskId: "child-1", roleId: "coder", path: ["developer", "coder"] });
    expect(delegate).toHaveBeenCalledTimes(1);
    const [input, caller, scope] = delegate.mock.calls[0]!;
    expect(input).toEqual({ to: "coder", title: "t", text: "x" });
    expect(caller).toEqual(ctx);
    expect(scope).toEqual({ tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "task:parent-1" });

    const awaited = await tasks.await({ taskId: "child-1" });
    expect(awaited).toEqual({ status: "completed", result: { value: 7 }, artifactRef: null });
    expect(awaitTask).toHaveBeenCalledTimes(1);

    // W8 P2：resume 只读上下文快照（waiting/results）
    expect(await tasks.resume()).toEqual({
      waiting: { "child-9": { at: "2026-08-17T00:00:00.000Z" } },
      results: { "child-8": { status: "completed", result: { value: 7 }, artifactRef: null } },
    });
  });

  it("W8 P2：await 挂起错误码透传（runner 据此落 retryable requeue）", async () => {
    const suspend = Object.assign(new Error("等待子任务终态"), { code: "task-await-suspended", childTaskId: "c" });
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: { delegate: async () => ({ taskId: "x", roleId: "coder", path: ["x"] }), awaitTask: async () => { throw suspend; } },
      taskContext: { current: { taskId: "p", roleId: "developer", tenantId: "t", delivery: null } },
    });
    const tasks = caps["tasks"] as { await: (i: { taskId: string }) => Promise<unknown> };
    await expect(tasks.await({ taskId: "c" })).rejects.toMatchObject({
      code: "task-await-suspended",
      childTaskId: "c",
    });
  });

  it("PTC 契约校验：缺 to/title/text 直接结构化报错（不进端口）", async () => {
    const delegate = vi.fn(async () => ({ taskId: "x", roleId: "coder", path: ["x"] }));
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: { delegate, awaitTask: async () => ({ status: "pending" }) },
      taskContext: { current: { taskId: "p", roleId: "developer", tenantId: "t", delivery: null } },
    });
    const tasks = caps["tasks"] as { delegate: (i: unknown) => Promise<unknown> };
    expect(() => tasks.delegate({ title: "t", text: "x" })).toThrow(/\[tasks.delegate\].*to/);
    expect(() => tasks.delegate({ to: "coder", title: "", text: "x" })).toThrow(/\[tasks.delegate\].*title/);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("W8 P3：穿透 skill 在 memory-keeper 维护面注册校验（坏形状不进 write/propose）", async () => {
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      roleId: "memory-keeper",
    });
    const skills = caps["skills"] as {
      maintain: {
        write: (i: { name: string; content: string }) => Promise<unknown>;
        propose: (i: { action: "write"; name: string; content?: string }) => Promise<unknown>;
      };
    };
    await expect(skills.maintain.write({ name: "penetrate:coder", content: "bad" })).rejects.toThrow(/标题缺失或非法/);
    await expect(skills.maintain.propose({ action: "write", name: "penetrate:coder", content: "bad" })).rejects.toThrow(/标题缺失或非法/);
    await expect(skills.maintain.propose({ action: "write", name: "penetrate:coder" })).rejects.toThrow(/必须携带 content/);
  });
});

describe("0.16.3：tasks.penetrate 能力注入（显式原语——与 taskControl 同批装配）", () => {
  const stampedCtx: TaskDispatchContext = { taskId: "p", roleId: "developer", tenantId: "t", delivery: null };

  it("penetration 端口缺省 → 不注入 tasks.penetrate（嵌套子 kernel 形态——深度限 1）", () => {
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: { delegate: async () => ({ taskId: "x", roleId: "coder", path: ["x"] }), awaitTask: async () => ({ status: "pending" }) },
      taskContext: { current: stampedCtx },
    });
    const tasks = caps["tasks"] as Record<string, unknown>;
    expect(tasks).toBeDefined();
    expect(tasks["penetrate"]).toBeUndefined();
    expect(tasks["delegate"]).toBeDefined();
  });

  it("penetration 端口装配 → penetrate 以服务器身份转发（scope 由上下文派生）", async () => {
    const penetrate = vi.fn(async () => ({ ok: true as const, value: { code: "f()" }, steps: 3, childRole: "coder", durationMs: 50 }));
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: { delegate: async () => ({ taskId: "x", roleId: "coder", path: ["x"] }), awaitTask: async () => ({ status: "pending" }) },
      penetration: { penetrate },
      taskContext: { current: stampedCtx },
    });
    const tasks = caps["tasks"] as { penetrate: (i: unknown) => Promise<unknown> };
    const r = await tasks.penetrate({ to: "coder", title: "t", text: "x" });
    expect(r).toMatchObject({ ok: true, childRole: "coder", steps: 3 });
    expect(penetrate).toHaveBeenCalledWith(
      { to: "coder", title: "t", text: "x" },
      stampedCtx,
      expect.objectContaining({ tenantId: "t", principalId: "worker:developer", traceId: "task:p" }),
    );
  });

  it("任务上下文未盖章 → penetrate 结构化报错（不伪造调用者）", async () => {
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: { delegate: async () => ({ taskId: "x", roleId: "coder", path: ["x"] }), awaitTask: async () => ({ status: "pending" }) },
      penetration: { penetrate: async () => ({ ok: true as const, value: null, steps: 0, childRole: "coder", durationMs: 0 }) },
      taskContext: { current: null },
    });
    const tasks = caps["tasks"] as { penetrate: (i: unknown) => Promise<unknown> };
    await expect(tasks.penetrate({ to: "coder", title: "t", text: "x" })).rejects.toThrow(/任务上下文未就绪/);
  });

  it("PTC 契约校验：缺 to/title/text 直接结构化报错（不进端口）", async () => {
    const penetrate = vi.fn(async () => ({ ok: true as const, value: null, steps: 0, childRole: "coder", durationMs: 0 }));
    const caps = buildCapabilities({
      llm: async () => ({ text: "" }) as never,
      dataWorld: fakeDataWorld() as never,
      toolstore: fakeToolstore as never,
      taskControl: { delegate: async () => ({ taskId: "x", roleId: "coder", path: ["x"] }), awaitTask: async () => ({ status: "pending" }) },
      penetration: { penetrate },
      taskContext: { current: stampedCtx },
    });
    const tasks = caps["tasks"] as { penetrate: (i: unknown) => Promise<unknown> };
    expect(() => tasks.penetrate({ title: "t", text: "x" })).toThrow(/\[tasks.penetrate\].*to/);
    expect(() => tasks.penetrate({ to: "coder", title: "", text: "x" })).toThrow(/\[tasks.penetrate\].*title/);
    expect(() => tasks.penetrate({ to: "coder", title: "t", text: "" })).toThrow(/\[tasks.penetrate\].*text/);
    expect(penetrate).not.toHaveBeenCalled();
  });
});
