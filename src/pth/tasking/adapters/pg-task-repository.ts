/**
 * tasking/adapters/pg-task-repository.ts — 任务仓库 PG 适配器（模块化 v2 P1-2）。
 *
 * 把 contracts 层的 TaskRepository 端口落到 tasks 表：
 *  - claim：tenant + assigned_role + status=pending 过滤，事务内 FOR UPDATE SKIP LOCKED
 *    抢占；生成 UUID lease，generation 单调递增，expires_at = now + leaseTtlMs；
 *    claimed_by/claims_count/claimed_at 保留为诊断字段，不作为授权依据。
 *  - commit：CAS（id + lease_id + lease_generation + status='claimed'），重复/过期/跨租户
 *    outcome 一律 committed:false。
 *  - recoverExpired：只清 lease_expires_at 过期的 claimed 行，generation 不回退。
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "../../kernel/storage/pg.js";
import {
  buildCompletedResultWriteback,
  buildErrorResultWriteback,
  TASK_MAX_CLAIMS,
} from "../../contracts/index.js";
import type {
  TaskLease,
  TaskOutcome,
  TaskRepository,
  TaskWorkItem,
  TenantScope,
} from "../../contracts/index.js";
import { readWorkItemDomainBinding, readWorkItemDomains } from "../task-work-item-reader.js";
import type { TaskOutcomeCommitOptions, TaskOutcomeSideEffect } from "../task-outcome-committer.js";

export interface PgTaskRepositoryOptions {
  /** 新 lease 有效期（默认 10 分钟——与旧 claim 超时余量一致，可由调度器覆盖） */
  leaseTtlMs?: number;
  /** 时钟注入（测试/过期语义确定性） */
  clock?: () => Date;
}

export type PgTaskRepository = TaskRepository;

interface ClaimRow {
  id: string;
  tenant_id: string;
  title: string;
  text: string;
  tags: string[] | null;
  payload: unknown;
  assigned_role: string;
  lease_generation: string | number | null;
}

