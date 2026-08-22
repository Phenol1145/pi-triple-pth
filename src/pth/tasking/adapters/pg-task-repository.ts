/**
 * tasking/adapters/pg-task-repository.ts — 任务仓库 PG 适配器（模块化 v2 P1-2）。
 *
 * 把 contracts 层的 TaskRepository 端口落到 tasks 表：
 *  - claim：tenant + assigned_role + status=pending 过滤，事务内 FOR UPDATE SKIP LOCKED
 *    抢占；生成 UUID lease，generation 单调递增，expires_at = now + leaseTtlMs；
 *    claimed_by/claims_count/claimed_at 保留为诊断字段，不作为授权依据。
 *  - commit：CAS（id + lease_id + lease_generation + status='claimed' + tenant_id +
 *    未过期 lease_expires_at），重复/过期/跨租户 outcome 一律 committed:false。
 *  - recoverExpired：只清 lease_expires_at 过期的 claimed 行，generation 不回退。
 *
 * N29 L1（§1.3 P0-1 / §1.4 P0-2）：
 *  - 三条终态 CAS（completed / retry / rejected）都必须带 tenant_id 与
 *    `lease_expires_at IS NOT NULL AND lease_expires_at > now()`；
 *  - side effect 只在 `upd.rowCount === 1` 时于同一事务内 enqueue，CAS 未命中直接返回 upd；
 *  - 无法确定服务端 tenant scope 时 fail closed（committed:false，零 side effect）。
 *
 * N29 再验收 P0-1（docs/pth/n29-minimal-intake-reacceptance-feedback.md §3 P0-1 / §8 条件 1）：
 *  - side effect 的 outbox tenant **只由聚合上下文盖章**——三条 CAS 都 `RETURNING tenant_id`，
 *    用刚通过 CAS 的 `tasks.tenant_id` 落 outbox；调用方自报值不再是事实源；
 *  - 自报 tenant ≠ 聚合 tenant：开事务前 fail closed（committed:false，任一 tenant 零 outbox），
 *    事务内再加一道断言（抛错整体回滚）作为深度防御。
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "@away_from/pth-kernel-storage";
import {
  buildCompletedResultWriteback,
  buildErrorResultWriteback,
  hasForeignTenantSideEffect,
  isWorkMode,
  resolveTaskCommitTenantId,
  TASK_MAX_CLAIMS,
} from "@away_from/pth-contracts";
import type {
  TaskCommitOptions,
  TaskCommitSideEffect,
  TaskLease,
  TaskOutcome,
  TaskRepository,
  TaskWorkItem,
  TenantScope,
} from "@away_from/pth-contracts";
import { readWorkItemDomainBinding, readWorkItemDomains } from "../task-work-item-reader.js";
import { enqueueSideEffectInTx } from "@away_from/pth-kernel-storage";

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
  work_mode?: string | null;
}

/**
 * R4/P0-4 + N29/P0-1：在同一 PG 事务内写入 side_effect_outbox。
 * identity=(tenant_id,key)；exact 重放幂等，不同 kind/payload 抛 conflict 让整个 commit 回滚。
 * 只允许在 task CAS `rowCount === 1` 之后调用。
 *
 * N29 再验收 P0-1（feedback §3 P0-1 / §8 条件 1）：`stampedTenantId` 必须来自
 * **CAS RETURNING 的 `tasks.tenant_id`**——刚通过 CAS 的聚合自身 tenant，而不是调用方自报值。
 * 输入若自报不同 tenant，这里是第二道防线（抛错 → 整个事务回滚）；第一道在 `commit()` 开事务前。
 */
async function insertSideEffects(
  client: pg.PoolClient,
  stampedTenantId: string,
  sideEffects?: ReadonlyArray<TaskCommitSideEffect>,
): Promise<void> {
  if (!sideEffects || sideEffects.length === 0) return;
  for (const se of sideEffects) {
    if (se.tenantId !== undefined && se.tenantId !== stampedTenantId) {
      throw new Error(
        `task commit side effect "${se.key}" 自报 tenant "${se.tenantId}" 与聚合 tenant `
        + `"${stampedTenantId}" 不一致——跨 tenant 入队不允许（tenant 由仓库按聚合上下文盖章）`,
      );
    }
    await enqueueSideEffectInTx(client, {
      key: se.key,
      tenantId: stampedTenantId,
      kind: se.kind,
      payload: se.payload,
    });
  }
}

