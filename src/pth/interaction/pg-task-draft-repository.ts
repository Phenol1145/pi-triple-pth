/**
 * interaction/pg-task-draft-repository.ts —— N25 PG TaskDraft 持久化适配器。
 *
 * 异步接口；服务侧接入由后续 wave 完成（当前 TaskDraftService 使用同步 Repository 缝）。
 */

import type { TaskDraft } from "@away_from/pth-contracts";

export interface AsyncTaskDraftRepository {
  save(draft: TaskDraft): Promise<void>;
  get(id: string): Promise<TaskDraft | undefined>;
}

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export class PgTaskDraftRepository implements AsyncTaskDraftRepository {
  constructor(private readonly pool: Queryable) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS task_drafts (
        id TEXT PRIMARY KEY,
        revision INT NOT NULL,
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content_hash TEXT NOT NULL
      )
    `);
  }

  async save(draft: TaskDraft): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_drafts (id, revision, tenant_id, principal_id, title, text, status, created_at, updated_at, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         revision=EXCLUDED.revision, title=EXCLUDED.title, text=EXCLUDED.text,
         status=EXCLUDED.status, updated_at=EXCLUDED.updated_at, content_hash=EXCLUDED.content_hash`,
      [draft.id, draft.revision, draft.tenantId, draft.principalId, draft.title, draft.text, draft.status, draft.createdAt, draft.updatedAt, draft.contentHash],
    );
  }

  async get(id: string): Promise<TaskDraft | undefined> {
    const r = await this.pool.query(
      `SELECT id, revision, tenant_id AS "tenantId", principal_id AS "principalId", title, text, status, created_at AS "createdAt", updated_at AS "updatedAt", content_hash AS "contentHash"
       FROM task_drafts WHERE id=$1`,
      [id],
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      revision: Number(row.revision),
      tenantId: String(row.tenantId),
      principalId: String(row.principalId),
      title: String(row.title),
      text: String(row.text),
      status: row.status as TaskDraft["status"],
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      contentHash: String(row.contentHash),
    };
  }
}
