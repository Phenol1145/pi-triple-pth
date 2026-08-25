import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { Redis } from "ioredis";
import { Redis as IoRedis } from "ioredis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { ProgramStore } from "../../src/pth/programs/store.js";
import { registerProgramRoutes } from "../../src/pth/gateway/routes-programs.js";
import type { AgentEngine } from "../../src/pth/core/agent-engine.js";

/**
 * Integration tests for programs routes.
 * Mocks AgentEngine (only createSession/prompt used by run), uses real ProgramStore.
 */
describe("programs routes", () => {
  let app: ReturnType<typeof Fastify>;
  let redis: Redis;
  let store: ProgramStore;
  let tmpDir: string;
  let engineSessions: Map<string, { sessionId: string; tenantId: string }>;
  let nextSeq: number;
  let testIdx = 0;
  const tenantId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    redis = new IoRedis({ host: "localhost", port: 6379, maxRetriesPerRequest: 1, lazyConnect: true });
    try { await redis.connect(); } catch { /* Redis may be unavailable */ }

    // Clean up any stale keys from prior runs
    try {
      const keys = await redis.keys(`programs:${tenantId}*`);
      const progKeys = await redis.keys(`program:${tenantId}:*`);
      const allKeys = [...keys, ...progKeys];
      for (const k of allKeys) await redis.del(k);
    } catch { /* best-effort */ }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-programs-test-"));
    store = new ProgramStore(redis, tmpDir);

    engineSessions = new Map();
    nextSeq = 0;
    testIdx = 0;

    const mockEngine = {
      createSession: async (opts: any) => {
        const sessionId = `test-session-${nextSeq++}`;
        engineSessions.set(sessionId, { sessionId, tenantId: opts.tenantId });
        return {
          ok: true,
          data: { sessionId, tenantId: opts.tenantId, project: opts.project, state: "idle", model: opts.model ?? "unknown", createdAt: new Date().toISOString(), lastAccess: new Date().toISOString() },
        };
      },
      prompt: async function* (_sessionId: string, _tenantId: string, _text: string) {
        yield { seq: 1, type: "message_update", data: { text: "test output" }, timestamp: new Date().toISOString() };
        yield { seq: 2, type: "agent_end", data: {}, terminal: true, timestamp: new Date().toISOString() };
      },
      destroySession: async (sessionId: string) => {
        engineSessions.delete(sessionId);
      },
    } as unknown as AgentEngine;

    app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (req) => {
      (req as any).auth = { tenantId, role: "platform-admin" };
    });
    registerProgramRoutes(app, mockEngine, store);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    redis.disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function uniq(name: string): string {
    return `${name}-${testIdx++}`;
  }

  /** Build a minimal gzip-compressed ustar archive from files. */
  function makeGzipTar(files: { name: string; content: string }[]): string {
    const records: Buffer[] = [];
    const addFile = (name: string, content: string) => {
      const buf = Buffer.from(content);
      const header = Buffer.alloc(512, 0);
      header.write(name.padEnd(100, "\0"), 0, 100, "utf-8");
      header.write("000644 \0", 100, 8, "utf-8");          // mode
      header.write("000000 \0", 108, 7, "utf-8");           // uid
      header.write("000000 \0", 116, 7, "utf-8");           // gid
      const sizeOct = buf.length.toString(8).padStart(11, "0");
      header.write(sizeOct + " ", 124, 12, "utf-8");         // size
      header.write("00000000000 ", 136, 12, "utf-8");        // mtime
      header.write("        ", 148, 8, "utf-8");             // chksum placeholder
      header.write("0", 156, 1, "utf-8");                    // typeflag
      header.write("ustar\0", 257, 6, "utf-8");              // magic
      header.write("00", 263, 2, "utf-8");                   // version
      // checksum
      let ck = 0;
      for (let i = 0; i < 512; i++) ck += header[i]!;
      header.write(ck.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");
      records.push(header);
      records.push(buf);
      const remainder = buf.length % 512;
      if (remainder > 0) records.push(Buffer.alloc(512 - remainder));
    };
    for (const f of files) addFile(f.name, f.content);
    records.push(Buffer.alloc(512)); // two zero blocks = end of archive
    records.push(Buffer.alloc(512));
    const tarBuf = Buffer.concat(records);
    return gzipSync(tarBuf).toString("base64");
  }

  // ── Tests ─────────────────────────────────────────────

  it("POST /programs submits and returns version 1", async () => {
    const name = uniq("hello");
    const manifest = { name, description: "test", systemPrompt: "PROMPT.md" };
    const archive = makeGzipTar([
      { name: "agent.json", content: JSON.stringify(manifest) },
      { name: "PROMPT.md", content: "Say hello." },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest, archive } });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe(name);
    expect(body.version).toBe(1);
  });

  it("POST /programs increments version", async () => {
    const name = uniq("hello");
    const base = { archive: makeGzipTar([{ name: "agent.json", content: JSON.stringify({ name, systemPrompt: "PROMPT.md" }) }, { name: "PROMPT.md", content: "hi" }]) };
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest: { name, systemPrompt: "PROMPT.md" }, archive: base.archive } });
    const res = await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest: { name, description: "v2", systemPrompt: "PROMPT.md" }, archive: base.archive } });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).version).toBe(2);
  });

  it("GET /programs lists programs", async () => {
    const name = uniq("hello");
    const manifest = { name, systemPrompt: "PROMPT.md" };
    const archive = makeGzipTar([{ name: "agent.json", content: JSON.stringify(manifest) }, { name: "PROMPT.md", content: "hi" }]);
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest, archive } });
    const res = await app.inject({ method: "GET", url: "/api/v1/programs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const found = body.find((p: any) => p.name === name);
    expect(found).toBeTruthy();
    expect(found.latestVersion).toBe(1);
  });

  it("GET /programs/:name returns detail", async () => {
    const name = uniq("hello");
    const manifest = { name, systemPrompt: "PROMPT.md" };
    const archive = makeGzipTar([{ name: "agent.json", content: JSON.stringify(manifest) }, { name: "PROMPT.md", content: "hi" }]);
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest, archive } });
    const res = await app.inject({ method: "GET", url: `/api/v1/programs/${name}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe(name);
    expect(body.version).toBe(1);
    expect(body.manifest.systemPrompt).toBe("PROMPT.md");
  });

  it("GET /programs/:nonexist returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/programs/nope-never-exists" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /programs/:name/run returns SSE stream", async () => {
    const name = uniq("hello");
    const manifest = { name, systemPrompt: "PROMPT.md" };
    const archive = makeGzipTar([{ name: "agent.json", content: JSON.stringify(manifest) }, { name: "PROMPT.md", content: "hi" }]);
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest, archive } });
    const res = await app.inject({ method: "POST", url: `/api/v1/programs/${name}/run`, payload: { input: { text: "hi" } } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["x-program-version"]).toBe("1");
    expect(res.headers["x-session-id"]).toBeTruthy();
    expect(res.body).toContain("data: [DONE]");
    expect(res.body).toContain("test output");
  });

  it("POST /programs/:name/run --version 1 works", async () => {
    const name = uniq("hello");
    const manifest = { name, systemPrompt: "PROMPT.md" };
    const archive = makeGzipTar([{ name: "agent.json", content: JSON.stringify(manifest) }, { name: "PROMPT.md", content: "hi" }]);
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest, archive } });
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest: { ...manifest, description: "v2" }, archive } });
    const res = await app.inject({ method: "POST", url: `/api/v1/programs/${name}/run`, payload: { input: { text: "hi" }, version: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-program-version"]).toBe("1");
  });

  it("POST /programs/:name/run missing required input returns 400", async () => {
    const name = uniq("reviewer");
    const manifest = { name, systemPrompt: "PROMPT.md", input: { schema: { type: "object", required: ["repo"] } } };
    const archive = makeGzipTar([{ name: "agent.json", content: JSON.stringify(manifest) }, { name: "PROMPT.md", content: "Review." }]);
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest, archive } });
    const res = await app.inject({ method: "POST", url: `/api/v1/programs/${name}/run`, payload: { input: { other: "x" } } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("missing required field");
  });

  it("DELETE /programs/:name removes all versions", async () => {
    const name = uniq("hello");
    const manifest = { name, systemPrompt: "PROMPT.md" };
    const archive = makeGzipTar([{ name: "agent.json", content: JSON.stringify(manifest) }, { name: "PROMPT.md", content: "hi" }]);
    await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest, archive } });
    const res = await app.inject({ method: "DELETE", url: `/api/v1/programs/${name}` });
    expect(res.statusCode).toBe(200);
    const res2 = await app.inject({ method: "GET", url: `/api/v1/programs/${name}` });
    expect(res2.statusCode).toBe(404);
  });

  it("POST /programs rejects bad manifest name", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest: { name: "BAD NAME!", systemPrompt: "x" }, archive: "dGVzdA==" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("invalid name");
  });

  it("POST /programs rejects non-gzip archive", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/programs", payload: { manifest: { name: "test1", systemPrompt: "x" }, archive: "not-gzip" } });
    expect(res.statusCode).toBe(400);
  });
});
