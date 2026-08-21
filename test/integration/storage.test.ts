import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { RedisSessionStore } from "../../src/pth/kernel/storage/session/redis-session-store.js";
import type { SessionMeta, SessionEntry, Snapshot } from "../../src/pth/kernel/storage/session/types.js";

const TENANT = "test-storage";
const PROJECT = "integration";

let redis: Redis;
let sessionStore: RedisSessionStore;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  sessionStore = new RedisSessionStore(redis);
});

afterAll(async () => {
  // Flush test keys（RedisSettingsStore 已删——2026-08-14 A2 Phase 2，设置键清理随删）
  const keys = await redis.keys(`session:${TENANT}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.del(`session-index:${TENANT}`);
  await redis.quit();
});

describe("RedisSessionStore", () => {
  const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("saveMeta + getMeta roundtrip", async () => {
    const meta: SessionMeta = {
      version: 1,
      sessionId: SID,
      tenantId: TENANT,
      project: PROJECT,
      model: "test-model-v1",
      thinkingLevel: "medium",
      status: "active",
      entryCount: 0,
      lastEntrySeq: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await sessionStore.saveMeta(TENANT, SID, meta);
    const got = await sessionStore.getMeta(TENANT, SID);

    expect(got).not.toBeNull();
    expect(got!.sessionId).toBe(SID);
    expect(got!.tenantId).toBe(TENANT);
    expect(got!.project).toBe(PROJECT);
    expect(got!.model).toBe("test-model-v1");
    expect(got!.thinkingLevel).toBe("medium");
    expect(got!.status).toBe("active");
    expect(got!.entryCount).toBe(0);
  });

  it("getMeta returns null for unknown session", async () => {
    const got = await sessionStore.getMeta(TENANT, "nonexistent-session");
    expect(got).toBeNull();
  });

  it("appendEntry + getEntries preserves order", async () => {
    const entry1: SessionEntry = {
      version: 1,
      seq: 1,
      id: "msg-1",
      parentId: null,
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      createdAt: new Date().toISOString(),
    };
    const entry2: SessionEntry = {
      version: 1,
      seq: 2,
      id: "msg-2",
      parentId: "msg-1",
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
      createdAt: new Date().toISOString(),
    };
    const entry3: SessionEntry = {
      version: 1,
      seq: 3,
      id: "msg-3",
      parentId: "msg-2",
      role: "user",
      content: [{ type: "text", text: "How are you?" }],
      createdAt: new Date().toISOString(),
    };

    await sessionStore.appendEntry(TENANT, SID, entry1);
    await sessionStore.appendEntry(TENANT, SID, entry2);
    await sessionStore.appendEntry(TENANT, SID, entry3);

    const entries = await sessionStore.getEntries(TENANT, SID);
    expect(entries).toHaveLength(3);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].role).toBe("user");
    expect(entries[1].seq).toBe(2);
    expect(entries[1].role).toBe("assistant");
    expect(entries[2].seq).toBe(3);
    expect(entries[2].role).toBe("user");

    // appendEntry also updates meta.entryCount
    const meta = await sessionStore.getMeta(TENANT, SID);
    expect(meta!.entryCount).toBe(3);
    expect(meta!.lastEntrySeq).toBe(3);
  });

  it("getEntries respects fromSeq", async () => {
    const entries = await sessionStore.getEntries(TENANT, SID, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(2);
    expect(entries[1].seq).toBe(3);
  });

  it("saveSnapshot + getLatestSnapshot roundtrip", async () => {
    const snapshot: Snapshot = {
      version: 1,
      seq: 3,
      entries: [
        {
          version: 1, seq: 1, id: "msg-1", parentId: null,
          role: "user", content: [{ type: "text", text: "Hello" }],
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    };

    await sessionStore.saveSnapshot(TENANT, SID, snapshot);
    const got = await sessionStore.getLatestSnapshot(TENANT, SID);

    expect(got).not.toBeNull();
    expect(got!.seq).toBe(3);
    expect(got!.entries).toHaveLength(1);
  });

  it("listSessions returns sessions for tenant", async () => {
    const list = await sessionStore.listSessions(TENANT);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((s) => s.sessionId === SID)).toBe(true);
  });

  it("listSessions filters by project", async () => {
    const list = await sessionStore.listSessions(TENANT, PROJECT);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((s) => s.project === PROJECT)).toBe(true);

    const other = await sessionStore.listSessions(TENANT, "nonexistent-project");
    expect(other.length).toBe(0);
  });

  it("saveVersionSnapshot + getLatestVersionSnapshot roundtrip", async () => {
    const record = {
      seq: 3,
      skills: ["skill-a:abc123", "skill-b:def456"],
      prompts: ["prompt-x:111"],
      tools: ["read", "bash"],
      timestamp: new Date().toISOString(),
    };

    await sessionStore.saveVersionSnapshot(TENANT, SID, record);
    const got = await sessionStore.getLatestVersionSnapshot(TENANT, SID);

    expect(got).not.toBeNull();
    expect(got!.seq).toBe(3);
    expect(got!.skills).toEqual(["skill-a:abc123", "skill-b:def456"]);
    expect(got!.prompts).toEqual(["prompt-x:111"]);
    expect(got!.tools).toEqual(["read", "bash"]);
  });

  it("getLatestVersionSnapshot returns null for unknown session", async () => {
    const got = await sessionStore.getLatestVersionSnapshot(TENANT, "nonexistent");
    expect(got).toBeNull();
  });

  it("deleteSession removes all keys", async () => {
    const delSid = "del-test-session";
    await sessionStore.saveMeta(TENANT, delSid, {
      version: 1, sessionId: delSid, tenantId: TENANT, project: PROJECT,
      model: "x", thinkingLevel: "medium", status: "active",
      entryCount: 2, lastEntrySeq: 2,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await sessionStore.appendEntry(TENANT, delSid, {
      version: 1, seq: 1, id: "d1", parentId: null,
      role: "user", content: [{ type: "text", text: "x" }],
      createdAt: new Date().toISOString(),
    });
    await sessionStore.appendEntry(TENANT, delSid, {
      version: 1, seq: 2, id: "d2", parentId: "d1",
      role: "assistant", content: [{ type: "text", text: "y" }],
      createdAt: new Date().toISOString(),
    });

    // Verify it exists
    expect(await sessionStore.getMeta(TENANT, delSid)).not.toBeNull();

    await sessionStore.deleteSession(TENANT, delSid);

    // After deletion
    expect(await sessionStore.getMeta(TENANT, delSid)).toBeNull();
    expect(await sessionStore.getEntries(TENANT, delSid)).toEqual([]);
    expect(await sessionStore.getLatestSnapshot(TENANT, delSid)).toBeNull();
  });
});

