/**
 * execution/professional-runtime.ts — v1.3 Task 2 专业运行注册表。
 *
 * Registry 是 adapter 之前的最后一道门禁：在调用任何 adapter 前验证
 *  - auth 是验证器 mint 的 branded envelope（不重放 HMAC）；
 *  - role/runtime allowlist；
 *  - lease/grant/deadline 绑定（tenant/space/worker/lease/roleRevision/runtime）；
 *  - committed lock（entry stable、请求版本与 lock 一致、安装版本与 lock 一致）。
 * Adapter 抛错或返回非法信封都会变成结构化 ProfessionalJobResult，绝不绕过
 * artifact/audit 处理，也绝不把异常直接抛给调用方。
 */

import { createHash } from "node:crypto";
import {
  isProfessionalJobResultStructurallyValid,
  isProfessionalRuntimeId,
  validateProfessionalJobRequest,
  type ExecutionGrant,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
  type ProfessionalJobSpec,
  type ProfessionalRuntimeId,
  type ProfessionalRuntimeLock,
  type TaskLeaseReference,
  type WorkerReplicaRef,
} from "../contracts/index.js";
import { canonicalGrantPayload, type ExecutionGrantService } from "./authorization/execution-grant-service.js";

// ─── 已验证专业 Job auth（一次性 grantService.verify() 后 mint 的 branded envelope） ───

const AUTH_BRAND = new WeakSet<object>();

export interface VerifiedProfessionalJobAuth {
  readonly tenantId: string;
  readonly space: string;
  readonly principalId: string;
  readonly worker: WorkerReplicaRef;
  readonly roleRevision: string;
  readonly runtimeId: ProfessionalRuntimeId;
  readonly lease: Readonly<TaskLeaseReference>;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly capabilities: readonly string[];
  readonly traceId: string;
  /** min(grant.deadlineAt, leaseDeadlineAt, request.deadlineAt)，冻结于 mint 时。 */
  readonly deadlineAt: string;
}

export interface ProfessionalJobAuthVerifier {
  verify(request: unknown, grant: unknown, opts?: { leaseDeadlineAt?: string }): VerifiedProfessionalJobAuth;
}

function earlierIso(...values: Array<string | undefined>): string {
  const defined = values.filter((v): v is string => typeof v === "string" && v !== "");
  return defined.sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
}

function mint(request: ProfessionalJobRequest<ProfessionalJobSpec>, grant: ExecutionGrant, leaseDeadlineAt?: string): VerifiedProfessionalJobAuth {
  const auth: VerifiedProfessionalJobAuth = Object.freeze({
    tenantId: request.tenantId,
    space: request.space,
    principalId: grant.scope.principalId,
    worker: Object.freeze({ ...request.worker, role: Object.freeze({ ...request.worker.role }) }),
    roleRevision: request.roleRevision,
    runtimeId: request.runtimeId,
    lease: Object.freeze({ taskId: request.lease.taskId, leaseId: request.lease.leaseId, generation: request.lease.generation }),
    grantId: grant.grantId,
    grantDigest: createHash("sha256").update(canonicalGrantPayload(grant)).digest("hex"),
    capabilities: Object.freeze([...grant.capabilities]),
    traceId: grant.scope.traceId,
    deadlineAt: earlierIso(grant.deadlineAt, leaseDeadlineAt, request.deadlineAt),
  });
  AUTH_BRAND.add(auth);
  return auth;
}

