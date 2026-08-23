/**
 * interaction/human-interaction-repository.ts — 人工交互持久化端口 + PG 实现。
 *
 * 不依赖 AgentEngine；基于 pg 事务实现 HumanRequest / TaskWaitGate / tasks 状态迁移。
 * 幂等与 CAS：respond 使用状态谓词（status='pending'）更新，重复相同 response 幂等，
 * 并发相反决定返回 conflict。
 */

import type pg from "pg";
import { withTx } from "@away_from/pth-kernel-storage";
import type {
  ApprovalDecision,
  HumanRequest,
  HumanResponse,
  HumanResponseResult,
} from "@away_from/pth-contracts";
import {
  isApprovalDecision,
  isHumanRequestStructurallyValid,
} from "@away_from/pth-contracts";

export interface CreateHumanRequestInput {
  id: string;
  tenantId: string;
  taskId: string;
  kind: string;
  title: string;
  body: string;
  assignedTo: readonly string[];
  policySelector?: string;
  createdBy: string;
  expiresAt?: string;
  idempotencyKey?: string;
}

export interface RespondHumanRequestInput {
  requestId: string;
  decision: ApprovalDecision;
  reason?: string;
  principalId: string;
  idempotencyKey?: string;
}

export interface ListHumanRequestsFilter {
  tenantId: string;
  status?: string;
  limit?: number;
}

export interface HumanInteractionRepository {
  createRequest(input: CreateHumanRequestInput): Promise<HumanRequest>;
  listRequests(filter: ListHumanRequestsFilter): Promise<HumanRequest[]>;
  getRequest(id: string, tenantId: string): Promise<HumanRequest | null>;
  respond(input: RespondHumanRequestInput, tenantId: string): Promise<HumanResponseResult>;
  cancelRequest(id: string, tenantId: string, principalId: string): Promise<HumanRequest | null>;
}

function mapRow(row: any): HumanRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    assignedTo: row.assigned_to ?? [],
    ...(row.policy_selector ? { policySelector: row.policy_selector } : {}),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at } : {}),
    ...(row.response ? { response: row.response } : {}),
  };
}

export class PgHumanInteractionRepository implements HumanInteractionRepository {
  constructor(private pool: pg.Pool) {}

