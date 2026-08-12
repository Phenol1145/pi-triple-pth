import { describe, it, expect } from "vitest";
import { spaceRegistry } from "../../src/pth/kernel/execution/space-registry.js";
import { buildSpaceIndex } from "../../src/pth/kernel/execution/space-index.js";
import { PyKernel } from "../../src/pth/kernel/interpreter/py-kernel.js";
import { BashKernel } from "../../src/pth/kernel/interpreter/bash-kernel.js";

/**
 * 空间治理 v2（2026-08-12 用户裁决批 3）：
 *   - SpaceDef 声明 allowChildren/maxDepth/childParams/memoryScope
 *   - meta 禁建子空间（凭据根级固化）；asp.create 在父空间内按表单校验
 *   - 深度衰减（子空间深度 ≤ 父 maxDepth）；extraTools 只能收窄不能扩权
 *   - asp.index 索引即引导（空间树 + 表单展示）
 *   - 记忆桥盖章：kernel 层注入当前空间（python _PTH_SPACE / bash PTH_MEMORY_SPACE）
 */

describe("空间治理 v2（批 3）——SpaceDef 声明", () => {
  it("dev 声明 allowChildren + maxDepth + childParams 表单；meta 恒不可建", () => {
    const dev = spaceRegistry.get("dev")!;
    expect(dev.allowChildren).toBe(true);
    expect(dev.maxDepth).toBe(2);
    expect(dev.childParams?.map((p) => p.name)).toEqual(["execTool", "memoryScope", "extraTools", "description"]);
    expect(dev.childParams?.filter((p) => p.required).map((p) => p.name)).toEqual(["execTool", "memoryScope", "description"]);
    // 其余内置空间不声明 allowChildren（缺省 false）
    for (const id of ["meta", "ts", "python", "bash", "write"]) {
      expect(spaceRegistry.get(id)?.allowChildren).not.toBe(true);
    }
  });

  it("深度计算（meta=0 / 内置=0·parent=meta；子空间=1）", () => {
    expect(spaceRegistry.depthOf("meta")).toBe(0);
    expect(spaceRegistry.depthOf("dev")).toBe(0);   // parent=meta 不算深度
    spaceRegistry.register({ id: "gv-depth", kind: "action", execTool: "depth_exec", parent: "dev", description: "t" });
    expect(spaceRegistry.depthOf("gv-depth")).toBe(1);
    spaceRegistry.register({ id: "gv-depth2", kind: "action", execTool: "depth2_exec", parent: "gv-depth", description: "t" });
    expect(spaceRegistry.depthOf("gv-depth2")).toBe(2);
    expect(spaceRegistry.childrenOf("dev").map((s) => s.id)).toContain("gv-depth");
    spaceRegistry.unregister("gv-depth2");
    spaceRegistry.unregister("gv-depth");
  });

  it("unregister 拒绝有子空间的目标（2026-08-12 审计 BUG-4——防孤儿子空间断 parent 链）", () => {
    spaceRegistry.register({ id: "gv-orphan-p", kind: "action", execTool: "bash", parent: "dev", description: "t" });
    spaceRegistry.register({ id: "gv-orphan-c", kind: "action", execTool: "bash", parent: "gv-orphan-p", description: "c" });
    expect(() => spaceRegistry.unregister("gv-orphan-p")).toThrow(/先注销后代/);
    expect(spaceRegistry.get("gv-orphan-p")).toBeDefined();   // 未被删
    spaceRegistry.unregister("gv-orphan-c");
    spaceRegistry.unregister("gv-orphan-p");   // 后代清完后可注销
    expect(spaceRegistry.get("gv-orphan-p")).toBeUndefined();
  });

  it("注册幂等比较含治理字段（allowChildren 变化报冲突）", () => {
    expect(() => spaceRegistry.register({ id: "dev", kind: "action", execTool: "dev", parent: "meta", allowChildren: false, description: "x", builtin: true })).toThrow(/注册冲突/);
  });
});

