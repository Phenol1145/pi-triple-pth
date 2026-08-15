/**
 * kernel-host.ts — sandbox 侧 kernel 宿主服务（kernel sandbox SPEC §3.2）
 *
 * 职责：托管 PyKernel/BashKernel 共享池，通过 HTTP 协议向 PTH 侧提供持久 REPL。
 *
 * 接口：
 *   POST /kernel/acquire  { lang: "python"|"bash" } → { kernelId }
 *   POST /kernel/execute  { kernelId, code, timeoutMs? } → InterpreterResult
 *   POST /kernel/reset    { kernelId } → { ok: true }（ns 清命名空间）
 *   POST /kernel/snapshot { kernelId } → InterpreterSnapshot（refine 价值抽取）
 *   POST /kernel/release  { kernelId } → { ok: true }
 *   GET  /kernel/status             → { pools: [{ lang, inFlight, idle, size, capacity }] }
 *   GET  /health                    → { status: "ok" }（无认证——内网可达，compose healthcheck）
 *
 * 安全边界（敏感信息 SPEC §4.5）：
 *   - 共享密钥认证（SANDBOX_SHARED_SECRET，与 exec API 同源）——fail-closed
 *   - execute 请求体【拒绝 env 字段】（400）——sandbox 侧零业务密钥
 *   - 池内 kernel 无出网（compose internal 网络）+ 无业务密钥 env
 */

import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { KernelPool, type KernelLang } from "./kernel-pool.js";
import { CCompiledKernel } from "./compiled-kernel.js";
import { CDebugSession } from "./gdb-mi.js";

/** 编译核统计（/kernel/status 聚合——PTH obs.kernels 可查） */
export interface CompiledStats {
  cacheHits: number;
  coldCompiles: number;
  avgCompileMs: number;
  totalMs: number;
  cacheEntries: number;
}

export interface KernelHostOptions {
  /** 各语言池容量（默认 4） */
  poolSize?: number;
  /** 共享密钥获取器（默认读 env SANDBOX_SHARED_SECRET——每次请求读取，测试可注入） */
  getSecret?: () => string | undefined;
  /** PTH 记忆桥 Bearer token 获取器（默认读 env PTH_MEMORY_BRIDGE_TOKEN——controller-only，测试可注入） */
  getBridgeToken?: () => string | undefined;
  onStderr?: (lang: string, line: string) => void;
}

const VALID_LANGS: KernelLang[] = ["python", "bash"];

