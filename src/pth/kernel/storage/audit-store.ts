import type pg from "pg";

export interface AuditEvent {
  // Finding #1 修复（协调者裁决）：audit_log.id 为 BIGSERIAL(int8)，node-postgres 默认以 string 返回
  // （未设全局 setTypeParser——避免大整型精度风险），故接口声明为 string 而非 number。
  id: string;
  eventType: string;
  actor?: string;
  taskId?: string;
  workerId?: string;
  sessionId?: string;
  payload: unknown;
  createdAt: Date;
}

export class PgAuditStore {
  constructor(private pool: pg.Pool) {}

  async write(ev: { eventType: string; actor?: string; taskId?: string; workerId?: string; sessionId?: string; payload?: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (event_type, actor, task_id, worker_id, session_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [ev.eventType, ev.actor ?? null, ev.taskId ?? null, ev.workerId ?? null, ev.sessionId ?? null, JSON.stringify(ev.payload ?? {})],
    );
  }

  async query(opts?: { eventType?: string; since?: Date; limit?: number }): Promise<AuditEvent[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts?.eventType) { params.push(opts.eventType); conds.push(`event_type = $${params.length}`); }
    if (opts?.since) { params.push(opts.since); conds.push(`created_at >= $${params.length}`); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${opts?.limit ?? 100}`,
      params,
    );
    // Finding #1 修复：row 映射显式标注 string 语义（pg int8 无 setTypeParser 时返回 string）
    return res.rows.map((r: any) => ({
      id: r.id as string, eventType: r.event_type, actor: r.actor ?? undefined,
      taskId: r.task_id ?? undefined, workerId: r.worker_id ?? undefined,
      sessionId: r.session_id ?? undefined, payload: r.payload, createdAt: r.created_at,
    }));
  }
}
