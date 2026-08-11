import { describe, it, expect } from "vitest";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/kernel/interpreter/kernel-manager.js";
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import { AGENT_TOOL_IDS } from "../../src/pth/kernel/execution/parse-agent-action.js";
import { AGENT_CAPABILITY_DOC, AGENT_TOOLS_DESCRIPTION } from "../../src/pth/kernel/execution/agent-tools.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";

/**
 * 工具面收敛终态（2026-08-09）：
 * ① 元工具三件套 + done（白名单收缩）
 * ② ts 核内 results/context 对象（结果注册表 + 工作台——内部管理语言语义）
 * ③ 能力函数进 vm（memory.query/sql 等——程序内一体化）
 */

describe("工具面收敛终态", () => {
  let manager: ReturnType<typeof createKernelManager>;
  let kernel: ReturnType<typeof createWorkerKernelWithManager>;

  beforeAll(async () => {
    manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: {
        memory: { retrieve: async () => [], write: async () => {} },
        tasks: { candidates: async () => [], submit: async () => {} },
        queryReadOnly: async (sql: string) => [{ kind: "tool-function", content: `from:${sql.slice(0, 20)}` }],
      } as any,
      manager,
      toolstore: null as any,
    });
  });

  afterAll(() => {
    manager.dispose();
  });

  it("白名单收缩：语言元命令 + 生产核 dev.*/debug.* + done", () => {
    expect(AGENT_TOOL_IDS).toEqual([
      "ts.eval", "ts.run", "python.eval", "python.run", "bash.eval", "bash.run",
      // 生产核（2026-08-11 dev 空间——编译类语言唯一入口 + 调试会话族）
      "dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list",
      "debug.attach", "debug.breakpoint", "debug.continue", "debug.step", "debug.snapshot", "debug.evaluate", "debug.detach", "debug.sessions",
      "done",
    ]);
    expect(AGENT_TOOLS_DESCRIPTION).toContain("ts");
    expect(AGENT_TOOLS_DESCRIPTION).not.toContain("- llm.complete"); // 动作工具面无 llm.complete（能力函数仍在 ts 程序内）
  });

  it("能力文档：ts 程序内可用函数清单（memory.query/context/results 说明）", () => {
    expect(AGENT_CAPABILITY_DOC).toContain("memory.query");
    expect(AGENT_CAPABILITY_DOC).toContain("results");
    expect(AGENT_CAPABILITY_DOC).toContain("context");
    expect(AGENT_CAPABILITY_DOC).toContain("仅 SELECT");
  });

  it("ts 核内 results/context 对象预置：程序可读写", async () => {
    const r1 = await kernel.ts.execute("context.my_data = { loaded: true };\nreturn 'ok1'");
    expect(r1.ok).toBe(true);
    const r2 = await kernel.ts.execute("return { ctx: context.my_data, hasResults: typeof results === 'object' }");
    expect(r2.ok).toBe(true);
    expect((r2.value as any).ctx).toEqual({ loaded: true });
    expect((r2.value as any).hasResults).toBe(true);
  });

  it("能力函数进 vm：ts 程序内 await memory.query（受限 SQL）", async () => {
    const r = await kernel.ts.execute(
      'const rows = await memory.query("SELECT * FROM memory_entries WHERE kind = \'tool-function\'"); return { n: rows.length, kind: rows[0].kind };',
    );
    expect(r.ok).toBe(true);
    expect((r.value as any).kind).toBe("tool-function");
  });

  it("registerResult：工具结果自动注册 results 对象（agent 循环）", async () => {
    let step = 0;
    const llm: LlmFn = {
      complete: async () => {
        step++;
        if (step === 1) {
          return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c1", name: "python.run", arguments: { code: "_result = 21 * 2" } }] };
        }
        return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c2", name: "done", arguments: { result: { ok: true }, summary: "done" } }] };
      },
    } as LlmFn;

    const r = await runAgentTask({
      llm, kernel, caps: kernel.capabilities,
      task: { title: "reg", text: "算 21*2" },
      maxSteps: 5,
    });
    expect(r.ok).toBe(true);
    // 上一步 python 工具结果已自动注册进 ts 核内 results
    const check = await kernel.ts.execute("return results.result_1");
    expect((check.value as any).tool).toBe("python.run");
    expect((check.value as any).value).toBe(42);
  });

  it("agent 循环内程序可引用之前结果（results.result_N 联动）", async () => {
    let step = 0;
    const llm: LlmFn = {
      complete: async () => {
        step++;
        if (step === 1) {
          return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c1", name: "python.run", arguments: { code: "_result = 100" } }] };
        }
        if (step === 2) {
          return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c2", name: "ts.run", arguments: { code: "const prev = results.result_1; return { got: prev.value + 1 };" } }] };
        }
        return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c3", name: "done", arguments: { result: { ok: true }, summary: "done" } }] };
      },
    } as LlmFn;

    const r = await runAgentTask({
      llm, kernel, caps: kernel.capabilities,
      task: { title: "link", text: "联动" },
      maxSteps: 5,
    });
    expect(r.ok).toBe(true);
    // step2 的 ts 程序读了 results.result_1（100）→ 101
    const check = await kernel.ts.execute("return results.result_2");
    expect((check.value as any).value).toEqual({ got: 101 });
  });
});

