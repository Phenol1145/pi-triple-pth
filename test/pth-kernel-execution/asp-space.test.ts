import { describe, it, expect, vi } from "vitest";
import { spaceRegistry } from "../../src/pth/kernel/execution/space-registry.js";
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";

describe("space-registry（空间注册表——数据驱动）", () => {
  it("内置空间随模块加载（meta + ts/python/bash/dev/write——2026-08-11 c 撤销/生产核 dev 上线；2026-08-12 批 2 write 上线）", () => {
    expect(spaceRegistry.get("meta")?.kind).toBe("meta");
    for (const id of ["ts", "python", "bash", "dev", "write"]) {
      expect(spaceRegistry.isActionSpace(id)).toBe(true);
    }
    expect(spaceRegistry.get("c")).toBeUndefined();   // c 空间已撤销（编译类归 dev 生产核）
  });

  it("执行工具反查（门控依据）", () => {
    expect(spaceRegistry.spaceOfExecTool("python_run")).toBe("python");
    expect(spaceRegistry.spaceOfExecTool("ts")).toBe("ts");
    expect(spaceRegistry.spaceOfExecTool("done")).toBeNull();   // done 不是语言执行工具
    // 生产核 dev 空间（2026-08-11）：execTool="dev" 族名展开 + extraTools=["debug"] 族反查
    expect(spaceRegistry.spaceOfExecTool("dev_write")).toBe("dev");
    expect(spaceRegistry.spaceOfExecTool("dev.run")).toBe("dev");
    expect(spaceRegistry.spaceOfExecTool("debug_attach")).toBe("dev");
    expect(spaceRegistry.spaceOfExecTool("debug.snapshot")).toBe("dev");
    expect(spaceRegistry.spaceOfExecTool("c_execute")).toBeNull();   // c 空间已撤销
    // 生产核 write 空间（2026-08-12 批 2）：execTool="write" 族名展开/反查
    expect(spaceRegistry.spaceOfExecTool("write_create")).toBe("write");
    expect(spaceRegistry.spaceOfExecTool("write.section")).toBe("write");
  });

  it("内置空间不可注销", () => {
    expect(() => spaceRegistry.unregister("ts")).toThrow(/内置/);
  });
});

// ── agent-loop ASP 状态机 ─────────────────────────────
function mockKernel() {
  return {
    ts: { execute: vi.fn(async (code: string) => ({ ok: true, value: `exec:${code.slice(0, 20)}`, durationMs: 1 })), registerResult: vi.fn() },
    bash: { execute: async () => ({ ok: true, stdout: "ok" }) },
    python: { execute: async () => ({ ok: true, value: 1, stdout: "1" }) },
    llm: { complete: async () => ({ content: "" }) },
    dataWorld: {} as any,
    reset: () => {}, dispose: () => {},
  } as any;
}

function mockLlm(steps: Array<{ toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string }>): LlmFn {
  let i = 0;
  return {
    // 签名：complete(messages, opts)——tools 在第二参
    complete: vi.fn(async (_messages: unknown, opts?: { tools?: Array<{ name: string }> }) => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return {
        content: step.content ?? "",
        model: "mock",
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(step.toolCalls ? { toolCalls: step.toolCalls.map((tc, idx) => ({ id: `c${i}_${idx}`, name: tc.name, arguments: tc.arguments })) } : {}),
        ...(opts?.tools ? { offeredTools: opts.tools.map((t) => t.name) } : {}),
      };
    }),
  } as LlmFn;
}

const CAPS = { memory: {} } as Record<string, unknown>;

describe("ASP 状态机（asp:true——空间门控）", () => {
  it("元空间初始：语言工具不在工具面（只有 asp_cd + done）", async () => {
    const llm = mockLlm([{ toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] }]);
    await runAgentTask({ llm, kernel: mockKernel(), caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 3 });
    const firstCall = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { tools: Array<{ name: string }> };
    expect(firstCall.tools.map((t) => t.name).sort()).toEqual(["asp_cd", "asp_create", "asp_destroy", "asp_index", "cache_cancel", "cache_index", "cache_load", "done", "memory_index"]);
  });

  it("元空间直调 ts → 门控引导（不执行）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "ts.run", arguments: { code: "return 1" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 5 });
    expect(kernel.ts.execute).not.toHaveBeenCalled();   // 未执行——被门控
    expect(r.ok).toBe(true);
  });

  it("cd ts → ts 可执行；cd meta → done 可提交（完整导航循环）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "ts" } }] },
      { toolCalls: [{ name: "ts.run", arguments: { code: "return 42" } }] },
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { v: 42 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 8 });
    expect(kernel.ts.execute).toHaveBeenCalledWith("return 42", expect.objectContaining({ exec: "program" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ v: 42 });
  });

  it("cd 后工具面切换（ts 空间提供 asp_cd + ts.run/ts.eval）", async () => {
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "python" } }] },
      { toolCalls: [{ name: "done", arguments: { result: {} } }] },   // done 在 python 空间被门控
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    await runAgentTask({ llm, kernel: mockKernel(), caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 8 });
    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallTools = (calls[1]![1] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(secondCallTools.sort()).toEqual(["asp_cd", "asp_create", "asp_destroy", "asp_index", "cache_cancel", "cache_index", "cache_load", "memory_index", "python_eval", "python_run"]);
  });

  it("cd 未知空间 → 报错引导（不迁移）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "narnia" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },   // 仍在 meta——done 可用
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 5 });
    expect(r.ok).toBe(true);
  });

  it("ASP 关闭（默认）：旧行为不变（ts/done 直接可用）", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "ts.run", arguments: { code: "return 1" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, maxSteps: 5 });
    expect(kernel.ts.execute).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});

