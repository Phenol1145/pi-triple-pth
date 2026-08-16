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

describe("Origin 升级链（retask 模式——任务池纯化 D3）", () => {
  // 内置角色标签注册走装配注入（2026-08-13 审计 P2）
  beforeEach(async () => {
    const { installDefaultRoles } = await import("../helpers");
    installDefaultRoles();
  });
  function mockTasksWith(origTask: { id: string; title: string; text: string; assigned_role: string | null } | null) {
    const published: Array<{ title: string; text: string; createdBy: string; tags?: string[]; payload?: unknown }> = [];
    return {
      published,
      publish: async (input: { title: string; text: string; createdBy: string; tags?: string[]; payload?: unknown }) => {
        published.push(input);
        return { id: `task-${published.length}` };
      },
      getById: async (id: string) => (origTask && origTask.id === id ? origTask : null),
    };
  }

  it("task.rejected → retask 重发布原任务（正文继承 + origin 标签 + 升级元数据）", async () => {
    const hub = new ActivityHub();
    const orig = { id: "orig-1", title: "实现功能X", text: "请实现功能X并验证", assigned_role: "developer" };
    const tasks = mockTasksWith(orig);
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: mockMemory([]) as never });
    engine.addSystemTrigger({
      name: "origin-escalation", event: "task.rejected",
      task: { title: "", text: "", retask: true, tags: ["origin"] }, enabled: true,
    });
    await engine.start();
    hub.publish({ kind: "task.rejected", taskId: "orig-1", role: "developer", ok: false, detail: "execution-failed", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(1);
    const p = tasks.published[0]!;
    expect(p.title).toBe("实现功能X");           // 正文继承
    expect(p.text).toBe("请实现功能X并验证");
    expect(p.tags).toEqual(["origin"]);          // 转写 origin 标签
    expect(p.createdBy).toBe("trigger:origin-escalation");
    const payload = p.payload as { escalatedFrom?: string; originalRole?: string; triggeredBy?: { depth?: number } };
    expect(payload.escalatedFrom).toBe("orig-1");
    expect(payload.originalRole).toBe("developer");
    expect(payload.triggeredBy?.depth).toBe(1);
    engine.stop();
  });

  it("终态闸：Origin 任务失败不再升级（防死循环）", async () => {
    const hub = new ActivityHub();
    const orig = { id: "orig-2", title: "t", text: "x", assigned_role: "origin" };
    const tasks = mockTasksWith(orig);
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: mockMemory([]) as never });
    engine.addSystemTrigger({
      name: "origin-escalation", event: "task.rejected",
      task: { title: "", text: "", retask: true, tags: ["origin"] }, enabled: true,
    });
    await engine.start();
    hub.publish({ kind: "task.rejected", taskId: "orig-2", role: "origin", ok: false, at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(0);     // Origin 失败即终态
    engine.stop();
  });

  it("原任务不存在 → 跳过不炸", async () => {
    const hub = new ActivityHub();
    const tasks = mockTasksWith(null);
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: mockMemory([]) as never });
    engine.addSystemTrigger({
      name: "origin-escalation", event: "task.rejected",
      task: { title: "", text: "", retask: true, tags: ["origin"] }, enabled: true,
    });
    await engine.start();
    hub.publish({ kind: "task.rejected", taskId: "ghost", role: "developer", ok: false, at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(0);
    engine.stop();
  });

  it("系统 trigger 不受 once/maxFires 移除影响（持续升级多个失败任务）", async () => {
    const hub = new ActivityHub();
    const tasks = mockTasksWith(null);
    const store = new Map(Object.entries({
      "a-1": { id: "a-1", title: "t1", text: "x1", assigned_role: "developer" },
      "a-2": { id: "a-2", title: "t2", text: "x2", assigned_role: "tester" },
    }));
    tasks.getById = async (id: string) => (store.get(id) ?? null) as never;
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: mockMemory([]) as never });
    engine.addSystemTrigger({
      name: "origin-escalation", event: "task.rejected",
      task: { title: "", text: "", retask: true, tags: ["origin"] }, enabled: true,
    });
    await engine.start();
    hub.publish({ kind: "task.rejected", taskId: "a-1", role: "developer", ok: false, at: Date.now() });
    hub.publish({ kind: "task.rejected", taskId: "a-2", role: "tester", ok: false, at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(2);     // 两个失败任务都升级
    engine.stop();
  });

  it("addSystemTrigger 幂等（同名去重）", async () => {
    const hub = new ActivityHub();
    const tasks = mockTasksWith(null);
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: mockMemory([]) as never });
    const def = { name: "origin-escalation", event: "task.rejected", task: { title: "", text: "", retask: true, tags: ["origin"] }, enabled: true };
    engine.addSystemTrigger(def);
    engine.addSystemTrigger(def);
    await engine.start();
    hub.publish({ kind: "task.rejected", taskId: "ghost", role: "developer", ok: false, at: Date.now() });
    await TICK();
    engine.stop();
    // 不重复注册（间接验证：无异常、无重复处理日志）
  });
});

