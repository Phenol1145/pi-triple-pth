/**
 * contracts/execution.ts — 执行请求/grant/结果协议（纯类型 + 结构校验）。
 *
 * ExecutionGrant 是签名 capability：绑定 lease/scope/workspace/language/generation/deadline，
 * 可验证过期、重放与 generation 不匹配。本层只做结构校验；签名/验签由 execution
 * authorization 模块与 sandbox adapter 实现，本层不产生任何授权。
 */

import {
  isTenantScopeStructurallyValid,
  isUuidLike,
  isWorkspaceRefStructurallyValid,
  type TenantScope,
  type WorkspaceRef,
} from "./identity.js";
import { isTaskLeaseReferenceStructurallyValid, type TaskLeaseReference } from "./tasking.js";

export type ExecutionLanguage = "ts" | "python" | "bash" | "c" | (string & {});

export interface ExecutionRequest {
  readonly scope: TenantScope;
  readonly workspace: WorkspaceRef;
  readonly language: ExecutionLanguage;
  readonly program: string;
  readonly timeoutMs: number;
  readonly maxStdout: number;
  readonly maxStderr: number;
}

export interface ExecutionGrant {
  readonly grantId: string;
  readonly nonce: string;
  readonly lease: TaskLeaseReference;
  readonly scope: TenantScope;
  readonly workspace: WorkspaceRef;
  readonly language: ExecutionLanguage;
  readonly capabilities: readonly string[];
  readonly issuedAt: string;
  readonly deadlineAt: string;
}

export interface ExecutionResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: { code: string; message: string };
  readonly truncated?: Readonly<Record<"stdout" | "stderr" | "value", boolean>>;
}

/** 执行端口：request 必须配同一 lease/scope 的 grant；无 grant 不得执行。 */
export interface ExecutionPort {
  execute(request: ExecutionRequest, grant: ExecutionGrant, signal?: AbortSignal): Promise<ExecutionResult>;
}

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const LANGUAGE_RE = /^[a-z0-9_-]{1,32}$/;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function isExecutionLanguage(v: unknown): v is ExecutionLanguage {
  return typeof v === "string" && LANGUAGE_RE.test(v);
}

export function isExecutionRequestStructurallyValid(v: unknown): v is ExecutionRequest {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isTenantScopeStructurallyValid(r.scope) &&
    isWorkspaceRefStructurallyValid(r.workspace) &&
    isExecutionLanguage(r.language) &&
    typeof r.program === "string" &&
    typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0 &&
    isNonNegativeFiniteNumber(r.maxStdout) &&
    isNonNegativeFiniteNumber(r.maxStderr)
  );
}

export function isExecutionGrantStructurallyValid(v: unknown): v is ExecutionGrant {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  if (
    !isUuidLike(g.grantId) ||
    !NON_EMPTY_STRING(g.nonce) ||
    !isTaskLeaseReferenceStructurallyValid(g.lease) ||
    !isTenantScopeStructurallyValid(g.scope) ||
    !isWorkspaceRefStructurallyValid(g.workspace) ||
    !isExecutionLanguage(g.language) ||
    !Array.isArray(g.capabilities) ||
    !g.capabilities.every((c) => typeof c === "string" && CAPABILITY_RE.test(c))
  ) return false;
  const issuedAt = typeof g.issuedAt === "string" ? Date.parse(g.issuedAt) : Number.NaN;
  const deadlineAt = typeof g.deadlineAt === "string" ? Date.parse(g.deadlineAt) : Number.NaN;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(deadlineAt)) return false;
  return deadlineAt > issuedAt;
}

export function isExecutionResultStructurallyValid(v: unknown): v is ExecutionResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.ok !== "boolean" || typeof r.stdout !== "string" || typeof r.stderr !== "string") return false;
  if (!isNonNegativeFiniteNumber(r.durationMs)) return false;
  if (r.error !== undefined) {
    const e = r.error as Record<string, unknown>;
    if (typeof e !== "object" || e === null || !NON_EMPTY_STRING(e.code) || typeof e.message !== "string") return false;
  }
  if (r.truncated !== undefined) {
    const t = r.truncated as Record<string, unknown>;
    if (typeof t !== "object" || t === null || Object.values(t).some((b) => typeof b !== "boolean")) return false;
  }
  return true;
}
