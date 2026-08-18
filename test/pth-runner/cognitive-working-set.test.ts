import { describe, expect, it, vi } from "vitest";
import { createBudgetedTaskCapabilities, createTaskWorkingSetPolicy } from "../../src/pth/runner/cognitive-working-set.js";
import { N28_FEASIBILITY_BUDGET } from "../../src/pth/contracts/index.js";
import { N28_WORKERS } from "../../scripts/n28-feasibility-fixture.js";
import type { AuthorizedTaskReads } from "../../src/pth/runner/authorized-task-reads.js";
import type { PendingRetrievalTrace } from "../../src/pth/contracts/index.js";

const pendingTrace = (): PendingRetrievalTrace => ({
  directorySnapshotId: "md-1", workerId: N28_WORKERS.algebra.workerId, queryFingerprint: "q-1",
  waves: [{ wave: 0, regionIds: [], candidateCount: 3, visibleCount: 3, selectedCount: 3, scannedCount: 3, completeForQuery: true, reason: "primary" }],
  globalFallback: false, omitted: {}, status: "found",
});

function adapters(overrides: Partial<AuthorizedTaskReads> = {}): AuthorizedTaskReads {
  return {
    assertCurrentScope: vi.fn(),
    retrieveMemory: vi.fn(async () => ({
      entries: [
        { id: "m1", content: "x".repeat(800) },
        { id: "m2", content: "y".repeat(800) },
      ],
      trace: pendingTrace(),
    })),
    getMemory: vi.fn(async (id: string) => (id === "draft" ? undefined : { id, content: "full" })),
    queryMemory: vi.fn(async () => [{ id: "q1", meta: { huge: "x".repeat(2000) } }, { id: "q2", meta: { huge: "y".repeat(2000) } }]),
    recallFunctions: vi.fn(async () => [{ id: "state:function:f", key: "f", source: "tool-function", spec: { large: "s".repeat(3000) } }]),
    recallInsights: vi.fn(async () => [{ id: "state:insight:i", content: "insight" }]),
    listSkills: vi.fn(async () => [
      { id: "skill:a", anchor: "a", whenToUse: "w", effect: "e", status: "official" },
      { id: "skill:b", anchor: "b", whenToUse: "w", effect: "e", status: "official" },
    ]),
    getSkill: vi.fn(async (id: string) => ({ id, tenantId: "tenant-a", kind: id, anchors: [], content: "full skill", status: "official", meta: {} })),
    ...overrides,
  };
}

