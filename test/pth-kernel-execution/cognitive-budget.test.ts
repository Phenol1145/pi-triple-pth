import { describe, expect, it } from "vitest";
import { CognitiveBudgetLedger } from "../../src/pth/kernel/execution/cognitive-budget.js";
import { N28_FEASIBILITY_BUDGET, checkResponsibilityCapacity } from "../../src/pth/contracts/index.js";
import { N28_WORKERS } from "../../scripts/n28-feasibility-fixture.js";

describe("CognitiveBudgetLedger", () => {
  const ledgerFor = (budget = N28_FEASIBILITY_BUDGET.task) => new CognitiveBudgetLedger({
    taskId: "task-n28-ledger",
    workerId: N28_WORKERS.algebra.workerId,
    directorySnapshotId: "n28-directory-fixture",
    budget,
  });

  it("counts the initial context and later memory reads in the same budget", () => {
    const ledger = ledgerFor();
    expect(ledger.admitMemory([{ id: "m1", chars: 2000 }, { id: "m2", chars: 2000 }]).accepted.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(ledger.admitMemory([{ id: "m3", chars: 200 }]).accepted).toEqual([]);
    expect(ledger.snapshot().usage).toMatchObject({ memoryEntries: 2, memoryChars: 4000 });
  });

  it("charges only the positive representation delta when a summary expands to full text", () => {
    const ledger = ledgerFor({ ...N28_FEASIBILITY_BUDGET.task, maxMemoryChars: 500 });
    expect(ledger.admitMemory([{ id: "m1", chars: 200 }]).accepted).toHaveLength(1);
    expect(ledger.admitMemory([{ id: "m1", chars: 450 }]).accepted).toHaveLength(1);
    expect(ledger.snapshot().usage.memoryChars).toBe(450);
    expect(ledger.admitMemory([{ id: "m1", chars: 501 }]).accepted).toEqual([]);
    expect(ledger.snapshot().usage.memoryChars).toBe(450);
  });

  it("counts pinned tools and rejects a pinned face that already exceeds the limit", () => {
    const ledger = ledgerFor({ ...N28_FEASIBILITY_BUDGET.task, maxTools: 2 });
    expect(() => ledger.freezeTools(["done", "ts_run", "asp_cd"], [])).toThrow(/pinned tools exceed/);
  });

  it("allows only indexed skills and caps active skill count and characters", () => {
    const ledger = ledgerFor({ ...N28_FEASIBILITY_BUDGET.task, maxActiveSkills: 1, maxSkillChars: 15 });
    ledger.freezeSkillIndex([{ id: "skill:a", chars: 5 }, { id: "skill:b", chars: 5 }]);
    expect(ledger.activateSkill("skill:a", 10)).toBe(true);
    expect(ledger.activateSkill("skill:b", 1)).toBe(false);
    expect(ledger.activateSkill("skill:a", 16)).toBe(false);
    expect(() => ledger.activateSkill("skill:outside", 1)).toThrow(/not in frozen skill index/);
  });

  it("never exceeds any axis across 1000 deterministic generated surfaces", () => {
    for (let seed = 0; seed < 1000; seed += 1) {
      const run = (reverse = false) => {
        const ledger = new CognitiveBudgetLedger({
          taskId: `task-generated-${seed}`,
          workerId: N28_WORKERS.algebra.workerId,
          directorySnapshotId: "n28-directory-fixture",
          budget: N28_FEASIBILITY_BUDGET.task,
        });
        const generated = Array.from({ length: 1 + (seed % 30) }, (_, index) => ({
          id: `m-${(seed * 17 + index * 13) % 97}`,
          chars: 1 + ((seed * 31 + index * 19) % 1400),
        }));
        const source = reverse ? [...generated].reverse() : generated;
        const memory = [...source].sort((a, b) => a.id.localeCompare(b.id));
        ledger.admitMemory(memory);
        const generatedSkills = Array.from({ length: 20 }, (_, index) => ({ id: `skill:${(seed + index * 7) % 31}`, chars: 20 + index }));
        const skillSource = reverse ? [...generatedSkills].reverse() : generatedSkills;
        ledger.freezeSkillIndex([...skillSource].sort((a, b) => a.id.localeCompare(b.id)));
        for (let index = 0; index < 12; index += 1) {
          const id = ledger.snapshot().skillIndexIds[index];
          if (id) ledger.activateSkill(id, 100 + ((seed + index) % 900));
        }
        const generatedTools = Array.from({ length: 30 }, (_, index) => `tool_${(seed + index * 11) % 41}`);
        ledger.freezeTools(["done", "ts_run"], reverse ? [...generatedTools].reverse() : generatedTools);
        return ledger.snapshot();
      };
      const first = run(false);
      const second = run(true);
      expect(second).toEqual(first);
      expect(first.usage.memoryEntries).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxMemoryEntries);
      expect(first.usage.memoryChars).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxMemoryChars);
      expect(first.usage.skillIndexEntries).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxSkillIndexEntries);
      expect(first.usage.activeSkills).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxActiveSkills);
      expect(first.usage.skillChars).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxSkillChars);
      expect(first.usage.tools).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxTools);

      const generatedRegions = Array.from({ length: 1 + (seed % 6) }, (_, index) => ({
        regionId: `region:g-${index}`,
        revision: 1,
        selector: { anchorsAny: [`g-${index}`] },
        estimatedWeight: (seed * 13 + index * 17) % 100,
      }));
      const generatedResponsibilities = generatedRegions.map((region, index) => ({
        workerId: N28_WORKERS.algebra.workerId,
        regionId: region.regionId,
        regionRevision: 1,
        kind: index === 0 ? "primary" as const : index % 2 ? "overlap" as const : "fallback" as const,
        priority: index,
        epoch: 1,
      }));
      const capacity = checkResponsibilityCapacity(N28_WORKERS.algebra, generatedRegions, generatedResponsibilities, N28_FEASIBILITY_BUDGET.responsibility);
      const expectedPrimary = generatedRegions[0]?.estimatedWeight ?? 0;
      const expectedSecondary = generatedRegions.slice(1).reduce((sum, region) => sum + region.estimatedWeight, 0);
      const expectedOk = generatedRegions.length <= 3 && expectedPrimary <= 80 && expectedSecondary <= 40;
      expect(capacity.ok).toBe(expectedOk);
      if (capacity.ok) {
        expect(capacity.usage.regions).toBeLessThanOrEqual(3);
        expect(capacity.usage.primaryWeight).toBeLessThanOrEqual(80);
        expect(capacity.usage.secondaryWeight).toBeLessThanOrEqual(40);
      }
    }
  });
});
