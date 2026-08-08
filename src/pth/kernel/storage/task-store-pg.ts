import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "./pg.js";
import { routeTaskRole } from "../execution/role-router.js";

/** 单任务最大认领次数（防坏任务无限 claim→reject 空转的兜底） */
export const MAX_CLAIMS = 10;

export interface Task {
  id: string;
  title: string;
  text: string;
  tags: string[];
  status: string;
  claimed_by: string | null;
  claims_count: number;
  created_at: Date;
  payload: unknown;
  assigned_role?: string | null;
}

export interface PublishInput {
  title: string;
  text: string;
  createdBy: string;
  tags?: string[];
  payload?: unknown;
  templateId?: string;
}

export interface TaskStore {
  candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]>;
  claimTopN(agentId: string, ids: string[]): Promise<Task[]>;
  reject(agentId: string, taskId: string, reason: string, opts?: { terminal?: boolean }): Promise<void>;
  submit(agentId: string, taskId: string, outputRef: unknown): Promise<void>;
  publish(input: PublishInput): Promise<Task>;
  // 跨 spec 扩展（plan Task 5 标注）：负载统计 collectStats 依赖 pending 队列长度。
  countPending(): Promise<number>;
}

export class PgTaskStore implements TaskStore {
  constructor(private pool: pg.Pool) {}

  async publish(input: PublishInput): Promise<Task> {
    // 任务分配正交化：应用层生成 id（crypto.randomUUID）→ routeTaskRole 确定性路由
    // （flow 显式 role / tags 语义 / hash 分片兜底）——assigned_role 从出生即确定，零抢票。
    const id = randomUUID();
    const assignedRole = routeTaskRole({ id, tags: input.tags, payload: input.payload });
    const res = await this.pool.query(
      `INSERT INTO tasks (id, title, text, created_by, tags, payload, template_id, assigned_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [id, input.title, input.text, input.createdBy, input.tags ?? [], input.payload ?? {}, input.templateId ?? null, assignedRole],
    );
    return mapRow(res.rows[0]);
  }

  async candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]> {
    // 任务分配正交化：只查自己队列（assigned_role = 自己）——零竞争零抢票。
    // claims_count < MAX_CLAIMS：坏任务（terminal reject 被绕过）不占队列。
    const res = await this.pool.query(
      `SELECT * FROM tasks
       WHERE status = 'pending'
         AND assigned_role = $1
         AND claims_count < $2
       ORDER BY created_at
       LIMIT $3`,
      [agentId, MAX_CLAIMS, opts?.limit ?? 10],
    );
    return res.rows.map(mapRow);
  }

  async claimTopN(agentId: string, ids: string[]): Promise<Task[]> {
    // 并发原子认领：事务内先 SELECT ... FOR UPDATE SKIP LOCKED 抢占（跳过已被其他事务锁定的行，
    // 不阻塞等待），再 UPDATE 回写。两个并发 claimTopN 抢同一任务时只有一个能锁到行 → 只认领成功一个。
    // 防御：claims_count >= MAX_CLAIMS 不再认领——即使 terminal reject 被绕过，坏任务最多空转 N 次。
    return withTx(this.pool, async (client) => {
      const sel = await client.query(
        `SELECT id FROM tasks
         WHERE id = ANY($1::text[])
           AND status = 'pending'
           AND (claimed_by IS NULL OR claimed_by = $2)
           AND claims_count < $3
         ORDER BY id
         FOR UPDATE SKIP LOCKED`,
        [ids, agentId, MAX_CLAIMS],
      );
      if (sel.rows.length === 0) return [];
      const lockedIds = (sel.rows as Array<{ id: string }>).map((r) => r.id);
      const upd = await client.query(
        `UPDATE tasks SET
           status = 'claimed',
           claimed_by = $1,
           claims_count = claims_count + 1,
           claimed_at = now(),
           updated_at = now()
         WHERE id = ANY($2::text[])
         RETURNING *`,
        [agentId, lockedIds],
      );
      return upd.rows.map(mapRow);
    });
  }

  async countPending(): Promise<number> {
    // count(*) 返回 int8 → node-postgres 解析为字符串，必须 Number() 转换（见 Task 1 ledger minor）。
    // 排除冻结坏任务（claims_count >= MAX_CLAIMS——永远不会被执行，不应阻塞自动缩容）。
    const res = await this.pool.query(
      `SELECT count(*) FROM tasks WHERE status = 'pending' AND claims_count < $1`,
      [MAX_CLAIMS],
    );
    // count(*) 返回 int8 → node-postgres 解析为字符串，必须 Number() 转换（见 Task 1 ledger minor）。
    return Number((res.rows[0] as { count: string }).count);
  }

  async reject(agentId: string, taskId: string, reason: string, opts: { terminal?: boolean } = {}): Promise<void> {
    // 允许拒绝：未认领（claimed_by IS NULL）或本人已认领的任务；记录原因并释放认领。
    // terminal=true：坏任务终态化（status='rejected' 不回池）——执行失败（语法/崩溃）的任务
    // 永远无法成功，回池会导致无限 claim→reject 空转（摸底实测 claims_count=252）。
    // 默认（assessed-as-unfit 等软失败）：回到 pending（保持既有语义）。
    await this.pool.query(
      `UPDATE tasks SET
         status = ${opts.terminal ? "'rejected'" : "'pending'"},
         claimed_by = NULL,
         rejects = rejects || $3::jsonb,
         updated_at = now()
       WHERE id = $1 AND (claimed_by IS NULL OR claimed_by = $2)`,
      [taskId, agentId, JSON.stringify([{ agentId, reason, at: Date.now() }])],
    );
  }

  async submit(agentId: string, taskId: string, outputRef: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET
         status = 'completed',
         submitted_at = now(),
         completed_at = now(),
         updated_at = now(),
         payload = payload || jsonb_build_object('outputRef', $3::jsonb)
       WHERE id = $1 AND claimed_by = $2`,
      [taskId, agentId, JSON.stringify(outputRef)],
    );
  }
}

function mapRow(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    tags: row.tags ?? [],
    status: row.status,
    claimed_by: row.claimed_by,
    claims_count: row.claims_count,
    created_at: row.created_at,
    payload: row.payload,
    assigned_role: row.assigned_role ?? null,
  };
}
