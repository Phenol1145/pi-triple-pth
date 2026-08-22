/**
 * g8-dual-process.test.ts —— N29 再验收 G8：双 OS 进程 drainer + SIGKILL 恢复（真实 PG + 真实子进程）。
 *
 * - dual-drainer：两个独立 OS 进程并发消费同一 outbox，断言每行恰好被处理一次
 *   （g8_results 的 (tenant,key) 唯一约束 + 处理计数）。
 * - SIGKILL：子进程 claim 后挂起（领域处理进行中、未 complete），父进程 kill -9；
 *   lease 过期后由新进程回收并完成——断言恰好一次处理、一次完成、无重复副作用。
 *
 * 计划 §5 Task 7 Step 2：dual drainer 必须是两个独立 OS 进程，不能是同一 Vitest 进程的两个 pool。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { PgSideEffectOutbox } from "@away_from/pth-kernel-storage";

const TENANT = "t-g8";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "g8-dual-process-child.ts");
const TSX = path.join(HERE, "../../node_modules/.bin/tsx");

function spawnChild(args: string[]): ChildProcess {
  return spawn(TSX, [CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function waitExit(child: ChildProcess, timeoutMs = 60_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child exit timeout")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("N29 再验收 G8：双 OS 进程 drainer 与 SIGKILL 恢复", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let uri: string;
  let outbox: PgSideEffectOutbox;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    uri = container.getConnectionUri();
    pool = await createPgPool({ connectionString: uri });
    await applySchema(pool);
    await pool.query(`CREATE TABLE IF NOT EXISTS g8_results(tenant_id text NOT NULL, key text NOT NULL, owner text NOT NULL, PRIMARY KEY (tenant_id, key))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS g8_claimed(tenant_id text NOT NULL, key text NOT NULL, owner text NOT NULL, PRIMARY KEY (tenant_id, key))`);
    outbox = new PgSideEffectOutbox(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 120_000);

  it("dual OS-process drainers：同一 outbox 两行并发消费，恰好各处理一次", async () => {
    for (const key of ["g8-a", "g8-b", "g8-c", "g8-d"]) {
      await outbox.enqueue({ tenantId: TENANT, key, kind: "g8.probe", payload: { probe: key } });
    }
    const a = spawnChild(["drain", uri, TENANT, "6"]);
    const b = spawnChild(["drain", uri, TENANT, "6"]);
    let outA = "";
    let outB = "";
    a.stdout!.on("data", (d) => { outA += String(d); });
    b.stdout!.on("data", (d) => { outB += String(d); });
    const [codeA, codeB] = await Promise.all([waitExit(a), waitExit(b)]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    // 恰好一次：唯一约束兜底 + 总行数 = 入队数；两个进程的处理计数之和 = 4。
    const results = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM g8_results WHERE tenant_id = $1`, [TENANT]);
    expect(results.rows[0]!.n).toBe(4);
    const pa = Number(/processed:(\d+)/.exec(outA)?.[1] ?? 0);
    const pb = Number(/processed:(\d+)/.exec(outB)?.[1] ?? 0);
    expect(pa + pb).toBe(4);

    // outbox 终态全部 done。
    const done = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1 AND status = 'done' AND key LIKE 'g8-%'`,
      [TENANT],
    );
    expect(done.rows[0]!.n).toBe(4);
  }, 120_000);

  it("SIGKILL 恢复：handler 中途强杀 → lease 过期 → 新进程回收并完成，恰好一次", async () => {
    await outbox.enqueue({ tenantId: TENANT, key: "g8-kill", kind: "g8.probe", payload: { probe: "kill" } });

    // 子进程 claim 后挂起；父进程收到 claimed 信号后 SIGKILL。
    const victim = spawnChild(["hang", uri, TENANT]);
    let claimed = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not claim in time")), 30_000);
      victim.stdout!.on("data", (d) => {
        claimed += String(d);
        if (claimed.includes("claimed:")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    victim.kill("SIGKILL");
    await waitExit(victim);

    // 强杀后：行仍处于 processing（lease 3s 未过期），此刻新进程不得重复处理。
    const processing = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1 AND key = 'g8-kill' AND status = 'processing'`,
      [TENANT],
    );
    expect(processing.rows[0]!.n).toBe(1);
    const claimedRows = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM g8_claimed WHERE tenant_id = $1 AND key = 'g8-kill'`, [TENANT]);
    expect(claimedRows.rows[0]!.n).toBe(1);

    // 等待 lease 过期（3s + 余量），新进程回收并完成。
    await new Promise((r) => setTimeout(r, 3_500));
    const recovery = spawnChild(["drain", uri, TENANT, "5"]);
    let outR = "";
    recovery.stdout!.on("data", (d) => { outR += String(d); });
    expect(await waitExit(recovery)).toBe(0);
    expect(/processed:([1-9]\d*)/.test(outR)).toBe(true);

    const finalRow = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM side_effect_outbox WHERE tenant_id = $1 AND key = 'g8-kill'`,
      [TENANT],
    );
    expect(finalRow.rows[0]!.status).toBe("done");
    // 两次 attempt（被杀一次 + 回收一次），结果行唯一。
    expect(finalRow.rows[0]!.attempts).toBe(2);
    const resultRows = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM g8_results WHERE tenant_id = $1 AND key = 'g8-kill'`, [TENANT]);
    expect(resultRows.rows[0]!.n).toBe(1);
  }, 120_000);
});
