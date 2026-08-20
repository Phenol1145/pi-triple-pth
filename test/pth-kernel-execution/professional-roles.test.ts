import { beforeEach, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";
import {
  PROFESSIONAL_ROLE_BUDGETS,
  PROFESSIONAL_ROLE_REGIONS,
  PROFESSIONAL_ROLE_RESPONSIBILITIES,
  PROFESSIONAL_ROLE_WORKERS,
  PROFESSIONAL_ROLES,
  assertProfessionalRoleBudgetsWithinN28,
  professionalRuntimeIdsForRole,
} from "../../src/pth/kernel/execution/professional-roles.js";
import {
  allKnownRoles,
  allWorkerRoles,
  expandRoleWeights,
  parseRoleWeights,
} from "../../src/pth/kernel/execution/worker-cluster.js";
import {
  N28_FEASIBILITY_BUDGET,
  checkResponsibilityCapacity,
} from "../../src/pth/contracts/index.js";
import { createTaskWorkingSetPolicy } from "../../src/pth/runner/cognitive-working-set.js";

beforeEach(() => installDefaultRoles());

const PROFESSIONAL_IDS = [
  "assembly-engineer",
  "computational-chemist",
  "lean4-prover",
  "symbolic-mathematician",
  "technical-educator",
] as const;

describe("v1.3 Task 3：五个显式专业角色（explicit-only）", () => {
  it("五角色 ID 按设计冻结（排序断言）", () => {
    expect(PROFESSIONAL_ROLES.map((r) => r.id).sort()).toEqual([...PROFESSIONAL_IDS].sort());
  });

  it("parent/generation 按设计 §4 冻结", () => {
    const byId = new Map(PROFESSIONAL_ROLES.map((r) => [r.id, r]));
    expect(byId.get("assembly-engineer")).toMatchObject({ parent: "developer", generation: 4 });
    expect(byId.get("computational-chemist")).toMatchObject({ parent: "solver", generation: 5 });
    expect(byId.get("lean4-prover")).toMatchObject({ parent: "solver", generation: 5 });
    expect(byId.get("symbolic-mathematician")).toMatchObject({ parent: "solver", generation: 5 });
    expect(byId.get("technical-educator")).toMatchObject({ parent: "writer", generation: 4 });
  });

  it("每个角色声明 loadPolicyRef 且预算 fixture 覆盖全部 ref", () => {
    for (const role of PROFESSIONAL_ROLES) {
      expect(role.loadPolicyRef).toBeTruthy();
      expect(PROFESSIONAL_ROLE_BUDGETS.has(role.loadPolicyRef!)).toBe(true);
    }
  });

  it("窄 capability：无通用 ext / 无限 bash / 全量 adapter；educator 只读 artifact", () => {
    for (const role of PROFESSIONAL_ROLES) {
      expect(role.capabilities).toBeDefined();
      expect(role.capabilities).not.toContain("ext");
      expect(role.capabilities).not.toContain("bash");
    }
    const educator = PROFESSIONAL_ROLES.find((r) => r.id === "technical-educator")!;
    expect(educator.capabilities).toEqual(["memory", "readSource", "readText", "fs"]);
    expect(professionalRuntimeIdsForRole("technical-educator")).toEqual(["jupyter"]);
  });

  it("role→runtime 与 professional-runtime.ts allowlist 对齐", () => {
    expect(professionalRuntimeIdsForRole("assembly-engineer")).toEqual(["assembly"]);
    expect(professionalRuntimeIdsForRole("computational-chemist")).toEqual(["psi4", "quantum-espresso", "cp2k"]);
    expect(professionalRuntimeIdsForRole("lean4-prover")).toEqual(["lean4"]);
    expect(professionalRuntimeIdsForRole("symbolic-mathematician")).toEqual(["wolfram"]);
    expect(professionalRuntimeIdsForRole("technical-educator")).toEqual(["jupyter"]);
    expect(professionalRuntimeIdsForRole("origin")).toEqual([]);
  });

  it("PTH_WORKER_ROLES 缺省时五个专业角色零副本（不进隐式单副本循环）", () => {
    const w = parseRoleWeights(undefined);
    for (const id of PROFESSIONAL_IDS) {
      expect(w.get(id)).toBe(0);
    }
    const expanded = expandRoleWeights(w);
    for (const id of PROFESSIONAL_IDS) {
      expect(expanded.some((r) => r.id === id)).toBe(false);
    }
  });

  it("PTH_WORKER_ROLES 显式 assembly-engineer:1 → 该角色 1 副本", () => {
    expect(parseRoleWeights("assembly-engineer:1").get("assembly-engineer")).toBe(1);
    expect(expandRoleWeights(parseRoleWeights("assembly-engineer:1")).filter((r) => r.id === "assembly-engineer")).toHaveLength(1);
  });

  it("专业角色 known lineage 可见，但不在 allWorkerRoles（默认 batch 不含）", () => {
    expect(allWorkerRoles().some((r) => PROFESSIONAL_IDS.includes(r.id as never))).toBe(false);
    for (const id of PROFESSIONAL_IDS) {
      expect(allKnownRoles().some((r) => r.id === id)).toBe(true);
    }
  });

  it("五个责任 fixture 过 N28 容量校验（共享 index/wiki 区域）", () => {
    const capacity = N28_FEASIBILITY_BUDGET.responsibility;
    for (const id of PROFESSIONAL_IDS) {
      const worker = PROFESSIONAL_ROLE_WORKERS[id]!;
      const result = checkResponsibilityCapacity(worker, PROFESSIONAL_ROLE_REGIONS, PROFESSIONAL_ROLE_RESPONSIBILITIES.get(id)!, capacity);
      expect(result).toEqual({
        ok: true,
        usage: {
          regions: PROFESSIONAL_ROLE_RESPONSIBILITIES.get(id)!.length,
          primaryWeight: expect.any(Number),
          secondaryWeight: expect.any(Number),
        },
      });
      if (result.ok) {
        expect(result.usage.primaryWeight).toBeLessThanOrEqual(capacity.maxPrimaryWeight);
        expect(result.usage.secondaryWeight).toBeLessThanOrEqual(capacity.maxSecondaryWeight);
        expect(result.usage.regions).toBeLessThanOrEqual(capacity.maxRegions);
      }
    }
  });

  it("五个预算 fixture 过 N28 任务预算校验（各轴 ≤ 基线且可冻结工作集）", () => {
    expect(() => assertProfessionalRoleBudgetsWithinN28()).not.toThrow();
    for (const id of PROFESSIONAL_IDS) {
      const role = PROFESSIONAL_ROLES.find((r) => r.id === id)!;
      const budget = PROFESSIONAL_ROLE_BUDGETS.get(role.loadPolicyRef!)!;
      const { policy, ledger } = createTaskWorkingSetPolicy({
        taskId: `task-${id}`,
        worker: PROFESSIONAL_ROLE_WORKERS[id]!,
        directorySnapshotId: "dir-professional",
        budget,
        skillIndexItems: [
          { id: "skill:professional-01", chars: 128 },
          { id: "skill:professional-02", chars: 128 },
        ],
        pinnedToolNames: ["done"],
        candidateToolNames: ["done"],
      });
      expect(policy.budget).toEqual(budget);
      expect(policy.skillIndexIds.length).toBeLessThanOrEqual(budget.maxSkillIndexEntries);
      expect(ledger.snapshot().usage.skillIndexEntries).toBeLessThanOrEqual(budget.maxSkillIndexEntries);
      expect(ledger.snapshot().usage.tools).toBeLessThanOrEqual(budget.maxTools);
    }
  });
});
