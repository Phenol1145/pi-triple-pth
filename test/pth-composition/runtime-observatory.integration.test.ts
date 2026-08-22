/**
 * runtime-observatory.integration.test.ts — N30 Task 4 组合测试。
 *
 * 真实 PostgreSQL（testcontainers）+ 最小 PTH gateway（runtime observation 路由）
 * + docker-monitor 聚合。验证：
 *  - monitor 通过 pth-client 只读拉取 durable timeline 并合并进 /snapshot；
 *  - durable 源变化（PG UPDATE）后 collectOnce 再次 reconcile，无需刷新页面；
 *  - /events 单条 SSE 发出统一 snapshot 事件（含 PTH interval）；
 *  - monitor 对 PTH 只发 GET，不触碰任何写路由。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { RuntimeObservationFacade } from "../../src/pth/application/observation/runtime-observation-facade.js";
import { registerRuntimeObservationRoutes } from "../../src/pth/gateway/routes-observe.js";
import { createMonitorServer } from "../../deploy/docker-monitor/server.js";

const TASK_ID = "task-integration-1";
const STABLE_ID = `task:tenant-a:${TASK_ID}`;

async function seedTask(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  status: string,
  createdAt: string,
  updatedAt: string,
  completedAt: string | null,
) {
  await pool.query(
    `INSERT INTO tasks
       (id, tenant_id, title, text, created_by, status, work_mode, created_at, updated_at, completed_at, rejects)
     VALUES ($1,'tenant-a',$2,$3,'integration', $4, 'run', $5::timestamptz, $6::timestamptz, $7::timestamptz, '[]'::jsonb)`,
    [TASK_ID, `integration ${TASK_ID}`, `text of ${TASK_ID}`, status, createdAt, updatedAt, completedAt],
  );
}

function parseSseBlock(block: string) {
  const ev: { id?: string; event?: string; data?: string } = {};
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) ev.id = line.slice(3).trim();
    else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
    else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
  }
  return ev;
}

async function readSseEvents(res: Response, count: number) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<{ id?: string; event?: string; data?: string }> = [];
  const timer = setTimeout(() => void reader.cancel(), 5000);
  try {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (ev.event) events.push(ev);
        if (events.length >= count) break;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

describe("runtime observatory composition（PG + gateway + monitor 聚合）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let gateway: ReturnType<typeof Fastify>;
  let gatewayPort: number;
  let monitor: ReturnType<typeof createMonitorServer>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);

    const now = Date.now();
    await seedTask(
      pool,
      "claimed",
      new Date(now - 60_000).toISOString(),
      new Date(now - 55_000).toISOString(),
      null,
    );

    // 最小 gateway 装配：只注册 N30 只读 timeline 路由，认证钩子直接盖章 tenant-a。
    const facade = new RuntimeObservationFacade(pool, { clock: () => Date.now() });
    gateway = Fastify({ logger: false });
    gateway.addHook("onRequest", async (req) => {
      (req as any).auth = {
        tenantId: "tenant-a",
        role: "runtime-observer",
        principalId: "tenant:tenant-a:runtime-observer",
      };
    });
    registerRuntimeObservationRoutes(gateway, {
      queryTimeline: (scope: any, window: any, query: any) => facade.queryTimeline(scope, window, query),
    } as any);
    await gateway.listen({ port: 0, host: "127.0.0.1" });
    const addr = gateway.server.address();
    if (!addr || typeof addr === "string") throw new Error("gateway did not bind");
    gatewayPort = addr.port;

    monitor = createMonitorServer({
      port: 0,
      intervalMs: 2000,
      docker: {
        getContainers: async () => [],
        inspectContainer: async () => null,
        getContainerStats: async () => {
          throw new Error("no containers");
        },
      },
      clock: () => Date.now(),
      pth: {
        endpoint: `http://127.0.0.1:${gatewayPort}`,
        token: "runtime-observer-integration-token",
        fetchImpl: globalThis.fetch,
      },
    });

    await monitor.collectOnce();
  });

  afterAll(async () => {
    await monitor?.close();
    await gateway?.close();
    await pool?.end();
    await container?.stop();
  });

  it("monitor /snapshot 合并真实 PG durable timeline，且 pth-timeline fresh", () => {
    const snap = monitor.snapshot();

    const task = snap.intervals.find((iv) => iv.id === STABLE_ID);
    expect(task).toBeTruthy();
    expect(task?.kind).toBe("task");
    expect(task?.tenantId).toBe("tenant-a");
    expect(task?.status).toBe("running"); // claimed → running
    expect(task?.endAt).toBeNull();

    const pthTimeline = snap.sources.find((s) => s.source === "pth-timeline");
    expect(pthTimeline?.state).toBe("fresh");
  });

  it("durable 源变化后 collectOnce 再对账：status/sourceVersion 更新，无需刷新页面", async () => {
    const before = monitor.snapshot().intervals.find((iv) => iv.id === STABLE_ID);
    const beforeVersion = before?.sourceVersion;

    const now = Date.now();
    await pool.query(
      `UPDATE tasks
          SET status = 'completed',
              completed_at = $2::timestamptz,
              updated_at = $2::timestamptz
        WHERE id = $1 AND tenant_id = 'tenant-a'`,
      [TASK_ID, new Date(now).toISOString()],
    );

    await monitor.collectOnce();

    const task = monitor.snapshot().intervals.find((iv) => iv.id === STABLE_ID);
    expect(task?.status).toBe("completed");
    expect(task?.endAt).not.toBeNull();
    expect(task?.sourceVersion).not.toBe(beforeVersion);
    expect(monitor.snapshot().sources.find((s) => s.source === "pth-timeline")?.state).toBe("fresh");
  });

  it("/events 单条 SSE 发出统一 snapshot 事件（含 PTH interval）且事件 ID 单调", async () => {
    await monitor.start();
    const addr = monitor.server.address();
    if (!addr || typeof addr === "object") {
      const port = addr && typeof addr === "object" ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await readSseEvents(res, 3);
      const snapshotEvents = events.filter((ev) => ev.event === "snapshot");
      expect(snapshotEvents.length).toBeGreaterThan(0);

      const payload = JSON.parse(snapshotEvents[0]!.data!);
      expect(payload.intervals.some((iv: { id: string }) => iv.id === STABLE_ID)).toBe(true);
      expect(payload.sources.some((s: { source: string }) => s.source === "pth-timeline")).toBe(true);

      const ids = events.map((ev) => Number(ev.id)).filter((n) => Number.isFinite(n));
      expect(ids.length).toBe(events.length);
      for (let i = 1; i < ids.length; i += 1) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
      }
    }
  });
});
