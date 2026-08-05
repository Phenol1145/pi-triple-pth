import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import Fastify from "fastify";
import { FallbackRequestStore, URGENCIES, type FallbackRequest } from "../../src/pth/fallback/requests.js";
import { AuditWriter } from "../../src/pth/observability/audit.js";
import { ProgramStore } from "../../src/pth/programs/store.js";
import { registerProgramRoutes } from "../../src/pth/gateway/routes-programs.js";
import { registerFallbackRoutes } from "../../src/pth/gateway/routes-fallback.js";
import { createAuthHook } from "../../src/pth/gateway/auth.js";
import type { ComponentManifest } from "../../src/pth/components/store.js";

// ── mock Redis（fallback 用：hset/hget/hgetall + audit stream）──────

export class MockRedis {
  store = new Map<string, string>();
  streams = new Map<string, { id: string; fields: Record<string, string> }[]>();

  incr(key: string): Promise<number> {
    const v = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(v));
    return Promise.resolve(v);
  }
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
  sadd(key: string, ...members: string[]): Promise<number> {
    const arr: string[] = JSON.parse(this.store.get(key) ?? "[]");
    let added = 0;
    for (const m of members) if (!arr.includes(m)) { arr.push(m); added++; }
    this.store.set(key, JSON.stringify(arr));
    return Promise.resolve(added);
  }
  smembers(key: string): Promise<string[]> {
    return Promise.resolve(JSON.parse(this.store.get(key) ?? "[]"));
  }
  srem(key: string, ...members: string[]): Promise<number> {
    const arr: string[] = JSON.parse(this.store.get(key) ?? "[]");
    const kept = arr.filter((m) => !members.includes(m));
    this.store.set(key, JSON.stringify(kept));
    return Promise.resolve(arr.length - kept.length);
  }
  hset(key: string, field: string, value: string): Promise<number> {
    const raw = this.store.get(key);
    const hash: Record<string, string> = raw ? JSON.parse(raw) : {};
    const created = !(field in hash);
    hash[field] = value;
    this.store.set(key, JSON.stringify(hash));
    return Promise.resolve(created ? 1 : 0);
  }
  hget(key: string, field: string): Promise<string | null> {
    const raw = this.store.get(key);
    if (!raw) return Promise.resolve(null);
    const hash = JSON.parse(raw) as Record<string, string>;
    return Promise.resolve(hash[field] ?? null);
  }
  hgetall(key: string): Promise<Record<string, string>> {
    const raw = this.store.get(key);
    return Promise.resolve(raw ? (JSON.parse(raw) as Record<string, string>) : {});
  }
  xadd(key: string, _id: string, ...fields: string[]): Promise<string> {
    const rec: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) rec[fields[i]!] = fields[i + 1]!;
    const arr = this.streams.get(key) ?? [];
    arr.push({ id: `${arr.length + 1}-0`, fields: rec });
    this.streams.set(key, arr);
    return Promise.resolve(`${arr.length}-0`);
  }
  xtrim(): Promise<number> { return Promise.resolve(0); }
}

function auditEvents(redis: MockRedis): Array<{ action: string; details: Record<string, unknown>; tenantId: string; actor: string }> {
  const entries = redis.streams.get("audit:log") ?? [];
  return entries.map((e) => JSON.parse(e.fields.data ?? "{}"));
}

// ── ustar/gzip helpers（respond 上传路由测试用）────────────────────

function padOctal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}
function checksum(header: Buffer): number {
  let sum = 256;
  for (let i = 0; i < 512; i++) if (i < 148 || i >= 156) sum += header[i]!;
  return sum;
}
function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf-8");
  buf.write(padOctal(0o644, 8), 100, 8, "utf-8");
  buf.write(padOctal(0, 8), 108, 8, "utf-8");
  buf.write(padOctal(0, 8), 116, 8, "utf-8");
  buf.write(padOctal(size, 12), 124, 12, "utf-8");
  buf.write(padOctal(0, 12), 136, 12, "utf-8");
  buf.write("        ", 148, 8, "utf-8");
  buf.write("0", 156, 1, "utf-8");
  buf.write("ustar\0", 257, 6, "utf-8");
  buf.write("00", 263, 2, "utf-8");
  buf.write(padOctal(checksum(buf), 7), 148, 8, "utf-8");
  return buf;
}
function makeTar(files: { name: string; content: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const content = Buffer.from(f.content, "utf-8");
    chunks.push(tarHeader(f.name, content.length));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(512));
  chunks.push(Buffer.alloc(512));
  return Buffer.concat(chunks);
}
function gzipB64(files: { name: string; content: string }[]): string {
  return gzipSync(makeTar(files)).toString("base64");
}