describe("asp.index（空间索引——双聚合模式）", () => {
  function kernelWithSnap() {
    return {
      ts: {
        execute: vi.fn(async () => ({ ok: true, value: 1, durationMs: 1 })),
        registerResult: vi.fn(),
        snapshot: async () => ({ variables: [{ key: "total", value: 42, serializable: true }], functions: [{ key: "helper", source: "function helper(){}" }], oversized: [] }),
      },
      python: { execute: async () => ({ ok: true }), snapshot: async () => ({ variables: [{ key: "py_var", value: 1, serializable: true }], functions: [], oversized: [] }) },
      bash: { execute: async () => ({ ok: true }), snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
      llm: { complete: async () => ({ content: "" }) },
      dataWorld: {} as any, reset: () => {}, dispose: () => {},
    } as any;
  }
  const capsWith = { memory: { query: async () => [], write: async () => {} }, llm: { complete: async () => ({}) }, fs: { readText: async () => "" }, state: {} } as Record<string, unknown>;

  it("无参默认当前空间（meta → 空间清单）", async () => {
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_index", arguments: {} }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const traces: string[] = [];
    await runAgentTask({ llm, kernel: kernelWithSnap(), caps: capsWith, task: { title: "t", text: "x" }, asp: true, maxSteps: 5,
      onTrace: (e) => { if (e.type === "tool-result") traces.push(e.resultPreview); } });
    expect(traces[0]).toContain("元空间");
  });

  it("ts 空间 by-package：扩展包展开（memory/llm/fs 各包能力键）", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ mode: "by-package" }, { currentSpace: "ts", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("memory: query/write");
    expect(out).toContain("llm: complete");
    expect(out).toContain("【ts 空间 · 按扩展包】");
  });

  it("ts 空间 by-type：变量/函数快照", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ mode: "by-type", space: "ts" }, { currentSpace: "meta", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("total");
    expect(out).toContain("helper");
    expect(out).toContain("变量(1)");
  });

  it("python 空间：snapshot 分区视图", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ space: "python" }, { currentSpace: "meta", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("py_var");
    expect(out).toContain("python 空间");
  });

  it("指定未知空间 → 错误提示含已注册清单", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const out = await buildSpaceIndex({ space: "narnia" }, { currentSpace: "meta", kernel: kernelWithSnap(), caps: capsWith });
    expect(out).toContain("未知空间");
    expect(out).toContain("ts");
  });

  it("输出体积纪律：单层 ≤ ~2KB", async () => {
    const { buildSpaceIndex } = await import("../../src/pth/kernel/execution/space-index.js");
    const bigCaps: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) bigCaps[`pkg_${i}`] = Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`fn_${j}`, () => {}]));
    const out = await buildSpaceIndex({ mode: "by-package" }, { currentSpace: "ts", kernel: kernelWithSnap(), caps: bigCaps });
    expect(out.length).toBeLessThanOrEqual(2100);   // MAX_LAYER_CHARS + 截断标注余量
    expect(out).toContain("截断");
  });
});

describe("ASP 门控归一化（e2e 实测发现——点形工具名绕过）", () => {
  it("点形工具名（python.execute）同样被门控", async () => {
    expect(spaceRegistry.spaceOfExecTool("python.run")).toBe("python");
    expect(spaceRegistry.spaceOfExecTool("python_run")).toBe("python");
    expect(spaceRegistry.spaceOfExecTool("bash.run")).toBe("bash");
  });

  it("ts 空间内点形调用 python.execute → 门控引导不执行", async () => {
    const kernel = mockKernel();
    const pySpy = vi.spyOn(kernel.python, "execute");
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "ts" } }] },
      { toolCalls: [{ name: "python.run", arguments: { code: "print(1)" } }] },   // 点形——e2e 实测模型会这样输出
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 8 });
    expect(pySpy).not.toHaveBeenCalled();
  });
});

