import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchManager } from "../../src/pth/kernel/execution/batch-manager";

/** 轮询等待 pid 进程完全消失（Node 子进程被回收后 kill(pid,0) 抛 ESRCH） */
async function waitUntilGone(pid: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH：进程已退出并被回收
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("batch manager", () => {
  let dir: string;
  let stubPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pth-batch-"));
    // stub 子进程：启动后发 status，收 shutdown 后退出
    // fork 的 IPC 用 process.send / process.on("message")（无需 worker_threads 的 parentPort）
    stubPath = join(dir, "stub-batch.mjs");
    await writeFile(stubPath, `
      process.send?.({ type: "status", tasks: [] });
      process.on("message", (msg) => {
        if (msg.type === "shutdown") process.exit(0);
      });
    `);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("spawnBatch starts a batch child process", async () => {
    const mgr = new BatchManager({ batchProcessPath: stubPath });
    const handle = await mgr.spawnBatch();
    expect(handle.id).toBeTruthy();
    expect(handle.pid).toBeGreaterThan(0);
    await mgr.killBatch(handle.id);
  });

  it("killBatch gracefully shuts down (sends shutdown, waits exit)", async () => {
    const mgr = new BatchManager({ batchProcessPath: stubPath });
    const handle = await mgr.spawnBatch();
    await mgr.killBatch(handle.id);
    const batches = await mgr.listBatches();
    expect(batches.some((b) => b.id === handle.id)).toBe(false);
  });

  it("listBatches reports current state", async () => {
    const mgr = new BatchManager({ batchProcessPath: stubPath });
    const handle = await mgr.spawnBatch();
    const batches = await mgr.listBatches();
    const b = batches.find((x) => x.id === handle.id);
    expect(b?.workers.length).toBeGreaterThan(0);
    await mgr.killBatch(handle.id);
  });

  it("killBatch does not leak the map when the child already exited", async () => {
    const mgr = new BatchManager({ batchProcessPath: stubPath });
    const handle = await mgr.spawnBatch();
    // 外部 SIGKILL 模拟崩溃/并发退出（不经过 killBatch）
    process.kill(handle.pid, "SIGKILL");
    // 等子进程完全退出（'exit' 已触发、channel 关闭）。信号致死时 exitCode=null 而
    // signalCode=SIGKILL——旧实现只查 exitCode 会漏掉 → 挂满 5s SIGKILL 兑底；修复后立即返回。
    await waitUntilGone(handle.pid);
    await mgr.killBatch(handle.id);
    const batches = await mgr.listBatches();
    expect(batches.some((b) => b.id === handle.id)).toBe(false);
  }, 3000);  // 短超时：若 killBatch 走 5s SIGKILL 兜底则视为失败

  it("spawnBatch survives an invalid batch process path (no crash, clean recovery)", async () => {
    const mgr = new BatchManager({ batchProcessPath: join(dir, "does-not-exist.mjs") });
    // fork 语义：子进程 = node 二进制必然 spawn 成功；无效模块路径由子进程加载失败退出(1)，
    // 父进程不触发 'error' 事件。断言 = 短超时内不 crash、handle 可被 killBatch 干净回收。
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 100));  // 给子进程加载失败/退出留时间
    await mgr.killBatch(handle.id);
    const batches = await mgr.listBatches();
    expect(batches.some((b) => b.id === handle.id)).toBe(false);
  }, 3000);

  it("trigger 统一化：broadcastOptimizerSweep 下行广播到全部存活 batch", async () => {
    const mgr = new BatchManager({ batchProcessPath: stubPath });
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 100));   // 等 spawn 完成 + IPC 就绪
    expect(mgr.broadcastOptimizerSweep()).toBe(1);  // 存活 batch 收到下行
    await mgr.killBatch(handle.id);
    expect(mgr.broadcastOptimizerSweep()).toBe(0);  // 无存活 batch
  });

  it("H6: status 消息含 ts → 更新 lastHeartbeat（watchdog v2 心跳面）", async () => {
    // stub 子进程在收到 ping 时回 status+ts（模拟 batch-process 心跳）
    const hbPath = join(dir, "hb-batch.mjs");
    await writeFile(hbPath, `
      process.send?.({ type: "status", tasks: [], ts: Date.now() });
      process.on("message", (msg) => {
        if (msg.type === "ping") process.send?.({ type: "status", tasks: [], ts: Date.now() });
        if (msg.type === "shutdown") process.exit(0);
      });
    `);
    const mgr = new BatchManager({ batchProcessPath: hbPath });
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 150));  // 等首条 status 到达
    const ts1 = mgr.lastHeartbeatOf(handle.id);
    expect(ts1).toBeGreaterThan(0);
    // 再 ping 一次 → 心跳更新（新 ts 更大）——通过 mgr 内部 child 通道发送
    await new Promise((r) => setTimeout(r, 30));
    const before = Date.now();
    const rec = (mgr as unknown as { batches: Map<string, { child: { send?: (m: unknown) => void } }> }).batches.get(handle.id);
    rec?.child.send?.({ type: "ping" });
    await new Promise((r) => setTimeout(r, 100));
    const ts2 = mgr.lastHeartbeatOf(handle.id);
    expect(ts2).toBeGreaterThanOrEqual(ts1);
    expect(ts2).toBeLessThanOrEqual(before + 500);
    await mgr.killBatch(handle.id);
  }, 5000);

  it("L3 健康面：status 自报 rss/cpu → listBatches 含 healthy + 资源字段（§9 L2 内存/CPU）", async () => {
    const resPath = join(dir, "res-batch.mjs");
    await writeFile(resPath, `
      const mem = process.memoryUsage(); const cpu = process.cpuUsage();
      process.send?.({ type: "status", tasks: [], ts: Date.now(), rss: mem.rss, cpuU: cpu.user, cpuS: cpu.system });
      process.on("message", (msg) => { if (msg.type === "shutdown") process.exit(0); });
    `);
    const mgr = new BatchManager({ batchProcessPath: resPath });
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 150));
    const b = (await mgr.listBatches()).find((x) => x.id === handle.id)!;
    expect(b.health).toBe("healthy");
    expect(b.heartbeatLagMs).toBeLessThan(15_000);
    expect(b.rssBytes).toBeGreaterThan(0);
    expect(b.cpuUserUs).toBeGreaterThanOrEqual(0);
    expect(b.cpuSystemUs).toBeGreaterThanOrEqual(0);
    await mgr.killBatch(handle.id);
  });

  it("L3 健康面：心跳陈旧 → stale（watchdog 处置前的可观测态）", async () => {
    const mgr = new BatchManager({ batchProcessPath: stubPath });
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 150));
    // 手工老化心跳（模拟事件循环阻塞——stub 不再上报）
    const rec = (mgr as unknown as { batches: Map<string, { lastHeartbeat: number }> }).batches.get(handle.id)!;
    rec.lastHeartbeat = Date.now() - 60_000;
    const b = (await mgr.listBatches()).find((x) => x.id === handle.id)!;
    expect(b.health).toBe("stale");
    expect(b.heartbeatLagMs).toBeGreaterThanOrEqual(60_000);
    await mgr.killBatch(handle.id);
  });

  it("L3 健康面：子进程崩溃未清理 → dead（killBatch 正常移除的不在列）", async () => {
    const crashPath = join(dir, "crash-batch.mjs");
    await writeFile(crashPath, `setTimeout(() => process.exit(1), 50);`);
    const mgr = new BatchManager({ batchProcessPath: crashPath });
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 300));   // 等崩溃落地
    const b = (await mgr.listBatches()).find((x) => x.id === handle.id)!;
    expect(b.health).toBe("dead");
    expect(mgr.isBatchAlive(handle.id)).toBe(false);
    await mgr.killBatch(handle.id);   // 清理出 map
    expect((await mgr.listBatches()).some((x) => x.id === handle.id)).toBe(false);
  });
});

