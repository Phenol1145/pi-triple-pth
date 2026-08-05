/**
 * test/unit/hub-observe.test.ts — F/WP4 Task 21 hub observe 只读观测路由
 *
 * 覆盖：路由（sessions/session 详情/trace）+ 权限（无 Bearer→401）+
 * tenant 隔离（A 不可见 B 的会话）+ events 端点（WP5 交付前的 501 占位）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { RedisSessionStore } from "../../src/pth/storage/redis-session-store.js";
import { createAuthHook } from "../../src/pth/gateway/auth.js";
import { registerObserveRoutes } from "../../src/pth/gateway/routes-observe.js";
import type { SessionEntry } from "../../src/pth/storage/types.js";

// ── mock Redis（observe 用：get/set/del/incr + zset——RedisSessionStore 依赖）─────

class MockRedis {
  store = new Map<string, string>();
  zsets = new Map<string, { member: string; score: number }[]>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return Promise.resolve("OK");
  }
  del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let count = 0;
    for (const k of keys) if (this.store.delete(k)) count++;
    return Promise.resolve(count);
  }
  mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((k) => this.store.get(k) ?? null));
  }
  incr(key: string): Promise<number> {
    const v = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(v));
    return Promise.resolve(v);
  }
  zadd(key: string, score: number, member: string): Promise<number> {
    const arr = this.zsets.get(key) ?? [];
    const existing = arr.find((e) => e.member === member);
    if (existing) {
      existing.score = score;
      return Promise.resolve(0);
    }
    arr.push({ member, score });
    this.zsets.set(key, arr);
    return Promise.resolve(1);
  }
  zrange(key: string, start: number, stop: number): Promise<string[]> {
    const arr = (this.zsets.get(key) ?? [])
      .slice().sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    const sliced = arr.slice(start, stop === -1 ? undefined : stop + 1);
    return Promise.resolve(sliced.map((e) => e.member));
  }
  zrem(key: string, ...members: string[]): Promise<number> {
    const arr = this.zsets.get(key) ?? [];
    const kept = arr.filter((e) => !members.includes(e.member));
    this.zsets.set(key, kept);
    return Promise.resolve(arr.length - kept.length);
  }
}

function entry(seq: number, role: SessionEntry["role"], text: string): SessionEntry {
  return {
    version: 1,
    seq,
    id: `e-${seq}`,
    parentId: seq > 1 ? `e-${seq - 1}` : null,
    role,
    content: [{ type: "text", text }],
    createdAt: new Date(2026, 7, 5, 10, 0, seq).toISOString(),
  };
}

describe("hub observe 路由", () => {
  let redis: MockRedis;
  let store: RedisSessionStore;
  let app: ReturnType<typeof Fastify>;

  const TOKEN_A = "token-a";
  const TOKEN_B = "token-b";
  const headersA = { authorization: `Bearer ${TOKEN_A}` };
  const headersB = { authorization: `Bearer ${TOKEN_B}` };

  beforeEach(async () => {
    redis = new MockRedis();
    store = new RedisSessionStore(redis as any);

    // 会话痕迹：tenant-a 两个会话（一个带 entry），tenant-b 一个会话
    await store.saveMeta("tenant-a", "sess-a1", {
      version: 1, sessionId: "sess-a1", tenantId: "tenant-a", project: "proj-a",
      model: "m1", thinkingLevel: "medium", status: "active",
      entryCount: 0, lastEntrySeq: 0,
      createdAt: "2026-08-05T10:00:00.000Z", updatedAt: "2026-08-05T10:00:00.000Z",
    });
    await store.saveMeta("tenant-a", "sess-a2", {
      version: 1, sessionId: "sess-a2", tenantId: "tenant-a", project: "proj-a",
      model: "m2", thinkingLevel: "high", status: "idle",
      entryCount: 0, lastEntrySeq: 0,
      createdAt: "2026-08-05T10:05:00.000Z", updatedAt: "2026-08-05T10:05:00.000Z",
    });
    await store.saveMeta("tenant-b", "sess-b1", {
      version: 1, sessionId: "sess-b1", tenantId: "tenant-b", project: "proj-b",
      model: "m3", thinkingLevel: "medium", status: "active",
      entryCount: 0, lastEntrySeq: 0,
      createdAt: "2026-08-05T11:00:00.000Z", updatedAt: "2026-08-05T11:00:00.000Z",
    });
    // 会话 A1 追加两条 entry（trace 用）
    await store.appendEntry("tenant-a", "sess-a1", entry(1, "user", "你好"));
    await store.appendEntry("tenant-a", "sess-a1", entry(2, "assistant", "收到"));

    await redis.set(`auth:token:${TOKEN_A}`, JSON.stringify({ tenantId: "tenant-a", role: "tenant-agent" }));
    await redis.set(`auth:token:${TOKEN_B}`, JSON.stringify({ tenantId: "tenant-b", role: "tenant-agent" }));

    app = Fastify({ logger: false });
    app.addHook("onRequest", createAuthHook(redis as any));
    registerObserveRoutes(app, store);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("权限断言：无 Bearer → 401（全部 observe 端点）", async () => {
    for (const url of [
      "/api/v1/observe/sessions",
      "/api/v1/observe/sessions/sess-a1",
      "/api/v1/observe/trace/sess-a1",
      "/api/v1/observe/events",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("会话列表：仅返回本租户会话（tenant 隔离）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/sessions", headers: headersA });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body.map((s: any) => s.sessionId).sort()).toEqual(["sess-a1", "sess-a2"]);
    expect(body.every((s: any) => s.tenantId === "tenant-a")).toBe(true);

    const resB = await app.inject({ method: "GET", url: "/api/v1/observe/sessions", headers: headersB });
    const bodyB = JSON.parse(resB.body);
    expect(bodyB.map((s: any) => s.sessionId)).toEqual(["sess-b1"]);
  });

  it("会话详情：返回 meta（entryCount/lastEntrySeq/状态）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/sessions/sess-a1", headers: headersA });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe("sess-a1");
    expect(body.tenantId).toBe("tenant-a");
    expect(body.entryCount).toBe(2);
    expect(body.lastEntrySeq).toBe(2);
    expect(body.status).toBe("active");
  });

  it("会话详情 tenant 隔离：A 访问 B 的会话 → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/sessions/sess-b1", headers: headersA });
    expect(res.statusCode).toBe(404);
  });

  it("会话详情：未知会话 → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/sessions/nope", headers: headersA });
    expect(res.statusCode).toBe(404);
  });

  it("trace：返回完整时间线（seq 升序 + 内容）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/trace/sess-a1", headers: headersA });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe("sess-a1");
    expect(body.tenantId).toBe("tenant-a");
    expect(body.project).toBe("proj-a");
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e: any) => e.seq)).toEqual([1, 2]);
    expect(body.entries[0].content[0].text).toBe("你好");
    expect(body.entries[1].role).toBe("assistant");
  });

  it("trace tenant 隔离：A 访问 B 的会话 → 404（不泄露存在性）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/trace/sess-b1", headers: headersA });
    expect(res.statusCode).toBe(404);
  });

  it("trace：未知会话 → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/trace/nope", headers: headersA });
    expect(res.statusCode).toBe(404);
  });

  it("events：EventLog 代理未交付 → 501 + 依赖标注说明（评审 I1）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observe/events", headers: headersA });
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/WP5 Task 23\/24/);
    expect(body.error).toMatch(/Task 28/);
  });
});
