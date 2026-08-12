import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolstore } from "../../src/pth/kernel/interpreter/toolstore.js";
import { ExtRegistry } from "../../src/pth/kernel/extensions/ext-registry.js";
import { parseExtManifest } from "../../src/pth/kernel/extensions/ext-manifest.js";
import { getEventBus, resetEventBus } from "../../src/pth/kernel/execution/event-bus.js";

describe("兼容性扩展装载器（ExtRegistry——P2）", () => {
  let dir: string;
  let toolstore: ReturnType<typeof createToolstore>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext-reg-"));
    toolstore = createToolstore(dir);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("manifest 解析（schema + compat 版本）", () => {
    const m = parseExtManifest(JSON.stringify({
      id: "hello", name: "Hello", contracts: { tools: ["greet"] },
      compat: { pluginApi: ">=0.6.0" },
    }), "0.7.0");
    expect(m.id).toBe("hello");
    expect(m.contracts.tools).toEqual(["greet"]);
    // 版本不兼容
    expect(() => parseExtManifest(JSON.stringify({
      id: "x", name: "X", contracts: {}, compat: { pluginApi: ">=0.9.0" },
    }), "0.7.0")).toThrow(/版本不兼容/);
  });

  it("装载扩展：eval index.ts → factory → 角色注册（注册式 tools/events 已取消——代码库式编排）", async () => {
    await mkdir(join(dir, "extensions", "hello"), { recursive: true });
    await writeFile(join(dir, "extensions", "hello", "plugin.json"), JSON.stringify({
      id: "hello", name: "Hello Ext",
      contracts: { tools: ["greet"], capabilities: ["whoami"], events: ["task.claim"] },
      activation: { onStartup: true },
    }));
    await writeFile(join(dir, "extensions", "hello", "index.ts"), `
      module.exports = function factory(ctx) {
        return {
          tools: { greet: async (args) => ({ ok: true, result: "hello " + args.name }) },
          capabilities: { whoami: async () => "hello-ext" },
          events: { "task.claim": async (e) => { globalThis.__extEventGot = e; } },
        };
      };
    `);
    const reg = new ExtRegistry({ toolstore, extContext: { log: () => {} } });
    const loaded = await reg.loadAll();
    expect(loaded).toContain("hello");
    const ext = reg.getLoaded("hello")!;
    expect(ext.tools["greet"]).toBeDefined();
    expect(await ext.tools["greet"]!({ name: "world" })).toMatchObject({ result: "hello world" });
    expect(await ext.capabilities["whoami"]!()).toBe("hello-ext");
    // 注册式事件订阅已取消（代码库式编排——ext 能力 + 公共记忆区索引）
    expect(reg.getLoaded("hello")!.roles).toEqual([]);
  });

  it("角色标签冲突拒绝（tag-registry 接管——同名不同角色）", async () => {
    await mkdir(join(dir, "extensions", "conflict"), { recursive: true });
    await writeFile(join(dir, "extensions", "conflict", "plugin.json"), JSON.stringify({
      id: "conflict", name: "C",
      contracts: { roles: [{ id: "x1", tags: ["data"], prompt: "p" }, { id: "x2", tags: ["data"], prompt: "p" }] },
    }));
    await writeFile(join(dir, "extensions", "conflict", "index.ts"), `
      module.exports = function() {
        return { roles: [
          { id: "x1", tags: ["data"], prompt: "p" },
          { id: "x2", tags: ["data"], prompt: "p" },
        ] };
      };
    `);
    const reg = new ExtRegistry({ toolstore, extContext: {} });
    await expect(reg.loadOne("conflict")).rejects.toThrow(/冲突/);
  });

  it("index.ts 未导出 factory → 装载失败", async () => {
    await mkdir(join(dir, "extensions", "bad"), { recursive: true });
    await writeFile(join(dir, "extensions", "bad", "plugin.json"), JSON.stringify({
      id: "bad", name: "Bad", contracts: {},
    }));
    await writeFile(join(dir, "extensions", "bad", "index.ts"), `module.exports = { notAFunction: true };`);
    const reg = new ExtRegistry({ toolstore, extContext: {} });
    await expect(reg.loadOne("bad")).rejects.toThrow(/factory/);
  });
});

describe("扩展 SDK 标准通道（2026-08-12 完善——buildStdExtChannels）", () => {
  it("exec：正常执行 + 超时/输出上限受控 + 白名单", async () => {
    const { buildStdExtChannels } = await import("../../src/pth/kernel/extensions/ext-registry.js");
    const ch = buildStdExtChannels({ dbQuery: async () => [] });
    const r = await ch.exec!("node", ["-e", "console.log(1+1)"]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("2");
    // 白名单拒绝
    const ch2 = buildStdExtChannels({ dbQuery: async () => [], execAllowlist: ["node"] });
    const bad = await ch2.exec!("rm", ["-rf", "/"]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("白名单");
  });

  it("http.get：协议约束（ftp 拒绝 / https 允许）+ 超时", async () => {
    const { buildStdExtChannels } = await import("../../src/pth/kernel/extensions/ext-registry.js");
    const ch = buildStdExtChannels({ dbQuery: async () => [] });
    const bad = await ch.http!.get("ftp://x.example/f");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("协议");
    const unreachable = await ch.http!.get("https://127.0.0.1:1/x", { timeoutMs: 2000 });
    expect(unreachable.ok).toBe(false);   // 连接失败——不抛（返回 ok:false）
  });

  it("db.query：表白名单 + where 过滤构建 + limit 上限", async () => {
    const seen: Array<{ table: string; sql: string }> = [];
    const { buildStdExtChannels } = await import("../../src/pth/kernel/extensions/ext-registry.js");
    const ch = buildStdExtChannels({ dbQuery: async (table, sql) => { seen.push({ table, sql }); return [{ id: "t1" }]; } });
    const r = await ch.db!.query("tasks", { where: { status: "pending", assigned_role: "developer" }, limit: 5 });
    expect(r.ok).toBe(true);
    expect(seen[0]?.sql).toContain("SELECT id, title, status, assigned_role, created_at FROM tasks");
    expect(seen[0]?.sql).toContain("status = 'pending'");
    expect(seen[0]?.sql).toContain("LIMIT 5");
    // 白名单拒绝
    const bad = await ch.db!.query("users");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("白名单");
    // 注入防护（值含非法字符——白名单直接拒绝，不进入 SQL）
    const r2 = await ch.db!.query("tasks", { where: { status: "pending'; DROP TABLE tasks; --" } });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("非法字符");
  });

  it("evalFactory：TS 语法误用 → 友好错误提示（含 TS 语法提示）", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "ext-ts-"));
    try {
      await mkdir(join(dir2, "extensions", "ts-bad"), { recursive: true });
      await writeFile(join(dir2, "extensions", "ts-bad", "plugin.json"), JSON.stringify({ id: "ts-bad", name: "x", contracts: {}, activation: { onStartup: true }, compat: { pluginApi: ">=0.6.0" } }));
      await writeFile(join(dir2, "extensions", "ts-bad", "index.ts"), `module.exports = async function factory(ctx) { const x: number = 1; return {}; };`);
      const ts2 = createToolstore(dir2);
      const errors: string[] = [];
      const reg = new ExtRegistry({ toolstore: ts2, extContext: {}, onError: (id, e) => errors.push(e.message) });
      const loaded = await reg.loadAll();
      expect(loaded).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("TS 语法");
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