/** CAS RETURNING 行里的聚合 tenant（唯一合法盖章来源）；取不到即当作 CAS 未命中处理。 */
function stampedTenantOf(upd: pg.QueryResult): string | null {
  const value = (upd.rows[0] as { tenant_id?: unknown } | undefined)?.tenant_id;
  return typeof value === "string" && value !== "" ? value : null;
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
    workMode: isWorkMode(row.work_mode) ? row.work_mode : "run",
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
          `SELECT id, tenant_id, title, text, tags, payload, assigned_role, lease_generation, work_mode
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

    async commit(outcome: TaskOutcome, opts?: TaskCommitOptions) {
      const { taskId, leaseId, generation } = outcome.lease;
      // N29 P0-2：tenant scope 必须由服务端盖章（dispatcher 从 claim lease 取；或完整 lease 自带 scope）。
      // 拿不到 tenant 就 fail closed——不提交、不写任何 side effect。
      const tenantId = resolveTaskCommitTenantId(outcome, opts);
      if (tenantId === null) return { committed: false };
      // N29 再验收 P0-1：side effect 的 tenant 只能由聚合上下文盖章。调用方自报不同 tenant =
      // 编排缺陷或跨租户越权：开事务前 fail closed（零领域写、零 outbox、任一 tenant 都不落行）。
      if (hasForeignTenantSideEffect(tenantId, opts?.sideEffects)) return { committed: false };
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
             WHERE id = $1 AND lease_id = $2 AND lease_generation = $3
               AND status = 'claimed'
               AND tenant_id = $6
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at > now()
             RETURNING tenant_id`,
            [taskId, leaseId, generation, JSON.stringify(result), JSON.stringify({ ref: result }), tenantId],
          );
          // N29 P0-1：CAS 未命中（错 generation/过期 lease/跨 tenant/重复提交）→ 立即返回，
          // 不写 side effect、不推进下一阶段。
          if ((upd.rowCount ?? 0) !== 1) return upd;
          if (artifactRef) {
            await client.query(
              `UPDATE tasks SET
                 payload = jsonb_set(
                   jsonb_set(payload, '{delivery}', COALESCE(payload->'delivery', '{}'::jsonb), true),
                   '{delivery,artifactRef}', $4::jsonb, true),
                 updated_at = now()
               WHERE id = $1 AND lease_id = $2 AND lease_generation = $3
                 AND status = 'completed'
                 AND tenant_id = $5`,
              [taskId, leaseId, generation, JSON.stringify(artifactRef), tenantId],
            );
          }
          // N29 再验收 P0-1：盖章 tenant 取自 CAS RETURNING 的聚合行，不是调用方输入。
          const stamped = stampedTenantOf(upd);
          if (stamped === null) return { ...upd, rowCount: 0 } as pg.QueryResult;
          await insertSideEffects(client, stamped, opts?.sideEffects);
          return upd;
        });
      } else if (outcome.retryable === true) {
        res = await withTx(pool, async (client) => {
          const upd = await client.query(
            `UPDATE tasks SET
               status = 'pending',
               claimed_by = NULL,
               claimed_at = NULL,
               lease_id = NULL,
               lease_expires_at = NULL,
               updated_at = now()
             WHERE id = $1 AND lease_id = $2 AND lease_generation = $3
               AND status = 'claimed'
               AND tenant_id = $4
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at > now()
             RETURNING tenant_id`,
            [taskId, leaseId, generation, tenantId],
          );
          if ((upd.rowCount ?? 0) !== 1) return upd;
          // N29 再验收 P0-1：盖章 tenant 取自 CAS RETURNING 的聚合行，不是调用方输入。
          const stamped = stampedTenantOf(upd);
          if (stamped === null) return { ...upd, rowCount: 0 } as pg.QueryResult;
          await insertSideEffects(client, stamped, opts?.sideEffects);
          return upd;
        });
      } else {
        // W8 P0：终态失败回写——payload.result = { error: {code,message} }（父 await 的错误摘要）
        const { result } = buildErrorResultWriteback(
          outcome.error,
          outcome.status === "cancelled" ? "任务已取消" : "任务被拒绝",
        );
        res = await withTx(pool, async (client) => {
          const upd = await client.query(
            `UPDATE tasks SET
               status = 'rejected',
               escalated_at = CASE WHEN $4::text = 'cancelled' THEN now() ELSE escalated_at END,
               payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', $5::jsonb, true),
               updated_at = now()
             WHERE id = $1 AND lease_id = $2 AND lease_generation = $3
               AND status = 'claimed'
               AND tenant_id = $6
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at > now()
             RETURNING tenant_id`,
            [taskId, leaseId, generation, outcome.status, JSON.stringify(result), tenantId],
          );
          if ((upd.rowCount ?? 0) !== 1) return upd;
          // N29 再验收 P0-1：盖章 tenant 取自 CAS RETURNING 的聚合行，不是调用方输入。
          const stamped = stampedTenantOf(upd);
          if (stamped === null) return { ...upd, rowCount: 0 } as pg.QueryResult;
          await insertSideEffects(client, stamped, opts?.sideEffects);
          return upd;
        });
      }
      return { committed: (res.rowCount ?? 0) > 0 };
    },
  };
}
