/**
 * kernel-session-host.ts —— sandbox persistent 会话宿主（P4，2026-08-22）。
 *
 * 把 kernel-host 的共享池暴露为 execution/v1.1 persistent wire：
 *   POST /sessions                      → create（私有 header 携带 lang + grant 绑定）
 *   GET  /sessions/:id                  → 会话状态（lease/snapshot 计数）
 *   POST /sessions/:id/execute          → 在租约内核上执行（自动续租）
 *   POST /sessions/:id/snapshot         → 导出 kernel 状态快照（refine 消费）
 *   POST /sessions/:id/reset            → 只支持回会话初始状态；
 *                                          reset(snapshotId) = MODE_NOT_SUPPORTED（2026-08-22 裁决）
 *   POST /sessions/:id/release          → 归还池条目（幂等）
 *
 * 授权（用户裁决 2026-08-22）：
 *  - wire body 不变；create 必带 `x-sandbox-kernel-lang`（python|bash）与
 *    `x-sandbox-grant`（base64url(JSON) 签名 grant）——sandbox 在会话层盖章
 *    taskId/tenantId 绑定，等价于旧 /kernel/acquire 的 per-task 防混用；
 *  - execute 若再带 grant 头则必须与创建时绑定一致，否则沿用已盖章绑定。
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EXECUTION_WIRE,
  ExecutionClientError,
  ExecutionSessionManager,
  type ExecutionResult,
  type ExecutionSessionBackend,
} from "@away_from/shared/execution";
import { KernelPool, type KernelLang } from "./kernel-pool.js";
import type { SandboxLease } from "./kernel-lease.js";
import type { SandboxGrantVerifier } from "./authorization/grant-verifier.js";
import { sandboxGrantFromHeader } from "./authorization/grant-verifier.js";

const SESSION_LANG_HEADER = "x-sandbox-kernel-lang";
const SESSION_GRANT_HEADER = "x-sandbox-grant";
const SESSION_EXEC_HEADER = "x-sandbox-kernel-exec";
const SESSION_SPACE_HEADER = "x-sandbox-kernel-space";

interface KernelSessionContext {
  readonly lang: KernelLang;
}

interface SessionBinding {
  readonly taskId: string;
  readonly tenantId: string;
}

export interface KernelSessionHostDeps {
  readonly pools: Record<KernelLang, KernelPool>;
  readonly getSecret: () => string | undefined;
  readonly grantVerifier?: SandboxGrantVerifier;
}

export interface KernelSessionHostHandle {
  readonly manager: ExecutionSessionManager;
}

function isKernelLang(value: unknown): value is KernelLang {
  return value === "python" || value === "bash";
}

/** KernelPool lease → ExecutionSessionBackend（token = SandboxLease.id，永不出 HTTP）。 */
class KernelPoolSessionBackend implements ExecutionSessionBackend {
  private readonly entries = new Map<string, { pool: KernelPool; lease: SandboxLease }>();

  constructor(private readonly pools: Record<KernelLang, KernelPool>) {}

  async createSession(context?: unknown): Promise<string> {
    const lang = (context as KernelSessionContext | undefined)?.lang;
    if (!isKernelLang(lang)) {
      throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.invalidRequest, `invalid session kernel lang: ${String(lang)}`);
    }
    try {
      const lease = await this.pools[lang].acquire();
      this.entries.set(lease.id, { pool: this.pools[lang], lease });
      return lease.id;
    } catch (error) {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.backendUnavailable,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private entry(token: string): { pool: KernelPool; lease: SandboxLease } {
    const entry = this.entries.get(token);
    if (!entry) {
      throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.sessionExpired, "sandbox kernel session entry is gone (pool TTL or stale lease)");
    }
    return entry;
  }

