import { describe, it, expect, vi } from "vitest";
import { createRecallState } from "../../src/pth/kernel/interpreter/capability";

function mockMemory(entries: any[]) {
  return {
    retrieve: vi.fn(async (opts: any) => entries.filter((e) => !opts.kinds || opts.kinds.includes(e.kind))),
    write: vi.fn(async () => {}),
    bumpHitCount: vi.fn(async () => {}),
  };
}

describe("createRecallState（召回能力）", () => {
  it("recallFunctions 按锚点召回 tool-function（源码 + spec）", async () => {
    const memory = mockMemory([
      { id: "fn-abc", kind: "tool-function", content: "function add(a,b){return a+b}", anchors: ["add"], meta: { spec: { signature: "add(a,b)" } } },
    ]);
    const state = createRecallState(memory as any);
    const fns = await state.recallFunctions(["add"]);
    expect(fns).toHaveLength(1);
    expect(fns[0].key).toBe("add");
    expect(fns[0].source).toContain("function add");
    expect(fns[0].spec).toBeDefined();
    // 用 kinds 过滤
    expect(memory.retrieve).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["tool-function"] }));
  });

  it("recallFunctions 返回 {key, source} 供 eval 重放", async () => {
    const memory = mockMemory([
      { id: "fn-x", kind: "tool-function", content: "function fib(n){return n<=1?n:fib(n-1)+fib(n-2)}", anchors: ["fib"], meta: {} },
    ]);
    const state = createRecallState(memory as any);
    const fns = await state.recallFunctions(["fib"]);
    // eval 重放验证（pickle 当前实现）——vm 里 eval 函数声明
    const { createContext, runInContext } = await import("node:vm");
    const vmCtx = createContext({});
    const ctx = runInContext(`(function(){
      ${fns[0].source}
      return fib(10);
    })()`, vmCtx);
    expect(ctx).toBe(55);
  });

  it("recallInsights 按锚点召回 task-insight 内容列表", async () => {
    const memory = mockMemory([
      { id: "insight-1", kind: "task-insight", content: "fib(10)=55", anchors: ["fib"] },
      { id: "insight-2", kind: "task-insight", content: "递归有性能问题", anchors: ["fib"] },
    ]);
    const state = createRecallState(memory as any);
    const insights = await state.recallInsights(["fib"]);
    expect(insights).toContain("fib(10)=55");
    expect(insights).toContain("递归有性能问题");
    expect(memory.retrieve).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["task-insight"] }));
  });

  it("空结果 → 空数组", async () => {
    const state = createRecallState(mockMemory([]) as any);
    expect(await state.recallFunctions(["nope"])).toEqual([]);
    expect(await state.recallInsights(["nope"])).toEqual([]);
  });
});
