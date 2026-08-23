import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { installDefaultRoles } from "../helpers.js";

beforeEach(() => installDefaultRoles());
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager.js";
import { runAgentTask } from "@away_from/pth-kernel-execution";
import { AGENT_TOOL_IDS } from "@away_from/pth-kernel-execution";
import { AGENT_CAPABILITY_DOC, AGENT_TOOLS_DESCRIPTION } from "@away_from/pth-kernel-execution";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";

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

  it("白名单收缩：语言元命令 + 生产核 dev.*/debug.* + write.* + done", () => {
    expect(AGENT_TOOL_IDS).toEqual([
      "ts.eval", "ts.run", "python.eval", "python.run", "bash.eval", "bash.run",
      // 生产核（2026-08-11 dev 空间——编译类语言唯一入口 + 调试会话族）
      "dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list",
      "debug.attach", "debug.breakpoint", "debug.continue", "debug.step", "debug.snapshot", "debug.evaluate", "debug.detach", "debug.sessions",
      // 生产核·文档（2026-08-12 批 2 write 空间——编写类任务）
      "write.create", "write.edit", "write.read", "write.list", "write.save", "write.section",
      "done",
      "pause",
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

describe("asm-kernel 接线（2026-08-12：dev.build/dev.run .s 分发）", () => {
  it("dev.build .s 文件 → asm 惰性注册 + execute(\"asm\") 路由（C 路径不触碰）", async () => {
    const { AGENT_TOOLS: agentTools } = await import("@away_from/pth-kernel-execution");
    const calls: string[] = [];
    const kernel = {
      c: { execute: async () => { calls.push("c"); return { ok: true, value: {} }; } },
      registerKernel: (l: string) => { calls.push(`register:${l}`); },
      execute: async (l: string) => { calls.push(`execute:${l}`); return { ok: true, value: { binaryRef: "abc" }, stdout: "ok" }; },
    };
    const ctx = {
      kernel,
      toolstore: { readText: async (p: string) => {
        calls.push(`read:${p}`);
        return `module.exports = async function factory(ctx) { return { kernels: [{ language: "asm", create: () => ({ execute: async () => ({ ok: true, value: {} }) }) }] }; };`;
      } },
      taskWorkspace: "/tmp/ws",
      taskWorkspaceResolve: () => "/tmp/ws",
    } as never;
    // 写入工作区 hello.s
    await (await import("node:fs/promises")).mkdir("/tmp/ws", { recursive: true });
    await (await import("node:fs/promises")).writeFile("/tmp/ws/hello.s", "mov x0, #1\n");
    const r = await (agentTools as Record<string, (c: typeof ctx, a: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; stdout?: string }>>)["dev.build"](ctx, { path: "hello.s" });
    expect(r.ok).toBe(true);
    expect(calls).toContain("read:extensions/asm-kernel/index.js");
    expect(calls).toContain("register:asm");
    expect(calls).toContain("execute:asm");
    expect(calls).not.toContain("c");   // C 核路径未触碰
    await (await import("node:fs/promises")).rm("/tmp/ws", { recursive: true, force: true });
  });

  it("dev.build 非 .s（.c）→ 原 C 路径（分发不误伤）", async () => {
    const { AGENT_TOOLS: agentTools } = await import("@away_from/pth-kernel-execution");
    const calls: string[] = [];
    const ctx = {
      kernel: { c: { execute: async () => { calls.push("c"); return { ok: true, value: {} }; } } },
      toolstore: null,
      taskWorkspace: "/tmp/ws",
    } as never;
    await (await import("node:fs/promises")).mkdir("/tmp/ws", { recursive: true });
    await (await import("node:fs/promises")).writeFile("/tmp/ws/main.c", "int main(){return 0;}\n");
    const r = await (agentTools as Record<string, (c: typeof ctx, a: Record<string, unknown>) => Promise<{ ok: boolean }>>)["dev.build"](ctx, { path: "main.c" });
    expect(calls).toEqual(["c"]);
    await (await import("node:fs/promises")).rm("/tmp/ws", { recursive: true, force: true });
  });
});

describe("动作面裁剪（2026-08-12：目标驱动最小工具面——推理面削减）", () => {
  it("coder 纯代码编写面：无 debug（不调试——调试归 debug 族/tester 验证）", async () => {
    const { DEFAULT_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const coder = DEFAULT_ROLES.find((r) => r.id === "coder")!;
    expect(coder.actionTools).not.toContain("debug");
    expect(coder.actionTools).toContain("dev");
    expect(coder.parent).toBe("developer");
  });

  it("developer 面（0.16.4 收口后）：内部类型 = 基本工具面（dev/debug/write 下沉 coder/tester/writer）", async () => {
    const { DEFAULT_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const { filterToolSchemas } = await import("@away_from/pth-kernel-execution");
    const dev = DEFAULT_ROLES.find((r) => r.id === "developer")!;
    const schemas = filterToolSchemas(dev.actionTools);
    const names = Object.keys(schemas);
    expect(names).toContain("ts.run");
    expect(names).not.toContain("dev.build");     // 生产核归 coder/tester（developer 已分拆——只投递）
    expect(names).not.toContain("debug.attach");
    expect(names).not.toContain("write.create");
    expect(names).not.toContain("asp.create");
    expect(names).not.toContain("asp.destroy");
    // 基本工具面：execTs2 + nav3 + cache3 = 8
    expect(names.length).toBe(8);
  });

  it("acceptor 只读面：dev.run/dev.list/write.read/write.list——无 dev.write/write.create（验收不写）", async () => {
    const { DEFAULT_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const { filterToolSchemas } = await import("@away_from/pth-kernel-execution");
    const acc = DEFAULT_ROLES.find((r) => r.id === "acceptor")!;
    const schemas = filterToolSchemas(acc.actionTools);
    const names = Object.keys(schemas);
    expect(names).toContain("dev.run");
    expect(names).toContain("write.read");
    expect(names).not.toContain("dev.write");
    expect(names).not.toContain("dev.edit");
    expect(names).not.toContain("write.create");
    expect(names).not.toContain("write.edit");
  });

  it("spaceMaint 族已退役（2026-08-14 N8）——controller 系与 worker 角色均无（空间生成走治理通道）", async () => {
    const { DEFAULT_ROLES, GOVERNANCE_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const ctrl = GOVERNANCE_ROLES.find((r) => r.id === "controller:pth-opt")!;
    expect(ctrl.actionTools ?? []).not.toContain("spaceMaint");   // 工具面退役——生成走 spaceRegistry.createChild（治理通道）
    for (const r of DEFAULT_ROLES) {
      expect(r.actionTools ?? []).not.toContain("spaceMaint");   // worker 从来无空间治理面
    }
  });

  it("toolsDescription 与 schema 同步（裁剪后 prompt 面一致——in-tokens 削减）", async () => {
    const { filterToolSchemas, toolsDescription } = await import("@away_from/pth-kernel-execution");
    const schemas = filterToolSchemas(["execTs", "nav", "cache"]);
    const desc = toolsDescription(["execTs", "nav", "cache"]);
    for (const n of Object.keys(schemas)) {
      // 2026-08-15 审计 LOW：描述名与 schema tool name 同为下划线形（命名一致性）
      if (n === "done") { expect(desc).toContain("- done:"); continue; }
      expect(desc).toContain(n.replace(/\./g, "_"));
    }
    expect(desc).not.toContain("debug.attach");   // 未裁剪工具不进 prompt
    expect(desc).toContain("- done:");            // 协议固定段保留
  });

  it("toolsDescription done 去重 + 下划线命名一致（2026-08-15 审计 LOW）", async () => {
    const { toolsDescription } = await import("@away_from/pth-kernel-execution");
    const desc = toolsDescription();
    expect(desc.match(/- done:/g)).toHaveLength(1);          // schema 内 done 与协议固定段不重复
    expect(desc).toContain("- ts_run:");
    expect(desc).not.toContain("- ts.run:");
    expect(desc).toContain("- asp_cd:");
  });

  it("toolsDescription 非 ASP 面剔除 ASP-only（schema/prompt 与执行面同源——2026-08-15 审计 MEDIUM）", async () => {
    const { toolsDescription } = await import("@away_from/pth-kernel-execution");
    const nonAsp = toolsDescription(undefined, { asp: false });
    expect(nonAsp).not.toContain("asp.cd");
    expect(nonAsp).not.toContain("asp.index");
    expect(nonAsp).not.toContain("memory.index");
    expect(nonAsp).not.toContain("cache.load");
    expect(nonAsp).toContain("ts.run");
    expect(nonAsp).toContain("- done:");
    const asp = toolsDescription(undefined, { asp: true });
    expect(asp).toContain("asp_cd:");
    expect(asp).toContain("cache_load:");
  });
});

describe("0.16.4 分拆 worker 工具面收口（2026-08-18——内部类型 = 基本工具 + 直接子类型投递）", () => {
  // 裁决：Q1 仅收 actionTools（capabilities 不动——引导级收口）/ Q2 一次全收 + 测试钉死 / Q3 MID prompt 同步改写
  const INTERNAL_TYPES = ["actuator", "executor", "explorer", "governor", "researcher", "analyst", "developer", "tester", "prospector"];
  const BASE_FACE = ["ts.run", "ts.eval", "asp.cd", "asp.index", "memory.index", "cache.load", "cache.index", "cache.cancel"];

  it("九个内部类型 actionTools 统一收为 [execTs, nav, cache]", async () => {
    const { DEFAULT_ROLES, MID_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const all = [...DEFAULT_ROLES, ...MID_ROLES];
    for (const id of INTERNAL_TYPES) {
      const role = all.find((r) => r.id === id);
      expect(role, `内部类型 ${id} 应存在`).toBeDefined();
      expect(role!.actionTools, `${id} 工具面`).toEqual(["execTs", "nav", "cache"]);
    }
  });

  it("内部类型过滤后工具面 = 基本工具 8 件（无执行核/生产核/治理面）", async () => {
    const { DEFAULT_ROLES, MID_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const { filterToolSchemas } = await import("@away_from/pth-kernel-execution");
    const all = [...DEFAULT_ROLES, ...MID_ROLES];
    for (const id of INTERNAL_TYPES) {
      const names = Object.keys(filterToolSchemas(all.find((r) => r.id === id)!.actionTools)).sort();
      expect(names, `${id} 过滤面`).toEqual([...BASE_FACE].sort());
    }
  });

  it("MID 类型 prompt 已改写为 tasks.delegate 实际派发（用户裁决 Q3）", async () => {
    const { MID_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    for (const id of ["actuator", "executor", "explorer", "governor", "researcher"]) {
      const role = MID_ROLES.find((r) => r.id === id)!;
      expect(role.prompt, `${id} prompt`).toContain("tasks.delegate");
      expect(role.prompt, `${id} prompt`).not.toContain("注明建议路由");
    }
  });

  it("叶子类型工具面不受收口影响（coder/scout/writer 等保持专精面）", async () => {
    const { DEFAULT_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const coder = DEFAULT_ROLES.find((r) => r.id === "coder")!;
    expect(coder.actionTools).toContain("dev");
    const scout = DEFAULT_ROLES.find((r) => r.id === "scout")!;
    expect(scout.actionTools).toContain("execBash");
    const writer = DEFAULT_ROLES.find((r) => r.id === "writer")!;
    expect(writer.actionTools).toContain("write");
    const solver = DEFAULT_ROLES.find((r) => r.id === "solver")!;
    expect(solver.actionTools).toContain("execPy");
  });

  it("sensor/controller 治理族根不按 0.16.4 收口（各自治理工具面保留）", async () => {
    const { MID_ROLES, GOVERNANCE_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const sensor = MID_ROLES.find((r) => r.id === "sensor")!;
    expect(sensor.actionTools ?? []).not.toEqual(["execTs", "nav", "cache"]);
    const ctrl = GOVERNANCE_ROLES.find((r) => r.id === "controller:worker-opt")!;
    expect(ctrl.actionTools).toContain("execPy");
  });

  it("九内部类型均有直接子类型（tasks 投递白名单非空——收口后投递面可用）", async () => {
    const { allowedDelegationTargets } = await import("../../src/pth/tasking/index.js");
    for (const id of INTERNAL_TYPES) {
      expect(allowedDelegationTargets(id).length, `${id} 可投递目标`).toBeGreaterThan(0);
    }
  });
});
