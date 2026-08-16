/**
 * contracts/identity.ts — 跨模块身份与工作区协议（纯类型 + 结构校验）。
 *
 * 约束：
 *  - 本目录不 import fastify / pg / redis / @away_from/pth-sandbox 运行时；
 *  - WorkspaceRef 是 opaque 引用，不承载宿主路径、卷名或可直接访问文件系统的 string path；
 *  - 所有跨模块查询必须显式携带 TenantScope。
 */

export interface TenantScope {
  /** 服务器端从认证上下文派生的租户 id；调用方 body 字段不可覆盖 */
  readonly tenantId: string;
  /** 当前调用主体（worker / system / operator 身份） */
  readonly principalId: string;
  readonly roles: readonly string[];
  /** 一次业务调用链的关联 id（审计/追踪） */
  readonly traceId: string;
}

export interface WorkspaceRef {
  readonly tenantId: string;
  /** 不透明工作区 id（不得是宿主路径或可直接用于 fs 的 string path） */
  readonly workspaceId: string;
  readonly taskId?: string;
}

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isUuidLike(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isIsoDateString(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE_RE.test(v) && Number.isFinite(Date.parse(v));
}

export function isTenantScopeStructurallyValid(v: unknown): v is TenantScope {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    NON_EMPTY_STRING(s.tenantId) &&
    NON_EMPTY_STRING(s.principalId) &&
    NON_EMPTY_STRING(s.traceId) &&
    Array.isArray(s.roles) &&
    s.roles.length > 0 &&
    s.roles.every((r) => NON_EMPTY_STRING(r))
  );
}

export function isWorkspaceRefStructurallyValid(v: unknown): v is WorkspaceRef {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  if (!NON_EMPTY_STRING(w.tenantId) || !NON_EMPTY_STRING(w.workspaceId)) return false;
  if (w.taskId !== undefined && !NON_EMPTY_STRING(w.taskId)) return false;
  return true;
}
