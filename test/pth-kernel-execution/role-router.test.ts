import { describe, it, expect } from "vitest";
import { routeTaskRole } from "../../src/pth/kernel/execution/role-router.js";

describe("role router（任务分配正交化）", () => {
  it("flow 显式 role 优先（payload.flow.stages[0].task.role）", () => {
    const role = routeTaskRole({
      id: "t-1",
      tags: ["analysis"],
      payload: { flow: { stages: [{ task: { role: "developer" } }, { task: { role: "acceptor" } }] } },
    });
    expect(role).toBe("developer");
  });

  it("tags 语义匹配（analyst: analysis/research）", () => {
    expect(routeTaskRole({ id: "t-1", tags: ["analysis", "data"] })).toBe("analyst");
    expect(routeTaskRole({ id: "t-1", tags: ["research"] })).toBe("analyst");
  });

  it("tags 匹配其他角色（developer: implement/code/fix）", () => {
    expect(routeTaskRole({ id: "t-1", tags: ["code"] })).toBe("developer");
    expect(routeTaskRole({ id: "t-1", tags: ["implement"] })).toBe("developer");
  });

  it("多标签匹配取首个角色（按角色顺序）", () => {
    // planner: plan/design 在 analyst 之后——analysis+plan 都匹配时取 analyst（DEFAULT_ROLES 顺序）
    expect(routeTaskRole({ id: "t-1", tags: ["plan", "analysis"] })).toBe("analyst");
  });

  it("无匹配 → hash 分片确定性（同 id 恒同角色）", () => {
    const r1 = routeTaskRole({ id: "abc-123" });
    const r2 = routeTaskRole({ id: "abc-123" });
    expect(r1).toBe(r2);
    expect(r1.length).toBeGreaterThan(0);
  });

  it("hash 分片分布均匀（100 个 id 覆盖多角色）", () => {
    const roles = new Set<string>();
    for (let i = 0; i < 100; i++) {
      roles.add(routeTaskRole({ id: `task-${i}-uuid-${i * 37}` }));
    }
    expect(roles.size).toBeGreaterThan(3);  // 至少覆盖 4 个角色
  });

  it("无 tags 无 payload 也路由（兜底分片）", () => {
    expect(routeTaskRole({ id: "x" })).toBeTruthy();
  });
});
