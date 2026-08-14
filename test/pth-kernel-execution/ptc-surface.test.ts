import { describe, it, expect } from "vitest";
import { findOutOfBoundsRoots, buildSurfaceGuidance, capabilityRoots } from "../../src/pth/kernel/ptc/surface";

const KNOWN = new Set(["memory", "llm", "web", "fs", "env", "state", "cache", "skills", "bash", "python", "results", "context"]);

describe("能力面越界预检（A1 Phase 3 条目 9——ptc/surface）", () => {
  it("未知能力根 → 越界（拼写错误/未注入/幻视）", () => {
    expect(findOutOfBoundsRoots('const r = await memeory.query("x")', KNOWN)).toEqual(["memeory"]);
    expect(findOutOfBoundsRoots("await foo.bar()", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("foo()", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("obj?.a?.b", KNOWN)).toEqual(["obj"]);
    expect(findOutOfBoundsRoots("obj[0]", KNOWN)).toEqual(["obj"]);
    expect(findOutOfBoundsRoots("obj['key']", KNOWN)).toEqual(["obj"]);
  });

  it("已知能力根 → 放行（注入面键集合为基准）", () => {
    expect(findOutOfBoundsRoots('const r = await memory.query("SELECT 1")', KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("results.result_1.value", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("context.my_key = 1", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("await llm.complete([])", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("python.execute('x = 1')", KNOWN)).toEqual([]);
  });

  it("字符串/注释/正则字面量不参与判定", () => {
    expect(findOutOfBoundsRoots('const s = "foo.bar() text"; s;', KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("// foo.bar()\nconst x = 1;", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("/* foo.bar() */ const x = 1;", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("const re = /http:\/\/x/; re.test(u)", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("const str = ''; str.split(/[\n;]/)", KNOWN)).toEqual([]);
  });

  it("声明/形参/解构/内建 → 安全名（合法程序零误杀）", () => {
    expect(findOutOfBoundsRoots("const foo = {}; foo.bar()", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("const items = [{id: 1}]; items.map(x => x.id)", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("function f(a) { return a.length } f(1)", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots('const { rows } = await memory.query("SELECT 1"); rows.map(r => r.id)', KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("JSON.stringify(await memory.query('x'))", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("Math.max(1,2)", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("new Map()", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("Array.from(items)", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("console.log(1)", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("await new Promise((resolve) => resolve(1))", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("for (const i of arr) { console.log(i) }", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("const arr = [1, 2, 3]; const total = arr.reduce((acc, v) => acc + v, 0)", KNOWN)).toEqual([]);
  });

  it("vm 上下文无的内建（fetch/process/setTimeout）→ 越界引导（正确——本就是运行错误）", () => {
    expect(findOutOfBoundsRoots('const d = await fetch("http://x")', KNOWN)).toEqual(["fetch"]);
    expect(findOutOfBoundsRoots("process.env.PTH_X", KNOWN)).toEqual(["process"]);
    expect(findOutOfBoundsRoots("setTimeout(fn, 1)", KNOWN)).toEqual(["setTimeout"]);
  });

  it("多根去重 + 顺序稳定", () => {
    expect(findOutOfBoundsRoots("foo.bar(); foo.baz(); baz()", KNOWN)).toEqual(["foo", "baz"]);
  });

  it("引导消息列出能力根（N12 同构——引导而非裸 undefined）", () => {
    const msg = buildSurfaceGuidance(["memeory"]);
    expect(msg).toContain('"memeory"');
    expect(msg).toContain("能力面越界");
    expect(msg).toContain("可用能力根");
    expect(msg).toContain("memory");
    expect(msg).toContain("capability-index");
    expect(capabilityRoots()).toContain("memory");
    expect(capabilityRoots()).toContain("bash");
    expect(capabilityRoots()).toContain("results");
  });
});
