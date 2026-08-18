# N28 Role/Memory/Worker Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, through the real PTH worker and agent execution path, that independently addressable WorkerReplicas can share a Role, carry overlapping bounded memory responsibilities, recover relevant knowledge through layered fallback, and expose a single hard-bounded Memory/Skill/Tool working set.

**Architecture:** Add a reversible, feature-gated feasibility slice: runtime WorkerReplica identity, a tenant-scoped immutable in-memory MemoryDirectory, a layered retriever shared by KnowledgeContext and KnowledgeBroker, and a task-scoped CognitiveBudget ledger used by the actual agent capability and tool surfaces. Keep existing PG schemas, TaskLease persistence, N26 intake, and promotion unchanged. `PTH_COGNITIVE_RESPONSIBILITY_MODE=off` is the default and preserves the current heartbeat, principal and capability behavior; only the deterministic feasibility assembly sets it to `feasibility`.

**Tech Stack:** TypeScript, Node.js `crypto.randomUUID`/`createHash`, Vitest, existing PTH Runtime Catalog, TaskLoop, KnowledgeBroker, KnowledgeContextProvider, AgentTaskRunner, ToolReg and `@away_from/pth-memory` interfaces.

**Spec:** `docs/pth/n28-role-memory-orchestration-design.md`

## Global Constraints

- Role Definition expresses a durable work contract; WorkerReplica expresses a runtime instance. New code must not call a role ID a worker ID.
- Memory Responsibility changes maintenance and retrieval priority; it never grants visibility or ownership.
- Every fallback wave and every worker read surface (`get/query/retrieve/state.recall*`) must preserve tenant, space, `status=official`, and Execution Grant/task-scope checks.
- One memory entry may belong to multiple MemoryRegions, but its content is stored once.
- Every authorized official entry is classified into a declared Region or explicit `region:unclassified`; silent omission is forbidden.
- Task routing and TaskLease CAS remain role-based in this feasibility slice; no task or memory schema migration is allowed.
- The slice must use the existing KnowledgeBroker, KnowledgeContextProvider, AgentTaskRunner and agent-loop; copied evaluation-only retrieval logic is not acceptable evidence.
- The experimental limits are exactly: `maxRegions=3`, `maxPrimaryWeight=80`, `maxSecondaryWeight=40` (overlap + fallback), `maxMemoryEntries=8`, `maxMemoryChars=4096`, `maxSkillIndexEntries=8`, `maxActiveSkills=4`, `maxSkillChars=8192`, `maxTools=16`.
- Static and ToolReg tools share the same `maxTools` limit; pinned tools count toward it.
- The experiment does not create PG tables, automatic Region splitting, automatic Role differentiation, autoscaling, embeddings, or production defaults.
- A tenant/space/status/grant leak, a gold item made unreachable by responsibility assignment, a budget bypass, or non-independent same-Role replicas is an immediate No-Go.
- N27 R1–R6 files and contracts remain untouched. Tasks 1–7 are blocked until `docs/pth/v1.2-acceptance-fix-revalidation-final.md` exists, says `ACCEPTED`, and records R1–R6 as merged; touching runtime files before that is a plan violation.
- All Directory snapshots are single-tenant and bind entry revision/content hash. The builder rejects cross-tenant input, duplicate/unknown bindings, stale epochs and Region sets without a primary owner.
- `maxTools` counts actual LLM Tool schemas only (static + ToolReg, using canonical underscore names). TypeScript capability functions are governed by the capability grant plus their own Memory/Skill ledgers; they are not fictitious Tool schemas.
- The feasibility retriever executes all four bounded waves. Early-stop optimization is deferred until semantic confidence is calibrated; a port must distinguish `found`, `exhausted-empty`, `retrieval-incomplete`, and `retrieval-failed`.

## Feasibility Gate

The implementation is considered feasible only when H1–H6 in the spec all pass. The final evaluator exits `0` only for `GO`; any direct No-Go condition exits non-zero and names the failed hypothesis. A green unit suite without the vertical evaluator is not acceptance evidence.

Gate 0: before Task 1, record the N27 acceptance commit in the implementation branch and verify its final report is
`ACCEPTED`, names a main commit that already contains R6, and explicitly records R1–R6 as merged. A report whose header
still evaluates pre-R6 main while describing R6 as a lane run must first be amended and committed. No N28 code task starts
or merges before this gate. This prevents a reversible experiment from silently changing an acceptance repair that touches
the same runtime surfaces.

---

### Task 1: Freeze the Cognitive Responsibility Contract and Role Compatibility Name

**Files:**
- Create: `src/pth/contracts/cognitive-responsibility.ts`
- Modify: `src/pth/contracts/index.ts`
- Modify: `src/pth/kernel/execution/worker-cluster.ts`
- Create: `test/pth-contracts/cognitive-responsibility.test.ts`
- Modify: `test/pth-kernel-execution/worker-cluster.test.ts`

**Interfaces:**
- Consumes: existing role fields from `WorkerRole` and the canonical terms in `CONTEXT.md`.
- Produces: `RoleDefinition`, `RoleDefinitionRef`, `WorkerReplicaRef`, `MemoryType`, `MemoryRegion`, `MemoryResponsibility`, `ResponsibilityCapacity`, `CognitiveBudget`, `WorkerLoadEnvelope`, `TaskWorkingSetPolicy`, `TaskWorkingSet`, `RetrievalTrace`, `N28_FEASIBILITY_BUDGET`, `checkResponsibilityCapacity()`.

- [ ] **Step 1: Write the failing contract tests**

```typescript
import { describe, expect, it } from "vitest";
import {
  N28_FEASIBILITY_BUDGET,
  checkResponsibilityCapacity,
  type MemoryRegion,
  type MemoryResponsibility,
  type WorkerReplicaRef,
} from "../../src/pth/contracts/cognitive-responsibility.js";

const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000001",
  batchId: "batch-a",
  role: { roleId: "researcher", revision: "role-sha256:fixture-v1" },
};

const regions: MemoryRegion[] = [
  { regionId: "region:algebra", revision: 1, selector: { domains: ["algebra"] }, estimatedWeight: 50 },
  { regionId: "region:numerical", revision: 1, selector: { anchorsAny: ["numerical"] }, estimatedWeight: 30 },
];

const responsibilities: MemoryResponsibility[] = [
  { workerId: worker.workerId, regionId: "region:algebra", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: worker.workerId, regionId: "region:numerical", regionRevision: 1, kind: "overlap", priority: 1, epoch: 1 },
];

describe("cognitive responsibility contract", () => {
  it("accepts a worker load that is inside every responsibility limit", () => {
    expect(checkResponsibilityCapacity(worker, regions, responsibilities, N28_FEASIBILITY_BUDGET.responsibility)).toEqual({
      ok: true,
      usage: { regions: 2, primaryWeight: 50, secondaryWeight: 30 },
    });
  });

  it("rejects responsibility expansion above the primary weight", () => {
    const overloaded = regions.map((region) => region.regionId === "region:algebra" ? { ...region, estimatedWeight: 81 } : region);
    expect(checkResponsibilityCapacity(worker, overloaded, responsibilities, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({
      ok: false,
      reason: "primary-weight",
    });
  });

  it("counts overlap and fallback against the same secondary ceiling", () => {
    const withFallback = [
      ...responsibilities,
      { workerId: worker.workerId, regionId: "region:fallback", regionRevision: 1, kind: "fallback" as const, priority: 2, epoch: 1 },
    ];
    const withRegion = [...regions, { regionId: "region:fallback", revision: 1, selector: { anchorsAny: ["shared"] }, estimatedWeight: 11 }];
    expect(checkResponsibilityCapacity(worker, withRegion, withFallback, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({
      ok: false,
      reason: "secondary-weight",
    });
  });

  it("rejects a responsibility that names another worker", () => {
    const forged = [{ ...responsibilities[0]!, workerId: "10000000-0000-4000-8000-000000000099" }];
    expect(checkResponsibilityCapacity(worker, regions, forged, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({
      ok: false,
      reason: "worker-mismatch",
    });
  });
});
```

- [ ] **Step 2: Run the contract test and verify the missing module failure**

Run: `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts`

Expected: FAIL because `src/pth/contracts/cognitive-responsibility.ts` does not exist.

- [ ] **Step 3: Create the executable contract and exact experiment budget**

Create the interfaces exactly as written in N28 §§2.2, 4.1, 5.3 and 6.2, then add this executable validation:

```typescript
export const N28_FEASIBILITY_BUDGET: WorkerLoadEnvelope = Object.freeze({
  responsibility: Object.freeze({
    maxRegions: 3,
    maxPrimaryWeight: 80,
    maxSecondaryWeight: 40,
  }),
  task: Object.freeze({
    maxMemoryEntries: 8,
    maxMemoryChars: 4096,
    maxSkillIndexEntries: 8,
    maxActiveSkills: 4,
    maxSkillChars: 8192,
    maxTools: 16,
  }),
});

export type ResponsibilityCapacityResult =
  | { ok: true; usage: { regions: number; primaryWeight: number; secondaryWeight: number } }
  | { ok: false; reason: "worker-mismatch" | "unknown-region" | "region-revision" | "invalid-weight" | "duplicate-responsibility" | "region-count" | "primary-weight" | "secondary-weight" };

export function checkResponsibilityCapacity(
  worker: WorkerReplicaRef,
  regions: readonly MemoryRegion[],
  responsibilities: readonly MemoryResponsibility[],
  capacity: ResponsibilityCapacity,
): ResponsibilityCapacityResult {
  const byId = new Map(regions.map((region) => [region.regionId, region] as const));
  let primaryWeight = 0;
  let secondaryWeight = 0;
  const seen = new Set<string>();
  for (const responsibility of responsibilities) {
    if (responsibility.workerId !== worker.workerId) return { ok: false, reason: "worker-mismatch" };
    const region = byId.get(responsibility.regionId);
    if (!region) return { ok: false, reason: "unknown-region" };
    if (region.revision !== responsibility.regionRevision) return { ok: false, reason: "region-revision" };
    if (!Number.isFinite(region.estimatedWeight) || region.estimatedWeight < 0) return { ok: false, reason: "invalid-weight" };
    const bindingKey = `${responsibility.workerId}|${responsibility.regionId}`;
    if (seen.has(bindingKey)) return { ok: false, reason: "duplicate-responsibility" };
    seen.add(bindingKey);
    if (responsibility.kind === "primary") primaryWeight += region.estimatedWeight;
    else secondaryWeight += region.estimatedWeight;
  }
  const usage = { regions: responsibilities.length, primaryWeight, secondaryWeight };
  if (usage.regions > capacity.maxRegions) return { ok: false, reason: "region-count" };
  if (usage.primaryWeight > capacity.maxPrimaryWeight) return { ok: false, reason: "primary-weight" };
  if (usage.secondaryWeight > capacity.maxSecondaryWeight) return { ok: false, reason: "secondary-weight" };
  return { ok: true, usage };
}
```

- [ ] **Step 4: Export the contract from the barrel**

Add this exact export to `src/pth/contracts/index.ts`:

```typescript
export * from "./cognitive-responsibility.js";
```

- [ ] **Step 5: Rename the canonical role interface without breaking imports**

In `src/pth/kernel/execution/worker-cluster.ts`, rename the declaration `export interface WorkerRole` to `export interface RoleDefinition`, leave every existing field unchanged, add the optional policy reference below, and add the compatibility alias immediately after the interface:

```typescript
/** Optional immutable policy reference; absence means the host system ceiling. */
loadPolicyRef?: string;
```

```typescript
/** @deprecated Use RoleDefinition. Kept while runtime call sites migrate by layer. */
export type WorkerRole = RoleDefinition;
```

Extend `worker-cluster.test.ts` with a compile-time/runtime compatibility assertion:

```typescript
it("keeps WorkerRole as a compatibility alias for RoleDefinition", () => {
  const role: import("../../src/pth/kernel/execution/worker-cluster.js").RoleDefinition = {
    id: "compat-role",
    tags: ["compat"],
    prompt: "compat",
  };
  const legacy: import("../../src/pth/kernel/execution/worker-cluster.js").WorkerRole = role;
  expect(legacy.id).toBe("compat-role");
});
```

- [ ] **Step 6: Run the focused tests**

Run: `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts test/pth-kernel-execution/worker-cluster.test.ts test/pth-kernel-execution/role-lineage.test.ts`

Expected: PASS with no change to existing role registration or lineage output.

- [ ] **Step 7: Commit the contract slice**

```bash
git add src/pth/contracts/cognitive-responsibility.ts src/pth/contracts/index.ts src/pth/kernel/execution/worker-cluster.ts test/pth-contracts/cognitive-responsibility.test.ts test/pth-kernel-execution/worker-cluster.test.ts
git commit -m "feat(pth): define cognitive responsibility contracts"
```

---

### Task 2: Give Same-Role Workers Independent Runtime Identity and Control

**Files:**
- Create: `src/pth/kernel/execution/worker-replica.ts`
- Modify: `src/pth/contracts/tasking.ts`
- Modify: `src/pth/config/schema.ts`
- Modify: `docs/pth/configuration.md`
- Modify: `test/pth-config/config.test.ts`
- Modify: `src/pth/bootstrap/task-loop-types.ts`
- Modify: `src/pth/bootstrap/task-loop.ts`
- Create: `src/pth/bootstrap/worker-slot-assembly.ts`
- Create: `src/pth/bootstrap/worker-slot-runtime.ts`
- Create: `src/pth/bootstrap/batch-runtime-assembly.ts`
- Modify: `src/pth/bootstrap/batch-process.ts`
- Modify: `src/pth/kernel/execution/batch-manager.ts`
- Modify: `src/pth/impls/kernels/capability.ts`
- Modify: `src/pth/runner/observers/audit-observer.ts`
- Create: `test/pth-kernel-execution/worker-replica.test.ts`
- Create: `test/pth-kernel-execution/worker-slot-assembly.test.ts`
- Create: `test/pth-kernel-execution/worker-slot-runtime.test.ts`
- Create: `test/pth-kernel-execution/batch-runtime-assembly.test.ts`
- Modify: `test/pth-kernel-execution/task-loop.test.ts`
- Modify: `test/pth-kernel-execution/batch-manager.test.ts`

**Interfaces:**
- Consumes: `WorkerReplicaRef`, `RoleDefinition`, existing `TaskLoop`, batch IPC and Execution Grant identity.
- Produces: `WorkerReplica`, `WorkerReplicaStatus`, the production `WorkerSlotRuntime` used by `batch-process.ts`, batch
  heartbeat `replicas[]`, `pauseReplica()`, `resumeReplica()`, `removeReplica()`, deterministic stopped-slot cleanup, and
  runtime `TaskDispatchContext.worker` stamping.

- [ ] **Step 1: Write the failing replica state test**

```typescript
import { describe, expect, it } from "vitest";
import { createWorkerReplica, roleDefinitionRevision } from "../../src/pth/kernel/execution/worker-replica.js";

describe("WorkerReplica", () => {
  it("creates independently addressable replicas for the same role", () => {
    const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
    const a = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => ids.shift()!);
    const b = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => ids.shift()!);
    expect(a.ref.role).toEqual(b.ref.role);
    expect(a.ref.workerId).not.toBe(b.ref.workerId);
    a.pause();
    expect(a.snapshot().state).toBe("paused");
    expect(b.snapshot().state).toBe("idle");
  });

  it("allows one current task and returns to idle after completion", () => {
    const replica = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => "10000000-0000-4000-8000-000000000003");
    replica.startTask("task-a");
    expect(replica.snapshot()).toMatchObject({ state: "busy", currentTaskId: "task-a" });
    expect(() => replica.startTask("task-b")).toThrow(/already busy/);
    replica.finishTask("task-a");
    expect(replica.snapshot()).toMatchObject({ state: "idle", currentTaskId: undefined });
  });

  it("preserves a pause requested while busy", () => {
    const replica = createWorkerReplica("researcher", "catalog-v1", "batch-a", () => "10000000-0000-4000-8000-000000000004");
    replica.startTask("task-a");
    replica.pause();
    expect(replica.snapshot()).toMatchObject({ state: "draining", currentTaskId: "task-a" });
    replica.finishTask("task-a");
    expect(replica.snapshot()).toMatchObject({ state: "paused", currentTaskId: undefined });
  });

  it("versions one role from its canonical definition rather than an unrelated catalog", () => {
    const role = { id: "researcher", tags: ["research"], prompt: "p" };
    expect(roleDefinitionRevision({ prompt: "p", tags: ["research"], id: "researcher" })).toBe(roleDefinitionRevision(role));
    expect(roleDefinitionRevision({ ...role, prompt: "changed" })).not.toBe(roleDefinitionRevision(role));
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npx vitest run test/pth-kernel-execution/worker-replica.test.ts`

