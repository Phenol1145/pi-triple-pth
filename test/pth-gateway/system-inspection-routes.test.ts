/**
 * system-inspection-routes.test.ts — N33 Task 3 / Step 5 路由对抗测试。
 *
 * 覆盖：
 *  - tenant/space 只来自 req.auth：query.tenant/query.space 覆盖一律 400；
 *  - 默认 limit 20 / 上限 100 / 越界 400；
 *  - 畸形 cursor 400；
 *  - /memory/entries/:id 精确 ID + tenant/visibility 谓词（404 不落到 retrieveMemory({})）；
 *  - /memory/entries/:id/revisions 路由边界恰好十条第；
 *  - facade 未装配 503；
 *  - runtime-observer 只读身份可读 observe，写路由仍 403。
 */

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createAuthHook } from "../../src/pth/gateway/auth.js";
import { registerSystemInspectionRoutes } from "../../src/pth/gateway/routes-observe.js";
import { SystemInspectionFacade } from "../../src/pth/application/observation/system-inspection-facade.js";

const T0 = new Date("2026-08-19T00:00:00.000Z");
const T1 = new Date("2026-08-19T00:01:00.000Z");

function tokens(role: string): Map<string, string> {
  return new Map([
    ["token-a", JSON.stringify({ tenantId: "tenant-a", role })],
    ["token-b", JSON.stringify({ tenantId: "tenant-b", role })],
  ]);
}

function memoryRow(i: number) {
  return {
    id: `entry-${String(i).padStart(3, "0")}`,
    tenant_id: "tenant-a",
    kind: "skill",
    anchors: ["skill"],
    status: "official",
    version: 1,
    created_at: T0,
    updated_at: T1,
    content_bytes: 64,
  };
}

function revisionRow(i: number) {
  return {
    entry_id: "entry-000",
    revision: 30 - i,
    status: "official",
    created_at: T1,
    created_by: null,
    reason: null,
  };
}

function fakePool(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { pool: { query } as unknown as import("pg").Pool, query };
}

function buildApp(role: string, facade: SystemInspectionFacade | null) {
  const app = Fastify();
  app.addHook("onRequest", createAuthHook({ get: async (key: string) => tokens(role).get(key.replace("auth:token:", "")) ?? null } as never));
  registerSystemInspectionRoutes(app, facade);
  // 写路由样本：runtime-observer 必须被认证钩子拒绝，而不是靠路由自身。
  app.post("/api/v1/kernel/tasks", async () => ({ ok: true }));
  return app;
}

describe("system inspection 路由（N33 Task 3）", () => {
  it("tenant/space 只来自 req.auth：query 覆盖一律 400", async () => {
    const { pool } = fakePool(memoryRow(0) ? [memoryRow(0)] : []);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });
    const app = buildApp("tenant-agent", facade);

    for (const url of [
      "/api/v1/observe/memory/entries?tenant=tenant-b",
      "/api/v1/observe/memory/summary?space=space-b",
      "/api/v1/observe/workers?tenant=tenant-b",
      "/api/v1/observe/config?space=space-b",
      "/api/v1/observe/roles?tenant=tenant-b",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer token-a" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("tenant/space must come from auth");
    }
  });

  it("默认 limit 20 / 显式 limit 100 合法 / 101 与畸形 400", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => memoryRow(i));
    const { pool } = fakePool(rows);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });
    const app = buildApp("tenant-agent", facade);

    const dflt = await app.inject({
      method: "GET",
      url: "/api/v1/observe/memory/entries",
      headers: { authorization: "Bearer token-a" },
    });
    expect(dflt.statusCode).toBe(200);
    expect(dflt.json().items).toHaveLength(20);

    const max = await app.inject({
      method: "GET",
      url: "/api/v1/observe/memory/entries?limit=100",
      headers: { authorization: "Bearer token-a" },
    });
    expect(max.statusCode).toBe(200);
    expect(max.json().items).toHaveLength(25);

    for (const url of [
      "/api/v1/observe/memory/entries?limit=101",
      "/api/v1/observe/memory/entries?limit=0",
      "/api/v1/observe/memory/entries?limit=abc",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer token-a" },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("畸形 cursor → 400", async () => {
    const { pool } = fakePool();
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });
    const app = buildApp("tenant-agent", facade);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observe/memory/entries?cursor=not-a-cursor",
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("/memory/entries/:id 精确 ID + tenant/visibility 谓词；未命中 404", async () => {
    const { pool, query } = fakePool([]);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });
    const app = buildApp("tenant-agent", facade);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observe/memory/entries/nope",
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(404);

    // 只允许精确 ID + 谓词 SQL；绝不允许 retrieveMemory({}) 全量读。
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("me.tenant_id = $1");
    expect(sql).toContain("me.id = $2");
    expect(sql).not.toMatch(/FROM memory_entries\s*WHERE\s*$/);
  });

  it("/memory/entries/:id/revisions 路由边界恰好十条第，倒序", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => revisionRow(i));
    const { pool } = fakePool(rows);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });
    const app = buildApp("tenant-agent", facade);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observe/memory/entries/entry-000/revisions",
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revisions).toHaveLength(10);
    expect(res.json().revisions[0].revision).toBe(30);
    expect(res.json().revisions[9].revision).toBe(21);
  });

  it("facade 未装配 → 503", async () => {
    const app = buildApp("tenant-agent", null);
    for (const url of [
      "/api/v1/observe/workers",
      "/api/v1/observe/memory/entries",
      "/api/v1/observe/config",
      "/api/v1/observe/roles",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer token-a" },
      });
      expect(res.statusCode).toBe(503);
    }
  });

  it("runtime-observer 只读：observe GET 可读，写路由一律 403", async () => {
    const { pool } = fakePool([]);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });
    const app = buildApp("runtime-observer", facade);

    const read = await app.inject({
      method: "GET",
      url: "/api/v1/observe/roles",
      headers: { authorization: "Bearer token-a" },
    });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/tasks",
      headers: { authorization: "Bearer token-a" },
      payload: { title: "x", text: "y" },
    });
    expect(write.statusCode).toBe(403);
  });
});
