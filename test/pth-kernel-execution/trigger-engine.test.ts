import { describe, it, expect } from "vitest";
import { TriggerEngine } from "../../src/pth/kernel/execution/trigger-engine.js";
import { ActivityHub } from "../../src/pth/kernel/execution/activity-hub.js";

function mockMemory(defs: Array<{ id: string; def: object; status?: string }>) {
  const entries = defs.map((d) => ({
    id: d.id, kind: "trigger", anchors: [], content: JSON.stringify(d.def),
    status: (d.status ?? "official") as "official", meta: {},
  }));
  const written: unknown[] = [];
  return {
    written,
    retrieve: async (opts: { kinds?: string[]; status?: string[] }) => {
      let out = entries;
      if (opts.status) out = out.filter((e) => opts.status!.includes(e.status));
      return out;
    },
    write: async (e: { id: string; content: string; status: string }) => {
      written.push(e);
      const i = entries.findIndex((x) => x.id === e.id);
      if (i >= 0) entries[i] = { ...entries[i], content: e.content, status: e.status as "official" };
      return { id: e.id };
    },
  };
}

function mockTasks() {
  const published: Array<{ title: string; text: string; createdBy: string; payload?: unknown }> = [];
  return {
    published,
    publish: async (input: { title: string; text: string; createdBy: string; payload?: unknown }) => {
      published.push(input);
      return { id: `task-${published.length}` };
    },
  };
}

const TICK = () => new Promise((r) => setTimeout(r, 20));

describe("TriggerEngine（事件触发任务——trigger 组件落地）", () => {
  it("task.done 事件匹配 trigger → 自动发布下游任务（模板变量渲染）", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "trig-1", def: { name: "链式验收", event: "task.done", task: { title: "验收 {{taskId}}", text: "验收 {{role}} 的产物", role: "acceptor" } } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "abc123", role: "developer", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(1);
    expect(tasks.published[0].title).toBe("验收 abc123");
    expect(tasks.published[0].text).toBe("验收 developer 的产物");
    expect(tasks.published[0].createdBy).toBe("trigger:链式验收");
    expect((tasks.published[0].payload as { flow?: { stages?: Array<{ task?: { role?: string } }> } }).flow?.stages?.[0]?.task?.role).toBe("acceptor");
    engine.stop();
  });

  it("match.role 过滤——不匹配不触发", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "trig-2", def: { name: "仅 developer", event: "task.done", match: { role: "developer" }, task: { title: "t", text: "x" } } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "a", role: "scout", at: Date.now() });   // 不匹配
    await TICK();
    expect(tasks.published).toHaveLength(0);
    hub.publish({ kind: "task.done", taskId: "b", role: "developer", at: Date.now() });  // 匹配
    await TICK();
    expect(tasks.published).toHaveLength(1);
    engine.stop();
  });

  it("disabled trigger 不加载；maxFires 达上限不再触发", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([
      { id: "trig-off", def: { name: "禁用", event: "task.done", enabled: false, task: { title: "t", text: "x" } } },
      { id: "trig-max", def: { name: "限次", event: "task.done", maxFires: 1, task: { title: "t", text: "x" } } },
    ]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "a", at: Date.now() });
    hub.publish({ kind: "task.done", taskId: "b", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(1);   // 仅 trig-max 第一次（disabled 不触发 + maxFires=1 阻断第二次）
    engine.stop();
  });

  it("once 触发后自动禁用（memory 更新 + 内存移除）", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "trig-once", def: { name: "一次性", event: "task.done", once: true, task: { title: "t", text: "x" } } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "a", at: Date.now() });
    hub.publish({ kind: "task.done", taskId: "b", at: Date.now() });
    await TICK();
    await TICK();
    expect(tasks.published).toHaveLength(1);
    expect(memory.written.length).toBeGreaterThan(0);   // enabled=false 写回
    engine.stop();
  });

  it("链深 >5 不再触发（防链式爆炸）", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "trig-chain", def: { name: "链", event: "task.done", task: { title: "t", text: "x" } } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "deep", at: Date.now(), chainDepth: 6 });
    await TICK();
    expect(tasks.published).toHaveLength(0);
    engine.stop();
  });

  it("自触发阻断（trigger 发的任务事件带 triggerId——同一 trigger 不再连锁）", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "trig-self", def: { name: "自链", event: "task.done", task: { title: "t", text: "x" } } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "x", at: Date.now(), chainDepth: 1, triggerId: "trig-self" });
    await TICK();
    expect(tasks.published).toHaveLength(0);   // 自己触发的事件不再触发自己
    engine.stop();
  });
});
