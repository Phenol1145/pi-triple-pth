import { describe, it, expect, vi } from "vitest";
import { SessionPool, type PoolSession } from "../../src/pth/core/session-pool.js";

function makeSession(overrides: Partial<PoolSession> = {}): PoolSession {
  return {
    sessionId: overrides.sessionId ?? `sid-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: overrides.tenantId ?? "tenant-a",
    project: overrides.project ?? "proj-1",
    state: overrides.state ?? "idle",
    refCount: overrides.refCount ?? 0,
    lastAccess: overrides.lastAccess ?? Date.now(),
    lastCheckpointSeq: overrides.lastCheckpointSeq ?? 0,
    versionSnapshot: overrides.versionSnapshot ?? null,
    model: overrides.model ?? "test-model",
  };
}

function mockDeps() {
  return {
    sessionStore: { saveMeta: vi.fn(), appendEntry: vi.fn(), getMeta: vi.fn(), getEntries: vi.fn(), saveSnapshot: vi.fn(), getLatestSnapshot: vi.fn(), listSessions: vi.fn(), deleteSession: vi.fn(), saveVersionSnapshot: vi.fn(), getLatestVersionSnapshot: vi.fn() } as any,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
    metrics: { sessionsActive: { set: vi.fn(), inc: vi.fn(), dec: vi.fn() } } as any,
  };
}

describe("SessionPool", () => {
  it("canCreate allows normal creation", () => {
    const deps = mockDeps();
    const pool = new SessionPool({ maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, deps.sessionStore, deps.logger, deps.metrics);
    const result = pool.canCreate("tenant-a");
    expect(result.ok).toBe(true);
  });

  it("canCreate rejects when tenant limit reached", () => {
    const deps = mockDeps();
    const pool = new SessionPool({ maxSessions: 20, maxSessionsPerTenant: 2, idleTimeoutMs: 300_000 }, deps.sessionStore, deps.logger, deps.metrics);
    // Add 2 sessions for tenant-a
    pool.add(makeSession({ tenantId: "tenant-a", sessionId: "a1" }));
    pool.add(makeSession({ tenantId: "tenant-a", sessionId: "a2" }));
    const result = pool.canCreate("tenant-a");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Tenant limit");
  });

  it("canCreate rejects when global limit reached and all busy", () => {
    const deps = mockDeps();
    const pool = new SessionPool({ maxSessions: 2, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, deps.sessionStore, deps.logger, deps.metrics);
    // Add 2 BUSY sessions
    pool.add(makeSession({ sessionId: "b1", state: "busy", refCount: 1 }));
    pool.add(makeSession({ sessionId: "b2", state: "busy", refCount: 1 }));
    const result = pool.canCreate("tenant-z");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("all sessions busy");
  });

  it("canCreate evicts idle when global limit reached", () => {
    const evicted: string[] = [];
    const deps = mockDeps();
    const pool = new SessionPool(
      { maxSessions: 3, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000, onEvict: (sid) => evicted.push(sid) },
      deps.sessionStore, deps.logger, deps.metrics,
    );
    pool.add(makeSession({ sessionId: "idle1", state: "idle", lastAccess: 1000 }));
    pool.add(makeSession({ sessionId: "idle2", state: "idle", lastAccess: 2000 }));
    pool.add(makeSession({ sessionId: "busy1", state: "busy", refCount: 1, lastAccess: 3000 }));

    // Now try to create — should evict idle1 (oldest access)
    const result = pool.canCreate("tenant-b");
    expect(result.ok).toBe(true);
    expect(evicted).toContain("idle1");
    expect(pool.get("idle1")).toBeUndefined();
    expect(pool.get("idle2")).toBeDefined();
  });

  it("acquire/release transitions state correctly", () => {
    const deps = mockDeps();
    const pool = new SessionPool({ maxSessions: 10, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, deps.sessionStore, deps.logger, deps.metrics);
    const s = makeSession({ sessionId: "test", state: "idle" });
    pool.add(s);

    pool.markBusy("test");
    expect(s.state).toBe("busy");
    expect(s.refCount).toBe(1);

    pool.markBusy("test"); // nested acquire
    expect(s.refCount).toBe(2);

    pool.markIdle("test");
    expect(s.refCount).toBe(1);
    expect(s.state).toBe("busy"); // still busy because refCount > 0

    pool.markIdle("test");
    expect(s.refCount).toBe(0);
    expect(s.state).toBe("idle");
  });

  it("evictLRU only evicts idle sessions", () => {
    const deps = mockDeps();
    const pool = new SessionPool({ maxSessions: 10, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 }, deps.sessionStore, deps.logger, deps.metrics);
    pool.add(makeSession({ sessionId: "busy1", state: "busy", refCount: 1, lastAccess: 1000 }));
    pool.add(makeSession({ sessionId: "busy2", state: "busy", refCount: 1, lastAccess: 2000 }));

    const evicted = pool.evictLRU();
    expect(evicted).toBeNull(); // no idle sessions to evict
    expect(pool.get("busy1")).toBeDefined();
    expect(pool.get("busy2")).toBeDefined();
  });

  it("evictLRU picks LRU idle session", () => {
    const evicted: string[] = [];
    const deps = mockDeps();
    const pool = new SessionPool(
      { maxSessions: 10, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000, onEvict: (sid) => evicted.push(sid) },
      deps.sessionStore, deps.logger, deps.metrics,
    );
    pool.add(makeSession({ sessionId: "old", state: "idle", lastAccess: 1000 }));
    pool.add(makeSession({ sessionId: "fresh", state: "idle", lastAccess: 5000 }));
    pool.add(makeSession({ sessionId: "busy", state: "busy", refCount: 1, lastAccess: 3000 }));

    const victim = pool.evictLRU();
    expect(victim).toBe("old");
    expect(evicted).toContain("old");
    expect(pool.get("fresh")).toBeDefined();
    expect(pool.get("busy")).toBeDefined();
  });

  it("onEvict callback fires on eviction", () => {
    const callbacks: Array<{ sid: string; tid: string }> = [];
    const deps = mockDeps();
    const pool = new SessionPool(
      { maxSessions: 10, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000, onEvict: (sid, tid) => callbacks.push({ sid, tid }) },
      deps.sessionStore, deps.logger, deps.metrics,
    );
    pool.add(makeSession({ sessionId: "evict-me", tenantId: "t1", state: "idle", lastAccess: 1 }));
    pool.evictLRU();
    expect(callbacks).toEqual([{ sid: "evict-me", tid: "t1" }]);
  });
});
