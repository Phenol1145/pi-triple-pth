import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { createDataWorld } from "../../src/pth/kernel/storage/index";
import { BatchManager } from "../../src/pth/kernel/execution/batch-manager";
import { DEFAULT_ROLES } from "../../src/pth/kernel/execution/worker-cluster";

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
        PTH_TEST_DATABASE_URL: container.getConnectionUri(),
        PTH_WORKSPACES_PATH: workspacesDir,
        PTH_ARTIFACTS_PATH: artifactsDir,
      },
    });

    const dw = createDataWorld(pool);
    const task = await dw.tasks.publish({ title: "e2e", text: "2 + 3", createdBy: "test", tags: ["code"] });

    const handle = await manager.spawnBatch();
    expect(handle.workers).toHaveLength(7);
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
    } finally {
      await manager.killBatch(handle.id);
    }
  }, 60_000);
});
