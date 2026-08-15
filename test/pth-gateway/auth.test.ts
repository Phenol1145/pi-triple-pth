import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { createAuthHook } from "../../src/pth/gateway/auth.js";

/** P0-1：memory-bridge 不再豁免全局 Bearer 鉴权；space 声明来自 Redis token */
describe("createAuthHook（P0-1）", () => {
  const tokens = new Map<string, string>([
    ["ok", JSON.stringify({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" })],
    ["no-space", JSON.stringify({ tenantId: "tenant-b", role: "tenant-agent" })],
    ["no-tenant", JSON.stringify({ role: "tenant-agent" })],
  ]);
  const redis = { get: async (key: string) => tokens.get(key.replace("auth:token:", "")) ?? null };

  function buildApp() {
    const app = Fastify();
    app.addHook("onRequest", createAuthHook(redis as never));
    app.get("/health", async () => ({ ok: true }));
    app.get("/metrics", async () => "metrics");
    app.get("/probe", async (req) => (req as unknown as { auth: unknown }).auth);
    app.post("/api/v1/kernel/memory-bridge", async (req, reply) => {
      const auth = (req as unknown as { auth?: { tenantId?: string; space?: string } }).auth;
      if (!auth?.tenantId || !auth.space) return reply.status(401).send({ error: "no bridge claim" });
      return { auth };
    });
    return app;
  }

  it("health 与 metrics 免鉴权", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
  });

  it("memory-bridge 不再豁免：无 Bearer → 401", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/kernel/memory-bridge", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("合法 token：tenant/role/space 从 Redis 声明解析", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/memory-bridge",
      headers: { authorization: "Bearer ok" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().auth).toMatchObject({ tenantId: "tenant-a", role: "tenant-agent", space: "meta" });
  });

  it("token 缺少 space 声明：请求可达路由，由路由 fail-closed（401）", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/kernel/memory-bridge",
      headers: { authorization: "Bearer no-space" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("token 缺少 tenantId → 401", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: "Bearer no-tenant" },
    });
    expect(res.statusCode).toBe(401);
  });
});
