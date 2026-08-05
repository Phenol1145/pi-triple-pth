import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import { SessionPool, type PoolSession } from "../../src/pth/core/session-pool.js";

/**
 * F/WP5 Task 23 — 常驻系统会话机制。
 * RESERVED 标记（evict 豁免）/ 优先恢复 / watchdog 崩溃重建 / destroy 豁免 / 幂等。
 * mock SDK 层（无 LLM key），真实 SessionManager + 真实 Redis 池元（优先恢复用例）。
 */

const sdkMocks = vi.hoisted(() => ({
  createdOptions: [] as any[],
  reset: () => { sdkMocks.createdOptions.length = 0; },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...mod,
    createAgentSession: vi.fn(async (options: any) => {
      sdkMocks.createdOptions.push(options);
      const session = {
        prompt: async () => {},
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      };
      return { session };
    }),
  };
});

// ── helpers ──────────────────────────────────────────────────────────

function mockDeps() {
  return {
    sessionStore: {
      saveMeta: vi.fn(async () => {}), appendEntry: vi.fn(async () => {}), getMeta: vi.fn(async () => null),
      getEntries: vi.fn(async () => []), saveSnapshot: vi.fn(async () => {}), getLatestSnapshot: vi.fn(async () => null),
      listSessions: vi.fn(async () => []), deleteSession: vi.fn(async () => {}),
      saveVersionSnapshot: vi.fn(async () => {}), getLatestVersionSnapshot: vi.fn(async () => null),
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
    metrics: {
      promptDuration: { startTimer: () => () => {} },
      sessionsActive: { set: vi.fn(), inc: vi.fn(), dec: vi.fn() },
      tokensTotal: { inc: vi.fn() },
    } as any,
    audit: { write: vi.fn(async () => {}) } as any,
  };
}

function makeEngine(tmpDir: string, sessionsDir: string, deps = mockDeps(), maxSessions = 20, redis?: RedisType): { engine: AgentEngine; deps: ReturnType<typeof mockDeps> } {
  const cwd = path.join(tmpDir, "workspace", "tenant-a", "proj-1");
  fs.mkdirSync(cwd, { recursive: true });
  const modelRouter = { resolve: () => ({ id: "test-model" }), getRuntime: () => ({}) } as any;
  const toolPlatform = {
    getAllowedTools: () => [], getSdkToolDefinitions: () => [], getEffectiveTools: () => [],
    recordToolStart: vi.fn(), recordToolEnd: vi.fn(),
  } as any;
  const workspaceMgr = {
    ensureWorkspace: vi.fn(async () => cwd),
    ensureProgramRunWorkspace: vi.fn(async () => cwd),
    getPlatformDir: () => path.join(tmpDir, "platform"),
  } as any;
  const pool = new SessionPool(
    { maxSessions, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    deps.sessionStore, deps.logger, deps.metrics, redis,
  );
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, deps.sessionStore, toolPlatform, deps.logger, deps.metrics, sessionsDir, deps.audit);
  pool.setOnEvict((sid) => { void engine.evictSession(sid); });
  return { engine, deps };
}

function makePoolSession(sid: string, sessionDir: string, cwd: string, overrides: Partial<PoolSession> = {}): PoolSession {
  return {
    sessionId: sid,
    tenantId: "system",
    project: "system",
    state: "idle",
    refCount: 0,
    lastAccess: Date.now(),
    lastCheckpointSeq: 0,
    entryCount: 0,
    sessionDir,
    cwd,
    createdAt: Date.now(),
    recoveredFromCrash: false,
    interrupted: false,
    versionSnapshot: null,
    model: "test-model",
    reserved: true,
    ...overrides,
  };
}

/** 模拟常驻会话崩溃：从进程内映射与池中移除（dispose/丢失语义） */
function simulateSystemCrash(engine: AgentEngine): string | null {
  const sid = engine.getSystemSessionId();
  if (!sid) return null;
  (engine as any).agentSessions.delete(sid);
  engine.getPool().remove(sid);
  return sid;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── tests ────────────────────────────────────────────────────────────

describe("常驻系统会话机制（F/WP5 Task 23）", () => {
  let tmpRoot: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-session-"));
    agentDir = path.join(tmpRoot, "agent-dir");
    fs.mkdirSync(agentDir, { recursive: true });
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = path.join(tmpRoot, "home");
    sdkMocks.reset();
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("createSystemSession：RESERVED 标记 + tenant=system + 幂等复用", async () => {
    const sessionsDir = path.join(tmpRoot, "sessions");
    const { engine } = makeEngine(tmpRoot, sessionsDir);
    try {
      const res1 = await engine.createSystemSession();
      expect(res1.ok).toBe(true);
      if (!res1.ok) throw new Error("unreachable");
      const sid = res1.data.sessionId;
      expect(res1.data.tenantId).toBe("system");

      const pooled = engine.getPool().get(sid)!;
      expect(pooled.reserved).toBe(true); // RESERVED 标记
      expect(pooled.tenantId).toBe("system");

      // 幂等：再次调用复用现有会话
      const res2 = await engine.createSystemSession();
      expect(res2.ok).toBe(true);
      if (!res2.ok) throw new Error("unreachable");
      expect(res2.data.sessionId).toBe(sid);
      expect(engine.getPool().size).toBe(1);
    } finally {
      engine.stopSystemWatchdog();
      await engine.drain();
    }
  });

  it("驱逐豁免：pool 满时 evictLRU 跳过 RESERVED，逐出普通 idle 会话", async () => {
    const sessionsDir = path.join(tmpRoot, "sessions");
    const { engine } = makeEngine(tmpRoot, sessionsDir, mockDeps(), 2); // maxSessions=2
    try {
      const sys = await engine.createSystemSession();
      expect(sys.ok).toBe(true);
      if (!sys.ok) throw new Error("unreachable");
      const sysSid = sys.data.sessionId;

      const a = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(a.ok).toBe(true);
      if (!a.ok) throw new Error("unreachable");
      const aSid = a.data.sessionId;

      // 池已满（system + A）。新建 B → canCreate 触发 evictLRU：必须驱逐 A（idle 普通会话），保留 system（RESERVED）
      const b = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(b.ok).toBe(true);
      if (!b.ok) throw new Error("unreachable");
      const bSid = b.data.sessionId;

      expect(engine.getPool().get(sysSid)).toBeDefined(); // 常驻会话未被驱逐
      expect(engine.getPool().get(sysSid)!.reserved).toBe(true);
      expect(engine.getPool().get(aSid)).toBeUndefined(); // 普通 idle 被驱逐
      expect(engine.getPool().get(bSid)).toBeDefined();
      expect(engine.getPool().size).toBe(2);
    } finally {
      engine.stopSystemWatchdog();
      await engine.drain();
    }
  });

  it("destroy 豁免：destroySession 对 RESERVED 会话 no-op", async () => {
    const sessionsDir = path.join(tmpRoot, "sessions");
    const { engine } = makeEngine(tmpRoot, sessionsDir);
    try {
      const res = await engine.createSystemSession();
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      await engine.destroySession(sid, "system");
      expect(engine.getPool().get(sid)).toBeDefined(); // 仍在
      expect(engine.getSystemSessionId()).toBe(sid);
    } finally {
      engine.stopSystemWatchdog();
      await engine.drain();
    }
  });

  it("崩溃重建：ensureSystemSessionAlive 检测缺席 → 自动重建 + 审计 + rebuildCount", async () => {
    const sessionsDir = path.join(tmpRoot, "sessions");
    const deps = mockDeps();
    const { engine } = makeEngine(tmpRoot, sessionsDir, deps);
    try {
      const res = await engine.createSystemSession();
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      expect(engine.getSystemRebuildCount()).toBe(0);

      // 会话仍在 → 不重建
      expect(await engine.ensureSystemSessionAlive()).toBe(false);

      // 模拟崩溃：进程内映射/池记录丢失
      simulateSystemCrash(engine);

      const rebuilt = await engine.ensureSystemSessionAlive();
      expect(rebuilt).toBe(true);
      const newSid = engine.getSystemSessionId()!;
      expect(newSid).not.toBe(sid);
      expect(engine.getSystemRebuildCount()).toBe(1);
      expect(engine.getPool().get(newSid)!.reserved).toBe(true);
      // 重建审计
      expect(deps.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: "system_session_rebuilt", details: expect.objectContaining({ previousSessionId: sid, rebuildCount: 1 }) }),
      );
      // 新会话 ID 与旧不同（全新构建）
      expect(sdkMocks.createdOptions.some((o: any) => o.sessionManager?.getSessionId() === newSid)).toBe(true);
    } finally {
      engine.stopSystemWatchdog();
      await engine.drain();
    }
  });

  it("watchdog 定时器：周期探测 → 崩溃后自动重建", async () => {
    const sessionsDir = path.join(tmpRoot, "sessions");
    const { engine } = makeEngine(tmpRoot, sessionsDir);
    try {
      const res = await engine.createSystemSession();
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;

      engine.startSystemWatchdog(30); // 30ms 周期（测试用，生产 60s）
      simulateSystemCrash(engine);
      await sleep(150); // 等 5 个 tick

      const newSid = engine.getSystemSessionId()!;
      expect(newSid).not.toBe(sid);
      expect(engine.getPool().get(newSid)).toBeDefined();
      expect(engine.getPool().get(newSid)!.reserved).toBe(true);
      expect(engine.getSystemRebuildCount()).toBeGreaterThanOrEqual(1);
    } finally {
      engine.stopSystemWatchdog();
      await engine.drain();
    }
  });
});

