import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkToolFaceBudget,
  loadToolRegSnapshot,
  registryToolToSchema,
  visibleRegistryTools,
  type ToolRegStoreLike,
} from "../../src/pth/kernel/execution/tool-registry.js";
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import { buildToolRegContent, type ToolRegSpec } from "@away_from/pth-memory";
import { resetConfig } from "../../src/pth/kernel/extensions/perf-params.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";
import type { WorkerKernel } from "../../src/pth/kernel/interpreter/index.js";

/** 构造合法注册条目 spec（缺省 program 态） */
function spec(name: string, roles: string[], overrides: Partial<ToolRegSpec> = {}): ToolRegSpec {
  return {
    name,
    version: 1,
    description: { anchor: `${name} 锚点`, whenToUse: `${name} 何时用`, effect: `${name} 效果` },
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    executor: { type: "program", source: "return String(args.text).toUpperCase();" },
    visibility: { roles, pack: "util" },
    ...overrides,
  };
}

function mockStore(rows: Array<{ id: string; kind: string; status: string; content: string }>): ToolRegStoreLike & { rows: typeof rows } {
  return {
    rows,
    listIds: async () => rows.map((r) => r.id),
    get: async (id: string) => rows.find((r) => r.id === id),
  };
}

function regRow(s: ToolRegSpec, status = "official") {
  return { id: `tool:${s.name}`, kind: "tool-reg", status, content: buildToolRegContent(s) };
}

describe("N14 P2：注册表运行时（快照/可见性/预算）", () => {
  it("快照装载：official+校验通过才进面；draft/非法/非 tool-reg 排除", async () => {
    const store = mockStore([
      regRow(spec("util_a", ["developer"])),
      regRow(spec("util_b", ["developer"]), "draft"),   // draft 不可见（§7-4）
      { id: "tool:broken", kind: "tool-reg", status: "official", content: "# 无 spec 行" },
      { id: "skill:x", kind: "skill", status: "official", content: "irrelevant" },
      regRow(spec("util_c", ["coder"])),
    ]);
    const snap = await loadToolRegSnapshot(store);
    expect([...snap.entries.keys()].sort()).toEqual(["util_a", "util_c"]);
    expect(snap.version).toMatch(/^tr-2-[0-9a-f]{8}$/);
  });

  it("快照版本化：内容变化 → 版本变化；同内容 → 同版本（T3 防线的可观测面）", async () => {
    const s1 = spec("util_a", ["developer"]);
    const snap1 = await loadToolRegSnapshot(mockStore([regRow(s1)]));
    const snap2 = await loadToolRegSnapshot(mockStore([regRow(s1)]));
    expect(snap2.version).toBe(snap1.version);
    const snap3 = await loadToolRegSnapshot(mockStore([regRow(s1), regRow(spec("util_b", ["developer"]))]));
    expect(snap3.version).not.toBe(snap1.version);
    const snap4 = await loadToolRegSnapshot(mockStore([regRow({ ...s1, version: 2 })]));
    expect(snap4.version).not.toBe(snap1.version);   // 版本链留痕进指纹
  });

  it("可见性窄投放（命题 3）：只给声明角色", async () => {
    const store = mockStore([regRow(spec("util_a", ["developer"])), regRow(spec("util_b", ["coder", "developer"]))]);
    const snap = await loadToolRegSnapshot(store);
    expect(visibleRegistryTools(snap, "developer").map((s) => s.name)).toEqual(["util_a", "util_b"]);
    expect(visibleRegistryTools(snap, "coder").map((s) => s.name)).toEqual(["util_b"]);
    expect(visibleRegistryTools(snap, "scout")).toEqual([]);
  });

  it("预算守卫：静态面占额后注册面补足到预算，溢出确定性裁减", () => {
    const specs = [spec("b_tool", ["developer"]), spec("a_tool", ["developer"]), spec("c_tool", ["developer"])];
    // 静态面 22 + 预算 24 → 注册面只进 2（名称序 a,b 进，c 裁）
    const r = checkToolFaceBudget(22, [...specs].sort((a, b) => a.name.localeCompare(b.name)), 24);
    expect(r.allowed.map((s) => s.name)).toEqual(["a_tool", "b_tool"]);
    expect(r.dropped).toEqual(["c_tool"]);
    // 静态面已超预算 → 注册面全裁（静态面不动——P2 自决②）
    const r2 = checkToolFaceBudget(26, specs, 24);
    expect(r2.allowed).toEqual([]);
    expect(r2.dropped).toHaveLength(3);
  });

  it("registryToolToSchema：name 去点、描述三要素格式与静态面一致", () => {
    const s = registryToolToSchema(spec("util.parse", ["developer"]));
    expect(s.name).toBe("util_parse");
    expect(s.description).toBe("【场景锚点：util.parse 锚点】何时用：util.parse 何时用。效果：util.parse 效果。");
    expect(s.parameters.required).toEqual(["text"]);
  });
});

