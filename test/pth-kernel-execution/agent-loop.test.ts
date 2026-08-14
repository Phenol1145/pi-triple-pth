import { describe, it, expect, vi } from "vitest";
import { runAgentTask, filterCapabilityDoc } from "../../src/pth/kernel/execution/agent-loop.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";
import type { WorkerKernel } from "../../src/pth/kernel/interpreter/index.js";

function mockKernel(): WorkerKernel {
  return {
    ts: {
      execute: vi.fn(async (code: string) => ({ ok: true, value: { fromTs: true }, durationMs: 1, language: "ts" })),
      reset: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
    } as any,
    python: {
      execute: vi.fn(async (code: string) => ({ ok: true, value: code.includes("fib") ? 75025 : 42, durationMs: 1, language: "python" })),
      reset: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
    } as any,
    bash: {
      execute: vi.fn(async (cmd: string) => ({ ok: true, stdout: `bash:${cmd.length}`, durationMs: 1, language: "bash" })),
      reset: vi.fn(),
      dispose: vi.fn(),
      snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
    } as any,
    llm: null as any,
    dataWorld: null as any,
    reset: vi.fn(),
    dispose: vi.fn(),
    snapshot: vi.fn(async () => ({ variables: [], functions: [], oversized: [] })),
  };
}

function mockLlm(steps: Array<{ toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string; thinking?: string }>): LlmFn {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return {
        content: step.content ?? "",
        model: "mock",
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(step.thinking ? { thinking: step.thinking } : {}),
        ...(step.toolCalls
          ? { toolCalls: step.toolCalls.map((tc, idx) => ({ id: `call_${i}_${idx}`, name: tc.name, arguments: tc.arguments })) }
          : {}),
      };
    }),
  };
}

const CAPS = { web: {}, state: {}, fs: {}, memory: {} } as Record<string, unknown>;

describe("runAgentTask（agent 循环）", () => {
  it("多步执行：python 算 → done 提交（工具被正确调用）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "python.run", arguments: { code: "fib" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { fib25: 75025 }, summary: "完成" } }] },
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS,
      task: { title: "t", text: "算 fib(25)" },
      role: { id: "developer", labelPatterns: [], prompt: "你是开发者" },
      maxSteps: 5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toBe(2);
      expect(r.value).toEqual({ fib25: 75025 });
      expect(kernel.python.execute).toHaveBeenCalledWith("fib", expect.objectContaining({ exec: "program" }));
    }
  });

  it("原生 tool_calls：结构化调用 bash + 文本回复完成", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "bash.run", arguments: { command: "ls" } }] },
      { content: "完成，已执行 ls" },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(kernel.bash.execute).toHaveBeenCalledWith("ls");
  });

  it("超 maxSteps 强制终止（partial result + warning）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([{ toolCalls: [{ name: "bash.run", arguments: { command: "x" } }] }]);  // 永远不 done
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("maxSteps");
  });

  it("工具执行异常 → 回填错误让 LLM 修正（不算失败）", async () => {
    const kernel = mockKernel();
    const badKernel = { ...kernel, python: { ...kernel.python, execute: vi.fn(async () => { throw new Error("boom"); }) } } as never;
    const llm = mockLlm([
      { toolCalls: [{ name: "python.run", arguments: { code: "x" } }] },
      { content: "修正后完成" },
    ]);
    const r = await runAgentTask({ llm, kernel: badKernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(true);  // 异常不终止——LLM 收到错误回填后文本回复完成
  });

  it("done 缺 result 视为失败", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([{ toolCalls: [{ name: "done", arguments: {} }] }]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(false);
  });
});

