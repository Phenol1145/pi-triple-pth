import crypto from "node:crypto";
import type pg from "pg";

export class PgTranscriptStore {
  constructor(private pool: pg.Pool) {}

  async create(input: { taskId?: string; sessionId?: string; agentId: string; body: unknown[]; summary?: string; artifactPath?: string; tenantId?: string; context?: unknown }): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO transcripts (id, tenant_id, task_id, session_id, agent_id, body, summary, artifact_path, context)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)`,
      [id, input.tenantId ?? "default", input.taskId ?? null, input.sessionId ?? null, input.agentId, JSON.stringify(input.body), input.summary ?? null, input.artifactPath ?? null, input.context !== undefined ? JSON.stringify(input.context) : null],
    );
    return id;
  }

  async get(id: string) {
    const res = await this.pool.query(`SELECT * FROM transcripts WHERE id = $1`, [id]);
    return res.rows.length > 0 ? res.rows[0] : undefined;
  }

  async listByTask(taskId: string) {
    const res = await this.pool.query(`SELECT * FROM transcripts WHERE task_id = $1 ORDER BY created_at`, [taskId]);
    return res.rows;
  }

  /** W-a：历史活动记录查询——按落盘时间倒序取 transcripts，可按 agent_id 过滤。 */
  async listRecent(opts: { since: Date; agentId?: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
    const params: unknown[] = [opts.since];
    let where = `created_at >= $1`;
    if (opts.agentId !== undefined) {
      params.push(opts.agentId);
      where += ` AND agent_id = $${params.length}`;
    }
    params.push(limit);
    const res = await this.pool.query(
      `SELECT * FROM transcripts WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows as Array<Record<string, unknown>>;
  }
}
