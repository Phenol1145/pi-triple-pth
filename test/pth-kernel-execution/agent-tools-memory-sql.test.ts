import { describe, it, expect } from "vitest";
import { AGENT_TOOLS, AGENT_TOOLS_DESCRIPTION } from "../../src/pth/kernel/execution/agent-tools.js";
import { AGENT_TOOL_IDS } from "../../src/pth/kernel/execution/parse-agent-action.js";
import type { AgentToolCtx } from "../../src/pth/kernel/execution/agent-tools.js";
import type { WorkerKernel } from "../../src/pth/kernel/interpreter/index.js";

/**
 * memory.sql 工具（记忆收敛为单一 SQL 查询）——安全约束与行为。
 */

function fakeCtx(sqlImpl: (sql: string) => Promise<unknown>): AgentToolCtx {
  return {
    kernel: null as unknown as WorkerKernel,
    caps: {},
    sql: sqlImpl,
  };
}

describe("memory.sql（记忆收敛单一工具）", () => {
  it("SELECT 查询：执行并返回行", async () => {
    let received = "";
    const ctx = fakeCtx(async (sql) => {
      received = sql;
      return [{ kind: "tool-function", anchors: ["fib"], content: "fib(n)" }];
    });
    const r = await AGENT_TOOLS["memory.sql"](ctx, { sql: "SELECT * FROM memory_entries WHERE kind = 'tool-function' LIMIT 5" });
    expect(r.ok).toBe(true);
    expect(received).toContain("SELECT");
    expect(JSON.stringify(r.value)).toContain("fib");
  });

  it("非 SELECT（DELETE/UPDATE/INSERT/DROP）→ 拒绝", async () => {
    const ctx = fakeCtx(async () => [{ hacked: true }]);
    for (const bad of ["DELETE FROM memory_entries", "UPDATE memory_entries SET kind='x'", "INSERT INTO memory_entries VALUES (1)", "DROP TABLE memory_entries", "  truncate memory_entries"]) {
      const r = await AGENT_TOOLS["memory.sql"](ctx, { sql: bad });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("read-only");
    }
  });

  it("多语句（SELECT 1; DELETE ...）→ 拒绝", async () => {
    const ctx = fakeCtx(async () => []);
    const r = await AGENT_TOOLS["memory.sql"](ctx, { sql: "SELECT 1; DELETE FROM memory_entries" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("single");
  });

  it("无 LIMIT → 自动追加（防无界扫描）", async () => {
    let received = "";
    const ctx = fakeCtx(async (sql) => {
      received = sql;
      return [];
    });
    await AGENT_TOOLS["memory.sql"](ctx, { sql: "SELECT * FROM memory_entries WHERE kind='dev-artifact'" });
    expect(received).toMatch(/LIMIT\s+50/i);
  });

  it("显式 LIMIT 超上限 → 拒绝（或压到上限）", async () => {
    let received = "";
    const ctx = fakeCtx(async (sql) => {
      received = sql;
      return [];
    });
    const r = await AGENT_TOOLS["memory.sql"](ctx, { sql: "SELECT * FROM memory_entries LIMIT 9999" });
    expect(r.ok).toBe(true);
    expect(received).toMatch(/LIMIT\s+200/i);
  });

  it("SQL 错误 → ok:false 回填错误（LLM 修正）", async () => {
    const ctx = fakeCtx(async () => {
      throw new Error('syntax error at or near "FROM"');
    });
    const r = await AGENT_TOOLS["memory.sql"](ctx, { sql: "SELECT * FORM memory_entries" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("syntax error");
  });

  it("查询工具收敛：旧查询工具从白名单移除，memory.sql 在位", () => {
    expect(AGENT_TOOL_IDS).not.toContain("state.recallFunctions");
    expect(AGENT_TOOL_IDS).not.toContain("state.recallInsights");
    expect(AGENT_TOOL_IDS).not.toContain("memory.retrieve");
    expect(AGENT_TOOL_IDS).toContain("memory.sql");
    expect(AGENT_TOOL_IDS).toContain("memory.write"); // 写入保留封装
  });

  it("工具描述包含 memory_entries schema（LLM 可写对 SQL）", () => {
    expect(AGENT_TOOLS_DESCRIPTION).toContain("memory.sql");
    expect(AGENT_TOOLS_DESCRIPTION).toContain("memory_entries");
    expect(AGENT_TOOLS_DESCRIPTION).toContain("read-only");
  });
});
