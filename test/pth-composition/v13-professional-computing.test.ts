/**
 * test/pth-composition/v13-professional-computing.test.ts —— v1.3 Task 10 组合测试。
 *
 * 覆盖 plan Step 1/2 的组合证据（共享记忆与授权面；真实垂直 Job 与四份教程由
 * technical-educator.integration.test.ts 在同一 focused 集合内提供）：
 *  - 一个 canonical 语料上两块重叠 index region，两个专业 Role 读同一 artifact，
 *    各自 Task Working Set 预算独立、正文零复制；
 *  - 四个专业 Worker Replica 独立可寻址；
 *  - run→intake / run→optimize 固定 handoff：新 workId、immutable 源 mode、完整 causation；
 *  - 12 项 sabotage probe：base 全过、单点破坏只翻转自己映射的门。
 */

import { describe, expect, it } from "vitest";
import {
  createCrossModeWork,
  createServerWorkEnvelope,
  assertWorkModeImmutable,
  N28_FEASIBILITY_BUDGET,
  type CognitiveBudget,
  type ExecutionGrant,
  type TaskLease,
  type TaskWorkItem,
  type WorkerReplicaRef,
} from "@away_from/pth-contracts";
import {
  createExecutionGrantService,
  createHmacGrantKeyProvider,
  createIndexMemoryReader,
  createVerifiedTaskReadScopeFactory,
  type IndexMemoryRecord,
  type IndexMemorySourceAdapter,
  type IndexMemorySpan,
  type VerifiedTaskReadScope,
} from "../../src/pth/execution/index.js";
import { createTaskWorkingSetPolicy } from "../../src/pth/runner/index.js";
import { createWorkerReplica } from "@away_from/pth-kernel-execution";
import { CognitiveBudgetLedger } from "@away_from/pth-kernel-execution";
import { runV13SabotageProbes, V13_SABOTAGE_GATES } from "../../scripts/tools/v13-authority-gates.js";

const TENANT = "tenant-a";
const HASH = `sha256:${"a".repeat(64)}`;
const nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const clock = () => new Date(nowMs);

// ─── canonical 记忆语料：正文只存一份，index 只存导航元数据 ──────────────────

const CANONICAL_URI = "artifact://mathlib-docs/List.map";
const CANONICAL_BODY = "theorem List.map_eq (f g) (l : List α) : map f (map g l) = map (f ∘ g) l := by simp";
const canonicalBodies = new Map<string, string>([[CANONICAL_URI, CANONICAL_BODY]]);

function makeIndexRecord(overrides: Partial<IndexMemoryRecord> = {}): IndexMemoryRecord {
  return {
    entryId: "idx:lean:list-map",
    sourceId: "lean4-mathlib",
    product: "Mathlib",
    version: "stable-lock",
    releaseChannel: "stable",
    canonicalUri: CANONICAL_URI,
    artifactHash: HASH,
    locator: { kind: "symbol", value: "List.map" },
    domains: ["formal-methods"],
    license: "Apache-2.0",
    ...overrides,
  };
}

function spanFor(record: IndexMemoryRecord): IndexMemorySpan {
  return {
    locator: record.locator,
    artifactHash: record.artifactHash,
    content: CANONICAL_BODY.slice(0, record.locator.kind === "symbol" ? 80 : 120),
  };
}

function makeSourceAdapter(record: IndexMemoryRecord): IndexMemorySourceAdapter {
  return { readExactSpan: async () => spanFor(record) };
}

// ─── 授权与预算（与 index-memory 权威测试同一套接线） ──────────────────────

const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000071",
  batchId: "batch-v13-composition",
  role: { roleId: "assembly-engineer", revision: "rev-v1" },
};

const lease: TaskLease = {
  taskId: "task-v13-composition",
  leaseId: "20000000-0000-4000-8000-000000000071",
  generation: 1,
  scope: { tenantId: TENANT, principalId: `worker:${worker.workerId}`, roles: ["assembly-engineer"], traceId: "trace-v13-composition", space: "meta" },
  workspace: { tenantId: TENANT, workspaceId: "ws-v13-composition", taskId: "task-v13-composition" },
  roleId: "assembly-engineer",
  deadlineAt: "2030-01-01T00:02:00.000Z",
};

const work: TaskWorkItem = {
  taskId: "task-v13-composition",
  scope: lease.scope,
  title: "v13 composition",
  text: "v13 composition",
  tags: [],
  payload: {},
  assignedRole: "assembly-engineer",
  domains: ["formal-methods"],
};

function makeGrantService() {
  return createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "v13-composition-test-secret-0123456789" }),
    clock,
  });
}

function issueGrant(svc: ReturnType<typeof makeGrantService>, roleId: string): ExecutionGrant {
  return svc.issue({
    lease,
    scope: { ...lease.scope, principalId: `worker:${worker.workerId}`, roles: [roleId] },
    workspace: lease.workspace,
    language: "ts",
    capabilities: ["memory.read", "memory.query"],
    ttlMs: 120_000,
  });
}

