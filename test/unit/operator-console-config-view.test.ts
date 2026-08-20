/**
 * test/unit/operator-console-config-view.test.ts — N33 Task 8 视图模型测试。
 */
import { describe, expect, it } from "vitest";
import { createConfigViewModel, redactConfigEntry } from "../../packages/framework/web/operator-console/config.js";

describe("operator console config view", () => {
  it("secret 条目任何值都恒定打码为 ***", () => {
    for (const entry of [
      { key: "DATABASE_URL", secret: true, defaultValue: "postgres://secret", effectiveValue: "postgres://secret", sourceDetail: "env" },
      { key: "SHORT", secret: true, defaultValue: "x", effectiveValue: "y", sourceDetail: "env" },
      { key: "LONG", secret: true, defaultValue: "a".repeat(500), effectiveValue: "b".repeat(500), sourceDetail: "env" },
      { key: "MALFORMED", secret: true, defaultValue: { nested: 1 }, effectiveValue: ["bad"], sourceDetail: null },
    ]) {
      const redacted = redactConfigEntry(entry);
      expect(redacted.defaultValue).toBe("***");
      expect(redacted.effectiveValue).toBe("***");
      expect(redacted.sourceDetail).toBe("***");
    }
    const unset = redactConfigEntry({ key: "UNSET", secret: true });
    expect(unset.defaultValue).toBe("***");
    expect(unset.effectiveValue).toBe("***");
    expect(unset.sourceDetail).toBe("***");
  });

  it("非 secret 保留值；source unknown 显式保留", () => {
    const entry = redactConfigEntry({ key: "PORT", source: undefined, defaultValue: 9090, effectiveValue: 9091 });
    expect(entry.source).toBe("unknown");
    expect(entry.defaultValue).toBe(9090);
    expect(entry.effectiveValue).toBe(9091);
  });

  it("role 行有 roleRevision 且无 worker lifecycle/heartbeat 字段", () => {
    const vm = createConfigViewModel();
    vm.ingestRoles([
      {
        id: "lean4-prover",
        parent: "solver",
        roleRevision: "rev-7",
        lifecycle: "running",
        heartbeatAt: "now",
        workerId: "worker-9",
        defaultReplicas: 0,
      },
    ]);
    const role = vm.view().roles[0]!;
    expect(role.revision).toBe("rev-7");
    expect("lifecycle" in role).toBe(false);
    expect("heartbeatAt" in role).toBe(false);
    expect("workerId" in role).toBe(false);
    expect(role.defaultReplicas).toBe(0); // 专业零副本角色保持可见
  });

  it("搜索过滤 config；角色过滤器不改谱系", () => {
    const vm = createConfigViewModel();
    vm.ingestPtl([{ key: "model", group: "ptl", source: "env" }, { key: "host", group: "ptl", source: "default" }]);
    vm.ingestRoles([{ id: "lean4-prover", family: "executor", tags: ["formal"], roleRevision: "r1" }]);
    vm.setSearch("model");
    expect(vm.view().ptlConfig.map((c) => c.key)).toEqual(["model"]);
    vm.setSearch("");
    vm.setRoleFilter("lean4");
    expect(vm.view().roles).toHaveLength(1);
    expect(vm.view().roles[0].family).toBe("executor");
  });

  it("tab 切换：ptl/pth/roles 白名单", () => {
    const vm = createConfigViewModel();
    vm.setTab("pth");
    expect(vm.view().tab).toBe("pth");
    vm.setTab("roles");
    expect(vm.view().tab).toBe("roles");
    expect(() => vm.setTab("workers")).toThrow(/unknown config tab/);
  });
});
