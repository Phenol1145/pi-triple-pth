import { describe, it, expect } from "vitest";
import { buildReadOnlyQuery } from "../../src/pth/kernel/storage/index.js";

/**
 * 受限只读 SQL（memory.query 能力——LLM/任务代码输入不可信）——安全约束纯函数测试。
 */

describe("buildReadOnlyQuery（受限只读 SQL 校验）", () => {
  it("SELECT 通过（保留原文）", () => {
    const r = buildReadOnlyQuery("SELECT * FROM memory_entries WHERE kind = 'tool-function' LIMIT 5");
    expect(r).toContain("SELECT");
    expect(r).toContain("LIMIT 5");
  });

  it("非 SELECT（DELETE/UPDATE/INSERT/DROP/TRUNCATE）→ 拒绝", () => {
    for (const bad of [
      "DELETE FROM memory_entries",
      "UPDATE memory_entries SET kind='x'",
      "INSERT INTO memory_entries VALUES (1)",
      "DROP TABLE memory_entries",
      "  truncate memory_entries",
      "WITH x AS (SELECT 1) DELETE FROM memory_entries",
    ]) {
      expect(() => buildReadOnlyQuery(bad)).toThrow(/read-only/);
    }
  });

  it("多语句（SELECT 1; DELETE ...）→ 拒绝", () => {
    expect(() => buildReadOnlyQuery("SELECT 1; DELETE FROM memory_entries")).toThrow(/single/);
  });

  it("无 LIMIT → 自动追加 50（防无界扫描）", () => {
    const r = buildReadOnlyQuery("SELECT * FROM memory_entries WHERE kind='dev-artifact'");
    expect(r).toMatch(/LIMIT\s+50/i);
  });

  it("显式 LIMIT 超上限 → 压到 200", () => {
    const r = buildReadOnlyQuery("SELECT * FROM memory_entries LIMIT 9999");
    expect(r).toMatch(/LIMIT\s+200/i);
  });

  it("显式 LIMIT 正常范围 → 保留", () => {
    const r = buildReadOnlyQuery("SELECT * FROM memory_entries LIMIT 10");
    expect(r).toMatch(/LIMIT\s+10/i);
  });

  it("pg 系统表探测 → 拒绝", () => {
    for (const bad of [
      "SELECT * FROM pg_catalog.pg_tables",
      "SELECT relname FROM pg_class",
      "SELECT * FROM pg_stat_activity",
    ]) {
      expect(() => buildReadOnlyQuery(bad)).toThrow(/pg 系统表/);
    }
  });

  it("大小写不敏感（select 小写也通过）", () => {
    const r = buildReadOnlyQuery("select * from memory_entries");
    expect(r).toMatch(/LIMIT\s+50/i);
  });

  it("引号标识符逃逸 → 拒绝（FROM \"tasks\" 不得绕过名单）", () => {
    expect(() => buildReadOnlyQuery('SELECT * FROM "tasks"')).toThrow(/表 "tasks" 不开放/);
    expect(() => buildReadOnlyQuery('SELECT * FROM "credit_tx" LIMIT 1')).toThrow(/不开放/);
  });

  it("注释分隔逃逸 → 拒绝（FROM/*x*/tasks 不得绕过名单）", () => {
    expect(() => buildReadOnlyQuery("SELECT * FROM/*x*/tasks")).toThrow(/表 "tasks" 不开放/);
  });

  it("子查询内嵌未开放表（引号/注释绕过）→ 拒绝", () => {
    expect(() => buildReadOnlyQuery("SELECT * FROM memory_entries WHERE id IN (SELECT id FROM \"audit_log\")")).toThrow(/不开放/);
    expect(() => buildReadOnlyQuery("SELECT * FROM memory_entries WHERE id IN (SELECT id FROM/*c*/transcripts)")).toThrow(/不开放/);
  });
});
