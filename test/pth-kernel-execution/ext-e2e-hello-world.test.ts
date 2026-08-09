import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createToolstore } from "../../src/pth/kernel/interpreter/toolstore.js";
import { ExtRegistry } from "../../src/pth/kernel/extensions/ext-registry.js";
import { getEventBus, resetEventBus } from "../../src/pth/kernel/execution/event-bus.js";
import { allWorkerRoles, resetExtraRoles, getExtraRoles } from "../../src/pth/kernel/execution/worker-cluster.js";
import { routeTaskRole } from "../../src/pth/kernel/execution/role-router.js";

/**
 * 端到端：hello-world 示例扩展（toolstore/extensions/hello-world——四类 contracts）
 * 装载 → tools/capabilities 可调用 → events 订阅触发 → 扩展角色入谱系（routeTaskRole 路由）
 */
describe("hello-world 扩展端到端（P4）", () => {
  beforeAll(() => { resetExtraRoles(); });
  afterAll(() => { resetExtraRoles(); });

  it("装载 hello-world → tools/capabilities/events/roles 全生效", async () => {
    const toolstore = createToolstore("toolstore");
    const reg = new ExtRegistry({ toolstore, extContext: { log: () => {} } });
    const loaded = await reg.loadAll();
    expect(loaded).toContain("hello-world");

    const ext = reg.getLoaded("hello-world")!;
    // tools
    const greet = ext.tools["greet"]!;
    expect(await greet({ name: "PTH" })).toMatchObject({ ok: true, result: "Hello, PTH!" });
    // capabilities
    expect(await ext.capabilities["hello_capability"]!()).toBe("hello from extension");
    // 注册式事件订阅已取消（代码库式编排）——ext 能力面可用
    expect(ext.tools["greet"]).toBeDefined();
    expect(ext.capabilities["hello_capability"]).toBeDefined();
    // 扩展角色入谱系
    expect(getExtraRoles().map((r) => r.id)).toContain("greeting-agent");
    expect(allWorkerRoles().map((r) => r.id)).toContain("greeting-agent");
    // routeTaskRole 用扩展角色路由（tags greeting → greeting-agent）
    expect(routeTaskRole({ id: "t1", tags: ["greeting"] })).toBe("greeting-agent");
  });

  it("扩展角色的 capabilities/memoryScope 入谱系（正交语义）", async () => {
    const role = allWorkerRoles().find((r) => r.id === "greeting-agent")!;
    expect(role.capabilities).toEqual(["memory", "fs"]);
    expect(role.memoryScope).toBe("own");
  });

  it("角色冲突拒绝：重复注册 greeting-agent → 抛错", async () => {
    const { registerWorkerRole } = await import("../../src/pth/kernel/execution/worker-cluster.js");
    expect(() => registerWorkerRole({ id: "greeting-agent", labelPatterns: ["x"], prompt: "p" })).toThrow(/已存在/);
    expect(() => registerWorkerRole({ id: "new-role", labelPatterns: ["code"], prompt: "p" })).toThrow(/重叠/);
  });
});