describe("PTC 程序模式（P1）", () => {
  it("探索核候选块（backlog 差距 11）：角色声明 exploreKernels 时注入 A/B 并存引导；未声明不注入", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const withKernels = await buildAgentSystemPrompt(
      { id: "tester", labelPatterns: [], prompt: "你是测试者", exploreKernels: ["python", "bash"] } as never, "t");
    expect(withKernels).toContain("探索核候选");
    expect(withKernels).toContain("python/bash");
    expect(withKernels).toContain("A/B 并存");
    const without = await buildAgentSystemPrompt({ id: "developer", labelPatterns: [], prompt: "你是开发者" }, "t");
    expect(without).not.toContain("探索核候选");
  });

  it("system prompt 包含程序模式引导（ts 组合多 kernel + 示例）", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt({ id: "developer", labelPatterns: [], prompt: "你是开发者" }, "t");
    expect(prompt).toContain("程序模式（PTC");
    expect(prompt).toContain("完整程序");
    // eager 模式：无 memory 时回退 role.prompt（不崩）
    expect(prompt).toContain("你是开发者");
  });

  it("lazy 模式：角色/能力指针（不注入全文——LLM 按需 query）", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt({ id: "developer", labelPatterns: [], prompt: "你是开发者" }, "t", { mode: "lazy" });
    expect(prompt).toContain("role-doc:developer");
    expect(prompt).toContain("capability-index");
    expect(prompt).toContain("memory.query");
    expect(prompt).not.toContain("fs.task.write");  // 能力详情不注入——指针指向索引
  });

  it("eager 模式：memory 有 role-doc/capability-index 时注入全文", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const memory = { query: async (sql: string) => {
      if (sql.includes("role-doc")) return [{ content: "# 角色：developer 全文角色文档" }];
      return [{ content: "# PTH 能力索引 fs.task.write 写任务工作区" }];
    } };
    const prompt = await buildAgentSystemPrompt({ id: "developer", labelPatterns: [], prompt: "你是开发者" }, "t", { mode: "eager", memory: memory as never });
    expect(prompt).toContain("全文角色文档");
    expect(prompt).toContain("fs.task.write");
  });

  it("ts 工具回填 value + stdout（组合输出）", async () => {
    const { AGENT_TOOLS } = await import("../../src/pth/kernel/execution/agent-tools.js");
    const kernel = mockKernel();
    (kernel.ts.execute as any).mockResolvedValueOnce({
      ok: true, value: { sum: 5050 }, stdout: "中间输出1\n中间输出2", durationMs: 1, language: "ts",
    });
    const r = await AGENT_TOOLS["ts.run"]({ kernel, caps: CAPS }, { code: "return 1" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ sum: 5050 });
    expect(r.stdout).toContain("中间输出1");
    expect(r.stdout).toContain("返回值");
  });

  it("LLM 单步输出 ts 程序（组合 python+bash）→ 一次执行完成多步", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      // LLM 直接写 PTC 程序：一次完成 python 算 + bash 验证（不再分步）
      { toolCalls: [{ name: "ts.run", arguments: { code: 'const py = await python.execute("fib"); const b = await bash.execute("echo check"); return { fib: py.value, checked: true }; ' } }] },
      { toolCalls: [{ name: "done", arguments: { result: { fib25: 75025 }, summary: "PTC 一次完成" } }] },
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS,
      task: { title: "t", text: "算 fib(25) 并验证" },
      role: { id: "developer", labelPatterns: [], prompt: "你是开发者" },
      maxSteps: 5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toBe(2); // ts 程序一步 + done 一步（vs 旧多步）
      expect(kernel.ts.execute).toHaveBeenCalledTimes(1);
      expect(r.value).toEqual({ fib25: 75025 });
    }
  });
});

describe("收敛 agent 行为 v1（重复动作检测——轨迹分析 2026-08-09）", () => {
  it("语义指纹：同文件读取微变重写 → 判定重复（14 次案例的归一化）", async () => {
    const kernel = mockKernel();
    // 模拟 step 13-26 模式：同一 readSource 但每步微变（变量名/注释）
    const steps = Array.from({ length: 6 }, (_, i) => ({
      toolCalls: [{ name: "ts.run", arguments: { code: `// v${i} 重写\nconst s${i} = await fs.readSource("src/pth/impls/kernels/ts-interpreter.ts"); s${i};` } }],
    }));
    const llm = mockLlm(steps);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "读文件" }, maxSteps: 8 });
    // 第 5 次重复（repeatCount≥5）→ 强制终止（不无限循环）
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning ?? "").toContain("重复动作");
  });

  it("不同文件读取 → 不判定重复（正常推进）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "ts.run", arguments: { code: `const a = await fs.readSource("src/a.ts"); a;` } }] },
      { toolCalls: [{ name: "ts.run", arguments: { code: `const b = await fs.readSource("src/b.ts"); b;` } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: true } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "读多文件" }, maxSteps: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: true });
  });
});

