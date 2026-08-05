import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import Fastify from "fastify";
import { ComponentStore, COMPONENT_TYPES, type ComponentManifest } from "../../src/pth/components/store.js";
import { ProgramStore } from "../../src/pth/programs/store.js";
import { FallbackRequestStore } from "../../src/pth/fallback/requests.js";
import { registerProgramRoutes } from "../../src/pth/gateway/routes-programs.js";
import { registerFallbackRoutes } from "../../src/pth/gateway/routes-fallback.js";

// ── ustar writer (minimal, for test-only archive creation) ────────

function padOctal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function checksum(header: Buffer): number {
  let sum = 256; // 8*32 for the initial chksum field spaces
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) continue; // chksum field → spaces
    sum += header[i]!;
  }
  return sum;
}

function tarHeader(name: string, size: number, typeflag = "0"): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf-8");
  buf.write(padOctal(0o644, 8), 100, 8, "utf-8");
  buf.write(padOctal(0, 8), 108, 8, "utf-8");
  buf.write(padOctal(0, 8), 116, 8, "utf-8");
  buf.write(padOctal(size, 12), 124, 12, "utf-8");
  buf.write(padOctal(0, 12), 136, 12, "utf-8");
  buf.write("        ", 148, 8, "utf-8"); // chksum placeholder
  buf.write(typeflag, 156, 1, "utf-8");
  buf.write("ustar\0", 257, 6, "utf-8");
  buf.write("00", 263, 2, "utf-8");
  const sum = checksum(buf);
  buf.write(padOctal(sum, 7), 148, 8, "utf-8");
  return buf;
}

function makeTar(files: { name: string; content: Buffer | string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const content = typeof f.content === "string" ? Buffer.from(f.content, "utf-8") : f.content;
    chunks.push(tarHeader(f.name, content.length));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  // End-of-archive: two zero blocks
  chunks.push(Buffer.alloc(512));
  chunks.push(Buffer.alloc(512));
  return Buffer.concat(chunks);
}

// ── mock Redis ────────────────────────────────────────────────────

class MockRedis {
  store = new Map<string, string>();
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
  // fallback_requests hash 支持（fallback store 用 hset/hget/hgetall/hdel）
  hset(key: string, field: string, value: string): Promise<number> {
    const hash = JSON.parse(this.store.get(key) ?? "{}") as Record<string, string>;
    hash[field] = value;
    this.store.set(key, JSON.stringify(hash));
    return Promise.resolve(1);
  }
  hget(key: string, field: string): Promise<string | null> {
    const hash = JSON.parse(this.store.get(key) ?? "{}") as Record<string, string>;
    return Promise.resolve(hash[field] ?? null);
  }
  hgetall(key: string): Promise<Record<string, string>> {
    const hash = JSON.parse(this.store.get(key) ?? "{}") as Record<string, string>;
    return Promise.resolve(hash);
  }
  hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = JSON.parse(this.store.get(key) ?? "{}") as Record<string, string>;
    let n = 0;
    for (const f of fields) if (delete hash[f]) n++;
    this.store.set(key, JSON.stringify(hash));
    return Promise.resolve(n);
  }
  del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return Promise.resolve(count);
  }
  sadd(key: string, ...members: string[]): Promise<number> {
    const arr: string[] = JSON.parse(this.store.get(key) ?? "[]");
    let added = 0;
    for (const m of members) {
      if (!arr.includes(m)) { arr.push(m); added++; }
    }
    this.store.set(key, JSON.stringify(arr));
    return Promise.resolve(added);
  }
  smembers(key: string): Promise<string[]> {
    return Promise.resolve(JSON.parse(this.store.get(key) ?? "[]"));
  }
  srem(key: string, ...members: string[]): Promise<number> {
    const arr: string[] = JSON.parse(this.store.get(key) ?? "[]");
    const before = arr.length;
    const kept = arr.filter((m: string) => !members.includes(m));
    this.store.set(key, JSON.stringify(kept));
    return Promise.resolve(before - kept.length);
  }
}

// ── helpers ───────────────────────────────────────────────────────

function agentManifest(overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return { type: "agent-program", name: "echo", systemPrompt: "PROMPT.md", ...overrides };
}

function schedulerManifest(name = "daily"): ComponentManifest {
  return { type: "scheduler", name, payload: { schedule: "0 9 * * *" } };
}

function agentArchive(files: { name: string; content: string }[], manifest?: ComponentManifest): Buffer {
  const mf = manifest ?? agentManifest();
  return makeTar([{ name: "agent.json", content: JSON.stringify(mf) }, ...files]);
}

