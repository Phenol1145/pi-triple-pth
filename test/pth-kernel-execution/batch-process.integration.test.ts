import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgPool } from "../../src/pth/kernel/storage/pg";
import { applySchema } from "../../src/pth/kernel/storage/schema";
import { createDataWorld } from "../../src/pth/kernel/storage/index";
import { checkTaskRouting, routeTaskRole } from "../../src/pth/kernel/execution/role-router";
import { installDefaultRoles } from "../helpers";

beforeEach(() => installDefaultRoles());

// --- Docker 可用性守卫（与 pg.test.ts 同模式；无 docker 环境 SKIP 而非 FAIL）---
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

// --- fork 子进程跑 TS 入口所需的 resolve-hook loader ---
// Node 24 strip-types 不做相对导入 .js→.ts 重写（实测 ERR_MODULE_NOT_FOUND），而 src/ 内
// import 一律 .js 后缀（Node16 模块解析约定）→ 注册 resolve hook：父模块为 .ts 时把
// 相对 .js specifier 先按 .ts 解析。配合 --experimental-transform-types（参数属性等语法）。
// F2：node_modules 软链指向主工作树——fork 子进程解析 @away_from/pth-memory 会落到主树
// dist（旧实现）。这里把该裸 specifier 重定向到本工作树源码，保证子进程跑的是 F2 实现。
const MEMORY_SRC = new URL("../../packages/pth-memory/src/index.ts", import.meta.url).href;
const LOADER_SRC = `import { register } from "node:module";
register(import.meta.url, import.meta.url);
const MEMORY_SRC = ${JSON.stringify(MEMORY_SRC)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@away_from/pth-memory") {
    return { url: MEMORY_SRC, shortCircuit: true };
  }
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

suite("batch process integration (真实 pg 全链路)", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let loaderPath: string;
  let workspacesDir: string;
  let artifactsDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    const dir = await mkdtemp(join(tmpdir(), "pth-batch-e2e-"));
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

  it("forked batch process claims and completes a task end-to-end", async () => {
    const dw = createDataWorld(pool, { validate: checkTaskRouting, assign: routeTaskRole });
    // 发布一个任务
    const task = await dw.tasks.publish({ title: "e2e", text: "1 + 1", createdBy: "test", tags: ["code"] });
    // fork batch 子进程（连同一 pg）。TS 入口不能直接跑：execPath=node + execArgv 带
    // --experimental-transform-types（参数属性等语法）+ --import resolve-hook loader（.js→.ts）。
    const child = fork("src/pth/bootstrap/batch-process.ts", [], {
      execPath: process.execPath,
      execArgv: ["--experimental-transform-types", "--import", loaderPath],
      env: {
        ...process.env,
        PTH_BATCH_PROCESS: "1",
        PTH_LLM_STUB: "1",   // 任务池纯化：e2e 经 agent 循环——stub LLM 立即 done（无真实凭据）
        PTH_TEST_DATABASE_URL: container.getConnectionUri(),
        PTH_WORKSPACES_PATH: workspacesDir,
        PTH_ARTIFACTS_PATH: artifactsDir,
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    try {
      // 等待任务完成（轮询 tasks 表 status）
      let status = "pending";
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const res = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
        status = res.rows[0]?.status ?? "missing";
        if (status === "completed" || status === "rejected") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(status).toBe("completed");
    } finally {
      // 无论断言成败都清理子进程：先发 shutdown（优雅），超时强杀；防 fork 泄漏
      try {
        if (child.connected) child.send({ type: "shutdown" });
      } catch {
        // channel 已关闭：下方 exit 兜底
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 60_000);
});
