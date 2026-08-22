import { describe, it, expect, beforeEach } from "vitest";
import { routeTaskRole, checkTaskRouting } from "@away_from/pth-kernel-execution";
import { installDefaultRoles } from "../helpers";

beforeEach(() => installDefaultRoles());

describe("role router v2（角色标签制——分选器唯一标准）", () => {
  it("flow 显式 role 优先（payload.flow.stages[0].task.role）", () => {
    const role = routeTaskRole({
      id: "t-1",
      tags: ["analysis"],
      payload: { flow: { stages: [{ task: { role: "developer" } }, { task: { role: "acceptor" } }] } },
    });
    expect(role).toBe("developer");
  });

  it("tags 精确匹配角色标签", () => {
    expect(routeTaskRole({ id: "t-1", tags: ["analysis"] })).toBe("analyst");
    expect(routeTaskRole({ id: "t-1", tags: ["code"] })).toBe("developer");
    expect(routeTaskRole({ id: "t-1", tags: ["test"] })).toBe("tester");
    expect(routeTaskRole({ id: "t-1", tags: ["origin"] })).toBe("origin");
  });

  it("模糊匹配废止：testing 不命中 test（无路由依据 → throw）", () => {
    expect(() => routeTaskRole({ id: "t-1", tags: ["testing"] })).toThrow(/无路由依据/);
  });

  it("大小写不敏感（注册表小写归一）", () => {
    expect(routeTaskRole({ id: "t-1", tags: ["Code"] })).toBe("developer");
  });

  it("无标签无 flow → throw（校验期应已拦截）", () => {
    expect(() => routeTaskRole({ id: "t-1" })).toThrow(/无路由依据/);
  });
});

describe("checkTaskRouting（publish 前严格校验）", () => {
  it("合法角色标签 → ok", () => {
    expect(checkTaskRouting({ tags: ["code"] })).toEqual({ ok: true });
  });

  it("未知标签 → 拒绝（含合法标签提示）", () => {
    const r = checkTaskRouting({ tags: ["python", "self-modify"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("未知标签");
      expect(r.error).toContain("python");
      expect(r.error).toContain("code"); // 合法标签提示
    }
  });

  it("历史自由标签（dev-task/ext-e2e/triggered/chain）全部拒绝", () => {
    for (const tag of ["dev-task", "ext-e2e", "triggered", "chain", "dev"]) {
      expect(checkTaskRouting({ tags: [tag] }).ok).toBe(false);
    }
  });

  it("多角色歧义 → 拒绝", () => {
    const r = checkTaskRouting({ tags: ["code", "test"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("歧义");
  });

  it("同角色多标签不歧义", () => {
    expect(checkTaskRouting({ tags: ["code", "fix"] })).toEqual({ ok: true });
  });

  it("无角色标签且无 flow → 拒绝", () => {
    const r = checkTaskRouting({ tags: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("缺少角色标签");
  });

  it("flow 显式角色免标签", () => {
    expect(checkTaskRouting({ tags: [], payload: { flow: { stages: [{ task: { role: "scout" } }] } } })).toEqual({ ok: true });
  });

  it("flow 指定未注册角色 → 拒绝", () => {
    const r = checkTaskRouting({ payload: { flow: { stages: [{ task: { role: "ghost" } }] } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("未注册");
  });
});

describe("GOVERNANCE_ROLES（控制论骨架——2026-08-12 体系自制）", () => {
  it("谱系可见：sensor/controller 16 角色在 allLineageRoles（默认不派发）", async () => {
    const { allLineageRoles, allWorkerRoles } = await import("@away_from/pth-kernel-execution");
    const { GOVERNANCE_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    expect(GOVERNANCE_ROLES.length).toBe(16);   // 10 + controller:adversarial（B4 W7）+ N14 六点位（sensor/controller × tool-face/tool-single/rule）
    const lineage = allLineageRoles().map((r) => r.id);
    for (const g of GOVERNANCE_ROLES) expect(lineage).toContain(g.id);
    // 默认派发面（allWorkerRoles）不含 governance（池容量安全——显式启用才进 batch）
    const dispatched = allWorkerRoles().map((r) => r.id);
    for (const g of GOVERNANCE_ROLES) expect(dispatched).not.toContain(g.id);
    // controller 系带 manage 控制面；sensor 系不带
    const c = GOVERNANCE_ROLES.find((r) => r.id === "controller:resource")!;
    const s = GOVERNANCE_ROLES.find((r) => r.id === "sensor:resource")!;
    expect(c.capabilities).toContain("manage");
    expect(s.capabilities).not.toContain("manage");
  });

  it("PTH_WORKER_ROLES 显式列出 governance 角色可派发（parseRoleWeights known 含）", async () => {
    const { parseRoleWeights } = await import("@away_from/pth-kernel-execution");
    const w = parseRoleWeights("sensor:worker-opt:1,controller:resource:1");
    expect(w.get("sensor:worker-opt")).toBe(1);
    expect(w.get("controller:resource")).toBe(1);
    expect(w.get("developer")).toBe(1);   // 未列角色默认 1
  });
});

describe("governance 角色路由（2026-08-12 router 接线修复）", () => {
  it("flow 显式指定 governance 角色 → 通过校验（controller:worker-opt）", async () => {
    const { checkTaskRouting } = await import("@away_from/pth-kernel-execution");
    const r = checkTaskRouting({ tags: ["analysis"], payload: { flow: { stages: [{ task: { role: "controller:worker-opt" } }] } } });
    expect(r.ok).toBe(true);
  });

  it("routeTaskRole flow 优先 → governance 角色", async () => {
    const { routeTaskRole } = await import("@away_from/pth-kernel-execution");
    const role = routeTaskRole({ id: "t1", tags: ["analysis"], payload: { flow: { stages: [{ task: { role: "controller:worker-opt" } }] } } });
    expect(role).toBe("controller:worker-opt");
  });

  it("sensor 角色同样可路由", async () => {
    const { checkTaskRouting } = await import("@away_from/pth-kernel-execution");
    const r = checkTaskRouting({ tags: ["analysis"], payload: { flow: { stages: [{ task: { role: "sensor:system-opt" } }] } } });
    expect(r.ok).toBe(true);
  });
});
