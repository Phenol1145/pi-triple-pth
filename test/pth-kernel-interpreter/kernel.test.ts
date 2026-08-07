import { describe, it, expect } from "vitest";
import { buildCapabilities } from "../../src/pth/kernel/interpreter/capability";
import { createWorkerKernel } from "../../src/pth/kernel/interpreter/index";
import { TsInterpreter } from "../../src/pth/kernel/interpreter/ts-interpreter";

/** mock DataWorldAccess（Spec C 接口） */
function mockDataWorld() {
  return {
    // 适配说明：brief 原 mock 的 tasks 用 `peek`，但 Spec C TaskStore 真实形状是
    // `candidates`（capability 实现按 `dataWorld.tasks.candidates` 映射）——mock 对齐真实接口。
    tasks: { candidates: async () => [], submit: async () => {} },
    memory: { retrieve: async () => [], write: async () => {} },
    transcripts: {},
    audit: {},
  } as any;
}

describe("capabilities", () => {
  it("buildCapabilities injects llm/memory/skills/tasks", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(caps.llm).toBeDefined();
    expect(caps.memory).toBeDefined();
    expect(caps.skills).toBeDefined();
    expect(caps.tasks).toBeDefined();
  });

  it("tasks capability only exposes peek/submit (not claim/reject)", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(caps.tasks.peek).toBeDefined();
    expect(caps.tasks.submit).toBeDefined();
    expect(caps.tasks.claim).toBeUndefined();   // 认领由 TaskLoop 机械控制
    expect(caps.tasks.reject).toBeUndefined();
  });

  it("injects bash/python interpreters when provided", () => {
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld: mockDataWorld(),
      bash: { execute: async () => ({}) } as any,
      python: { execute: async () => ({}) } as any,
    });
    expect(caps.bash).toBeDefined();
    expect(caps.python).toBeDefined();
  });
});

describe("worker kernel", () => {
  it("createWorkerKernel assembles all interpreters + llm + dataWorld", () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    expect(kernel.ts).toBeInstanceOf(TsInterpreter);
    expect(kernel.bash).toBeDefined();
    expect(kernel.python).toBeDefined();
    expect(kernel.llm).toBeDefined();
    expect(kernel.dataWorld).toBeDefined();
  });

  it("kernel.reset resets all interpreters", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    await kernel.ts.execute("let x = 42");
    kernel.reset();
    const res = await kernel.ts.execute("typeof x");
    expect(res.value).toBe("undefined");
  });

  it("kernel exposes capabilities usable from TS program", async () => {
    const kernel = createWorkerKernel({
      modelRouter: { resolve: () => ({ id: "m", api: "a" }), getRuntime: () => ({}) } as any,
      dataWorld: mockDataWorld(),
    });
    const res = await kernel.ts.execute("tasks.peek()");
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([]);
  });
});