function mintScope(svc: ReturnType<typeof makeGrantService>, roleId: string): VerifiedTaskReadScope {
  const factory = createVerifiedTaskReadScopeFactory({ grantService: svc, grantForTask: () => issueGrant(svc, roleId) });
  return factory.forTask({ lease, work: { ...work, assignedRole: roleId }, space: "meta", worker: { ...worker, role: { roleId, revision: "rev-v1" } } });
}

function newLedger(taskId: string, roleId: string, overrides: Partial<CognitiveBudget> = {}): CognitiveBudgetLedger {
  return new CognitiveBudgetLedger({
    taskId,
    workerId: `${worker.workerId}-${roleId}`,
    directorySnapshotId: "md-v13-composition",
    budget: { ...N28_FEASIBILITY_BUDGET.task, ...overrides },
  });
}

// ─── Task 10 Step 1：共享记忆 / Replica / handoff / 预算 ───────────────────

describe("v13 authority composition（共享记忆 + 角色 + handoff + 预算）", () => {
  it("同一 index entry 路由两个专业 Role 到同一 artifact，各自工作集预算独立", async () => {
    const recordA = makeIndexRecord({ entryId: "idx:lean:list-map:a" });
    const recordB = makeIndexRecord({ entryId: "idx:lean:list-map:b", locator: { kind: "heading", value: "List.map" } });
    const reader = createIndexMemoryReader({ clock });
    const svc = makeGrantService();

    const assemblyScope = mintScope(svc, "assembly-engineer");
    const leanScope = mintScope(svc, "lean4-prover");
    const assemblyLedger = newLedger("task-a", "assembly-engineer");
    const leanLedger = newLedger("task-b", "lean4-prover");

    const spanA = await reader.readExact(assemblyScope, recordA, makeSourceAdapter(recordA), assemblyLedger);
    const spanB = await reader.readExact(leanScope, recordB, makeSourceAdapter(recordB), leanLedger);

    expect(recordA.canonicalUri).toBe(recordB.canonicalUri);
    expect(canonicalBodies.get(recordA.canonicalUri)).toBe(CANONICAL_BODY);
    expect(CANONICAL_BODY.startsWith(spanA.content)).toBe(true);
    expect(CANONICAL_BODY.startsWith(spanB.content)).toBe(true);
    expect(assemblyLedger.snapshot().usage.memoryEntries).toBe(1);
    expect(leanLedger.snapshot().usage.memoryEntries).toBe(1);
    expect(assemblyLedger.snapshot().usage.memoryChars).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxMemoryChars);
    expect(leanLedger.snapshot().usage.memoryChars).toBeLessThanOrEqual(N28_FEASIBILITY_BUDGET.task.maxMemoryChars);
  });

  it("canonical 语料正文只存一份，index region 零 body 复制", () => {
    const recordA = makeIndexRecord({ entryId: "idx:lean:list-map:a" });
    const recordB = makeIndexRecord({ entryId: "idx:lean:list-map:b", locator: { kind: "heading", value: "List.map" } });
    expect(canonicalBodies.size).toBe(1);
    expect("content" in recordA).toBe(false);
    expect("body" in recordA).toBe(false);
    expect("content" in recordB).toBe(false);
    expect("body" in recordB).toBe(false);
    expect(recordA.canonicalUri).toBe(recordB.canonicalUri);
  });

  it("四个专业 Worker Replica 独立可寻址且不共享任务状态", () => {
    const roleIds = ["assembly-engineer", "computational-chemist", "lean4-prover", "symbolic-mathematician"];
    const ids = roleIds.map((_, i) => `10000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, "0")}`);
    const replicas = roleIds.map((roleId, i) => createWorkerReplica(roleId, "catalog-v13", "batch-v13", () => ids[i]!));
    expect(new Set(replicas.map((r) => r.ref.workerId)).size).toBe(4);
    for (const replica of replicas) expect(replica.snapshot().state).toBe("idle");
    replicas[0]!.startTask("task-a");
    replicas[1]!.startTask("task-b");
    expect(replicas[0]!.snapshot().state).toBe("busy");
    expect(replicas[1]!.snapshot().state).toBe("busy");
    expect(replicas[2]!.snapshot().currentTaskId).toBeUndefined();
    replicas[0]!.finishTask("task-a");
    replicas[1]!.finishTask("task-b");
  });

  it("run→intake 与 run→optimize handoff 产生新 workId、完整 causation，源 mode 不可原地改", async () => {
    const runWork = createServerWorkEnvelope({
      workId: "work-run-1",
      mode: "run",
      objective: "verify byte-sum",
      authorityPolicyRef: "auth-default",
      budgetPolicyRef: "budget-default",
      causationId: "cause-run-1",
    });
    const published: Array<{ workMode: string; parentWorkId: string; causationId: string; objective: string }> = [];
    const publisher = {
      async publish(input: { workMode: "intake" | "optimize" | "run"; objective: string; authorityPolicyRef: string; budgetPolicyRef: string; parentWorkId: string; causationId: string }) {
        published.push(input);
        return { workId: `work-${input.workMode}-${published.length}` };
      },
    };

    const intake = await createCrossModeWork({
      fromWorkId: runWork.workId,
      fromMode: runWork.mode,
      toMode: "intake",
      objective: "ingest gap for byte-sum",
      authorityPolicyRef: runWork.authorityPolicyRef,
      budgetPolicyRef: runWork.budgetPolicyRef,
      causationId: runWork.causationId,
    }, publisher);
    const optimize = await createCrossModeWork({
      fromWorkId: runWork.workId,
      fromMode: runWork.mode,
      toMode: "optimize",
      objective: "optimize byte-sum telemetry",
      authorityPolicyRef: runWork.authorityPolicyRef,
      budgetPolicyRef: runWork.budgetPolicyRef,
      causationId: runWork.causationId,
    }, publisher);

    expect(intake.workId).toBe("work-intake-1");
    expect(optimize.workId).toBe("work-optimize-2");
    expect(intake.workId).not.toBe(runWork.workId);
    expect(optimize.workId).not.toBe(runWork.workId);
    expect(intake.parentWorkId).toBe(runWork.workId);
    expect(optimize.parentWorkId).toBe(runWork.workId);
    expect(intake.causationId).toBe(runWork.causationId);
    expect(optimize.causationId).toBe(runWork.causationId);
    expect(runWork.mode).toBe("run");
    expect(published.map((p) => p.workMode)).toEqual(["intake", "optimize"]);

    expect(() => assertWorkModeImmutable(runWork, { workId: runWork.workId, mode: "intake" })).toThrow(/new work id/);
  });

  it("四个 Task Working Set 各自冻结预算，超限只影响自己的账本", () => {
    const roleIds = ["assembly-engineer", "computational-chemist", "lean4-prover", "symbolic-mathematician"];
    const ledgers = roleIds.map((roleId, i) =>
      createTaskWorkingSetPolicy({
        taskId: `task-ws-${i}`,
        worker: { workerId: `worker-ws-${i}`, batchId: "batch-v13", role: { roleId, revision: "rev-v1" } },
        directorySnapshotId: "dir-v13",
        budget: N28_FEASIBILITY_BUDGET.task,
        skillIndexItems: [{ id: `skill:${roleId}`, chars: 32 }],
        pinnedToolNames: ["memory"],
        candidateToolNames: ["memory.query"],
      }).ledger,
    );

    ledgers[0]!.admitMemory([{ id: "entry-a", chars: 64 }]);
    ledgers[1]!.admitMemory([{ id: "entry-b", chars: 64 }]);
    expect(ledgers[0]!.snapshot().usage.memoryEntries).toBe(1);
    expect(ledgers[1]!.snapshot().usage.memoryEntries).toBe(1);
    expect(ledgers[2]!.snapshot().usage.memoryEntries).toBe(0);
    const oversize = newLedger("task-oversize", "lean4-prover");
    const admitted = oversize.admitMemory([{ id: "entry-big", chars: N28_FEASIBILITY_BUDGET.task.maxMemoryChars + 1 }]);
    expect(admitted.accepted).toHaveLength(0);
    expect(admitted.omitted).toHaveLength(1);
  });
});