describe("指纹归一化修正（c473e646 实测——memory 查询误判重复）", () => {
  it("不同 memory 查询（role/索引/列表）→ 不判重复（前 3 步正常推进）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "ts.run", arguments: { code: `const r = await memory.query("SELECT content FROM memory_entries WHERE id='role-doc:tester' LIMIT 1"); r;` } }] },
      { toolCalls: [{ name: "ts.run", arguments: { code: `const c = await memory.query("SELECT content FROM memory_entries WHERE kind='capability-index' LIMIT 1"); c;` } }] },
      { toolCalls: [{ name: "ts.run", arguments: { code: `const l = await memory.query("SELECT id, kind FROM memory_entries WHERE kind='skill' LIMIT 20"); l;` } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: true }, summary: "完成" } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "探索" }, maxSteps: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: true });  // 未被重复检测误终止——正常 done
  });

  it("同一 memory SQL 连续 → 判定重复（收敛——5 次强制终止）", async () => {
    const kernel = mockKernel();
    const same = { toolCalls: [{ name: "ts.run", arguments: { code: `const c = await memory.query("SELECT content FROM memory_entries WHERE kind='capability-index' LIMIT 1"); c;` } }] };
    const llm = mockLlm(Array.from({ length: 8 }, () => same));
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning ?? "").toContain("重复动作");
  });
});

describe("done 收尾引导（worker 设计 2026-08-09——三层防御：schema 强制 + 运行时引导 + 计数兜底）", () => {
  it("done 空 args → 引导继续（不立即 reject）——修正后成功提交", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "done", arguments: {} }] },                                // 空 done
      { toolCalls: [{ name: "done", arguments: { result: { ok: true } } }] },          // 修正——带 result
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: true });
  });

  it("连续 3 次空 done → 第 3 次强制失败（防死循环）", async () => {
    const kernel = mockKernel();
    const empty = { toolCalls: [{ name: "done", arguments: {} }] };
    const llm = mockLlm(Array.from({ length: 4 }, () => empty));
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("连续 3 次缺少 result");
  });

  it("空对象/空数组/空串 → 引导；0/false → 合法不误伤", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "done", arguments: { result: {} } }] },          // 空对象 → 引导
      { toolCalls: [{ name: "done", arguments: { result: [] } }] },          // 空数组 → 引导
      { toolCalls: [{ name: "done", arguments: { result: 0 } }] },           // 0 → 合法成功
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(0);
  });
});

describe("role.thinking 生效（推理深度→system prompt——PTH worker 实现 2026-08-10）", () => {
  it("thinking=low（scout）→ system prompt 含浅推理预算行", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt({ id: "scout", labelPatterns: [], prompt: "p", thinking: "low" } as never, "t", { mode: "lazy" });
    expect(prompt).toContain("浅——快速行动");
  });
  it("thinking=high（planner）→ 深推理预算行", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt({ id: "planner", labelPatterns: [], prompt: "p", thinking: "high" } as never, "t", { mode: "lazy" });
    expect(prompt).toContain("深度推理");
  });
  it("无 thinking 角色 → 零行为回归（不含推理预算行）", async () => {
    const { buildAgentSystemPrompt } = await import("../../src/pth/kernel/execution/agent-loop.js");
    const prompt = await buildAgentSystemPrompt(undefined, "t", { mode: "lazy" });
    expect(prompt).not.toContain("推理预算");
  });
});

describe("Agent-JIT 路径 B：role.thinking/role.model 接线到 LLM 调用", () => {
  it("scout（thinking low + model 覆盖）→ complete opts 传 thinking low + 指定模型", async () => {
    const llm = mockLlm([{ toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] }]);
    await runAgentTask({
      llm, kernel: mockKernel(), caps: { memory: {} } as any,
      task: { title: "t", text: "x" }, maxSteps: 3,
      role: { id: "scout", tags: ["role:scout"], prompt: "scout", thinking: "low", model: "cheap-model-x" },
    });
    const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { thinking?: string; model?: string };
    expect(call.thinking).toBe("low");
    expect(call.model).toBe("cheap-model-x");
  });

  it("无 role → 不传 thinking（走 provider 默认）；模型回落全局", async () => {
    const llm = mockLlm([{ toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] }]);
    await runAgentTask({ llm, kernel: mockKernel(), caps: { memory: {} } as any, task: { title: "t", text: "x" }, maxSteps: 3 });
    const call = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { thinking?: string };
    expect(call.thinking).toBeUndefined();
  });
});

