import { describe, it, expect, vi } from "vitest";
import { TaskResolver } from "@away_from/pth-kernel-execution";

function mockTaskStore() {
  return {
    candidates: vi.fn(async () => []),
    claimTopN: vi.fn(async () => []),
    reject: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    publish: vi.fn(async (input: any) => ({ id: "new-" + Math.random().toString(36).slice(2, 8), ...input, status: "pending" })),
    countPending: vi.fn(async () => 0),
  };
}

function makeTask(overrides: any = {}) {
  return {
    id: "t1",
    title: "test",
    text: "code",
    tags: [],
    status: "pending",
    claimed_by: null,
    claims_count: 0,
    created_at: new Date(),
    payload: {},
    ...overrides,
  };
}

describe("TaskResolver", () => {
  it("无 flow 任务 → 不处理", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    await resolver.resolveOnce(makeTask());
    expect(store.publish).not.toHaveBeenCalled();
  });

  it("transform 算子：改 role/kind 并注销阶段", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      status: "pending",
      payload: {
        flow: { stages: [{ id: "s1", match: { status: "pending" }, transform: { role: "developer", kind: "dev" } }] },
        resolvedStages: [],
      },
    });
    await resolver.resolveOnce(task);
    // transform 更新 payload（resolvedStages + role/kind）
    expect(task.payload.resolvedStages).toContain("s1");
    expect(task.payload.role).toBe("developer");
    expect(task.payload.kind).toBe("dev");
  });

  it("decompose 算子：生成下游任务（带 deps + 子任务自己的 flow）", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      status: "completed",
      payload: {
        flow: {
          stages: [{
            id: "s1",
            match: { status: "completed" },
            decompose: [{ role: "acceptor", title: "验收: {upstream.title}", text: "验收任务", tags: ["verify"] }],
          }],
        },
        resolvedStages: [],
      },
    });
    await resolver.resolveOnce(task);
    expect(store.publish).toHaveBeenCalled();
    const pub = store.publish.mock.calls[0][0];
    expect(pub.title).toContain("验收: test");   // 插值 {upstream.title}
    expect(pub.payload.deps).toContain("t1");    // 依赖上游
    expect(pub.tags).toContain("verify");
  });

  it("全部阶段注销后不再生成（幂等）", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      payload: {
        flow: { stages: [{ id: "s1", transform: { role: "x" } }] },
        resolvedStages: ["s1"],
      },
    });
    await resolver.resolveOnce(task);
    expect(store.publish).not.toHaveBeenCalled();
  });

  it("match 不满足且非 loop → 跳过注销（wait:false 缺省）", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      status: "pending",
      payload: {
        flow: { stages: [{ id: "s1", match: { status: "completed" }, transform: { role: "x" } }] },
        resolvedStages: [],
      },
    });
    await resolver.resolveOnce(task);
    // 跳过：注销但不 transform
    expect(task.payload.resolvedStages).toContain("s1");
    expect(task.payload.role).toBeUndefined();
  });

  it("wait:true 且 match 不满足 → 不注销（等待）", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      status: "pending",
      payload: {
        flow: { stages: [{ id: "s1", match: { status: "completed" }, transform: { role: "x" }, wait: true }] },
        resolvedStages: [],
      },
    });
    await resolver.resolveOnce(task);
    expect(task.payload.resolvedStages).not.toContain("s1");
  });

  it("loop 算子：until 不满足 → 不注销 + loopCount+1；满足 → 注销", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    // until 不满足（output.ok false）→ 继续循环
    const t1 = makeTask({
      payload: {
        flow: { stages: [{ id: "loop1", loop: { until: "output.ok == true", max: 3 }, transform: { role: "retry" } }] },
        resolvedStages: [],
        output: { ok: false },
        loopCount: 0,
      },
    });
    await resolver.resolveOnce(t1);
    expect(t1.payload.resolvedStages).not.toContain("loop1");
    expect(t1.payload.loopCount).toBe(1);
    // until 满足 → 注销
    const t2 = makeTask({
      payload: {
        flow: { stages: [{ id: "loop1", loop: { until: "output.ok == true", max: 3 }, transform: { role: "retry" } }] },
        resolvedStages: [],
        output: { ok: true },
        loopCount: 0,
      },
    });
    await resolver.resolveOnce(t2);
    expect(t2.payload.resolvedStages).toContain("loop1");
  });

  it("loop max 超限 → 注销并标记", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      payload: {
        flow: { stages: [{ id: "loop1", loop: { until: "output.ok == true", max: 3 } }] },
        resolvedStages: [],
        output: { ok: false },
        loopCount: 3,   // 已达 max
      },
    });
    await resolver.resolveOnce(task);
    expect(task.payload.resolvedStages).toContain("loop1");
    expect(task.payload.loopExceeded).toBe("loop1");
  });

  it("branch 算子：if 命中执行该分支；else 兜底", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      status: "completed",
      payload: {
        flow: {
          stages: [{
            id: "s1",
            match: { status: "completed" },
            branch: [
              { if: "output.ok == true", decompose: [{ role: "acceptor", title: "验收", text: "t" }] },
              { transform: { status: "rejected", reason: "output.failed" } },
            ],
          }],
        },
        resolvedStages: [],
        output: { ok: true },
      },
    });
    await resolver.resolveOnce(task);
    expect(store.publish).toHaveBeenCalled();   // if 分支 → decompose
    // else 分支（output.ok false）→ transform rejected
    const store2 = mockTaskStore();
    const r2 = new TaskResolver({ taskStore: store2 as any });
    const t2 = makeTask({
      status: "completed",
      payload: {
        flow: {
          stages: [{
            id: "s1",
            match: { status: "completed" },
            branch: [
              { if: "output.ok == true", decompose: [{ role: "acceptor", title: "验收", text: "t" }] },
              { transform: { status: "rejected", reason: "output.failed" } },
            ],
          }],
        },
        resolvedStages: [],
        output: { ok: false },
      },
    });
    await r2.resolveOnce(t2);
    expect(store2.publish).not.toHaveBeenCalled();
    expect(t2.payload.status).toBe("rejected");
  });

  it("terminal 阶段执行后不再递归", async () => {
    const store = mockTaskStore();
    const resolver = new TaskResolver({ taskStore: store as any });
    const task = makeTask({
      payload: {
        flow: { stages: [{ id: "s1", transform: { kind: "done" }, terminal: true }, { id: "s2", transform: { kind: "never" } }] },
        resolvedStages: [],
      },
    });
    await resolver.resolveOnce(task);
    expect(task.payload.resolvedStages).toContain("s1");
    expect(task.payload.resolvedStages).not.toContain("s2");
  });
});
