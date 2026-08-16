/**
 * tasking/task-work-item-reader.ts — tasks 表行 → TaskWorkItem 映射（模块化 v2 P1-3）。
 *
 * pg-task-repository 与 pg-task-queries 共用同一映射，保证 claim/work 读取与查询面
 * 的 TaskWorkItem 形状一致；scope 永远由调用方（auth/claim 上下文）提供，不从行内派生。
 */

import type { TaskWorkItem, TenantScope } from "../contracts/index.js";

export interface TaskWorkRow {
  id: string;
  tenant_id: string;
  title: string;
  text: string;
  tags: string[] | null;
  payload: unknown;
  assigned_role: string | null;
}

export function toTaskWorkItem(row: TaskWorkRow, scope: TenantScope): TaskWorkItem {
  return {
    taskId: row.id,
    scope,
    title: row.title,
    text: row.text,
    tags: row.tags ?? [],
    payload: row.payload,
    assignedRole: row.assigned_role ?? "unknown",
  };
}