describe("空间治理 v2——asp.index 索引即引导", () => {
  it("meta 空间树含治理标注（可建子空间/表单/记忆域）", async () => {
    const out = await buildSpaceIndex({}, { currentSpace: "meta", kernel: {} as never, caps: {} });
    expect(out).toContain("空间树");
    expect(out).toContain("meta 禁建");
    expect(out).toContain("可建子空间(maxDepth=2)");
    expect(out).toContain("表单: execTool* memoryScope* extraTools description*");
  });

  it("生产空间/自定义子空间索引：工具族视图 + 治理信息（不再'暂无索引构造器'）", async () => {
    const dev = await buildSpaceIndex({}, { currentSpace: "dev", kernel: {} as never, caps: {} });
    expect(dev).toContain("dev 空间 · 工具族");
    expect(dev).toContain("dev.*");
    expect(dev).toContain("debug.*");
    expect(dev).toContain("可建子空间");
    // 自定义子空间注册后同样有构造器
    spaceRegistry.register({ id: "gv-idx", kind: "action", execTool: "gv_exec", parent: "dev", memoryScope: "dev-sandbox", description: "t" });
    const sub = await buildSpaceIndex({}, { currentSpace: "gv-idx", kernel: {} as never, caps: {} });
    expect(sub).toContain("gv-idx 空间 · 工具族");
    expect(sub).toContain("记忆域: dev-sandbox");
    spaceRegistry.unregister("gv-idx");
  });
});

describe("空间治理 v2——记忆桥盖章（kernel 层注入当前空间）", () => {
  it("PyKernel execute 带 space → 用户代码环境 _PTH_SPACE 生效（记忆库读取通道）", async () => {
    const k = new PyKernel({ pythonBin: "python3", timeoutMs: 10_000 });
    try {
      const r1 = await k.execute("print('stamp=' + str(globals().get('_PTH_SPACE', '(none)')))", { space: "dev" });
      expect(r1.ok).toBe(true);
      expect(r1.stdout).toContain("stamp=dev");
      // 无 space → 协议级清章（2026-08-12 审计 ROBUST-2 修复——防 REPL 跨任务残留）
      const r2 = await k.execute("print('stamp2=' + str(globals().get('_PTH_SPACE', '(none)')))");
      expect(r2.ok).toBe(true);
      expect(r2.stdout).toContain("stamp2=");
      // single 模式 + space 不再炸（2026-08-12 审计 BUG-1：前缀注入在 eval 单表达式必 SyntaxError）
      const r3 = await k.execute("1 + 1", { exec: "single", space: "dev" });
      expect(r3.ok).toBe(true);
      expect(r3.value).toBe(2);
      // single 模式的盖章由 PY_RUNTIME 统一设置（eval 前 exec——协议级）——单表达式直接求值验证
      const r4 = await k.execute("globals().get('_PTH_SPACE', '(none)')", { exec: "single", space: "python" });
      expect(r4.ok).toBe(true);
      expect(r4.value).toBe("python");
    } finally {
      k.dispose();
    }
  });

  it("BashKernel execute 带 space → PTH_MEMORY_SPACE 生效", async () => {
    const k = new BashKernel({ timeoutMs: 10_000, lazySpawn: true });
    try {
      const r1 = await k.execute("echo stamp=$PTH_MEMORY_SPACE", { space: "python" });
      expect(r1.ok).toBe(true);
      expect(r1.stdout).toContain("stamp=python");
      // 无 space → 空
      const r2 = await k.execute("echo stamp2=$PTH_MEMORY_SPACE");
      expect(r2.ok).toBe(true);
      expect(r2.stdout).toContain("stamp2=");
    } finally {
      k.dispose();
    }
  });
});

// ── agent-loop 级治理校验（asp.create 深度/收窄——复用 asp-space 的 mock 模式）────────────────
import { runAgentTask } from "../../src/pth/kernel/execution/agent-loop.js";
import { vi } from "vitest";
import type { LlmFn } from "../../src/pth/kernel/interpreter/llm-fn.js";

function govMockKernel() {
  return {
    ts: { execute: vi.fn(async (code: string) => ({ ok: true, value: `exec:${code.slice(0, 20)}`, durationMs: 1 })), registerResult: vi.fn() },
    bash: { execute: async () => ({ ok: true, stdout: "ok" }) },
    python: { execute: async () => ({ ok: true, value: 1, stdout: "1" }) },
    llm: { complete: async () => ({ content: "" }) },
    dataWorld: {} as never,
    reset: () => {}, dispose: () => {},
  } as never;
}
function govMockLlm(steps: Array<{ toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string }>): LlmFn {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return {
        content: step.content ?? "", model: "mock", usage: { inputTokens: 1, outputTokens: 1 },
        ...(step.toolCalls ? { toolCalls: step.toolCalls.map((tc, idx) => ({ id: `c${i}_${idx}`, name: tc.name, arguments: tc.arguments })) } : {}),
      };
    }),
  } as never;
}

