/**
 * migrate-optimizer-suggestion-kinds.ts —— W4：一次性迁移 `kind=optimizer-suggestion` 存量条目。
 *
 * 用法：DATABASE_URL=... npx tsx scripts/migrate-optimizer-suggestion-kinds.ts [--dry-run]
 *
 * 规则：
 *  - 含 modification-plan 结构字段 → kind=modification-plan
 *  - 含观测语义字段 → kind=observation-report
 *  - 不确定 → 保留 optimizer-suggestion，meta.needsReview=true
 * 全部迁移条目 meta.migratedFrom="optimizer-suggestion"、meta.migratedAt=ISO。
 */

import { Pool } from "pg";
import { classifyLegacySuggestionKind } from "../src/pth/execution/legacy-suggestion-migration.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL 必填");
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(
      `SELECT id, tenant_id, content, meta FROM memory_entries WHERE kind = 'optimizer-suggestion' ORDER BY created_at`,
    );
    let plan = 0;
    let obs = 0;
    let review = 0;
    for (const row of rows) {
      let content: unknown = {};
      try { content = JSON.parse(row.content ?? "{}"); } catch { /* 保留原样 */ }
      const targetKind = classifyLegacySuggestionKind(content);
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      const nextMeta = {
        ...meta,
        migratedFrom: "optimizer-suggestion",
        migratedAt: new Date().toISOString(),
        ...(targetKind === "optimizer-suggestion" ? { needsReview: true } : {}),
      };
      if (targetKind === "modification-plan") plan++;
      else if (targetKind === "observation-report") obs++;
      else review++;
      if (dryRun) {
        console.log(`[dry-run] ${row.id} → ${targetKind}`);
        continue;
      }
      await pool.query(
        `UPDATE memory_entries SET kind = $1, meta = $2::jsonb, version = version + 1 WHERE id = $3 AND tenant_id = $4`,
        [targetKind, JSON.stringify(nextMeta), row.id, row.tenant_id],
      );
    }
    console.log(`迁移完成${dryRun ? "（dry-run）" : ""}: modification-plan=${plan} observation-report=${obs} 待人工=${review}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
