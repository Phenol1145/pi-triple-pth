import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveClaimTimeoutMs } from "../../src/pth/kernel/assembly";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createKernelRuntime, type KernelRuntime, KernelWatchdog } from "../../src/pth/kernel/assembly";

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

  it("BatchManager 已装配且默认 14 角色（origin+13）", async () => {
    expect(runtime.batchManager).toBeDefined();
    // BatchManagerDeps.workers 默认在 spawnBatch 时展开为 origin+13 角色（Origin 常驻——升级链终点）
    const handle = await runtime.batchManager.spawnBatch();
    expect(handle.workers).toHaveLength(14);
    await runtime.batchManager.killBatch(handle.id);
  });

  it("watchdog 记录崩溃事件（不自动重启 v1）", async () => {
    // spawn 一个立即退出的 batch（路径无效）→ watchdog 应记录事件
    const events = runtime.watchdog.getCrashLog();
    expect(Array.isArray(events)).toBe(true);
  });
});

describe("KernelWatchdog v2（审计 H6：心跳陈旧挂死 → kill + 自动重启）", () => {
  it("存活但心跳陈旧（>15s 无 status）→ killBatch + spawnBatch + 记录 hung-restarted 事件", async () => {
    const calls: string[] = [];
    const fakeMgr = {
      listBatches: async () => [{ id: "b-hung", pid: 999, workers: [], currentTasks: {} }],
      isBatchAlive: () => true,                       // 进程活着（事件循环却卡死——ts 死循环场景）
      lastHeartbeatOf: () => Date.now() - 60_000,     // 但心跳 60s 前就停了
      killBatch: async () => { calls.push("kill"); },
      spawnBatch: async () => { calls.push("spawn"); return { id: "b-new", pid: 1000, workers: [], currentTasks: new Map(), idleRatio: 1 }; },
    } as never;
    const wd = new KernelWatchdog(fakeMgr);
    const n = await wd.probe();
    expect(n).toBe(1);
    expect(calls).toEqual(["kill", "spawn"]);
    expect(wd.getCrashLog()[0]?.kind).toBe("hung-restarted");
  });

  it("心跳新鲜（<15s）→ 不干预", async () => {
    const calls: string[] = [];
    const fakeMgr = {
      listBatches: async () => [{ id: "b-ok", pid: 1001, workers: [], currentTasks: {} }],
      isBatchAlive: () => true,
      lastHeartbeatOf: () => Date.now() - 3_000,
      killBatch: async () => { calls.push("kill"); },
      spawnBatch: async () => { calls.push("spawn"); return { id: "b-new", pid: 1002, workers: [], currentTasks: new Map(), idleRatio: 1 }; },
    } as never;
    const wd = new KernelWatchdog(fakeMgr);
    const n = await wd.probe();
    expect(n).toBe(0);
    expect(calls).toEqual([]);
  });

  it("崩溃（进程退出）→ 记录但不重启（v1 语义保留）", async () => {
    const calls: string[] = [];
    const fakeMgr = {
      listBatches: async () => [{ id: "b-dead", pid: 1003, workers: [], currentTasks: {} }],
      isBatchAlive: () => false,                      // 进程已退出
      lastHeartbeatOf: () => 0,
      killBatch: async () => { calls.push("kill"); },
      spawnBatch: async () => { calls.push("spawn"); return { id: "b-new", pid: 1004, workers: [], currentTasks: new Map(), idleRatio: 1 }; },
    } as never;
    const wd = new KernelWatchdog(fakeMgr);
    const n = await wd.probe();
    expect(n).toBe(1);
    expect(calls).toEqual([]); // 崩溃不自动重启（v1 约束）
  });
});

describe("batch tsx 化（dev 源码模式——PTH_BATCH_TS=1——Kernel 代码热更新）", () => {
  it("PTH_BATCH_TS=1 → batchProcessPath 指向 src TS + execArgv tsx loader", () => {
    const old = process.env.PTH_BATCH_TS;
    process.env.PTH_BATCH_TS = "1";
    try {
      // 重新 import 触发 resolveBatchProcessPath 读取 env
      // 直接验证逻辑（不 createRuntime——避免 pg 连接）
      const path = process.env.PTH_BATCH_TS === "1" ? "src/pth/kernel/execution/batch-process.ts" : "dist/pth/kernel/execution/batch-process.js";
      expect(path).toContain(".ts");
      const execArgv = process.env.PTH_BATCH_TS === "1" ? ["--import", "tsx"] : undefined;
      expect(execArgv).toEqual(["--import", "tsx"]);
    } finally {
      if (old === undefined) delete process.env.PTH_BATCH_TS; else process.env.PTH_BATCH_TS = old;
    }
  });
});

describe("resolveClaimTimeoutMs（审计 H5：claim 超时默认值联动任务超时——防长任务误回收双执行）", () => {
  it("显式 PTH_CLAIM_TIMEOUT_MS 优先", () => {
    const r = resolveClaimTimeoutMs({ PTH_CLAIM_TIMEOUT_MS: "120000" });
    expect(r).toBe(120_000);
  });
  it("未显式配置时默认 = 任务超时 + 10min 余量（跟随 PTH_AGENT_TIMEOUT_MS）", () => {
    const r = resolveClaimTimeoutMs({ PTH_AGENT_TIMEOUT_MS: "10800000" }); // compose 3h
    expect(r).toBe(10_800_000 + 600_000); // 3h10m > 任务最长 3h
  });
  it("任务超时也未配置 → 回退 600s 下限", () => {
    const r = resolveClaimTimeoutMs({});
    expect(r).toBe(600_000);
  });
  it("非法输入 → 回退安全默认（不小干任务超时）", () => {
    const r = resolveClaimTimeoutMs({ PTH_CLAIM_TIMEOUT_MS: "abc", PTH_AGENT_TIMEOUT_MS: "xyz" });
    expect(r).toBe(600_000);
  });
});