describe("asp.create / asp.destroy（空间生成/注销——治理 v2）", () => {
  it("dev 空间内 create 子空间（childParams 表单）→ cd 可进入 → 回 meta destroy（兜底）注销后不可进入", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      // 迁移到 dev 生产空间（allowChildren=true 的唯一内置空间）
      { toolCalls: [{ name: "asp_cd", arguments: { space: "dev" } }] },
      // dev 内创建隔离子空间（childParams 必填表单：execTool/memoryScope/description）
      { toolCalls: [{ name: "asp_create", arguments: { id: "matlab", execTool: "matlab_exec", memoryScope: "dev-sandbox", description: "MATLAB 风格隔离计算子空间" } }] },
      // cd 进入自定义子空间
      { toolCalls: [{ name: "asp_cd", arguments: { space: "matlab" } }] },
      // 回 meta destroy（meta 兜底注销任何非内置）
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "asp_destroy", arguments: { id: "matlab" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 12 });
    expect(r.ok).toBe(true);
    expect(spaceRegistry.get("matlab")).toBeUndefined();   // 注销后不残留
  });

  it("meta 禁建子空间 → 拒绝；childParams 缺必填 → 拒绝；destroy 内置空间 → 拒绝", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      // 元空间直接 create → 禁建拒绝
      { toolCalls: [{ name: "asp_create", arguments: { id: "x1", execTool: "x_exec", description: "在 meta 建" } }] },
      // dev 内 create 缺 childParams 必填（memoryScope）→ 表单拒绝
      { toolCalls: [{ name: "asp_cd", arguments: { space: "dev" } }] },
      { toolCalls: [{ name: "asp_create", arguments: { id: "x2", execTool: "python", description: "缺 memoryScope" } }] },
      // destroy 内置空间（dev 内——父空间领地对内置无效）
      { toolCalls: [{ name: "asp_destroy", arguments: { id: "ts" } }] },   // 内置空间保护
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 8 });
    expect(r.ok).toBe(true);
    expect(spaceRegistry.get("ts")).toBeDefined();   // 内置未删
    expect(spaceRegistry.get("x1")).toBeUndefined();   // meta 禁建未注册
    expect(spaceRegistry.get("x2")).toBeUndefined();   // 缺表单未注册
    // 拒绝消息回填给了 LLM（工具结果含拒绝文案）
    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const allTool = calls.slice(1).flatMap((c) => (c[0] as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => m.content)).join("\n");
    expect(allTool).toContain("meta 空间禁建子空间");
    expect(allTool).toContain("缺必填参量");
    expect(allTool).toMatch(/仅子空间的父空间|不可注销/);   // destroy 内置：位置约束或 builtin 保护任一拦截
  });
});

describe("审计修复（2026-08-12）", () => {
  it("注册幂等完整比较：extraTools 变化报冲突；相同定义幂等通过", () => {
    expect(() => spaceRegistry.register({ id: "dev", kind: "action", execTool: "dev", parent: "meta", skeleton: "不同 skeleton", description: "x", builtin: true })).toThrow(/注册冲突/);
    // 与现有完全一致 → 幂等通过
    const existing = spaceRegistry.get("dev")!;
    expect(() => spaceRegistry.register(existing)).not.toThrow();
  });
});


// ── N8 空间-角色绑定（2026-08-14——生成即绑定：注册事实 + 进入校验）────────────────
import { isRoleBoundToSpace } from "../../src/pth/kernel/execution/space-registry.js";

