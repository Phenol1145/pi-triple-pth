import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import { SessionPool, type PoolSession } from "../../src/pth/core/session-pool.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * F/WP2 Task 6 — recoverAll 实现 + 竞态防护 + 恢复清理。
 * 制造崩溃现场（Redis 池元 + 会话目录 JSONL + 损坏文件）→ 新 engine → recoverAll。
 */

const sdkMocks = vi.hoisted(() => ({
  createdOptions: [] as any[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...mod,
    createAgentSession: vi.fn(async (options: any) => {
      sdkMocks.createdOptions.push(options);
      const sm = options.sessionManager;
      const subscribers: Array<(ev: any) => void> = [];
      const session = {
        prompt: async (text: string) => {
          sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
          sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
          for (const cb of [...subscribers]) cb({ type: "message_end", message: { role: "assistant", content: [], timestamp: Date.now(), usage: { input: 1, output: 1 } } });
          for (const cb of [...subscribers]) cb({ type: "agent_end" });
        },
        abort: async () => {},
        subscribe: (cb: (ev: any) => void) => { subscribers.push(cb); return () => {}; },
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

function makeEngine(tmpDir: string, sessionsDir: string, redis: RedisType, deps = mockDeps(), cwd?: string): AgentEngine {
  const workspaceCwd = cwd ?? path.join(tmpDir, "workspace", "tenant-a", "proj-1");
  fs.mkdirSync(workspaceCwd, { recursive: true });
  const modelRouter = { resolve: () => ({ id: "test-model" }), getRuntime: () => ({}) } as any;
  const toolPlatform = {
    getAllowedTools: () => [], getSdkToolDefinitions: () => [], getEffectiveTools: () => [],
    recordToolStart: vi.fn(), recordToolEnd: vi.fn(),
  } as any;
  const workspaceMgr = {
    ensureWorkspace: vi.fn(async () => workspaceCwd),
    getPlatformDir: () => path.join(tmpDir, "platform"),
  } as any;
  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    deps.sessionStore, deps.logger, deps.metrics, redis,
  );
  return new AgentEngine(pool, modelRouter, workspaceMgr, deps.sessionStore, toolPlatform, deps.logger, deps.metrics, sessionsDir, deps.audit);
}

function makePoolSession(sid: string, sessionDir: string, cwd: string, overrides: Partial<PoolSession> = {}): PoolSession {
  return {
    sessionId: sid,
    tenantId: "tenant-a",
    project: "proj-1",
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
    ...overrides,
  };
}

// ── tests ────────────────────────────────────────────────────────────

describe("AgentEngine recoverAll（F/WP2 Task 6）", () => {
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

  it("busy→interrupted+recovered 置 idle；idle→recovered；损坏文件→unrecoverable+审计", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-recover-"));
    const sessionsDir = path.join(tmp, "sessions");
    const cwd = path.join(tmp, "workspace", "tenant-a", "proj-1");
    fs.mkdirSync(cwd, { recursive: true });
    const prefix = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sidIdle = `${prefix}-idle`;
    const sidBusy = `${prefix}-busy`;
    const sidCorrupt = `${prefix}-corrupt`;
    writtenKeys.push(`pool:${sidIdle}:meta`, `pool:${sidBusy}:meta`, `pool:${sidCorrupt}:meta`);

    // ── 制造崩溃现场 1：真实 SDK 会话文件（idle/busy 各一轮完整对话）──
    const mk = (sid: string) => {
      const sm = SessionManager.create(cwd, path.join(sessionsDir, "tenant-a", sid), { id: sid });
      sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
      return sm;
    };
    mk(sidIdle);
    mk(sidBusy);
    // 制造崩溃现场 2：损坏的 .jsonl（发现不了 header → continueRecent 空 → id 不匹配 → unrecoverable）
    const corruptDir = path.join(sessionsDir, "tenant-a", sidCorrupt);
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "0000_bad.jsonl"), "{not valid json\n");

    // ── 崩溃前：pool A 写池元（busy 会话模拟 in-flight 崩溃）──
    const depsA = mockDeps();
    const poolA = new SessionPool({ maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, depsA.sessionStore, depsA.logger, depsA.metrics, redis);
    poolA.add(makePoolSession(sidIdle, path.join(sessionsDir, "tenant-a", sidIdle), cwd, { entryCount: 2 }));
    poolA.add(makePoolSession(sidBusy, path.join(sessionsDir, "tenant-a", sidBusy), cwd, { state: "busy", refCount: 1, entryCount: 2 }));
    poolA.add(makePoolSession(sidCorrupt, corruptDir, cwd, { state: "busy", refCount: 1, entryCount: 2 }));
    await poolA.flush();

    // ── 模拟重启：新 engine（新 pool，内存空）──
    const depsB = mockDeps();
    const engine = makeEngine(tmp, sessionsDir, redis, depsB, cwd);
    await engine.recoverAll();

    // idle 会话：恢复为 idle + recoveredFromCrash（非 interrupted）
    const rIdle = engine.getPool().get(sidIdle);
    expect(rIdle).toBeDefined();
    expect(rIdle!.state).toBe("idle");
    expect(rIdle!.refCount).toBe(0);
    expect(rIdle!.recoveredFromCrash).toBe(true);
    expect(rIdle!.interrupted).toBe(false);

    // busy 会话：interrupted + recovered-from-crash，状态置 idle，refCount 归零
    const rBusy = engine.getPool().get(sidBusy);
    expect(rBusy).toBeDefined();
    expect(rBusy!.state).toBe("idle");
    expect(rBusy!.refCount).toBe(0);
    expect(rBusy!.interrupted).toBe(true);
    expect(rBusy!.recoveredFromCrash).toBe(true);

    // 损坏会话：unrecoverable——不进内存池，Redis meta 标记，审计事件
    expect(engine.getPool().get(sidCorrupt)).toBeUndefined();
    const corruptMeta = JSON.parse((await redis.get(`pool:${sidCorrupt}:meta`))!);
    expect(corruptMeta.unrecoverable).toBe(true);
    expect(depsB.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: "recovery_unrecoverable" }));
    // busy 会话恢复：dispatch 丢弃审计（不重放）
    expect(depsB.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: "recovery_interrupted" }));

    // 恢复校验：entryCount 一致（=2）→ 无 mismatch warn（过滤本测试会话——同文件/同 Redis 其他测试残留键不影响断言）
    const mismatchWarns = depsB.logger.warn.mock.calls.filter(
      (c: any[]) => (c[0]?.sessionId === sidIdle || c[0]?.sessionId === sidBusy) && c[0]?.event === "recovery_entry_count_mismatch",
    );
    expect(mismatchWarns).toHaveLength(0);

    // 恢复后可继续 prompt（fake SDK 会话绑定恢复出的 SessionManager）
    const events: any[] = [];
    for await (const ev of engine.prompt(sidBusy, "tenant-a", "continue")) events.push(ev);
    expect(events[events.length - 1].type).toBe("agent_end");
    // 恢复的 JSONL 又追加了一轮
    const busyDir = path.join(sessionsDir, "tenant-a", sidBusy);
    const files = fs.readdirSync(busyDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = fs.readFileSync(path.join(busyDir, files[0]), "utf-8").trim().split("\n");
    expect(lines.filter((l) => JSON.parse(l).type === "message")).toHaveLength(4); // 2 原有 + 2 新增

    await engine.drain();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("entryCount 不一致记 warn 不阻断恢复", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-recover-"));
    const sessionsDir = path.join(tmp, "sessions");
    const cwd = path.join(tmp, "workspace", "tenant-a", "proj-1");
    fs.mkdirSync(cwd, { recursive: true });
    const prefix = `recm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sid = `${prefix}-mismatch`;
    writtenKeys.push(`pool:${sid}:meta`);

    SessionManager.create(cwd, path.join(sessionsDir, "tenant-a", sid), { id: sid });
    // 注意：不 append 任何消息 → 无落盘文件（懒落盘窗口）
    const depsA = mockDeps();
    const poolA = new SessionPool({ maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, depsA.sessionStore, depsA.logger, depsA.metrics, redis);
    poolA.add(makePoolSession(sid, path.join(sessionsDir, "tenant-a", sid), cwd, { entryCount: 7 })); // 元数据与实际(0)不一致
    await poolA.flush();

    const depsB = mockDeps();
    const engine = makeEngine(tmp, sessionsDir, redis, depsB, cwd);
    await engine.recoverAll();

    // 仍然恢复（空会话重建），但记 mismatch warn（按本测试会话过滤）
    const r = engine.getPool().get(sid);
    expect(r).toBeDefined();
    expect(r!.recoveredFromCrash).toBe(true);
    const mismatchWarns = depsB.logger.warn.mock.calls.filter(
      (c: any[]) => c[0]?.sessionId === sid && c[0]?.event === "recovery_entry_count_mismatch",
    );
    expect(mismatchWarns).toHaveLength(1);
    expect(mismatchWarns[0][0].expected).toBe(7);
    expect(mismatchWarns[0][0].actual).toBe(0);
    // 懒落盘窗口：recovery_no_session_file warn 也记录
    expect(depsB.logger.warn.mock.calls.some((c: any[]) => c[0]?.sessionId === sid && c[0]?.event === "recovery_no_session_file")).toBe(true);

    await engine.drain();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("重复调用 recoverAll 幂等：内存已有会话跳过，不重复 revive", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-recover-"));
    const sessionsDir = path.join(tmp, "sessions");
    const cwd = path.join(tmp, "workspace", "tenant-a", "proj-1");
    fs.mkdirSync(cwd, { recursive: true });
    const prefix = `recr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sid = `${prefix}-idem`;
    writtenKeys.push(`pool:${sid}:meta`);

    const sm = SessionManager.create(cwd, path.join(sessionsDir, "tenant-a", sid), { id: sid });
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });

    const depsA = mockDeps();
    const poolA = new SessionPool({ maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, depsA.sessionStore, depsA.logger, depsA.metrics, redis);
    poolA.add(makePoolSession(sid, path.join(sessionsDir, "tenant-a", sid), cwd, { entryCount: 2 }));
    await poolA.flush();

    const depsB = mockDeps();
    const engine = makeEngine(tmp, sessionsDir, redis, depsB, cwd);
    const revivesOf = () => sdkMocks.createdOptions.filter((o: any) => o.sessionManager?.getSessionId() === sid).length;
    await engine.recoverAll();
    expect(revivesOf()).toBe(1); // 第一次恢复 revive 1 个

    await engine.recoverAll(); // 幂等：内存已有 → 跳过
    expect(revivesOf()).toBe(1);
    expect(engine.getPool().get(sid)).toBeDefined();

    await engine.drain();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
