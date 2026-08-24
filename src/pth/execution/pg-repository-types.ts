/**
 * execution/pg-repository-types.ts —— 执行域 PG 适配器共用最小查询面。
 *
 * 仅暴露 query 的结构化最小面，便于 fake-pool 单测；实际可传 pg.Pool / pg.PoolClient。
 */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
