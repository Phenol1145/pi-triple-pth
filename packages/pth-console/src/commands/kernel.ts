/**
 * bridge/kernel.ts — pth kernel 命令族（任务工具 Task 3）
 *
 * PTL 作为交互层：经 PthClient HTTP 访问 PTH gateway /kernel/* 路由，
 * 发布任务 / 查状态 / 控制 batch / 运行状态全景（监控面板铺垫）。
 *
 *   pth kernel tasks add "<描述>" [--tags x,y]
 *   pth kernel tasks ls [--limit n]
 *   pth kernel batch add [n]
 *   pth kernel batch remove [n]
 *   pth kernel status
 */
import { PthClient } from "../bridge/client.js";
import { requireClient } from "./client.js";
import { printPthBanner } from "./banner.js";

/** 解析 --tags a,b 与 --limit n 等 flags（hub 侧 flags 已由 dispatch 解析为 Record） */
function parseTags(flags: Record<string, string>): string[] | undefined {
  const tags = flags.tags;
  if (!tags) return undefined;
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

export async function cmdKernelTasksAdd(passthrough: string[], flags: Record<string, string>): Promise<void> {
  // 模板发布：pth kernel tasks add --template recon-doc --url X --anchors a,b
  if (flags.template) {
    const client = requireClient();
    const params: Record<string, unknown> = {};
    const templateId = flags.template;
    // 收集模板参数（--key value 形式，排除已知 flags）
    const known = new Set(["template", "tags", "limit", "dry-run"]);
    for (const [k, v] of Object.entries(flags)) {
      if (!known.has(k)) params[k] = v;
    }
    if (flags.anchors) params.anchors = flags.anchors.split(",").map((a) => a.trim()).filter(Boolean);
    try {
      const task = await client.publishTemplateTask(templateId, params, {
        createdBy: process.env.USER ?? "pth",
        tags: parseTags(flags),
      });
      printPthBanner();
      console.log(`  \x1b[1m[模板 ${templateId}] 任务已发布\x1b[0m`);
      console.log(`    id:     ${task.id}`);
      console.log(`    status: ${task.status}`);
      console.log("  查看: \x1b[36mpth kernel tasks ls\x1b[0m");
      return;
    } catch (err: any) {
      console.log(`\x1b[31m❌ 模板发布失败: ${err.message}\x1b[0m`);
      console.log("  模板列表: pth kernel templates ls");
      process.exit(1);
    }
  }

  const desc = passthrough.join(" ");
  if (!desc) {
    console.log("  用法: pth kernel tasks add \"<任务描述>\" --tags <角色标签>");
    console.log("        角色标签（必填其一）：code/test/analysis/research/plan/design/recon/memory/accept…");
    console.log("        （任务池纯化：只面向自然语言——严格标签校验；调试代码执行走 kernel exec 通道）");
    console.log("        pth kernel tasks add --template <id> --url <x> [--anchors a,b] [--section S]");
    process.exit(1);
  }
  const client = requireClient();
  try {
    const task = await client.publishTask({
      title: desc.slice(0, 80),
      text: desc,
      createdBy: process.env.USER ?? "pth",
      tags: parseTags(flags),
    });
    printPthBanner();
    console.log("  \x1b[1m任务已发布\x1b[0m");
    console.log(`    id:     ${task.id}`);
    console.log(`    status: ${task.status}`);
    console.log(`    title:  ${task.title}`);
    console.log("  查看: \x1b[36mpth kernel tasks ls\x1b[0m  状态: \x1b[36mpth kernel status\x1b[0m");
  } catch (err: any) {
    console.log(`\x1b[31m❌ 发布任务失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdKernelTemplatesLs(_passthrough: string[], _flags: Record<string, string>): Promise<void> {
  const client = requireClient();
  try {
    const templates = await client.listTemplates();
    printPthBanner();
    console.log("  \x1b[1mPTH 任务模板\x1b[0m");
    if (templates.length === 0) {
      console.log("\n  暂无模板。");
    } else {
      console.log("");
      for (const t of templates) {
        console.log(`  \x1b[1m${t.id}\x1b[0m  ${t.name}`);
        console.log(`      ${t.description}`);
        const params = t.params.map((p) => `${p.key}${p.required ? "*" : "?"}`).join(" ");
        if (params) console.log(`      参数: ${params}`);
      }
      console.log("");
      console.log("  发布: \x1b[36mpth kernel tasks add --template <id> --key value...\x1b[0m");
    }
    console.log("");
  } catch (err: any) {
    console.log(`\x1b[31m❌ 模板列表失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdKernelTasksLs(flags: Record<string, string>): Promise<void> {
  const client = requireClient();
  const limit = flags.limit ? parseInt(flags.limit, 10) || 20 : 20;
  try {
    const tasks = await client.listTasks({ limit });
    printPthBanner();
    console.log("  \x1b[1mPTH 任务列表\x1b[0m");
    if (tasks.length === 0) {
      console.log("\n  暂无任务。发布: \x1b[36mpth kernel tasks add \"<描述>\"\x1b[0m");
    } else {
      console.log("");
      console.log(`  \x1b[2m${"ID".padEnd(12)}${"STATUS".padEnd(12)}TITLE\x1b[0m`);
      for (const t of tasks) {
        const id = String(t.id ?? "").slice(0, 10).padEnd(12);
        const status = String(t.status ?? "?").padEnd(12);
        console.log(`  \x1b[1m${id}\x1b[0m${status}${String(t.title ?? "")}`);
      }
    }
    console.log("");
  } catch (err: any) {
    console.log(`\x1b[31m❌ 任务列表失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdKernelTasksCancel(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const id = passthrough[0];
  if (!id) {
    console.log("  用法: pth kernel tasks cancel <taskId> [--recursive]");
    process.exit(1);
  }
  const client = requireClient();
  try {
    const r = await client.cancelTask(id, { recursive: "recursive" in flags });
    printPthBanner();
    console.log(`  \x1b[1m任务取消\x1b[0m  ${id}`);
    console.log(`    cancelled: ${r.cancelled}`);
    for (const t of r.taskIds) console.log(`    - ${t}`);
  } catch (err: any) {
    console.log(`\x1b[31m❌ 取消任务失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

const TERMINAL_KINDS = new Set(["task.submit", "task.reject", "task.done", "task.failed"]);

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "rejected";
}

function printTaskWait(t: Record<string, unknown>): void {
  const payload = (t.payload ?? {}) as {
    delivery?: { path?: string[]; parent?: { taskId?: string } };
    childResult?: Record<string, { status?: string; summary?: string; artifactRef?: unknown; error?: { message?: string } }>;
  };
  const path = Array.isArray(payload.delivery?.path) ? payload.delivery!.path!.join(" → ") : undefined;
  const parent = payload.delivery?.parent?.taskId ? `（父 ${String(payload.delivery.parent.taskId).slice(0, 8)}）` : "";
  console.log(`  [${new Date().toISOString().slice(11, 19)}] ${t.status}  ${path ? `path: ${path} ` : ""}${parent}`);
  const children = Object.entries(payload.childResult ?? {});
  if (children.length > 0) {
    for (const [childId, r] of children) {
      const detail = r.error?.message ? ` — error: ${r.error.message.slice(0, 80)}` : r.summary ? ` — ${r.summary.slice(0, 80)}` : "";
      console.log(`    └ ${String(childId).slice(0, 10)} ${r.status ?? "?"}${detail}`);
    }
  }
}

async function waitOnce(client: PthClient, id: string): Promise<{ terminal: boolean; ok: boolean }> {
  const t = await client.getTask(id);
  if (!t) return { terminal: false, ok: false };
  printTaskWait(t);
  const status = String(t.status ?? "");
  return isTerminalStatus(status) ? { terminal: true, ok: status === "completed" } : { terminal: false, ok: true };
}

/** pth kernel wait <taskId> [--follow] [--timeout ms]：等待任务终态；--follow 经 SSE 实时打印 path/childResult */
export async function cmdKernelWait(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const id = passthrough[0];
  if (!id) {
    console.log("  用法: pth kernel wait <taskId> [--follow] [--timeout ms]");
    process.exit(1);
  }
  const client = requireClient();
  const timeoutMs = flags.timeout ? parseInt(flags.timeout, 10) || 300_000 : 300_000;
  const started = Date.now();
  try {
    const first = await waitOnce(client, id);
    if (first.terminal) {
      console.log("");
      process.exitCode = first.ok ? 0 : 1;
      return;
    }
    if ("follow" in flags) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let finishing = false;
      const refresh = async (): Promise<void> => {
        if (finishing) return;
        finishing = true;
        const t = await client.getTask(id).catch(() => null);
        if (t) {
          printTaskWait(t);
          const status = String(t.status ?? "");
          if (isTerminalStatus(status)) {
            process.exitCode = status === "completed" ? 0 : 1;
            clearTimeout(timer);
            ctrl.abort();
          }
        }
        finishing = false;
      };
      try {
        await client.streamSSE("/api/v1/kernel/events", (e) => {
          const ev = e as { kind?: string; taskId?: string };
          if (ev.taskId === id && TERMINAL_KINDS.has(ev.kind ?? "")) void refresh();
        }, { signal: ctrl.signal });
      } catch (err) {
        if ((err as Error).name !== "AbortError" && ctrl.signal.aborted === false) throw err;
      } finally {
        clearTimeout(timer);
      }
      const last = await client.getTask(id);
      if (last && isTerminalStatus(String(last.status ?? ""))) {
        console.log("");
        process.exitCode = String(last.status) === "completed" ? 0 : 1;
      } else if (Date.now() - started >= timeoutMs) {
        console.log(`\n  ⏱ 等待超时 ${timeoutMs}ms（任务仍在 ${last?.status ?? "?"}）`);
        process.exitCode = 1;
      }
      return;
    }
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const r = await waitOnce(client, id);
      if (r.terminal) {
        console.log("");
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
    }
    console.log(`\n  ⏱ 等待超时 ${timeoutMs}ms`);
    process.exitCode = 1;
  } catch (err: any) {
    console.log(`\x1b[31m❌ wait 失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdKernelBatchAdd(passthrough: string[], flags: Record<string, string>): Promise<void> {
  // pth kernel batch add [n] [--role developer] [--copies 2] [--weights developer:3,analyst:2]
  const n = Math.min(Math.max(parseInt(passthrough[0] ?? "1", 10) || 1, 1), 10);
  const client = requireClient();
  try {
    const res = await client.batchAddProfile(n, {
      role: flags.role,
      copies: flags.copies ? parseInt(flags.copies, 10) : undefined,
      weights: flags.weights,
    });
    printPthBanner();
    console.log(`  \x1b[1m已启动 ${res.spawned} 个 batch（${res.mode}）\x1b[0m`);
    for (const b of res.batches) console.log(`    ${b.id.slice(0, 8)}  pid=${b.pid}  workers=[${b.workers?.join(",") ?? "?"}]`);
    console.log("  状态: \x1b[36mpth kernel status\x1b[0m");
  } catch (err: any) {
    console.log(`\x1b[31m❌ 启动 batch 失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdKernelBatchRemove(passthrough: string[], _flags: Record<string, string>): Promise<void> {
  const n = Math.min(Math.max(parseInt(passthrough[0] ?? "1", 10) || 1, 10), 10);
  const client = requireClient();
  try {
    const res = await client.batchRemove(n);
    printPthBanner();
    console.log(`  \x1b[1m已停止 ${res.stopped} 个 batch\x1b[0m`);
  } catch (err: any) {
    console.log(`\x1b[31m❌ 停止 batch 失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdKernelBatchWorker(passthrough: string[], _flags: Record<string, string>): Promise<void> {
  // pth kernel batch worker <action> <batchId> <role> [copies]
  const [action, batchId, role, copiesRaw] = passthrough;
  if (!["pause", "resume", "remove", "add"].includes(action ?? "") || !batchId || !role) {
    console.log("  用法: pth kernel batch worker <pause|resume|remove|add> <batchId> <role> [copies]");
    process.exit(1);
  }
  const client = requireClient();
  try {
    const res = await client.workerControl(batchId, action!, role, copiesRaw ? parseInt(copiesRaw, 10) || 1 : undefined);
    printPthBanner();
    console.log(`  \x1b[1mworker ${action} ${role}\x1b[0m @ ${batchId.slice(0, 8)}`);
    console.log(`    batch: ${res.batchId} · action: ${res.action}${res.copies ? ` · copies: ${res.copies}` : ""}`);
    console.log("  状态: \x1b[36mpth kernel status\x1b[0m");
  } catch (err: any) {
    console.log(`\x1b[31m❌ worker 控制失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdKernelStatus(_passthrough: string[], _flags: Record<string, string>): Promise<void> {
  const client = requireClient();
  try {
    const s = await client.kernelStatus();
    printPthBanner();
    console.log("  \x1b[1mPTH kernel 运行状态\x1b[0m");
    console.log("");
    console.log(`  kernel: ${s.kernel.connected ? "\x1b[32mconnected\x1b[0m" : "\x1b[31mdisconnected\x1b[0m"}`);
    console.log(`  batches: ${s.batches.length} 个`);
    for (const b of s.batches) {
      const id = String(b.id ?? "").slice(0, 8);
      const pid = String(b.pid ?? "?");
      const alive = b.alive ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
      const workers = Array.isArray(b.workers) ? b.workers.length : 0;
      console.log(`    ${alive} ${id}  pid=${pid}  工人=${workers}  idle=${Math.round(Number(b.idleRatio ?? 1) * 100)}%`);
    }
    console.log(`  tasks: pending=${s.tasks.pending ?? 0} claimed=${s.tasks.claimed ?? 0} completed=${s.tasks.completed ?? 0} rejected=${s.tasks.rejected ?? 0} total=${s.tasks.total ?? 0}`);
    console.log(`  watchdog crashes: ${s.watchdog.crashLog.length}`);
    console.log(`  collected: ${new Date(s.collectedAt ?? Date.now()).toISOString()}`);
  } catch (err: any) {
    console.log(`\x1b[31m❌ kernel 状态获取失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