describe("空间治理 v2——asp.create 深度衰减与工具族收窄（agent-loop 校验）", () => {
  it("maxDepth 超限拒绝（dev 子空间内再建孙空间）", async () => {
    // 准备：dev 直属子空间 sandbox-a（深度1）；再在 sandbox-a 内创建（深度2 > sandbox-a 继承 maxDepth=2?——见下）
    // 模拟由 dev 的 asp.create 生成的子空间（治理字段继承：allowChildren + maxDepth=2）
    spaceRegistry.register({ id: "gv-sandbox-a", kind: "action", execTool: "sb_exec", parent: "dev", allowChildren: true, maxDepth: 2, description: "t" });
    try {
      const llm = govMockLlm([
        { toolCalls: [{ name: "asp_cd", arguments: { space: "gv-sandbox-a" } }] },
        // 子空间未声明 maxDepth → 继承父（dev maxDepth=2）——创建孙空间深度2 ≤2 应通过？
        // 校验语义：childDepth=depthOf(parent)+1；parent=gv-sandbox-a depth=1 → childDepth=2 ≤ parent.maxDepth
        // parent 无 maxDepth → 继承父链 dev 的 2 → 2≤2 通过（先建 gv-grand 再验证三层拒绝）
        { toolCalls: [{ name: "asp_create", arguments: { id: "gv-grand", execTool: "bash", memoryScope: "m", description: "孙" } }] },
        // 三层：gv-grand（depth=2）内创建 → childDepth=3 > maxDepth=2 → 拒绝
        { toolCalls: [{ name: "asp_cd", arguments: { space: "gv-grand" } }] },
        { toolCalls: [{ name: "asp_create", arguments: { id: "gv-great", execTool: "bash", memoryScope: "m", description: "曾孙" } }] },
        { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
        { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
      ]);
      const r = await runAgentTask({ llm, kernel: govMockKernel(), caps: {}, task: { title: "t", text: "x" }, asp: true, maxSteps: 10 });
      expect(r.ok).toBe(true);
      expect(spaceRegistry.get("gv-grand")).toBeDefined();
      expect(spaceRegistry.get("gv-great")).toBeUndefined();   // 深度超限未注册
      const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
      const allTool = calls.slice(1).flatMap((c) => (c[0] as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => m.content)).join("\n");
      expect(allTool).toContain("超过父空间 maxDepth");
    } finally {
      spaceRegistry.unregister("gv-great");
      spaceRegistry.unregister("gv-grand");
      spaceRegistry.unregister("gv-sandbox-a");
    }
  });

  it("extraTools 只能收窄不能扩权（dev 子空间挂非 debug 族拒绝）", async () => {
    const llm = govMockLlm([
      { toolCalls: [{ name: "asp_cd", arguments: { space: "dev" } }] },
      // extraTools=write 不是 dev 的工具族 → 拒绝
      { toolCalls: [{ name: "asp_create", arguments: { id: "gv-x", execTool: "python", memoryScope: "m", extraTools: "write", description: "扩权" } }] },
      // extraTools=debug（收窄——父有）→ 通过
      { toolCalls: [{ name: "asp_create", arguments: { id: "gv-y", execTool: "python", memoryScope: "m", extraTools: "debug", description: "收窄" } }] },
      { toolCalls: [{ name: "asp_cd", arguments: { space: "meta" } }] },
      { toolCalls: [{ name: "done", arguments: { result: { ok: 1 } } }] },
    ]);
    const r = await runAgentTask({ llm, kernel: govMockKernel(), caps: {}, task: { title: "t", text: "x" }, asp: true, maxSteps: 10 });
    expect(r.ok).toBe(true);
    expect(spaceRegistry.get("gv-x")).toBeUndefined();
    expect(spaceRegistry.get("gv-y")?.extraTools).toEqual(["debug"]);
    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const allTool = calls.slice(1).flatMap((c) => (c[0] as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => m.content)).join("\n");
    expect(allTool).toContain("只能收窄不能扩权");
    spaceRegistry.unregister("gv-y");
  });
});
