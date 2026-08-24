/**
 * execution/pg-task-cognitive-ledger-outbox.ts —— N28 M3：任务认知账本 outbox 的 PG 持久化适配器。
 *
 * drain 使用 DELETE ... RETURNING 实现一次性取走；payload 以 JSONB 保存。
 */

import type { CognitiveLedgerEvent } from "./task-cognitive-ledger-outbox.js";
import { parseJsonField, type PgQueryable } from "./pg-repository-types.js";

export interface AsyncCognitiveLedgerOutboxRepository {
  append(event: CognitiveLedgerEvent): Promise<void>;
  drain(): Promise<CognitiveLedgerEvent[]>;
  pending(): Promise<CognitiveLedgerEvent[]>;
}

function mapEvent(row: Record<string, unknown>): CognitiveLedgerEvent {
  return {
    id: String(row.id),
    type: row.type as CognitiveLedgerEvent["type"],
    taskId: String(row.taskId),
    workerId: String(row.workerId),
    payload: parseJsonField(row.payload),
    at: Number(row.at),
  };
}

export class PgCognitiveLedgerOutbox implements AsyncCognitiveLedgerOutboxRepository {
  constructor(private readonly pool: PgQueryable) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS cognitive_ledger_outbox (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        at BIGINT NOT NULL
      )
    `);
  }

  async append(event: CognitiveLedgerEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO cognitive_ledger_outbox (id, type, task_id, worker_id, payload, at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         type=EXCLUDED.type, task_id=EXCLUDED.task_id, worker_id=EXCLUDED.worker_id,
         payload=EXCLUDED.payload, at=EXCLUDED.at`,
      [event.id, event.type, event.taskId, event.workerId, JSON.stringify(event.payload), event.at],
    );
  }

  async drain(): Promise<CognitiveLedgerEvent[]> {
    const r = await this.pool.query(
      `DELETE FROM cognitive_ledger_outbox
       RETURNING id, type, task_id AS "taskId", worker_id AS "workerId", payload, at`,
    );
    return r.rows.map(mapEvent);
  }

  async pending(): Promise<CognitiveLedgerEvent[]> {
    const r = await this.pool.query(
      `SELECT id, type, task_id AS "taskId", worker_id AS "workerId", payload, at
       FROM cognitive_ledger_outbox ORDER BY at, id`,
    );
    return r.rows.map(mapEvent);
  }
}
