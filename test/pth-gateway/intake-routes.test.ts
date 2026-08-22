/**
 * intake-routes.test.ts — N33 Task 5 Step 5/7：intake 原生动作窄端点。
 *
 * 覆盖：503 未装配 / auth scope 来自 token / body 白名单（path/method/command/sql/
 * manifest/privateKey/policy/自报 space 拒绝且不触达 service）/ 幂等键重复返回原
 * run 与订阅 / tenant 域内状态查询。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerIntakeRoutes } from "../../src/pth/gateway/routes-intake";
import {
  IntakeManualControlError,
  type IntakeManualControlService,
} from "../../src/pth/execution/knowledge-intake/manual-control";
import type { IntakeRun, SourceSubscription } from "@away_from/pth-contracts";

const AUTH = { tenantId: "t-1", role: "platform-admin", principalId: "p-1", space: "ts" };

function fakeSubscription(overrides: Partial<SourceSubscription> = {}): SourceSubscription {
  return {
    tenantId: "t-1",
    id: "sub-1",
    space: "ts",
    canonicalUri: "https://example.com/docs",
    domainId: "web",
    status: "probing",
    policyId: "pol-1",
    policyVersion: "1",
    policyDigest: "d".repeat(64),
    policyRuleId: "r-1",
    recrawlIntervalMs: 86_400_000,
    nextCrawlAt: "2026-08-19T00:00:00.000Z",
    rowVersion: 1,
    ...overrides,
  } as SourceSubscription;
}

function fakeRun(overrides: Partial<IntakeRun> = {}): IntakeRun {
  return {
    id: "run-1",
    tenantId: "t-1",
    workMode: "intake",
    subscriptionId: "sub-1",
    reason: "manual-retry",
    stage: "fetch",
    status: "queued",
    attempt: 0,
    leaseGeneration: 0,
    rowVersion: 1,
    ...overrides,
  };
}

interface FakeService extends IntakeManualControlService {
  calls: Array<{ method: string; scope: unknown; args: unknown[] }>;
}

function makeFakeService(): FakeService {
  const calls: FakeService["calls"] = [];
  return {
    calls,
    async createSubscription(scope, input) {
      calls.push({ method: "createSubscription", scope, args: [input] });
      return fakeSubscription({ canonicalUri: input.canonicalUri });
    },
    async triggerSubscriptionRun(scope, subscriptionId, idempotencyKey) {
      calls.push({ method: "triggerSubscriptionRun", scope, args: [subscriptionId, idempotencyKey] });
      // 幂等：同一 key 永远返回同一个 run
      const id = idempotencyKey === "k-dup" ? "run-dup" : "run-1";
      return fakeRun({ id, subscriptionId });
    },
    async getRun(scope, runId) {
      calls.push({ method: "getRun", scope, args: [runId] });
      return runId === "run-1" ? fakeRun() : null;
    },
    async getSubscription(scope, subscriptionId) {
      calls.push({ method: "getSubscription", scope, args: [subscriptionId] });
      return subscriptionId === "sub-1" ? fakeSubscription() : null;
    },
  };
}

function buildApp(service: IntakeManualControlService | null, withAuth = true): FastifyInstance {
  const app = Fastify();
  if (withAuth) {
    // 测试用 auth 注入（生产由 server.ts 的 createAuthHook 统一设置 req.auth）
    app.addHook("onRequest", async (req) => {
      (req as unknown as { auth: typeof AUTH }).auth = AUTH;
    });
  }
  registerIntakeRoutes(app, service);
  return app;
}

const VALID_SUBSCRIBE_BODY = {
  canonicalUri: "https://example.com/docs",
  domainId: "web",
  recrawlIntervalMs: 86_400_000,
  declared: { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" },
};

describe("intake routes", () => {
  let app: FastifyInstance | undefined;
  afterAll(async () => {
    if (app) await app.close();
  });

  it("service=null → 全部 503", async () => {
    app = buildApp(null);
    for (const req of [
      { method: "POST" as const, url: "/api/v1/intake/subscriptions", payload: VALID_SUBSCRIBE_BODY },
      { method: "GET" as const, url: "/api/v1/intake/subscriptions/sub-1" },
      { method: "POST" as const, url: "/api/v1/intake/runs", payload: { subscriptionId: "sub-1", idempotencyKey: "k" } },
      { method: "GET" as const, url: "/api/v1/intake/runs/run-1" },
    ]) {
      const res = await app.inject({ ...req });
      expect(res.statusCode).toBe(503);
    }
  });

  describe("service present", () => {
    let service: FakeService;
    beforeAll(() => {
      service = makeFakeService();
      app = buildApp(service);
    });

    it("POST /subscriptions 创建订阅 → 201；scope 来自 auth；body 不含 space/tenant", async () => {
      const res = await app!.inject({ method: "POST", url: "/api/v1/intake/subscriptions", payload: VALID_SUBSCRIBE_BODY });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: "sub-1", status: "probing" });
      const call = service.calls.find((c) => c.method === "createSubscription")!;
      expect(call.scope).toEqual({ tenantId: "t-1" });
      const input = call.args[0] as Record<string, unknown>;
      expect(input.space).toBe("ts"); // 来自 auth claim
      expect(input).not.toHaveProperty("policy");
      expect(input).not.toHaveProperty("manifest");
    });

    it("POST /subscriptions 携带期望 policy 钉定值 → 透传 expectedPolicy", async () => {
      const res = await app!.inject({
        method: "POST",
        url: "/api/v1/intake/subscriptions",
        payload: { ...VALID_SUBSCRIBE_BODY, expectedPolicyDigest: "d".repeat(64), idempotencyKey: "k-pin" },
      });
      expect(res.statusCode).toBe(201);
      const input = service.calls.filter((c) => c.method === "createSubscription").at(-1)!.args[0] as {
        expectedPolicy?: { digest?: string };
        idempotencyKey?: string;
      };
      expect(input.expectedPolicy?.digest).toBe("d".repeat(64));
      expect(input.idempotencyKey).toBe("k-pin");
    });

    it("body 夹带 path/method/command/sql/manifest/privateKey/policy/url → 400 且不触达 service", async () => {
      const before = service.calls.length;
      for (const bad of [
        { ...VALID_SUBSCRIBE_BODY, path: "/etc/passwd" },
        { ...VALID_SUBSCRIBE_BODY, method: "DELETE" },
        { ...VALID_SUBSCRIBE_BODY, command: "rm -rf /" },
        { ...VALID_SUBSCRIBE_BODY, sql: "DROP TABLE knowledge_intake_runs" },
        { ...VALID_SUBSCRIBE_BODY, manifest: { forged: true } },
        { ...VALID_SUBSCRIBE_BODY, privateKey: "-----BEGIN" },
        { ...VALID_SUBSCRIBE_BODY, policy: { rules: [] } },
        { ...VALID_SUBSCRIBE_BODY, url: "http://evil.example" },
      ]) {
        const res = await app!.inject({ method: "POST", url: "/api/v1/intake/subscriptions", payload: bad });
        expect(res.statusCode).toBe(400);
      }
      expect(service.calls.length).toBe(before);
    });

    it("body 自报 space/tenantId → 400（scope 只能来自 auth token）", async () => {
      const before = service.calls.length;
      for (const bad of [
        { ...VALID_SUBSCRIBE_BODY, space: "other-space" },
        { ...VALID_SUBSCRIBE_BODY, tenantId: "t-9" },
      ]) {
        const res = await app!.inject({ method: "POST", url: "/api/v1/intake/subscriptions", payload: bad });
        expect(res.statusCode).toBe(400);
      }
      expect(service.calls.length).toBe(before);
    });

    it("未知字段 → 400", async () => {
      const res = await app!.inject({
        method: "POST",
        url: "/api/v1/intake/subscriptions",
        payload: { ...VALID_SUBSCRIBE_BODY, disableGuards: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/unknown field/);
    });

    it("POST /runs 触发 run → 201；重复幂等键返回原 run", async () => {
      const first = await app!.inject({
        method: "POST",
        url: "/api/v1/intake/runs",
        payload: { subscriptionId: "sub-1", idempotencyKey: "k-dup" },
      });
      expect(first.statusCode).toBe(201);
      const second = await app!.inject({
        method: "POST",
        url: "/api/v1/intake/runs",
        payload: { subscriptionId: "sub-1", idempotencyKey: "k-dup" },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
      const call = service.calls.find((c) => c.method === "triggerSubscriptionRun")!;
      expect(call.scope).toEqual({ tenantId: "t-1" });
    });

    it("POST /runs 缺 idempotencyKey / 未知字段 / 任意 URL → 400", async () => {
      const before = service.calls.length;
      for (const bad of [
        { subscriptionId: "sub-1" },
        { subscriptionId: "sub-1", idempotencyKey: "k", url: "https://evil.example" },
        { subscriptionId: "sub-1", idempotencyKey: "k", path: "/tmp/x" },
        { subscriptionId: "sub-1", idempotencyKey: "k", stage: "promote" },
      ]) {
        const res = await app!.inject({ method: "POST", url: "/api/v1/intake/runs", payload: bad });
        expect(res.statusCode).toBe(400);
      }
      expect(service.calls.length).toBe(before);
    });

    it("GET /runs/:id 命中 → 200；未命中 → 404；scope 是 tenant 域内", async () => {
      const hit = await app!.inject({ method: "GET", url: "/api/v1/intake/runs/run-1" });
      expect(hit.statusCode).toBe(200);
      expect(hit.json()).toMatchObject({ id: "run-1", status: "queued", stage: "fetch" });
      const miss = await app!.inject({ method: "GET", url: "/api/v1/intake/runs/run-9" });
      expect(miss.statusCode).toBe(404);
      const call = service.calls.filter((c) => c.method === "getRun").at(-1)!;
      expect(call.scope).toEqual({ tenantId: "t-1" });
    });

    it("GET /subscriptions/:id 命中 → 200；未命中 → 404", async () => {
      const hit = await app!.inject({ method: "GET", url: "/api/v1/intake/subscriptions/sub-1" });
      expect(hit.statusCode).toBe(200);
      const miss = await app!.inject({ method: "GET", url: "/api/v1/intake/subscriptions/sub-9" });
      expect(miss.statusCode).toBe(404);
    });

    it("service 抛 POLICY_MISMATCH → 409；NOT_FOUND → 404", async () => {
      service.createSubscription = async () => {
        throw new IntakeManualControlError("POLICY_MISMATCH", "expected policy digest mismatch");
      };
      const conflict = await app!.inject({
        method: "POST",
        url: "/api/v1/intake/subscriptions",
        payload: VALID_SUBSCRIBE_BODY,
      });
      expect(conflict.statusCode).toBe(409);
      service.triggerSubscriptionRun = async () => {
        throw new IntakeManualControlError("SUBSCRIPTION_NOT_FOUND", "subscription not found: sub-9");
      };
      const missing = await app!.inject({
        method: "POST",
        url: "/api/v1/intake/runs",
        payload: { subscriptionId: "sub-9", idempotencyKey: "k-9" },
      });
      expect(missing.statusCode).toBe(404);
    });

    it("无 auth 声明 → 401", async () => {
      const noAuth = buildApp(makeFakeService(), false);
      try {
        const res = await noAuth.inject({
          method: "POST",
          url: "/api/v1/intake/subscriptions",
          payload: VALID_SUBSCRIBE_BODY,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await noAuth.close();
      }
    });
  });
});
