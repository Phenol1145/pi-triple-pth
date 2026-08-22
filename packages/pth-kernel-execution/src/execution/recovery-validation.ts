/**
 * recovery-validation.ts —— 装配恢复来源校验（模块优化 H7）。
 *
 * worker-role / space-reg 是重启装配的注册源。worker 面 memory.write 已被用途层拒绝
 * （prompt 层只读），但 store 深度再上一道：恢复时校验 meta.source 允许集 + 结构形状，
 * 任意伪造 official 条目都会被拒绝（信任链闭环）。
 */

const ROLE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SPACE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SPACE_EXEC_TOOLS = new Set(["ts", "python", "bash", "dev", "write"]);

/** worker-role 可信写入源（routes-lineage approve / assembly proposal 重建） */
export const WORKER_ROLE_SOURCES = new Set(["lineage-approve", "proposal-rebuild"]);

export interface RecoverableWorkerRole {
  id: string;
  parent: string;
  tags: string[];
  prompt: string;
  [k: string]: unknown;
}

export type RecoveryParse<T> = { ok: true; value: T } | { ok: false; reason: string };

export function parseWorkerRoleRecovery(entry: { content: string; meta?: Record<string, unknown> | null }): RecoveryParse<RecoverableWorkerRole> {
  const source = entry.meta?.["source"];
  if (source !== "lineage-approve" && source !== "proposal-rebuild") {
    return { ok: false, reason: `来源不受信（source=${String(source ?? "缺失")}）` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(entry.content);
  } catch {
    return { ok: false, reason: "content 不是合法 JSON" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "content 不是对象" };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ROLE_ID_RE.test(r.id)) return { ok: false, reason: "角色 id 非法" };
  if (typeof r.parent !== "string" || r.parent.length === 0 || r.parent.length > 64) return { ok: false, reason: "parent 非法" };
  if (!Array.isArray(r.tags) || r.tags.length === 0 || r.tags.some((t) => typeof t !== "string" || t.length === 0 || t.length > 64)) {
    return { ok: false, reason: "tags 非法（非空字符串数组）" };
  }
  if (typeof r.prompt !== "string" || r.prompt.length === 0) return { ok: false, reason: "prompt 缺失" };
  return { ok: true, value: { id: r.id, parent: r.parent, tags: r.tags as string[], prompt: r.prompt, ...r } };
}

export interface RecoverableSpace {
  id: string;
  parent: string;
  execTool: string;
  extraTools?: string[];
  memoryScope?: string;
  description?: string;
  bindRoles?: string[];
}

export function parseSpaceRecovery(
  entry: { content: string; meta?: Record<string, unknown> | null },
  hasParent: (id: string) => boolean,
): RecoveryParse<RecoverableSpace> {
  let raw: unknown;
  try {
    raw = JSON.parse(entry.content);
  } catch {
    return { ok: false, reason: "content 不是合法 JSON" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "content 不是对象" };
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || !SPACE_ID_RE.test(d.id)) return { ok: false, reason: "空间 id 非法" };
  if (typeof d.parent !== "string" || !hasParent(d.parent)) return { ok: false, reason: `父空间不存在（${String(d.parent)}）` };
  if (typeof d.execTool !== "string" || !SPACE_EXEC_TOOLS.has(d.execTool)) return { ok: false, reason: `execTool 不在白名单（${String(d.execTool)}）` };
  if (d.extraTools !== undefined && (!Array.isArray(d.extraTools) || d.extraTools.some((t) => typeof t !== "string"))) {
    return { ok: false, reason: "extraTools 非法" };
  }
  if (d.memoryScope !== undefined && typeof d.memoryScope !== "string") return { ok: false, reason: "memoryScope 非法" };
  if (d.description !== undefined && typeof d.description !== "string") return { ok: false, reason: "description 非法" };
  if (d.bindRoles !== undefined && (!Array.isArray(d.bindRoles) || d.bindRoles.length === 0 || d.bindRoles.some((b) => typeof b !== "string"))) {
    return { ok: false, reason: "bindRoles 非法（非空字符串数组）" };
  }
  return {
    ok: true,
    value: {
      id: d.id,
      parent: d.parent,
      execTool: d.execTool,
      ...(d.extraTools ? { extraTools: d.extraTools as string[] } : {}),
      ...(d.memoryScope !== undefined ? { memoryScope: d.memoryScope } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      ...(d.bindRoles ? { bindRoles: d.bindRoles as string[] } : {}),
    },
  };
}
