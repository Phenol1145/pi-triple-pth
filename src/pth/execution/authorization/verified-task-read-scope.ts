/**
 * execution/authorization/verified-task-read-scope.ts —— N28 T4 唯一已验证任务读取信封。
 *
 * 一次性真实 `grantService.verify()` 后私密 mint 一个 branded frozen envelope；
 * 此后每次 wave/read 前只做廉价 brand/binding/effective-deadline 断言（绝不重放
 * HMAC/replay verify——enabled replay guard 会在首次验证时消耗 nonce）。
 * raw verified grant → branded scope 的 mint 模块私有，永不从 barrel 导出。
 */

import { createHash } from "node:crypto";
import type { ExecutionGrant, TaskLease, TaskWorkItem, WorkerReplicaRef } from "../../contracts/index.js";
import { canonicalGrantPayload, type ExecutionGrantService } from "./execution-grant-service.js";

const SCOPE_BRAND = new WeakSet<object>();

export interface VerifiedTaskReadScope {
  readonly tenantId: string;
  readonly space: string;
  readonly principalId: string;
  readonly worker: WorkerReplicaRef;
  readonly capabilities: readonly string[];
  readonly lease: Readonly<Pick<TaskLease, "taskId" | "leaseId" | "generation">>;
  readonly grantDigest: string;
  /** min(grant.deadlineAt, TaskLease.deadlineAt)，冻结于创建时。 */
  readonly deadlineAt: string;
}

export interface VerifiedTaskReadScopeFactory {
  forTask(input: { lease: TaskLease; work: TaskWorkItem; space: string; worker: WorkerReplicaRef }): VerifiedTaskReadScope;
  verifyBrokerGrant(input: {
    grant: unknown;
    worker: WorkerReplicaRef;
    /** Required when the Broker call belongs to a live task; effective deadline uses the earlier value. */
    leaseDeadlineAt?: string;
  }): VerifiedTaskReadScope;
}

export interface VerifiedTaskReadScopeAssertion {
  tenantId?: string;
  space?: string;
  principalId?: string;
  workerId?: string;
  taskId?: string;
  leaseId?: string;
  generation?: number;
  capabilities?: readonly string[];
}

function earlierIso(a: string, b: string | undefined): string {
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function mint(grant: ExecutionGrant, worker: WorkerReplicaRef, leaseDeadlineAt?: string): VerifiedTaskReadScope {
  if (!grant.scope.tenantId || !grant.scope.space) throw new Error("verified task read scope: grant scope tenant/space missing");
  const scope: VerifiedTaskReadScope = Object.freeze({
    tenantId: grant.scope.tenantId,
    space: grant.scope.space,
    principalId: grant.scope.principalId,
    worker: Object.freeze({ ...worker, role: Object.freeze({ ...worker.role }) }),
    capabilities: Object.freeze([...grant.capabilities]),
    lease: Object.freeze({ taskId: grant.lease.taskId, leaseId: grant.lease.leaseId, generation: grant.lease.generation }),
    grantDigest: createHash("sha256").update(canonicalGrantPayload(grant)).digest("hex"),
    deadlineAt: earlierIso(grant.deadlineAt, leaseDeadlineAt),
  });
  SCOPE_BRAND.add(scope);
  return scope;
}

function verifyForTask(deps: {
  grantService: ExecutionGrantService;
  grantForTask(input: { lease: TaskLease; work: TaskWorkItem; space: string; worker: WorkerReplicaRef }): ExecutionGrant;
}, input: { lease: TaskLease; work: TaskWorkItem; space: string; worker: WorkerReplicaRef }): VerifiedTaskReadScope {
  const grant = deps.grantForTask(input);
  const verified = deps.grantService.verify(grant, { leaseGeneration: input.lease.generation });
  if (!verified.ok) throw new Error(`verified task read scope: ${verified.error}`);
  const g = verified.grant;
  if (g.scope.tenantId !== input.work.scope.tenantId) throw new Error("verified task read scope: tenant mismatch");
  if (g.scope.space !== input.space) throw new Error("verified task read scope: space mismatch");
  const expectedPrincipal = `worker:${input.worker.workerId}`;
  if (g.scope.principalId !== expectedPrincipal) throw new Error(`verified task read scope: principal mismatch（grant=${g.scope.principalId}, expected=${expectedPrincipal}）`);
  if (g.lease.taskId !== input.lease.taskId || g.lease.leaseId !== input.lease.leaseId || g.lease.generation !== input.lease.generation) {
    throw new Error("verified task read scope: lease mismatch");
  }
  if (!g.capabilities.includes("memory.read")) throw new Error("verified task read scope: missing capability memory.read");
  return mint(g, input.worker, input.lease.deadlineAt);
}

export function createVerifiedTaskReadScopeFactory(deps: {
  grantService: ExecutionGrantService;
  grantForTask(input: { lease: TaskLease; work: TaskWorkItem; space: string; worker: WorkerReplicaRef }): ExecutionGrant;
}): VerifiedTaskReadScopeFactory {
  return {
    forTask(input) {
      return verifyForTask(deps, input);
    },
    verifyBrokerGrant(input) {
      const verified = deps.grantService.verify(input.grant);
      if (!verified.ok) throw new Error(`verified broker grant: ${verified.error}`);
      const g = verified.grant;
      if (!g.capabilities.includes("memory.read")) throw new Error("verified broker grant: missing capability memory.read");
      const expectedPrincipal = `worker:${input.worker.workerId}`;
      if (g.scope.principalId !== expectedPrincipal) {
        throw new Error(`verified broker grant: principal mismatch（grant=${g.scope.principalId}, expected=${expectedPrincipal}）`);
      }
      return mint(g, input.worker, input.leaseDeadlineAt);
    },
  };
}

export function assertVerifiedTaskReadScope(
  scope: unknown,
  expected: VerifiedTaskReadScopeAssertion,
  opts: { clock: () => Date },
): asserts scope is VerifiedTaskReadScope {
  if (typeof scope !== "object" || scope === null || !SCOPE_BRAND.has(scope)) {
    throw new Error("verified task read scope: opaque provenance mismatch");
  }
  const s = scope as VerifiedTaskReadScope;
  if (expected.tenantId !== undefined && s.tenantId !== expected.tenantId) throw new Error("verified task read scope: tenant mismatch");
  if (expected.space !== undefined && s.space !== expected.space) throw new Error("verified task read scope: space mismatch");
  if (expected.principalId !== undefined && s.principalId !== expected.principalId) throw new Error("verified task read scope: principal mismatch");
  if (expected.workerId !== undefined && s.worker.workerId !== expected.workerId) throw new Error("verified task read scope: worker mismatch");
  if (expected.taskId !== undefined && s.lease.taskId !== expected.taskId) throw new Error("verified task read scope: task mismatch");
  if (expected.leaseId !== undefined && s.lease.leaseId !== expected.leaseId) throw new Error("verified task read scope: leaseId mismatch");
  if (expected.generation !== undefined && s.lease.generation !== expected.generation) throw new Error("verified task read scope: generation mismatch");
  if (expected.capabilities !== undefined) {
    for (const capability of expected.capabilities) {
      if (!s.capabilities.includes(capability)) throw new Error(`verified task read scope: missing capability ${capability}`);
    }
  }
  if (Date.parse(s.deadlineAt) <= opts.clock().getTime()) throw new Error("verified task read scope: deadline exceeded");
}
