import crypto from "node:crypto";
import type pg from "pg";

export class PgTranscriptStore {
  constructor(private pool: pg.Pool) {}

  async create(input: { taskId?: string; sessionId?: string; agentId: string; body: unknown[]; summary?: string; artifactPath?: string; tenantId?: string }): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO transcripts (id, tenant_id, task_id, session_id, agent_id, body, summary, artifact_path)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [id, input.tenantId ?? "default", input.taskId ?? null, input.sessionId ?? null, input.agentId, JSON.stringify(input.body), input.summary ?? null, input.artifactPath ?? null],
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
}
