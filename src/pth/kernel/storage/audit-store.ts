import type pg from "pg";

export interface AuditEvent {
  id: number;
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
    return res.rows.map((r: any) => ({
      id: r.id, eventType: r.event_type, actor: r.actor ?? undefined,
      taskId: r.task_id ?? undefined, workerId: r.worker_id ?? undefined,
      sessionId: r.session_id ?? undefined, payload: r.payload, createdAt: r.created_at,
    }));
  }
}