describe("N28 T2：replica 级控制传输/关联（BatchManager）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pth-batch-replica-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("transport stub 报告两个 researcher 副本，只移除被寻址 ID，w-b 仍在 listBatches", async () => {
    const replicaPath = join(dir, "replica-batch.mjs");
    await writeFile(replicaPath, `
      const replicas = [
        { workerId: "w-a", batchId: "batch-a", role: { roleId: "researcher", revision: "v1" }, state: "idle" },
        { workerId: "w-b", batchId: "batch-a", role: { roleId: "researcher", revision: "v1" }, state: "idle" },
      ];
      process.on("message", (msg) => {
        if (msg.type === "worker-remove" && msg.workerId) {
          const index = replicas.findIndex((replica) => replica.workerId === msg.workerId);
          if (index >= 0) replicas.splice(index, 1);
          process.send?.({ type: "worker-status", workerId: msg.workerId, state: "draining", accepted: true });
          process.send?.({ type: "worker-removed", workerId: msg.workerId });
          process.send?.({ type: "status", tasks: [], replicas, ts: Date.now() });
        }
        if (msg.type === "shutdown") process.exit(0);
      });
      process.send?.({ type: "status", tasks: [], replicas, ts: Date.now() });
    `);
    const mgr = new BatchManager({ batchProcessPath: replicaPath });
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 150));   // 等首条 status/replicas 到达
    expect(await mgr.removeReplica(handle.id, "w-a")).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    const batch = (await mgr.listBatches()).find((x) => x.id === handle.id)!;
    expect(batch.replicas?.map((r) => r.workerId)).toEqual(["w-b"]);
    await mgr.killBatch(handle.id);
  });

  it("off 模式（无 workerId 回执）worker-specific 控制不可用 → removeReplica 超时 false", async () => {
    // 旧形状 stub：只回 status（无 replicas），不认 workerId 消息（与 batch-process off 分支一致）。
    const offPath = join(dir, "off-batch.mjs");
    await writeFile(offPath, `
      process.send?.({ type: "status", tasks: [], ts: Date.now() });
      process.on("message", (msg) => { if (msg.type === "shutdown") process.exit(0); });
    `);
    const mgr = new BatchManager({ batchProcessPath: offPath });
    const handle = await mgr.spawnBatch();
    await new Promise((r) => setTimeout(r, 100));
    const batch = (await mgr.listBatches()).find((x) => x.id === handle.id)!;
    expect("replicas" in batch).toBe(false);   // 旧形状不新增键
    expect(await mgr.removeReplica(handle.id, "w-none")).toBe(false);
    await mgr.killBatch(handle.id);
  }, 7000);
});
