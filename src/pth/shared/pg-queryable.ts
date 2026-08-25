/**
 * shared/pg-queryable.ts —— PTH 各域共用的 PG 最小查询面与 JSON 字段解析助手。
 *
 * 仅暴露 query 的结构化最小面，便于 fake-pool 单测；实际可传 pg.Pool / pg.PoolClient。
 * N25/N28 等持久化适配器统一复用，避免各域重复定义。
 */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** 把 PG JSONB 返回的 string 或 object 归一化为对象。 */
export function parseJsonField(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { raw: value };
    }
  }
  return (value ?? {}) as Record<string, unknown>;
}
