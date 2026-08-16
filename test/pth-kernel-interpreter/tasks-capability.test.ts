import { describe, expect, it, vi } from "vitest";
import {
  buildCapabilities,
  type TaskDispatchPort,
} from "../../src/pth/impls/kernels/capability.js";
import { PtcContractError } from "../../src/pth/kernel/ptc/contract.js";
import type { TaskDispatchContext } from "../../src/pth/contracts/index.js";

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
});
