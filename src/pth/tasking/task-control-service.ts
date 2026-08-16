/**
 * tasking/task-control-service.ts — 任务控制服务（模块化 v2 P1-3）。
 *
 * publish 的 createdBy/tenantId 只从服务器端 TenantScope 派生；body 自报字段不可覆盖。
 * list/get 按 scope.tenantId 过滤（跨租户 get 返回 null、list 为空——路由 JSON 形状不变）。
 */

import type pg from "pg";
import type { Task, TaskStore } from "../kernel/storage/task-store-pg.js";
import type { PublishInput } from "../kernel/storage/task-store-pg.js";
import type { TenantScope } from "../contracts/index.js";
import { PgTaskQueries } from "./task-queries.js";

export interface TaskControlServiceDeps {
  store: Pick<TaskStore, "publish">;
  pool: pg.Pool;
  queries: PgTaskQueries;
}

export class TaskControlService {
  constructor(private deps: TaskControlServiceDeps) {}

  async publish(
    input: Omit<PublishInput, "createdBy" | "tenantId"> & { createdBy?: string; tenantId?: string },
    scope: TenantScope,
  ): Promise<Task> {
    // P1-3：服务器端盖章——body 里的 createdBy/tenantId 一律丢弃。
    const { createdBy: _createdBy, tenantId: _tenantId, ...rest } = input;
    return this.deps.store.publish({ ...rest, createdBy: scope.principalId, tenantId: scope.tenantId });
  }

  /** 观测列表（全部状态、created_at 倒序）——保持 gateway 既有 JSON 形状，仅加租户过滤 */
  async list(scope: TenantScope, limit: number): Promise<Array<Record<string, unknown>>> {
    const res = await this.deps.pool.query(
      `SELECT id, title, text, tags, status, claimed_by, claims_count, created_at, payload
       FROM tasks WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [scope.tenantId, Math.min(Math.max(limit, 1), 200)],
    );
    return res.rows as Array<Record<string, unknown>>;
  }

  async get(scope: TenantScope, id: string): Promise<Record<string, unknown> | null> {
    const res = await this.deps.pool.query("SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2", [id, scope.tenantId]);
    return (res.rows[0] as Record<string, unknown> | undefined) ?? null;
  }
}