describe("filterCapabilityDoc（Agent-JIT 路径 B——能力文档按包裁剪）", () => {
  const DOC = `# PTH 能力索引\n\n## 基础（全角色注入——results/context/model/perf/obs）\n- results: 结果注册表\n- context: 任务工作台\n\n## memory\n- memory.query: {sql}\n- memory.write: {kind, anchors, content}\n\n## fs\n- fs.readText(path)\n- fs.task.write(relPath, content)\n\n## 执行核（python/bash/c）\n- python.execute(code)\n- bash.execute(command)\n\n## web/llm/state/ext/env（扩展能力包）\n- llm.complete\n- web: HTTP 获取\n`;

  it("memory 角色 → 只留基础 + memory 节", () => {
    const out = filterCapabilityDoc(DOC, ["memory"]);
    expect(out).toContain("memory.query");
    expect(out).not.toContain("fs.readText");
    expect(out).not.toContain("python.run");
    expect(out).not.toContain("llm.complete");
    expect(out).toContain("results: 结果注册表");   // 基础节保留
  });

  it("fs 角色 → 基础 + fs 节（readSource/readText 映射 fs）", () => {
    const out = filterCapabilityDoc(DOC, ["fs", "readSource"]);
    expect(out).toContain("fs.readText");
    expect(out).not.toContain("memory.query");
  });

  it("全量角色（无 capabilities 声明）→ 不裁剪", () => {
    expect(filterCapabilityDoc(DOC, ["python", "bash", "c", "fs", "web", "llm", "state", "ext", "env", "memory", "skills", "obs"])).toBe(DOC);
  });

  it("自由格式文档（无 ## 节）→ 原样返回", () => {
    expect(filterCapabilityDoc("plain doc no sections", ["memory"])).toBe("plain doc no sections");
  });
});

describe("执行面授权（2026-08-12 审计 HIGH-2 修复）", () => {
  it("asp 模式：actionTools 未授 spaceMaint → asp_create 拒绝且不注册空间", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_create", arguments: { id: "auth-x", execTool: "ts", description: "d" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const traces: string[] = [];
    const r = await runAgentTask({
      llm, kernel, caps: CAPS,
      task: { title: "t", text: "x" },
      role: { id: "planner", labelPatterns: [], prompt: "p", actionTools: ["nav", "cache"], capabilities: ["fs", "memory"] } as never,
      asp: true, maxSteps: 6,
      onTrace: ((t: { type: string; resultPreview?: string }) => { if (t.type === "tool-result") traces.push(t.resultPreview ?? ""); }) as never,
    });
    expect(r.ok).toBe(true);
    expect(traces.some((t) => t.includes("治理授权拒绝"))).toBe(true);
    const { spaceRegistry } = await import("../../src/pth/kernel/execution/space-registry.js");
    expect(spaceRegistry.get("auth-x")).toBeUndefined();   // 未注册
  });

  it("asp 模式：capabilities 无 python → python.run 拒绝（不触达 kernel）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "python" } }] },
      { toolCalls: [{ name: "python_run", arguments: { code: "x" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const traces: string[] = [];
    const r = await runAgentTask({
      llm, kernel, caps: CAPS,
      task: { title: "t", text: "x" },
      role: { id: "planner", labelPatterns: [], prompt: "p", capabilities: ["fs", "memory"] } as never,
      asp: true, maxSteps: 8,
      onTrace: ((t: { type: string; resultPreview?: string }) => { if (t.type === "tool-result") traces.push(t.resultPreview ?? ""); }) as never,
    });
    expect(r.ok).toBe(true);
    expect(traces.some((t) => t.includes("capabilities 授权拒绝"))).toBe(true);
    expect(kernel.python.execute).not.toHaveBeenCalled();
  });

  it("全量兼容：未声明 capabilities → python.run 正常执行", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "python" } }] },
      { toolCalls: [{ name: "python_run", arguments: { code: "fib" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS,
      task: { title: "t", text: "x" },
      role: { id: "developer", labelPatterns: [], prompt: "p" } as never,   // 无 capabilities 声明 = 全量兼容
      asp: true, maxSteps: 8,
    });
    expect(r.ok).toBe(true);
    expect(kernel.python.execute).toHaveBeenCalled();
  });
});

// （2026-08-14 T3：pick_tools 动态工具选择协议已废弃——describe 块与相关测试随机制移除）

describe("未知工具引导 + 直觉别名（2026-08-13）", () => {
  it("幻觉工具名 write_doc → 回填引导不终止（模型改 write.create 完成）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "write_doc", arguments: { path: "a.md", content: "x" } }] },
      { toolCalls: [{ name: "write.create", arguments: { path: "a.md", content: "x" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 6 });
    expect(r.ok).toBe(true);   // 引导后模型用正确工具名完成
  });

  it("直觉别名 write_doc → write.create（直接映射——不占引导轮）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "write_doc", arguments: { path: "a.md", content: "x" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(r.ok).toBe(true);
  });
});

