/**
 * execution/adapters/job-runner.ts — professional runtime adapter 公共 job 生命周期。
 *
 * 收敛 6 个 adapter 重复的 running 状态、结果组装、artifact 写入与 usage 统计。
 * 各 adapter 只保留 spec 校验、命令构造、probe、诊断解析等特有逻辑。
 */
import { createHash } from "node:crypto";
import {
  type ArtifactRef,
  type ProfessionalArtifactPort,
  type ProfessionalDiagnostic,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
} from "@away_from/pth-contracts";

export interface JobRunContextDeps<TValue> {
  readonly runtime: ProfessionalJobResult["runtime"];
  readonly runtimeVersion: string;
  readonly request: ProfessionalJobRequest<any>;
  readonly artifactPort: ProfessionalArtifactPort;
  readonly clock?: () => Date;
  readonly running: Map<string, { cancelled: boolean }>;
}

export interface JobRunContext<TValue> {
  readonly startedAt: Date;
  readonly traceId: string;
  readonly artifacts: ArtifactRef[];
  readonly diagnostics: ProfessionalDiagnostic[];
  readonly state: { cancelled: boolean };
  finish(
    status: ProfessionalJobResult["status"],
    error?: { code: string; message: string },
    value?: TValue,
    outputHashSource?: Uint8Array | string,
  ): ProfessionalJobResult<TValue>;
  fail(code: string, message: string): ProfessionalJobResult<TValue>;
  put(kind: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  isCancelled(): boolean;
  cleanup(): void;
}

/** 公共 sha256 hex（6 个 professional adapter 与 job-runner 共用同一实现）。 */
export function sha256hex(s: Uint8Array | string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 公共 cancel 标记翻转：job 未在 running 表内返回 false，否则置 cancelled 并返回 true。 */
export function cancelJob(running: Map<string, { cancelled: boolean }>, jobId: string): boolean {
  const state = running.get(jobId);
  if (!state) return false;
  state.cancelled = true;
  return true;
}

export function createJobRunContext<TValue>(deps: JobRunContextDeps<TValue>): JobRunContext<TValue> {
  const clock = deps.clock ?? (() => new Date());
  const startedAt = clock();
  const traceId = deps.request.traceId ?? "unknown";
  const artifacts: ArtifactRef[] = [];
  const diagnostics: ProfessionalDiagnostic[] = [];
  let outputBytes = 0;
  const state = { cancelled: false };
  deps.running.set(deps.request.jobId, state);

  const finish = (
    status: ProfessionalJobResult["status"],
    error?: { code: string; message: string },
    value?: TValue,
    outputHashSource?: Uint8Array | string,
  ): ProfessionalJobResult<TValue> => {
    const finishedAt = clock();
    if (error) diagnostics.push({ code: error.code, severity: "error", message: error.message });
    return {
      status,
      runtime: deps.runtime,
      runtimeVersion: deps.runtimeVersion,
      inputHash: deps.request.inputHash,
      outputHash: status === "succeeded" && outputHashSource !== undefined ? `sha256:${sha256hex(outputHashSource)}` : null,
      artifacts,
      diagnostics,
      usage: { durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()), cpuMs: 0, maxRssBytes: 0, outputBytes },
      traceId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ...(value !== undefined ? { value } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  };

  const fail = (code: string, message: string): ProfessionalJobResult<TValue> =>
    finish("failed", { code, message: message.slice(0, 4_000) });

  const put = async (kind: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactRef> => {
    const ref = await deps.artifactPort.putOutput({
      tenantId: deps.request.tenantId,
      jobId: deps.request.jobId,
      kind,
      mediaType,
      bytes,
    });
    artifacts.push(ref);
    outputBytes += bytes.byteLength;
    return ref;
  };

  const isCancelled = (): boolean => state.cancelled;
  const cleanup = (): void => {
    deps.running.delete(deps.request.jobId);
  };

  return { startedAt, traceId, artifacts, diagnostics, state, finish, fail, put, isCancelled, cleanup };
}