describe("recoverAll 优先恢复常驻会话（F/WP5 Task 23）", () => {
  let redis: RedisType;
  const writtenKeys: string[] = [];

  beforeAll(() => {
    redis = new Redis({ host: "localhost", port: 6379, maxRetriesPerRequest: 1, lazyConnect: true });
  });

  afterAll(async () => {
    try {
      for (const k of writtenKeys) await redis.del(k);
    } catch { /* best-effort */ }
    redis.disconnect();
  });

  beforeEach(() => {
    sdkMocks.reset();
  });

  it("reserved 会话先于普通会话恢复；systemSessionId 关联", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-sysrec-"));
    const sessionsDir = path.join(tmp, "sessions");
    const cwd = path.join(tmp, "workspace", "tenant-a", "proj-1");
    fs.mkdirSync(cwd, { recursive: true });
    const prefix = `sysrec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sidSys = `${prefix}-system`;
    const sidNorm = `${prefix}-normal`;
    writtenKeys.push(`pool:${sidSys}:meta`, `pool:${sidNorm}:meta`);

    // 崩溃前：pool A 写池元（常驻 + 普通各一）
    const depsA = mockDeps();
    const poolA = new SessionPool({ maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, depsA.sessionStore, depsA.logger, depsA.metrics, redis);
    poolA.add(makePoolSession(sidSys, path.join(sessionsDir, "system", sidSys), cwd));
    poolA.add(makePoolSession(sidNorm, path.join(sessionsDir, "tenant-a", sidNorm), cwd, { tenantId: "tenant-a", project: "proj-1", reserved: false }));
    await poolA.flush();

    // 模拟重启：新 engine（pool 带 Redis——读穿透恢复索引）
    const depsB = mockDeps();
    const { engine } = makeEngine(tmp, sessionsDir, depsB, 20, redis);
    await engine.recoverAll();

    // 常驻会话已恢复 + 关联 systemSessionId
    expect(engine.getSystemSessionId()).toBe(sidSys);
    const sys = engine.getPool().get(sidSys);
    expect(sys).toBeDefined();
    expect(sys!.reserved).toBe(true);
    expect(sys!.recoveredFromCrash).toBe(true);
    // 普通会话也恢复
    expect(engine.getPool().get(sidNorm)).toBeDefined();

    // 优先顺序：常驻会话的 createAgentSession 调用先于普通会话
    const order = sdkMocks.createdOptions.map((o: any) => o.sessionManager?.getSessionId());
    expect(order.indexOf(sidSys)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(sidNorm)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(sidSys)).toBeLessThan(order.indexOf(sidNorm));

    // 恢复后 createSystemSession 幂等：复用已恢复的常驻会话
    const again = await engine.createSystemSession();
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("unreachable");
    expect(again.data.sessionId).toBe(sidSys);

    await engine.drain();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