export function createProfessionalJobAuthVerifier(deps: { grantService: ExecutionGrantService }): ProfessionalJobAuthVerifier {
  return {
    verify(requestInput, grantInput, opts = {}) {
      const validated = validateProfessionalJobRequest(requestInput);
      if (!validated.ok) throw new Error(`professional job auth: ${validated.reason}`);
      const request = validated.value;
      const verified = deps.grantService.verify(grantInput, { leaseGeneration: request.lease.generation });
      if (!verified.ok) throw new Error(`professional job auth: ${verified.error}`);
      const grant = verified.grant;
      if (grant.scope.tenantId !== request.tenantId) throw new Error("professional job auth: tenant mismatch");
      if (grant.scope.space !== request.space) throw new Error("professional job auth: space mismatch");
      const expectedPrincipal = `worker:${request.worker.workerId}`;
      if (grant.scope.principalId !== expectedPrincipal) {
        throw new Error(`professional job auth: principal mismatch（grant=${grant.scope.principalId}, expected=${expectedPrincipal}）`);
      }
      if (grant.lease.taskId !== request.lease.taskId || grant.lease.leaseId !== request.lease.leaseId || grant.lease.generation !== request.lease.generation) {
        throw new Error("professional job auth: lease mismatch");
      }
      if (!grant.capabilities.includes("professional.execute")) {
        throw new Error("professional job auth: missing capability professional.execute");
      }
      if (request.roleRevision !== request.worker.role.revision) {
        throw new Error("professional job auth: role revision mismatch");
      }
      return mint(request, grant, opts.leaseDeadlineAt);
    },
  };
}

export function isVerifiedProfessionalJobAuth(v: unknown): v is VerifiedProfessionalJobAuth {
  return typeof v === "object" && v !== null && AUTH_BRAND.has(v);
}

// ─── Role → runtime allowlist（Task 3 的五个专业 Role 前移冻结） ───

export const PROFESSIONAL_RUNTIME_ROLE_ALLOWLIST: Readonly<Record<ProfessionalRuntimeId, readonly string[]>> = Object.freeze({
  assembly: Object.freeze(["assembly-engineer"]),
  lean4: Object.freeze(["lean4-prover"]),
  wolfram: Object.freeze(["symbolic-mathematician"]),
  psi4: Object.freeze(["computational-chemist"]),
  "quantum-espresso": Object.freeze(["computational-chemist"]),
  jupyter: Object.freeze(["technical-educator"]),
});

function isRoleAllowedForRuntime(roleId: string, runtimeId: ProfessionalRuntimeId): boolean {
  const allowed = PROFESSIONAL_RUNTIME_ROLE_ALLOWLIST[runtimeId] as readonly string[];
  return allowed.includes(roleId);
}

// ─── Adapter 与 Registry ───────────────────────────────────────────────────

export interface ProfessionalRuntimeAdapter<S extends ProfessionalJobSpec = ProfessionalJobSpec, R = unknown> {
  readonly id: ProfessionalRuntimeId;
  probe(): Promise<{ available: boolean; version: string; releaseChannel: "stable"; reason?: string }>;
  execute(input: ProfessionalJobRequest<S>): Promise<ProfessionalJobResult<R>>;
  cancel(jobId: string): Promise<boolean>;
}

export interface ProfessionalRuntimeProbe {
  readonly runtimeId: ProfessionalRuntimeId;
  readonly available: boolean;
  readonly version: string;
  readonly releaseChannel: string;
  readonly committedVersion: string | null;
  readonly satisfiesLock: boolean;
  readonly reason?: string;
}