/** R4/P0-4：在同一 PG 事务内写入 side_effect_outbox（key 幂等，首写生效）。 */
async function insertSideEffects(
  client: pg.PoolClient,
  sideEffects?: ReadonlyArray<TaskOutcomeSideEffect>,
): Promise<void> {
  if (!sideEffects || sideEffects.length === 0) return;
  for (const se of sideEffects) {
    await client.query(
      `INSERT INTO side_effect_outbox (key, tenant_id, kind, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [se.key, se.tenantId, se.kind, JSON.stringify(se.payload ?? {})],
    );
  }
}

function toWorkItem(row: ClaimRow, scope: TenantScope): TaskWorkItem {
  const domains = readWorkItemDomains(row.payload);
  const domainBinding = readWorkItemDomainBinding(row.payload, domains);
  return {
    taskId: row.id,
    scope,
    title: row.title,
    text: row.text,
    tags: row.tags ?? [],
    payload: row.payload,
    assignedRole: row.assigned_role,
    domains,
    ...(domainBinding ? { domainBinding } : {}),
  };
}

function toLease(row: ClaimRow, scope: TenantScope, leaseId: string, generation: number, expiresAt: Date): TaskLease {
  return {
    taskId: row.id,
    leaseId,
    generation,
    scope,
    roleId: row.assigned_role,
    workspace: { tenantId: scope.tenantId, workspaceId: `task:${row.id}`, taskId: row.id },
    deadlineAt: expiresAt.toISOString(),
  };
}

export function createPgTaskRepository(pool: pg.Pool, opts: PgTaskRepositoryOptions = {}): PgTaskRepository {
  const leaseTtlMs = opts.leaseTtlMs ?? 10 * 60_000;
  const now = opts.clock ?? (() => new Date());

  return {
    async claim(scope, roleId, taskIds) {
      if (taskIds.length === 0) return [];
      return withTx(pool, async (client) => {
        const sel = await client.query(
          `SELECT id, tenant_id, title, text, tags, payload, assigned_role, lease_generation
           FROM tasks
           WHERE id = ANY($1::text[])
             AND tenant_id = $2
             AND assigned_role = $3
             AND status = 'pending'
             AND claims_count < $4
           ORDER BY id
           FOR UPDATE SKIP LOCKED`,
          [taskIds, scope.tenantId, roleId, TASK_MAX_CLAIMS],
        );
        if (sel.rows.length === 0) return [];
        const rows = sel.rows as unknown as ClaimRow[];
        const claimed: Array<{ lease: TaskLease; work: TaskWorkItem }> = [];
        for (const row of rows) {
          const leaseId = randomUUID();
          const generation = Number(row.lease_generation ?? 0) + 1;
          const expiresAt = new Date(now().getTime() + leaseTtlMs);
          await client.query(
            `UPDATE tasks SET
               status = 'claimed',
               claimed_by = $1,
               claims_count = claims_count + 1,
               claimed_at = now(),
               lease_id = $2,
               lease_generation = $3,
               lease_expires_at = $4,
               updated_at = now()
             WHERE id = $5 AND status = 'pending'`,
            [scope.principalId, leaseId, generation, expiresAt, row.id],
          );
          claimed.push({ lease: toLease(row, scope, leaseId, generation, expiresAt), work: toWorkItem(row, scope) });
        }
        return claimed;
      });
    },

    async recoverExpired(nowArg) {
      const res = await pool.query(
        `UPDATE tasks SET
           status = 'pending',
           claimed_by = NULL,
           claimed_at = NULL,
           lease_id = NULL,
           lease_expires_at = NULL,
           updated_at = now()
         WHERE status = 'claimed'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < $1`,
        [nowArg],
      );
      return res.rowCount ?? 0;
    },

    async commit(outcome: TaskOutcome, opts?: TaskOutcomeCommitOptions) {
      const { taskId, leaseId, generation } = outcome.lease;
      let res: pg.QueryResult;
      if (outcome.status === "completed") {
        // W8 P0 终态回写：payload.result = JSON-safe 编码结果（≤64KiB/截断标记）；
        // done 声明产物时同步写 payload.delivery.artifactRef（不覆盖 path/lineageId 已有章）。
        // R4/P0-4：side-effect enqueue 与 task CAS commit 同一事务。
        const { result, artifactRef } = buildCompletedResultWriteback(outcome.result, outcome.artifacts);
        res = await withTx(pool, async (client) => {
          const upd = await client.query(
            `UPDATE tasks SET
               status = 'completed',
               submitted_at = now(),
               completed_at = now(),
               updated_at = now(),
               payload = jsonb_set(
                 jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', $4::jsonb, true),
                 '{outputRef}', $5::jsonb, true)
             WHERE id = $1 AND lease_id = $2 AND lease_generation = $3 AND status = 'claimed'`,
            [taskId, leaseId, generation, JSON.stringify(result), JSON.stringify({ ref: result })],
          );
          if ((upd.rowCount ?? 0) > 0 && artifactRef) {
            await client.query(
              `UPDATE tasks SET
                 payload = jsonb_set(
                   jsonb_set(payload, '{delivery}', COALESCE(payload->'delivery', '{}'::jsonb), true),
                   '{delivery,artifactRef}', $4::jsonb, true),
                 updated_at = now()
               WHERE id = $1 AND lease_id = $2 AND lease_generation = $3 AND status = 'completed'`,
              [taskId, leaseId, generation, JSON.stringify(artifactRef)],
            );
          }
          await insertSideEffects(client, opts?.sideEffects);
          return upd;
        });
      } else if (outcome.retryable === true) {
        if (opts?.sideEffects?.length) {
          res = await withTx(pool, async (client) => {
            const upd = await client.query(
              `UPDATE tasks SET
                 status = 'pending',
                 claimed_by = NULL,
                 claimed_at = NULL,
                 lease_id = NULL,
                 lease_expires_at = NULL,
                 updated_at = now()
               WHERE id = $1 AND lease_id = $2 AND lease_generation = $3 AND status = 'claimed'`,
              [taskId, leaseId, generation],
            );
            await insertSideEffects(client, opts.sideEffects);
            return upd;
          });
        } else {
          res = await pool.query(
            `UPDATE tasks SET
               status = 'pending',
               claimed_by = NULL,
               claimed_at = NULL,
               lease_id = NULL,
               lease_expires_at = NULL,
               updated_at = now()
             WHERE id = $1 AND lease_id = $2 AND lease_generation = $3 AND status = 'claimed'`,
            [taskId, leaseId, generation],
          );
        }
      } else {
        // W8 P0：终态失败回写——payload.result = { error: {code,message} }（父 await 的错误摘要）
        const { result } = buildErrorResultWriteback(
          outcome.error,
          outcome.status === "cancelled" ? "任务已取消" : "任务被拒绝",
        );
        if (opts?.sideEffects?.length) {
          res = await withTx(pool, async (client) => {
            const upd = await client.query(
              `UPDATE tasks SET
                 status = 'rejected',
                 escalated_at = CASE WHEN $4::text = 'cancelled' THEN now() ELSE escalated_at END,
                 payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', $5::jsonb, true),
                 updated_at = now()
               WHERE id = $1 AND lease_id = $2 AND lease_generation = $3 AND status = 'claimed'`,
              [taskId, leaseId, generation, outcome.status, JSON.stringify(result)],
            );
            await insertSideEffects(client, opts.sideEffects);
            return upd;
          });
        } else {
          res = await pool.query(
            `UPDATE tasks SET
               status = 'rejected',
               escalated_at = CASE WHEN $4::text = 'cancelled' THEN now() ELSE escalated_at END,
               payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', $5::jsonb, true),
               updated_at = now()
             WHERE id = $1 AND lease_id = $2 AND lease_generation = $3 AND status = 'claimed'`,
            [taskId, leaseId, generation, outcome.status, JSON.stringify(result)],
          );
        }
      }
      return { committed: (res.rowCount ?? 0) > 0 };
    },
  };
}
