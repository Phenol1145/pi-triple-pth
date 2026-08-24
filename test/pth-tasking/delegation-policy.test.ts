import { beforeAll, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";
import {
  allowedDelegationTargets,
  descendantsOf,
  hasDelegationAuthority,
  isGovernanceFaceRole,
} from "../../src/pth/tasking/delegation-policy.js";
import { allKnownRoles } from "@away_from/pth-kernel-execution";

beforeAll(() => {
  installDefaultRoles();
});

describe("W8 P1 delegation-policy：组织权矩阵（谱系派生）", () => {
  it("有子类型的内部角色：仅直接子类型", () => {
    // v1.3 P2：专业叶子入谱系——developer→assembly-engineer，solver→三个科学角色，writer→technical-educator
    expect(allowedDelegationTargets("developer")).toEqual(["assembly-engineer", "coder", "tester"]);
    expect(allowedDelegationTargets("tester")).toEqual(["debug-case-writer"]);
    expect(allowedDelegationTargets("analyst")).toEqual(["prospector", "solver"]);
    expect(allowedDelegationTargets("prospector")).toEqual(["predictor"]);
    expect(allowedDelegationTargets("executor")).toEqual(["developer", "writer"]);
    expect(allowedDelegationTargets("writer")).toEqual(["technical-educator"]);
    expect(allowedDelegationTargets("solver")).toEqual([
      "computational-chemist",
      "lean4-prover",
      "symbolic-mathematician",
    ]);
    expect(allowedDelegationTargets("explorer")).toEqual(["scout", "spider"]);
    expect(allowedDelegationTargets("researcher")).toEqual(["analyst", "memory-keeper"]);
    expect(allowedDelegationTargets("actuator")).toEqual(["executor", "explorer", "governor", "researcher"]);
  });

  it("planner/governor：直接子类型 + 执行族补充权", () => {
    const executionFamily = descendantsOf(allKnownRoles(), "executor").sort();
    expect(executionFamily).toEqual([
      "assembly-engineer", "coder", "debug-case-writer", "developer", "executor",
      "technical-educator", "tester", "writer",
    ]);
    expect(allowedDelegationTargets("planner")).toEqual(executionFamily);
    expect(allowedDelegationTargets("governor")).toEqual([
      ...new Set(["planner", "acceptor", ...executionFamily]),
    ].sort());
  });

  it("origin 已退役：未知角色 → 无投递权（2026-08-24 三源重构）", () => {
    expect(allowedDelegationTargets("origin")).toEqual([]);
  });

  it("叶子类型无投递权；治理面不走 delegate；未知角色空", () => {
    expect(allowedDelegationTargets("coder")).toEqual([]);
    expect(allowedDelegationTargets("debug-case-writer")).toEqual([]);
    expect(allowedDelegationTargets("predictor")).toEqual([]);
    // v1.3 P2：五个专业角色均为叶子，无投递权
    expect(allowedDelegationTargets("assembly-engineer")).toEqual([]);
    expect(allowedDelegationTargets("computational-chemist")).toEqual([]);
    expect(allowedDelegationTargets("lean4-prover")).toEqual([]);
    expect(allowedDelegationTargets("symbolic-mathematician")).toEqual([]);
    expect(allowedDelegationTargets("technical-educator")).toEqual([]);
    expect(allowedDelegationTargets("sensor")).toEqual([]);
    expect(allowedDelegationTargets("controller")).toEqual([]);
    expect(allowedDelegationTargets("sensor:memory")).toEqual([]);
    expect(allowedDelegationTargets("controller:router")).toEqual([]);
    expect(allowedDelegationTargets("no-such-role")).toEqual([]);
  });

  it("hasDelegationAuthority 与目标集一致；governance 面判定", () => {
    expect(hasDelegationAuthority("developer")).toBe(true);
    expect(hasDelegationAuthority("origin")).toBe(false);
    expect(hasDelegationAuthority("coder")).toBe(false);
    expect(isGovernanceFaceRole("sensor")).toBe(true);
    expect(isGovernanceFaceRole("controller:adversarial")).toBe(true);
    expect(isGovernanceFaceRole("developer")).toBe(false);
  });
});