// ── agent-loop 执行缝 ─────────────────────────────────────────────

function mockKernel() {
  return {
    ts: {
      execute: vi.fn(async (code: string) => ({ ok: true, value: code.includes("toUpperCase") ? "UPPER" : { fromTs: true }, durationMs: 1, language: "ts" })),
      reset: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
      registerResult: vi.fn(),
      injectCapability: vi.fn(),
      state: { results: {}, context: {}, memory: {}, llm: {}, web: {}, fs: {}, env: {}, state: {}, python: {}, bash: {} },
    } as never,
    python: { execute: vi.fn(), reset: vi.fn(), dispose: vi.fn(), snapshot: vi.fn(async () => ({})) } as never,
    bash: { execute: vi.fn(async (cmd: string) => ({ ok: true, stdout: `bash:${cmd}`, durationMs: 1, language: "bash" })), reset: vi.fn(), dispose: vi.fn(), snapshot: vi.fn(async () => ({})) } as never,
    llm: null,
    dataWorld: null,
    reset: vi.fn(),
    dispose: vi.fn(),
    snapshot: vi.fn(async () => ({})),
  } as unknown as WorkerKernel;
}

function mockLlm(steps: Array<{ toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string }>) {
  const seenTools: string[][] = [];
  let i = 0;
  const llm = {
    complete: vi.fn(async (_msgs: unknown, opts?: { tools?: Array<{ name: string }> }) => {
      seenTools.push((opts?.tools ?? []).map((t) => t.name));
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return {
        content: step.content ?? "",
        model: "mock",
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(step.toolCalls ? { toolCalls: step.toolCalls.map((tc, idx) => ({ id: `call_${i}_${idx}`, name: tc.name, arguments: tc.arguments })) } : {}),
      };
    }),
  } as unknown as LlmFn;
  return { llm, seenTools };
}

const CAPS = { web: {}, state: {}, fs: {}, memory: {} } as Record<string, unknown>;

