import { createHash, randomUUID } from "node:crypto";
import type { WorkerReplicaRef } from "@away_from/pth-contracts";
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

  readonly ref: WorkerReplicaRef;
  constructor(ref: WorkerReplicaRef) {
    this.ref = Object.freeze({ ...ref, role: Object.freeze({ ...ref.role }) });
  }

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
    // T2 裁决（用户确认）：恒定输出 currentTaskId 键（无任务时为 undefined），
    // 与计划冻结测试 toMatchObject({ currentTaskId: undefined }) 对齐。
    return { ...this.ref, state: this.state, currentTaskId: this.currentTaskId };
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
