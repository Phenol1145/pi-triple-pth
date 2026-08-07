import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchManager } from "../../src/pth/kernel/execution/batch-manager";

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
});