describe("N14 P2：agent-loop 注册工具执行缝", () => {
  afterEach(() => resetConfig({}));

  it("program 态：注册工具进工具面 + 调用分发 ts 核（args 注入）+ 结果回填", async () => {
    const store = mockStore([regRow(spec("util.shout", ["developer"]))]);
    const snap = await loadToolRegSnapshot(store);
    const kernel = mockKernel();
    const { llm, seenTools } = mockLlm([
      { toolCalls: [{ name: "util_shout", arguments: { text: "hello" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS,
      task: { title: "t", text: "调用注册工具" },
      role: { id: "developer", labelPatterns: [], prompt: "你是开发者", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 5,
      toolRegistry: snap,
    });
    expect(r.ok).toBe(true);
    // 工具面含注册工具（下划线形——OpenAI 格式）
    expect(seenTools[0]).toContain("util_shout");
    // program 分发：ts 核执行了「args 注入 + 源程序」
    const tsExec = (kernel.ts as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    const code = tsExec.mock.calls.map((c) => String(c[0])).find((c) => c.includes("toUpperCase"));
    expect(code).toBeDefined();
    expect(code).toContain('const args = {"text":"hello"};');
  });

  it("快照冻结（验收要点 2）：任务中途新注册不影响本任务工具面", async () => {
    const s = spec("util.shout", ["developer"]);
    const store = mockStore([regRow(s)]);
    const snap = await loadToolRegSnapshot(store);   // 任务开始冻结
    store.rows.push(regRow(spec("util.late", ["developer"])));   // 任务中途注册
    const kernel = mockKernel();
    const { llm, seenTools } = mockLlm([
      { toolCalls: [{ name: "done", arguments: { result: 1 } }] },
      { toolCalls: [{ name: "done", arguments: { result: 2 } }] },
    ]);
    await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "p", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 2, toolRegistry: snap,
    });
    // 两轮工具面一致且不含 util_late（快照版本边界——下任务才生效）
    expect(seenTools.length).toBeGreaterThanOrEqual(1);
    for (const face of seenTools) {
      expect(face).toContain("util_shout");
      expect(face).not.toContain("util_late");
    }
    // 新快照才含 util_late（下一任务的语义）
    const snap2 = await loadToolRegSnapshot(store);
    expect(snap2.entries.has("util.late")).toBe(true);
    expect(snap2.version).not.toBe(snap.version);
  });

  it("预算守卫（验收要点 3）：静态面占满预算 → 注册工具裁减 + 日志提示合并/退役", async () => {
    resetConfig({ PTH_TOOL_FACE_BUDGET: "2" });
    const store = mockStore([regRow(spec("util.shout", ["developer"]))]);
    const snap = await loadToolRegSnapshot(store);
    const kernel = mockKernel();
    const { llm, seenTools } = mockLlm([{ toolCalls: [{ name: "done", arguments: { result: 1 } }] }]);
    const logs: string[] = [];
    await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" },
      // 非 ASP 静态面 = execTs 2 件（nav/cache 为 ASP-only）= 预算 2 → 注册面全裁
      role: { id: "developer", labelPatterns: [], prompt: "p", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 2, toolRegistry: snap, logger: (m) => logs.push(m),
    });
    expect(seenTools[0]).not.toContain("util_shout");
    expect(logs.join("\n")).toContain("预算守卫");
    expect(logs.join("\n")).toContain("util.shout");
  });

  it("可见性投放：角色不在 visibility.roles → 工具不进面", async () => {
    const store = mockStore([regRow(spec("util.shout", ["coder"]))]);   // 只给 coder
    const snap = await loadToolRegSnapshot(store);
    const kernel = mockKernel();
    const { llm, seenTools } = mockLlm([{ toolCalls: [{ name: "done", arguments: { result: 1 } }] }]);
    await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "p", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 2, toolRegistry: snap,
    });
    expect(seenTools[0]).not.toContain("util_shout");
  });

  it("agent 态：走 runChild 执行缝（契约/audit id 透传）+ 结果回填", async () => {
    const agentSpec = spec("reviewer.check", ["developer"], {
      executor: { type: "agent", role: "acceptor", input: "代码片段", output: "{issues: string[]}" },
    });
    const snap = await loadToolRegSnapshot(mockStore([regRow(agentSpec)]));
    const kernel = mockKernel();
    const { llm } = mockLlm([
      { toolCalls: [{ name: "reviewer_check", arguments: { text: "const x=1" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { done: 1 } } }] },
    ]);
    const runChild = vi.fn(async () => ({ ok: true, value: { issues: [] }, summary: "审毕", steps: 3, durationMs: 5 }));
    const r = await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "p", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 5, toolRegistry: snap,
      toolRegExec: { runChild, caller: { taskId: "task-1", roleId: "developer", tenantId: "default", delivery: null } },
    });
    expect(r.ok).toBe(true);
    expect(runChild).toHaveBeenCalledOnce();
    const req = runChild.mock.calls[0]![0];
    expect(req.childRoleId).toBe("acceptor");
    expect(req.skillId).toBe("tool:reviewer.check");
    expect(req.inputContract).toBe("代码片段");
    expect(req.caller.taskId).toBe("task-1");
    expect(req.text).toContain("const x=1");
  });

  it("agent 态执行缝未装配 → 回填明确提示（不打崩任务）", async () => {
    const agentSpec = spec("reviewer.check", ["developer"], { executor: { type: "agent", role: "acceptor" } });
    const snap = await loadToolRegSnapshot(mockStore([regRow(agentSpec)]));
    const kernel = mockKernel();
    const { llm } = mockLlm([
      { toolCalls: [{ name: "reviewer_check", arguments: { text: "x" } }] },
      { toolCalls: [{ name: "done", arguments: { result: 1 } }] },
    ]);
    const traces: string[] = [];
    const r = await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "p", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 5, toolRegistry: snap,   // 无 toolRegExec
      onTrace: (e) => { if (e.type === "tool-result") traces.push(e.resultPreview); },
    });
    expect(r.ok).toBe(true);   // 任务继续（错误回填后 done）
    expect(traces.join("\n")).toContain("执行缝未装配");
  });

  it("下划线命名可达（名归一别名——设计文档 util_parse_log 同款命名）", async () => {
    const store = mockStore([regRow(spec("util_shout", ["developer"]))]);   // 下划线名
    const snap = await loadToolRegSnapshot(store);
    const kernel = mockKernel();
    const { llm, seenTools } = mockLlm([
      { toolCalls: [{ name: "util_shout", arguments: { text: "hi" } }] },
      { toolCalls: [{ name: "done", arguments: { result: 1 } }] },
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "p", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 5, toolRegistry: snap,
    });
    expect(r.ok).toBe(true);
    expect(seenTools[0]).toContain("util_shout");
    // 名归一 util_shout → util.shout 命中别名 → program 分发执行
    const tsExec = (kernel.ts as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(tsExec.mock.calls.map((c) => String(c[0])).join("\n")).toContain("toUpperCase");
  });

  it("builtin 态归并：ref 命中 AGENT_TOOLS → 静态执行面分发", async () => {
    const builtinSpec = spec("shell.echo", ["developer"], {
      executor: { type: "builtin", ref: "bash.eval" },
    });
    const snap = await loadToolRegSnapshot(mockStore([regRow(builtinSpec)]));
    const kernel = mockKernel();
    const { llm } = mockLlm([
      { toolCalls: [{ name: "shell_echo", arguments: { command: "echo hi" } }] },
      { toolCalls: [{ name: "done", arguments: { result: 1 } }] },
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "p", actionTools: ["execTs", "nav", "cache"] } as never,
      maxSteps: 5, toolRegistry: snap,
    });
    expect(r.ok).toBe(true);
    // bash.eval 执行器被调（mock bash.execute 收到 echo 命令）
    const bashExec = (kernel.bash as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(bashExec.mock.calls.map((c) => String(c[0])).join("\n")).toContain("echo hi");
  });
});