  async createRequest(input: CreateHumanRequestInput): Promise<HumanRequest> {
    return withTx(this.pool, async (client) => {
      const task = await client.query(`SELECT id, tenant_id FROM tasks WHERE id = $1`, [input.taskId]);
      if (task.rows.length === 0) {
        const err = new Error(`task not found: ${input.taskId}`) as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      const taskTenant = (task.rows[0] as any).tenant_id as string;
      if (taskTenant !== input.tenantId) {
        const err = new Error("cross-tenant human request rejected") as Error & { statusCode?: number };
        err.statusCode = 403;
        throw err;
      }
      const res = await client.query(
        `INSERT INTO human_requests
           (id, tenant_id, task_id, kind, title, body, assigned_to, policy_selector,
            created_by, expires_at, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          input.id, input.tenantId, input.taskId, input.kind, input.title, input.body,
          [...input.assignedTo],
          input.policySelector ?? null,
          input.createdBy,
          input.expiresAt ? new Date(input.expiresAt) : null,
          input.idempotencyKey ?? null,
        ],
      );
      await client.query(
        `INSERT INTO task_wait_gates (task_id, request_id)
         VALUES ($1,$2)
         ON CONFLICT (task_id) DO UPDATE SET request_id = EXCLUDED.request_id, status = 'waiting', decision = NULL, resolved_at = NULL`,
        [input.taskId, input.id],
      );
      await client.query(
        `UPDATE tasks SET status = 'waiting-human', claimed_by = NULL, claimed_at = NULL, lease_id = NULL
         WHERE id = $1`,
        [input.taskId],
      );
      return mapRow(res.rows[0] as any);
    });
  }

  async listRequests(filter: ListHumanRequestsFilter): Promise<HumanRequest[]> {
    const params: unknown[] = [filter.tenantId];
    let sql = `SELECT * FROM human_requests WHERE tenant_id = $1`;
    if (filter.status) {
      params.push(filter.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    const res = await this.pool.query(sql, params);
    return res.rows.map((r: any) => mapRow(r));
  }

  async getRequest(id: string, tenantId: string): Promise<HumanRequest | null> {
    const res = await this.pool.query(
      `SELECT * FROM human_requests WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return res.rows.length > 0 ? mapRow(res.rows[0] as any) : null;
  }

  async respond(input: RespondHumanRequestInput, tenantId: string): Promise<HumanResponseResult> {
    if (!isApprovalDecision(input.decision)) {
      const err = new Error(`decision must be approved|rejected`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    return withTx(this.pool, async (client) => {
      // 幂等/冲突预检：若已 responded，同 decision+principal 视为幂等成功，否则 conflict。
      const existing = await client.query(
        `SELECT * FROM human_requests WHERE id = $1 AND tenant_id = $2`,
        [input.requestId, tenantId],
      );
      if (existing.rows.length === 0) {
        const err = new Error(`human request not found: ${input.requestId}`) as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      const row = existing.rows[0] as any;
      if (row.status === "responded") {
        const prev = row.response as HumanResponse | undefined;
        if (
          prev &&
          prev.decision === input.decision &&
          prev.principalId === input.principalId &&
          (input.idempotencyKey === undefined || prev.idempotencyKey === input.idempotencyKey)
        ) {
          return {
            requestId: input.requestId,
            status: "responded",
            decision: input.decision,
            taskStatus: input.decision === "approved" ? "pending" : "rejected",
            committed: true,
          };
        }
        const err = new Error(`human request ${input.requestId} already responded（并发相反决定冲突）`) as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      if (row.status !== "pending") {
        const err = new Error(`human request ${input.requestId} not pending (${row.status})`) as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      const response: HumanResponse = {
        requestId: input.requestId,
        decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        principalId: input.principalId,
        respondedAt: new Date().toISOString(),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      const upd = await client.query(
        `UPDATE human_requests
         SET status = 'responded', response = $3::jsonb
         WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
         RETURNING *`,
        [input.requestId, tenantId, JSON.stringify(response)],
      );
      if (upd.rows.length === 0) {
        const err = new Error(`human request ${input.requestId} 并发更新冲突`) as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      const gate = await client.query(
        `UPDATE task_wait_gates
         SET status = 'resolved', decision = $2, resolved_at = now()
         WHERE request_id = $1 AND status = 'waiting'
         RETURNING task_id`,
        [input.requestId, input.decision],
      );
      const gateRow = gate.rows[0] as { task_id?: string } | undefined;
      const taskId = gateRow?.task_id;
      if (!taskId) {
        const err = new Error(`human request ${input.requestId} 没有 waiting gate`) as Error & { statusCode?: number };
        err.statusCode = 409;
        throw err;
      }
      const taskStatus = input.decision === "approved" ? "pending" : "rejected";
      await client.query(
        `UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1`,
        [taskId, taskStatus],
      );
      return {
        requestId: input.requestId,
        status: "responded",
        decision: input.decision,
        taskStatus,
        committed: true,
      };
    });
  }

  async cancelRequest(id: string, tenantId: string, principalId: string): Promise<HumanRequest | null> {
    return withTx(this.pool, async (client) => {
      const upd = await client.query(
        `UPDATE human_requests
         SET status = 'cancelled'
         WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
         RETURNING *`,
        [id, tenantId],
      );
      if (upd.rows.length === 0) return null;
      const gate = await client.query(
        `UPDATE task_wait_gates
         SET status = 'resolved', decision = NULL, resolved_at = now()
         WHERE request_id = $1 AND status = 'waiting'
         RETURNING task_id`,
        [id],
      );
      const gateRow = gate.rows[0] as { task_id?: string } | undefined;
      const taskId = gateRow?.task_id;
      if (taskId) {
        await client.query(
          `UPDATE tasks SET status = 'pending', updated_at = now() WHERE id = $1 AND status = 'waiting-human'`,
          [taskId],
        );
      }
      return mapRow(upd.rows[0] as any);
    });
  }
}