Expected: FAIL because `worker-replica.ts` does not exist.

- [ ] **Step 3: Implement the runtime replica object**

```typescript
import { createHash, randomUUID } from "node:crypto";
import type { WorkerReplicaRef } from "../../contracts/index.js";
import type { RoleDefinition } from "./worker-cluster.js";

export type WorkerReplicaState = "idle" | "busy" | "paused" | "draining" | "stopped";

export interface WorkerReplicaStatus extends WorkerReplicaRef {
  state: WorkerReplicaState;
  currentTaskId?: string;
}

export class WorkerReplica {
  private state: WorkerReplicaState = "idle";
  private currentTaskId: string | undefined;
  private pauseAfterTask = false;
  private stopAfterTask = false;

  constructor(readonly ref: WorkerReplicaRef) {}

  startTask(taskId: string): void {
    if (this.state !== "idle") throw new Error(`worker ${this.ref.workerId} already ${this.state}`);
    this.state = "busy";
    this.currentTaskId = taskId;
  }

  finishTask(taskId: string): void {
    if (this.currentTaskId !== taskId) throw new Error(`worker ${this.ref.workerId} does not hold ${taskId}`);
    this.currentTaskId = undefined;
    this.state = this.stopAfterTask ? "stopped" : this.pauseAfterTask ? "paused" : "idle";
    this.pauseAfterTask = false;
    this.stopAfterTask = false;
  }

  pause(): void {
    if (this.state === "busy") { this.pauseAfterTask = true; this.state = "draining"; return; }
    if (this.state !== "stopped") this.state = "paused";
  }
  resume(): void { if (this.state === "paused") this.state = "idle"; }
  drain(): void { this.pause(); }
  requestStop(): void {
    if (this.currentTaskId) { this.stopAfterTask = true; this.state = "draining"; return; }
    this.state = "stopped";
  }

  snapshot(): WorkerReplicaStatus {
    return { ...this.ref, state: this.state, ...(this.currentTaskId ? { currentTaskId: this.currentTaskId } : {}) };
  }
}

function stableRoleJson(role: RoleDefinition): string {
  const normalize = (value: unknown): unknown => Array.isArray(value)
    ? value.map(normalize)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]))
      : value;
  return JSON.stringify(normalize(role));
}

export function roleDefinitionRevision(role: RoleDefinition): string {
  return `role-sha256:${createHash("sha256").update(stableRoleJson(role)).digest("hex")}`;
}

export function createWorkerReplica(
  roleId: string,
  roleRevision: string,
  batchId: string,
  idFactory: () => string = randomUUID,
): WorkerReplica {
  return new WorkerReplica({ workerId: idFactory(), batchId, role: { roleId, revision: roleRevision } });
}
```

- [ ] **Step 4: Add a feature-gated, server-stamped worker reference to task dispatch context**

Add to `TaskDispatchContext` in `src/pth/contracts/tasking.ts`:

```typescript
/** Runtime replica identity stamped by batch TaskLoop; absent only on legacy/test callers. */
worker?: WorkerReplicaRef;
```

Import `WorkerReplicaRef` from the local contract module. In `TaskLoopDeps`, add:

```typescript
replica?: import("../kernel/execution/worker-replica.js").WorkerReplica;
```

Only when a replica dependency is present, call `this.deps.replica.startTask(taskId)` before runner execution and call
`this.deps.replica.finishTask(taskId)` in the same `finally` block that clears task-local kernel state. When TaskLoop calls
`setTaskDispatchContext`, include `worker: this.deps.replica.ref`; when it writes activity and audit events, add
`workerId: this.deps.replica.ref.workerId`. Also replace the two per-task identity fallbacks that currently stamp
`principalId: role.id` (claim scope and `setExecutionGrantContext`) with
`worker:${this.deps.replica.ref.workerId}` only when a replica exists; keep `roles:[role.id]`, `roleId`, task routing and
TaskLease CAS role-based. `AuditObserver` must record this server-stamped worker principal and a separate role field. With no
replica, retain the exact current context/audit/grant shape.
In `feasibility` mode both legacy and dispatched paths use a strict per-candidate cycle:
`check state → claim one candidate → execute/finally → check state again`. They must not pre-claim a batch. A busy remove
therefore finishes the current task without claiming a second candidate from the same `runOnce()` call. Mode `off` keeps
the existing polling algorithm byte-compatible. If this per-candidate adapter cannot be installed around one of the two
paths, that path is excluded from GO rather than leaving already-claimed work stranded.

- [ ] **Step 5: Add an off-by-default feasibility mode and stable role revision**

Add `PTH_BATCH_ID` as a string configuration key with default `""` and `PTH_COGNITIVE_RESPONSIBILITY_MODE` as an enum/string key restricted to `off|feasibility`, default `off`, in `src/pth/config/schema.ts`. In `BatchManager.spawnBatch`, add the generated batch ID to the child environment, but do not enable feasibility mode unless the caller explicitly requests the feasibility profile:

```typescript
envOverride = { ...envOverride, PTH_BATCH_ID: id };
```

Change the `fork()` environment expression so the override is not discarded when `deps.env` is undefined:

```typescript
env: { ...process.env, ...(this.deps.env ?? {}), ...envOverride },
```

Extract `assembleWorkerSlotIdentity()` into `src/pth/bootstrap/worker-slot-assembly.ts`. It takes mode, Role Definition,
batch ID and an injectable ID factory and returns two explicit principals because the legacy system currently differs by
surface: `taskPrincipalId=role.id` and `sandboxPrincipalId=worker:<roleId>` in `off`; both become
`worker:<workerId>` in `feasibility`. It must never collapse those rollback values into one ambiguous `principalId`.
Both `batch-process.ts` and in-memory tests call this helper; tests may not restate its branch logic.

Extract the slot lifecycle, heartbeat projection and worker-specific control reducer into
`src/pth/bootstrap/worker-slot-runtime.ts`. This is the production component that `batch-process.ts` must instantiate;
tests and the feasibility harness import the same component. In feasibility mode, replace the loop-only array with slots:

```typescript
type WorkerSlot = {
  replica: import("../kernel/execution/worker-replica.js").WorkerReplica;
  role: import("../kernel/execution/worker-cluster.js").RoleDefinition;
  loop: { runOnce(): Promise<boolean>; pause(): void; resume(): void; stop(): void };
  dispose: () => Promise<void>;
};

const slots: WorkerSlot[] = [];
```

The shared runtime has this finite public surface; it owns the array so callers cannot remove slots behind its cleanup path:

```typescript
export type WorkerControlMessage =
  | { type: "worker-pause"; workerId: string }
  | { type: "worker-resume"; workerId: string }
  | { type: "worker-remove"; workerId: string };

export type WorkerSlotEvent =
  | { type: "worker-status"; workerId: string; state: string; accepted: boolean }
  | { type: "worker-removed"; workerId: string };

export class WorkerSlotRuntime {
  constructor(options: { emit(event: WorkerSlotEvent): void });
  add(slot: WorkerSlot): void;
  runOnce(workerId: string): Promise<boolean>;
  runAllOnce(): Promise<boolean[]>;
  heartbeat(resource: { ts: number; rss: number; cpuU: number; cpuS: number }): {
    type: "status";
    tasks: Array<{ workerId: string; taskId: string }>;
    replicas: WorkerReplicaStatus[];
    ts: number;
    rss: number;
    cpuU: number;
    cpuS: number;
  };
  handleControl(message: WorkerControlMessage): Promise<{ workerId: string; state: string; accepted: boolean }>;
  list(): readonly WorkerReplicaStatus[];
  disposeAll(): Promise<void>;
}
```

`runOnce/runAllOnce` are the only polling entry points in feasibility mode. Their `finally` calls the internal
`finalizeStoppedSlot()` exactly once; batch process must not maintain a parallel slot array or cleanup loop.

Create `batch-runtime-assembly.ts` with `assembleBatchRuntime(deps)` and `runBatchHost(runtime, hostOpts)`. The former is
the only production composition root for worker identities, slot runtime, TaskLoop, heartbeat/control and disposers. The
latter owns IPC/control and polling; production passes `continuous=true`, while tests/harness pass `maxIterations` for a
finite run. `runBatchProcess()` may keep PG/schema/config setup, but after creating adapters it must call these two exports—
it cannot assemble workers or interpret worker control a second time. `scripts/n28-feasibility-harness.ts` later invokes the
same assembly/host with in-memory adapters. Thus H1 executes the production composition, not a source-text assertion.

At the start of `createWorker(role)`, call that helper. It creates a replica only when the mode is `feasibility`. Derive its role revision from the canonical Role Definition itself—not the Discipline Catalog—and use the configured batch ID, falling back to `batch:${process.pid}` only when the child is launched outside BatchManager:

```typescript
const replica = createWorkerReplica(
  role.id,
  roleDefinitionRevision(role),
  pthConfig().str("PTH_BATCH_ID") || `batch:${process.pid}`,
);
```

Pass `replica` into the existing TaskLoop/BatchTaskLoop; use the assembled task principal in TaskLoop and the assembled
sandbox principal in the kernel grant, retaining unchanged `roleId`. Store `{ replica, role, loop, dispose }` in the shared
slot runtime. In `off` mode, retain the current loop array, both historical principal values and public IPC/heartbeat shape.

- [ ] **Step 6: Make heartbeat and control worker-specific while retaining role-bulk compatibility**

In feasibility mode the host emits only the runtime-owned heartbeat projection; it must not read or maintain a second
`slots` array:

```typescript
process.send?.(runtime.heartbeat({
  ts: Date.now(),
  rss: mem.rss,
  cpuU: cpu.user,
  cpuS: cpu.system,
}));
```

The shared `WorkerSlotRuntime.handleControl()` handles `{type:"worker-pause",workerId}`,
`{type:"worker-resume",workerId}` and `{type:"worker-remove",workerId}` and touches exactly one slot, acknowledging with
the same `workerId`. `batch-process.ts` delegates those IPC messages to it; keep existing `{role}` handlers as explicitly
named bulk compatibility operations.
`worker-remove` on an idle/paused replica stops and removes it immediately; on a busy replica it marks a stop-after-task
intent and calls the loop's non-aborting `stop()` so the current execution may finish but no second candidate in the same
poll is claimed. `WorkerSlotRuntime.runOnce()` observes `stopped` after the runner `finally`, prevents another run, awaits
`loop.stop()`/`dispose()`, removes the slot, then emits the `removed` acknowledgement. It must never clear `currentTaskId`
while execution is live. Disposal and removal are idempotent. `handleControl()` may synchronously emit/return an accepted
`draining` status, but that is not the final removal acknowledgement: `finalizeStoppedSlot()` emits exactly one
`worker-removed` event after disposal. `runBatchHost()` forwards runtime events to IPC, and
`BatchManager.removeReplica()` resolves only on the final matching `worker-removed` event.

When mode is `off`, do not advertise `replicas`, do not accept worker-specific control messages, and keep current role-bulk behavior byte-compatible.

In `BatchManager`, store `replicas: WorkerReplicaStatus[]`, correlate `pendingCtl` by `workerId` for replica methods, and add:

```typescript
pauseReplica(batchId: string, workerId: string): Promise<boolean>;
resumeReplica(batchId: string, workerId: string): Promise<boolean>;
removeReplica(batchId: string, workerId: string): Promise<boolean>;
```

- [ ] **Step 7: Use the stamped worker principal in worker-originated task capabilities**

In `src/pth/impls/kernels/capability.ts`, replace synthesized `worker:${ctx.roleId}` principals in delegate/await/penetrate scopes with:

```typescript
principalId: ctx.worker ? `worker:${ctx.worker.workerId}` : `worker:${ctx.roleId}`,
```

The fallback exists only for legacy tests and non-batch callers; the vertical test must assert that production-style batch context takes the workerId branch.

- [ ] **Step 8: Extend BatchManager tests with independent same-role control**

Keep a small child-process stub only to verify BatchManager transport/correlation. It is not H1 acceptance evidence.
H1 evidence comes from `worker-slot-runtime.test.ts`, which constructs two same-Role slots with the exact production
runtime consumed by `batch-process.ts`, gives the addressed slot at least two pending candidates, blocks the first,
removes it while busy, releases it, and asserts:

- the addressed slot alone transitions `busy → draining → stopped → removed`;
- the second candidate is never claimed and remains pending; no subsequent `runOnce()` occurs for it;
- its kernel disposer runs exactly once;
- the other same-Role slot continues to claim and execute;
- heartbeat and acknowledgements come from the shared runtime projection, and the delayed final acknowledgement resolves
  the real `BatchManager.removeReplica()` correlation.

The transport stub reports two researcher replicas and removes only the addressed ID:

```typescript
const replicas = [
  { workerId: "w-a", batchId: "batch-a", role: { roleId: "researcher", revision: "v1" }, state: "idle" },
  { workerId: "w-b", batchId: "batch-a", role: { roleId: "researcher", revision: "v1" }, state: "idle" },
];
process.send?.({ type: "status", tasks: [], replicas, ts: Date.now() });
process.on("message", (msg) => {
  if (msg.type === "worker-remove" && msg.workerId) {
    const index = replicas.findIndex((replica) => replica.workerId === msg.workerId);
    if (index >= 0) replicas.splice(index, 1);
    process.send?.({ type: "worker-status", workerId: msg.workerId, state: "removed" });
    process.send?.({ type: "status", tasks: [], replicas, ts: Date.now() });
  }
  if (msg.type === "shutdown") process.exit(0);
});
```

Assert `removeReplica(batchId,"w-a")` returns true and `w-b` remains in `listBatches()`.

Add a second regression with the mode unset and assert the heartbeat has the old shape, worker-specific control is unavailable,
and every claim/grant/capability principal remains exactly equal to its pre-N28 role-derived value. This is the rollback proof for the feasibility slice.

In `task-loop.test.ts`, cover claim=0 (replica stays idle), completed/rejected/cancelled/throw (the same `finally` returns it
to idle), and pause during a busy task (state becomes `draining`, then `paused` after completion). Capture TaskDispatchContext,
grant context, activity and AuditObserver output and assert worker ID and role ID occupy separate fields. In
`worker-slot-assembly.test.ts`, call the exact helper used by batch process and assert both off and feasibility branches,
including the distinct legacy task/sandbox principals. In `batch-runtime-assembly.test.ts`, execute the exported host for
two finite iterations with injected TaskLoop/kernel adapters and assert the production assembly emits the same heartbeat,
control, audit and grant identities observed by the harness. A disconnected helper or source-text match is not evidence.

- [ ] **Step 9: Run worker identity tests and type checks**

Run: `npx vitest run test/pth-config/config.test.ts test/pth-kernel-execution/worker-replica.test.ts test/pth-kernel-execution/worker-slot-assembly.test.ts test/pth-kernel-execution/worker-slot-runtime.test.ts test/pth-kernel-execution/batch-runtime-assembly.test.ts test/pth-kernel-execution/task-loop.test.ts test/pth-kernel-execution/batch-manager.test.ts test/pth-kernel-execution/role-lineage.test.ts`

