/**
 * bridge/bench.ts — PTH 性能基准（v0.8 循环①：PTH-PTL 开发循环的性能验证面）
 *
 * 每轮开发循环（写计划 → 提交任务 → 收产物）顺带跑一次基准——采集 PTH 实际性能
 * （路由/认领/执行/refine 各阶段 + 系统快照）——归档 .perf-bench/ 积累趋势数据——
 * 为下一个版本 V8 引擎专项优化做铺垫。
 *
 *   pth bench            跑全量基准（7 类代表性任务）+ 归档 + 与最新对比
 *   pth bench --task ts  只跑单类任务
 *   pth bench --list     列出历史基准
 *   pth bench --compare  对比最近两次基准
 *
 * 基准任务集（代表性——覆盖各执行路径）：
 *   ts-calc    纯 ts 计算（路由/认领/执行基线）
 *   py-calc    python sandbox kernel 路径
 *   bash-cmd   bash sandbox
 *   c-compile  C 编译核（冷编译路径）
 *   memory-io  memory.write + query（refine 沉淀路径）
 *   ext-use    ext.use hello-world（扩展链路）
 *   agent-nl   自然语言任务（LLM agent 循环）
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PthClient } from "../bridge/client.js";

const BENCH_DIR = ".perf-bench";
const POLL_MS = 1000;
const TIMEOUT_MS = 180_000;

interface BenchTask {
  id: string;
  title: string;
  text: string;
  tags: string[];
}

export const BENCH_TASKS: BenchTask[] = [
  { id: "ts-calc", title: "[bench] ts 计算", text: "const s = await (async () => { let sum = 0; for (let i = 1; i <= 100000; i++) sum += i; return sum; })(); ({ sum: s });", tags: ["code"] },
  { id: "py-calc", title: "[bench] python 计算", text: "const r = await python.execute(\"print(sum(range(1, 10001)))\"); ({ stdout: r.stdout });", tags: ["code"] },
  { id: "bash-cmd", title: "[bench] bash 命令", text: "const r = await bash.execute(\"seq 1 1000 | paste -sd+ | bc\"); ({ out: r.stdout });", tags: ["code"] },
  { id: "c-compile", title: "[bench] C 编译", text: "const r = await c.execute(\"gcc\", `#include <stdio.h>\\nint main(){ long long s=0; for(int i=1;i<=100000;i++) s+=i; printf(\\\"%lld\\\\n\\\",s); }`); ({ ok: r.ok });", tags: ["code"] },
  { id: "memory-io", title: "[bench] 记忆读写", text: "await memory.write({ kind: 'bench-marker', anchors: ['bench'], content: 'bench-' + Date.now() }); const rows = await memory.query(\"SELECT count(*)::int AS n FROM memory_entries WHERE kind='bench-marker'\"); ({ n: rows[0]?.n });", tags: ["code"] },
  { id: "ext-use", title: "[bench] 扩展引用", text: "const r = await ext.use(\"hello-world\", { tool: \"greet\", args: { name: \"bench\" } }); ({ got: r.result });", tags: ["code"] },
  // 任务池纯化（2026-08-10）：任务池只面向 NL——代码文本由 agent 理解执行；nl/bench 标签废止
  // （严格校验只认角色标签——createdBy:"bench" 承担来源标识）。代码级直连执行另有 /kernel/exec 通道。
  { id: "agent-nl", title: "[bench] 自然语言任务", text: "请计算 1 到 100 的和，用 ts 程序完成并返回结果。", tags: ["code"] },
];

export interface BenchResult {
  taskId: string;
  status: string;
  role: string | null;
  totalMs: number;          // 发布→completed 轮询总耗时（含排队+执行+refine）
  execMs: number | null;    // outputRef.durationMs（执行耗时）
  value?: unknown;          // outputRef.value
  error?: string | null;
  claimedAt?: string | null;
}

export interface BenchReport {
  ts: string;
  env: { version: string; node: string };
  results: BenchResult[];
  summary: {
    total: number;
    completed: number;
    rejected: number;
    avgTotalMs: number;
    avgExecMs: number;
  };
  system: Record<string, unknown>;  // /kernel/status 快照
}

function requireClient(): PthClient {
  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }
  return client;
}

function color(s: string, c: number): string { return `\x1b[${c}m${s}\x1b[0m`; }

async function waitForTask(client: PthClient, id: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const tasks = await client.listTasks({ limit: 50 });
    const t = tasks.find((x) => x.id === id);
    if (t && (t.status === "completed" || t.status === "rejected")) return t;
    if (Date.now() - start > timeoutMs) throw new Error(`task ${id} 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** 单任务基准（发布 + 等待 + 采集） */
export async function runBenchTask(client: PthClient, task: BenchTask): Promise<BenchResult> {
  const t0 = Date.now();
  const created = await client.publishTask({ title: task.title, text: task.text, createdBy: "bench", tags: task.tags });
  const t = await waitForTask(client, created.id, TIMEOUT_MS);
  const totalMs = Date.now() - t0;
  const ref = ((t.payload as Record<string, unknown> | undefined)?.outputRef as { ref?: Record<string, unknown> } | undefined)?.ref;
  return {
    taskId: task.id,
    status: String(t.status ?? "?"),
    role: (t.assigned_role as string | null) ?? null,
    totalMs,
    execMs: typeof ref?.durationMs === "number" ? ref.durationMs : null,
    value: ref?.value,
    error: (t.error as string | null) ?? null,
    claimedAt: (t.claimed_at as string | null) ?? null,
  };
}

