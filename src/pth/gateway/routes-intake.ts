/**
 * gateway/routes-intake.ts — N33 Task 5 Step 5：intake 原生动作窄端点。
 *
 *   POST /api/v1/intake/subscriptions        创建订阅（probing；走既有正式入口）
 *   GET  /api/v1/intake/subscriptions/:id    订阅状态（tenant 域内）
 *   POST /api/v1/intake/runs                 手动触发一次摄入 run（幂等键去重）
 *   GET  /api/v1/intake/runs/:id             run 状态（tenant 域内）
 *
 * 硬约束：
 *  - scope（tenant/space）只能来自 auth token 声明；body 自报 space/tenant 一律 400；
 *  - manifest/私钥/policy 正文永远不出现在请求体（出现即 400）；
 *  - body 字段白名单：path/method/command/sql/url 等任意字段在触达 service 前 400；
 *  - run.trigger 不接受任意 URL——抓取目标永远来自订阅行；
 *  - service 未装配 → 全部 503（fail-open 约定，同 routes-kernel）。
 */

import type { FastifyInstance } from "fastify";
import {
  IntakeManualControlError,
  type IntakeManualControlService,
  type ManualSubscribeInput,
} from "../execution/knowledge-intake/manual-control.js";

const INTAKE_UNAVAILABLE = {
  error: "intake unavailable",
  reason: "intake 手动控制面未装配（缺 DATABASE_URL 或 TrustPolicy manifest/keyring）",
};

/** 永远不被接受的字段：任意路径/方法/命令/SQL/URL 与 policy 材料。 */
const FORBIDDEN_BODY_KEYS = new Set([
  "path",
  "method",
  "command",
  "sql",
  "url",
  "manifest",
  "privateKey",
  "keyring",
  "policy",
  "policyManifest",
  "token",
  "secret",
  "tenant",
  "tenantId",
  "space",
]);

const SUBSCRIPTION_FIELDS = new Set([
  "canonicalUri",
  "domainId",
  "recrawlIntervalMs",
  "declared",
  "idempotencyKey",
  "expectedPolicyId",
  "expectedPolicyVersion",
  "expectedPolicyDigest",
]);

const RUN_FIELDS = new Set(["subscriptionId", "idempotencyKey"]);

const DECLARED_FIELDS = new Set(["sourceType", "contentType", "license"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 白名单校验；返回错误消息或 null。 */
function validateBody(body: unknown, allowed: Set<string>): string | null {
  if (!isPlainRecord(body)) return "body must be a JSON object";
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) {
      return `field "${key}" is never accepted on intake routes（scope 来自 auth token；policy 材料不出现在请求体）`;
    }
    if (!allowed.has(key)) return `unknown field "${key}"`;
  }
  return null;
}

function authOf(req: unknown): { tenantId?: string; space?: string } {
  return (req as { auth?: { tenantId?: string; space?: string } }).auth ?? {};
}