Run: `npx tsc --noEmit`

Expected: PASS; existing role-bulk control remains callable, and replica control is independent.

- [ ] **Step 10: Commit WorkerReplica identity**

```bash
git add src/pth/kernel/execution/worker-replica.ts src/pth/contracts/tasking.ts src/pth/config/schema.ts docs/pth/configuration.md src/pth/bootstrap/task-loop-types.ts src/pth/bootstrap/task-loop.ts src/pth/bootstrap/worker-slot-assembly.ts src/pth/bootstrap/worker-slot-runtime.ts src/pth/bootstrap/batch-runtime-assembly.ts src/pth/bootstrap/batch-process.ts src/pth/kernel/execution/batch-manager.ts src/pth/impls/kernels/capability.ts src/pth/runner/observers/audit-observer.ts test/pth-config/config.test.ts test/pth-kernel-execution/worker-replica.test.ts test/pth-kernel-execution/worker-slot-assembly.test.ts test/pth-kernel-execution/worker-slot-runtime.test.ts test/pth-kernel-execution/batch-runtime-assembly.test.ts test/pth-kernel-execution/task-loop.test.ts test/pth-kernel-execution/batch-manager.test.ts
git commit -m "feat(pth): separate worker replica identity from roles"
```

---

### Task 3: Build a Deterministic In-Memory MemoryDirectory with Overlap and Unclassified Coverage

**Files:**
- Create: `src/pth/execution/memory-type-classifier.ts`
- Create: `src/pth/execution/memory-directory.ts`
- Modify: `src/pth/execution/knowledge-broker.ts`
- Modify: `src/pth/execution/index.ts`
- Create: `scripts/n28-feasibility-fixture.ts`
- Create: `test/pth-execution/memory-directory.test.ts`
- Create: `test/pth-execution/memory-type-classifier.test.ts`

**Interfaces:**
- Consumes: `MemoryRegion`, `MemoryResponsibility`, active `WorkerReplicaRef[]`, top-level tenant identity and an explicit
  repository revision/classification projection around the existing `KnowledgeMemoryEntry` shape.
- Produces: explicit `MemoryTypeClassifier`, `MemoryDirectorySnapshot`, `buildMemoryDirectorySnapshot()`, `assertMemoryDirectorySnapshotIntegrity()`, `responsibilitiesForWorker()`, `membershipsForEntry()`, `regionEntryIds()`.

- [ ] **Step 1: Create the deterministic feasibility corpus fixture**

First add optional top-level `tenantId?: string` to `KnowledgeMemoryEntry` and preserve the repository-returned top-level
tenant in the Broker adapter. Do not mirror tenant into `meta`. Directory input tightens this to required.

Create `memory-type-classifier.ts` as the explicit repository-projection boundary. It does not infer from prose or
anchors. The feasibility mapping is frozen and exhaustive for the fixture: `domain-fact|domain-method|pth-wiki → wiki`,
`system-setting|role-definition|config → setting`, `skill|skill-index → skill`, and
`task-insight|episodic-log → log`. Unknown kinds return `undefined`; Directory construction fails closed until a repository
adapter supplies an approved mapping. Export `MemoryTypeClassifier` and `classifyFeasibilityMemoryType()`. The real store
adapter remains future work, but the feasibility vertical must call this production projection rather than hardcode
`"wiki"`. Add classifier tests for all four types, an unknown kind, and a `MemoryRegion.selector.memoryTypes` query.

Create `scripts/n28-feasibility-fixture.ts` with generators that produce exactly 100 authorized official entries plus a seven-row authorization/visibility probe matrix:

```typescript
import type { KnowledgeMemoryEntry } from "../src/pth/execution/knowledge-broker.js";
import { classifyFeasibilityMemoryType } from "../src/pth/execution/memory-type-classifier.js";
import { MID_ROLES } from "../src/pth/kernel/execution/builtin-roles.js";
import { roleDefinitionRevision } from "../src/pth/kernel/execution/worker-replica.js";

export const N28_ROLE = { ...MID_ROLES.find((role) => role.id === "researcher")!, loadPolicyRef: "n28-feasibility-v1" };
export const N28_ROLE_REVISION = roleDefinitionRevision(N28_ROLE);
export const N28_DOMAIN_IDS = new Set(["algebra", "geometry", "mathematics"]);

export type N28KnowledgeEntry = KnowledgeMemoryEntry & { tenantId: string };

function rows(prefix: string, count: number, domains: string[], anchors: string[], contentPrefix: string): N28KnowledgeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    tenantId: "tenant-a",
    kind: index % 4 === 0 ? "domain-method" : "domain-fact",
    anchors,
    status: "official",
    content: `${contentPrefix} ${index + 1}`,
    meta: { domains, spaceScope: { space: "meta", visibility: "public" } },
  }));
}

export function n28AuthorizedCorpus(): N28KnowledgeEntry[] {
  const algebra = rows("alg", 40, ["algebra"], ["mathematics", "algebra-core"], "algebra theorem");
  algebra[34] = { ...algebra[34]!, kind: "system-setting" };
  algebra[35] = { ...algebra[35]!, kind: "skill" };
  algebra[36] = { ...algebra[36]!, kind: "task-insight" };
  algebra[38] = { ...algebra[38]!, content: `${algebra[38]!.content} bounded global target decoy` };
  algebra[39] = { ...algebra[39]!, anchors: [...algebra[39]!.anchors, "numerical"] };
  return [
    ...algebra,
    ...rows("geo", 40, ["geometry"], ["mathematics", "geometry-core"], "geometry theorem"),
    ...rows("num", 10, ["mathematics"], ["mathematics", "numerical"], "numerical method"),
    ...rows("shared", 8, ["mathematics"], ["mathematics", "shared-method"], "shared mathematical method"),
    { id: "global-only", tenantId: "tenant-a", kind: "domain-fact", anchors: ["mathematics", "global-only"], status: "official", content: "bounded global target canonical", meta: { domains: ["mathematics"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "unclassified-only", tenantId: "tenant-a", kind: "domain-fact", anchors: ["orphan-anchor"], status: "official", content: "unclassified target", meta: { domains: [], spaceScope: { space: "meta", visibility: "public" } } },
  ];
}

export function n28DirectoryInputs(
  entries: readonly N28KnowledgeEntry[] = n28AuthorizedCorpus(),
  revisions: ReadonlyMap<string, number> = new Map(),
) {
  return entries.map((entry) => {
    const memoryType = classifyFeasibilityMemoryType(entry);
    if (!memoryType) throw new Error(`unclassified memory kind: ${entry.kind}`);
    return { entry, revision: revisions.get(entry.id) ?? 1, memoryType };
  });
}

export const N28_WORKERS = {
  algebra: {
    workerId: "10000000-0000-4000-8000-000000000011",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
  geometry: {
    workerId: "10000000-0000-4000-8000-000000000012",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
  curator: {
    workerId: "10000000-0000-4000-8000-000000000013",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
  global: {
    workerId: "10000000-0000-4000-8000-000000000014",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
} as const;

export const N28_REGIONS = [
  { regionId: "region:algebra", revision: 1, mode: "selector", selector: { domains: ["algebra"] }, estimatedWeight: 0 },
  { regionId: "region:geometry", revision: 1, mode: "selector", selector: { domains: ["geometry"] }, estimatedWeight: 0 },
  { regionId: "region:numerical", revision: 1, selector: { anchorsAny: ["numerical"] }, estimatedWeight: 0 },
  { regionId: "region:shared", revision: 1, selector: { anchorsAny: ["shared-method"] }, estimatedWeight: 0 },
  { regionId: "region:global-holdout", revision: 1, selector: { anchorsAny: ["global-only"] }, estimatedWeight: 0 },
  { regionId: "region:unclassified", revision: 1, mode: "unclassified", selector: {}, estimatedWeight: 0 },
] as const;

export const N28_RESPONSIBILITIES = [
  { workerId: N28_WORKERS.algebra.workerId, regionId: "region:algebra", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.algebra.workerId, regionId: "region:numerical", regionRevision: 1, kind: "overlap", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.algebra.workerId, regionId: "region:shared", regionRevision: 1, kind: "fallback", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.geometry.workerId, regionId: "region:geometry", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.geometry.workerId, regionId: "region:numerical", regionRevision: 1, kind: "overlap", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.geometry.workerId, regionId: "region:shared", regionRevision: 1, kind: "fallback", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.curator.workerId, regionId: "region:shared", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.curator.workerId, regionId: "region:unclassified", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 },
  { workerId: N28_WORKERS.global.workerId, regionId: "region:global-holdout", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.global.workerId, regionId: "region:numerical", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 },
] as const;

export function n28TrapCorpus(): N28KnowledgeEntry[] {
  return [
    { id: "trap-tenant", tenantId: "tenant-b", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "tenant trap", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "trap-space", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "space trap", meta: { domains: ["algebra"], spaceScope: { space: "private-other", visibility: "private" } } },
    { id: "trap-draft", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "draft", content: "draft trap", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "trap-archived", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "archived", content: "archived trap", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "probe-public-child", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "public child probe", meta: { domains: ["algebra"], spaceScope: { space: "child", visibility: "public" } } },
    { id: "probe-private-same", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "private same probe", meta: { domains: ["algebra"], spaceScope: { space: "dev", visibility: "private" } } },
    { id: "probe-public-ancestor", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "public ancestor probe", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
  ];
}
```

- [ ] **Step 2: Write failing overlap, coverage and determinism tests**

```typescript
import { describe, expect, it } from "vitest";
import { N28_FEASIBILITY_BUDGET, checkResponsibilityCapacity } from "../../src/pth/contracts/index.js";
import { assertMemoryDirectorySnapshotIntegrity, buildMemoryDirectorySnapshot, membershipsForEntry } from "../../src/pth/execution/memory-directory.js";
import { N28_DOMAIN_IDS, N28_REGIONS, N28_RESPONSIBILITIES, N28_WORKERS, n28AuthorizedCorpus, n28DirectoryInputs, type N28KnowledgeEntry } from "../../scripts/n28-feasibility-fixture.js";

describe("MemoryDirectory", () => {
  it("references one cross-domain entry from multiple regions without copying it", () => {
    const corpus = n28AuthorizedCorpus();
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs(corpus) });
    expect(directory.memberships.find((membership) => membership.entryId === "alg-40")?.regionIds).toEqual([
      "region:algebra",
      "region:numerical",
    ]);
    expect(corpus.filter((entry) => entry.id === "alg-40")).toHaveLength(1);
  });

  it("classifies every entry or records it as unclassified", () => {
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() });
    expect(directory.memberships).toHaveLength(100);
    expect(directory.unclassifiedEntryIds).toEqual(["unclassified-only"]);
    expect(directory.regions.some((region) => region.regionId === "region:unclassified")).toBe(true);
    expect(new Set(n28DirectoryInputs().map((item) => item.memoryType))).toEqual(new Set(["setting", "wiki", "skill", "log"]));
  });

  it("produces the same snapshot for reordered input and a different one for a content revision", () => {
    const corpus = n28AuthorizedCorpus();
    const a = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs(corpus) });
    const b = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS).reverse(), regions: [...N28_REGIONS].reverse(), responsibilities: [...N28_RESPONSIBILITIES].reverse(), entries: n28DirectoryInputs([...corpus].reverse()) });
    expect(b.snapshotId).toBe(a.snapshotId);
    expect(b.memberships).toEqual(a.memberships);
    expect(Object.isFrozen(a.memberships[0]!.regionIds)).toBe(true);
    expect(() => (a.memberships[0]!.regionIds as string[]).push("region:forged")).toThrow();
    expect(Object.isFrozen(N28_REGIONS[0].selector)).toBe(false);
    const changed = corpus.map((entry) => entry.id === "alg-01" ? { ...entry, content: `${entry.content}!` } : entry);
    const c = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs(changed, new Map([["alg-01", 2]])) });
    expect(c.snapshotId).not.toBe(a.snapshotId);
    expect(c.corpusFingerprint).not.toBe(a.corpusFingerprint);
  });

  it("keeps both same-role replicas inside the fixed responsibility capacity", () => {
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() });
    for (const worker of Object.values(N28_WORKERS)) {
      const assigned = directory.responsibilities.filter((item) => item.workerId === worker.workerId);
      expect(checkResponsibilityCapacity(worker, directory.regions, assigned, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({ ok: true });
    }
  });

  it("rejects cross-tenant entries, duplicate bindings, stale epochs and ownerless regions", () => {
    const base = { tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() } as const;
    expect(() => buildMemoryDirectorySnapshot({ ...base, entries: [...base.entries, { ...base.entries[0]!, entry: { ...base.entries[0]!.entry, id: "tenant-duplicate", tenantId: "tenant-b" } }] })).toThrow(/tenant/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, responsibilities: [...base.responsibilities, base.responsibilities[0]!] })).toThrow(/duplicate responsibility/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, responsibilities: base.responsibilities.map((item) => ({ ...item, epoch: 0 })) })).toThrow(/epoch/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, responsibilities: base.responsibilities.filter((item) => item.regionId !== "region:global-holdout") })).toThrow(/primary owner/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, workers: base.workers.filter((worker) => worker.workerId !== N28_WORKERS.global.workerId) })).toThrow(/unknown worker/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, entries: base.entries.map((item) => item.entry.id === "alg-01" ? { ...item, revision: 0 } : item) })).toThrow(/revision/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, regions: base.regions.map((region) => region.regionId === "region:algebra" ? { ...region, selector: { domains: ["not-in-catalog"] } } : region) })).toThrow(/unknown selector domain/);
  });

  it("rejects a forged revision, content hash, index hash or epoch before retrieval", () => {
    const entries = n28DirectoryInputs();
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries });
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, epoch: 2 }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
    const membership = { ...directory.memberships[0]!, contentHash: "0".repeat(64) };
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, memberships: [membership, ...directory.memberships.slice(1)] }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
    const staleRevision = { ...directory.memberships[0]!, entryRevision: directory.memberships[0]!.entryRevision + 1 };
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, memberships: [staleRevision, ...directory.memberships.slice(1)] }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
    const forgedIndex = { ...directory.memberships[0]!, indexHash: "f".repeat(64) };
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, memberships: [forgedIndex, ...directory.memberships.slice(1)] }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
  });

  it("places a newly promoted but unmatched official entry into unclassified on the next immutable snapshot", () => {
    const before = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() });
    const added = { id: "new-official", tenantId: "tenant-a", kind: "domain-fact", anchors: ["new-anchor"], status: "official", content: "new intake result", meta: { domains: [], spaceScope: { space: "meta", visibility: "public" } } } satisfies N28KnowledgeEntry;
    const after = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs([...n28AuthorizedCorpus(), added]) });
    expect(before.memberships).toHaveLength(100);
    expect(after.memberships).toHaveLength(101);
    expect(membershipsForEntry(after, "new-official")).toEqual(["region:unclassified"]);
    expect(before.snapshotId).not.toBe(after.snapshotId);
  });
});
```

- [ ] **Step 3: Run the tests and verify the missing directory failure**

Run: `npx vitest run test/pth-execution/memory-directory.test.ts`

Expected: FAIL because `memory-directory.ts` does not exist.

- [ ] **Step 4: Implement selector matching, overlap membership and stable snapshot hashing**

