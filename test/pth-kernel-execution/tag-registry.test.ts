import { describe, it, expect, beforeEach } from "vitest";
import { TagRegistry } from "../../src/pth/kernel/execution/tag-registry.js";

describe("tag-registry（标签总表——注册通道）", () => {
  let reg: TagRegistry;
  beforeEach(() => { reg = new TagRegistry(); });

  it("注册 role 标签（name 小写归一）", () => {
    reg.register({ name: "Code", kind: "role", role: "developer" });
    expect(reg.get("code")?.role).toBe("developer");
    expect(reg.get("CODE")?.kind).toBe("role");
  });

  it("幂等：同义重复注册跳过", () => {
    reg.register({ name: "code", kind: "role", role: "developer" });
    expect(() => reg.register({ name: "code", kind: "role", role: "developer" })).not.toThrow();
    expect(reg.list()).toHaveLength(1);
  });

  it("冲突：同名不同义（不同角色/不同 kind）抛错", () => {
    reg.register({ name: "test", kind: "role", role: "tester" });
    expect(() => reg.register({ name: "test", kind: "role", role: "acceptor" })).toThrow(/冲突/);
    expect(() => reg.register({ name: "test", kind: "priority" })).toThrow(/冲突/);
  });

  it("role 类标签必须带 role 字段", () => {
    expect(() => reg.register({ name: "x", kind: "role" })).toThrow(/role/);
  });

  it("validate：未知标签报 unknown 列表", () => {
    reg.register({ name: "code", kind: "role", role: "developer" });
    expect(reg.validate(["code"])).toEqual({ ok: true });
    const r = reg.validate(["code", "python", "self-modify"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknown).toEqual(["python", "self-modify"]);
  });

  it("routeRole：精确匹配 role 标签（不做 includes 模糊匹配）", () => {
    reg.register({ name: "test", kind: "role", role: "tester" });
    expect(reg.routeRole(["test"])).toEqual({ ok: true, role: "tester" });
    // 模糊匹配废止：testing 不命中 test
    expect(reg.routeRole(["testing"])).toEqual({ ok: true, role: null });
  });

  it("routeRole：非 role 类标签不参与路由", () => {
    reg.register({ name: "p0", kind: "priority" });
    expect(reg.routeRole(["p0"])).toEqual({ ok: true, role: null });
  });

  it("routeRole：多个不同角色 → 歧义（conflict）", () => {
    reg.register({ name: "code", kind: "role", role: "developer" });
    reg.register({ name: "test", kind: "role", role: "tester" });
    const r = reg.routeRole(["code", "test"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflict.sort()).toEqual(["developer", "tester"]);
  });

  it("routeRole：同角色多标签不歧义", () => {
    reg.register({ name: "code", kind: "role", role: "developer" });
    reg.register({ name: "fix", kind: "role", role: "developer" });
    expect(reg.routeRole(["code", "fix"])).toEqual({ ok: true, role: "developer" });
  });

  it("预留维度：complexity/priority 可注册", () => {
    reg.register({ name: "high", kind: "complexity" });
    reg.register({ name: "p0", kind: "priority" });
    expect(reg.get("high")?.kind).toBe("complexity");
    expect(reg.get("p0")?.kind).toBe("priority");
  });

  it("list 返回全部已注册标签", () => {
    reg.register({ name: "code", kind: "role", role: "developer", registeredBy: "role:developer" });
    reg.register({ name: "p0", kind: "priority", registeredBy: "api" });
    const all = reg.list();
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.name).sort()).toEqual(["code", "p0"]);
  });
});

describe("tag-registry × worker-cluster（内置角色自动挂载）", () => {
  it("origin + DEFAULT_ROLES 标签随 setDefaultRoles 注入注册（2026-08-13 审计 P2——装配期）", async () => {
    const { tagRegistry: global } = await import("../../src/pth/kernel/execution/tag-registry.js");
    const { installDefaultRoles } = await import("../helpers");
    installDefaultRoles();
    // origin 升级链标签
    expect(global.get("origin")).toMatchObject({ kind: "role", role: "origin" });
    // 7 默认角色代表抽查
    expect(global.get("code")?.role).toBe("developer");
    expect(global.get("test")?.role).toBe("tester");
    expect(global.get("analysis")?.role).toBe("analyst");
    expect(global.get("plan")?.role).toBe("planner");
    expect(global.get("recon")?.role).toBe("scout");
    expect(global.get("memory")?.role).toBe("memory-keeper");
    expect(global.get("accept")?.role).toBe("acceptor");
  });

  it("registerWorkerRole 自动挂载扩展角色标签", async () => {
    const { registerWorkerRole } = await import("../../src/pth/kernel/execution/worker-cluster.js");
    const { tagRegistry: global } = await import("../../src/pth/kernel/execution/tag-registry.js");
    registerWorkerRole({ id: "auto-tag-role", labelPatterns: [], tags: ["auto-tag-x"], prompt: "测试" });
    expect(global.get("auto-tag-x")).toMatchObject({ kind: "role", role: "auto-tag-role", registeredBy: "role:auto-tag-role" });
  });
});