describe("cognitive working set（policy + budgeted facade）", () => {
  it("policy 与 ledger 同源；六轴不超上限；skills.list 冻结快照零 backing read", async () => {
    const { policy, ledger } = createTaskWorkingSetPolicy({
      taskId: "task-n28", worker: N28_WORKERS.algebra, directorySnapshotId: "md-1", budget: N28_FEASIBILITY_BUDGET.task,
      skillIndexItems: [
        { id: "skill:a", chars: 100 },
        { id: "skill:b", chars: 100 },
      ],
      pinnedToolNames: ["done", "ts_run"],
      candidateToolNames: ["asp_cd", "ts", "registry_omitted"],
    });
    expect(policy.skillIndexIds).toEqual(["skill:a", "skill:b"]);
    expect(policy.toolNames).toEqual(["done", "ts_run", "asp_cd", "registry_omitted", "ts"]);

    const frozenSummaries = Object.freeze([
      Object.freeze({ id: "skill:a", anchor: "a", whenToUse: "w", effect: "e", status: "official" }),
      Object.freeze({ id: "skill:b", anchor: "b", whenToUse: "w", effect: "e", status: "official" }),
    ]);
    const fake = adapters();
    const caps = createBudgetedTaskCapabilities({}, policy, ledger, fake, { skillSummaries: frozenSummaries });

    const memory = caps["memory"] as { retrieve(o: unknown): Promise<Array<{ id: string }>>; get(id: string): Promise<{ id: string } | undefined>; query(sql: string): Promise<Array<{ id: string }>> };
    const state = caps["state"] as { recallFunctions(a: string[]): Promise<unknown[]>; recallInsights(a: string[]): Promise<unknown[]> };
    const skills = caps["skills"] as { list(): Promise<unknown[]>; get(id: string): Promise<unknown> };

    const retrieved = await memory.retrieve({ anchors: ["mathematics"] });
    expect(retrieved.map((e) => e.id)).toEqual(["m1", "m2"]);
    await expect(memory.get("draft")).resolves.toBeUndefined();
    await expect(memory.get("m9")).resolves.toMatchObject({ id: "m9" });
    const queried = await memory.query("SELECT 1");
    expect(queried.map((e) => e.id)).toEqual(["q1"]);   // q2 超预算在暴露前 omitted（账本硬上限）
    await state.recallFunctions(["a"]);
    await state.recallInsights(["a"]);
    expect(await skills.list()).toHaveLength(2);
    expect(await skills.list()).toHaveLength(2);
    expect(fake.listSkills).not.toHaveBeenCalled();   // wrapper 只返回冻结快照
    await expect(skills.get("skill:outside")).rejects.toThrow(/not in frozen skill index/);
    await expect(skills.get("a")).resolves.toMatchObject({ id: "skill:a" });

    const usage = ledger.snapshot().usage;
    expect(usage.memoryEntries).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxMemoryEntries);
    expect(usage.memoryChars).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxMemoryChars);
    expect(usage.skillIndexEntries).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxSkillIndexEntries);
    expect(usage.activeSkills).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxActiveSkills);
    expect(usage.skillChars).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxSkillChars);
    expect(usage.tools).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxTools);
    expect(fake.assertCurrentScope).toHaveBeenCalled();
  });

  it("state recall 只暴露 ledger accepted 行（P0-1 红→绿）：超条目时 omitted 不返回", async () => {
    const { policy, ledger } = createTaskWorkingSetPolicy({
      taskId: "task-n28", worker: N28_WORKERS.algebra, directorySnapshotId: "md-1",
      budget: { ...N28_FEASIBILITY_BUDGET.task, maxMemoryEntries: 1 },
      skillIndexItems: [],
      pinnedToolNames: ["done"],
      candidateToolNames: [],
    });
    const fake = adapters({
      recallFunctions: async () => [
        { id: "state:function:f1", key: "f1", source: "tool-function", spec: { a: 1 } },
        { id: "state:function:f2", key: "f2", source: "tool-function", spec: { b: 2 } },
      ],
      recallInsights: async () => [
        { id: "state:insight:i1", content: "one" },
        { id: "state:insight:i2", content: "two" },
      ],
    });
    const caps = createBudgetedTaskCapabilities({}, policy, ledger, fake, { skillSummaries: Object.freeze([]) });
    const state = caps["state"] as { recallFunctions(a: string[]): Promise<unknown[]>; recallInsights(a: string[]): Promise<unknown[]> };
    const functions = await state.recallFunctions(["a"]);
    expect(functions).toHaveLength(1);   // 第二条被 omit 不得暴露
    const insights = await state.recallInsights(["a"]);
    expect(insights).toHaveLength(0);    // 同一账本条目轴已满——两条 insight 都 omit，不得暴露
    const snapshot = ledger.snapshot();
    expect(snapshot.usage.memoryEntries).toBe(1);
    expect(snapshot.omitted["state:function:f2#row1"]).toBe(1);
    expect(snapshot.omitted["state:insight:i1#row0"]).toBe(1);
    expect(snapshot.omitted["state:insight:i2#row1"]).toBe(1);
  });

  it("超预算展开：memory.get / skills.get 抛 CognitiveBudgetExceededError 且不暴露", async () => {
    const { policy, ledger } = createTaskWorkingSetPolicy({
      taskId: "task-n28", worker: N28_WORKERS.algebra, directorySnapshotId: "md-1", budget: { ...N28_FEASIBILITY_BUDGET.task, maxMemoryChars: 10, maxSkillChars: 10 },
      skillIndexItems: [{ id: "skill:a", chars: 5 }],
      pinnedToolNames: ["done"],
      candidateToolNames: [],
    });
    const fake = adapters({
      getMemory: async (id) => ({ id, content: "x".repeat(1000) }),
      getSkill: async (id) => ({ id, tenantId: "tenant-a", kind: id, anchors: [], content: "y".repeat(1000), status: "official", meta: {} }),
    });
    const caps = createBudgetedTaskCapabilities({}, policy, ledger, fake, { skillSummaries: Object.freeze([]) });
    const memory = caps["memory"] as { get(id: string): Promise<unknown> };
    const skills = caps["skills"] as { get(id: string): Promise<unknown> };
    await expect(memory.get("m9")).rejects.toThrow(/cognitive-budget-exceeded/);
    await expect(skills.get("a")).rejects.toThrow(/cognitive-budget-exceeded/);
  });

  it("1,000 组重排输入的 policy+ledger 确定性（H5 内核）", () => {
    for (let seed = 0; seed < 1000; seed += 1) {
      const run = (reverse: boolean) => {
        const skillItems = Array.from({ length: 12 }, (_, i) => ({ id: `skill:${(seed + i * 5) % 17}`, chars: 20 + i }));
        const { policy, ledger } = createTaskWorkingSetPolicy({
          taskId: `t${seed}`, worker: N28_WORKERS.algebra, directorySnapshotId: "md-1", budget: N28_FEASIBILITY_BUDGET.task,
          skillIndexItems: [...(reverse ? skillItems.reverse() : skillItems)].sort((a, b) => a.id.localeCompare(b.id)),
          pinnedToolNames: ["done"],
          candidateToolNames: reverse
            ? Array.from({ length: 20 }, (_, i) => `tool_${(seed + i * 7) % 23}`).reverse()
            : Array.from({ length: 20 }, (_, i) => `tool_${(seed + i * 7) % 23}`),
        });
        ledger.admitMemory([{ id: `m${seed}`, chars: 100 + (seed % 500) }]);
        return { policy, snapshot: ledger.snapshot() };
      };
      const a = run(false);
      const b = run(true);
      expect(b.snapshot).toEqual(a.snapshot);
      expect(b.policy).toEqual(a.policy);
    }
  });
});
