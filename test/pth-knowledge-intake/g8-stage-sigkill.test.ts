/**
 * g8-stage-sigkill.test.ts —— N29 再验收 G8-b：三个**阶段级**故障点的真实子进程 SIGKILL 恢复。
 *
 * 每个用例使用独立 tenant、同一个真实 PG 容器：
 *   1. 拉起独立 tsx 子进程（生产 scanner + 生产 drainer + 生产 intake service + 生产 processors，
 *      仅替换 HTTP transport 与 LlmFn 后端）；
 *   2. 子进程命中精确故障窗口后打印 `FAULT:<point>` 并挂起；
 *   3. 父进程发送 SIGKILL（kill -9，进程无法执行任何清理/回滚代码）；
 *   4. 断言中间 PG 状态与该故障窗口一致；
 *   5. 等待 run/outbox lease 过期后，启动**全新进程**只读 PG 恢复；
 *   6. 断言最终 PG 状态：恰好一条 official、无重复 candidate/plan/verdict、outbox 全部 done。
 *
 * 故障点与计划 §5 Task 7 Step 2 一一对应：
 *   - artifact 写入前             → repository.storeAcquisition 端口包装挂起；
 *   - aggregate+outbox commit 后 → repository.transitionRun 端口包装挂起（真实事务已提交）；
 *   - handler 写结果后            → KnowledgeIngestor.ingest 端口包装挂起（candidate/plan 已真实落库）。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";

type SqlRow = Record<string, any>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "g8-stage-sigkill-child.ts");
const TSX = path.join(HERE, "../../node_modules/.bin/tsx");
const LEASE_SETTLE_MS = 3_300;

function spawnChild(args: string[]): ChildProcess {
  return spawn(TSX, [CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function waitExit(child: ChildProcess, timeoutMs = 90_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      reject(new Error("child exit timeout"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitForFault(child: ChildProcess, point: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, output?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
      if (error) {
        // 超时/异常路径绝不留活孤儿：它可能在后台抢其他 tenant 的 outbox 行。
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        reject(error);
      } else {
        resolve(output ?? "");
      }
    };
    const onData = (d: Buffer | string): void => {
      stdout += String(d);
      if (stdout.includes(`FAULT:${point}`)) finish(null, stdout);
    };
    const onErr = (d: Buffer | string): void => {
      stderr += String(d);
    };
    const onExit = (code: number | null, signal: string | null): void => {
      finish(new Error(`child exited before fault marker ${point}: code=${String(code)} signal=${String(signal)} stderr=${stderr} stdout=${stdout}`));
    };
    const timer = setTimeout(() => finish(new Error(`no fault marker ${point} in time; stdout=${stdout} stderr=${stderr}`)), timeoutMs);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onErr);
    child.once("exit", onExit);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("N29 再验收 G8-b：阶段级故障点 SIGKILL 真实子进程恢复", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let uri: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    uri = container.getConnectionUri();
    pool = await createPgPool({ connectionString: uri });
    await applySchema(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 120_000);

  interface Counts {
    artifacts: number;
    revisions: number;
    rawQuarantine: number;
    admitted: number;
    entries: number;
    officialEntries: number;
    plans: number;
    verdicts: number;
    dependencies: number;
    outbox: number;
    outboxDone: number;
    runs: number;
    runStatus: string | null;
    runStage: string | null;
  }

  async function counts(tenantId: string): Promise<Counts> {
    const row = (await pool.query<SqlRow>(
      `SELECT
         (SELECT count(*)::int FROM knowledge_source_artifacts WHERE tenant_id = $1) AS artifacts,
         (SELECT count(*)::int FROM knowledge_source_revisions WHERE tenant_id = $1) AS revisions,
         (SELECT count(*)::int FROM knowledge_source_revisions WHERE tenant_id = $1 AND disposition = 'raw-quarantine') AS raw_quarantine,
         (SELECT count(*)::int FROM knowledge_source_revisions WHERE tenant_id = $1 AND disposition = 'admitted') AS admitted,
         (SELECT count(*)::int FROM memory_entries WHERE tenant_id = $1) AS entries,
         (SELECT count(*)::int FROM memory_entries WHERE tenant_id = $1 AND status = 'official') AS official_entries,
         (SELECT count(*)::int FROM knowledge_verification_plans WHERE tenant_id = $1) AS plans,
         (SELECT count(*)::int FROM knowledge_verdict_rows WHERE tenant_id = $1) AS verdicts,
         (SELECT count(*)::int FROM knowledge_source_dependencies WHERE tenant_id = $1) AS dependencies,
         (SELECT count(*)::int FROM side_effect_outbox WHERE tenant_id = $1) AS outbox,
         (SELECT count(*)::int FROM side_effect_outbox WHERE tenant_id = $1 AND status = 'done') AS outbox_done,
         (SELECT count(*)::int FROM knowledge_intake_runs WHERE tenant_id = $1) AS runs,
         (SELECT status FROM knowledge_intake_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1) AS run_status,
         (SELECT stage FROM knowledge_intake_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1) AS run_stage`,
      [tenantId],
    )).rows[0]!;
    return {
      artifacts: Number(row.artifacts),
      revisions: Number(row.revisions),
      rawQuarantine: Number(row.raw_quarantine),
      admitted: Number(row.admitted),
      entries: Number(row.entries),
      officialEntries: Number(row.official_entries),
      plans: Number(row.plans),
      verdicts: Number(row.verdicts),
      dependencies: Number(row.dependencies),
      outbox: Number(row.outbox),
      outboxDone: Number(row.outbox_done),
      runs: Number(row.runs),
      runStatus: row.run_status as string | null,
      runStage: row.run_stage as string | null,
    };
  }

  async function outboxAttempts(tenantId: string, keyPrefix: string): Promise<number> {
    return Number(
      (await pool.query<SqlRow>(
        `SELECT attempts FROM side_effect_outbox WHERE tenant_id = $1 AND key LIKE $2 ORDER BY id LIMIT 1`,
        [tenantId, `${keyPrefix}:%`],
      )).rows[0]?.attempts ?? 0,
    );
  }

  async function assertFinalState(tenantId: string, retriedKeyPrefix: string): Promise<void> {
    const c = await counts(tenantId);
    const outboxRows = (await pool.query<SqlRow>(
      `SELECT key, status, attempts, last_error FROM side_effect_outbox WHERE tenant_id = $1 ORDER BY id`,
      [tenantId],
    )).rows;
    expect(c.runs).toBe(1);
    expect(c.runStatus).toBe("completed");
    expect(c.runStage).toBe("complete");
    expect(c.artifacts).toBe(1);
    expect(c.revisions).toBe(2);
    expect(c.rawQuarantine).toBe(1);
    expect(c.admitted).toBe(1);
    expect(c.entries).toBe(1);
    expect(c.officialEntries).toBe(1);
    expect(c.plans).toBe(1);
    expect(c.verdicts).toBe(2);
    expect(c.dependencies).toBe(2);
    // intake 五个阶段的 outbox 行必须全部 done；`promotion-index` 行不属于本内环注册的
    // 五类 handler（既有生产组合范围外），只允许它保持 pending 且不得被错误重试。
    const intakeRows = outboxRows.filter((r) => String(r.key).startsWith("intake."));
    expect(intakeRows.length, `outbox rows: ${JSON.stringify(outboxRows)}`).toBe(5);
    expect(intakeRows.every((r) => r.status === "done"), `outbox rows: ${JSON.stringify(outboxRows)}`).toBe(true);
    const otherRows = outboxRows.filter((r) => !String(r.key).startsWith("intake."));
    expect(otherRows, `outbox rows: ${JSON.stringify(outboxRows)}`).toHaveLength(1);
    expect(String(otherRows[0]!.key)).toMatch(/^promotion-index:/);
    expect(otherRows[0]!.status).toBe("pending");
    expect(c.outbox).toBe(c.outboxDone + 1);
    expect(c.outboxDone).toBeGreaterThanOrEqual(5);
    // 被杀的那条 outbox 行必须由新进程重试过（attempts >= 2），且结果行唯一。
    expect(await outboxAttempts(tenantId, retriedKeyPrefix)).toBeGreaterThanOrEqual(2);
  }

  interface Scenario {
    readonly title: string;
    readonly point: string;
    readonly retriedKeyPrefix: string;
    readonly assertIntermediate: (c: Counts, t: string) => Promise<void> | void;
  }

  const SCENARIOS: readonly Scenario[] = [
    {
      title: "SIGKILL 恢复：artifact 写入前（真实子进程 kill -9 → 新进程重跑 fetch）",
      point: "before-artifact-write",
      retriedKeyPrefix: "intake.fetch",
      assertIntermediate: (c) => {
        expect(c.artifacts).toBe(0);
        expect(c.revisions).toBe(0);
        expect(c.entries).toBe(0);
        expect(c.plans).toBe(0);
        expect(c.outbox).toBe(1);
        expect(c.outboxDone).toBe(0);
        expect(c.runStatus).toBe("leased");
        expect(c.runStage).toBe("fetch");
      },
    },
    {
      title: "SIGKILL 恢复：aggregate+outbox commit 后（run 已 admit + extract outbox 已入队，新进程接管）",
      point: "after-aggregate-outbox-commit",
      retriedKeyPrefix: "intake.fetch",
      assertIntermediate: (c) => {
        expect(c.artifacts).toBe(1);
        expect(c.revisions).toBe(2);
        expect(c.rawQuarantine).toBe(1);
        expect(c.admitted).toBe(1);
        expect(c.entries).toBe(0);
        expect(c.plans).toBe(0);
        expect(c.outbox).toBe(2); // fetch（processing）+ extract（pending）
        expect(c.outboxDone).toBe(0);
        expect(c.runStatus).toBe("queued");
        expect(c.runStage).toBe("admit");
      },
    },
    {
      title: "SIGKILL 恢复：handler 写结果后（candidate/plan 已落库，extract 重放幂等）",
      point: "after-handler-result",
      retriedKeyPrefix: "intake.extract",
      assertIntermediate: (c) => {
        expect(c.artifacts).toBe(1);
        expect(c.revisions).toBe(2);
        expect(c.entries).toBe(1);
        expect(c.officialEntries).toBe(0);
        expect(c.plans).toBe(1);
        expect(c.verdicts).toBe(0);
        expect(c.outbox).toBe(2); // fetch（done）+ extract（processing）
        expect(c.outboxDone).toBe(1);
        expect(c.runStatus).toBe("leased");
        expect(c.runStage).toBe("admit");
      },
    },
  ] as const;

  for (const scenario of SCENARIOS) {
    it(scenario.title, async () => {
      const tenant = `t-g8b-${scenario.point}`;

      const victim = spawnChild([scenario.point, uri, tenant]);
      const faultOut = await waitForFault(victim, scenario.point);
      expect(faultOut).toContain(`FAULT:${scenario.point}:${tenant}`);
      victim.kill("SIGKILL");
      expect(await waitExit(victim)).toBeNull(); // 被信号杀死，code=null（不是自然退出）。

      await scenario.assertIntermediate(await counts(tenant), tenant);

      // run lease 与 outbox processing lease 都只有 2.5s；等待过期后启动全新进程恢复。
      await sleep(LEASE_SETTLE_MS);

      const recovery = spawnChild(["recover", uri, tenant]);
      let recoveredOut = "";
      let recoveredErr = "";
      recovery.stdout?.on("data", (d) => { recoveredOut += String(d); });
      recovery.stderr?.on("data", (d) => { recoveredErr += String(d); });
      expect(await waitExit(recovery), `recovery failed: stderr=${recoveredErr} stdout=${recoveredOut}`).toBe(0);
      expect(recoveredOut).toMatch(/RECOVERED:[^:]+:completed:complete/);

      await assertFinalState(tenant, scenario.retriedKeyPrefix);
    }, 180_000);
  }
});
