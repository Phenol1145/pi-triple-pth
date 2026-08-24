/**
 * contracts/worker-kind.ts — 统一 LLM worker / code worker 的共享身份契约。
 *
 * WorkerKind 只描述“执行单元的类型”，不替代调度通道：
 *  - llm    → 走任务队列 / agent loop；
 *  - code   → 走 loop runtime / drainer / scheduler；
 *  - hybrid → 两者组合，可按场景选择入口。
 *
 * TaskTemplateHandoff 是模板层的建议字段：真实接手身份始终由路由与 Worker Registry 决定，
 * 模板只能给出“建议”，并且 `requiresApproval` 只能收紧、不能放松。
 */

export const WORKER_KINDS = ["llm", "code", "hybrid"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export interface TaskTemplateHandoff {
  /** 建议的下游角色；非权威，真实路由由 Registry/role-tag 决定。 */
  readonly nextRoleId?: string;
  /** 建议的下游 worker 类型；非权威，仅作展示/审计/默认建议。 */
  readonly nextWorkerKind?: WorkerKind;
  /** 只能收紧：真实路由不得因模板降低审批要求。 */
  readonly requiresApproval?: boolean;
}

export function isWorkerKind(v: unknown): v is WorkerKind {
  return typeof v === "string" && (WORKER_KINDS as readonly string[]).includes(v);
}

export function isTaskTemplateHandoffStructurallyValid(v: unknown): v is TaskTemplateHandoff {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  if (h.nextRoleId !== undefined && (typeof h.nextRoleId !== "string" || h.nextRoleId.trim() === "")) return false;
  if (h.nextWorkerKind !== undefined && !isWorkerKind(h.nextWorkerKind)) return false;
  if (h.requiresApproval !== undefined && typeof h.requiresApproval !== "boolean") return false;
  return true;
}