export interface ProfessionalRuntimeRegistry {
  register<S extends ProfessionalJobSpec, R>(adapter: ProfessionalRuntimeAdapter<S, R>): void;
  probe(id: ProfessionalRuntimeId): Promise<ProfessionalRuntimeProbe>;
  execute<S extends ProfessionalJobSpec, R>(
    request: ProfessionalJobRequest<S>,
    auth: VerifiedProfessionalJobAuth,
  ): Promise<ProfessionalJobResult<R>>;
  cancel(id: ProfessionalRuntimeId, jobId: string, auth: VerifiedProfessionalJobAuth): Promise<boolean>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createProfessionalRuntimeRegistry(deps: {
  lock: ProfessionalRuntimeLock;
  clock?: () => Date;
}): ProfessionalRuntimeRegistry {
  if (typeof deps.lock !== "object" || deps.lock === null) {
    throw new Error("professional runtime registry: lock is required");
  }
  const clock = deps.clock ?? (() => new Date());
  const adapters = new Map<ProfessionalRuntimeId, ProfessionalRuntimeAdapter<any, any>>();

  function lockEntry(runtimeId: ProfessionalRuntimeId): ProfessionalRuntimeLock["runtimes"][ProfessionalRuntimeId] | undefined {
    return deps.lock.runtimes?.[runtimeId];
  }

  function assertCommittedLock(runtimeId: ProfessionalRuntimeId): { ok: true; version: string } | { ok: false; code: string; message: string } {
    const entry = lockEntry(runtimeId);
    if (!entry) return { ok: false, code: "lock-entry-missing", message: `committed lock has no entry for ${runtimeId}` };
    if (entry.releaseChannel !== "stable") {
      return { ok: false, code: "lock-entry-not-stable", message: `committed lock entry for ${runtimeId} is not stable` };
    }
    return { ok: true, version: entry.version };
  }

  function resolveRequestedVersion(runtimeId: ProfessionalRuntimeId, runtimeVersion: string): { ok: true; version: string } | { ok: false; code: string; message: string } {
    const lock = assertCommittedLock(runtimeId);
    if (!lock.ok) return lock;
    if (runtimeVersion === `lock:${runtimeId}`) return { ok: true, version: lock.version };
    if (runtimeVersion !== lock.version) {
      return {
        ok: false,
        code: "lock-version-mismatch",
        message: `request runtimeVersion ${runtimeVersion} does not match committed lock ${lock.version}`,
      };
    }
    return { ok: true, version: lock.version };
  }

  function failureResult<S extends ProfessionalJobSpec, R>(
    request: ProfessionalJobRequest<S>,
    auth: { readonly traceId?: string } | undefined,
    code: string,
    message: string,
    status: ProfessionalJobResult["status"] = "failed",
  ): ProfessionalJobResult<R> {
    const nowIso = clock().toISOString();
    const resolved = resolveRequestedVersion(request.runtimeId, request.runtimeVersion);
    return {
      status,
      runtime: request.runtimeId,
      runtimeVersion: resolved.ok ? resolved.version : request.runtimeVersion,
      inputHash: request.inputHash,
      outputHash: null,
      artifacts: [],
      diagnostics: [{ code, severity: "error", message }],
      usage: { durationMs: 0, cpuMs: 0, maxRssBytes: 0, outputBytes: 0 },
      traceId: auth?.traceId ?? "unknown",
      startedAt: nowIso,
      finishedAt: nowIso,
      error: { code, message },
    };
  }

  function assertBoundAuth(request: ProfessionalJobRequest<any>, auth: VerifiedProfessionalJobAuth): string | null {
    if (!isVerifiedProfessionalJobAuth(auth)) return "auth provenance mismatch";
    if (auth.runtimeId !== request.runtimeId) return "auth runtime mismatch";
    if (auth.tenantId !== request.tenantId) return "auth tenant mismatch";
    if (auth.space !== request.space) return "auth space mismatch";
    if (auth.worker.workerId !== request.worker.workerId) return "auth worker mismatch";
    if (auth.roleRevision !== request.worker.role.revision) return "auth role revision mismatch";
    if (auth.lease.taskId !== request.lease.taskId || auth.lease.leaseId !== request.lease.leaseId || auth.lease.generation !== request.lease.generation) {
      return "auth lease mismatch";
    }
    return null;
  }

  return {
    register(adapter) {
      if (!isProfessionalRuntimeId(adapter.id)) {
        throw new Error(`professional runtime registry: adapter id ${String(adapter.id)} is not an allowlisted professional runtime`);
      }
      if (adapters.has(adapter.id)) {
        throw new Error(`professional runtime registry: duplicate adapter id ${adapter.id}`);
      }
      adapters.set(adapter.id, adapter as ProfessionalRuntimeAdapter<any, any>);
    },

    async probe(id) {
      const adapter = adapters.get(id);
      const entry = lockEntry(id);
      const committedVersion = entry?.version ?? null;
      if (!adapter) {
        return { runtimeId: id, available: false, version: "", releaseChannel: "stable", committedVersion, satisfiesLock: false, reason: "unregistered-runtime" };
      }
      if (adapter.id !== id) {
        return { runtimeId: id, available: false, version: "", releaseChannel: "stable", committedVersion, satisfiesLock: false, reason: "adapter-runtime-mismatch" };
      }
      const p = await adapter.probe();
      const lockOk = entry !== undefined && entry.releaseChannel === "stable";
      const satisfiesLock = p.available && p.releaseChannel === "stable" && lockOk && p.version === committedVersion;
      return {
        runtimeId: id,
        available: p.available,
        version: p.version,
        releaseChannel: p.releaseChannel,
        committedVersion,
        satisfiesLock,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      };
    },

    async execute(request, auth) {
      const validated = validateProfessionalJobRequest(request);
      if (!validated.ok) {
        return failureResult(request as ProfessionalJobRequest<any>, auth, "request-invalid", validated.reason);
      }
      const bound = assertBoundAuth(request, auth);
      if (bound !== null) {
        return failureResult(request, auth, "auth-rejected", bound);
      }
      if (Date.parse(auth.deadlineAt) <= clock().getTime()) {
        return failureResult(request, auth, "deadline-exceeded", `professional job deadline ${auth.deadlineAt} has passed`);
      }
      if (!isRoleAllowedForRuntime(request.worker.role.roleId, request.runtimeId)) {
        return failureResult(request, auth, "role-not-allowed", `role ${request.worker.role.roleId} is not allowlisted for runtime ${request.runtimeId}`);
      }
      const resolved = resolveRequestedVersion(request.runtimeId, request.runtimeVersion);
      if (!resolved.ok) {
        return failureResult(request, auth, resolved.code, resolved.message);
      }
      const adapter = adapters.get(request.runtimeId);
      if (!adapter) {
        return failureResult(request, auth, "unregistered-runtime", `no adapter registered for runtime ${request.runtimeId}`);
      }
      if (adapter.id !== request.runtimeId) {
        return failureResult(request, auth, "adapter-runtime-mismatch", `adapter ${adapter.id} does not match runtime ${request.runtimeId}`);
      }
      let probe: Awaited<ReturnType<ProfessionalRuntimeAdapter["probe"]>>;
      try {
        probe = await adapter.probe();
      } catch (error) {
        return failureResult(request, auth, "probe-error", errorMessage(error), "failed");
      }
      if (!probe.available) {
        return failureResult(request, auth, "probe-unavailable", probe.reason ?? `runtime ${request.runtimeId} is unavailable`, "unavailable");
      }
      if (probe.releaseChannel !== "stable") {
        return failureResult(request, auth, "probe-not-stable", `runtime ${request.runtimeId} reports non-stable release channel ${probe.releaseChannel}`);
      }
      if (probe.version !== resolved.version) {
        return failureResult(request, auth, "installed-version-mismatch", `installed ${request.runtimeId} ${probe.version} does not match committed lock ${resolved.version}`);
      }
      const adapterInput = { ...request, traceId: auth.traceId } as ProfessionalJobRequest<ProfessionalJobSpec>;
      let result: unknown;
      try {
        result = await adapter.execute(adapterInput);
      } catch (error) {
        return failureResult(request, auth, "adapter-error", errorMessage(error));
      }
      if (!isProfessionalJobResultStructurallyValid(result)) {
        return failureResult(request, auth, "invalid-result-envelope", "adapter returned an invalid professional job result envelope");
      }
      const envelope = result as ProfessionalJobResult<any>;
      if (envelope.traceId !== auth.traceId) {
        return failureResult(request, auth, "result-trace-mismatch", "adapter result traceId does not match the verified auth traceId");
      }
      return envelope;
    },

    async cancel(id, jobId, auth) {
      if (!isVerifiedProfessionalJobAuth(auth)) return false;
      if (auth.runtimeId !== id) return false;
      if (Date.parse(auth.deadlineAt) <= clock().getTime()) return false;
      if (!isRoleAllowedForRuntime(auth.worker.role.roleId, id)) return false;
      const resolved = resolveRequestedVersion(id, `lock:${id}`);
      if (!resolved.ok) return false;
      const adapter = adapters.get(id);
      if (!adapter || adapter.id !== id) return false;
      try {
        return await adapter.cancel(jobId);
      } catch {
        return false;
      }
    },
  };
}
