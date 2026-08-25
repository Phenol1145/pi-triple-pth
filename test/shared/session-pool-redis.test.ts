import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import { SessionPool, type PoolSession } from "../../src/pth/core/session-pool.js";

/**
 * F/WP2 Task 5 — 池元状态入 Redis（内存 Map 降级为缓存：写直通+读穿透）。
 * 用真实 Redis（与本机既有 pth 测试模式一致）；唯一 key 前缀+结束清理。
 */

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function makeSession(overrides: Partial<PoolSession> = {}): PoolSession {
  const sid = overrides.sessionId ?? `sid-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    sessionId: sid,
    tenantId: overrides.tenantId ?? "tenant-a",
    project: overrides.project ?? "proj-1",
    state: overrides.state ?? "idle",
    refCount: overrides.refCount ?? 0,
    lastAccess: overrides.lastAccess ?? Date.now(),
    lastCheckpointSeq: overrides.lastCheckpointSeq ?? 0,
    entryCount: overrides.entryCount ?? 0,
    sessionDir: overrides.sessionDir ?? `/tmp/sessions/${sid}`,
    cwd: overrides.cwd ?? `/tmp/workspace/${sid}`,
    createdAt: overrides.createdAt ?? Date.now(),
    recoveredFromCrash: overrides.recoveredFromCrash ?? false,
    interrupted: overrides.interrupted ?? false,
    versionSnapshot: overrides.versionSnapshot ?? null,
    model: overrides.model ?? "test-model",
  };
}

function mockDeps() {
  return {
    sessionStore: {
      saveMeta: vi.fn(), appendEntry: vi.fn(), getMeta: vi.fn(), getEntries: vi.fn(),
      saveSnapshot: vi.fn(), getLatestSnapshot: vi.fn(), listSessions: vi.fn(),
      deleteSession: vi.fn(), saveVersionSnapshot: vi.fn(), getLatestVersionSnapshot: vi.fn(),
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
    metrics: { sessionsActive: { set: vi.fn(), inc: vi.fn(), dec: vi.fn() } } as any,
  };
}

function makePool(redis: RedisType, deps = mockDeps()) {
  return new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    deps.sessionStore, deps.logger, deps.metrics, redis,
  );
}

describe("SessionPool 池元状态入 Redis（F/WP2 Task 5）", () => {
  let redis: RedisType;
  const writtenKeys: string[] = [];

  beforeAll(() => {
    redis = new Redis({ host: "localhost", port: 6379, maxRetriesPerRequest: 1, lazyConnect: true });
  });

  afterAll(async () => {
    // 清理本测试写入的 pool:* 键
    try {
      for (const k of writtenKeys) await redis.del(k);
    } catch { /* best-effort */ }
    redis.disconnect();
  });

  function key(sid: string): string {
    return `pool:${sid}:meta`;
  }

  async function readMeta(sid: string): Promise<any> {
    const raw = await redis.get(key(sid));
    return raw ? JSON.parse(raw) : null;
  }

  it("add 写直通：pool:{sid}:meta 键存在且含关键字段", async () => {
    const deps = mockDeps();
    const pool = makePool(redis, deps);
    const s = makeSession({ tenantId: "tenant-a", model: "deepseek-v4", refCount: 0, state: "idle", entryCount: 3, sessionDir: "/sessions/tenant-a/s1", cwd: "/ws/tenant-a/p1" });
    writtenKeys.push(key(s.sessionId));

    pool.add(s);
    await pool.flush();

    const meta = await readMeta(s.sessionId);
    expect(meta).not.toBeNull();
    expect(meta.sessionId).toBe(s.sessionId);
    expect(meta.tenantId).toBe("tenant-a");
    expect(meta.project).toBe("proj-1");
    expect(meta.state).toBe("idle");
    expect(meta.refCount).toBe(0);
    expect(meta.entryCount).toBe(3);
    expect(meta.sessionDir).toBe("/sessions/tenant-a/s1");
    expect(meta.cwd).toBe("/ws/tenant-a/p1");
    expect(meta.model).toBe("deepseek-v4");
    expect(meta.lastCheckpointSeq).toBe(0);
    expect(typeof meta.lastAccess).toBe("number");
    // 内存缓存仍可同步读
    expect(pool.get(s.sessionId)).toBeDefined();
  });

  it("markBusy/markIdle 状态迁移双写 Redis", async () => {
    const deps = mockDeps();
    const pool = makePool(redis, deps);
    const s = makeSession({ state: "idle", refCount: 0 });
    writtenKeys.push(key(s.sessionId));
    pool.add(s);
    await pool.flush();

    pool.markBusy(s.sessionId);
    await pool.flush();
    let meta = await readMeta(s.sessionId);
    expect(meta.state).toBe("busy");
    expect(meta.refCount).toBe(1);

    pool.markBusy(s.sessionId); // 嵌套 acquire
    await pool.flush();
    meta = await readMeta(s.sessionId);
    expect(meta.refCount).toBe(2);

    pool.markIdle(s.sessionId);
    pool.markIdle(s.sessionId);
    await pool.flush();
    meta = await readMeta(s.sessionId);
    expect(meta.state).toBe("idle");
    expect(meta.refCount).toBe(0);
  });

  it("remove 删除 Redis 键", async () => {
    const deps = mockDeps();
    const pool = makePool(redis, deps);
    const s = makeSession();
    writtenKeys.push(key(s.sessionId));
    pool.add(s);
    await pool.flush();
    expect(await readMeta(s.sessionId)).not.toBeNull();

    pool.remove(s.sessionId);
    await pool.flush();
    expect(await readMeta(s.sessionId)).toBeNull();
  });

  it("模拟进程重启：新 pool 实例从 Redis 重建池视图", async () => {
    const depsA = mockDeps();
    const poolA = makePool(redis, depsA);
    const s1 = makeSession({ tenantId: "tenant-a", state: "idle", model: "m1" });
    const s2 = makeSession({ tenantId: "tenant-b", state: "busy", refCount: 1, model: "m2", entryCount: 5 });
    writtenKeys.push(key(s1.sessionId), key(s2.sessionId));
    poolA.add(s1);
    poolA.add(s2);
    await poolA.flush();

    // 新进程：全新 pool 实例（内存空）+ 同一 Redis
    const depsB = mockDeps();
    const poolB = makePool(redis, depsB);
    expect(poolB.size).toBe(0);
    expect(poolB.get(s1.sessionId)).toBeUndefined();

    const metas = (await poolB.loadAllFromRedis()).filter((m) => m.sessionId === s1.sessionId || m.sessionId === s2.sessionId);
    expect(metas.map((m) => m.sessionId).sort()).toEqual([s1.sessionId, s2.sessionId].sort());
    const m2 = metas.find((m) => m.sessionId === s2.sessionId)!;
    expect(m2.state).toBe("busy");
    expect(m2.refCount).toBe(1);
    expect(m2.entryCount).toBe(5);
    expect(m2.model).toBe("m2");
    expect(m2.tenantId).toBe("tenant-b");
    expect(m2.versionSnapshot).toBeNull(); // 版本快照不落池元（另存 sessionStore）
  });

  it("getOrLoad 读穿透：新实例单键重建并回填缓存", async () => {
    const depsA = mockDeps();
    const poolA = makePool(redis, depsA);
    const s = makeSession({ tenantId: "tenant-a", model: "m3" });
    writtenKeys.push(key(s.sessionId));
    poolA.add(s);
    await poolA.flush();

    const depsB = mockDeps();
    const poolB = makePool(redis, depsB);
    expect(poolB.get(s.sessionId)).toBeUndefined();
    const loaded = await poolB.getOrLoad(s.sessionId);
    expect(loaded).toBeDefined();
    expect(loaded!.sessionId).toBe(s.sessionId);
    expect(loaded!.model).toBe("m3");
    // 已回填内存缓存
    expect(poolB.get(s.sessionId)).toBeDefined();
  });

  it("markUnrecoverable 后 loadAllFromRedis 跳过（死会话不恢复）", async () => {
    const depsA = mockDeps();
    const poolA = makePool(redis, depsA);
    const good = makeSession({ sessionId: `good-${RUN_ID}` });
    const dead = makeSession({ sessionId: `dead-${RUN_ID}` });
    writtenKeys.push(key(good.sessionId), key(dead.sessionId));
    poolA.add(good);
    poolA.add(dead);
    await poolA.flush();

    await poolA.markUnrecoverable(dead.sessionId, "corrupt session file");

    const depsB = mockDeps();
    const poolB = makePool(redis, depsB);
    const metas = (await poolB.loadAllFromRedis()).filter((m) => m.sessionId === good.sessionId || m.sessionId === dead.sessionId);
    expect(metas.map((m) => m.sessionId)).toContain(good.sessionId);
    expect(metas.map((m) => m.sessionId)).not.toContain(dead.sessionId);
    // getOrLoad 对死会话也拒绝
    expect(await poolB.getOrLoad(dead.sessionId)).toBeUndefined();
  });
});
