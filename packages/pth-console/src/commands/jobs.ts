/**
 * bridge/jobs.ts — 异步 job 委托命令族（v0.8 循环①）
 *
 * 交互层工作流：写计划 → 提交 job（批量任务）→ 【脱手】立即返回 job id——
 * 主会话不阻塞，继续处理其他事物；PTH 任务池异步执行；需要时查状态/收产物。
 *
 *   pth job submit <plan> [--tasks n] [--tags a,b]   # 提交（计划 → 批量任务）——立即返回
 *   pth job status [id]                              # job 列表 / 单 job 进度
 *   pth job fetch <id>                               # 收产物（任务结果汇总）
 *
 * 性能伴随（V8 优化铺垫）：fetch 时汇总 exec 耗时——job 执行数据归档 .perf-bench/jobs/。
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PthClient } from "../bridge/client.js";

const JOBS_DIR = ".perf-bench/jobs";

function requireClient(): PthClient {
  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }
  return client;
}

/** 计划 → 批量任务切分（按行/段落——v1：每行一个任务文本；--tasks 控制条数） */
function planToTasks(plan: string, maxTasks: number, tags: string[]): Array<{ title: string; text: string; tags?: string[] }> {
  const lines = plan.split("\n").map((l) => l.trim()).filter(Boolean);
  // 计划段落 → 任务：每个非空行一个任务（若行数 > maxTasks 合并尾部）
  const chunks = lines.length > maxTasks ? [...lines.slice(0, maxTasks - 1), lines.slice(maxTasks - 1).join(" ")] : lines;
  return chunks.map((c, i) => ({
    title: c.slice(0, 80),
    text: c,
    tags,
  }));
}

export async function cmdHubJobSubmit(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const client = requireClient();
  const plan = passthrough.join(" ");
  if (!plan) {
    console.log("  用法: pth job submit <计划文本> [--tasks n] [--tags a,b]");
    
    return;
  }
  const maxTasks = Math.min(Math.max(Number(flags.tasks ?? 8), 1), 50);
  const tags = (flags.tags ?? "job").split(",").map((t) => t.trim()).filter(Boolean);
  const tasks = planToTasks(plan, maxTasks, tags);

  const res = await client.requestJson("/api/v1/kernel/jobs", {
    method: "POST",
    body: JSON.stringify({ plan, tasks, createdBy: process.env.USER ?? "pth" }),
  });

  console.log("  \x1b[1mjob 已提交（交互层脱手——PTH 异步执行）\x1b[0m");
  console.log(`    jobId:   ${(res as { jobId?: string }).jobId}`);
  console.log(`    任务数:  ${(res as { tasks?: number }).tasks ?? tasks.length}`);
  console.log(`    脱手说明: 主会话可继续处理其他事物`);
  console.log(`    收取:   \x1b[36mpth job status ${(res as { jobId?: string }).jobId}\x1b[0m 进度 · \x1b[36mpth job fetch ${(res as { jobId?: string }).jobId}\x1b[0m 产物`);
}

export async function cmdHubJobStatus(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const client = requireClient();
  const id = passthrough[0];
  if (id) {
    const detail = await client.requestJson(`/api/v1/kernel/jobs/${encodeURIComponent(id)}`, { method: "GET" }) as {
      jobId: string; status: string; total: number; completed: number; failed: number; tasks: Array<{ id: string; title: string; status: string; role: string | null; error: string | null }>;
    };
    console.log(`  \x1b[1mjob ${id.slice(0, 8)}…\x1b[0m  ${detail.status}  ${detail.completed}/${detail.total} completed${detail.failed > 0 ? `（${detail.failed} failed）` : ""}`);
    for (const t of detail.tasks) {
      const mark = t.status === "completed" ? "\x1b[32m✓\x1b[0m" : t.status === "rejected" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m◐\x1b[0m";
      console.log(`    ${mark} ${t.title.slice(0, 50).padEnd(52)} ${t.status.padEnd(10)} ${t.role ?? "?"}`);
    }
    return;
  }
  const res = await client.requestJson("/api/v1/kernel/jobs", { method: "GET" }) as { jobs: Array<{ jobId: string; total: number; completed: number; failed: number; status: string; createdAt: string }> };
  if (res.jobs.length === 0) { console.log("  · 无 job——pth job submit 提交"); return; }
  console.log("  \x1b[1m异步 jobs（脱手任务）\x1b[0m");
  for (const j of res.jobs) {
    const mark = j.status === "completed" ? "\x1b[32m●\x1b[0m" : "\x1b[33m◐\x1b[0m";
    console.log(`    ${mark} ${j.jobId.slice(0, 8)}…  ${j.completed}/${j.total} completed${j.failed > 0 ? `（${j.failed} failed）` : ""}  ${new Date(j.createdAt).toLocaleTimeString()}`);
  }
}

export async function cmdHubJobFetch(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const client = requireClient();
  const id = passthrough[0];
  if (!id) { console.log("  用法: pth job fetch <jobId>"); return; }
  const detail = await client.requestJson(`/api/v1/kernel/jobs/${encodeURIComponent(id)}`, { method: "GET" }) as {
    jobId: string; status: string; total: number; completed: number; failed: number;
    tasks: Array<{ id: string; title: string; status: string; role: string | null; result: { value?: unknown; durationMs?: number } | null; error: string | null }>;
  };
  console.log(`  \x1b[1mjob ${id.slice(0, 8)}… 产物\x1b[0m  ${detail.status}（${detail.completed}/${detail.total}）`);
  const execMs: number[] = [];
  for (const t of detail.tasks) {
    if (t.status !== "completed") { console.log(`    ${"\x1b[33m◐\x1b[0m"} ${t.title.slice(0, 50)}  ${t.status}`); continue; }
    if (typeof t.result?.durationMs === "number") execMs.push(t.result.durationMs);
    const val = t.result?.value;
    console.log(`    ${"\x1b[32m✓\x1b[0m"} ${t.title.slice(0, 50).padEnd(52)} exec=${t.result?.durationMs ?? "—"}ms`);
    if (val !== undefined && val !== null) {
      const s = typeof val === "string" ? val : JSON.stringify(val);
      console.log(`        ↳ ${s.slice(0, 300)}`);
    }
  }

  // 性能归档（V8 优化数据）：job 执行耗时 → .perf-bench/jobs/<jobId>.json
  if (execMs.length > 0) {
    try {
      await mkdir(JOBS_DIR, { recursive: true });
      await writeFile(join(JOBS_DIR, `${id}.json`), JSON.stringify({
        jobId: id, status: detail.status, fetchedAt: new Date().toISOString(),
        total: detail.total, completed: detail.completed, failed: detail.failed,
        execMs: { avg: Math.round(execMs.reduce((a, b) => a + b, 0) / execMs.length), list: execMs },
      }, null, 2));
      console.log(`  \x1b[2m性能归档 .perf-bench/jobs/${id}.json（avg exec ${Math.round(execMs.reduce((a, b) => a + b, 0) / execMs.length)}ms——V8 优化数据）\x1b[0m`);
    } catch { /* 归档失败容错 */ }
  }
}

/** 历史 job 归档列表（性能数据回顾） */
