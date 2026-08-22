/**
 * runner/professional-task-capability.ts — v1.3 Task 4 任务级专业计算 facade。
 *
 * LLM 只提交 typed adapter spec + artifact IDs；tenant/role/worker/runtime version/
 * deadline/space/jobId 全部由本 facade 服务端创建。所有 denial 都以结构化
 * ProfessionalJobResult 返回（adapter 调用计数必须为 0），不把异常直接抛给任务。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  isExecutionGrantStructurallyValid,
  isProfessionalRuntimeId,
  validateProfessionalJobRequest,
  type ArtifactRef,
  type ExecutionGrant,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
  type ProfessionalJobSpec,
  type ProfessionalRuntimeId,
  type TaskLease,
  type TaskWorkItem,
  type WorkerReplicaRef,
} from "@away_from/pth-contracts";
import { roleDefinitionRevision } from "@away_from/pth-kernel-execution";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";
import {
  createProfessionalJobAuthVerifier,
  PROFESSIONAL_RUNTIME_ROLE_ALLOWLIST,
  type ProfessionalRuntimeProbe,
  type ProfessionalRuntimeRegistry,
  type VerifiedProfessionalJobAuth,
} from "../execution/index.js";
import type { ExecutionGrantService } from "../execution/index.js";

/** Task 4 服务端输出预算上限：LLM 单次 professional.execute 声明的输出总量不得超过此值。 */
export const PROFESSIONAL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

import type { ProfessionalArtifactPort } from "@away_from/pth-contracts";
export type { ProfessionalArtifactPort };

export interface ProfessionalOutputSpec {
  readonly kind: string;
  readonly mediaType: string;
  /** 本产物声明的最大字节数（服务端预算门禁——不是 adapter 可自报的兜底）。 */
  readonly maxBytes: number;
}

export interface ProfessionalExecuteInput {
  readonly runtimeId: ProfessionalRuntimeId;
  readonly spec: ProfessionalJobSpec;
  /** 额外输入 artifact（spec 内嵌 ArtifactRef 也会被强制读取并校验租户）。 */
  readonly inputs?: readonly ArtifactRef[];
  /** 输出声明；总量超 PROFESSIONAL_MAX_OUTPUT_BYTES 时在调用 adapter 前拒绝。 */
  readonly outputs?: readonly ProfessionalOutputSpec[];
}

export interface ProfessionalCancelInput {
  readonly runtimeId: ProfessionalRuntimeId;
  readonly jobId: string;
}

export interface ProfessionalJobHandle {
  readonly jobId: string;
  readonly result: ProfessionalJobResult;
}

export interface ProfessionalTaskCapability {
  probe(input: { runtimeId: ProfessionalRuntimeId }): Promise<ProfessionalRuntimeProbe>;
  execute(input: ProfessionalExecuteInput): Promise<ProfessionalJobHandle>;
  cancel(input: ProfessionalCancelInput): Promise<boolean>;
}

export interface ProfessionalTaskCapabilityInput {
  readonly lease: TaskLease;
  readonly work: TaskWorkItem;
  readonly worker: WorkerReplicaRef;
  readonly role: RoleDefinition;
  readonly grant: ExecutionGrant;
  readonly registry: ProfessionalRuntimeRegistry;
  readonly artifacts: ProfessionalArtifactPort;
  /** 服务器端空间（agent-task-runner 从 kernel sessionRef 注入；缺省 meta）。 */
  readonly space?: string;
  readonly clock?: () => Date;
}

const EMPTY_SHA256 = `sha256:${"0".repeat(64)}`;

function earlierIso(...values: Array<string | undefined>): string {
  const defined = values.filter((v): v is string => typeof v === "string" && v !== "");
  return defined.sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
}

