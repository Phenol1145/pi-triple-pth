/**
 * bootstrap/batch-runtime-assembly.ts —— N28 T2 生产组合根。
 *
 * `assembleBatchRuntime` 是 feasibility 模式下 worker 身份、slot runtime、TaskLoop、
 * heartbeat/control 与 disposer 的唯一装配点；`runBatchHost` 拥有 IPC/控制与轮询。
 * 生产传 `continuous=true`；测试/harness 传 `maxIterations` 做有限运行。
 * batch-process 只保留 PG/schema/config 装配，不得二次组装 worker 或解释 worker control。
 */

import { createWorkerReplica, roleDefinitionRevision, WorkerReplica } from "@away_from/pth-kernel-execution";
import type { WorkerReplicaRef } from "@away_from/pth-contracts";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";
import { WorkerSlotRuntime, type WorkerControlMessage, type WorkerSlot, type WorkerSlotEvent } from "./worker-slot-runtime.js";

export interface BatchRuntimeDeps {
  mode: "off" | "feasibility";
  batchId: string;
  /** 生产从 Runtime Catalog 派生；确定性 harness 注入冻结 N28_ROLE + N28_WORKERS。 */
  workerSpecs?: readonly {
    role: RoleDefinition;
    requestedReplica?: WorkerReplicaRef;
  }[];
  replicaFactory?: (input: {
    role: RoleDefinition;
    batchId: string;
    index: number;
    requestedReplica?: WorkerReplicaRef;
  }) => WorkerReplica;
  /** feasibility 模式的 slot 工厂（真实 TaskLoop/kernel disposer 由 batch-process/harness 注入）。 */
  buildSlot?: (input: {
    role: RoleDefinition;
    replica: WorkerReplica | undefined;
    taskPrincipalId: string;
    sandboxPrincipalId: string;
    index: number;
  }) => WorkerSlot;
  emit?: (event: WorkerSlotEvent) => void;
}

function defaultReplicaFactory(input: {
  role: RoleDefinition;
  batchId: string;
  index: number;
  requestedReplica?: WorkerReplicaRef;
}): WorkerReplica {
  if (input.requestedReplica) return new WorkerReplica(input.requestedReplica);
  return createWorkerReplica(input.role.id, roleDefinitionRevision(input.role), input.batchId);
}

export function assembleBatchRuntime(deps: BatchRuntimeDeps): WorkerSlotRuntime {
  const runtime = new WorkerSlotRuntime({ emit: deps.emit ?? (() => {}) });
  if (deps.mode !== "feasibility") return runtime;

  const specs = deps.workerSpecs ?? [];
  const factory = deps.replicaFactory ?? defaultReplicaFactory;
  const seenWorkerIds = new Set<string>();
  for (const [index, spec] of specs.entries()) {
    const replica = factory({ role: spec.role, batchId: deps.batchId, index, requestedReplica: spec.requestedReplica });
    if (seenWorkerIds.has(replica.ref.workerId)) throw new Error(`duplicate worker id: ${replica.ref.workerId}`);
    seenWorkerIds.add(replica.ref.workerId);
    if (replica.ref.batchId !== deps.batchId) throw new Error(`worker ${replica.ref.workerId} batch mismatch: ${replica.ref.batchId} != ${deps.batchId}`);
    if (replica.ref.role.roleId !== spec.role.id) throw new Error(`worker ${replica.ref.workerId} role id mismatch`);
    if (roleDefinitionRevision(spec.role) !== replica.ref.role.revision) {
      throw new Error(`worker ${replica.ref.workerId} role revision mismatch`);
    }
    const identity = `worker:${replica.ref.workerId}`;
    if (!deps.buildSlot) throw new Error("buildSlot is required in feasibility mode");
    runtime.add(deps.buildSlot({
      role: spec.role,
      replica,
      taskPrincipalId: identity,
      sandboxPrincipalId: identity,
      index,
    }));
  }
  return runtime;
}

export interface RunBatchHostOptions {
  continuous?: boolean;
  maxIterations?: number;
  tickMs?: number;
  send?: (msg: unknown) => void;
  heartbeatResource?: () => { ts: number; rss: number; cpuU: number; cpuS: number };
  pollControls?: () => Promise<WorkerControlMessage[]>;
}

export async function runBatchHost(runtime: WorkerSlotRuntime, opts: RunBatchHostOptions = {}): Promise<void> {
  const max = opts.continuous ? Number.POSITIVE_INFINITY : (opts.maxIterations ?? 1);
  let iterations = 0;
  while (iterations < max) {
    const results = await runtime.runAllOnce();
    const resource = opts.heartbeatResource?.() ?? { ts: Date.now(), rss: 0, cpuU: 0, cpuS: 0 };
    opts.send?.(runtime.heartbeat(resource));
    for (const control of (await opts.pollControls?.()) ?? []) {
      const ack = await runtime.handleControl(control);
      opts.send?.(ack);
    }
    iterations += 1;
    if (iterations >= max) break;
    // 忙时自驱动（与 legacy tick 同吞吐语义）；空闲才退避 tickMs。
    if (results.some(Boolean)) continue;
    if ((opts.tickMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, opts.tickMs));
  }
}