describe("space-registry 绑定（N8——注册事实）", () => {
  afterEach(() => {
    for (const s of spaceRegistry.list()) {
      if (!s.builtin) { try { spaceRegistry.unregister(s.id); } catch { /* 父空间先于子空间清理——容忍 */ } }
    }
  });

  it("bindRoles 格式校验：空数组/非法 id/重复 → 拒绝", () => {
    expect(() => spaceRegistry.register({ id: "n8-empty", kind: "action", execTool: "ts", description: "x", bindRoles: [] })).toThrow(/非空数组/);
    expect(() => spaceRegistry.register({ id: "n8-bad", kind: "action", execTool: "ts", description: "x", bindRoles: ["Bad Role!"] })).toThrow(/绑定非法/);
    expect(() => spaceRegistry.register({ id: "n8-dup", kind: "action", execTool: "ts", description: "x", bindRoles: ["developer", "developer"] })).toThrow(/绑定重复/);
  });

  it("绑定参与幂等冲突比较（第 10 字段——绑定可变 → 冲突报错）", () => {
    spaceRegistry.register({ id: "n8-c1", kind: "action", execTool: "ts", description: "x", bindRoles: ["developer"] });
    spaceRegistry.register({ id: "n8-c1", kind: "action", execTool: "ts", description: "x", bindRoles: ["developer"] });   // 同绑定幂等
    expect(() => spaceRegistry.register({ id: "n8-c1", kind: "action", execTool: "ts", description: "x", bindRoles: ["analyst"] })).toThrow(/注册冲突/);
  });

  it("isRoleBoundToSpace：基板放行；直接/祖先命中；非绑定拒绝；无角色上下文放行", () => {
    const substrate = spaceRegistry.get("ts")!;   // 语言执行基板——无绑定
    expect(isRoleBoundToSpace(substrate, { id: "anyone" })).toBe(true);
    const bound = { id: "n8-s1", kind: "action" as const, execTool: "ts", description: "x", bindRoles: ["developer"] };
    const roles = [
      { id: "origin" },
      { id: "developer", parent: "origin" },
      { id: "scout", parent: "developer" },
      { id: "analyst", parent: "origin" },
    ];
    expect(isRoleBoundToSpace(bound, { id: "developer", parent: "origin" }, roles)).toBe(true);   // 直接命中
    expect(isRoleBoundToSpace(bound, { id: "scout", parent: "developer" }, roles)).toBe(true);    // 祖先命中（谱系上溯）
    expect(isRoleBoundToSpace(bound, { id: "analyst", parent: "origin" }, roles)).toBe(false);    // 非绑定类型
    expect(isRoleBoundToSpace(bound, { id: "origin" }, roles)).toBe(false);                       // 绑定集的父类型不匹配
    expect(isRoleBoundToSpace(bound, undefined)).toBe(true);                                      // 无角色上下文放行（兼容）
    // 绑祖先：origin 绑定时 developer/scout/analyst 均可进
    const byRoot = { ...bound, bindRoles: ["origin"] };
    expect(isRoleBoundToSpace(byRoot, { id: "developer", parent: "origin" }, roles)).toBe(true);
    expect(isRoleBoundToSpace(byRoot, { id: "analyst", parent: "origin" }, roles)).toBe(true);
  });
});

describe("ASP 状态机——N8 绑定进入校验（asp.cd）", () => {
  afterEach(() => {
    for (const s of spaceRegistry.list()) {
      if (!s.builtin) { try { spaceRegistry.unregister(s.id); } catch { /* 容忍 */ } }
    }
  });

  it("绑定空间拒绝非绑定角色进入（ts 未执行）；绑定角色放行", async () => {
    spaceRegistry.register({ id: "n8-private", kind: "action", execTool: "ts", parent: "meta", description: "developer 专属", bindRoles: ["developer"] });
    // ① 非绑定角色 analyst：cd 被拒（仍在 meta）→ ts 被空间门控 → done 完成
    const kernel1 = mockKernel();
    const llm1 = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "n8-private" } }] },
      { toolCalls: [{ name: "ts.run", arguments: { code: "return 1" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r1 = await runAgentTask({
      llm: llm1, kernel: kernel1, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 6,
      role: { id: "analyst", parent: "origin", tags: [], prompt: "a" },
    });
    expect(r1.ok).toBe(true);
    expect(kernel1.ts.execute).not.toHaveBeenCalled();   // 未进入空间——ts 未执行
    // ② 绑定角色 developer：cd 放行 → ts 执行 → 回 meta done
    const kernel2 = mockKernel();
    const llm2 = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "n8-private" } }] },
      { toolCalls: [{ name: "ts.run", arguments: { code: "return 42" } }] },
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { v: 42 } } }] },
    ]);
    const r2 = await runAgentTask({
      llm: llm2, kernel: kernel2, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 8,
      role: { id: "developer", parent: "origin", tags: [], prompt: "d" },
    });
    expect(r2.ok).toBe(true);
    expect(kernel2.ts.execute).toHaveBeenCalledWith("return 42", expect.objectContaining({ exec: "program" }));
  });

  it("基板（无绑定）进入不受影响——全角色共享", async () => {
    const kernel = mockKernel();
    const llm = mockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "bash" } }] },
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({
      llm, kernel, caps: CAPS, task: { title: "t", text: "x" }, asp: true, maxSteps: 6,
      role: { id: "analyst", parent: "origin", tags: [], prompt: "a" },
    });
    expect(r.ok).toBe(true);
  });
});
