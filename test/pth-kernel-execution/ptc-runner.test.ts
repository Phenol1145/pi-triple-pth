import { describe, it, expect, vi } from "vitest";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { buildCapabilityIndexDoc, renderCapabilityLine } from "@away_from/pth-kernel-interpreter";
import { PTC_CAPABILITIES } from "@away_from/pth-kernel-interpreter";

function mockTs(impl?: (code: string, opts: any) => Promise<any>) {
  return {
    execute: vi.fn(impl ?? (async () => ({ ok: true, value: { a: 1 }, stdout: "x", durationMs: 1, language: "ts" }))),
    registerResult: vi.fn(),
    state: {},
    injectCapability: vi.fn(),
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

describe("PTC Phase 3——能力面装配 + 越界预检（ptc/runner）", () => {
  it("caps 注入先于执行（装配→预检→执行顺序）", async () => {
    const ts = mockTs();
    const cacheObj = { get: vi.fn() };
    await runPtcProgram({ code: "const a = 1;", ts, caps: { cache: cacheObj } });
    expect(ts.injectCapability).toHaveBeenCalledWith("cache", cacheObj);
    expect(ts.execute).toHaveBeenCalled();
  });

  it("越界根 → 编译前拒绝（execute 未调用）+ 引导消息", async () => {
    const ts = mockTs();
    const { raw } = await runPtcProgram({ code: "await foo.bar()", ts });
    expect(raw.ok).toBe(false);
    expect(raw.error?.code).toBe("capability-out-of-bounds");
    expect(raw.error?.message).toContain('"foo"');
    expect(raw.error?.message).toContain("能力面越界");
    expect(raw.error?.message).toContain("memory");
    expect(ts.execute).not.toHaveBeenCalled();
  });

  it("注入面内的能力根 → 放行（state 键为基准）", async () => {
    const ts = mockTs();
    ts.state = { memory: { query: vi.fn() }, results: {}, context: {} };
    const { raw } = await runPtcProgram({ code: 'const r = await memory.query("SELECT 1"); results.result_1 = r;', ts });
    expect(raw.ok).toBe(true);
  });

  it("拼写错误能力 → 引导（memeory 场景——LLM 高频失误）", async () => {
    const ts = mockTs();
    ts.state = { memory: {} };
    const { raw } = await runPtcProgram({ code: 'await memeory.query("x")', ts });
    expect(raw.ok).toBe(false);
    expect(raw.error?.message).toContain('"memeory"');
    expect(ts.execute).not.toHaveBeenCalled();
  });

  it("skipSurfaceCheck 关闭预检", async () => {
    const ts = mockTs();
    await runPtcProgram({ code: "await foo.bar()", ts, skipSurfaceCheck: true });
    expect(ts.execute).toHaveBeenCalled();
  });

  it("越界拒绝同样走结果注册（工具结果注册不变量）", async () => {
    const ts = mockTs();
    const { raw } = await runPtcProgram({
      code: "await foo.bar()", ts,
      registerResult: { key: "result_1", build: (r) => ({ tool: "x", ok: r.ok, code: r.error?.code }) },
    });
    expect(raw.ok).toBe(false);
    expect(ts.registerResult).toHaveBeenCalledWith("result_1", { tool: "x", ok: false, code: "capability-out-of-bounds" });
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

