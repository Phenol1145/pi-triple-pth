/// <reference path="../sdk.d.ts" />
// @ts-check
// sql-readonly 扩展——受控只读 SQL 查询（走 ctx.db 标准通道——白名单表 + 键值对过滤由通道保证）
module.exports = /** @type {PthExtFactory} */ async function factory(ctx) {
  return {
    tools: {
      "sql.query": async (args) => {
        const table = String(args?.table ?? "").trim();
        if (!table) return { ok: false, error: "sql.query: table 必填（tasks/memory_entries/transcripts）" };
        if (!ctx.db) return { ok: false, error: "sql.query: 运行环境无 db 通道" };
        /** @type {Record<string, string | number> | undefined} */
        const where = (args?.where && typeof args.where === "object")
          ? Object.fromEntries(Object.entries(args.where).map(([k, v]) => [k, String(v)]))
          : undefined;
        const r = await ctx.db.query(table, {
          where,
          limit: Number(args?.limit) || undefined,
        });
        return r.ok ? { ok: true, rows: r.rows } : { ok: false, error: r.error };
      },
    },
    capabilities: {},
  };
};
