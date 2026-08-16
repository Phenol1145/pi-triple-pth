import { beforeAll, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";
import {
  allowedDelegationTargets,
  descendantsOf,
  hasDelegationAuthority,
  isGovernanceFaceRole,
} from "../../src/pth/tasking/delegation-policy.js";
import { allKnownRoles } from "../../src/pth/kernel/execution/worker-cluster.js";

beforeAll(() => {
  installDefaultRoles();
});

describe("W8 P1 delegation-policy：组织权矩阵（谱系派生）", () => {
  it("有子类型的内部角色：仅直接子类型", () => {
    expect(allowedDelegationTargets("developer")).toEqual(["coder", "tester"]);
    expect(allowedDelegationTargets("tester")).toEqual(["debug-case-writer"]);
    expect(allowedDelegationTargets("analyst")).toEqual(["prospector", "solver"]);
    expect(allowedDelegationTargets("prospector")).toEqual(["predictor"]);
    expect(allowedDelegationTargets("executor")).toEqual(["developer", "writer"]);
    expect(allowedDelegationTargets("explorer")).toEqual(["scout", "spider"]);
    expect(allowedDelegationTargets("researcher")).toEqual(["analyst", "memory-keeper"]);
    expect(allowedDelegationTargets("actuator")).toEqual(["executor", "explorer", "governor", "researcher"]);
  });

  it("planner/governor：直接子类型 + 执行族补充权", () => {
    const executionFamily = descendantsOf(allKnownRoles(), "executor").sort();
    expect(executionFamily).toEqual([
      "coder", "debug-case-writer", "developer", "executor", "tester", "writer",
    ]);
    expect(allowedDelegationTargets("planner")).toEqual(executionFamily);
    expect(allowedDelegationTargets("governor")).toEqual([
      ...new Set(["planner", "acceptor", ...executionFamily]),
    ].sort());
  });

  it("origin：全树任意类型（自身除外）", () => {
    const all = allKnownRoles().map((r) => r.id);
    const targets = allowedDelegationTargets("origin");
    expect(targets).toHaveLength(all.length - 1);
    expect(targets).not.toContain("origin");
    expect(targets).toEqual(all.filter((id) => id !== "origin").sort());
  });

  it("叶子类型无投递权；治理面不走 delegate；未知角色空", () => {
    expect(allowedDelegationTargets("coder")).toEqual([]);
    expect(allowedDelegationTargets("debug-case-writer")).toEqual([]);
    expect(allowedDelegationTargets("solver")).toEqual([]);
    expect(allowedDelegationTargets("predictor")).toEqual([]);
    expect(allowedDelegationTargets("sensor")).toEqual([]);
    expect(allowedDelegationTargets("controller")).toEqual([]);
    expect(allowedDelegationTargets("sensor:memory")).toEqual([]);
    expect(allowedDelegationTargets("controller:router")).toEqual([]);
    expect(allowedDelegationTargets("no-such-role")).toEqual([]);
  });

  it("hasDelegationAuthority 与目标集一致；governance 面判定", () => {
    expect(hasDelegationAuthority("developer")).toBe(true);
    expect(hasDelegationAuthority("origin")).toBe(true);
    expect(hasDelegationAuthority("coder")).toBe(false);
    expect(isGovernanceFaceRole("sensor")).toBe(true);
    expect(isGovernanceFaceRole("controller:adversarial")).toBe(true);
    expect(isGovernanceFaceRole("developer")).toBe(false);
  });
});