describe("FallbackRequestStore（store 层）", () => {
  let redis: MockRedis;
  let store: FallbackRequestStore;

  beforeEach(() => {
    redis = new MockRedis();
    store = new FallbackRequestStore(redis as any, new AuditWriter(redis as any));
  });

  it("建单：requestId 生成、status=open、urgency 缺省 medium、slotHint/description 记录", async () => {
    const r = await store.create(
      { slotHint: "slot-a", description: "缺一个审核 agent" },
      { tenantId: "t1" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requestId.length).toBeGreaterThan(0);
    expect(r.value.status).toBe("open");
    expect(r.value.urgency).toBe("medium");
    expect(r.value.slotHint).toBe("slot-a");
    expect(r.value.description).toBe("缺一个审核 agent");
    expect(new Date(r.value.createdAt).getTime()).not.toBeNaN();
  });

  it("urgency 合法值校验：low/high 接受，非法拒绝", async () => {
    expect(URGENCIES).toEqual(["low", "medium", "high"]);
    const high = await store.create({ description: "urgent", urgency: "high" }, { tenantId: "t1" });
    expect(high.ok && high.value.urgency === "high").toBe(true);
    const bad = await store.create({ description: "x", urgency: "critical" }, { tenantId: "t1" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("urgency");
  });

  it("空 description 拒绝；超长拒绝", async () => {
    const empty = await store.create({ description: "   " }, { tenantId: "t1" });
    expect(empty.ok).toBe(false);
    const long = await store.create({ description: "a".repeat(2001) }, { tenantId: "t1" });
    expect(long.ok).toBe(false);
  });

  it("列表 open 优先：open 请求排在 closed 之前", async () => {
    const a = await store.create({ description: "A" }, { tenantId: "t1" });
    const b = await store.create({ description: "B" }, { tenantId: "t1" });
    if (!a.ok || !b.ok) return;
    await store.close(a.value.requestId, { tenantId: "t1", closedBy: "t1" });

    const list = await store.list();
    expect(list.map((r) => r.requestId)).toEqual([b.value.requestId, a.value.requestId]);
    expect(list[0]!.status).toBe("open");
    expect(list[1]!.status).toBe("closed");
  });

  it("闭合：status=closed + closedBy/closedAt/component 记录", async () => {
    const c = await store.create({ description: "fill me" }, { tenantId: "t1" });
    if (!c.ok) return;
    const r = await store.close(c.value.requestId, {
      tenantId: "t1",
      closedBy: "t1",
      component: { type: "agent-program", name: "echo", version: 3 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("closed");
    expect(r.value.closedBy).toBe("t1");
    expect(new Date(r.value.closedAt!).getTime()).not.toBeNaN();
    expect(r.value.component).toEqual({ type: "agent-program", name: "echo", version: 3 });
  });

  it("闭合幂等：重复 close 返回现有记录且不重复审计（网络重试安全）", async () => {
    const c = await store.create({ description: "fill me" }, { tenantId: "t1" });
    if (!c.ok) return;
    await store.close(c.value.requestId, { tenantId: "t1", closedBy: "t1" });
    await store.close(c.value.requestId, { tenantId: "t1", closedBy: "t1" });

    const closed = auditEvents(redis).filter((e) => e.action === "fallback_request_closed");
    expect(closed).toHaveLength(1);
    const g = await store.get(c.value.requestId);
    expect(g.ok && g.value.status === "closed").toBe(true);
  });

  it("get 未知请求 → 错误", async () => {
    const g = await store.get("nope-1");
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toContain("nope-1");
  });

  it("审计事件：created 含 requestId/slotHint/description/urgency；closed 含 requestId/component", async () => {
    const c = await store.create({ slotHint: "slot-x", description: "缺个调度器", urgency: "high" }, { tenantId: "t1" });
    if (!c.ok) return;
    await store.close(c.value.requestId, {
      tenantId: "t1",
      closedBy: "builder",
      component: { type: "scheduler", name: "daily", version: 1 },
    });

    const events = auditEvents(redis);
    const created = events.find((e) => e.action === "fallback_request_created");
    expect(created!.tenantId).toBe("t1");
    expect(created!.actor).toBe("user");
    expect(created!.details.requestId).toBe(c.value.requestId);
    expect(created!.details.slotHint).toBe("slot-x");
    expect(created!.details.urgency).toBe("high");

    const closed = events.find((e) => e.action === "fallback_request_closed");
    expect(closed!.actor).toBe("builder");
    expect(closed!.details.component).toEqual({ type: "scheduler", name: "daily", version: 1 });
  });
});

describe("fallback_requests 路由", () => {
  let app: ReturnType<typeof Fastify>;
  let redis: MockRedis;
  let store: FallbackRequestStore;
  let fallback: FallbackRequestStore;

  const TOKEN = "valid-token";

  function buildApp(withProgramRoutes: boolean, compStore?: ProgramStore): ReturnType<typeof Fastify> {
    const a = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });
    a.addHook("onRequest", createAuthHook(redis as any));
    if (withProgramRoutes && compStore) {
      const mockEngine = {
        createSession: async () => ({ ok: true, data: { sessionId: "s1", tenantId: "t1", project: "default", state: "idle", model: "unknown", createdAt: "", lastAccess: "" } }),
        prompt: async function* () { /* noop */ },
        destroySession: async () => undefined,
      } as any;
      registerProgramRoutes(a, mockEngine, compStore, fallback);
    }
    registerFallbackRoutes(a, fallback);
    return a;
  }

  beforeEach(async () => {
    redis = new MockRedis();
    fallback = new FallbackRequestStore(redis as any, new AuditWriter(redis as any));
    await redis.set(`auth:token:${TOKEN}`, JSON.stringify({ tenantId: "t1", role: "tenant-agent" }));
    store = fallback;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("权限断言：无 Bearer 请求被拒 401", async () => {
    app = buildApp(false);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/fallback-requests",
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(401);
    const list = await app.inject({ method: "GET", url: "/api/v1/fallback-requests" });
    expect(list.statusCode).toBe(401);
  });

  it("POST 建单 201；GET 列表 open 优先；POST close 闭合", async () => {
    app = buildApp(false);
    await app.ready();

    const headers = { authorization: `Bearer ${TOKEN}` };

    const r1 = await app.inject({
      method: "POST",
      url: "/api/v1/fallback-requests",
      headers,
      payload: { slotHint: "slot-a", description: "缺个调度器", urgency: "high" },
    });
    expect(r1.statusCode).toBe(201);
    const created = JSON.parse(r1.body) as FallbackRequest;
    expect(created.status).toBe("open");
    expect(created.urgency).toBe("high");

    const r2 = await app.inject({
      method: "POST",
      url: "/api/v1/fallback-requests",
      headers,
      payload: { description: "另一个" },
    });
    const created2 = JSON.parse(r2.body) as FallbackRequest;

    // close 第一个 → 列表 open 优先（第二个在前）
    const close = await app.inject({
      method: "POST",
      url: `/api/v1/fallback-requests/${created.requestId}/close`,
      headers,
      payload: { closedBy: "ops" },
    });
    expect(close.statusCode).toBe(200);
    const closedBody = JSON.parse(close.body) as FallbackRequest;
    expect(closedBody.status).toBe("closed");
    expect(closedBody.closedBy).toBe("ops");

    const list = await app.inject({ method: "GET", url: "/api/v1/fallback-requests", headers });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.body) as FallbackRequest[];
    expect(listBody[0]!.requestId).toBe(created2.requestId);
    expect(listBody[0]!.status).toBe("open");
    expect(listBody[1]!.status).toBe("closed");
  });

  it("close 未知请求 → 404", async () => {
    app = buildApp(false);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/fallback-requests/nope/close",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("建单非法（空 description）→ 400", async () => {
    app = buildApp(false);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/fallback-requests",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { description: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("respond 自动闭合：构件上传携带 requestId → 保存成功 + 请求 closed + component 记录", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-fbk-route-"));
    const compStore = new ProgramStore(redis as any, tmpDir);
    app = buildApp(true, compStore);
    await app.ready();

    const headers = { authorization: `Bearer ${TOKEN}` };

    // 建单
    const createdRes = await app.inject({
      method: "POST",
      url: "/api/v1/fallback-requests",
      headers,
      payload: { slotHint: "slot-review", description: "缺个审核 agent" },
    });
    const created = JSON.parse(createdRes.body) as FallbackRequest;

    // respond：上传构件 + requestId 关联
    const mf: ComponentManifest = { type: "agent-program", name: "reviewer", systemPrompt: "PROMPT.md" };
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers,
      payload: {
        type: "agent-program",
        requestId: created.requestId,
        manifest: mf,
        archive: gzipB64([
          { name: "agent.json", content: JSON.stringify(mf) },
          { name: "PROMPT.md", content: "review" },
        ]),
      },
    });
    expect(upload.statusCode).toBe(201);
    const uploadBody = JSON.parse(upload.body);
    expect(uploadBody.closedRequest).toBe(created.requestId);

    // 请求已闭合 + component 记录
    const g = await fallback.get(created.requestId);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.status).toBe("closed");
    expect(g.value.closedBy).toBe("t1");
    expect(g.value.component).toEqual({ type: "agent-program", name: "reviewer", version: 1 });

    // 审计含 closed 事件
    const closed = auditEvents(redis).filter((e) => e.action === "fallback_request_closed");
    expect(closed).toHaveLength(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("respond 闭合失败（请求不存在）→ 上传仍成功 + closeWarning 提示", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-fbk-route2-"));
    const compStore = new ProgramStore(redis as any, tmpDir);
    app = buildApp(true, compStore);
    await app.ready();

    const headers = { authorization: `Bearer ${TOKEN}` };
    const mf: ComponentManifest = { type: "agent-program", name: "orphan", systemPrompt: "PROMPT.md" };
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      headers,
      payload: {
        type: "agent-program",
        requestId: "ghost-request",
        manifest: mf,
        archive: gzipB64([
          { name: "agent.json", content: JSON.stringify(mf) },
          { name: "PROMPT.md", content: "x" },
        ]),
      },
    });
    expect(upload.statusCode).toBe(201);
    const body = JSON.parse(upload.body);
    expect(body.closeWarning).toContain("ghost-request");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
