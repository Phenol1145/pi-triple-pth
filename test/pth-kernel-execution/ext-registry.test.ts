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

  it("角色重叠校验拒绝（正交冲突）", async () => {
    await mkdir(join(dir, "extensions", "conflict"), { recursive: true });
    await writeFile(join(dir, "extensions", "conflict", "plugin.json"), JSON.stringify({
      id: "conflict", name: "C",
      contracts: { roles: [{ id: "x1", labelPatterns: ["data"], prompt: "p" }, { id: "x2", labelPatterns: ["data"], prompt: "p" }] },
    }));
    await writeFile(join(dir, "extensions", "conflict", "index.ts"), `
      module.exports = function() {
        return { roles: [
          { id: "x1", labelPatterns: ["data"], prompt: "p" },
          { id: "x2", labelPatterns: ["data"], prompt: "p" },
        ] };
      };
    `);
    const reg = new ExtRegistry({ toolstore, extContext: {} });
    await expect(reg.loadOne("conflict")).rejects.toThrow(/重叠/);
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
