import { describe, it, expect } from "vitest";
import { findOutOfBoundsRoots, buildSurfaceGuidance, capabilityRoots } from "@away_from/pth-kernel-interpreter";

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

  it("2026-08-15 筛查回归：逗号连声明/方法简写/生成器不误判", () => {
    // 逗号连声明（此前只收第一个声明符，rb 被误判为未注入能力）
    expect(findOutOfBoundsRoots("const listB = [], rb = []; listB.push(1); rb.push(2); return {listB, rb};", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("let listB, rb; listB = []; rb = listB.slice(1);", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("for (let i = 0, rb = 0; i < 2; i++, rb++) { rb = rb + i; }", KNOWN)).toEqual([]);
    // 对象方法简写/访问器/类方法/生成器（此前 name( 被当直接调用根）
    expect(findOutOfBoundsRoots("const o = { rb(x){ return x + 1; } }; return o.rb(1);", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("const o = { get rb(){ return 1; }, set rb(x){ this.x = x; } }; return o.rb;", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("class A { rb(x){ return x + 1; } } return new A().rb(1);", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("function* rb(){ yield 1; } return [...rb()];", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("async function* rb(){ yield 1; } return rb();", KNOWN)).toEqual([]);
  });

  it("2026-08-15 筛查回归：if/while 头调用与除法链不被误处理", () => {
    // if (foo()) 的 foo 不能因 if( 吞掉前导字符而漏检
    expect(findOutOfBoundsRoots("if (foo()) { return 1; }", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("while (foo()) { break; }", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("const x = foo().bar; return x;", KNOWN)).toEqual(["foo"]);
    // 除法链 a / b / c 不能被正则字面量启发式剥成 /x/ 而吞掉后续内容
    expect(findOutOfBoundsRoots("const a = foo.bar / 2; return a;", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("const a = 8, b = 4, c = 2; return a / b / c;", KNOWN)).toEqual([]);
  });

  it("2026-08-15 审计回归：控制流头部成员访问与 TS 非空断言不漏报", () => {
    expect(findOutOfBoundsRoots("if (foo.bar) { console.log(1) }", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("while (foo.bar) { break }", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("switch (foo.bar) { case 1: break }", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("for (const x of foo.bar) { console.log(x) }", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("foo!.bar", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("foo!()", KNOWN)).toEqual(["foo"]);
  });

  it("2026-08-15 审计回归：模板插值/解构默认值/as 断言不漏检", () => {
    // 模板串 ${} 插值表达式参与判定；模板文本不参与
    expect(findOutOfBoundsRoots("const msg = `value: ${foo.bar}`; msg", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots('const msg = `"${foo.bar}"`; msg', KNOWN)).toEqual(["foo"]);   // 模板文本引号不吞插值
    expect(findOutOfBoundsRoots("const msg = `text foo.bar text`; msg", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("`${foo()}`", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("`${memory.query('x')}`", KNOWN)).toEqual([]);
    // 解构默认值 RHS 是表达式引用——参与判定；绑定名仍安全
    expect(findOutOfBoundsRoots("const { a = foo.bar } = obj; a", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("const { rows = memory.query('x') } = obj; rows", KNOWN)).toEqual([]);
    expect(findOutOfBoundsRoots("const { a = foo.bar, b: { c = baz() } } = obj; a + c", KNOWN)).toEqual(["foo", "baz"]);
    // TS as 断言：断言表达式根参与判定；属性名/本地声明不误报
    expect(findOutOfBoundsRoots("const x = foo as Bar;", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("const x = obj.foo as Bar;", KNOWN)).toEqual(["obj"]);
    expect(findOutOfBoundsRoots("const x = (await foo()) as Bar;", KNOWN)).toEqual(["foo"]);
    expect(findOutOfBoundsRoots("const foo = 1; const x = foo as number;", KNOWN)).toEqual([]);
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