  async execute(
    token: string,
    request: { cmd: string | string[]; timeoutMs?: number },
    context?: unknown,
  ): Promise<ExecutionResult> {
    const entry = this.entry(token);
    const code = typeof request.cmd === "string"
      ? request.cmd
      : request.cmd.length === 1
        ? request.cmd[0]!
        : null;
    if (code === null) {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.invalidRequest,
        "sandbox persistent execute cmd must be a code string（kernel REPL，不接受 argv 数组）",
      );
    }
    const ctx = (context ?? {}) as { exec?: unknown; space?: unknown };
    if (ctx.exec !== undefined && ctx.exec !== "single" && ctx.exec !== "program" && ctx.exec !== "auto") {
      throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.invalidRequest, `invalid x-sandbox-kernel-exec: ${String(ctx.exec)}`);
    }
    if (ctx.space !== undefined && (typeof ctx.space !== "string" || ctx.space.length === 0 || ctx.space.length > 128)) {
      throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.invalidRequest, "invalid x-sandbox-kernel-space");
    }
    try {
      const result = await entry.pool.execute(entry.lease, code, {
        timeoutMs: request.timeoutMs,
        ...(ctx.exec !== undefined ? { exec: ctx.exec as "single" | "program" | "auto" } : {}),
        ...(typeof ctx.space === "string" ? { space: ctx.space } : {}),
      });
      const truncated = result.truncated && (result.truncated.field === "stdout" || result.truncated.field === "stderr")
        ? result.truncated as ExecutionResult["truncated"]
        : undefined;
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.ok ? 0 : 1,
        timedOut: false,
        ...(result.value !== undefined ? { value: result.value } : {}),
        ...(truncated ? { truncated } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("stale lease")) {
        throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.sessionExpired, error.message);
      }
      throw error;
    }
  }

  async snapshot(token: string): Promise<{ snapshotId: string; state?: unknown }> {
    const entry = this.entry(token);
    try {
      const state = await entry.pool.snapshot(entry.lease);
      return { snapshotId: randomUUID(), state };
    } catch (error) {
      if (error instanceof Error && error.message.includes("stale lease")) {
        throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.sessionExpired, error.message);
      }
      throw error;
    }
  }

  async reset(token: string, snapshotId?: string): Promise<void> {
    if (snapshotId !== undefined) {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.modeNotSupported,
        "snapshot restore is not supported: sandbox kernels can only reset to the initial session state",
      );
    }
    const entry = this.entry(token);
    await entry.pool.reset(entry.lease);
  }

  async release(token: string): Promise<void> {
    const entry = this.entries.get(token);
    if (!entry) return; // 幂等：池 TTL 已回收/重复 release 无副作用
    this.entries.delete(token);
    try {
      entry.pool.release(entry.lease);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("stale lease"))) throw error;
      // 池 TTL 已回收 = 已释放；会话层按幂等成功处理
    }
  }
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendWireError(reply: FastifyReply, error: unknown): void {
  const status = error instanceof ExecutionClientError
    ? error.status ?? (error.code === EXECUTION_WIRE.errorCodes.notFound || error.code === EXECUTION_WIRE.errorCodes.snapshotNotFound ? 404 : 400)
    : 500;
  const code = error instanceof ExecutionClientError ? error.code : EXECUTION_WIRE.errorCodes.internalError;
  const message = error instanceof Error ? error.message : String(error);
  reply.code(status).send({ error: { code, message } });
}

/**
 * 注册 persistent 会话路由（与 exec API / kernel-host 同端口）。
 * 会话管理器共享 kernel-host 的同一对语言池——不复制池容量。
 */
