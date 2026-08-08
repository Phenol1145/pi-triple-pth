import type { BatchManager, BatchStatus } from "./execution/batch-manager.js";
import { collectStats, suggest, type BatchSuggestion, type LoadStats } from "./execution/stats.js";

/**
 * /pth 命令族（装配层 Task 3）：
 * /pth batch add|remove|status|suggest|stats
 * 命令层为纯函数（解析/渲染）——测试友好；执行侧 consume BatchManager + stats。
 */

export type PthCommand =
  | { kind: "batch"; action: "add"; count: number }
  | { kind: "batch"; action: "remove"; count: number }
  | { kind: "batch"; action: "status" }
  | { kind: "batch"; action: "suggest" }
  | { kind: "batch"; action: "stats" }
  | { kind: "help" };

export function parsePthArgs(args: string): PthCommand {
  const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
  if (argv[0] !== "batch") return { kind: "help" };
  const sub = argv[1];
  const n = parseInt(argv[2] ?? "1", 10);
  const count = Number.isFinite(n) && n >= 1 ? n : 1;
  switch (sub) {
    case "add": return { kind: "batch", action: "add", count };
    case "remove": return { kind: "batch", action: "remove", count };
    case "status": return { kind: "batch", action: "status" };
    case "suggest": return { kind: "batch", action: "suggest" };
    case "stats": return { kind: "batch", action: "stats" };
    default: return { kind: "help" };
  }
}

export function renderBatchStatus(batches: BatchStatus[]): string {
  if (batches.length === 0) return "无运行中的 batch。";
  const lines = batches.map((b) => {
    const tasks = Object.entries(b.currentTasks)
      .map(([w, t]) => `${w}→${t}`)
      .join(", ") || "无进行中任务";
    return `  ${b.id.slice(0, 8)}  pid=${b.pid}  工人=${b.workers.join(",")}  idle=${(b.idleRatio * 100).toFixed(0)}%  [${tasks}]`;
  });
  return `运行中 batch ${batches.length} 个:\n${lines.join("\n")}`;
}

export function renderBatchSuggestion(s: BatchSuggestion): string {
  return `建议: ${s.action} — ${s.reason}（pending=${s.data.pendingCount}, idle=${(s.data.idleRatio * 100).toFixed(0)}%, batches=${s.data.batchCount}）`;
}

export function renderStats(stats: LoadStats): string {
  return `任务积压: ${stats.pendingCount}  批处理: ${stats.batchCount}  空闲率: ${(stats.idleRatio * 100).toFixed(0)}%`;
}

export interface PthCommandContext {
  batchManager: BatchManager;
  /** stats 数据源（suggest/stats 消费）；缺省时用 batchManager 状态兜底 */
  stats?: () => Promise<LoadStats>;
}

/** 执行 /pth 命令。返回文本结果（供扩展 handler 输出）。 */
export async function executePthCommand(cmd: PthCommand, ctx: PthCommandContext): Promise<string> {
  switch (cmd.kind) {
    case "help":
      return [
        "/pth batch add [n]       — 启动 n 个 batch（默认 1）",
        "/pth batch remove [n]    — 停止 n 个 batch",
        "/pth batch status        — 列出运行中 batch",
        "/pth batch suggest       — 基于负载建议扩缩容",
        "/pth batch stats         — 负载统计",
      ].join("\n");
    case "batch": {
      if (cmd.action === "add") {
        const out: string[] = [];
        for (let i = 0; i < cmd.count; i++) {
          const h = await ctx.batchManager.spawnBatch();
          out.push(`batch ${h.id.slice(0, 8)} 已启动 (pid=${h.pid}, 工人: ${h.workers.length})`);
        }
        return out.join("\n");
      }
      if (cmd.action === "remove") {
        const batches = await ctx.batchManager.listBatches();
        const targets = batches.slice(0, cmd.count);
        if (targets.length === 0) return "无运行中的 batch 可停止。";
        for (const b of targets) await ctx.batchManager.killBatch(b.id);
        return `已停止 ${targets.length} 个 batch。`;
      }
      if (cmd.action === "status") {
        return renderBatchStatus(await ctx.batchManager.listBatches());
      }
      if (cmd.action === "suggest") {
        const stats = ctx.stats ? await ctx.stats() : await defaultStats(ctx);
        return renderBatchSuggestion(suggest(stats));
      }
      if (cmd.action === "stats") {
        const stats = ctx.stats ? await ctx.stats() : await defaultStats(ctx);
        return renderStats(stats);
      }
      return "unknown";
    }
  }
}

/** 兜底 stats：taskStore 缺省时 pendingCount=0（v1 占位；真实接线由装配层注入 stats） */
async function defaultStats(ctx: PthCommandContext): Promise<LoadStats> {
  const batches = await ctx.batchManager.listBatches();
  return collectStats({
    taskStore: { countPending: async () => 0 },
    batches,
  });
}
