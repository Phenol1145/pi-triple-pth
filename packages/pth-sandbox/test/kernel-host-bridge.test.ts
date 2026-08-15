import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { buildKernelHostApp } from "@away_from/pth-sandbox";

/**
 * P0-1：sandbox 侧记忆桥上游改用 PTH_MEMORY_BRIDGE_TOKEN（Redis Bearer token）。
 * 不再把 SANDBOX_SHARED_SECRET 当作业务 API 凭据转发；token 缺失时 fail-closed 503。
 */
const SECRET = "test-kernel-secret";
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});

describe("sandbox kernel-host memory-bridge 上游认证（P0-1）", () => {
  it("PTH_MEMORY_BRIDGE_TOKEN 未配置 → 503 fail-closed", async () => {
    const upstream = Fastify();
    upstream.post("/api/v1/kernel/memory-bridge", async () => ({ ok: true }));
    const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
    servers.push(upstream);

    process.env.PTH_BRIDGE_URL = address;
    try {
      const app = buildKernelHostApp({ getSecret: () => SECRET, getBridgeToken: () => undefined });
      const res = await app.inject({
        method: "POST",
        url: "/kernel/memory-bridge",
        headers: { authorization: `Bearer ${SECRET}` },
        payload: { op: "get", id: "m1" },
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    } finally {
      delete process.env.PTH_BRIDGE_URL;
    }
  });

  it("上游收到的是 bridge token，而不是 SANDBOX_SHARED_SECRET", async () => {
    const seen: string[] = [];
    const upstream = Fastify();
    upstream.post("/api/v1/kernel/memory-bridge", async (req) => {
      seen.push(String(req.headers.authorization ?? ""));
      return { ok: true };
    });
    const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
    servers.push(upstream);

    process.env.PTH_BRIDGE_URL = address;
    try {
      const app = buildKernelHostApp({ getSecret: () => SECRET, getBridgeToken: () => "bridge-token" });
      const res = await app.inject({
        method: "POST",
        url: "/kernel/memory-bridge",
        headers: { authorization: `Bearer ${SECRET}` },
        payload: { op: "get", id: "m1" },
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual(["Bearer bridge-token"]);
      await app.close();
    } finally {
      delete process.env.PTH_BRIDGE_URL;
    }
  });

  it("loopback workload 免共享密钥，且 body.space 被剥除（P0-2）", async () => {
    const seen: { auth?: string; body: unknown } = { body: null };
    const upstream = Fastify();
    upstream.post("/api/v1/kernel/memory-bridge", async (req) => {
      seen.auth = String(req.headers.authorization ?? "");
      seen.body = req.body;
      return { ok: true };
    });
    const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
    servers.push(upstream);

    process.env.PTH_BRIDGE_URL = address;
    try {
      const app = buildKernelHostApp({ getSecret: () => SECRET, getBridgeToken: () => "bridge-token" });
      const res = await app.inject({
        method: "POST",
        url: "/kernel/memory-bridge",
        payload: { op: "retrieve", anchors: ["a"], space: "forged-space" },
      });
      expect(res.statusCode).toBe(200);
      expect(seen.auth).toBe("Bearer bridge-token");
      expect(seen.body).toEqual({ op: "retrieve", anchors: ["a"] });
      await app.close();
    } finally {
      delete process.env.PTH_BRIDGE_URL;
    }
  });
});
