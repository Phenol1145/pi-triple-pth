/**
 * kernel-host-debug.ts —— gdb 调试会话路由（模块专项 ② 大文件拆分：自 kernel-host.ts 抽出）。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CDebugSession } from "./gdb-mi.js";

export interface KernelDebugContext {
  enforceAuth(req: FastifyRequest, reply: any): boolean;
  maxSessions: number;
  idleMs: number;
  workRoot: string;
}

export interface KernelDebugHandle {
  sessions: Map<string, { session: CDebugSession; lastUsedAt: number }>;
  statusInfo(): { sessions: number; maxSessions: number };
  dispose(): Promise<void>;
}

export function registerKernelDebugRoutes(app: FastifyInstance, ctx: KernelDebugContext): KernelDebugHandle {
  const debugSessions = new Map<string, { session: CDebugSession; lastUsedAt: number }>();
  const debugMaxSessions = ctx.maxSessions;
  const debugIdleMs = ctx.idleMs;
  const debugWorkRoot = ctx.workRoot;
  const enforceAuth = ctx.enforceAuth;
  // ── 调试核（2026-08-09 Phase 2：debug 落 sandbox 侧——gdb 工具链已装）────────────
  // 会话管理：Map<id, CDebugSession> + idle 清理（30min 无操作 detach——防 gdb 泄漏）
  // 并发上限 PTH_DEBUG_SESSIONS（默认 4——gdb 进程资源约束）
  const getSession = (id: string): CDebugSession | null => {
    const rec = debugSessions.get(id);
    if (!rec) return null;
    rec.lastUsedAt = Date.now();
    return rec.session;
  };
  // idle 清理循环（30s 周期——unref 不阻止退出）
  setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of debugSessions) {
      if (now - rec.lastUsedAt > debugIdleMs) {
        rec.session.detach().catch(() => {});
        debugSessions.delete(id);
      }
    }
  }, 30_000).unref?.();

  const debugErr = (reply: any, msg: string, code = 400) => reply.code(code).send({ error: msg });

  // POST /kernel/debug/attach {code, cc?} → {sessionId}
  app.post("/kernel/debug/attach", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    if (debugSessions.size >= debugMaxSessions) return debugErr(reply, `debug 会话数上限 ${debugMaxSessions} 已达`, 503);
    const { code, cc } = (req.body ?? {}) as { code?: string; cc?: string };
    if (typeof code !== "string" || code.length === 0) return debugErr(reply, "code required");
    const ccBin = cc === "gcc" ? "gcc" : cc === "clang" ? "clang" : cc === "tcc" ? "tcc" : undefined;
    const session = new CDebugSession({
      workDir: debugWorkRoot,
      cc: ccBin ?? "cc",
      onEvent: (e) => { /* 调试事件——后续接 metrics */ void e; },
    });
    if (debugSessions.has(session.id)) {
      // S1-3：UUID 碰撞兜底（理论不可能，但不允许静默覆盖会话）
      return debugErr(reply, `debug session id collision: ${session.id}`, 503);
    }
    try {
      await session.attach(code);
      debugSessions.set(session.id, { session, lastUsedAt: Date.now() });
      return { sessionId: session.id };
    } catch (e) {
      return debugErr(reply, `attach 失败: ${(e as Error).message}`, 500);
    }
  });

  const withSession = async (
    req: FastifyRequest, reply: any,
    fn: (session: CDebugSession) => Promise<unknown>,
  ) => {
    if (!enforceAuth(req, reply)) return;
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId) return debugErr(reply, "sessionId required");
    const session = getSession(sessionId);
    if (!session) return debugErr(reply, `session not found/expired: ${sessionId}`, 404);
    try {
      return await fn(session);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  app.post("/kernel/debug/breakpoint", (req, reply) => withSession(req, reply, async (s) => {
    const { line, condition } = (req.body ?? {}) as { line?: number; condition?: string };
    if (typeof line !== "number") return debugErr(reply, "line (number) required");
    return await s.setBreakpoint(line, condition);
  }));
  app.post("/kernel/debug/continue", (req, reply) => withSession(req, reply, (s) => s.continueExec()));
  app.post("/kernel/debug/step", (req, reply) => withSession(req, reply, (s) => {
    const { direction } = (req.body ?? {}) as { direction?: "into" | "over" | "out" };
    return s.step(direction ?? "into");
  }));
  app.post("/kernel/debug/snapshot", (req, reply) => withSession(req, reply, (s) => s.snapshot()));
  app.post("/kernel/debug/stack", (req, reply) => withSession(req, reply, (s) => s.stack()));
  app.post("/kernel/debug/variables", (req, reply) => withSession(req, reply, (s) => {
    const { frameId } = (req.body ?? {}) as { frameId?: number };
    return s.variables(frameId);
  }));
  app.post("/kernel/debug/evaluate", (req, reply) => withSession(req, reply, (s) => {
    const { expr, frameId } = (req.body ?? {}) as { expr?: string; frameId?: number };
    if (typeof expr !== "string" || expr.length === 0) return debugErr(reply, "expr required");
    return s.evaluate(expr, frameId);
  }));
  app.post("/kernel/debug/detach", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId) return debugErr(reply, "sessionId required");
    const rec = debugSessions.get(sessionId);
    if (!rec) return debugErr(reply, `session not found: ${sessionId}`, 404);
    try {
      await rec.session.detach();
    } catch { /* 容错 */ }
    debugSessions.delete(sessionId);
    return { ok: true };
  });
  app.get("/kernel/debug/sessions", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    return [...debugSessions.entries()].map(([id, rec]) => ({ id, lastUsedAt: rec.lastUsedAt, language: rec.session.language }));
  });


  return {
    sessions: debugSessions,
    statusInfo: () => ({ sessions: debugSessions.size, maxSessions: debugMaxSessions }),
    async dispose() {
      for (const [, rec] of debugSessions) {
        try { await rec.session.detach(); } catch { /* 容错 */ }
      }
      debugSessions.clear();
    },
  };
}
