/**
 * operator-console-work.integration.test.ts — N33 Task 5 组合集成
 *
 * 真实 PTL operator console server（loopback）+ 真实 PTH 路由（kernel/intake，
 * fake kernel/manual-control 支撑）端到端：
 *   bootstrap → /api/work/actions → preview → submit → native 状态轮询 → evaluate
 * 并验证：CSRF 守卫、digest 绑定、未登记动作 404、浏览器侧任何响应都不含 PTH token。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import Fastify from "fastify";
import { registerKernelRoutes } from "../../src/pth/gateway/routes-kernel";
import { registerIntakeRoutes } from "../../src/pth/gateway/routes-intake";
import { createPthGatewayFacade } from "../../src/pth/application/gateway/pth-gateway-facade";
import type { IntakeManualControlService } from "../../src/pth/execution/knowledge-intake/manual-control";
import type { KernelRuntime } from "../../src/pth/kernel/assembly";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/framework/src/operator-console/index.js";

const BOOTSTRAP_TOKEN = "b".repeat(64);
const PTH_TOKEN = "pth-it-secret-token-0123456789abcdef";

// ─── fake PTH（真实路由 + fake kernel/manual-control 支撑）───

interface PthState {
  publishedTasks: Array<Record<string, unknown>>;
  intakeCalls: Array<{ method: string; scope: unknown; args: unknown[] }>;
  suggestionStatus: string;
  suggestionUpdates: Array<Record<string, unknown>>;
}

function buildFakePth(state: PthState) {
  const suggestionContent = JSON.stringify({
    target: "capability-index",
    evidence: { pattern: "rule" },
    content: "背景：测试\n建议规则: 总是先跑测试再合并",
  });

  const kernel = {
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("optimizer-suggestion")) {
          expect(params).toEqual(["default"]); // tenant-scoped 查询
          return {
            rows: [
              {
                id: "sug-1",
                status: state.suggestionStatus,
                kind: "optimizer-suggestion",
                preview: "capability-index 建议规则: 总是先跑测试",
                created_at: "2026-08-19",
              },
            ],
          };
        }
        if (sql.includes("FROM tasks WHERE id = $1 AND tenant_id = $2")) {
          return {
            rows: [{ id: params[0], tenant_id: "default", status: "completed", completed_at: "2026-08-19T00:01:00Z" }],
          };
        }
        if (sql.includes("GROUP BY status")) return { rows: [{ status: "pending", n: 1 }] };
        return { rows: [] };
      },
    },
    dataWorld: {
      tasks: {
        publish: async (input: Record<string, unknown>) => {
          state.publishedTasks.push(input);
          return { id: "task-xyz", status: "pending", ...input };
        },
        candidates: async () => [],
        countPending: async () => 0,
      },
      memory: {
        get: async (id: string, opts: { tenantId?: string }) => {
          if (id === "sug-1") {
            return {
              id: "sug-1",
              tenantId: opts?.tenantId ?? "default",
              kind: "optimizer-suggestion",
              status: state.suggestionStatus,
              content: suggestionContent,
              meta: {},
            };
          }
          return null;
        },
        update: async (id: string, patch: Record<string, unknown>) => {
          state.suggestionUpdates.push({ id, ...patch });
          if (id === "sug-1" && patch.status === "official") state.suggestionStatus = "official";
        },
      },
      queryReadOnly: async () => [],
      transcripts: {},
      audit: {},
    },
    batchManager: { listBatches: async () => [], isBatchAlive: () => false },
    watchdog: { getCrashLog: () => [] },
    shutdown: async () => {},
  } as unknown as KernelRuntime;

  const intakeService: IntakeManualControlService = {
    async createSubscription(scope, input) {
      state.intakeCalls.push({ method: "createSubscription", scope, args: [input] });
      return {
        tenantId: (scope as { tenantId: string }).tenantId,
        id: "sub-it-1",
        space: input.space,
        canonicalUri: input.canonicalUri,
        domainId: input.domainId,
        status: "probing",
        policyId: "pol-1",
        policyVersion: "1",
        policyDigest: "d".repeat(64),
        policyRuleId: "r-1",
        recrawlIntervalMs: input.recrawlIntervalMs,
        nextCrawlAt: "2026-08-19T00:00:00.000Z",
        rowVersion: 1,
      } as never;
    },
    async triggerSubscriptionRun(scope, subscriptionId, idempotencyKey) {
      state.intakeCalls.push({ method: "triggerSubscriptionRun", scope, args: [subscriptionId, idempotencyKey] });
      return {
        id: "run-it-1",
        tenantId: (scope as { tenantId: string }).tenantId,
        workMode: "intake",
        subscriptionId,
        reason: "manual-retry",
        stage: "fetch",
        status: "queued",
        attempt: 0,
        leaseGeneration: 0,
        rowVersion: 1,
      } as never;
    },
    async getRun(scope, runId) {
      return runId === "run-it-1"
        ? ({
            id: "run-it-1",
            tenantId: (scope as { tenantId: string }).tenantId,
            workMode: "intake",
            subscriptionId: "sub-it-1",
            reason: "manual-retry",
            stage: "complete",
            status: "completed",
            attempt: 1,
            leaseGeneration: 1,
            rowVersion: 3,
          } as never)
        : null;
    },
    async getSubscription(scope, subscriptionId) {
      return subscriptionId === "sub-it-1"
        ? ({
            tenantId: (scope as { tenantId: string }).tenantId,
            id: "sub-it-1",
            space: "ts",
            canonicalUri: "https://example.com/docs",
            domainId: "web",
            status: "active",
            policyId: "pol-1",
            policyVersion: "1",
            policyDigest: "d".repeat(64),
            policyRuleId: "r-1",
            recrawlIntervalMs: 86_400_000,
            nextCrawlAt: "2026-08-19T00:00:00.000Z",
            rowVersion: 2,
          } as never)
        : null;
    },
  };

  const app = Fastify();
  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization;
    if (header !== `Bearer ${PTH_TOKEN}`) {
      return reply.status(401).send({ error: "Invalid token" });
    }
    (req as unknown as { auth: unknown }).auth = {
      tenantId: "default",
      role: "platform-admin",
      principalId: "p-operator",
      space: "ts",
    };
  });
  registerKernelRoutes(app, createPthGatewayFacade(kernel));
  registerIntakeRoutes(app, intakeService);
  return app;
}

// ─── console HTTP helper ───

interface ConsoleResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => Record<string, never>;
}

async function call(
  app: OperatorConsoleServer,
  method: string,
  path: string,
  opts: { json?: unknown; cookie?: string; csrf?: string; origin?: string } = {},
): Promise<ConsoleResponse> {
  await app.listen();
  const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
  const headers: Record<string, string> = {
    host: app.hostHeader,
    origin: opts.origin ?? app.origin,
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.csrf ? { "x-ptl-csrf": opts.csrf } : {}),
  };
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: app.port, path, method, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { raw += c; });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: raw,
          json: () => JSON.parse(raw),
        });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function sessionCookieOf(res: ConsoleResponse): string {
  const sc = res.headers["set-cookie"];
  const list = Array.isArray(sc) ? sc : [String(sc ?? "")];
  return list.find((c) => c.startsWith("ptl-operator="))?.split(";")[0] ?? "";
}

describe("operator console work 通道（组合集成）", () => {
  const pthState: PthState = { publishedTasks: [], intakeCalls: [], suggestionStatus: "draft", suggestionUpdates: [] };
  let pthApp: ReturnType<typeof buildFakePth>;
  let pthPort: number;
  let console1: OperatorConsoleServer;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    pthApp = buildFakePth(pthState);
    await pthApp.listen({ port: 0, host: "127.0.0.1" });
    const address = pthApp.server.address();
    pthPort = typeof address === "object" && address ? address.port : 0;

    console1 = createOperatorConsoleServer({
      bootstrapToken: BOOTSTRAP_TOKEN,
      operatorPrincipalId: "human-it",
      pth: { baseUrl: `http://127.0.0.1:${pthPort}`, token: PTH_TOKEN },
      n30: {},
      tenant: "default",
      space: "ts",
    });
    await console1.listen();

    const boot = await call(console1, "POST", "/api/session/bootstrap", { json: { token: BOOTSTRAP_TOKEN } });
    expect(boot.status).toBe(200);
    cookie = sessionCookieOf(boot);
    csrf = boot.json().csrfToken;
  });

  afterAll(async () => {
    await console1?.close();
    await pthApp?.close();
  });

  it("未认证访问 work API → 401；静态资源与 API 响应均不含 PTH token", async () => {
    const anon = await call(console1, "GET", "/api/work/actions");
    expect(anon.status).toBe(401);
    const html = await call(console1, "GET", "/");
    const js = await call(console1, "GET", "/app.js");
    const css = await call(console1, "GET", "/styles.css");
    for (const res of [html, js, css, anon]) {
      expect(res.body).not.toContain(PTH_TOKEN);
    }
  });

  it("actions 列表：恰好四个登记动作", async () => {
    const res = await call(console1, "GET", "/api/work/actions", { cookie });
    expect(res.status).toBe(200);
    const keys = res.json().actions.map((a: { mode: string; action: string }) => `${a.mode}/${a.action}`).sort();
    expect(keys).toEqual([
      "intake/run.trigger",
      "intake/subscription.create",
      "optimize/suggestion.apply",
      "run/task.publish",
    ]);
    expect(res.body).not.toContain(PTH_TOKEN);
  });

  it("缺 CSRF 的 preview → 401", async () => {
    const res = await call(console1, "POST", "/api/work/preview", {
      cookie,
      json: { mode: "run", action: "task.publish", input: { title: "t", text: "x" } },
    });
    expect(res.status).toBe(401);
  });

  it("run/task.publish：preview → digest 错拒 → submit → native 状态 → evaluate", async () => {
    const previewRes = await call(console1, "POST", "/api/work/preview", {
      cookie, csrf,
      json: { mode: "run", action: "task.publish", input: { title: "集成巡检", text: "check", tags: ["it"] } },
    });
    expect(previewRes.status).toBe(200);
    const { preview, tenant, space } = previewRes.json();
    expect(tenant).toBe("default");
    expect(space).toBe("ts");
    expect(preview.nativeTarget).toBe("pth:/api/v1/kernel/tasks");

    const badDigest = await call(console1, "POST", "/api/work/submit", {
      cookie, csrf,
      json: { previewId: preview.previewId, previewDigest: "0".repeat(64), idempotencyKey: "k-it-1" },
    });
    expect(badDigest.status).toBe(400);
    expect(badDigest.json().error.code).toBe("DIGEST_MISMATCH");

    const submit = await call(console1, "POST", "/api/work/submit", {
      cookie, csrf,
      json: { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-it-1" },
    });
    expect(submit.status).toBe(200);
    const ref = submit.json().ref;
    expect(ref).toMatchObject({ mode: "run", kind: "task", id: "task-xyz", tenantId: "default" });

    // WorkEnvelope 服务端盖章经 payload 抵达 PTH
    const published = pthState.publishedTasks.at(-1)!;
    expect(published.payload).toMatchObject({
      work: { mode: "run", objective: "集成巡检", causationId: preview.previewId },
    });
    expect(published.tenantId).toBe("default");

    // 重放同一 preview → 409 consumed
    const replay = await call(console1, "POST", "/api/work/submit", {
      cookie, csrf,
      json: { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-it-2" },
    });
    expect(replay.status).toBe(409);

    const native = await call(console1, "GET", `/api/work/native/task/task-xyz?mode=run`, { cookie });
    expect(native.status).toBe(200);
    expect(native.json().projection.status).toBe("completed");

    const acceptance = await call(console1, "POST", "/api/work/evaluate", {
      cookie, csrf,
      json: { mode: "run", kind: "task", id: "task-xyz" },
    });
    expect(acceptance.status).toBe(200);
    expect(acceptance.json().acceptance.accepted).toBe(true);
  });

  it("intake/subscription.create：高风险 preview → submit 触达 PTH 手动控制面（scope 来自 token）", async () => {
    const previewRes = await call(console1, "POST", "/api/work/preview", {
      cookie, csrf,
      json: {
        mode: "intake",
        action: "subscription.create",
        input: {
          canonicalUri: "https://example.com/docs",
          domainId: "web",
          recrawlIntervalMs: 86_400_000,
          declared: { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" },
        },
      },
    });
    expect(previewRes.status).toBe(200);
    const { preview } = previewRes.json();
    expect(preview.impact.risk).toBe("high");

    const submit = await call(console1, "POST", "/api/work/submit", {
      cookie, csrf,
      json: { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-it-sub" },
    });
    expect(submit.status).toBe(200);
    expect(submit.json().ref).toMatchObject({ mode: "intake", kind: "intake-run", id: "sub-it-1" });

    const call1 = pthState.intakeCalls.find((c) => c.method === "createSubscription")!;
    expect(call1.scope).toEqual({ tenantId: "default" });
    const input = call1.args[0] as Record<string, unknown>;
    expect(input.space).toBe("ts"); // 来自 PTH auth token 声明
    expect(input.idempotencyKey).toBe(preview.previewId);

    const acceptance = await call(console1, "POST", "/api/work/evaluate", {
      cookie, csrf,
      json: { mode: "intake", kind: "intake-run", id: "sub-it-1" },
    });
    expect(acceptance.status).toBe(200);
    expect(acceptance.json().acceptance.accepted).toBe(true);
    expect(acceptance.json().acceptance.evidence.policyDigest).toBe("d".repeat(64));
  });

  it("intake/run.trigger：preview/submit/inspect 全链路（原生幂等键 = previewId）", async () => {
    const previewRes = await call(console1, "POST", "/api/work/preview", {
      cookie, csrf,
      json: { mode: "intake", action: "run.trigger", input: { subscriptionId: "sub-it-1" } },
    });
    expect(previewRes.status).toBe(200);
    const { preview } = previewRes.json();
    const submit = await call(console1, "POST", "/api/work/submit", {
      cookie, csrf,
      json: { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-it-run" },
    });
    expect(submit.status).toBe(200);
    expect(submit.json().ref.id).toBe("run-it-1");
    const trigger = pthState.intakeCalls.find((c) => c.method === "triggerSubscriptionRun")!;
    expect(trigger.args).toEqual(["sub-it-1", preview.previewId]);

    const native = await call(console1, "GET", `/api/work/native/intake-run/run-it-1?mode=intake`, { cookie });
    expect(native.status).toBe(200);
    expect(native.json().projection.status).toBe("completed@complete");
  });

  it("optimize/suggestion.apply：可见 draft → apply → evaluate accepted（guard 由 PTH 保留）", async () => {
    const previewRes = await call(console1, "POST", "/api/work/preview", {
      cookie, csrf,
      json: { mode: "optimize", action: "suggestion.apply", input: { suggestionId: "sug-1" } },
    });
    expect(previewRes.status).toBe(200);
    const { preview } = previewRes.json();
    const submit = await call(console1, "POST", "/api/work/submit", {
      cookie, csrf,
      json: { previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k-it-opt" },
    });
    expect(submit.status).toBe(200);
    expect(submit.json().ref).toMatchObject({ mode: "optimize", kind: "optimizer-work", id: "sug-1" });
    // deopt/canary 护栏链路仍在：suggestion 被置 official（fake store 记录 update）
    expect(pthState.suggestionUpdates.some((u) => u.id === "sug-1" && u.status === "official")).toBe(true);

    const acceptance = await call(console1, "POST", "/api/work/evaluate", {
      cookie, csrf,
      json: { mode: "optimize", kind: "optimizer-work", id: "sug-1" },
    });
    expect(acceptance.status).toBe(200);
    expect(acceptance.json().acceptance.accepted).toBe(true);
  });

  it("未登记动作 / 未知 API → 404；任意字段输入在触达 PTH 前拒绝", async () => {
    const unknownAction = await call(console1, "POST", "/api/work/preview", {
      cookie, csrf,
      json: { mode: "run", action: "http.request", input: {} },
    });
    expect(unknownAction.status).toBe(404);

    const forged = await call(console1, "POST", "/api/work/preview", {
      cookie, csrf,
      json: { mode: "run", action: "task.publish", input: { title: "t", text: "x", command: "sh -c id" } },
    });
    expect(forged.status).toBe(404);
    expect(pthState.publishedTasks).toHaveLength(1); // 只有前面成功的那一次

    const notFound = await call(console1, "GET", "/api/work/unknown", { cookie });
    expect(notFound.status).toBe(404);
  });
});