describe("负结果收敛（S6 死循环机制——2026-08-13）", () => {
  it("同目标连续负结果 N=3 引导 / N=5 强制终止（warning）", async () => {
    const baseKernel = mockKernel();
    const kernel = { ...baseKernel, bash: { ...baseKernel.bash, execute: vi.fn(async () => ({ ok: false, error: "No such file or directory", durationMs: 1, language: "bash" })) } } as never;
    const steps = Array.from({ length: 6 }, (_, i) => ({
      toolCalls: [{ name: "bash_run", arguments: { command: `ls extensions/probe-${i}/index.ts` } }],
    }));
    const llm = {
      complete: vi.fn(async () => {
        const i = Math.min((llm.complete as ReturnType<typeof vi.fn>).mock.calls.length - 1, steps.length - 1);
        return {
          content: "", model: "mock", usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: steps[i]!.toolCalls.map((tc, idx) => ({ id: `c${i}_${idx}`, name: tc.name, arguments: tc.arguments })),
        };
      }),
    };
    const traces: string[] = [];
    const r = await runAgentTask({
      llm: llm as never, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 8,
      onTrace: ((t: { type: string; resultPreview?: string }) => { if (t.type === "tool-result") traces.push(t.resultPreview ?? ""); }) as never,
    });
    // bash 执行结果 ok:false + error "No such file"（负结果语义）——N=5 强制终止
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("负验证循环");
  });

  it("正结果中断重置——负结果计数清零", async () => {
    const kernel = mockKernel();
    const seq = [
      { toolCalls: [{ name: "bash_run", arguments: { command: "ls x1/index.ts" } }] },
      { toolCalls: [{ name: "bash_run", arguments: { command: "ls x2/index.ts" } }] },
      { toolCalls: [{ name: "bash_run", arguments: { command: "echo ok" } }] },   // 正结果（stdout ok）
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ];
    const llm = mockLlm(seq);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 6 });
    expect(r.ok).toBe(true);   // 正结果重置——未触发终止——正常 done
  });
});

describe("B1 修复（2026-08-14）：reasoning_content 回传 + 多调用提前终止序列补全", () => {
  it("assistant 消息携带 thinking（deepseek v4 thinking 模式契约——reasoning_content 回传）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { thinking: "思考A", toolCalls: [{ name: "ts.run", arguments: { code: "const a = 1; a;" } }] },
      { thinking: "思考B", toolCalls: [{ name: "done", arguments: { result: { ok: true } } }] },
    ]);
    const input: any = { llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 };
    const r = await runAgentTask(input);
    expect(r.ok).toBe(true);
    const msgs = input.__messages as Array<{ role: string; thinking?: string }>;
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.thinking)).toEqual(["思考A", "思考B"]);
  });

  it("多工具调用中 done 提前终止 → 未执行调用补合成 tool 响应（序列完整）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [
        { name: "done", arguments: { result: { ok: true } } },
        { name: "ts.run", arguments: { code: "const a = 1; a;" } },
      ] },
    ]);
    const input: any = { llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 };
    const r = await runAgentTask(input);
    expect(r.ok).toBe(true);
    const msgs = input.__messages as Array<{ role: string; toolCallId?: string; content?: string }>;
    const tail = msgs.slice(-2);
    expect(tail[0].role).toBe("tool");
    expect(tail[1].role).toBe("tool");
    expect(tail.every((m) => m.toolCallId && m.content?.includes("未执行"))).toBe(true);
    // 两个 tool 响应 id 与 assistant tool_calls 一一对应
    const asst = msgs.filter((m) => m.role === "assistant")[0] as any;
    const callIds = asst.toolCalls.map((t: { id: string }) => t.id);
    expect(tail.map((m) => m.toolCallId).sort()).toEqual(callIds.sort());
  });

  it("正常多工具调用全执行 → 每个调用都有真实 tool 响应（无合成）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [
        { name: "ts.run", arguments: { code: "const a = 1; a;" } },
        { name: "ts.run", arguments: { code: "const b = 2; b;" } },
      ] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 2 } } }] },
    ]);
    const input: any = { llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 };
    const r = await runAgentTask(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ ok: 2 });
    const msgs = input.__messages as Array<{ role: string; content?: string }>;
    const firstBatch = msgs.slice(3, 5);   // 首步 assistant 后的两个 tool 响应（[system, user, assistant, tool, tool]）
    expect(firstBatch.every((m) => m.role === "tool" && !m.content?.includes("未执行"))).toBe(true);
  });
});