```typescript
import { createHash } from "node:crypto";
import type { MemoryRegion, MemoryResponsibility, MemoryType, WorkerReplicaRef } from "../contracts/index.js";
import type { KnowledgeMemoryEntry } from "./knowledge-broker.js";

export interface RegionMembership {
  tenantId: string;
  entryId: string;
  entryRevision: number;
  contentHash: string;
  indexHash: string;
  regionIds: readonly string[];
}

export interface MemoryDirectorySnapshot {
  tenantId: string;
  epoch: number;
  snapshotId: string;
  corpusFingerprint: string;
  workers: readonly WorkerReplicaRef[];
  regions: readonly MemoryRegion[];
  responsibilities: readonly MemoryResponsibility[];
  memberships: readonly RegionMembership[];
  unclassifiedEntryIds: readonly string[];
}

export interface DirectoryEntryInput {
  entry: KnowledgeMemoryEntry & { tenantId: string };
  revision: number;
  memoryType: MemoryType;
}

function matches(region: MemoryRegion, input: DirectoryEntryInput): boolean {
  if (region.mode === "unclassified") return false;
  const entry = input.entry;
  const selector = region.selector;
  const anchors = new Set(entry.anchors);
  const domains = new Set(Array.isArray(entry.meta?.["domains"]) ? entry.meta!["domains"] as string[] : []);
  if (selector.domains?.length && !selector.domains.some((domain) => domains.has(domain))) return false;
  if (selector.memoryTypes?.length && !selector.memoryTypes.includes(input.memoryType)) return false;
  if (selector.kinds?.length && !selector.kinds.includes(entry.kind)) return false;
  if (selector.anchorsAny?.length && !selector.anchorsAny.some((anchor) => anchors.has(anchor))) return false;
  if (selector.anchorPrefixes?.length && !entry.anchors.some((anchor) => selector.anchorPrefixes!.some((prefix) => anchor.startsWith(prefix)))) return false;
  return Boolean(selector.domains?.length || selector.memoryTypes?.length || selector.kinds?.length || selector.anchorsAny?.length || selector.anchorPrefixes?.length);
}

function stable<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((a, b) => key(a).localeCompare(key(b)));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildMemoryDirectorySnapshot(
  input: {
    tenantId: string;
    epoch: number;
    knownDomainIds: ReadonlySet<string>;
    workers: readonly WorkerReplicaRef[];
    regions: readonly MemoryRegion[];
    responsibilities: readonly MemoryResponsibility[];
    entries: readonly DirectoryEntryInput[];
  },
): MemoryDirectorySnapshot {
  if (!input.tenantId || !Number.isInteger(input.epoch) || input.epoch < 1) throw new Error("invalid tenant/epoch");
  const workers = stable(input.workers.map((worker) => ({ ...worker, role: { ...worker.role } })), (worker) => worker.workerId);
  if (new Set(workers.map((worker) => worker.workerId)).size !== workers.length) throw new Error("duplicate worker id");
  const workerIds = new Set(workers.map((worker) => worker.workerId));
  const regionSpecs = stable(input.regions.map((region) => ({
    ...region,
    selector: Object.fromEntries(Object.entries(region.selector).map(([key, values]) => [key, values ? [...values] : values])) as MemoryRegion["selector"],
  })), (region) => `${region.regionId}@${region.revision}`);
  if (new Set(regionSpecs.map((region) => region.regionId)).size !== regionSpecs.length) throw new Error("duplicate region");
  if (!regionSpecs.some((region) => region.regionId === "region:unclassified" && region.mode === "unclassified")) throw new Error("missing explicit unclassified region");
  for (const region of regionSpecs) {
    if (!Number.isFinite(region.estimatedWeight) || region.estimatedWeight < 0) throw new Error("invalid region weight");
    if (region.mode !== "unclassified" && Object.values(region.selector).every((values) => !Array.isArray(values) || values.length === 0)) throw new Error("empty selector");
    if (region.selector.domains?.some((domain) => !input.knownDomainIds.has(domain))) throw new Error("unknown selector domain");
  }
  const responsibilities = stable(input.responsibilities.map((item) => ({ ...item })), (item) => `${item.workerId}|${item.kind}|${String(item.priority).padStart(8, "0")}|${item.regionId}`);
  const regionById = new Map(regionSpecs.map((region) => [region.regionId, region] as const));
  const bindingKeys = new Set<string>();
  for (const item of responsibilities) {
    if (!workerIds.has(item.workerId)) throw new Error("responsibility references unknown worker");
    if (item.epoch !== input.epoch) throw new Error("responsibility epoch mismatch");
    const region = regionById.get(item.regionId);
    if (!region || region.revision !== item.regionRevision) throw new Error("unknown region revision");
    const key = `${item.workerId}|${item.regionId}`;
    if (bindingKeys.has(key)) throw new Error("duplicate responsibility");
    bindingKeys.add(key);
  }
  for (const region of regionSpecs) {
    if (!responsibilities.some((item) => item.regionId === region.regionId && item.kind === "primary")) throw new Error(`region ${region.regionId} has no primary owner`);
  }
  const entries = stable(input.entries, (item) => item.entry.id);
  if (new Set(entries.map((item) => item.entry.id)).size !== entries.length) throw new Error("duplicate tenant entry identity");
  for (const item of entries) {
    const entry = item.entry;
    if (entry.tenantId !== input.tenantId) throw new Error("cross-tenant directory entry");
    if (!Number.isInteger(item.revision) || item.revision < 1) throw new Error("invalid entry revision");
    if (!["setting", "wiki", "skill", "log"].includes(item.memoryType)) throw new Error("invalid memory type");
    if (entry.status !== "official") throw new Error("directory accepts official entries only");
    const domains = Array.isArray(entry.meta?.["domains"]) ? entry.meta!["domains"] as string[] : [];
    if (domains.some((domain) => !input.knownDomainIds.has(domain))) throw new Error("unknown entry domain");
  }
  const memberships = entries.map((item) => {
    const entry = item.entry;
    const matched = regionSpecs.filter((region) => matches(region, item)).map((region) => region.regionId);
    return {
      tenantId: input.tenantId,
      entryId: entry.id,
      entryRevision: item.revision,
      contentHash: createHash("sha256").update(entry.content).digest("hex"),
      indexHash: createHash("sha256").update(JSON.stringify({ memoryType: item.memoryType, kind: entry.kind, anchors: [...entry.anchors].sort(), domains: [...(Array.isArray(entry.meta?.["domains"]) ? entry.meta!["domains"] as string[] : [])].sort(), status: entry.status })).digest("hex"),
      regionIds: matched.length ? matched : ["region:unclassified"],
    };
  });
  const entryById = new Map(entries.map((item) => [item.entry.id, item.entry] as const));
  const regions = regionSpecs.map((region) => {
    const memberIds = memberships.filter((membership) => membership.regionIds.includes(region.regionId)).map((membership) => membership.entryId);
    const totalContentChars = memberIds.reduce((sum, entryId) => sum + (entryById.get(entryId)?.content.length ?? 0), 0);
    const selectorClauseCount =
      (region.selector.domains?.length ?? 0) +
      (region.selector.memoryTypes?.length ?? 0) +
      (region.selector.kinds?.length ?? 0) +
      (region.selector.anchorsAny?.length ?? 0) +
      (region.selector.anchorPrefixes?.length ?? 0);
    return {
      ...region,
      estimatedWeight: memberIds.length + Math.ceil(totalContentChars / 4096) + selectorClauseCount,
    };
  });
  const unclassifiedEntryIds = memberships.filter((membership) => membership.regionIds.includes("region:unclassified")).map((membership) => membership.entryId);
  const corpusFingerprint = createHash("sha256").update(JSON.stringify(memberships.map(({ tenantId, entryId, entryRevision, contentHash, indexHash }) => ({ tenantId, entryId, entryRevision, contentHash, indexHash })))).digest("hex");
  const digestInput = JSON.stringify({ tenantId: input.tenantId, epoch: input.epoch, corpusFingerprint, workers, regions, responsibilities, memberships });
  const snapshotId = `md-${createHash("sha256").update(digestInput).digest("hex").slice(0, 16)}`;
  return deepFreeze({ tenantId: input.tenantId, epoch: input.epoch, snapshotId, corpusFingerprint, workers, regions, responsibilities, memberships, unclassifiedEntryIds });
}

export function responsibilitiesForWorker(directory: MemoryDirectorySnapshot, workerId: string): MemoryResponsibility[] {
  return directory.responsibilities.filter((item) => item.workerId === workerId);
}

export function membershipsForEntry(directory: MemoryDirectorySnapshot, entryId: string): readonly string[] {
  return directory.memberships.find((membership) => membership.entryId === entryId)?.regionIds ?? [];
}

export function regionEntryIds(directory: MemoryDirectorySnapshot, regionId: string): string[] {
  return directory.memberships.filter((membership) => membership.regionIds.includes(regionId)).map((membership) => membership.entryId);
}

export function assertMemoryDirectorySnapshotIntegrity(
  directory: MemoryDirectorySnapshot,
  source: { knownDomainIds: ReadonlySet<string>; entries: readonly DirectoryEntryInput[] },
): void {
  try {
    const rebuilt = buildMemoryDirectorySnapshot({
      tenantId: directory.tenantId,
      epoch: directory.epoch,
      knownDomainIds: source.knownDomainIds,
      workers: directory.workers,
      regions: directory.regions,
      responsibilities: directory.responsibilities,
      entries: source.entries,
    });
    if (rebuilt.snapshotId !== directory.snapshotId || rebuilt.corpusFingerprint !== directory.corpusFingerprint || JSON.stringify(rebuilt) !== JSON.stringify(directory)) {
      throw new Error("snapshot differs");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`memory directory snapshot integrity mismatch: ${detail}`);
  }
}
```

- [ ] **Step 5: Export the directory and run focused tests**

Add to `src/pth/execution/index.ts`:

```typescript
export * from "./memory-directory.js";
```

Run: `npx vitest run test/pth-execution/memory-type-classifier.test.ts test/pth-execution/memory-directory.test.ts test/pth-contracts/cognitive-responsibility.test.ts`

Expected: PASS; membership count is exactly 100 and reordered inputs share a snapshot ID.

- [ ] **Step 6: Commit the in-memory directory**

```bash
git add src/pth/execution/memory-type-classifier.ts src/pth/execution/memory-directory.ts src/pth/execution/knowledge-broker.ts src/pth/execution/index.ts scripts/n28-feasibility-fixture.ts test/pth-execution/memory-type-classifier.test.ts test/pth-execution/memory-directory.test.ts
git commit -m "feat(pth): add overlapping memory directory snapshot"
```

---

### Task 4: Add Layered Retrieval and Share It Between KnowledgeBroker and KnowledgeContext

**Files:**
- Create: `src/pth/execution/layered-knowledge-retriever.ts`
- Create: `src/pth/execution/authorization/verified-task-read-scope.ts`
- Modify: `src/pth/execution/knowledge-ranking.ts`
- Modify: `src/pth/execution/knowledge-broker.ts`
- Modify: `src/pth/runner/knowledge-context.ts`
- Modify: `src/pth/runner/agent-task-runner.ts`
- Modify: `scripts/n28-feasibility-fixture.ts`
- Create: `test/pth-execution/layered-knowledge-retriever.test.ts`
- Create: `test/pth-execution/verified-task-read-scope.test.ts`
- Modify: `test/pth-execution/knowledge-broker.test.ts`
- Modify: `test/pth-runner/knowledge-context.test.ts`

**Interfaces:**
- Consumes: immutable `MemoryDirectorySnapshot`, a single verified task-read scope, existing `rankKnowledgeEntries`, memory retrieve/search ports and `isVisible`.
- Produces: `VerifiedTaskReadScope`, `VerifiedTaskReadScopeFactory`, `createLayeredKnowledgeRetriever()`, `LayeredRetrievalRequest`, per-call `searchWave` port, `RetrievalTrace`, optional layered paths in KnowledgeBroker and KnowledgeContextProvider.

- [ ] **Step 0: Define one verified authorization envelope before adding a wave port**

Create `verified-task-read-scope.ts`:

```typescript
export interface VerifiedTaskReadScope {
  tenantId: string;
  space: string;
  principalId: string;
  worker: WorkerReplicaRef;
  capabilities: readonly string[];
  lease: Readonly<Pick<TaskLease, "taskId" | "leaseId" | "generation">>;
  grantDigest: string;
  deadlineAt: string;
}

export interface VerifiedTaskReadScopeFactory {
  forTask(input: { lease: TaskLease; work: TaskWorkItem; space: string; worker: WorkerReplicaRef }): VerifiedTaskReadScope;
}

export function createVerifiedTaskReadScopeFactory(deps: {
  grantService: ExecutionGrantService;
  grantForTask(input: { lease: TaskLease; work: TaskWorkItem; space: string; worker: WorkerReplicaRef }): ExecutionGrant;
}): VerifiedTaskReadScopeFactory;
```

`forTask()` immediately verifies signature/deadline and requires the verified tenant, space, principal worker ID and
`memory.read` capability to equal the server-stamped task input. It returns a frozen envelope; request fields cannot
override it. The module keeps a private `WeakSet<object>` brand and exports
`assertVerifiedTaskReadScope(scope, expected, {clock})`; that assertion checks opaque provenance, task/lease generation,
worker binding and `deadlineAt > clock()` but does **not** call `grantService.verify()` again. This is
required because an enabled replay guard may consume a nonce on first verification. Export an internal helper that maps an
already verified Broker grant to the same branded shape without a second verify. Context, Broker and Task 5's
Memory/Skill/state adapters consume this envelope; no surface may manufacture `{tenantId,space}` on its own.
Write `verified-task-read-scope.test.ts` first and cover valid, bad signature, expired, missing capability, tenant/space/
worker/generation mismatch and post-construction mutation. Also create a valid scope, advance the injected clock past its
deadline, and prove every later wave/read fails before the supplied backing-read spy is called. HMAC/replay verification
still happens exactly once; cheap brand/binding/deadline checks happen before every backing read.

- [ ] **Step 1: Make every fixture entry contain a unique searchable token and freeze 12 gold cases**

In `scripts/n28-feasibility-fixture.ts`, change the row content to include its ID:

```typescript
const id = `${prefix}-${String(index + 1).padStart(2, "0")}`;
return {
  id,
  tenantId: "tenant-a",
  kind: index % 4 === 0 ? "domain-method" : "domain-fact",
  anchors,
  status: "official",
  content: `${contentPrefix} token:${id}`,
  meta: { domains, spaceScope: { space: "meta", visibility: "public" } },
};
```

Add these exact gold cases:

```typescript
export const N28_GOLD_QUERIES = [
  { id: "q-primary-1", workerKey: "algebra", text: "token:alg-01", expected: "alg-01", expectedWave: 0 },
  { id: "q-primary-2", workerKey: "algebra", text: "token:alg-20", expected: "alg-20", expectedWave: 0 },
  { id: "q-primary-3", workerKey: "geometry", text: "token:geo-01", expected: "geo-01", expectedWave: 0 },
  { id: "q-primary-4", workerKey: "geometry", text: "token:geo-40", expected: "geo-40", expectedWave: 0 },
  { id: "q-overlap-1", workerKey: "algebra", text: "token:num-01", expected: "num-01", expectedWave: 1 },
  { id: "q-overlap-2", workerKey: "geometry", text: "token:num-10", expected: "num-10", expectedWave: 1 },
  { id: "q-fallback-1", workerKey: "algebra", text: "token:shared-01", expected: "shared-01", expectedWave: 2 },
  { id: "q-fallback-2", workerKey: "geometry", text: "token:shared-08", expected: "shared-08", expectedWave: 2 },
  { id: "q-global-decoy", workerKey: "algebra", text: "bounded global target canonical", expected: "global-only", expectedWave: 3 },
  { id: "q-misbound", workerKey: "algebra", text: "token:geo-39", expected: "geo-39", expectedWave: 3 },
  { id: "q-unclassified-1", workerKey: "algebra", text: "unclassified target", expected: "unclassified-only", expectedWave: 2 },
  { id: "q-unclassified-2", workerKey: "geometry", text: "unclassified target", expected: "unclassified-only", expectedWave: 2 },
] as const;
```

- [ ] **Step 2: Expose query token hit count from the production ranking module**

Write a failing test in the existing knowledge-ranking test file:

```typescript
expect(knowledgeQueryTokenHits({ id: "x", anchors: ["mathematics"], content: "token:alg-01" }, "token:alg-01")).toBe(1);
expect(knowledgeQueryTokenHits({ id: "x", anchors: ["mathematics"], content: "other" }, "token:alg-01")).toBe(0);
```

