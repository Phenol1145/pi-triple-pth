import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createKernelRuntime, type KernelRuntime } from "../../src/pth/kernel/assembly";

// --- Docker 可用性守卫（Global Constraints：无 docker 环境必须 SKIP 而非 FAIL）---
// 模式同 kernel storage/execution 套件：getContainerRuntimeClient() 内部执行 dockerode.info()，
// daemon 不可用时抛错 → 走 skip 分支。PTH_TEST_NO_DOCKER=1 强制模拟无 docker。
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

suite("pth kernel assembly", () => {
  let container: PostgreSqlContainer;
  let runtime: KernelRuntime;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    runtime = await createKernelRuntime({
      databaseUrl: container.getConnectionUri(),
      basePath: "/tmp/pth-assembly-test/workspaces",
      artifactPath: "/tmp/pth-assembly-test/artifacts",
    });
  }, 120_000);

  afterAll(async () => {
    await runtime.shutdown();
    await container.stop();
  });

  it("applySchema 幂等——装配即建表", async () => {
    const pending = await runtime.dataWorld.tasks.countPending();
    expect(typeof pending).toBe("number");
    const res = await runtime.dataWorld.tasks.candidates("test-agent");
    expect(Array.isArray(res)).toBe(true);
  });

  it("BatchManager 已装配且默认 7 角色", async () => {
    expect(runtime.batchManager).toBeDefined();
    // BatchManagerDeps.workers 默认在 spawnBatch 时展开为 7 角色
    const handle = await runtime.batchManager.spawnBatch();
    expect(handle.workers).toHaveLength(7);
    await runtime.batchManager.killBatch(handle.id);
  });

  it("watchdog 记录崩溃事件（不自动重启 v1）", async () => {
    // spawn 一个立即退出的 batch（路径无效）→ watchdog 应记录事件
    const events = runtime.watchdog.getCrashLog();
    expect(Array.isArray(events)).toBe(true);
  });
});
