import { describe, it, expect, vi } from "vitest";
import { runPtcProgram } from "../../src/pth/kernel/ptc/runner";
import { buildCapabilityIndexDoc, renderCapabilityLine } from "../../src/pth/kernel/ptc/docs";
import { PTC_CAPABILITIES } from "../../src/pth/kernel/ptc/contract";

function mockTs(impl?: (code: string, opts: any) => Promise<any>) {
  return {
    execute: vi.fn(impl ?? (async () => ({ ok: true, value: { a: 1 }, stdout: "x", durationMs: 1, language: "ts" }))),
    registerResult: vi.fn(),
  };
}

describe("PTC 统一执行缝（A1 Phase 2——ptc/runner）", () => {
  it("program 组装 golden：stdout + 「返回值:」前缀 + 4000 截断", async () => {
    const ts = mockTs();
    const { raw, assembled } = await runPtcProgram({ code: "const a=1;", exec: "program", ts });
    expect(raw.ok).toBe(true);
    expect(assembled.stdout).toBe('x\n返回值: {"a":1}');
    expect(ts.execute).toHaveBeenCalledWith("const a=1;", { cwd: "/tmp", exec: "program" });
  });

  it("single 组装：「结果:」前缀 + 2000 上限", async () => {
    const ts = mockTs();
    const { assembled } = await runPtcProgram({ code: "1+1", exec: "single", ts });
    expect(assembled.stdout).toBe('x\n结果: {"a":1}');
  });

  it("value 为 null 时不输出前缀（与原组装一致）", async () => {
    const ts = mockTs(async () => ({ ok: true, value: null, stdout: "y", durationMs: 1 }));
    const { assembled } = await runPtcProgram({ code: "c", exec: "program", ts });
    expect(assembled.stdout).toBe("y");
  });

  it("缺省 cwd=/tmp；exec 缺省不传（旧降级路径 auto 语义）", async () => {
    const ts = mockTs();
    await runPtcProgram({ code: "c", ts });
    expect(ts.execute).toHaveBeenCalledWith("c", { cwd: "/tmp" });
  });

  it("registerResult 钩子：成功/失败都注册（build 收 raw）", async () => {
    const ts = mockTs(async () => ({ ok: false, error: { message: "boom" }, durationMs: 1 }));
    await runPtcProgram({
      code: "c", ts,
      registerResult: { key: "result_1", build: (r) => ({ tool: "x", ok: r.ok, error: r.ok ? undefined : r.error?.message }) },
    });
    expect(ts.registerResult).toHaveBeenCalledWith("result_1", { tool: "x", ok: false, error: "boom" });
  });
});

describe("能力索引文档生成器（Phase 2 条目 8）", () => {
  it("覆盖全部注册表条目且三要素齐全", () => {
    const doc = buildCapabilityIndexDoc();
    for (const name of Object.keys(PTC_CAPABILITIES)) {
      expect(doc).toContain(name);
    }
    expect(doc).toContain("【场景锚点】");
    expect(doc).toContain("何时用：");
    expect(doc).toContain("效果：");
    expect(doc).toContain("## memory");
    expect(doc).toContain("## 执行核");
  });

  it("单条目渲染含签名与三要素", () => {
    const line = renderCapabilityLine(PTC_CAPABILITIES["memory.query"]!);
    expect(line).toContain("memory.query(sql: string)");
    expect(line).toContain("【场景锚点】记忆库只读 SQL");
    expect(line).toContain("何时用：查条目");
    expect(line).toContain("效果：行数组");
  });

  it("核契约条目带 dispose 制动点标注", () => {
    const line = renderCapabilityLine(PTC_CAPABILITIES["bash"]!);
    expect(line).toContain("InterpreterResult");
    expect(line).toContain("dispose 终止语义");
  });
});