Export this function from `knowledge-ranking.ts` and make `rankKnowledgeEntries()` call it instead of maintaining a second hit implementation:

```typescript
export function knowledgeQueryTokenHits(entry: RankableKnowledgeEntry, queryText: string | undefined): number {
  return tokenize(queryText).reduce(
    (count, token) => count + (containsToken(entry.content, entry.anchors, token) ? 1 : 0),
    0,
  );
}
```

Run: `npx vitest run test/pth-execution/knowledge-ranking.test.ts`

Expected: PASS after the refactor; existing ranking order is unchanged.

- [ ] **Step 3: Write the failing four-wave gold and retrieval-status tests**

```typescript
import { describe, expect, it } from "vitest";
import { createLayeredKnowledgeRetriever } from "../../src/pth/execution/layered-knowledge-retriever.js";
import { createVerifiedTaskReadScopeFactory, type VerifiedTaskReadScope } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import type { TaskLease, TaskWorkItem } from "../../src/pth/contracts/index.js";
import { buildMemoryDirectorySnapshot, regionEntryIds } from "../../src/pth/execution/memory-directory.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../../src/pth/execution/knowledge-ranking.js";
import {
  N28_GOLD_QUERIES,
  N28_DOMAIN_IDS,
  N28_REGIONS,
  N28_RESPONSIBILITIES,
  N28_WORKERS,
  n28AuthorizedCorpus,
  n28DirectoryInputs,
} from "../../scripts/n28-feasibility-fixture.js";

const grantService = createExecutionGrantService({
  keyProvider: createHmacGrantKeyProvider({ secret: "n28-feasibility-test-secret-0123456789" }),
  clock: () => new Date("2030-01-01T00:00:00.000Z"),
});

describe("layered knowledge retrieval", () => {
  it("recalls all 12 gold targets within the expected wave", async () => {
    for (const query of N28_GOLD_QUERIES) {
      const result = await harness(N28_WORKERS[query.workerKey].workerId).search(query.text, 8);
      expect(result.status).toBe("found");
      expect(result.entries.some((entry) => entry.id === query.expected), query.id).toBe(true);
      const wave = result.trace.waves.find((item) => item.selectedEntryIds.includes(query.expected));
      expect(wave?.wave, query.id).toBe(query.expectedWave);
      expect(result.trace.waves.map((item) => item.wave)).toEqual([0, 1, 2, 3]);
    }
  });

  it("distinguishes a complete no-answer from incomplete and failed retrieval", async () => {
    expect((await harness(N28_WORKERS.algebra.workerId).search("no-such-token", 8)).status).toBe("exhausted-empty");
    expect((await harness(N28_WORKERS.algebra.workerId, { completeForQuery: false }).search("no-such-token", 8)).status).toBe("retrieval-incomplete");
    expect((await harness(N28_WORKERS.algebra.workerId, { failWave: 2 }).search("no-such-token", 8)).status).toBe("retrieval-failed");
  });
});
```

The low-level harness contains only the authorized tenant-a corpus. `verifiedScopeFor()` below uses the real test
`ExecutionGrantService` plus `createVerifiedTaskReadScopeFactory`; it is not a literal authorization object. The full
authorization matrix is tested through real Broker and Context in Step 8. The wave adapter applies Region membership and production query ranking before its
output limit, and explicitly reports completeness:

```typescript
const scopeFactory = createVerifiedTaskReadScopeFactory({
  grantService,
  grantForTask: ({ lease, work, space, worker }) => grantService.issue({
    lease,
    scope: { ...work.scope, principalId: `worker:${worker.workerId}`, roles: [worker.role.roleId], space },
    workspace: lease.workspace,
    language: "ts",
    capabilities: ["memory.read", "memory.query"],
  }),
});

function verifiedScopeFor(workerId: string): VerifiedTaskReadScope {
  const worker = Object.values(N28_WORKERS).find((item) => item.workerId === workerId)!;
  const scope = { tenantId: "tenant-a", principalId: `worker:${workerId}`, roles: [worker.role.roleId], traceId: "trace-n28", space: "meta" };
  const lease: TaskLease = {
    taskId: "task-n28", leaseId: "20000000-0000-4000-8000-000000000001", generation: 1,
    scope, workspace: { tenantId: "tenant-a", workspaceId: "ws-n28", taskId: "task-n28" },
    roleId: worker.role.roleId, deadlineAt: "2030-01-01T00:01:00.000Z",
  };
  const work: TaskWorkItem = { taskId: lease.taskId, scope, title: "n28", text: "n28", tags: [], payload: {}, assignedRole: worker.role.roleId, domains: ["mathematics"] };
  return scopeFactory.forTask({ lease, work, space: "meta", worker });
}

function harness(workerId: string, mode: { completeForQuery?: boolean; failWave?: number } = {}) {
  const corpus = n28AuthorizedCorpus();
  const directoryEntries = n28DirectoryInputs(corpus);
  const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: directoryEntries });
  const retriever = createLayeredKnowledgeRetriever(directory, { knownDomainIds: N28_DOMAIN_IDS, entries: directoryEntries });
  return {
    search: (queryText: string, limit: number) => {
      const authorization = verifiedScopeFor(workerId);
      return retriever.search({
      authorization,
      workerId,
      queryText,
      domains: ["mathematics"],
      limit,
      searchWave: async ({ authorization: waveAuthorization, wave, candidateScope, regionIds, limit: waveLimit }) => {
        if (waveAuthorization !== authorization) throw new Error("authorization identity changed");
        if (mode.failWave === wave) throw new Error("injected wave failure");
        const regionSet = new Set(regionIds.flatMap((regionId) => regionEntryIds(directory, regionId)));
        const inWave = corpus.filter((entry) => candidateScope === "global" || regionSet.has(entry.id));
        const matching = filterKnowledgeEntriesByQueryText(inWave, queryText, { strict: true });
        const ranked = rankKnowledgeEntries(matching, { queryText, domains: ["mathematics"] });
        return {
          entries: ranked.slice(0, waveLimit),
          scannedCount: inWave.length,
          completeForQuery: mode.completeForQuery ?? true,
        };
      },
    });
    },
  };
}
```

- [ ] **Step 4: Run the test and verify the missing retriever failure**

Run: `npx vitest run test/pth-execution/layered-knowledge-retriever.test.ts`

Expected: FAIL because `layered-knowledge-retriever.ts` does not exist.

- [ ] **Step 5: Implement deterministic retrieval planning and strict stop semantics**

Use this public shape:

```typescript
export interface LayeredSearchWaveInput {
  /** Exact branded scope created once for this task; adapters may not reconstruct it. */
  authorization: VerifiedTaskReadScope;
  wave: 0 | 1 | 2 | 3;
  /** Empty regions never mean global; global scope is explicit. */
  candidateScope: "regions" | "global";
  regionIds: readonly string[];
  queryText: string;
  limit: number;
}

export interface LayeredSearchWaveResult<T> {
  entries: readonly T[];
  scannedCount: number;
  /** True only when this adapter applied query + Region predicates before limit. */
  completeForQuery: boolean;
}

export interface LayeredRetrievalRequest<T extends RankableKnowledgeEntry> {
  authorization: VerifiedTaskReadScope;
  workerId: string;
  queryText: string;
  domains: readonly string[];
  limit: number;
  searchWave(input: LayeredSearchWaveInput): Promise<LayeredSearchWaveResult<T>>;
}

export interface LayeredRetrievalResult<T> {
  status: "found" | "exhausted-empty" | "retrieval-incomplete" | "retrieval-failed";
  entries: T[];
  error?: string;
  trace: RetrievalTrace & { waves: Array<RetrievalWaveTrace & { selectedEntryIds: string[] }> };
}

export interface LayeredKnowledgeRetriever<T extends RankableKnowledgeEntry> {
  readonly directory: MemoryDirectorySnapshot;
  entryIdsForRegions(regionIds: readonly string[]): ReadonlySet<string>;
  search(request: LayeredRetrievalRequest<T>): Promise<LayeredRetrievalResult<T>>;
}
```

`createLayeredKnowledgeRetriever(directory, integritySource)` first calls
`assertMemoryDirectorySnapshotIntegrity(directory, integritySource)` and refuses a forged epoch/revision/content/index hash
or invalid primary owner before exposing a search method. The feasibility assembly must retain the frozen
`DirectoryEntryInput[]` for this check; callers cannot assert a snapshot valid by fiat.

Reject unless `request.workerId === request.authorization.worker.workerId` and the Directory tenant equals
`request.authorization.tenantId`. Build Region waves from `responsibilitiesForWorker(directory, workerId)`, sorted by
`kind`, `priority`, then Region ID:

```typescript
const primary = ids("primary");
const overlap = ids("overlap");
const fallback = [...new Set([...ids("fallback"), "region:unclassified"])].sort();
const waves = [
  { wave: 0 as const, candidateScope: "regions" as const, regionIds: primary },
  { wave: 1 as const, candidateScope: "regions" as const, regionIds: overlap },
  { wave: 2 as const, candidateScope: "regions" as const, regionIds: fallback },
  { wave: 3 as const, candidateScope: "global" as const, regionIds: [] },
];
```

For each of the four waves, always pass the exact `request.authorization` object to `searchWave` and use a per-wave output
limit of `Math.max(request.limit * 2, 8)` capped at 20; merge by entry ID and remember the first wave that returned each ID.
The adapter contract requires `filterKnowledgeEntriesByQueryText(...,{strict:true})`, Region filtering and query-sensitive
ranking to happen before this limit. Record `scannedCount`, but never expose more than 20 candidates from one wave to the
retriever. This validates a bounded candidate interface, not a bounded database scan; the report must state that real
indexed PG search remains outside this feasibility slice.
An empty Region wave returns an empty complete result; only `candidateScope="global"` may scan globally.

After all waves, rank the merged set once with `rankKnowledgeEntries`. Return `found` only when at least one selected result has `knowledgeQueryTokenHits(entry, queryText) > 0`; return `exhausted-empty` only when every attempted wave says `completeForQuery=true` and no hit exists. Any incomplete wave with no final hit returns `retrieval-incomplete`; any thrown wave error returns `retrieval-failed` with an empty result and trace. A no-token-hit result must never inherit the current production filter's “return everything” fallback.

Return at most `request.limit` entries and a trace containing all four waves, candidate/scanned count, completeness, first-seen selected IDs, fallback reason, and omitted counts. Add a mutation test where the algebra primary Region contains the local decoy text but the more relevant target is in Wave 3; the target must still win.

- [ ] **Step 6: Wire the optional path into KnowledgeBroker without moving authorization**

Add `layeredRetriever?: LayeredKnowledgeRetriever<KnowledgeMemoryEntry>` and a `layeredSearchWave` port to
`KnowledgeBrokerDeps`. In the `search` branch, map the already verified grant to `VerifiedTaskReadScope`; use the layered
path only when both are injected and the Directory tenant/worker equal that envelope. The per-wave callback receives the
exact same verified envelope—not caller tenant/space strings—plus Region entry IDs, query and limit. It rechecks the
branded scope's deadline and lease generation without replaying HMAC verification, then applies tenant +
`status=official` + `deps.isVisible` + Region IDs + strict query filtering/ranking before returning at most the requested limit
and a `completeForQuery` flag.

Refactor `KnowledgeBroker` so public `query({grant,...})` verifies exactly once and delegates to a narrow
`queryVerified(authorization, requestWithoutGrant)` method. `queryVerified` first calls
`assertVerifiedTaskReadScope()` with the current clock and never replays signature verification. Authorized task adapters call only this internal
method with the task's single envelope; external callers keep using public `query`.

For Waves 0–2, compute the allowed composite entry refs from the retriever's Directory Snapshot and pass those IDs into
the port before its limit. Wave 3 passes no Region IDs and therefore performs a bounded global query. Do not retrieve an
arbitrary top 20 and intersect afterward. The feasibility adapter may full-scan the frozen 100-row in-memory corpus, but
the interface and trace must expose that scanned count honestly.

Return `retrievalTrace` on `KnowledgeResult`:

```typescript
return {
  ok: true,
  entries: layered.entries,
  retrievalTrace: layered.trace,
  queryFingerprint: computeKnowledgeQueryFingerprint({
    tenantId,
    space,
    roleId: grant.scope.roles[0] ?? "knowledge-search",
    workerId: grant.scope.principalId.startsWith("worker:") ? grant.scope.principalId.slice("worker:".length) : undefined,
    domains,
    title: request.queryText ?? "",
    text: [...kinds].sort().join("\n"),
    catalogVersion: layered.trace.directorySnapshotId,
  }),
};
```

Extend `KnowledgeContextInput`/fingerprinting with optional `workerId`; when absent, preserve the old fingerprint byte-for-byte.
When present, append it as a distinct component after `roleId`. Never put a worker principal into the `roleId` field. The old
search branch remains unchanged when no layered retriever is injected.

- [ ] **Step 7: Wire the same retriever into KnowledgeContextProvider**

Add optional `workerId` and `authorization?: VerifiedTaskReadScope` to `KnowledgeContextInput`, plus optional
`layeredRetriever` and the same envelope-consuming `layeredSearchWave` port to provider deps. The layered path requires the
verified envelope and calls the retriever through that port; it does not implement a second visibility predicate. Build
`KnowledgeContextEntry[]` only from `status="found"` entries and expose `retrievalTrace` plus retrieval status on the
context. `retrieval-failed` is an operational degradation signal, while `exhausted-empty` is a legitimate no-answer. When
dependencies are absent in mode `off`, preserve the current path exactly.

In Task 4, add optional `replica?: WorkerReplicaRef` and `verifiedReadScopeFactory?: VerifiedTaskReadScopeFactory` to
`AgentTaskRunnerDeps`. Build one verified scope per task and pass it plus `this.deps.replica?.workerId` to
`KnowledgeContextProvider.build()`. Invalid/expired/missing-capability scope creation rejects before Context invokes its
wave port. Task 6 later reuses the same scope for the working-set provider; it must not issue a second grant.

- [ ] **Step 8: Add broker and context regression assertions**

Extend `knowledge-broker.test.ts` to issue a real signed grant with
`principalId=worker:10000000-0000-4000-8000-000000000011`, inject the real layered retriever, and assert:

```typescript
expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.entries?.some((entry) => (entry as { id: string }).id === "global-only")).toBe(true);
  expect(result.retrievalTrace?.globalFallback).toBe(true);
  expect(result.entries?.some((entry) => String((entry as { id: string }).id).startsWith("trap-"))).toBe(false);
}
```

Extend `knowledge-context.test.ts` with the same query and assert its `retrievalTrace.directorySnapshotId` and selected IDs equal the broker result for the same worker/query/snapshot.

Use `setSpaceLookup()` and the production `isVisible()` from `@away_from/pth-memory`, then run the same wave port over
`n28TrapCorpus()`. Verify public ancestor visibility from `dev`, private same-space visibility only from `dev`, public child
invisibility from its parent, other private space invisibility, tenant-b invisibility, and draft/archived invisibility. Add
invalid-signature, expired-grant and missing-`memory.read` cases and assert `layeredSearchWave` is called zero times. Exercise
Broker `search/get/query/retrieve` here. Budgeted `state.recallFunctions/recallInsights` adapters do not exist until Task 5;
their authorization/budget bypass matrix belongs to Task 5 Step 6 and the final vertical gate.

- [ ] **Step 9: Run the retrieval suite**

Run: `npx vitest run test/pth-execution/knowledge-ranking.test.ts test/pth-execution/memory-directory.test.ts test/pth-execution/verified-task-read-scope.test.ts test/pth-execution/layered-knowledge-retriever.test.ts test/pth-execution/knowledge-broker.test.ts test/pth-runner/knowledge-context.test.ts`

