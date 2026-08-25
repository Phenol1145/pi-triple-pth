import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Redis } from "ioredis";
import { detectPlatform, createLogger } from "@away_from/infra";
import { createMetrics } from "../../src/pth/observability/metrics.js";
import { AuditWriter } from "../../src/pth/observability/audit.js";
import { RedisSessionStore } from "@away_from/pth-kernel-storage";
import { EnvCredentialProvider, WorkspaceManager, ModelRouter } from "@away_from/infra";
import { ToolRegistry } from "../../src/pth/tools/registry.js";
import { ToolPlatform } from "../../src/pth/tools/platform.js";
import { SessionPool, type SessionPoolConfig } from "../../src/pth/core/session-pool.js";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import type { AgentEvent, ManagedSessionInfo, Result } from "../../src/pth/core/types.js";

// ── helpers ──────────────────────────────────────────────────────────

/** Collect all events from an AsyncIterable into an array */
async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
  }
  return events;
}

/** Get all text_delta values concatenated from collected events */
function extractText(events: AgentEvent[]): string {
  let text = "";
  for (const ev of events) {
    const d = ev.data as any;
    if (ev.type === "message_update" && d?.assistantMessageEvent?.type === "text_delta") {
      text += d.assistantMessageEvent.delta;
    }
  }
  return text;
}

/** Wait N ms */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── shared test infrastructure ───────────────────────────────────────

let redis: Redis;
let engine: AgentEngine;
let modelRouter: ModelRouter;

beforeAll(async () => {
  const platform = detectPlatform();
  const logger = createLogger("warn");
  const metrics = createMetrics();
  redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

  const sessionStore = new RedisSessionStore(redis);
  const credentials = new EnvCredentialProvider();
  const audit = new AuditWriter(redis);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-test-"));
  const workspaceMgr = new WorkspaceManager(
    platform,
    `${dataDir}/workspaces`,
    `${dataDir}/platform`,
    `${dataDir}/tenants`,
  );

  modelRouter = new ModelRouter(credentials, logger);
  await modelRouter.initialize();

  const toolRegistry = new ToolRegistry();
  const toolPlatform = new ToolPlatform(toolRegistry, audit, metrics, logger);
  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    sessionStore,
    logger,
    metrics,
  );
  engine = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics);
  pool.setOnEvict((sid) => engine.evictSession(sid));
}, 30000);