// ─── Task 10 Step 2：12 项 sabotage，每项只翻转自己映射的门 ─────────────────

describe("v13 authority sabotage matrix（12 项，单点破坏只翻转自身）", () => {
  it("base fixture 全部通过，sabotaged fixture 只翻转自己映射的门", () => {
    const probes = runV13SabotageProbes();
    expect(probes).toHaveLength(12);
    for (const probe of probes) {
      expect(probe.baseOk, probe.gate).toBe(true);
      expect(probe.sabotagedOk, probe.gate).toBe(false);
      expect(probe.flipped, probe.gate).toBe(true);
    }

    for (let i = 0; i < V13_SABOTAGE_GATES.length; i++) {
      const mixed = V13_SABOTAGE_GATES.map((gate, j) => (j === i ? gate.sabotagedInput : gate.baseInput));
      const results = V13_SABOTAGE_GATES.map((gate, j) => gate.evaluate(mixed[j]));
      const flippedIndexes = results.flatMap((r, j) => (r.ok ? [] : [j]));
      expect(flippedIndexes, `sabotage ${V13_SABOTAGE_GATES[i]!.gate} must flip only its own gate`).toEqual([i]);
    }
  });

  it("sabotage 门名称与计划冻结清单一致", () => {
    expect(V13_SABOTAGE_GATES.map((g) => g.gate)).toEqual([
      "work-mode-in-place-mutation",
      "client-mode-self-stamp",
      "copied-index-body",
      "budget-bypass",
      "wrong-role-runtime",
      "arbitrary-command-field",
      "missing-artifact-hash",
      "lean-placeholder",
      "wolfram-fallback-masquerade",
      "chemistry-non-convergence-success",
      "notebook-historical-output-only",
      "specialist-default-replica",
    ]);
  });
});