Expected: PASS; 12/12 gold targets are found, the decoy cannot cause early stop, and the full signed-grant visibility matrix matches production `isVisible` semantics.

- [ ] **Step 10: Commit layered retrieval**

```bash
git add src/pth/execution/authorization/verified-task-read-scope.ts src/pth/execution/layered-knowledge-retriever.ts src/pth/execution/knowledge-ranking.ts src/pth/execution/knowledge-broker.ts src/pth/runner/knowledge-context.ts src/pth/runner/agent-task-runner.ts scripts/n28-feasibility-fixture.ts test/pth-execution/verified-task-read-scope.test.ts test/pth-execution/layered-knowledge-retriever.test.ts test/pth-execution/knowledge-broker.test.ts test/pth-runner/knowledge-context.test.ts
git commit -m "feat(pth): add layered memory responsibility retrieval"
```

---

### Task 5: Enforce One Task-Scoped Cognitive Budget Across Memory, Skill and Tool Surfaces

**Files:**
- Create: `src/pth/kernel/execution/cognitive-budget.ts`
- Create: `src/pth/runner/authorized-task-reads.ts`
- Create: `src/pth/runner/cognitive-working-set.ts`
- Modify: `src/pth/runner/index.ts`
- Create: `test/pth-kernel-execution/cognitive-budget.test.ts`
- Create: `test/pth-runner/authorized-task-reads.test.ts`
- Create: `test/pth-runner/cognitive-working-set.test.ts`

**Interfaces:**
- Consumes: exact `CognitiveBudget`, WorkerReplicaRef, layered retrieval output, Skill summaries/content and tool schema names.
- Produces: `CognitiveBudgetLedger`, `CognitiveBudgetExceededError`, `createTaskWorkingSetPolicy()`, `createBudgetedTaskCapabilities()`, deterministic `snapshot()`.

- [ ] **Step 1: Write failing ledger tests for all six task limits**

```typescript
import { describe, expect, it } from "vitest";
import { CognitiveBudgetLedger } from "../../src/pth/kernel/execution/cognitive-budget.js";
import { N28_FEASIBILITY_BUDGET, checkResponsibilityCapacity } from "../../src/pth/contracts/index.js";
import { N28_WORKERS } from "../../scripts/n28-feasibility-fixture.js";

describe("CognitiveBudgetLedger", () => {
  it("counts the initial context and later memory reads in the same budget", () => {
    const ledger = new CognitiveBudgetLedger(N28_FEASIBILITY_BUDGET.task);
    expect(ledger.admitMemory([{ id: "m1", chars: 2000 }, { id: "m2", chars: 2000 }]).accepted.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(ledger.admitMemory([{ id: "m3", chars: 200 }]).accepted).toEqual([]);
    expect(ledger.snapshot().usage).toMatchObject({ memoryEntries: 2, memoryChars: 4000 });
  });

  it("charges only the positive representation delta when a summary expands to full text", () => {
    const ledger = new CognitiveBudgetLedger({ ...N28_FEASIBILITY_BUDGET.task, maxMemoryChars: 500 });
    expect(ledger.admitMemory([{ id: "m1", chars: 200 }]).accepted).toHaveLength(1);
    expect(ledger.admitMemory([{ id: "m1", chars: 450 }]).accepted).toHaveLength(1);
    expect(ledger.snapshot().usage.memoryChars).toBe(450);
    expect(ledger.admitMemory([{ id: "m1", chars: 501 }]).accepted).toEqual([]);
    expect(ledger.snapshot().usage.memoryChars).toBe(450);
  });

  it("counts pinned tools and rejects a pinned face that already exceeds the limit", () => {
    const ledger = new CognitiveBudgetLedger({ ...N28_FEASIBILITY_BUDGET.task, maxTools: 2 });
    expect(() => ledger.freezeTools(["done", "ts_run", "asp_cd"], [])).toThrow(/pinned tools exceed/);
  });

  it("allows only indexed skills and caps active skill count and characters", () => {
    const ledger = new CognitiveBudgetLedger({ ...N28_FEASIBILITY_BUDGET.task, maxActiveSkills: 1, maxSkillChars: 10 });
    ledger.freezeSkillIndex([{ id: "skill:a", chars: 5 }, { id: "skill:b", chars: 5 }]);
    expect(ledger.activateSkill("skill:a", 10)).toBe(true);
    expect(ledger.activateSkill("skill:b", 1)).toBe(false);
    expect(() => ledger.activateSkill("skill:outside", 1)).toThrow(/not in frozen skill index/);
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing ledger failure**

Run: `npx vitest run test/pth-kernel-execution/cognitive-budget.test.ts`

Expected: FAIL because `cognitive-budget.ts` does not exist.

- [ ] **Step 3: Implement the monotonic task ledger**

Implement a class with these exact public methods:

```typescript
export class CognitiveBudgetLedger {
  constructor(readonly budget: CognitiveBudget) {}