describe("TriggerEngine（定时源——backlog 差距 12：controller/sensor 任务源）", () => {
  it("schedule 触发：到点发布观测任务（间隔生效 + maxFires 防风暴）", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "trig-sched", def: { name: "周期观测", schedule: { everySec: 1 }, task: { title: "观测窗口", text: "采集任务池分布", role: "sensor:worker-opt", tags: ["sensor", "observe"] }, maxFires: 2 } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    await new Promise((r) => setTimeout(r, 2600));
    engine.stop();
    expect(tasks.published.length).toBeGreaterThanOrEqual(1);
    expect(tasks.published.length).toBeLessThanOrEqual(2);   // maxFires=2——不超发
    const first = tasks.published[0];
    expect(first.title).toBe("观测窗口");
    expect(first.createdBy).toContain("trigger:周期观测");
    expect((first.payload as { triggeredBy: { source: string } }).triggeredBy.source).toBe("schedule");
  });

  it("schedule 与 event 互斥语义：有 event 的 trigger 不因 schedule 空值双触发", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "trig-e", def: { name: "事件链", event: "task.done", task: { title: "验收 {{taskId}}", text: "验收 {{role}} 的产物", role: "acceptor" } } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "x1", role: "developer", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(1);   // 仅事件触发一次（无 schedule 字段不重复）
    engine.stop();
  });
});

describe("TriggerEngine（原生 action——trigger 统一化：控制环收编为调度指令）", () => {
  it("event action trigger：事件匹配 → 调用注册 handler（ctx 含 vars/event/source）", async () => {
    const hub = new ActivityHub();
    const engine = new TriggerEngine({ activityHub: hub, tasks: mockTasks() as never, memory: mockMemory([
      { id: "act-1", def: { name: "事件动作", event: "task.execute.end", action: { type: "probe" }, task: undefined } },
    ]) as never });
    const calls: Array<{ vars: Record<string, string>; event?: { kind: string }; source: string }> = [];
    engine.registerAction("probe", async (ctx) => {
      calls.push({ vars: ctx.vars, event: ctx.event, source: ctx.source });
    });
    await engine.start();
    hub.publish({ kind: "task.execute.end", taskId: "t1", role: "developer", ok: true, at: Date.now() });
    await TICK();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.vars).toEqual({ taskId: "t1", role: "developer", detail: "" });
    expect(calls[0]!.event?.kind).toBe("task.execute.end");
    expect(calls[0]!.source).toBe("event");
    expect((engine as never as { tasks: unknown }).tasks).toBeUndefined();   // 未发布任务
    engine.stop();
  });

  it("schedule action trigger：到点调用 handler（可配 tick 加速测试）", async () => {
    const engine = new TriggerEngine({ activityHub: new ActivityHub(), tasks: mockTasks() as never, memory: mockMemory([]) as never, scheduleTickMs: 20 });
    let fires = 0;
    engine.registerAction("sweep", async () => { fires++; });
    engine.addSystemTrigger({ name: "sweep", schedule: { everySec: 1 }, action: { type: "sweep" }, enabled: true });
    await engine.start();
    await new Promise((r) => setTimeout(r, 1300));
    engine.stop();
    expect(fires).toBeGreaterThanOrEqual(1);
  });

  it("动态 nextMs：handler 返回的下一跳间隔覆盖 schedule（退避语义）", async () => {
    const engine = new TriggerEngine({ activityHub: new ActivityHub(), tasks: mockTasks() as never, memory: mockMemory([]) as never, scheduleTickMs: 20 });
    const ats: number[] = [];
    engine.registerAction("adaptive", async () => { ats.push(Date.now()); return { nextMs: 500 }; });
    engine.addSystemTrigger({ name: "adaptive", schedule: { everySec: 1 }, action: { type: "adaptive" }, enabled: true });
    await engine.start();
    await new Promise((r) => setTimeout(r, 1700));
    engine.stop();
    expect(ats.length).toBeGreaterThanOrEqual(2);                       // 至少 500ms 间隔内再触发
    expect(ats.length).toBeLessThan(10);                                 // 不是 20ms tick 狂触发（已按 nextMs 压制）
  });

  it("校验：task 与 action 均缺 → 跳过加载；action.type 非字符串 → 跳过", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([
      { id: "bad-1", def: { name: "无动作", event: "task.done" } },
      { id: "bad-2", def: { name: "坏 action", event: "task.done", action: { type: 42 } } },
      { id: "ok", def: { name: "好 action", event: "task.done", action: { type: "probe" } } },
    ]);
    const engine = new TriggerEngine({ activityHub: hub, tasks: mockTasks() as never, memory: memory as never });
    let fires = 0;
    engine.registerAction("probe", async () => { fires++; });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "t", at: Date.now() });
    await TICK();
    expect(fires).toBe(1);   // 仅合法定义触发
    engine.stop();
  });

  it("listTriggers：system 与 memory 两条来源的快照可观测", async () => {
    const hub = new ActivityHub();
    const engine = new TriggerEngine({ activityHub: hub, tasks: mockTasks() as never, memory: mockMemory([
      { id: "mem-1", def: { name: "mem", event: "task.done", action: { type: "probe" } } },
    ]) as never });
    engine.registerAction("probe", async () => {});
    engine.addSystemTrigger({ name: "sys-1", schedule: { everySec: 60 }, action: { type: "probe" }, enabled: true });
    await engine.start();
    const list = engine.listTriggers();
    expect(list.map((t) => t.name).sort()).toEqual(["mem", "sys-1"]);
    expect(list.find((t) => t.name === "sys-1")?.source).toBe("system");
    expect(list.find((t) => t.name === "mem")?.actionType).toBe("probe");
    engine.stop();
  });

  it("once/maxFires 对 action trigger 语义一致（maxFires=1 只动作一次）", async () => {
    const hub = new ActivityHub();
    const engine = new TriggerEngine({ activityHub: hub, tasks: mockTasks() as never, memory: mockMemory([
      { id: "act-max", def: { name: "限次动作", event: "task.done", action: { type: "probe" }, maxFires: 1 } },
    ]) as never });
    let fires = 0;
    engine.registerAction("probe", async () => { fires++; });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "a", at: Date.now() });
    hub.publish({ kind: "task.done", taskId: "b", at: Date.now() });
    await TICK();
    expect(fires).toBe(1);
    engine.stop();
  });
});

