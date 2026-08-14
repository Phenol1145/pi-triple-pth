import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { createDataWorld } from "../../src/pth/kernel/storage/index";
import { checkTaskRouting, routeTaskRole } from "../../src/pth/kernel/execution/role-router";
import { BatchManager } from "../../src/pth/kernel/execution/batch-manager";
import { DEFAULT_ROLES } from "../../src/pth/impls/roles/default-roles";
import { installDefaultRoles } from "../helpers";
import { beforeEach } from "vitest";

beforeEach(() => installDefaultRoles());

// --- Docker 可用性守卫（与既有套件同模式；无 docker 环境 SKIP 而非 FAIL）---
async function hasDocker(): Promise<boolean> {
  if (process.env.PTH_TEST_NO_DOCKER === "1") return false;
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await hasDocker();
const suite = dockerAvailable ? describe : describe.skip;

// --- fork TS 入口所需 resolve-hook loader（与 batch-process.integration.test.ts 同源）---
// Node 24 strip-types 不重写相对 .js→.ts specifier；src/ 内 import 一律 .js 后缀 →
// resolve hook：父模块 .ts 时相对 .js 先按 .ts 解析。
const LOADER_SRC = `import { register } from "node:module";
register(import.meta.url, import.meta.url);
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts") && specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier.replace(/\\.js$/, ".ts"), context);
    } catch {
      // 原 .js specifier 回退（防御：真实 .js 文件存在时）
    }
  }
  return nextResolve(specifier, context);
}
`;

suite("batch manager production fork (BatchManager ↔ batch-process 组合)", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let loaderPath: string;
  let workspacesDir: string;
  let artifactsDir: string;
  let manager: BatchManager;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    const dir = await mkdtemp(join(tmpdir(), "pth-batchmgr-e2e-"));
    loaderPath = join(dir, "pth-resolve-loader.mjs");
    await writeFile(loaderPath, LOADER_SRC);
    workspacesDir = join(dir, "workspaces");
    artifactsDir = join(dir, "artifacts");
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
    if (loaderPath) await rm(join(loaderPath, ".."), { recursive: true, force: true });
  });

  it("spawnBatch 直接 fork 生产 TS 入口并完成任务", async () => {
    // BatchManager 生产 fork 配置：execArgv（transform-types + loader）与 env 透传
    manager = new BatchManager({
      batchProcessPath: "src/pth/kernel/execution/batch-process.ts",
      workers: DEFAULT_ROLES.map((r) => r.id),
      execArgv: ["--experimental-transform-types", "--import", loaderPath],
      env: {
        PTH_BATCH_PROCESS: "1",
        PTH_LLM_STUB: "1",   // 任务池纯化：e2e 经 agent 循环——stub LLM 立即 done（无真实凭据）
        PTH_TEST_DATABASE_URL: container.getConnectionUri(),
        PTH_WORKSPACES_PATH: workspacesDir,
        PTH_ARTIFACTS_PATH: artifactsDir,
      },
    });

    const dw = createDataWorld(pool, { validate: checkTaskRouting, assign: routeTaskRole });
    const task = await dw.tasks.publish({ title: "e2e", text: "2 + 3", createdBy: "test", tags: ["code"] });

    const handle = await manager.spawnBatch();
    expect(handle.workers).toHaveLength(9);   // DEFAULT_ROLES 9 叶（8 + writer 2026-08-12 批 2）
    expect(handle.pid).toBeGreaterThan(0);

    try {
      // 轮询 tasks 表 status → completed
      let status = "pending";
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const res = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
        status = res.rows[0]?.status ?? "missing";
        if (status === "completed" || status === "rejected") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(status).toBe("completed");
      // IPC status 消息契约：listBatches 可见且 isBatchAlive 判定正确
      const statuses = await manager.listBatches();
      expect(statuses.length).toBe(1);
      expect(manager.isBatchAlive(handle.id)).toBe(true);
      // keep-alive 回归（试运行发现）：任务完成后 batch 必须仍存活（pg 不 hold 事件循环，
      // unref 定时器会致进程退出）——等待一个间隔后仍 alive
      await new Promise((r) => setTimeout(r, 2500));
      expect(manager.isBatchAlive(handle.id)).toBe(true);
    } finally {
      await manager.killBatch(handle.id);
    }
  }, 60_000);

  it("worker 级控制：remove developer 后该角色不再认领；add 后恢复", async () => {
    const bm3 = new BatchManager({
      batchProcessPath: "src/pth/kernel/execution/batch-process.ts",
      workers: ["developer"],
      execArgv: ["--experimental-transform-types", "--import", loaderPath],
      env: {
        PTH_WORKER_ROLES: "developer:1,analyst:0,planner:0,scout:0,memory-keeper:0,acceptor:0,tester:0,writer:0,coder:0,spider:0",
        PTH_BATCH_PROCESS: "1",
        PTH_LLM_STUB: "1",   // 任务池纯化：e2e 经 agent 循环——stub LLM 立即 done（无真实凭据）
        PTH_TEST_DATABASE_URL: container.getConnectionUri(),
        PTH_WORKSPACES_PATH: workspacesDir,
        PTH_ARTIFACTS_PATH: artifactsDir,
      },
      onMetric: () => {},
      obsResolver: async () => ({}),
    });
    const handle = await bm3.spawnBatch();
    const dw3 = createDataWorld(pool, { validate: checkTaskRouting, assign: routeTaskRole });
    // 1. developer 任务正常认领（轮询等待——2026-08-12 发布前 flaky 修复：
    //    3s 固定等待在全量并发下不足（fork 子进程启动/轮询慢）——改轮询最多 30s）
    const t1 = await dw3.tasks.publish({ title: "w1", text: "1", createdBy: "test", tags: ["code"] });
    let st = "";
    for (let i = 0; i < 30; i++) {
      st = (await pool.query("SELECT status FROM tasks WHERE id = $1", [t1.id])).rows[0]?.status as string;
      if (["completed", "claimed", "submitted"].includes(st)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(["completed", "claimed", "submitted"]).toContain(st);
    // 2. remove developer → 新任务不再被认领
    expect(await bm3.removeWorker(handle.id, "developer")).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const t2 = await dw3.tasks.publish({ title: "w2", text: "2", createdBy: "test", tags: ["code"] });
    await new Promise((r) => setTimeout(r, 3000));
    const t2row = (await pool.query("SELECT status, claimed_by FROM tasks WHERE id = $1", [t2.id])).rows[0];
    st = t2row?.status;
    expect(st).toBe("pending");   // remove 后不认领
    // 3. add developer → 新任务恢复认领
    expect(await bm3.addWorker(handle.id, "developer", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    const t3 = await dw3.tasks.publish({ title: "w3", text: "3", createdBy: "test", tags: ["code"] });
    await new Promise((r) => setTimeout(r, 2500));
    st = (await pool.query("SELECT status FROM tasks WHERE id = $1", [t3.id])).rows[0]?.status;
    expect(["completed", "claimed", "submitted"]).toContain(st);
    await bm3.killBatch(handle.id);
  }, 60_000);

  it("batch 构成参数化：自定义构成（developer×2+analyst×1+其余禁用）fork 子进程存活", async () => {
    const bm2 = new BatchManager({
      batchProcessPath: "src/pth/kernel/execution/batch-process.ts",
      workers: ["developer", "developer", "analyst"],
      execArgv: ["--experimental-transform-types", "--import", loaderPath],
      env: {
        PTH_WORKER_ROLES: "developer:2,analyst:1,planner:0,scout:0,memory-keeper:0,acceptor:0,tester:0,coder:0,spider:0",
        PTH_BATCH_PROCESS: "1",
        PTH_LLM_STUB: "1",   // 任务池纯化：e2e 经 agent 循环——stub LLM 立即 done（无真实凭据）
        PTH_TEST_DATABASE_URL: container.getConnectionUri(),
        PTH_WORKSPACES_PATH: workspacesDir,
        PTH_ARTIFACTS_PATH: artifactsDir,
      },
      onMetric: () => {},
      obsResolver: async () => ({}),
    });
    const handle = await bm2.spawnBatch();
    expect(handle.workers).toEqual(["developer", "developer", "analyst"]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(bm2.isBatchAlive(handle.id)).toBe(true);
    await bm2.killBatch(handle.id);
  }, 20_000);
});
