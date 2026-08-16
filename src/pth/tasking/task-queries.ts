/**
 * tasking/task-queries.ts — 任务读模型 PG 实现（模块化 v2 P1-3）。
 *
 * 所有查询显式携带 TenantScope：get/list 的租户过滤由 scope.tenantId 驱动，
 * 不存在无租户条件的跨租户读路径。
 */

import type pg from "pg";
import { TASK_MAX_CLAIMS, type TaskReadModel, type TaskWorkItem, type TenantScope } from "../contracts/index.js";
import { toTaskWorkItem, type TaskWorkRow } from "./task-work-item-reader.js";

const QUERY_SCOPE: TenantScope = { tenantId: "default", principalId: "system:query", roles: ["system"], traceId: "query" };

export class PgTaskQueries implements TaskReadModel {
  constructor(private pool: pg.Pool) {}

  async pending(opts: { roleId?: string; tenantId?: string; limit?: number; scope?: TenantScope } = {}): Promise<readonly TaskWorkItem[]> {
    const scope = opts.scope ?? { ...QUERY_SCOPE, tenantId: opts.tenantId ?? QUERY_SCOPE.tenantId };
    const conds = ["status = 'pending'", "tenant_id = $1", `claims_count < ${TASK_MAX_CLAIMS}`];
    const params: unknown[] = [scope.tenantId];
    if (opts.roleId) {
      params.push(opts.roleId);
      conds.push(`assigned_role = $${params.length}`);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    params.push(limit);
    const res = await this.pool.query(
      `SELECT id, tenant_id, title, text, tags, payload, assigned_role
       FROM tasks WHERE ${conds.join(" AND ")}
       ORDER BY created_at LIMIT $${params.length}`,
      params,
    );
    return (res.rows as unknown as TaskWorkRow[]).map((row) => toTaskWorkItem(row, scope));
  }

  async get(taskId: string, scope: TenantScope): Promise<TaskWorkItem | null> {
    const res = await this.pool.query(
      `SELECT id, tenant_id, title, text, tags, payload, assigned_role
       FROM tasks WHERE id = $1 AND tenant_id = $2`,
      [taskId, scope.tenantId],
    );
    const row = res.rows[0] as TaskWorkRow | undefined;
    return row ? toTaskWorkItem(row, scope) : null;
  }
}
