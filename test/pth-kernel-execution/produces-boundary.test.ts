import { describe, it, expect } from "vitest";
import { buildCapabilities } from "../../src/pth/impls/kernels/capability.js";
import {
  OBSERVATION_REPORT_KIND,
  MODIFICATION_PLAN_KIND,
  LEGACY_OPTIMIZER_SUGGESTION_KIND,
} from "@away_from/pth-kernel-execution";

function mockDataWorld(overrides: Record<string, unknown> = {}) {
  return {
    tasks: { candidates: async () => [], submit: async () => {} },
    memory: {
      retrieve: async () => [],
      write: async () => {},
      get: async () => undefined,
      update: async () => {},
      ...overrides,
    },
    transcripts: {},
    audit: {},
    queryReadOnly: async () => [],
  } as any;
}

describe("W0：produces 产物边界（三源重构）", () => {
  it("三源 kind 常量导出可见", () => {
    expect(OBSERVATION_REPORT_KIND).toBe("observation-report");
    expect(MODIFICATION_PLAN_KIND).toBe("modification-plan");
    expect(LEGACY_OPTIMIZER_SUGGESTION_KIND).toBe("optimizer-suggestion");
  });

  it("produces 白名单：允许 kind 通过，越界 fail-fast 且错误消息含角色与允许列表", async () => {
    const written: unknown[] = [];
    const dataWorld = mockDataWorld({
      write: async (entry: unknown) => { written.push(entry); },
    });
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld,
      roleId: "sensor:worker-opt",
      produces: [OBSERVATION_REPORT_KIND],
    });
    const memory = caps.memory as Record<string, (...a: unknown[]) => unknown>;

    await (memory.write as (e: unknown) => Promise<unknown>)({ kind: OBSERVATION_REPORT_KIND, content: "观测事实", anchors: ["a"], meta: { visibility: "public" } });
    expect(written).toHaveLength(1);

    await expect(
      (memory.write as (e: unknown) => Promise<unknown>)({ kind: MODIFICATION_PLAN_KIND, content: "方案", anchors: ["a"], meta: { visibility: "public" } }),
    ).rejects.toThrow(/sensor:worker-opt/);
    await expect(
      (memory.write as (e: unknown) => Promise<unknown>)({ kind: MODIFICATION_PLAN_KIND, content: "方案", anchors: ["a"], meta: { visibility: "public" } }),
    ).rejects.toThrow(/observation-report/);
  });

  it("produces: undefined 角色写任意 kind 通过（兼容）", async () => {
    const written: unknown[] = [];
    const dataWorld = mockDataWorld({
      write: async (entry: unknown) => { written.push(entry); },
    });
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld,
      roleId: "developer",
    });
    const memory = caps.memory as Record<string, (...a: unknown[]) => unknown>;
    await (memory.write as (e: unknown) => Promise<unknown>)({ kind: "task-insight", content: "x", anchors: ["a"], meta: { visibility: "public" } });
    await (memory.write as (kind: string, content: string, opts?: Record<string, unknown>) => Promise<unknown>)("dev-artifact", "y", { anchors: ["b"], meta: { visibility: "public" } });
    expect(written).toHaveLength(2);
  });

  it("produces: [] 角色写任何 kind 均 fail-fast", async () => {
    const dataWorld = mockDataWorld({
      write: async () => { throw new Error("不应到达底层 write"); },
    });
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld,
      roleId: "readonly-role",
      produces: [],
    });
    const memory = caps.memory as Record<string, (...a: unknown[]) => unknown>;
    await expect(
      (memory.write as (e: unknown) => Promise<unknown>)({ kind: OBSERVATION_REPORT_KIND, content: "x", anchors: ["a"] }),
    ).rejects.toThrow(/禁止任何 memory 写入/);
  });

  it("评审补强：produces 同样约束 memory.update（更新已存在条目也是写入该 kind）", async () => {
    const updated: unknown[] = [];
    const dataWorld = mockDataWorld({
      get: async (id: string) => ({ id, kind: LEGACY_OPTIMIZER_SUGGESTION_KIND, anchors: [], content: "old", status: "draft" }),
      update: async (id: unknown, patch: unknown) => { updated.push({ id, patch }); },
    });
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld,
      roleId: "sensor:worker-opt",
      produces: [OBSERVATION_REPORT_KIND],
    });
    const memory = caps.memory as Record<string, (...a: unknown[]) => unknown>;
    await expect(
      (memory.update as (id: string, patch: unknown) => Promise<unknown>)("e1", { content: "new" }),
    ).rejects.toThrow(/optimizer-suggestion/);
    expect(updated).toHaveLength(0);
  });

  it("评审补强：memory.update 允许 produces 内的 kind", async () => {
    const updated: unknown[] = [];
    const dataWorld = mockDataWorld({
      get: async (id: string) => ({ id, kind: OBSERVATION_REPORT_KIND, anchors: [], content: "old", status: "draft" }),
      update: async (id: unknown, patch: unknown) => { updated.push({ id, patch }); },
    });
    const caps = buildCapabilities({
      llm: { complete: async () => ({ content: "x" }) } as any,
      dataWorld,
      roleId: "sensor:worker-opt",
      produces: [OBSERVATION_REPORT_KIND],
    });
    const memory = caps.memory as Record<string, (...a: unknown[]) => unknown>;
    await (memory.update as (id: string, patch: unknown) => Promise<unknown>)("e1", { content: "new" });
    expect(updated).toHaveLength(1);
  });
});
