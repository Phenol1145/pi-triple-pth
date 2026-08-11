import { describe, it, expect } from "vitest";
import { createWorkerKernelWithManager } from "../../src/pth/kernel/interpreter/kernel-manager.js";

function makeManager(): any {
  return {
    bash: { language: "bash", execute: async () => ({ ok: true }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
    python: { language: "python", execute: async () => ({ ok: true }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
    c: { language: "c", execute: async () => ({ ok: true }), state: {}, reset() {}, dispose() {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }) },
  };
}
const fakeDataWorld = {
  memory: { retrieve: async () => [], write: async () => {} },
  tasks: { candidates: async () => [], submit: async () => {} },
  queryReadOnly: async () => [],
} as any;

describe("权限分层（P3——注入面收窄）", () => {
  it("roleFilter 白名单：只注入声明的能力（其余不在 vm 能力面）", () => {
    const k = createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as any,
      dataWorld: fakeDataWorld,
      manager: makeManager(),
      roleFilter: ["fs", "memory", "results", "context"],
    });
    expect(k.capabilities["fs"]).toBeUndefined();   // fs 无 toolstore——本身就没有（断言重点在 memory 在）
    expect(k.capabilities["memory"]).toBeDefined();
    expect(k.capabilities["python"]).toBeUndefined();   // 白名单外——未注入
    expect(k.capabilities["bash"]).toBeUndefined();
    expect(k.capabilities["c"]).toBeUndefined();
    expect(k.capabilities["llm"]).toBeUndefined();
    expect(k.capabilities["web"]).toBeUndefined();
  });

  it("缺省（无 roleFilter）→ 全量能力（兼容）", () => {
    const k = createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as any,
      dataWorld: fakeDataWorld,
      manager: makeManager(),
    });
    expect(k.capabilities["python"]).toBeDefined();
    expect(k.capabilities["llm"]).toBeDefined();
    expect(k.capabilities["web"]).toBeDefined();
  });

  it("memoryScope=own：memory.write 自动标记 role:<role> 命名空间", async () => {
    let written: Record<string, unknown> | undefined;
    const dw = {
      ...fakeDataWorld,
      memory: {
        retrieve: async () => [],
        // 对象签名（真实 PgMemoryStore.write(entry)——位置形是历史错配已修复）
        write: async (entry: Record<string, unknown>) => { written = entry; },
      },
    } as any;
    const k = createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as any,
      dataWorld: dw,
      manager: makeManager(),
      memoryScope: { role: "developer", scope: "own" },
    });
    const memory = k.capabilities["memory"] as Record<string, unknown>;
    await (memory["write"] as (e: unknown) => Promise<unknown>)({ kind: "insight", content: "x", anchors: ["orig"] });
    expect(written).toMatchObject({ anchors: ["role:developer", "orig"] });
  });

  it("memoryScope=all：不包装（兼容——跨区）", async () => {
    let written: Record<string, unknown> | undefined;
    const dw = {
      ...fakeDataWorld,
      memory: { retrieve: async () => [], write: async (entry: Record<string, unknown>) => { written = entry; } },
    } as any;
    const k = createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as any,
      dataWorld: dw,
      manager: makeManager(),
      memoryScope: { role: "memory-keeper", scope: "all" },
    });
    const memory = k.capabilities["memory"] as Record<string, unknown>;
    await (memory["write"] as (e: unknown) => Promise<unknown>)({ kind: "insight", content: "x", anchors: ["a"] });
    expect(written).toMatchObject({ anchors: ["a"] });   // 无 role 前缀（all 不包装）
  });

  it("roleFilter + memoryScope 组合（白名单过滤 + 命名空间标记）", () => {
    const k = createWorkerKernelWithManager({
      llm: { complete: async () => ({ ok: false }) } as any,
      dataWorld: fakeDataWorld,
      manager: makeManager(),
      roleFilter: ["memory", "fs"],
      memoryScope: { role: "scout", scope: "own" },
    });
    expect(k.capabilities["memory"]).toBeDefined();
    expect(k.capabilities["python"]).toBeUndefined();
    expect(k.capabilities["c"]).toBeUndefined();
  });
});
