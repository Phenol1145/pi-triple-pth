/**
 * tasking/task-work-item-reader.ts — tasks 表行 → TaskWorkItem 映射（模块化 v2 P1-3）。
 *
 * pg-task-repository 与 pg-task-queries 共用同一映射，保证 claim/work 读取与查询面
 * 的 TaskWorkItem 形状一致；scope 永远由调用方（auth/claim 上下文）提供，不从行内派生。
 *
 * K2 Phase 2：payload.domains / payload.domainBinding 是服务器 resolver 的盖章产物；
 * 读取侧只做结构合法性判定——非法 domains 一律回退空数组，非法 binding 一律省略。
 */

import {
  validateDomainBinding,
  type DomainBinding,
  type DomainId,
} from "@away_from/pth-contracts";
import { isWorkMode, type TaskWorkItem, type TenantScope, type WorkMode } from "@away_from/pth-contracts";

export interface TaskWorkRow {
  id: string;
  tenant_id: string;
  title: string;
  text: string;
  tags: string[] | null;
  payload: unknown;
  assigned_role: string | null;
  work_mode?: string | null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function parseDomains(payload: unknown): DomainId[] | null {
  if (!isPlainRecord(payload)) return null;
  const raw = payload["domains"];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return null;
  return [...new Set(raw as string[])].sort((a, b) => a.localeCompare(b));
}

/** payload.domains 为字符串数组 → 去重排序；否则空数组（结构非法不伪造）。 */
export function readWorkItemDomains(payload: unknown): DomainId[] {
  return parseDomains(payload) ?? [];
}

/** payload.domainBinding 结构合法 → 返回；否则 undefined（缺失/非法同语义：省略）。 */
export function readWorkItemDomainBinding(
  payload: unknown,
  domains: readonly DomainId[],
): DomainBinding | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const raw = payload["domainBinding"];
  if (raw === undefined) return undefined;
  const check = validateDomainBinding(raw as DomainBinding, new Set(domains));
  return check.ok ? (raw as DomainBinding) : undefined;
}

function parseWorkMode(v: unknown): WorkMode {
  return isWorkMode(v) ? v : "run";
}

export function toTaskWorkItem(row: TaskWorkRow, scope: TenantScope): TaskWorkItem {
  const domains = readWorkItemDomains(row.payload);
  const domainBinding = readWorkItemDomainBinding(row.payload, domains);
  return {
    taskId: row.id,
    scope,
    title: row.title,
    text: row.text,
    tags: row.tags ?? [],
    payload: row.payload,
    assignedRole: row.assigned_role ?? "unknown",
    domains,
    workMode: parseWorkMode(row.work_mode),
    ...(domainBinding ? { domainBinding } : {}),
  };
}
