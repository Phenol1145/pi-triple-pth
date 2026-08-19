/**
 * g8-dual-process-child.ts —— N29 再验收 G8 双 OS 进程 / SIGKILL 故障注入子进程。
 *
 * 用法（由 g8-dual-process.test.ts 以独立 OS 进程拉起）：
 *   tsx g8-dual-process-child.ts drain <pg-uri> <tenant> <seconds>
 *       循环 claim/处理/complete outbox 行，处理事实写入 g8_results 表（行 key 唯一）。
 *   tsx g8-dual-process-child.ts hang <pg-uri> <tenant>
 *       claim 一行、写入 g8_claimed 审计表、打印 "claimed:<key>"，然后挂起——
 *       等待父进程 SIGKILL（模拟 handler 中途崩溃，lease 残留）。
 */

import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { PgSideEffectOutbox } from "../../src/pth/tasking/side-effect-outbox.js";

const [mode, uri, tenant] = process.argv.slice(2);
const seconds = Number(process.argv[5] ?? "8");

async function main(): Promise<void> {
  if (!mode || !uri || !tenant) throw new Error("usage: <drain|hang> <pg-uri> <tenant> [seconds]");
  const pool = await createPgPool({ connectionString: uri });
  const outbox = new PgSideEffectOutbox(pool);
  const owner = `g8-child-${process.pid}`;

  if (mode === "hang") {
    const rows = await outbox.claimPending(1, { tenantId: tenant, owner, leaseMs: 3_000 });
    if (rows.length === 0) {
      process.stdout.write("no-row\n");
      await pool.end();
      return;
    }
    const row = rows[0]!;
    // 故障点：已 claim（领域处理进行中），尚未 complete。
    await pool.query(
      `INSERT INTO g8_claimed(tenant_id, key, owner) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenant, row.key, owner],
    );
    process.stdout.write(`claimed:${row.key}\n`);
    // 挂起等待 SIGKILL；pool 不 end，进程被强杀后 lease 到期可回收。
    await new Promise(() => {});
    return;
  }

  if (mode === "drain") {
    const deadline = Date.now() + seconds * 1000;
    let processed = 0;
    while (Date.now() < deadline) {
      const rows = await outbox.claimPending(4, { tenantId: tenant, owner, leaseMs: 3_000 });
      if (rows.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      for (const row of rows) {
        await pool.query(
          `INSERT INTO g8_results(tenant_id, key, owner) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO NOTHING`,
          [tenant, row.key, owner],
        );
        await outbox.complete({ tenantId: tenant, key: row.key, token: row.processingToken! });
        processed += 1;
      }
    }
    process.stdout.write(`processed:${processed}\n`);
    await pool.end();
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