function schedulerArchive(files: { name: string; content: string }[] = [], name = "daily"): Buffer {
  return makeTar([{ name: "definition.json", content: JSON.stringify({ name }) }, ...files]);
}

describe("ComponentStore", () => {
  let tmpDir: string;
  let redis: MockRedis;
  let store: ComponentStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-comp-"));
    redis = new MockRedis();
    store = new ComponentStore(redis as any, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 上传 / 版本分配 ────────────────────────────────────────

  it("save 按类型分配递增版本（scheduler v1 → v2）", async () => {
    const r1 = await store.save("t", schedulerManifest("daily"), schedulerArchive([{ name: "def.json", content: "{}" }], "daily"));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.type).toBe("scheduler");
    expect(r1.value.name).toBe("daily");
    expect(r1.value.version).toBe(1);
    expect(r1.value.root).toContain(path.join("components", "t", "scheduler", "daily", "1"));

    const r2 = await store.save("t", schedulerManifest("daily"), schedulerArchive([{ name: "def.json", content: "{}" }], "daily"));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.version).toBe(2);
  });

  it("同名不同类型互不干扰（独立命名空间）", async () => {
    const ra = await store.save("t", agentManifest({ name: "shared" }), agentArchive([{ name: "PROMPT.md", content: "hi" }], agentManifest({ name: "shared" })));
    const rs = await store.save("t", schedulerManifest("shared"), schedulerArchive([], "shared"));
    expect(ra.ok && rs.ok).toBe(true);
    if (!ra.ok || !rs.ok) return;

    const progList = await store.list("t", "agent-program");
    const schedList = await store.list("t", "scheduler");
    expect(progList.map((p) => p.name)).toEqual(["shared"]);
    expect(schedList.map((p) => p.name)).toEqual(["shared"]);
    expect(progList[0]!.latestVersion).toBe(1);
    expect(schedList[0]!.latestVersion).toBe(1);
  });

  it("agent-program 保存到 components 卷（components/<tenant>/agent-program/<name>/<v>）", async () => {
    const r = await store.save("t", agentManifest(), agentArchive([{ name: "PROMPT.md", content: "echo" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.root).toContain(path.join("components", "t", "agent-program", "echo", "1"));
    expect(fs.existsSync(path.join(r.value.root, "PROMPT.md"))).toBe(true);
    // 旧 programs 卷不写入
    expect(fs.existsSync(path.join(tmpDir, "programs", "programs", "t", "echo"))).toBe(false);
  });

  // ── 归档身份文件契约 ──────────────────────────────────────

  it("非 agent-program 类型要求 definition.json（缺失被拒）", async () => {
    const archive = makeTar([{ name: "random.txt", content: "x" }]);
    const r = await store.save("t", schedulerManifest(), archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("definition.json");
  });

  it("非 agent-program 类型 definition.json name 不一致被拒", async () => {
    const r = await store.save("t", schedulerManifest("daily"), schedulerArchive([], "other-name"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("does not match");
  });

  it("agent-program 要求 agent.json（回归）", async () => {
    const archive = makeTar([{ name: "PROMPT.md", content: "x" }]);
    const r = await store.save("t", agentManifest(), archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("agent.json");
  });

  // ── GC ────────────────────────────────────────────────────

  it("保留最近 10 个版本，旧版本被清理（scheduler）", async () => {
    for (let i = 0; i < 15; i++) {
      const r = await store.save("t", schedulerManifest(), schedulerArchive());
      expect(r.ok).toBe(true);
    }
    const latest = await store.getByType("t", "scheduler", "daily");
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.value.version).toBe(15);

    const v1 = await store.getByType("t", "scheduler", "daily", 1);
    expect(v1.ok).toBe(false);
    const v6 = await store.getByType("t", "scheduler", "daily", 6);
    expect(v6.ok).toBe(true);
  });

  // ── agent-program 读侧双查 legacy programs 路径 ─────────────

  function writeLegacyProgram(tenantId: string, name: string, version = 1): void {
    // Redis legacy keys（旧 ProgramStore 布局）
    redis.sadd(`programs:${tenantId}`, name);
    redis.set(`program:${tenantId}:${name}:latest`, String(version));
    redis.set(`program:${tenantId}:${name}:${version}`, JSON.stringify({ name, systemPrompt: "PROMPT.md" }));
    redis.set(`program:${tenantId}:${name}:${version}:bytes`, "999");
    redis.set(`program:${tenantId}:${name}:updatedAt`, String(Date.now()));
    redis.set(`program:${tenantId}:${name}:next`, String(version));
    // legacy 磁盘（旧 ProgramStore dataDir_arg=DATA_DIR/programs + 内部一层 programs）
    const root = path.join(tmpDir, "programs", "programs", tenantId, name, String(version));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "PROMPT.md"), "legacy prompt");
  }

  it("读侧双查：legacy programs 路径数据可读（get/list/delete）", async () => {
    writeLegacyProgram("t", "echo");

    // get：legacy latest + manifest 补 type
    const g = await store.getByType("t", "agent-program", "echo");
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.version).toBe(1);
    expect(g.value.type).toBe("agent-program");
    expect(g.value.manifest.type).toBe("agent-program");
    expect(g.value.root).toContain(path.join("programs", "programs", "t", "echo", "1"));

    // list：并入 legacy 名称
    const list = await store.list("t", "agent-program");
    expect(list.map((p) => p.name)).toEqual(["echo"]);
    expect(list[0]!.latestVersion).toBe(1);

    // delete：同时清理 legacy
    const del = await store.delete("t", "echo", "agent-program");
    expect(del.ok).toBe(true);
    const g2 = await store.getByType("t", "agent-program", "echo");
    expect(g2.ok).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "programs", "programs", "t", "echo"))).toBe(false);
  });

  it("新写入优先：legacy 数据存在时再上传，latest 指向 components 卷新版本", async () => {
    writeLegacyProgram("t", "echo");
    const r = await store.save("t", agentManifest(), agentArchive([{ name: "PROMPT.md", content: "new" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const g = await store.getByType("t", "agent-program", "echo");
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.version).toBe(r.value.version);
    expect(g.value.root).toContain(path.join("components", "t", "agent-program", "echo"));
  });

  it("类型优先接口 listByType/deleteByType", async () => {
    await store.save("t", schedulerManifest(), schedulerArchive());
    const list = await store.listByType("t", "scheduler");
    expect(list.length).toBe(1);

    const del = await store.deleteByType("t", "scheduler", "daily");
    expect(del.ok).toBe(true);
    const g = await store.getByType("t", "scheduler", "daily");
    expect(g.ok).toBe(false);
  });

  it("tar 穿越防御回归（非 agent 类型同样生效）", async () => {
    const bad = makeTar([
      { name: "definition.json", content: JSON.stringify({ name: "daily" }) },
      { name: "../escape.sh", content: "bad" },
    ]);
    const r = await store.save("t", schedulerManifest(), bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("path traversal");
  });
});

describe("ComponentStore routes（POST /api/v1/components）", () => {
  let app: ReturnType<typeof Fastify>;
  let tmpDir: string;
  let redis: MockRedis;
  let store: ProgramStore;
  const tenantId = "route-tenant";

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pth-comp-route-"));
    redis = new MockRedis();
    store = new ProgramStore(redis as any, tmpDir);
    const fallback = new FallbackRequestStore(redis as any);

    const mockEngine = {
      createSession: async () => ({ ok: true, data: { sessionId: "s1", tenantId, project: "default", state: "idle", model: "unknown", createdAt: "", lastAccess: "" } }),
      prompt: async function* () { /* noop */ },
      destroySession: async () => undefined,
    } as any;

    app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (req) => { (req as any).auth = { tenantId, role: "platform-admin" }; });
    registerProgramRoutes(app, mockEngine, store, fallback);
    registerFallbackRoutes(app, fallback);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function gzipB64(files: { name: string; content: string }[]): string {
    return gzipSync(makeTar(files)).toString("base64");
  }

  it("POST /api/v1/components 上传 scheduler 成功", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      payload: {
        type: "scheduler",
        manifest: { name: "daily", payload: { schedule: "0 9 * * *" } },
        archive: gzipB64([
          { name: "definition.json", content: JSON.stringify({ name: "daily" }) },
          { name: "def.json", content: "{}" },
        ]),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("scheduler");
    expect(body.name).toBe("daily");
    expect(body.version).toBe(1);
  });

  it("POST /api/v1/components 非法 type 被拒", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      payload: { type: "wat", manifest: { name: "x" }, archive: "dGVzdA==" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid type");
  });

  it("POST /api/v1/components manifest 显式 type 与请求冲突被拒", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      payload: {
        type: "scheduler",
        manifest: { type: "optimizer", name: "daily" },
        archive: gzipB64([{ name: "definition.json", content: JSON.stringify({ name: "daily" }) }]),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("does not match");
  });

  it("POST /api/v1/programs 仍为 agent-program 兼容别名", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      payload: {
        manifest: { name: "hello", systemPrompt: "PROMPT.md" },
        archive: gzipB64([
          { name: "agent.json", content: JSON.stringify({ name: "hello", systemPrompt: "PROMPT.md" }) },
          { name: "PROMPT.md", content: "hi" },
        ]),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("hello");
    expect(body.type).toBe("agent-program");
    expect(body.version).toBe(1);
  });

  it("COMPONENT_TYPES 常量齐全", () => {
    expect(COMPONENT_TYPES).toEqual(["agent-program", "scheduler", "optimizer", "memory-pack", "skeleton-update"]);
  });

  // ── 评审 WP4-R1 修复测试（B-1 透传 / I-1 slotHint 绑定 / I-2 closeWarning）──

  it("agent-program 经 /programs 别名透传 targetSlot+legalAuth（B-1 回归）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      payload: {
        manifest: { name: "slotprog", systemPrompt: "PROMPT.md", targetSlot: "slot-a", legalAuth: "legal-ref-1" },
        archive: gzipB64([
          { name: "agent.json", content: JSON.stringify({ name: "slotprog", systemPrompt: "PROMPT.md" }) },
          { name: "PROMPT.md", content: "hi" },
        ]),
      },
    });
    expect(res.statusCode).toBe(201);
    // 绑定已建立（B-1：此前 targetSlot 被 validateManifest 剥落——永不抵达 store.save）
    const binding = await store.slotBindings.get("slot-a");
    expect(binding.ok).toBe(true);
    expect(binding.value?.name).toBe("slotprog");
    expect(binding.value?.legalAuth).toBe("legal-ref-1");
  });

  it("agent-program 经 /components 上传 targetSlot+legalAuth 透传（B-1 回归）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      payload: {
        type: "agent-program",
        manifest: { name: "slotprog2", systemPrompt: "PROMPT.md", targetSlot: "slot-b", legalAuth: "legal-ref-2" },
        archive: gzipB64([
          { name: "agent.json", content: JSON.stringify({ name: "slotprog2", systemPrompt: "PROMPT.md" }) },
          { name: "PROMPT.md", content: "hi" },
        ]),
      },
    });
    expect(res.statusCode).toBe(201);
    const binding = await store.slotBindings.get("slot-b");
    expect(binding.ok).toBe(true);
    expect(binding.value?.name).toBe("slotprog2");
    expect(binding.value?.legalAuth).toBe("legal-ref-2");
  });

  it("respond 上传：请求 slotHint 补位建立绑定（I-1）", async () => {
    // 建单（带 slotHint）
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/fallback-requests",
      payload: { description: "缺一个 agent", slotHint: "slot-c", urgency: "high" },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as { requestId: string };
    // respond 上传（manifest 不带 targetSlot——应自动用请求 slotHint 补位）
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      payload: {
        type: "agent-program",
        manifest: { name: "respondprog", systemPrompt: "PROMPT.md" },
        archive: gzipB64([
          { name: "agent.json", content: JSON.stringify({ name: "respondprog", systemPrompt: "PROMPT.md" }) },
          { name: "PROMPT.md", content: "hi" },
        ]),
        requestId: created.requestId,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.closedRequest).toBe(created.requestId);
    // slotHint 已补位绑定（I-1：此前"respond 填槽"的 slot 实际从未被绑定）
    const binding = await store.slotBindings.get("slot-c");
    expect(binding.ok).toBe(true);
    expect(binding.value?.name).toBe("respondprog");
  });

  it("respond 上传：闭合失败返回 closeWarning 而非无提示（I-2 回归）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/components",
      payload: {
        type: "agent-program",
        manifest: { name: "ghostprog", systemPrompt: "PROMPT.md" },
        archive: gzipB64([
          { name: "agent.json", content: JSON.stringify({ name: "ghostprog", systemPrompt: "PROMPT.md" }) },
          { name: "PROMPT.md", content: "hi" },
        ]),
        requestId: "ghost-request-404", // 不存在的请求 → close 失败
      },
    });
    expect(res.statusCode).toBe(201); // 构件仍保存成功
    const body = JSON.parse(res.body);
    expect(body.closeWarning).toBeDefined();
    expect(body.closedRequest).toBe("ghost-request-404");
  });
});
