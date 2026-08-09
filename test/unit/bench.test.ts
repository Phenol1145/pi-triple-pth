import { describe, it, expect } from "vitest";
import { BENCH_TASKS, runBenchTask, listReports, type BenchReport, type BenchResult } from "../../packages/framework/src/bridge/bench.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PerfBench（v0.8 循环①——PTH 性能基准）", () => {
  it("基准任务集覆盖各执行路径（7 类）", () => {
    const ids = BENCH_TASKS.map((t) => t.id);
    expect(ids).toContain("ts-calc");
    expect(ids).toContain("py-calc");
    expect(ids).toContain("c-compile");
    expect(ids).toContain("memory-io");
    expect(ids).toContain("ext-use");
    expect(ids).toContain("agent-nl");
    expect(BENCH_TASKS.length).toBe(7);
  });

  it("runBenchTask：发布→等待→采集（mock 客户端——completed 含 exec 耗时）", async () => {
    const client = {
      publishTask: async () => ({ id: "t1", status: "pending" }),
      listTasks: async () => [{ id: "t1", status: "completed", assigned_role: "developer", error: null, claimed_at: "x", payload: { outputRef: { ref: { ok: true, durationMs: 42, value: { sum: 500 } } } } }],
    } as never;
    const r = await runBenchTask(client, BENCH_TASKS[0]!);
    expect(r.status).toBe("completed");
    expect(r.role).toBe("developer");
    expect(r.execMs).toBe(42);
    expect(r.value).toMatchObject({ sum: 500 });
  });

  it("runBenchTask：rejected 任务采集 error", async () => {
    const client = {
      publishTask: async () => ({ id: "t2", status: "pending" }),
      listTasks: async () => [{ id: "t2", status: "rejected", assigned_role: "acceptor", error: "execution-failed: x", payload: {} }],
    } as never;
    const r = await runBenchTask(client, BENCH_TASKS[1]!);
    expect(r.status).toBe("rejected");
    expect(r.error).toContain("execution-failed");
  });

  it("listReports：读取归档（summary 摘要）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      await mkdir(".perf-bench", { recursive: true });
      const report: BenchReport = {
        ts: "2026-08-09T12:00:00.000Z",
        env: { version: "0.8.0", node: "v22" },
        results: [],
        summary: { total: 7, completed: 6, rejected: 1, avgTotalMs: 100, avgExecMs: 50 },
        system: {},
      };
      await writeFile(join(dir, ".perf-bench", "bench-2026-08-09T12-00-00-000Z.json"), JSON.stringify(report));
      const reports = await listReports();
      expect(reports.length).toBe(1);
      expect(reports[0]!.summary.completed).toBe(6);
    } finally {
      process.chdir(orig);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