export function registerIntakeRoutes(
  app: FastifyInstance,
  service: IntakeManualControlService | null,
): void {
  const unavailable = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(503).send(INTAKE_UNAVAILABLE);

  app.post("/api/v1/intake/subscriptions", async (req, reply) => {
    if (!service) return unavailable(reply);
    const auth = authOf(req);
    if (!auth.tenantId) {
      return reply.status(401).send({ error: "intake subscription requires authenticated tenant" });
    }
    const bodyError = validateBody(req.body ?? {}, SUBSCRIPTION_FIELDS);
    if (bodyError) return reply.status(400).send({ error: bodyError });
    if (!auth.space) {
      return reply.status(400).send({ error: "intake subscription requires an auth token space claim" });
    }
    const body = req.body as Record<string, unknown>;
    const canonicalUri = typeof body.canonicalUri === "string" ? body.canonicalUri.trim() : "";
    const domainId = typeof body.domainId === "string" ? body.domainId.trim() : "";
    if (!canonicalUri || !domainId) {
      return reply.status(400).send({ error: "canonicalUri/domainId required" });
    }
    const recrawlIntervalMs = body.recrawlIntervalMs;
    if (typeof recrawlIntervalMs !== "number" || !Number.isFinite(recrawlIntervalMs) || recrawlIntervalMs <= 0) {
      return reply.status(400).send({ error: "recrawlIntervalMs must be a positive finite number" });
    }
    if (!isPlainRecord(body.declared)) {
      return reply.status(400).send({ error: "declared must be an object" });
    }
    for (const key of Object.keys(body.declared)) {
      if (!DECLARED_FIELDS.has(key)) {
        return reply.status(400).send({ error: `unknown declared field "${key}"` });
      }
    }
    const declared = body.declared as Record<string, unknown>;
    if (
      typeof declared.sourceType !== "string" ||
      typeof declared.contentType !== "string" ||
      typeof declared.license !== "string"
    ) {
      return reply.status(400).send({ error: "declared.sourceType/contentType/license required (strings)" });
    }
    const idempotencyKey = body.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "")) {
      return reply.status(400).send({ error: "idempotencyKey must be a non-empty string when present" });
    }
    const expected: Record<string, string> = {};
    for (const [field, target] of [
      ["expectedPolicyId", "id"],
      ["expectedPolicyVersion", "version"],
      ["expectedPolicyDigest", "digest"],
    ] as const) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== "string" || (body[field] as string).trim() === "") {
          return reply.status(400).send({ error: `${field} must be a non-empty string when present` });
        }
        expected[target] = (body[field] as string).trim();
      }
    }

    const input: ManualSubscribeInput = {
      space: auth.space,
      canonicalUri,
      domainId,
      recrawlIntervalMs,
      declared: {
        sourceType: declared.sourceType as string,
        contentType: declared.contentType as string,
        license: declared.license as string,
      },
      ...(idempotencyKey !== undefined ? { idempotencyKey: idempotencyKey.trim() } : {}),
      ...(Object.keys(expected).length > 0
        ? { expectedPolicy: expected as ManualSubscribeInput["expectedPolicy"] & object }
        : {}),
    };
    try {
      const subscription = await service.createSubscription({ tenantId: auth.tenantId }, input);
      return reply.status(201).send(subscription);
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get("/api/v1/intake/subscriptions/:id", async (req, reply) => {
    if (!service) return unavailable(reply);
    const auth = authOf(req);
    if (!auth.tenantId) {
      return reply.status(401).send({ error: "intake subscription status requires authenticated tenant" });
    }
    const { id } = req.params as { id: string };
    const subscription = await service.getSubscription({ tenantId: auth.tenantId }, id);
    if (!subscription) return reply.status(404).send({ error: "subscription not found" });
    return subscription;
  });

  app.post("/api/v1/intake/runs", async (req, reply) => {
    if (!service) return unavailable(reply);
    const auth = authOf(req);
    if (!auth.tenantId) {
      return reply.status(401).send({ error: "intake run trigger requires authenticated tenant" });
    }
    const bodyError = validateBody(req.body ?? {}, RUN_FIELDS);
    if (bodyError) return reply.status(400).send({ error: bodyError });
    const body = req.body as Record<string, unknown>;
    const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    if (!subscriptionId || !idempotencyKey) {
      return reply.status(400).send({ error: "subscriptionId/idempotencyKey required" });
    }
    try {
      const run = await service.triggerSubscriptionRun(
        { tenantId: auth.tenantId },
        subscriptionId,
        idempotencyKey,
      );
      return reply.status(201).send(run);
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get("/api/v1/intake/runs/:id", async (req, reply) => {
    if (!service) return unavailable(reply);
    const auth = authOf(req);
    if (!auth.tenantId) {
      return reply.status(401).send({ error: "intake run status requires authenticated tenant" });
    }
    const { id } = req.params as { id: string };
    const run = await service.getRun({ tenantId: auth.tenantId }, id);
    if (!run) return reply.status(404).send({ error: "intake run not found" });
    return run;
  });
}

function sendServiceError(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  err: unknown,
): unknown {
  if (err instanceof IntakeManualControlError) {
    const status =
      err.code === "SUBSCRIPTION_NOT_FOUND"
        ? 404
        : err.code === "POLICY_MISMATCH" || err.code === "SUBSCRIPTION_NOT_ELIGIBLE"
          ? 409
          : 400;
    return reply.status(status).send({ error: err.message, code: err.code });
  }
  // 既有订阅服务/TrustPolicy 门禁拒绝（KnowledgeIntakeServiceError 等）：一律 400，不上抛 500。
  const message = err instanceof Error ? err.message : String(err);
  return reply.status(400).send({ error: message });
}