  admitMemory<T extends { id: string; chars: number }>(items: readonly T[]): { accepted: T[]; omitted: T[] };
  freezeSkillIndex(items: readonly { id: string; chars: number }[]): readonly string[];
  activateSkill(id: string, chars: number): boolean;
  freezeTools(pinned: readonly string[], candidates: readonly string[]): readonly string[];
  snapshot(): {
    usage: {
      memoryEntries: number;
      memoryChars: number;
      skillIndexEntries: number;
      activeSkills: number;
      skillChars: number;
      tools: number;
    };
    memoryEntryIds: string[];
    skillIndexIds: string[];
    activeSkillIds: string[];
    toolNames: string[];
    omitted: Record<string, number>;
  };
}
```

All input IDs are deduplicated; providers sort candidates by score before entering the ledger and ties use ID/name order.
The ledger keeps `chargedCharsByMemoryId` and `chargedCharsBySkillId`. `freezeSkillIndex` charges the exact exposed
`SkillSummary` projection while enforcing `maxSkillIndexEntries`; `activateSkill` charges only the positive delta from that
summary to the exposed full `MemoryEntry`. Re-reading the same representation is free, but
expanding a 200-character summary to a 450-character full entry charges the positive 250-character delta; an expansion that
cannot fit is omitted without mutating prior usage. Memory admission stops before either entry or char limit is exceeded.
`freezeTools` uses canonical Tool schema names, deduplicates protocol-pinned tools in caller order, fails if pinned count
exceeds `maxTools`, then appends sorted candidate schemas until the limit.

Add `canonicalExposureChars(value)` beside the ledger: project only the fields actually returned/injected, sort object keys,
serialize as UTF-8 JSON and count bytes. Every caller passes that full projected size—never just `content` or `source`.
This includes metadata-only query rows, evidence/meta injected with a Context summary, recalled function `spec`, recalled
insight objects and Skill `MemoryEntry` fields.

- [ ] **Step 4: Write the 1,000-input determinism and hard-limit test**

```typescript
it("never exceeds any axis across 1000 deterministic generated surfaces", () => {
  for (let seed = 0; seed < 1000; seed += 1) {
    const run = (reverse = false) => {
      const ledger = new CognitiveBudgetLedger(N28_FEASIBILITY_BUDGET.task);
    const generated = Array.from({ length: 1 + (seed % 30) }, (_, index) => ({
      id: `m-${(seed * 17 + index * 13) % 97}`,
      chars: 1 + ((seed * 31 + index * 19) % 1400),
    }));
      const source = reverse ? [...generated].reverse() : generated;
      const memory = [...source].sort((a, b) => a.id.localeCompare(b.id));
      ledger.admitMemory(memory);
      ledger.freezeSkillIndex(Array.from({ length: 20 }, (_, index) => ({ id: `skill:${(seed + index * 7) % 31}`, chars: 20 + index })));
      for (let index = 0; index < 12; index += 1) {
        const id = ledger.snapshot().skillIndexIds[index];
        if (id) ledger.activateSkill(id, 100 + ((seed + index) % 900));
      }
      ledger.freezeTools(["done", "ts_run"], Array.from({ length: 30 }, (_, index) => `tool_${(seed + index * 11) % 41}`));
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
    if (capacity.ok) {
      expect(capacity.usage.regions).toBeLessThanOrEqual(3);
      expect(capacity.usage.primaryWeight).toBeLessThanOrEqual(80);
      expect(capacity.usage.secondaryWeight).toBeLessThanOrEqual(40);
    }
  }
});
```

- [ ] **Step 5: Define the only grant-bound read factory, then build the task policy and budgeted facade**

Create `src/pth/runner/authorized-task-reads.ts` and export these contracts before any facade wiring:

```typescript
export interface AuthorizedTaskReads {
  retrieveMemory(opts: unknown): Promise<Array<{ id: string } & Record<string, unknown>>>;
  getMemory(id: string): Promise<({ id: string } & Record<string, unknown>) | undefined>;
  queryMemory(sql: string): Promise<Array<{ id: string } & Record<string, unknown>>>;
  recallFunctions(anchors: string[], opts?: { limit?: number }): Promise<Array<{ id: string; key: string; source: string; spec: unknown }>>;
  recallInsights(anchors: string[], opts?: { limit?: number }): Promise<Array<{ id: string; content: string }>>;
  listSkills(): Promise<import("@away_from/pth-memory").SkillSummary[]>;
  getSkill(id: string): Promise<import("@away_from/pth-memory").MemoryEntry | undefined>;
}

export interface AuthorizedTaskReadFactory {
  forTask(input: {
    lease: TaskLease;
    work: TaskWorkItem;
    space: string;
    worker: WorkerReplicaRef;
    authorization: VerifiedTaskReadScope;
  }): AuthorizedTaskReads;
}

export function createAuthorizedTaskReadFactory(deps: {
  broker: Pick<KnowledgeBroker, "queryVerified">;
  skills: {
    forScope(authorization: VerifiedTaskReadScope): {
      list(): Promise<import("@away_from/pth-memory").SkillSummary[]>;
      get(id: string): Promise<import("@away_from/pth-memory").MemoryEntry | undefined>;
    };
  };
  state: {
    forScope(authorization: VerifiedTaskReadScope): Pick<AuthorizedTaskReads, "recallFunctions" | "recallInsights">;
  };
}): AuthorizedTaskReadFactory;
```

The production factory calls `assertVerifiedTaskReadScope()` once to compare the opaque envelope to every server-stamped
task field; it never calls `ExecutionGrantService.verify()` again. It then closes Broker `queryVerified`, Skill and state
ports over that one scope. The explicit `forScope()` factories prohibit task identity from living in mutable globals or
session refs when concurrent tasks run. Its scope comes
only from `work.scope`, signed grant, lease and worker; request arguments cannot replace tenant, space, status or principal.
Invalid/expired/missing-capability grant fails before any backing port call. Skill list/get must enforce the same
tenant/space/official boundary before budgeting. Raw memory/store functions are not valid factory deps.

In `cognitive-working-set.ts`, expose:

```typescript
export function createTaskWorkingSetPolicy(input: {
  taskId: string;
  worker: WorkerReplicaRef;
  directorySnapshotId: string;
  budget: CognitiveBudget;
  skillIndexIds: readonly string[];
  pinnedToolNames: readonly string[];
  candidateToolNames: readonly string[];
}): { policy: TaskWorkingSetPolicy; ledger: CognitiveBudgetLedger };

export function createBudgetedTaskCapabilities(
  base: Record<string, unknown>,
  policy: TaskWorkingSetPolicy,
  ledger: CognitiveBudgetLedger,
  adapters: AuthorizedTaskReads,
): Record<string, unknown>;
```

The capability wrapper must preserve unrelated capabilities and wrap these paths:

```typescript
memory.retrieve       -> adapters.retrieveMemory (layered + authorized) -> admit canonical projected rows -> return accepted rows
memory.get            -> adapters.getMemory (tenant/space/official checked) -> admit positive canonical representation delta -> return row or throw cognitive-budget-exhausted
memory.query          -> adapters.queryMemory (N27 secured query) -> require id -> charge the entire returned row even when content is absent -> return accepted rows
state.recallFunctions -> adapters.recallFunctions -> charge full `{key,source,spec}` projections under stable IDs -> strip IDs and preserve the current public shape
state.recallInsights  -> adapters.recallInsights -> charge full returned projections under stable IDs -> return the current public shape
skills.list           -> adapters.listSkills -> filter real SkillSummary[] by canonical policy IDs, charge the exposed index projections, preserve objects and frozen order
skills.get            -> canonicalize `foo`/`skill:foo`, require ID in frozen index -> adapters.getSkill -> charge the complete exposed MemoryEntry projection -> return original shape or throw cognitive-budget-exhausted
```

The adapter is constructed from the same server-derived task tenant/space and N27-accepted read ports; request arguments
cannot override scope. It rejects non-official `get` results even if the legacy base facade would return them. Do not wrap
write, maintain, review, promotion or task-control functions. Preserve `this` binding by invoking saved functions with
`.call(originalObject, ...)` where a base method remains involved.

The provider supplies `retrieveMemory` by calling the same `LayeredKnowledgeRetriever` used by KnowledgeContext and
KnowledgeBroker. It must not pass raw base memory methods as any read adapter. `memory.get` remains a known-ID authorized
expansion and therefore bypasses Region priority but never tenant/space/official checks or the shared ledger.

- [ ] **Step 6: Write facade bypass tests**

Use the real factory contract with secured fake backing ports that return 30 retrieve rows, 30 query rows, full entries after
short summaries, recall functions/insights, and exact production `SkillSummary[]` / `MemoryEntry | undefined` shapes. Call every read path in
sequence through the wrapper, then assert the combined ledger still respects all limits, summary→full charges only the
positive canonical delta, public API shapes are unchanged, non-official get is rejected, and a Skill outside the frozen
index is rejected. Include huge metadata-only query, huge function spec and huge Skill meta cases and prove each is charged
or omitted before exposure. Run invalid/expired/missing-capability grant cases across memory, recall and Skill surfaces and
assert every backing-port invocation count stays zero.

Run: `npx vitest run test/pth-kernel-execution/cognitive-budget.test.ts test/pth-runner/authorized-task-reads.test.ts test/pth-runner/cognitive-working-set.test.ts`

Expected: PASS; the test must fail if either memory method uses a separate ledger.

- [ ] **Step 7: Export the working-set API and commit**

Add to `src/pth/runner/index.ts`:

```typescript
export * from "./cognitive-working-set.js";
```

```bash
git add src/pth/kernel/execution/cognitive-budget.ts src/pth/runner/authorized-task-reads.ts src/pth/runner/cognitive-working-set.ts src/pth/runner/index.ts test/pth-kernel-execution/cognitive-budget.test.ts test/pth-runner/authorized-task-reads.test.ts test/pth-runner/cognitive-working-set.test.ts
git commit -m "feat(pth): enforce task cognitive working set budgets"
```

---

### Task 6: Make the Actual Agent Prompt, Skill Facade and Tool Executor Obey the Working Set

**Files:**
- Modify: `src/pth/kernel/execution/agent-loop-types.ts`
- Modify: `src/pth/kernel/execution/agent-loop.ts`
- Modify: `src/pth/kernel/execution/agent-loop-prompt.ts`
- Modify: `src/pth/kernel/execution/agent-loop-guards.ts`
- Modify: `src/pth/runner/cognitive-working-set.ts`
- Modify: `src/pth/runner/authorized-task-reads.ts`
- Modify: `src/pth/runner/agent-task-runner.ts`
- Modify: `src/pth/bootstrap/task-loop-types.ts`
- Modify: `src/pth/bootstrap/task-loop.ts`
- Modify: `src/pth/bootstrap/worker-slot-runtime.ts`
- Modify: `src/pth/bootstrap/batch-runtime-assembly.ts`
- Modify: `src/pth/bootstrap/batch-process.ts`
- Create: `scripts/n28-feasibility-harness.ts`
- Modify: `test/pth-runner/agent-task-runner.test.ts`
- Modify: `test/pth-kernel-execution/agent-loop.test.ts`
- Modify: `test/pth-kernel-execution/prompt-docs.test.ts`
- Create: `test/pth-kernel-execution/agent-loop-working-set.integration.test.ts`
- Create: `test/pth-runner/cognitive-responsibility.vertical.test.ts`

**Interfaces:**
- Consumes: worker-stamped TaskLoop, layered KnowledgeContext, ToolReg snapshot, `TaskWorkingSetPolicy`, `CognitiveBudgetLedger` and budgeted capabilities.
- Produces: optional `CognitiveWorkingSetProvider`, agent-loop `toolAllowlist`, execution-time hidden-tool rejection, final working-set snapshot in TaskOutcome usage/trace.

- [ ] **Step 1: Add a failing agent test that captures the real LLM surface**

In the new integration test (which must not mock `runAgentTask`), create a deterministic fake LLM that records `messages`
and `options.tools`. In ASP mode it attempts hidden `dev_run`, moves to `ts`, uses `ts_run` to exercise budgeted
`memory.retrieve`, `skills.list/get` and `state.recall*`, returns to `meta`, then calls `done`:

```typescript
const seen: Array<{ messages: unknown; tools: string[] }> = [];
let call = 0;
const scriptedCalls = [
  { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c2", name: "asp_cd", arguments: { space: "ts" } }] },
  { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c3", name: "ts_run", arguments: { code: "const ms = await memory.retrieve({anchors:['math']}); const ss = await skills.list(); if (ss[0]) await skills.get(ss[0].id); await state.recallInsights(['math']); return {m:ms.length,s:ss.length};" } }] },
  { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c4", name: "asp_cd", arguments: { space: "meta" } }] },
  { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c5", name: "done", arguments: { result: { ok: true } } }] },
];
const llm = {
  complete: async (messages: unknown, options: { tools?: Array<{ name: string }> }) => {
    seen.push({ messages, tools: (options.tools ?? []).map((tool) => tool.name) });
    call += 1;
    if (call === 1) {
      return { content: "", model: "stub", usage: {}, toolCalls: [{ id: "c1", name: "dev_run", arguments: { path: "hidden" } }] };
    }
    // Subsequent deterministic calls: asp_cd(ts) -> ts_run -> asp_cd(meta) -> done.
    return scriptedCalls[call - 2]!;
  },
};
```

Run through `AgentTaskRunner` with a frozen union that includes protocol-pinned `done`, ASP ambient tools, `ts_run`, and
one ToolReg schema, plus a Skill index containing four IDs. `memory.retrieve` is a capability inside `ts_run`, not an LLM
Tool schema. For every LLM round, assert the visible schema set equals `frozen union ∩ current ASP space face`; also assert:

```typescript
expect(trace).toContainEqual(expect.objectContaining({ type: "tool-result", tool: "dev_run", ok: false }));
expect(baseDevRun).not.toHaveBeenCalled();
expect(seen.some((round) => round.tools.includes("dev_run"))).toBe(false);
const systemPrompts = seen.flatMap((round) => round.messages as Array<{ role?: string; content?: unknown }>).filter((message) => message.role === "system");
expect(JSON.stringify(systemPrompts)).not.toContain("dev.run");
expect(finalWorkingSet.toolNames.length).toBeLessThanOrEqual(16);
expect(outcome.status).toBe("completed");
```

- [ ] **Step 2: Add the tool allowlist to the agent-loop contract**

Add to `AgentLoopOptions`:

```typescript
/** Frozen task tool face; schema exposure and execution authorization use the same set. */
toolAllowlist?: readonly string[];
```

In `agent-loop.ts`, canonicalize allowlist names with the existing `normalizeToolName()` and apply it in all three places:

1. Filter the combined static + ToolReg schema list before every LLM call.
2. Pass the frozen task union into `buildAgentSystemPrompt()`/`toolsDescription()` so the prompt never names a Tool outside the Working Set. Replace fixed tool inventories inside `PTH_WORKER_SYSTEM` with text derived from that same union; do not leave `dev.run` or another hidden name in worldview/examples. ASP prose explains that each round exposes only the current-space subset. Protocol prose may describe `done` only because `done` is explicitly pinned and budgeted.
3. Before resolving `AGENT_TOOLS`, capability-action wrappers or ToolReg executors, reject a tool whose canonical name is absent.

Use this rejection body so tests can assert it:

```typescript
const denied = `tool ${tool} is outside the frozen Task Working Set`;
messages.push({ role: "tool", toolCallId: toolCallId ?? `tc-${steps + 1}`, toolName: tool, content: denied });
input.onStep?.({ n: steps + 1, tool, durationMs: 0, ok: false, args: JSON.stringify(args).slice(0, 300) });
input.onTrace?.({ type: "tool-result", step: steps + 1, tool, ok: false, durationMs: 0, resultPreview: denied });
return undefined;
```

The allowlist check must happen before all executor lookup and must not rely on the model respecting advertised schemas.
`toolAllowlist` is the frozen task union; each ASP round advertises only its intersection with `toolsForSpace()`. The union
always counts protocol-pinned `done`, even though `done` is available only in `meta`. Update the role-document query and
environment prelude in `agent-loop-prompt.ts` / `agent-loop-guards.ts` to select `id, ... , meta`; metadata-only rows with an
ID are legal, but the complete exposed row projection is charged even when `content` is absent.

- [ ] **Step 3: Define and implement the provider consumed by AgentTaskRunner**

Add to `cognitive-working-set.ts`:

```typescript
export interface CognitiveWorkingSetProvider {
  build(input: {
    taskId: string;
    worker: WorkerReplicaRef;
    roleId: string;
    loadPolicyRef?: string;
    tenantId: string;
    space: string;
    domains: readonly string[];
    title: string;
    text: string;
    catalogVersion: string;
    baseCaps: Record<string, unknown>;
    staticToolNames: readonly string[];
    registryToolNames: readonly string[];
    authorizedReads: AuthorizedTaskReads;
  }): Promise<{
    policy: TaskWorkingSetPolicy;
    ledger: CognitiveBudgetLedger;
    capabilities: Record<string, unknown>;
  }>;
}

export function createCognitiveWorkingSetProvider(deps: {
  budget: WorkerLoadEnvelope;
  resolveRoleBudget?: (loadPolicyRef: string) => Partial<CognitiveBudget> | undefined;
  layeredRetriever: LayeredKnowledgeRetriever<KnowledgeMemoryEntry>;
  searchWave: (scope: {
    worker: WorkerReplicaRef;
    tenantId: string;
    space: string;
    queryText: string;
    wave: 0 | 1 | 2 | 3;
    scope: "regions" | "global";
    regionIds: readonly string[];
    limit: number;
  }) => Promise<LayeredSearchWaveResult<KnowledgeMemoryEntry>>;
}): CognitiveWorkingSetProvider;
```

The feasibility provider resolves the optional Role load policy and takes the minimum of each declared axis and the system
budget. If `loadPolicyRef` is present but no resolver or matching policy exists, it fails before any read or LLM call.
It loads the real `SkillSummary[]` from `authorizedReads.listSkills`, canonicalizes each summary ID, converts each summary
to `${id}\n${anchor}\n${whenToUse}\n${effect}`, scores that text with `knowledgeQueryTokenHits`, sorts by hit count descending
then ID, and freezes at most eight summaries while charging their complete exposed projections. It canonicalizes actual Tool schema names to underscore form, counts protocol-pinned
`done` plus the ASP ambient union first, and returns
`createBudgetedTaskCapabilities(baseCaps, policy, ledger, input.authorizedReads)`. No raw base read function may be passed
as `authorizedReads`.

- [ ] **Step 4: Wire the provider into the runner without changing the default path**

`replica` was added in Task 4. Add optional `cognitiveWorkingSetProvider`, `cognitiveResponsibilityMode` and
`authorizedReads?: AuthorizedTaskReadFactory` to `AgentTaskRunnerDeps`. When mode is `feasibility`, Directory/provider/
replica/verified-scope factory/read factory and the single grant-bound result are all mandatory; any absence returns a structured rejected outcome before
the first LLM call. It must never silently fall back to raw base reads. Mode `off` retains the old optional path. Export
`taskToolUnion()` from `agent-loop-prompt.ts`: with ASP enabled it snapshots `meta` plus all currently registered spaces,
unions `toolsForSpace(space, role.actionTools)`, canonicalizes names, and always includes protocol-pinned `done`; without
ASP it uses `toolsToSchema(...,{asp:false})` plus `done`.

Hoist ToolReg loading out of the `runAgentTask()` argument so the provider and agent loop consume the same frozen snapshot:

```typescript
const toolRegistry = this.deps.toolRegStore
  ? await loadToolRegSnapshot(this.deps.toolRegStore, { tenantId: work.scope.tenantId })
  : undefined;
```

Before Context or provider construction, call `verifiedReadScopeFactory.forTask({lease,work,space,worker})` exactly once.
Pass that same frozen `authorization` to `KnowledgeContextProvider.build()` and to
`authorizedReads.forTask()`; compare object identity in the vertical test so no surface reissues or weakens the grant.

```typescript
const cognitive = this.deps.replica && this.deps.cognitiveWorkingSetProvider && this.deps.authorizedReads
  ? await this.deps.cognitiveWorkingSetProvider.build({
      taskId: lease.taskId,
      worker: this.deps.replica,
      roleId: role.id,
      loadPolicyRef: role.loadPolicyRef,
      tenantId: work.scope.tenantId,
      space,
      domains: work.domains ?? [],
      title: work.title,
      text: work.text,
      catalogVersion: work.domainBinding?.catalogVersion ?? "",
      baseCaps: caps,
      staticToolNames: ["done", ...taskToolUnion(role.actionTools, { asp: config.aspMode }).map((tool) => tool.name)],
      registryToolNames: toolRegistry ? visibleRegistryTools(toolRegistry, role.id).map((tool) => tool.name.replace(/\./g, "_")) : [],
      authorizedReads: this.deps.authorizedReads.forTask({ lease, work, space, worker: this.deps.replica, authorization }),
    })
  : undefined;
const taskCaps = cognitive?.capabilities ?? caps;
```

Use `taskCaps` for `runAgentTask.caps` and capability injection; pass `cognitive?.policy.toolNames` as `toolAllowlist`. After KnowledgeContext is built, debit its selected entries into the same ledger before the first LLM call. If initial context alone cannot fit, truncate it according to the ledger and update `omitted.reason="cognitive-budget"`.
In feasibility mode, a Context status of `retrieval-failed` or `retrieval-incomplete` produces a structured rejected outcome
and H3 evidence; it must not enter the legacy “warn + original text” degradation branch. Mode `off` keeps the existing
non-blocking degradation behavior.

Use `canonicalExposureChars()` on the exact Context entry projection inserted into the prompt—including id, summary,
evidence and exposed meta—and retain only admitted IDs:

```typescript
const admitted = cognitive?.ledger.admitMemory(
  knowledgeContext.entries.map((entry) => ({ id: entry.entryId, chars: canonicalExposureChars(contextPromptProjection(entry)) })),
);
if (admitted) {
  const allowed = new Set(admitted.accepted.map((entry) => entry.id));
  knowledgeContext = {
    ...knowledgeContext,
    entries: knowledgeContext.entries.filter((entry) => allowed.has(entry.entryId)),
    omitted: {
      count: knowledgeContext.omitted.count + admitted.omitted.length,
      reason: admitted.omitted.length > 0 ? "cognitive-budget" : knowledgeContext.omitted.reason,
    },
  };
}
```

Pass the hoisted `toolRegistry` variable into `runAgentTask`; remove the previous inline second load so the task cannot
observe different registry versions during policy construction and execution.

On completion, expose numeric usage in `TaskOutcome.usage` using keys `cognitive.memoryEntries`, `cognitive.memoryChars`, `cognitive.skillIndexEntries`, `cognitive.activeSkills`, `cognitive.skillChars`, `cognitive.tools`.
Extend `AgentTraceEvent` with `type:"cognitive-working-set"` carrying the immutable policy/snapshot IDs, exact admitted ID/name
sets, usage and omitted counts (no entry bodies or Skill content). Emit once before the first LLM call and once at finish.
H6 compares the final trace snapshot—not a separately recomputed report—to the observed prompt/facades/tool schemas.

- [ ] **Step 5: Pass replica and provider through TaskLoop and batch assembly**

Add optional `cognitiveWorkingSetProvider`, `authorizedReads` and the mode to `TaskLoopDeps`, pass
`this.deps.replica?.ref` and these dependencies into `AgentTaskRunner`, and construct the feasibility provider in
`batch-process.ts` when mode is `feasibility`. Missing Directory or read factory is a startup/first-task error, not a reason
to omit the provider. Mode `off` remains on the old retrieval/capability behavior.

Add this optional dependency to `RunBatchProcessDeps`; the normal CLI entry leaves it undefined:

```typescript
memoryDirectory?: import("../execution/index.js").MemoryDirectorySnapshot;
authorizedTaskReadFactory?: import("../runner/index.js").AuthorizedTaskReadFactory;
```

Do **not** call the long-running, PG-dependent `runBatchProcess()` from the in-memory gate. Instead,
`scripts/n28-feasibility-harness.ts` must call `assembleBatchRuntime()` and `runBatchHost({maxIterations: ...})` with
in-memory repository/store adapters. This keeps the branch finite and PG-free while executing the exact production
composition for slot lifecycle, heartbeat/control, identity, TaskLoop, grant, Context, Broker and agent code.
`runBatchProcess()` calls the same exports in continuous mode; no evaluation-only composition or control reducer is permitted.

- [ ] **Step 6: Build the vertical integration test**

Create `scripts/n28-feasibility-harness.ts` as the single public assembly used by this vertical test and Task 7's CLI. The test must use:

- all four fixture `WorkerReplica` objects with role `researcher`, so every Directory primary owner is live; H1 focuses on
  the algebra/geometry pair;
- one immutable directory with algebra/geometry primary and numerical overlap responsibilities;
- the real layered retriever;
- the real `createKnowledgeContextProvider()`;
- production `assembleBatchRuntime` + finite `runBatchHost`, its `WorkerSlotRuntime`, real TaskLoop/archive wrapper,
  `AgentTaskRunner` and `runAgentTask()`;
- the real budgeted capability wrapper;
- a deterministic fake LLM only for model output.

Execute an algebra query on the algebra replica, a geometry query on the geometry replica, and a global-only query on the
algebra replica. Store observations per task ID (not one mutable value per worker). Assert:

```typescript
expect(algebraOutcome.status).toBe("completed");
expect(geometryOutcome.status).toBe("completed");
expect(globalOutcome.status).toBe("completed");
expect(seenByTask[algebraTaskId].prompt).toContain("alg-01");
expect(seenByTask[geometryTaskId].prompt).toContain("geo-01");
expect(seenByTask[algebraTaskId].toolNames.length).toBeLessThanOrEqual(16);
expect(seenByTask[geometryTaskId].toolNames.length).toBeLessThanOrEqual(16);
expect(globalTrace.globalFallback).toBe(true);
expect(allReturnedIds.some((id) => id.startsWith("trap-"))).toBe(false);
expect(actualSchemaSetByTurn).toEqual(expectedFrozenUnionIntersectedWithSpaceFace);
expect(actualSkillSummaries).toEqual(expectedFrozenSkillSummaries);
expect(actualWorkingSet).toEqual(expectedLedgerSnapshot);
```

Also pause the algebra replica and assert the geometry replica can still run a task.

- [ ] **Step 7: Run the real-surface focused suite**

Run: `npx vitest run test/pth-runner/agent-task-runner.test.ts test/pth-kernel-execution/agent-loop.test.ts test/pth-kernel-execution/prompt-docs.test.ts test/pth-kernel-execution/agent-loop-ptc.integration.test.ts test/pth-kernel-execution/agent-loop-working-set.integration.test.ts test/pth-kernel-execution/task-loop.test.ts test/pth-runner/cognitive-responsibility.vertical.test.ts`

Expected: PASS; the hidden `dev.run` attempt is rejected before its executor is invoked.

- [ ] **Step 8: Commit real agent integration**

```bash
git add src/pth/kernel/execution/agent-loop-types.ts src/pth/kernel/execution/agent-loop.ts src/pth/kernel/execution/agent-loop-prompt.ts src/pth/kernel/execution/agent-loop-guards.ts src/pth/runner/authorized-task-reads.ts src/pth/runner/cognitive-working-set.ts src/pth/runner/agent-task-runner.ts src/pth/bootstrap/task-loop-types.ts src/pth/bootstrap/task-loop.ts src/pth/bootstrap/worker-slot-runtime.ts src/pth/bootstrap/batch-runtime-assembly.ts src/pth/bootstrap/batch-process.ts scripts/n28-feasibility-harness.ts test/pth-runner/agent-task-runner.test.ts test/pth-kernel-execution/agent-loop.test.ts test/pth-kernel-execution/prompt-docs.test.ts test/pth-kernel-execution/agent-loop-working-set.integration.test.ts test/pth-runner/cognitive-responsibility.vertical.test.ts
git commit -m "feat(pth): enforce cognitive working set in agent runtime"
```

---

### Task 7: Add a Reproducible Go/No-Go Evaluator and Record the Feasibility Result

**Files:**
- Create: `scripts/eval-n28-feasibility.ts`
- Modify: `scripts/n28-feasibility-harness.ts`
- Modify: `scripts/n28-feasibility-fixture.ts`
- Create: `test/pth-runner/n28-feasibility-evaluator.test.ts`
- Create after execution: `docs/pth/n28-feasibility-report.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: all Task 1–6 production classes and frozen fixtures.
- Produces: machine-readable `N28FeasibilityResult`, CLI JSON, process exit status, evidence-backed GO/NO-GO report.

- [ ] **Step 1: Write a failing evaluator aggregation test**

```typescript
import { describe, expect, it } from "vitest";
import { decideN28Feasibility, evaluateN28Feasibility, type N28FeasibilityMetrics } from "../../scripts/eval-n28-feasibility.js";

describe("N28 feasibility evaluator", () => {
  it("derives hypotheses and decision only from metrics", () => {
    const observed = passingMetricsFixture();
    expect(decideN28Feasibility(observed).decision).toBe("GO");
    for (const metric of [
      "sameRoleReplicaControlFailures", "bodyCopiesOutsideCanonicalStore", "missingFourWaveCases",
      "authorizationLeaks", "budgetViolations", "hiddenExecutorInvocations",
    ] as const) {
      const mutated = structuredClone(observed);
      mutated[metric] += 1;
      expect(decideN28Feasibility(mutated).decision, metric).toBe("NO-GO");
    }
  });

  it("detects one mutation for each H1-H6 path through the shared harness", async () => {
    for (const sabotage of ["control-target-swap", "directory-body-copy", "remove-global-wave", "grant-bypass", "oversized-spec", "hidden-executor"] as const) {
      const result = await evaluateN28Feasibility({ sabotage });
      expect(result.decision, sabotage).toBe("NO-GO");
      expect(Object.values(result.hypotheses).filter((item) => !item.passed), sabotage).toHaveLength(1);
    }
  });

  it("runs the unsabotaged shared assembly without hardcoding its decision", async () => {
    const result = await evaluateN28Feasibility();
    expect(Object.keys(result.hypotheses)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6"]);
    expect(result.decision).toBe(decideN28Feasibility(result.metrics).decision);
    expect(result.metrics).toMatchObject({ goldQueries: 12, generatedBudgetCases: 1000 });
  });
});
```

Define `passingMetricsFixture()` locally in the test with `satisfies N28FeasibilityMetrics`, enumerating every metric:
12/12 recall, coverage 1, overlap ≥1, exactly four waves for all gold cases, 1,000 generated cases, candidates ≤20 and
every failure/leak/mismatch counter 0. It is decision-unit-test input only; the evaluator and harness may not import it.

- [ ] **Step 2: Implement one evaluator that calls the real test harness exports**

Use this result contract:

```typescript
export interface N28FeasibilityMetrics {
    goldQueries: 12;
    goldRecall: number;
    authorizationLeaks: number;
    maxRetrievalWaves: number;
    generatedBudgetCases: 1000;
    budgetViolations: number;
    sameRoleReplicaControlFailures: number;
    batchRuntimeConsumptionFailures: number;
    stoppedSlotCleanupFailures: number;
    heartbeatIdentityFailures: number;
    auditIdentityFailures: number;
    grantIdentityFailures: number;
    directoryCoverage: number;
    overlapMemberships: number;
    ownerlessRegions: number;
    bodyCopiesOutsideCanonicalStore: number;
    directoryInvariantFailures: number;
    snapshotDeterminismMismatches: number;
    workingSetDeterminismMismatches: number;
    responsibilityViolations: number;
    retrievalIncompleteCases: number;
    retrievalFailedCases: number;
    maxWaveCandidates: number;
    missingFourWaveCases: number;
    unauthorizedWaveInvocations: number;
    unauthorizedReadPortInvocations: number;
    surfaceMismatches: number;
    hiddenExecutorInvocations: number;
}

export interface N28FeasibilityResult {
  decision: "GO" | "NO-GO";
  hypotheses: Record<"H1" | "H2" | "H3" | "H4" | "H5" | "H6", {
    passed: boolean;
    evidence: string[];
  }>;
  metrics: N28FeasibilityMetrics;
}
```

Derive hypotheses mechanically from metrics:

| Hypothesis | Exact pass predicate |
|---|---|
| H1 | same-role control, batch-runtime consumption, stopped-slot cleanup, heartbeat identity, audit identity and grant identity failures are all 0 |
| H2 | directory coverage is 1; overlap memberships ≥1; ownerless Regions/body copies/directory invariant failures/snapshot mismatches are 0 |
| H3 | gold recall is 1; every gold case has exactly waves `[0,1,2,3]`; max waves ≤4; max returned candidates/wave ≤20; incomplete/failed gold cases are 0 |
| H4 | authorization leaks, unauthorized wave invocations and unauthorized Memory/Skill/state backing-port invocations are 0; invalid/expired/missing-capability grants call no backing read |
| H5 | 1,000 task + responsibility cases ran; budget/responsibility/snapshot/Working Set determinism violations are 0 |
| H6 | schema/Skill/working-set surface mismatches and hidden executor invocations are 0 |

Each evidence array names the producing test/harness probe and observed counter; booleans may not be supplied independently
of their metrics.
Direct counters describe the unsabotaged acceptance run only; deliberately injected negative/sabotage probes assert the
detector fires but are not added to the positive run's leak/failure totals.

The unsabotaged run still performs negative contract probes and records an invariant failure only when a bad input is
unexpectedly accepted: invalid Directory tenant/revision/hash/epoch/owner, invalid/expired/missing-capability grant, and a
busy-remove cleanup race. It also builds two independent ledgers from reordered inputs and compares policy, admitted sets,
usage and omitted trace. These are observations from public components, not constants.

`evaluateN28Feasibility()` must instantiate the same public components as the vertical test. Do not reimplement ranking,
visibility, budgeting or tool filtering inside the script. Both Vitest and CLI import the frozen corpus, worker refs,
regions, responsibilities and gold queries from `scripts/n28-feasibility-fixture.ts`; neither imports the other.
All WorkerReplica IDs come from that fixture or an injected ID factory, so evaluator output contains no randomness.
The optional `sabotage` argument exists only in `scripts/n28-feasibility-harness.ts`. It may alter a fixture input,
dependency behavior or requested action, but it may not write a metric/hypothesis/counter directly. The same observers that
measure the unsabotaged production component must detect the mutation. Fix the mapping: control target swap→H1, body field
in Directory projection→H2, omitted global wave→H3, verifier bypass→H4, oversized function spec→H5, outside-union executor
attempt→H6. No sabotage branch or evaluator import may enter `src/pth/**`.

The shared harness owns exactly one canonical `Map<tenantId|entryId, body>`. Traverse the Directory/Responsibility/
WorkingSet objects and count any `content`/`body` field outside that map. Also report membership reference count separately;
overlap must increase references without increasing canonical body count:

```typescript
const duplicateCompositeIds = corpus.length - new Set(corpus.map((entry) => `${entry.tenantId}|${entry.id}`)).size;
metrics.bodyCopiesOutsideCanonicalStore = duplicateCompositeIds + countBodyFields(directory);
```

Guard the CLI entry so importing the evaluator from Vitest does not execute it:

```typescript
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await evaluateN28Feasibility();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision !== "GO") process.exitCode = 1;
}
```

- [ ] **Step 3: Make direct No-Go conditions override aggregate metrics**

`decideN28Feasibility(metrics)` is the only decision function. It derives H1–H6 from metrics, then returns `GO` iff every
hypothesis and every direct invariant below passes. Callers cannot supply independent hypothesis booleans. The evaluator
never hardcodes expected success:

```typescript
const directNoGo =
  Object.values(hypotheses).some((item) => !item.passed) ||
  metrics.authorizationLeaks > 0 ||
  metrics.goldRecall < 1 ||
  metrics.budgetViolations > 0 ||
  metrics.responsibilityViolations > 0 ||
  metrics.sameRoleReplicaControlFailures > 0 ||
  metrics.batchRuntimeConsumptionFailures > 0 ||
  metrics.stoppedSlotCleanupFailures > 0 ||
  metrics.heartbeatIdentityFailures > 0 ||
  metrics.auditIdentityFailures > 0 ||
  metrics.grantIdentityFailures > 0 ||
  metrics.directoryCoverage < 1 ||
  metrics.overlapMemberships < 1 ||
  metrics.ownerlessRegions > 0 ||
  metrics.bodyCopiesOutsideCanonicalStore > 0 ||
  metrics.directoryInvariantFailures > 0 ||
  metrics.snapshotDeterminismMismatches > 0 ||
  metrics.workingSetDeterminismMismatches > 0 ||
  metrics.maxRetrievalWaves > 4 ||
  metrics.missingFourWaveCases > 0 ||
  metrics.maxWaveCandidates > 20 ||
  metrics.unauthorizedWaveInvocations > 0 ||
  metrics.unauthorizedReadPortInvocations > 0 ||
  metrics.retrievalIncompleteCases > 0 ||
  metrics.retrievalFailedCases > 0 ||
  metrics.surfaceMismatches > 0 ||
  metrics.hiddenExecutorInvocations > 0;
```

H6 also fails when the fake LLM receives a schema outside the frozen Tool face or a hidden executor is invoked.

- [ ] **Step 4: Commit the evaluator and shared harness before collecting evidence**

```bash
git add scripts/eval-n28-feasibility.ts scripts/n28-feasibility-harness.ts scripts/n28-feasibility-fixture.ts test/pth-runner/n28-feasibility-evaluator.test.ts
git commit -m "test(pth): add N28 feasibility evaluator"
git rev-parse HEAD
```

Record this SHA as the evaluated implementation commit. Do not amend it after collecting results; fixes require a new
commit and a fresh complete run.

- [ ] **Step 5: Run the evaluator twice and verify byte-stable semantic output**

Run:

```bash
node --import tsx scripts/eval-n28-feasibility.ts > /tmp/n28-run-1.json
node --import tsx scripts/eval-n28-feasibility.ts > /tmp/n28-run-2.json
diff -u /tmp/n28-run-1.json /tmp/n28-run-2.json
```

Expected: both evaluator runs have the same exit status (`0` for GO, `1` for NO-GO) and `diff` has no output. A NO-GO is
a valid feasibility result and still proceeds to report generation; do not massage it into a green test. Do not include
timestamps, random IDs or machine paths in evaluator JSON.

- [ ] **Step 6: Run the complete N28 focused gate**

Run:

```bash
npx vitest run \
  test/pth-contracts/cognitive-responsibility.test.ts \
  test/pth-config/config.test.ts \
  test/pth-kernel-execution/worker-replica.test.ts \
  test/pth-kernel-execution/worker-slot-assembly.test.ts \
  test/pth-kernel-execution/worker-slot-runtime.test.ts \
  test/pth-kernel-execution/task-loop.test.ts \
  test/pth-kernel-execution/batch-manager.test.ts \
  test/pth-execution/memory-directory.test.ts \
  test/pth-execution/knowledge-ranking.test.ts \
  test/pth-execution/layered-knowledge-retriever.test.ts \
  test/pth-kernel-execution/cognitive-budget.test.ts \
  test/pth-runner/authorized-task-reads.test.ts \
  test/pth-runner/cognitive-working-set.test.ts \
  test/pth-tasking/task-outcome-observers.test.ts \
  test/pth-execution/knowledge-broker.test.ts \
  test/pth-runner/knowledge-context.test.ts \
  test/pth-runner/agent-task-runner.test.ts \
  test/pth-kernel-execution/agent-loop.test.ts \
  test/pth-kernel-execution/prompt-docs.test.ts \
  test/pth-kernel-execution/agent-tool-convergence.test.ts \
  test/pth-kernel-execution/agent-loop-working-set.integration.test.ts \
  test/pth-kernel-execution/agent-loop-ptc.integration.test.ts \
  test/pth-runner/cognitive-responsibility.vertical.test.ts \
  test/pth-runner/n28-feasibility-evaluator.test.ts
```

Expected: all contract and mutation tests PASS with no PG/Redis skips because the feasibility slice is intentionally
in-memory. The unsabotaged integration test verifies evidence/decision consistency without requiring GO; the CLI and report
carry the actual feasibility verdict.

- [ ] **Step 7: Run existing regression and architecture gates**

Run:

```bash
npm test
npm run lint
```

Expected: PASS in the same approved environment used for N27 acceptance, with no new skips; `check:pth-boundaries` and
`check:pth-config` report zero violations. An unavailable PG/Redis or sandbox-restricted baseline means “evaluation not
completed,” not GO and not an N28 functional failure. Record the environment blocker and rerun in the accepted environment.

- [ ] **Step 8: Record the exact result without upgrading it to production acceptance**

Create `docs/pth/n28-feasibility-report.md` with:

- evaluated commit SHA and exact commands;
- one row for each H1–H6 with `PASS` or `FAIL` and named test/evaluator evidence;
- the evaluator JSON metrics;
- explicit `GO` or `NO-GO`;
- the sentence: “This result validates the reversible in-memory orchestration model; it does not validate PG durability, automatic partitioning, autoscaling, real-LLM retrieval quality, or production default thresholds.”

If the result is `NO-GO`, list the failing direct condition and stop. Do not create production schema or an ADR.

If the result is `GO`, list the next planning inputs only: persistent WorkerReplica lease identity, Region/Responsibility revision tables, membership outbox, real-corpus weight calibration and make-before-break rebalance. Do not implement them in this plan.

- [ ] **Step 9: Link N28 from the documentation index**

Add two PTH rows to `docs/README.md`: one for the N28 design/implementation plan and one for the feasibility report. Mark the report “GO” only when the evaluator says GO.

- [ ] **Step 10: Commit the immutable report and index update**

```bash
git add docs/pth/n28-feasibility-report.md docs/README.md
git commit -m "docs(pth): record N28 feasibility decision"
```

---

## Execution Order and Review Gates

Execute strictly in order because each task consumes the previous task's public interfaces:

```text
Task 1 contracts
  → Task 2 WorkerReplica identity
  → Task 3 in-memory directory
  → Task 4 layered retrieval
  → Task 5 shared budget ledger
  → Task 6 real agent surface
  → Task 7 evaluator and decision
```

Each task gets a fresh implementation review and a spec-compliance review before the next begins. Task 7 is the only authority for the feasibility decision.

## Productionization Boundary

This plan ends at a reproducible GO/NO-GO result. A GO authorizes writing the next implementation plan; it does not authorize database migrations, automatic rebalancing, autoscaling, Role evolution or N26 integration. Those changes require a new ADR and a separate production plan based on the measured N28 report.
