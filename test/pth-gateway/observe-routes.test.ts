/**
 * observe-routes.test.ts — N30 Task 3 / Step 4 路由对抗测试。
 *
 * 覆盖：
 *  - GET /api/v1/observe/timeline 参数校验（畸形窗口/未知 mode/超 7 天/limit 超 5000）；
 *  - tenant 只来自 req.auth，query.tenant 伪造不生效；
 *  - runtime-observer 只读角色：可读 observe，不可访问任何写路由。
 */

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createAuthHook } from "../../src/pth/gateway/auth.js";
import { registerRuntimeObservationRoutes } from "../../src/pth/gateway/routes-observe.js";
import type { PthGatewayFacade } from "../../src/pth/application/gateway/pth-gateway-facade.js";
import type { RuntimeTimelinePage } from "../../src/pth/application/observation/runtime-observation-facade.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FROM = Date.parse("2026-08-19T00:00:00.000Z");
const TO = FROM + DAY_MS;

function page(over: Partial<RuntimeTimelinePage> = {}): RuntimeTimelinePage {
  return {
    intervals: [],
    nextCursor: null,
    window: { from: FROM, to: TO },
    scope: { mode: "local-admin", tenantId: "tenant-a" },
    sourceObservedAt: Date.now(),
    collectedAt: Date.now(),
    ...over,
  };
}

function tokens(role: string): Map<string, string> {
  return new Map([
    ["token-a", JSON.stringify({ tenantId: "tenant-a", role })],
    ["token-b", JSON.stringify({ tenantId: "tenant-b", role })],
  ]);
}

function buildApp(role: string, facade: PthGatewayFacade | null) {
  const app = Fastify();
  app.addHook("onRequest", createAuthHook({ get: async (key: string) => tokens(role).get(key.replace("auth:token:", "")) ?? null } as never));
  registerRuntimeObservationRoutes(app, facade);
  // 一个写路由样本：runtime-observer 必须被认证钩子拒绝，而不是靠路由自身。
  app.post("/api/v1/kernel/tasks", async () => ({ ok: true }));
  return app;
}

describe("observe timeline 路由（N30 Task 3）", () => {
  it("tenant 只来自 req.auth：query.tenant 伪造不生效", async () => {
    const queryTimeline = vi.fn(async () => page());
    const app = buildApp("tenant-agent", { queryTimeline } as unknown as PthGatewayFacade);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${FROM}&to=${TO}&limit=10&modes=run&tenant=tenant-b`,
      headers: { authorization: "Bearer token-a" },
    });

    expect(res.statusCode).toBe(200);
    expect(queryTimeline).toHaveBeenCalledTimes(1);
    const [scope, window, query] = queryTimeline.mock.calls[0]!;
    expect(scope).toMatchObject({ tenantId: "tenant-a" });
    expect(scope).not.toMatchObject({ tenantId: "tenant-b" });
    expect(window).toEqual({ from: FROM, to: TO });
    expect(query).toMatchObject({ limit: 10, modes: ["run"] });
    expect(res.json().scope).toMatchObject({ tenantId: "tenant-a" });
  });

  it("畸形窗口（from/to 非数字）→ 400", async () => {
    const app = buildApp("tenant-agent", { queryTimeline: vi.fn() } as unknown as PthGatewayFacade);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observe/timeline?from=abc&to=def",
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("from > to → 400", async () => {
    const app = buildApp("tenant-agent", { queryTimeline: vi.fn() } as unknown as PthGatewayFacade);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${TO}&to=${FROM}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("窗口超过 7 天 → 400", async () => {
    const app = buildApp("tenant-agent", { queryTimeline: vi.fn() } as unknown as PthGatewayFacade);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${FROM}&to=${FROM + 8 * DAY_MS}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("未知 mode → 400", async () => {
    const app = buildApp("tenant-agent", { queryTimeline: vi.fn() } as unknown as PthGatewayFacade);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${FROM}&to=${TO}&modes=quantum`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("limit 超过 5000 → 400，limit 非法 → 400", async () => {
    const app = buildApp("tenant-agent", { queryTimeline: vi.fn() } as unknown as PthGatewayFacade);
    const tooLarge = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${FROM}&to=${TO}&limit=5001`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(tooLarge.statusCode).toBe(400);

    const notNumber = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${FROM}&to=${TO}&limit=abc`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(notNumber.statusCode).toBe(400);
  });

  it("runtime-observer 只读：observe GET 可读，写路由一律 403", async () => {
    const queryTimeline = vi.fn(async () => page());
    const app = buildApp("runtime-observer", { queryTimeline } as unknown as PthGatewayFacade);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${FROM}&to=${TO}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(read.statusCode).toBe(200);
    expect(queryTimeline).toHaveBeenCalledTimes(1);

    const write = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/tasks",
      headers: { authorization: "Bearer token-a" },
      payload: { title: "x", text: "y" },
    });
    expect(write.statusCode).toBe(403);
  });

  it("facade 未装配 → 503", async () => {
    const app = buildApp("tenant-agent", null);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/observe/timeline?from=${FROM}&to=${TO}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(res.statusCode).toBe(503);
  });
});