export function registerKernelSessionHost(app: FastifyInstance, deps: KernelSessionHostDeps): KernelSessionHostHandle {
  const backend = new KernelPoolSessionBackend(deps.pools);
  const manager = new ExecutionSessionManager({ backend });
  const bindings = new Map<string, SessionBinding>();

  const checkAuth = (req: FastifyRequest): "ok" | "unauthorized" | "misconfigured" => {
    const secret = deps.getSecret();
    if (!secret) return "misconfigured";
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
    return token === secret ? "ok" : "unauthorized";
  };

  const enforceAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const auth = checkAuth(req);
    if (auth === "ok") return true;
    reply.code(auth === "misconfigured" ? 503 : 401).send({
      error: { code: auth === "misconfigured" ? EXECUTION_WIRE.errorCodes.serverMisconfigured : EXECUTION_WIRE.errorCodes.unauthorized, message: auth === "misconfigured" ? "server misconfigured: SANDBOX_SHARED_SECRET not set" : "unauthorized" },
    });
    return false;
  };

  const requireBinding = (sessionId: string): SessionBinding => {
    const binding = bindings.get(sessionId);
    if (!binding) throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.notFound, "session binding not found", 404);
    return binding;
  };

  /** create：私有 header 携带 lang + 签名 grant，会话层盖章 task/tenant 绑定。 */
  app.post(EXECUTION_WIRE.paths.sessions, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    if (!deps.grantVerifier) {
      reply.code(503).send({ error: { code: EXECUTION_WIRE.errorCodes.serverMisconfigured, message: "server misconfigured: execution grant verifier not configured" } });
      return;
    }
    const lang = headerValue(req, SESSION_LANG_HEADER);
    if (!isKernelLang(lang)) {
      reply.code(400).send({ error: { code: EXECUTION_WIRE.errorCodes.invalidRequest, message: `invalid x-sandbox-kernel-lang: ${String(lang)}` } });
      return;
    }
    const grantHeader = headerValue(req, SESSION_GRANT_HEADER);
    if (!grantHeader) {
      reply.code(401).send({ error: { code: EXECUTION_WIRE.errorCodes.unauthorized, message: "x-sandbox-grant header required" } });
      return;
    }
    const verified = deps.grantVerifier.verify(sandboxGrantFromHeader(grantHeader));
    if (!verified.ok) {
      reply.code(401).send({ error: { code: EXECUTION_WIRE.errorCodes.unauthorized, message: verified.error } });
      return;
    }
    try {
      const created = await manager.create(req.body ?? {}, { lang } satisfies KernelSessionContext);
      bindings.set(created.sessionId, {
        taskId: verified.grant.lease.taskId,
        tenantId: verified.grant.scope.tenantId,
      });
      return created;
    } catch (error) {
      return sendWireError(reply, error);
    }
  });

  app.get(EXECUTION_WIRE.paths.session, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    try {
      return manager.get((req.params as { id: string }).id);
    } catch (error) {
      return sendWireError(reply, error);
    }
  });

  const bindingMatch = (verifiedTaskId: string, verifiedTenantId: string, binding: SessionBinding): boolean =>
    binding.taskId === verifiedTaskId && binding.tenantId === verifiedTenantId;

  const verifyOptionalGrant = (req: FastifyRequest, reply: FastifyReply, binding: SessionBinding): boolean => {
    const grantHeader = headerValue(req, SESSION_GRANT_HEADER);
    if (!grantHeader) return true; // 创建时已盖章；后续请求不强制重复携带
    if (!deps.grantVerifier) {
      reply.code(503).send({ error: { code: EXECUTION_WIRE.errorCodes.serverMisconfigured, message: "server misconfigured: execution grant verifier not configured" } });
      return false;
    }
    const verified = deps.grantVerifier.verify(sandboxGrantFromHeader(grantHeader));
    if (!verified.ok) {
      reply.code(401).send({ error: { code: EXECUTION_WIRE.errorCodes.unauthorized, message: verified.error } });
      return false;
    }
    if (!bindingMatch(verified.grant.lease.taskId, verified.grant.scope.tenantId, binding)) {
      reply.code(403).send({ error: { code: EXECUTION_WIRE.errorCodes.unauthorized, message: "session grant binding mismatch" } });
      return false;
    }
    return true;
  };

  app.post(EXECUTION_WIRE.paths.sessionExecute, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const sessionId = (req.params as { id: string }).id;
    try {
      const binding = requireBinding(sessionId);
      if (!verifyOptionalGrant(req, reply, binding)) return;
      return await manager.execute(sessionId, req.body ?? {}, {
        ...(headerValue(req, SESSION_EXEC_HEADER) !== undefined ? { exec: headerValue(req, SESSION_EXEC_HEADER) } : {}),
        ...(headerValue(req, SESSION_SPACE_HEADER) !== undefined ? { space: headerValue(req, SESSION_SPACE_HEADER) } : {}),
      });
    } catch (error) {
      return sendWireError(reply, error);
    }
  });

  app.post(EXECUTION_WIRE.paths.sessionSnapshot, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const sessionId = (req.params as { id: string }).id;
    try {
      requireBinding(sessionId);
      return await manager.snapshot(sessionId, req.body ?? {});
    } catch (error) {
      return sendWireError(reply, error);
    }
  });

  app.post(EXECUTION_WIRE.paths.sessionReset, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const sessionId = (req.params as { id: string }).id;
    try {
      requireBinding(sessionId);
      return await manager.reset(sessionId, req.body ?? {});
    } catch (error) {
      return sendWireError(reply, error);
    }
  });

  app.post(EXECUTION_WIRE.paths.sessionRelease, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const sessionId = (req.params as { id: string }).id;
    try {
      requireBinding(sessionId);
      return await manager.release(sessionId);
    } catch (error) {
      return sendWireError(reply, error);
    }
  });

  app.addHook("onClose", async () => {
    bindings.clear();
    await manager.close();
  });

  return { manager };
}