/** 归档目录（.perf-bench/——gitignore） */
async function benchDir(): Promise<string> {
  await mkdir(BENCH_DIR, { recursive: true });
  return BENCH_DIR;
}

/** 历史基准列表（最新在前） */
export async function listReports(): Promise<Array<{ file: string; ts: string; summary: BenchReport["summary"] }>> {
  const dir = await benchDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
  const out: Array<{ file: string; ts: string; summary: BenchReport["summary"] }> = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(join(dir, f), "utf8")) as BenchReport;
      out.push({ file: f, ts: r.ts, summary: r.summary });
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 对比摘要（当前 vs 历史——每任务耗时变化） */
function compareRows(cur: BenchResult[], prev: BenchResult[]): string[] {
  const prevBy = new Map(prev.map((r) => [r.taskId, r]));
  const rows: string[] = [];
  for (const c of cur) {
    const p = prevBy.get(c.taskId);
    const delta = p && c.execMs != null && p.execMs != null ? c.execMs - p.execMs : null;
    const deltaStr = delta === null ? "  —" : delta > 50 ? color(`+${delta}ms`, 31) : delta < -50 ? color(`${delta}ms`, 32) : `${delta >= 0 ? "+" : ""}${delta}ms`;
    rows.push(`    ${c.taskId.padEnd(10)} exec ${String(c.execMs ?? "—").padStart(6)}ms  vs prev ${String(p?.execMs ?? "—").padStart(6)}ms  ${deltaStr}  ${c.status}`);
  }
  return rows;
}

export async function cmdHubBench(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const client = requireClient();

  // --list：历史基准
  if (flags.list === "true" || flags.list === "1") {
    const reports = await listReports();
    if (reports.length === 0) { console.log("  · 无历史基准——运行 pth bench"); return; }
    console.log("  \x1b[1m历史基准（.perf-bench/）\x1b[0m");
    for (const r of reports) {
      console.log(`    ${r.file}  ${r.ts}  completed=${r.summary.completed}/${r.summary.total}  avgExec=${r.summary.avgExecMs}ms`);
    }
    return;
  }

  // --compare：最近两次对比
  if (flags.compare === "true" || flags.compare === "1") {
    const reports = await listReports();
    if (reports.length < 2) { console.log("  · 不足两次基准——运行 pth bench 积累"); return; }
    const [latest, prev] = reports;
    const curR = JSON.parse(await readFile(join(await benchDir(), latest.file), "utf8")) as BenchReport;
    const prevR = JSON.parse(await readFile(join(await benchDir(), prev.file), "utf8")) as BenchReport;
    console.log(`  \x1b[1m基准对比\x1b[0m ${prev.ts} → ${latest.ts}`);
    console.log(compareRows(curR.results, prevR.results).join("\n"));
    return;
  }

  // 跑基准
  const tasks = flags.task ? BENCH_TASKS.filter((t) => t.id === flags.task) : BENCH_TASKS;
  if (tasks.length === 0) { console.log(`  ❌ 未知基准任务 "${flags.task}"（可选: ${BENCH_TASKS.map((t) => t.id).join("/")}）`); return; }

  console.log(color(`  ▶ PTH 性能基准（${tasks.length} 任务——循环①性能验证面）`, 36));
  const results: BenchResult[] = [];
  for (const task of tasks) {
    process.stdout.write(`    ${task.id.padEnd(10)}… `);
    try {
      const r = await runBenchTask(client, task);
      results.push(r);
      const mark = r.status === "completed" ? color("✓", 32) : color("✗", 31);
      console.log(`${mark} ${r.status} role=${r.role ?? "?"} total=${r.totalMs}ms exec=${r.execMs ?? "—"}ms`);
    } catch (e) {
      results.push({ taskId: task.id, status: "error", role: null, totalMs: 0, execMs: null, error: (e as Error).message });
      console.log(`${color("✗", 31)} ${(e as Error).message}`);
    }
  }

  // 系统快照
  let system: Record<string, unknown> = {};
  try { system = (await client.kernelStatus()) as unknown as Record<string, unknown>; } catch { /* 快照失败容错 */ }

  const completed = results.filter((r) => r.status === "completed").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  const execTimes = results.map((r) => r.execMs).filter((x): x is number => x != null);
  const report: BenchReport = {
    ts: new Date().toISOString(),
    env: { version: process.env.npm_package_version ?? "?", node: process.version },
    results,
    summary: {
      total: results.length,
      completed, rejected,
      avgTotalMs: results.length > 0 ? Math.round(results.reduce((a, r) => a + r.totalMs, 0) / results.length) : 0,
      avgExecMs: execTimes.length > 0 ? Math.round(execTimes.reduce((a, b) => a + b, 0) / execTimes.length) : 0,
    },
    system,
  };

  const dir = await benchDir();
  const file = `bench-${report.ts.replace(/[:.]/g, "-")}.json`;
  await writeFile(join(dir, file), JSON.stringify(report, null, 2));
  console.log(color(`  ✓ 基准完成（${completed}/${results.length} completed）——归档 .perf-bench/${file}`, 32));

  // 与最新历史对比
  const reports = await listReports();
  if (reports.length >= 2) {
    const prev = JSON.parse(await readFile(join(dir, reports[1].file), "utf8")) as BenchReport;
    console.log(`  \x1b[1m与上次对比（${prev.ts}）\x1b[0m`);
    console.log(compareRows(results, prev.results).join("\n"));
  }
}