describe("env.inspect（环境感知 ②）", () => {
  it("ts 程序内 inspect 查看 kernel 状态（变量/函数概览）", async () => {
    const manager2 = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel2 = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager: manager2, toolstore: null as any,
    });
    // 先在 python 命名空间造状态
    await kernel2.python.execute("env_marker = 42");
    const r = await kernel2.ts.execute('const v = await env.inspect("python"); return { hasMarker: JSON.stringify(v).includes("env_marker"), shape: typeof v };');
    expect(r.ok).toBe(true);
    expect((r.value as any).hasMarker).toBe(true);
    expect((r.value as any).shape).toBe("object");
    manager2.dispose();
  });

  it("inspect 不暴露 _ 私有/保留项（摘要安全）", async () => {
    const manager3 = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel3 = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [] } as any,
      manager: manager3, toolstore: null as any,
    });
    await kernel3.python.execute("_private_var = 'secret'; public_var = 1");
    const r = await kernel3.ts.execute('const v = await env.inspect("python"); return { hasPrivate: JSON.stringify(v).includes("_private_var"), hasPublic: JSON.stringify(v).includes("public_var") };');
    expect((r.value as any).hasPrivate).toBe(false);
    expect((r.value as any).hasPublic).toBe(true);
    manager3.dispose();
  });
});

describe("能力函数动作降级（LLM 误写 memory.query 为动作）", () => {
  it("memory.query 动作 → 自动转 ts 程序执行", async () => {
    const manager4 = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    const kernel4 = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: { memory: { retrieve: async () => [], write: async () => {} }, tasks: { candidates: async () => [], submit: async () => {} }, queryReadOnly: async () => [{ kind: "tool-function" }] } as any,
      manager: manager4, toolstore: null as any,
    });
    let step = 0;
    const llm: LlmFn = {
      complete: async () => {
        step++;
        if (step === 1) {
          // 模型调了未声明的工具（memory.query 非白名单）→ 降级转 ts 程序执行
          return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c1", name: "memory.query", arguments: { sql: "SELECT kind FROM memory_entries LIMIT 5" } }] };
        }
        return { content: "", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ id: "c2", name: "done", arguments: { result: { ok: true }, summary: "done" } }] };
      },
    } as LlmFn;

    const r = await runAgentTask({ llm, kernel: kernel4, caps: kernel4.capabilities, task: { title: "cap-act", text: "查记忆" }, maxSteps: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps).toBe(2); // 降级一步 + done
    manager4.dispose();
  });
});