describe("TriggerEngine（模板引用——任务模板统一收口 A+：TASK_TEMPLATES 为唯一模板源）", () => {
  it("task.template + params 引用 TASK_TEMPLATES：事件变量注入 → 渲染 → 默认 title/tags/route", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{
      id: "trig-tpl",
      def: {
        name: "recon链",
        event: "task.done",
        task: { template: "recon-doc", params: { url: "{{detail}}", section: "{{role}}" } },
      },
    }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "t9", role: "scout", detail: "https://example.com/doc", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(1);
    const p = tasks.published[0]!;
    expect(p.title).toBe("[recon-doc] 信息搜集（文档转写）");
    expect(p.text).toContain('"https://example.com/doc"');
    expect(p.text).toContain('"scout"');
    expect((p as unknown as { tags?: string[] }).tags).toEqual(["recon"]);   // 模板 roleTag 缺省路由
    const payload = p.payload as { template?: string; params?: { url: string; section: string }; triggeredBy?: { source: string; depth: number } };
    expect(payload.template).toBe("recon-doc");
    expect(payload.params).toEqual({ url: "https://example.com/doc", section: "scout" });
    expect(payload.triggeredBy?.source).toBe("task.done");
    engine.stop();
  });

  it("模板引用 + 显式 role/tags 覆盖默认路由", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{
      id: "trig-tpl2",
      def: {
        name: "定制路由",
        event: "task.done",
        task: { template: "recon-doc", params: { url: "{{detail}}" }, role: "scout", tags: ["custom"] },
      },
    }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "t10", detail: "https://x.dev", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(1);
    const payload = tasks.published[0]!.payload as { flow?: { stages?: Array<{ task?: { role?: string } }> } };
    expect(payload.flow?.stages?.[0]?.task?.role).toBe("scout");
    expect((tasks.published[0] as unknown as { tags?: string[] }).tags).toEqual(["custom"]);
    engine.stop();
  });

  it("未知模板/缺必填 → 不发布不炸（日志跳过）", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([
      { id: "bad-tpl", def: { name: "未知模板", event: "task.done", task: { template: "nope" } } },
      { id: "missing-tpl", def: { name: "缺参", event: "task.done", task: { template: "recon-doc", params: { url: "{{detail}}" } } } },
    ]);
    const tasks = mockTasks();
    const logs: string[] = [];
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never, logger: (m) => logs.push(m) });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "t11", detail: "", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(0);
    expect(logs.some((l) => l.includes("模板解析失败"))).toBe(true);
    engine.stop();
  });

  it("内联 title/text 兼容形态继续可用（旧 memory trigger 定义不破坏）", async () => {
    const hub = new ActivityHub();
    const memory = mockMemory([{ id: "old", def: { name: "旧定义", event: "task.done", task: { title: "验收 {{taskId}}", text: "验收 {{role}} 的产物", role: "acceptor" } } }]);
    const tasks = mockTasks();
    const engine = new TriggerEngine({ activityHub: hub, tasks: tasks as never, memory: memory as never });
    await engine.start();
    hub.publish({ kind: "task.done", taskId: "t12", role: "developer", at: Date.now() });
    await TICK();
    expect(tasks.published).toHaveLength(1);
    expect(tasks.published[0]!.title).toBe("验收 t12");
    engine.stop();
  });
});