/** 插件式注册：把 kernel 宿主路由挂到已有 Fastify app（sandbox main 与 exec API 同端口） */
export function registerKernelHost(app: FastifyInstance, opts: KernelHostOptions = {}): void {
  const getSecret = opts.getSecret ?? (() => process.env.SANDBOX_SHARED_SECRET);
  const getBridgeToken = opts.getBridgeToken ?? (() => process.env.PTH_MEMORY_BRIDGE_TOKEN);
  // 池容量：env PTH_KERNEL_POOL_SIZE 优先（compose 注入——需 >= 并发 worker 数），option 次之
  const envSize = Number(process.env.PTH_KERNEL_POOL_SIZE);
  const poolSize = opts.poolSize ?? (Number.isFinite(envSize) && envSize > 0 ? envSize : 4);

  // acquire 排队超时（PTH_KERNEL_ACQUIRE_TIMEOUT_MS 默认 60s——池满拒绝防无限卡）
  const envAcquireMs = Number(process.env.PTH_KERNEL_ACQUIRE_TIMEOUT_MS);
  const acquireTimeoutMs = Number.isFinite(envAcquireMs) && envAcquireMs > 0 ? envAcquireMs : 60_000;
  // 池条目 TTL（PTH_KERNEL_ENTRY_TTL_MS 默认 0=关闭；崩溃泄漏兜底建议 30min）
  const envTtlMs = Number(process.env.PTH_KERNEL_ENTRY_TTL_MS);
  const entryTtlMs = Number.isFinite(envTtlMs) && envTtlMs > 0 ? envTtlMs : 0;

  const pools: Record<KernelLang, KernelPool> = {
    python: new KernelPool({ lang: "python", max: poolSize, acquireTimeoutMs, entryTtlMsMs: entryTtlMs, onStderr: opts.onStderr }),
    bash: new KernelPool({ lang: "bash", max: poolSize, acquireTimeoutMs, entryTtlMsMs: entryTtlMs, onStderr: opts.onStderr }),
  };

  type AuthResult = "ok" | "unauthorized" | "misconfigured";
  function checkAuth(req: FastifyRequest): AuthResult {
    const secret = getSecret();
    if (!secret) return "misconfigured";
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
    return token === secret ? "ok" : "unauthorized";
  }
  function enforceAuth(req: FastifyRequest, reply: any): boolean {
    const auth = checkAuth(req);
    if (auth === "ok") return true;
    reply.code(auth === "misconfigured" ? 503 : 401).send({ error: auth === "misconfigured" ? "server misconfigured: SANDBOX_SHARED_SECRET not set" : "unauthorized" });
    return false;
  }

  // /health 由 exec API 注册（组合模式）——独立 app（buildKernelHostApp）时自备
  if (!app.hasRoute({ method: "GET", url: "/health" })) {
    app.get("/health", async () => ({ status: "ok" }));
  }

  app.post("/kernel/acquire", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { lang } = (req.body ?? {}) as { lang?: string };
    if (!lang || !VALID_LANGS.includes(lang as KernelLang)) {
      reply.code(400).send({ error: `invalid lang: ${lang ?? "(missing)"}` });
      return;
    }
    const kernelId = await pools[lang as KernelLang].acquire();
    return { kernelId };
  });

  app.post("/kernel/execute", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const body = (req.body ?? {}) as { kernelId?: string; code?: string; timeoutMs?: number; env?: unknown; exec?: "single" | "program" | "auto"; space?: string };
    if (!body.kernelId || typeof body.code !== "string") {
      reply.code(400).send({ error: "kernelId and code required" });
      return;
    }
    if (body.env !== undefined) {
      // 敏感信息约束：execute 拒绝 env 注入（sandbox 零业务密钥）
      reply.code(400).send({ error: "env injection rejected" });
      return;
    }
    if (body.space !== undefined && !/^[a-z0-9-]{1,32}$/.test(body.space)) {
      // 空间盖章合法性（2026-08-12 批 3）：只允许空间 id 形状——防注入
      reply.code(400).send({ error: `invalid space: ${body.space}` });
      return;
    }
    try {
      const result = await pools[poolLang(body.kernelId)].execute(body.kernelId, body.code, { ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}), ...(body.exec ? { exec: body.exec } : {}), ...(body.space ? { space: body.space } : {}) });
      return result;
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── ASP-5 记忆桥（2026-08-11）：sandbox 内 python 空间访问记忆——转发 PTH 桥端点
  //  （sandbox 无 PG 凭据/无出网——经 internal 网络回 PTH：pi-platform:3000）
  //  P0-1（2026-08-15）：上游改用 PTH_MEMORY_BRIDGE_TOKEN（Redis Bearer token，含 tenant/space 声明）；
  //  未配置 token 时 fail-closed 503——不再把 SANDBOX_SHARED_SECRET 当作业务 API 凭据转发。
  const pthBridgeUrl = (process.env.PTH_BRIDGE_URL ?? "http://pi-platform:3000").replace(/\/+$/, "");
  app.post("/kernel/memory-bridge", async (req, reply) => {
    // P0-2：workload 不再持有 SANDBOX_SHARED_SECRET。本路由允许两种受控调用方：
    //  ① PTH 侧经 internal 网络调用——仍必须持有共享密钥；
    //  ② 本容器内 workload 从 loopback 调用——免密钥（只读桥；上游 PTH 按 bridge token 的
    //     tenant/space 声明过滤，body.space 会被剥除，workload 无法自报空间）。
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLoopback && !enforceAuth(req, reply)) return;
    const body = (req.body ?? {}) as { op?: string; space?: string };
    if (!body.op || !["query", "retrieve", "get"].includes(body.op)) {
      reply.code(400).send({ error: "op required: query|retrieve|get" });
      return;
    }
    const bridgeToken = getBridgeToken();
    if (!bridgeToken) {
      reply.code(503).send({ error: "server misconfigured: PTH_MEMORY_BRIDGE_TOKEN not set" });
      return;
    }
    const { space: _space, ...upstreamBody } = body;
    try {
      const res = await fetch(`${pthBridgeUrl}/api/v1/kernel/memory-bridge`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(35_000),
      });
      const text = await res.text();
      reply.code(res.status).type("application/json").send(text || "{}");
    } catch (err) {
      reply.code(502).send({ error: `memory bridge upstream failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post("/kernel/reset", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { kernelId } = (req.body ?? {}) as { kernelId?: string };
    if (!kernelId) {
      reply.code(400).send({ error: "kernelId required" });
      return;
    }
    try {
      await pools[poolLang(kernelId)].reset(kernelId);
      return { ok: true };
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/kernel/snapshot", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { kernelId } = (req.body ?? {}) as { kernelId?: string };
    if (!kernelId) {
      reply.code(400).send({ error: "kernelId required" });
      return;
    }
    try {
      return await pools[poolLang(kernelId)].snapshot(kernelId);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/kernel/release", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { kernelId } = (req.body ?? {}) as { kernelId?: string };
    if (!kernelId) {
      reply.code(400).send({ error: "kernelId required" });
      return;
    }
    pools[poolLang(kernelId)].release(kernelId);
    return { ok: true };
  });

  // ── 编译核（2026-08-09 Phase B：C 编译-运行管道落 sandbox 侧）────────────
  // POST /kernel/compiled {code, cc?, opt?, timeoutMs?} → InterpreterResult
  //   cc: 编译器变体（gcc|clang|tcc——缺省 auto=cc）；opt: -O0/-O2/-g 组合（缺省 -O0）
  //   编译在沙箱内（工具链 gcc/gdb/strace/valgrind/tcc 已装）——零业务密钥、cwd 白名单
  //   每次调用独立临时工作区（编译-运行管道——非持久进程——天然隔离）
  // 编译统计聚合（持久缓存 + 监视组件——/kernel/status 暴露）
  const compiledStats: CompiledStats = { cacheHits: 0, coldCompiles: 0, avgCompileMs: 0, totalMs: 0, cacheEntries: 0 };
  // 编译核参数面（2026-08-09 扩展）：缓存目录/磁盘上限/LRU/超时/并发——env 全可配
  const compiledCacheDir = process.env.PTH_COMPILED_CACHE_DIR ?? "/data/compiled-cache/c";
  const compiledCacheMaxMb = Number(process.env.PTH_COMPILED_CACHE_MAX_MB ?? 200);
  const compiledMaxCache = Number(process.env.PTH_COMPILED_MAX_CACHE ?? 50);
  const compiledTimeoutMs = Number(process.env.PTH_COMPILED_TIMEOUT_MS ?? 60_000);
  const compiledConcurrency = Number(process.env.PTH_COMPILED_CONCURRENCY ?? 4);
  let compiledInFlight = 0;   // 并发信号量（防编译风暴 CPU——超限 503 提示重试）

  app.post("/kernel/compiled", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    // 并发信号量：编译是 CPU 密集（gcc 进程）——超限 503（调用方重试/排队语义在 PTH 侧）
    if (compiledInFlight >= compiledConcurrency) {
      reply.code(503).send({ error: `compiled concurrency limit (${compiledConcurrency}) reached — retry` });
      return;
    }
    compiledInFlight++;
    let workDir = "";
    try {
      const { code, cc, timeoutMs, buildOnly } = (req.body ?? {}) as { code?: string; cc?: string; timeoutMs?: number; buildOnly?: boolean };
      if (typeof code !== "string" || code.length === 0) {
        reply.code(400).send({ error: "code required" });
        return;
      }
      // 编译器变体白名单（显式 > 默认 cc）——防任意命令注入面（编译器路径固定）
      const ccBin = cc === "gcc" ? "gcc" : cc === "clang" ? "clang" : cc === "tcc" ? "tcc" : undefined;
      workDir = `/data/workspaces/.compiled-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const kernel = new CCompiledKernel({
        workDir,
        cacheDir: compiledCacheDir,     // 持久缓存（跨调用/跨容器重启）
        cc: ccBin,
        compileTimeoutMs: timeoutMs ?? compiledTimeoutMs,
        maxCache: compiledMaxCache,
        maxCacheBytes: compiledCacheMaxMb * 1024 * 1024,
        onMetric: (m) => {
          if (m.type === "cache-hit") compiledStats.cacheHits++;
          else if (m.type === "compile") {
            compiledStats.coldCompiles++;
            compiledStats.totalMs += m.durationMs;
            compiledStats.avgCompileMs = compiledStats.coldCompiles > 0
              ? Math.round(compiledStats.totalMs / compiledStats.coldCompiles) : 0;
          }
          compiledStats.cacheEntries = m.cacheSize ?? compiledStats.cacheEntries;
        },
      });
      // 生产核 dev.build（2026-08-11）：buildOnly=true 仅编译（返回 binaryRef/diagnostics），否则两阶段编译+运行
      if (buildOnly === true) {
        const b = await kernel.build(code);
        return { ok: b.ok, value: b.ok ? { binaryRef: b.binaryRef } : null, error: b.ok ? undefined : { message: `编译失败：${(b.diagnostics ?? "").slice(0, 2000)}` }, stdout: "", stderr: b.diagnostics ?? "", durationMs: b.durationMs };
      }
      const result = await kernel.execute(code);
      return result;
    } catch (e) {
      return { ok: false, error: { message: `compiled kernel error: ${(e as Error).message}` }, durationMs: 0 };
    } finally {
      compiledInFlight--;
      // 编译运行工作区清理（持久缓存独立目录——保留）
      if (workDir) import("node:fs/promises").then(({ rm }) => rm(workDir, { recursive: true, force: true })).catch(() => {});
    }
  });

  // ── 调试核（2026-08-09 Phase 2：debug 落 sandbox 侧——gdb 工具链已装）────────────
  // 会话管理：Map<id, CDebugSession> + idle 清理（30min 无操作 detach——防 gdb 泄漏）
  // 并发上限 PTH_DEBUG_SESSIONS（默认 4——gdb 进程资源约束）
  const debugSessions = new Map<string, { session: CDebugSession; lastUsedAt: number }>();
  const debugMaxSessions = Number(process.env.PTH_DEBUG_SESSIONS ?? 4);
  const debugIdleMs = Number(process.env.PTH_DEBUG_IDLE_MS ?? 30 * 60 * 1000);
  const debugWorkRoot = process.env.PTH_DEBUG_WORKDIR ?? "/data/workspaces";   // CDebugSession 内部自加 .debug/<id>

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

  app.get("/kernel/status", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    return {
      pools: [pools.python.status(), pools.bash.status()],
      compiled: compiledStats,
      debug: { sessions: debugSessions.size, maxSessions: debugMaxSessions },
    };
  });
}

/** 独立 app（测试用）——与 main.ts 同构：exec 与 kernel 路由同端口 */
export function buildKernelHostApp(opts: KernelHostOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerKernelHost(app, opts);
  return app;
}

/** 从 kernelId 前缀推断池（py- → python；sh- → bash） */
function poolLang(kernelId: string): KernelLang {
  return kernelId.startsWith("py-") ? "python" : "bash";
}
