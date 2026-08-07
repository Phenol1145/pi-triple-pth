import type pg from "pg";
import { withTx } from "./pg.js";

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
  reject(agentId: string, taskId: string, reason: string): Promise<void>;
  submit(agentId: string, taskId: string, outputRef: unknown): Promise<void>;
  publish(input: PublishInput): Promise<Task>;
  // 跨 spec 扩展（plan Task 5 标注）：负载统计 collectStats 依赖 pending 队列长度。
  countPending(): Promise<number>;
}

export class PgTaskStore implements TaskStore {
  constructor(private pool: pg.Pool) {}

  async publish(input: PublishInput): Promise<Task> {
    // gen_random_uuid() 在 PG 13+ 内置（无需 pgcrypto），PG16 已验证可用
    const res = await this.pool.query(
      `INSERT INTO tasks (id, title, text, created_by, tags, payload, template_id)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.title, input.text, input.createdBy, input.tags ?? [], input.payload ?? {}, input.templateId ?? null],
    );
    return mapRow(res.rows[0]);
  }

  async candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]> {
    // v1 简化：不按标签过滤（tasks.tags 与模板 label_patterns 的匹配语义交给 TaskLoop assess 阶段智能判断，
    // 见 Spec B 设计）；返回全部 pending 任务。agentId 预留用于 v2 的按 agent 匹配/reject 排除。
    const res = await this.pool.query(
      `SELECT * FROM tasks
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT $1`,
      [opts?.limit ?? 10],
    );
    return res.rows.map(mapRow);
  }

  async claimTopN(agentId: string, ids: string[]): Promise<Task[]> {
    // 并发原子认领：事务内先 SELECT ... FOR UPDATE SKIP LOCKED 抢占（跳过已被其他事务锁定的行，
    // 不阻塞等待），再 UPDATE 回写。两个并发 claimTopN 抢同一任务时只有一个能锁到行 → 只认领成功一个。
    return withTx(this.pool, async (client) => {
      const sel = await client.query(
        `SELECT id FROM tasks
         WHERE id = ANY($1::text[])
           AND status = 'pending'
           AND (claimed_by IS NULL OR claimed_by = $2)
         ORDER BY id
         FOR UPDATE SKIP LOCKED`,
        [ids, agentId],
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
    const res = await this.pool.query(`SELECT count(*) FROM tasks WHERE status = 'pending'`);
    // count(*) 返回 int8 → node-postgres 解析为字符串，必须 Number() 转换（见 Task 1 ledger minor）。
    return Number((res.rows[0] as { count: string }).count);
  }

  async reject(agentId: string, taskId: string, reason: string): Promise<void> {
    // 允许拒绝：未认领（claimed_by IS NULL）或本人已认领的任务；记录原因并释放认领（回到 pending）。
    // 骨架里 `claimed_by = $2` 的严格匹配会让「未认领先 reject」的测试失败（brief 测试直接对 pending 任务 reject），故放宽。
    await this.pool.query(
      `UPDATE tasks SET
         status = 'pending',
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
  };
}