function hashInputs(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest("hex")}`;
}

function failureResult(input: {
  runtimeId: ProfessionalRuntimeId;
  runtimeVersion: string;
  inputHash: string;
  traceId: string;
  code: string;
  message: string;
  clock: () => Date;
}): ProfessionalJobResult {
  const nowIso = input.clock().toISOString();
  return {
    status: "failed",
    runtime: input.runtimeId,
    runtimeVersion: input.runtimeVersion,
    inputHash: input.inputHash,
    outputHash: null,
    artifacts: [],
    diagnostics: [{ code: input.code, severity: "error", message: input.message }],
    usage: { durationMs: 0, cpuMs: 0, maxRssBytes: 0, outputBytes: 0 },
    traceId: input.traceId,
    startedAt: nowIso,
    finishedAt: nowIso,
    error: { code: input.code, message: input.message },
  };
}

function isSafeArtifactUri(uri: string): boolean {
  if (typeof uri !== "string" || uri.trim() === "") return false;
  if (uri.includes("..")) return false;
  if (uri.startsWith("/") || uri.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(uri)) return false;
  if (uri.startsWith("file:")) return false;
  return true;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** 从判别 spec 中提取内嵌 ArtifactRef（不重复导出契约层的结构校验）。 */
function specArtifactRefs(spec: ProfessionalJobSpec): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const record = spec as unknown as Record<string, unknown>;
  const push = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const candidate = v as { kind?: unknown; uri?: unknown; mediaType?: unknown };
    if (isNonEmptyString(candidate.kind) && isNonEmptyString(candidate.uri)) {
      refs.push({ kind: candidate.kind, uri: candidate.uri, ...(typeof candidate.mediaType === "string" ? { mediaType: candidate.mediaType } : {}) });
    }
  };
  for (const [key, value] of Object.entries(record)) {
    if (key === "sourceRef" || key === "projectRef" || key === "structureRef" || key === "notebookRef") push(value);
  }
  return refs;
}

function createPreverifiedGrantService(grant: ExecutionGrant, clock: () => Date): ExecutionGrantService {
  return {
    issue() {
      throw new Error("preverified professional grant service cannot issue grants");
    },
    verify(candidate) {
      if (candidate !== grant) return { ok: false, error: "grant instance mismatch" };
      if (!isExecutionGrantStructurallyValid(candidate)) return { ok: false, error: "grant structurally invalid" };
      if (Date.parse(candidate.deadlineAt) <= clock().getTime()) return { ok: false, error: "grant expired" };
      return { ok: true, grant: candidate };
    },
  };
}

export function createProfessionalTaskCapability(input: ProfessionalTaskCapabilityInput): ProfessionalTaskCapability {
  const clock = input.clock ?? (() => new Date());
  const tenantId = input.work.scope.tenantId;
  const space = input.space ?? input.work.scope.space ?? "meta";
  const traceId = input.work.scope.traceId;
  const runtimeVersion = (runtimeId: ProfessionalRuntimeId) => `lock:${runtimeId}`;
  const registry = input.registry;
  const authByJobId = new Map<string, VerifiedProfessionalJobAuth>();
  const verifier = createProfessionalJobAuthVerifier({ grantService: createPreverifiedGrantService(input.grant, clock) });

  function denied(input: {
    runtimeId: ProfessionalRuntimeId;
    code: string;
    message: string;
    inputHash?: string;
  }): ProfessionalJobHandle {
    const result = failureResult({
      runtimeId: input.runtimeId,
      runtimeVersion: runtimeVersion(input.runtimeId),
      inputHash: input.inputHash ?? EMPTY_SHA256,
      traceId,
      code: input.code,
      message: input.message,
      clock,
    });
    return { jobId: "", result };
  }

  async function execute(executeInput: ProfessionalExecuteInput): Promise<ProfessionalJobHandle> {
    const { runtimeId, spec } = executeInput;
    if (!isProfessionalRuntimeId(runtimeId)) {
      throw new Error(`professional.execute: unknown runtime ${String(runtimeId)}`);
    }

    const nowMs = clock().getTime();
    if (Date.parse(input.lease.deadlineAt) <= nowMs) {
      return denied({ runtimeId, code: "lease-expired", message: `task lease ${input.lease.leaseId} expired at ${input.lease.deadlineAt}` });
    }
    if (Date.parse(input.grant.deadlineAt) <= nowMs) {
      return denied({ runtimeId, code: "grant-expired", message: `grant ${input.grant.grantId} expired at ${input.grant.deadlineAt}` });
    }
    if (!input.grant.capabilities.includes("professional.execute")) {
      return denied({ runtimeId, code: "missing-capability", message: "grant is missing professional.execute capability" });
    }
    if (input.grant.scope.tenantId !== tenantId) {
      return denied({ runtimeId, code: "tenant-mismatch", message: `grant tenant ${input.grant.scope.tenantId} does not match task tenant ${tenantId}` });
    }
    const expectedPrincipal = `worker:${input.worker.workerId}`;
    if (input.grant.scope.principalId !== expectedPrincipal) {
      return denied({ runtimeId, code: "worker-mismatch", message: `grant principal ${input.grant.scope.principalId} does not match ${expectedPrincipal}` });
    }
    if (input.grant.lease.taskId !== input.lease.taskId || input.grant.lease.leaseId !== input.lease.leaseId || input.grant.lease.generation !== input.lease.generation) {
      return denied({ runtimeId, code: "lease-mismatch", message: "grant lease does not match the task lease" });
    }
    const computedRevision = roleDefinitionRevision(input.role);
    if (input.worker.role.revision !== computedRevision) {
      return denied({ runtimeId, code: "role-revision-mismatch", message: `worker role revision ${input.worker.role.revision} does not match ${computedRevision}` });
    }
    const allowedRoles = PROFESSIONAL_RUNTIME_ROLE_ALLOWLIST[runtimeId] as readonly string[];
    if (!allowedRoles.includes(input.worker.role.roleId)) {
      return denied({ runtimeId, code: "runtime-not-allowed", message: `role ${input.worker.role.roleId} is not allowlisted for runtime ${runtimeId}` });
    }

    const allRefs = [...specArtifactRefs(spec), ...(executeInput.inputs ?? [])];
    const parts: Uint8Array[] = [];
    for (const ref of allRefs) {
      if (!isSafeArtifactUri(ref.uri)) {
        return denied({ runtimeId, code: "artifact-uri-unsafe", message: `artifact uri ${ref.uri} escapes the artifact namespace` });
      }
      try {
        parts.push(await input.artifacts.getInput(tenantId, ref));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /tenant/i.test(message) ? "tenant-mismatch" : "artifact-input-rejected";
        return denied({ runtimeId, code, message: `input artifact ${ref.uri} rejected: ${message}` });
      }
    }

    const outputSpecs = executeInput.outputs ?? [];
    const declaredOutputBytes = outputSpecs.reduce((sum, output) => {
      return sum + (Number.isFinite(output.maxBytes) && output.maxBytes > 0 ? output.maxBytes : 0);
    }, 0);
    if (declaredOutputBytes > PROFESSIONAL_MAX_OUTPUT_BYTES) {
      return denied({
        runtimeId,
        code: "output-limit",
        message: `declared output ${declaredOutputBytes} bytes exceeds server limit ${PROFESSIONAL_MAX_OUTPUT_BYTES}`,
        inputHash: hashInputs(parts),
      });
    }
    for (const output of outputSpecs) {
      if (!isNonEmptyString(output.kind) || !isNonEmptyString(output.mediaType) || !Number.isFinite(output.maxBytes) || output.maxBytes <= 0) {
        return denied({ runtimeId, code: "output-invalid", message: "output declaration must have kind/mediaType/positive maxBytes" });
      }
    }

    const inputHash = hashInputs(parts);
    const request: ProfessionalJobRequest<ProfessionalJobSpec> = {
      jobId: randomUUID(),
      taskId: input.lease.taskId,
      tenantId,
      space,
      worker: input.worker,
      lease: { taskId: input.lease.taskId, leaseId: input.lease.leaseId, generation: input.lease.generation },
      roleRevision: input.worker.role.revision,
      runtimeId,
      runtimeVersion: runtimeVersion(runtimeId),
      deadlineAt: earlierIso(input.grant.deadlineAt, input.lease.deadlineAt),
      inputHash,
      traceId,
      spec,
    };

    const validated = validateProfessionalJobRequest(request);
    if (!validated.ok) {
      return denied({ runtimeId, code: "request-invalid", message: validated.reason, inputHash });
    }

    let auth: VerifiedProfessionalJobAuth;
    try {
      auth = verifier.verify(request, input.grant, { leaseDeadlineAt: input.lease.deadlineAt });
    } catch (error) {
      return denied({ runtimeId, code: "auth-rejected", message: (error as Error).message, inputHash });
    }

    authByJobId.set(request.jobId, auth);
    try {
      const result = await input.registry.execute(request, auth);
      return { jobId: request.jobId, result };
    } catch (error) {
      return denied({
        runtimeId,
        code: "registry-error",
        message: (error as Error).message,
        inputHash,
      });
    }
  }

  return {
    probe(probeInput: { runtimeId: ProfessionalRuntimeId }) {
      if (!isProfessionalRuntimeId(probeInput.runtimeId)) {
        throw new Error(`professional.probe: unknown runtime ${String(probeInput.runtimeId)}`);
      }
      return registry.probe(probeInput.runtimeId);
    },
    execute,
    async cancel(cancelInput: ProfessionalCancelInput) {
      if (!isProfessionalRuntimeId(cancelInput.runtimeId)) return false;
      const auth = authByJobId.get(cancelInput.jobId);
      if (!auth || auth.runtimeId !== cancelInput.runtimeId) return false;
      return registry.cancel(cancelInput.runtimeId, cancelInput.jobId, auth);
    },
  };
}