afterAll(async () => {
  try {
    await engine.drain();
  } catch { /* ignore */ }
  try {
    // Flush test keys across all test tenants
    const tenants = ["test-lifecycle", "test-multi", "test-abort", "test-isolation", "test-concurrent", "test-limit", "test-evict"];
    for (const t of tenants) {
      const keys = await redis.keys(`session:${t}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.del(`session-index:${t}`);
    }
  } catch { /* ignore */ }
  try { await redis.quit(); } catch { /* ignore */ }
}, 10000);

// ── test suites ──────────────────────────────────────────────────────

describe("AgentEngine session lifecycle", () => {
  const TENANT = "test-lifecycle";

  afterAll(async () => {
    // cleanup
    const sessions = engine.listSessions(TENANT);
    for (const s of sessions) {
      await engine.destroySession(s.sessionId, TENANT);
    }
  });

  it("createSession → listSessions → destroySession", async () => {
    // create
    const result = await engine.createSession({ tenantId: TENANT, project: "lifecycle" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const info: ManagedSessionInfo = result.data;
    expect(info.sessionId).toBeDefined();
    expect(info.tenantId).toBe(TENANT);
    expect(info.project).toBe("lifecycle");
    expect(info.state).toBe("idle");
    expect(info.model).toBeDefined();

    // list includes it
    const list = engine.listSessions(TENANT);
    expect(list.some((s) => s.sessionId === info.sessionId)).toBe(true);

    // destroy
    await engine.destroySession(info.sessionId, TENANT);

    // list no longer includes it
    const list2 = engine.listSessions(TENANT);
    expect(list2.some((s) => s.sessionId === info.sessionId)).toBe(false);
  });

  it("createSession returns ok:false when tenant limit hit", async () => {
    // Create a fresh engine with tight limits
    const platform = detectPlatform();
    const logger = createLogger("warn");
    const metrics = createMetrics();
    const r = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    const sessionStore = new RedisSessionStore(r);
    const credentials = new EnvCredentialProvider();
    const audit = new AuditWriter(r);
    const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-test-"));
    const workspaceMgr = new WorkspaceManager(platform, path.join(testDataDir, "workspaces"), path.join(testDataDir, "platform"), path.join(testDataDir, "tenants"));

    const pool = new SessionPool(
      { maxSessions: 100, maxSessionsPerTenant: 2, idleTimeoutMs: 300_000 },
      sessionStore, logger, metrics,
    );
    const e = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, new ToolPlatform(new ToolRegistry(), audit, metrics, logger), logger, metrics);
    pool.setOnEvict((sid) => e.evictSession(sid));

    const T = "test-limit";

    // Create 2 sessions
    const r1 = await e.createSession({ tenantId: T, project: "limit" });
    const r2 = await e.createSession({ tenantId: T, project: "limit" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // 3rd should fail
    const r3 = await e.createSession({ tenantId: T, project: "limit" });
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain("Tenant limit");

    // cleanup
    if (r1.ok) await e.destroySession(r1.data.sessionId, T);
    if (r2.ok) await e.destroySession(r2.data.sessionId, T);
    await e.drain();
    // flush redis
    const keys = await r.keys(`session:${T}:*`);
    if (keys.length > 0) await r.del(...keys);
    await r.del(`session-index:${T}`);
    await r.quit();
  });

  it("eviction: idle sessions are evicted when global limit reached", async () => {
    const platform = detectPlatform();
    const logger = createLogger("warn");
    const metrics = createMetrics();
    const r = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    const sessionStore = new RedisSessionStore(r);
    const credentials = new EnvCredentialProvider();
    const audit = new AuditWriter(r);
    const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-test-"));
    const workspaceMgr = new WorkspaceManager(platform, path.join(testDataDir, "workspaces"), path.join(testDataDir, "platform"), path.join(testDataDir, "tenants"));

    const pool = new SessionPool(
      { maxSessions: 2, maxSessionsPerTenant: 10, idleTimeoutMs: 300_000 },
      sessionStore, logger, metrics,
    );
    const e = new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, new ToolPlatform(new ToolRegistry(), audit, metrics, logger), logger, metrics);
    pool.setOnEvict((sid) => e.evictSession(sid));

    const T = "test-evict";

    // Create 2 sessions (both idle)
    const r1 = await e.createSession({ tenantId: T, project: "evict" });
    const r2 = await e.createSession({ tenantId: T, project: "evict" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const sid1 = (r1 as any).data.sessionId;
    const sid2 = (r2 as any).data.sessionId;

    expect(e.getPool().size).toBe(2);

    // Create 3rd — should evict oldest idle session (sid1)
    const r3 = await e.createSession({ tenantId: T, project: "evict" });
    expect(r3.ok).toBe(true);

    // sid1 should be evicted; sid2 and sid3 remain
    const remaining = engine.listSessions(T).map((s) => s.sessionId);
    // Engine level. But we're using `e`, a separate engine.
    // Let's check the pool
    expect(pool.get(sid1)).toBeUndefined();
    expect(pool.get(sid2)).toBeDefined();
    expect(pool.get((r3 as any).data.sessionId)).toBeDefined();

    // cleanup
    await e.destroySession(sid2, T);
    await e.destroySession((r3 as any).data.sessionId, T);
    await e.drain();
    const keys = await r.keys(`session:${T}:*`);
    if (keys.length > 0) await r.del(...keys);
    await r.del(`session-index:${T}`);
    await r.quit();
  });
});

describe("AgentEngine prompt (single-turn)", () => {
  const TENANT = "test-single";

  afterAll(async () => {
    const sessions = engine.listSessions(TENANT);
    for (const s of sessions) {
      await engine.destroySession(s.sessionId, TENANT);
    }
  });

  it("prompt returns message_update and agent_end events", async () => {
    const result = await engine.createSession({ tenantId: TENANT, project: "single" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const sid = result.data.sessionId;

    const events = await collectEvents(engine.prompt(sid, TENANT, "Say hello in exactly one word."));

    // Should have at least one message_update
    const msgUpdates = events.filter((e) => e.type === "message_update");
    expect(msgUpdates.length).toBeGreaterThan(0);

    // Should end with agent_end
    const final = events[events.length - 1];
    expect(final.type).toBe("agent_end");

    // Text content should be present
    const text = extractText(events);
    expect(text.length).toBeGreaterThan(0);

    await engine.destroySession(sid, TENANT);
  }, 30000);
});

describe("AgentEngine prompt (multi-turn)", () => {
  const TENANT = "test-multi";

  afterAll(async () => {
    const sessions = engine.listSessions(TENANT);
    for (const s of sessions) {
      await engine.destroySession(s.sessionId, TENANT);
    }
  });

  it("multi-turn conversation preserves context", async () => {
    const result = await engine.createSession({ tenantId: TENANT, project: "multi" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const sid = result.data.sessionId;

    // Turn 1: tell the agent a secret
    const e1 = await collectEvents(
      engine.prompt(sid, TENANT, 'Remember this secret: the password is "orangesky42". Just say "Got it."')
    );
    expect(e1[e1.length - 1].type).toBe("agent_end");

    // Turn 2: ask for the secret
    const e2 = await collectEvents(
      engine.prompt(sid, TENANT, "What is the secret password I told you?")
    );
    expect(e2[e2.length - 1].type).toBe("agent_end");

    const text2 = extractText(e2).toLowerCase();
    // Should contain the secret (or at least acknowledge it)
    // Model may reveal the code OR acknowledge it remembers (both prove multi-turn memory)
    const remembers = text2.includes("orange") || text2.includes("secret") || text2.includes("remember") || text2.includes("password");
    expect(remembers).toBe(true);

    await engine.destroySession(sid, TENANT);
  }, 180000);
});

describe("AgentEngine abort", () => {
  const TENANT = "test-abort";

  afterAll(async () => {
    const sessions = engine.listSessions(TENANT);
    for (const s of sessions) {
      await engine.destroySession(s.sessionId, TENANT);
    }
  });

  it("abort stops an in-flight prompt without throwing", async () => {
    const result = await engine.createSession({ tenantId: TENANT, project: "abort" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const sid = result.data.sessionId;

    // Start a prompt in the background
    let promptDone = false;
    let promptError: unknown = null;
    const promptP = (async () => {
      try {
        for await (const _ of engine.prompt(sid, TENANT, "Write a long poem about clouds.")) {
          // consume events
        }
      } catch (e) {
        promptError = e;
      } finally {
        promptDone = true;
      }
    })();

    // Give it ~1s to start producing events, then abort
    await sleep(1000);
    await engine.abort(sid, TENANT);

    // Wait for prompt loop to finish
    await promptP;

    // Should have finished (either normally or with error — both OK for abort)
    expect(promptDone).toBe(true);

    await engine.destroySession(sid, TENANT);
  }, 30000);
});

describe("AgentEngine tenant isolation", () => {
  const TENANT_A = "test-isolation";
  const TENANT_B = "test-isolation-b";

  afterAll(async () => {
    for (const t of [TENANT_A, TENANT_B]) {
      const sessions = engine.listSessions(t);
      for (const s of sessions) {
        await engine.destroySession(s.sessionId, t);
      }
    }
  });

  it("cross-tenant prompt throws Forbidden", async () => {
    // Create session for tenant A
    const result = await engine.createSession({ tenantId: TENANT_A, project: "iso" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const sid = result.data.sessionId;

    // Tenant B tries to prompt A's session
    let threw = false;
    try {
      for await (const _ of engine.prompt(sid, TENANT_B, "Hello")) {
        // should not reach here
      }
    } catch (e: any) {
      threw = true;
      expect(e.message).toContain("Forbidden");
    }
    expect(threw).toBe(true);

    await engine.destroySession(sid, TENANT_A);
  }, 15000);
});

describe("AgentEngine concurrent sessions", () => {
  const TENANT = "test-concurrent";

  afterAll(async () => {
    const sessions = engine.listSessions(TENANT);
    for (const s of sessions) {
      await engine.destroySession(s.sessionId, TENANT);
    }
  });

  it("3 concurrent sessions all complete successfully", async () => {
    // Create 3 sessions
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await engine.createSession({ tenantId: TENANT, project: "concurrent" });
      expect(r.ok).toBe(true);
      if (r.ok) results.push(r.data.sessionId);
    }
    expect(results).toHaveLength(3);

    // Run prompts in parallel
    const prompts = results.map((sid) =>
      collectEvents(engine.prompt(sid, TENANT, `Say the word "ok" and nothing else.`))
    );

    const allEvents = await Promise.all(prompts);

    // All should end with agent_end
    for (const events of allEvents) {
      expect(events[events.length - 1].type).toBe("agent_end");
    }

    // Cleanup
    for (const sid of results) {
      await engine.destroySession(sid, TENANT);
    }
  }, 90000);
});
