import { describe, it, expect, vi } from "vitest";
import { AGENT_TOOLS, AGENT_TOOLS_DESCRIPTION } from "../../src/pth/kernel/execution/agent-tools.js";
import type { AgentToolCtx } from "../../src/pth/kernel/execution/agent-tools.js";
import type { WorkerKernel } from "../../src/pth/kernel/interpreter/index.js";

/**
 * 输出模式（③）：LLM 控制感知带宽——mode 枚举裁剪回填。
 */

function ctx(pythonResult: any, bashResult: any): AgentToolCtx {
  return {
    kernel: {
      python: { execute: vi.fn(async () => pythonResult) } as any,
      bash: { execute: vi.fn(async () => bashResult) } as any,
      ts: { execute: vi.fn(async () => ({ ok: true, value: { sum: 5050 }, stdout: "line1\nline2" })) } as any,
    } as WorkerKernel,
    caps: {},
  };
}

describe("输出模式（mode 枚举）", () => {
  it("default：完整回填（value + stdout）", async () => {
    const r = await AGENT_TOOLS["python.execute"](ctx({ ok: true, value: 5050 }), { code: "x", mode: "default" });
    expect(r.stdout).toContain("5050");
  });

  it("value-only：只回 value（stderr 清空）", async () => {
    const r = await AGENT_TOOLS["python.execute"](ctx({ ok: true, value: 42 }), { code: "x", mode: "value-only" });
    expect(r.value).toBe(42);
    expect(r.stdout).toContain("42");
    expect(r.stderr).toBe("");
  });

  it("errors-only：成功只回 ok（value 不占上下文）", async () => {
    const r = await AGENT_TOOLS["bash.execute"](ctx(null, { ok: true, stdout: "超长输出".repeat(100) }), { command: "x", mode: "errors-only" });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("ok");
    expect(r.value).toBeUndefined();
  });

  it("errors-only：失败回完整错误（修正必需）", async () => {
    const r = await AGENT_TOOLS["bash.execute"](ctx(null, { ok: false, stderr: "bash: x: command not found" }), { command: "x", mode: "errors-only" });
    expect(r.ok).toBe(false);
    expect(r.error ?? r.stderr).toContain("command not found");
  });

  it("quiet：静默（ok 保留，无输出/无 value）", async () => {
    const r = await AGENT_TOOLS["ts"](ctx(null, null), { code: "return 1", mode: "quiet" });
    expect(r.ok).toBe(true);
    expect(r.quiet).toBe(true);
    expect(r.stdout).toBe("");
    expect(r.value).toBeUndefined();
  });

  it("未知模式按 default", async () => {
    const r = await AGENT_TOOLS["python.execute"](ctx({ ok: true, value: 7 }), { code: "x", mode: "bogus" });
    expect(r.stdout).toContain("7");
  });

  it("工具描述包含 mode 文档", () => {
    expect(AGENT_TOOLS_DESCRIPTION).toContain("mode");
    expect(AGENT_TOOLS_DESCRIPTION).toContain("errors-only");
    expect(AGENT_TOOLS_DESCRIPTION).toContain("quiet");
  });
});
