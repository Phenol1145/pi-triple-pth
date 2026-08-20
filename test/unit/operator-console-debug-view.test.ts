/**
 * test/unit/operator-console-debug-view.test.ts — N33 Task 6 视图模型与密钥缺失测试。
 */
import { describe, expect, it } from "vitest";
import {
  createDebugViewModel,
  DEBUG_LAGGING_MS,
  DEBUG_STALE_MS,
} from "../../packages/framework/web/operator-console/debug.js";

const worker = (overrides = {}) => ({
  workerId: "worker-a",
  batchId: "batch-1",
  roleId: "lean4-prover",
  roleRevision: "rev-9",
  lifecycle: "running",
  workMode: "run",
  taskId: "task-1",
  leaseId: "lease-1",
  heartbeatAt: "2026-08-20T00:00:00.000Z",
  regions: [
    { regionId: "memory:wiki", weights: 0.5 },
    { regionId: "memory:index", weights: 0.5 },
  ],
  workingSet: ["idx:lean:list-map", "skill:prove:v1"],
  toolNames: ["probe", "check"],
  skillIds: ["skill:prove:v1"],
  ...overrides,
});

describe("operator console debug view model", () => {
  it("filters by workerId, roleId, workMode and lifecycle", () => {
    let clockNow = 1_000_000;
    const vm = createDebugViewModel({ clock: () => clockNow });
    vm.ingest(
      [
        worker({ workerId: "worker-a", roleId: "lean4-prover", workMode: "run", lifecycle: "running" }),
        worker({ workerId: "worker-b", roleId: "assembly-engineer", workMode: "intake", lifecycle: "idle" }),
      ],
      900_000,
    );
    expect(vm.view().workers.map((w) => w.workerId)).toEqual(["worker-a", "worker-b"]);
    expect(vm.setFilter("workerId", "worker-a").workers.map((w) => w.workerId)).toEqual(["worker-a"]);
    vm.setFilter("workerId", "");
    vm.setFilter("roleId", "assembly-engineer");
    expect(vm.view().workers.map((w) => w.roleId)).toEqual(["assembly-engineer"]);
    vm.setFilter("roleId", "");
    vm.setFilter("workMode", "intake");
    expect(vm.view().workers).toHaveLength(1);
    vm.setFilter("workMode", "all");
    vm.setFilter("lifecycle", "idle");
    expect(vm.view().workers).toHaveLength(1);
  });

  it("role revision 与 worker ID 分离；Working Set 只留 ID/计数；region 无 body", () => {
    const vm = createDebugViewModel();
    vm.ingest([
      worker({
        regions: [{ regionId: "memory:wiki", weights: 0.8, body: "SHOULD-NOT-APPEAR" }],
        workingSet: [{ id: "idx:a", body: "SECRET" }],
      }),
    ], Date.now());
    const view = vm.view();
    const w = view.workers[0]!;
    expect(w.roleRevision).toBe("rev-9");
    expect(w.roleRevision).not.toBe(w.workerId);
    expect(w.workingSet).toEqual({ ids: ["idx:a"], count: 1 });
    expect(w.regions[0]).toEqual({ regionId: "memory:wiki", weights: 0.8 });
  });

  it("序列化无 prompt/token/secret/env/记忆正文", () => {
    const vm = createDebugViewModel();
    vm.ingest([
      worker({
        regions: [{ regionId: "r", weights: 1, prompt: "p", chainOfThought: "c", secret: "s" }],
      }),
    ], Date.now());
    const serialized = vm.serialize();
    expect(serialized).not.toMatch(/secret-body|prompt-value/i);
    for (const forbidden of ["prompt", "chainOfThought", "token", "secret", "env", "content"]) {
      expect(JSON.stringify(JSON.parse(serialized))).not.toContain(`"${forbidden}"`);
    }
  });

  it("freshness: 5s lagging / 15s stale，确定性时钟", () => {
    let now = 10_000;
    const vm = createDebugViewModel({ clock: () => now });
    vm.ingest([worker()], now);
    expect(vm.view().freshness).toBe("fresh");
    now += DEBUG_LAGGING_MS + 1;
    expect(vm.view().freshness).toBe("lagging");
    now += DEBUG_STALE_MS - DEBUG_LAGGING_MS;
    expect(vm.view().freshness).toBe("stale");
  });

  it("ActivityHub hint 不复活缺失 worker：ingest 是全量权威快照", () => {
    const vm = createDebugViewModel();
    vm.ingest([worker()], 1);
    vm.ingest([], 2);
    expect(vm.view().workers).toHaveLength(0);
    expect(vm.view().total).toBe(0);
  });
});
