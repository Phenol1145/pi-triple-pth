/**
 * extensions/obs.ts —— obs 扩展（可监控数据调查——Phase 4）。
 *
 * 能力面：tasks（任务池调查——pg 封装 SQL）/ metrics（主进程指标——IPC 请求）/
 *         batches（主进程批次——IPC）/ kernels（sandbox 宿主池——直查）/
 *         search（事件检索——pg audit/transcripts）
 * 与 perf 分工：obs=读（发生了什么）/ perf=写（怎么改）——闭环：obs 发现→perf 策略→obs 验证
 */

import type { TsReplExtension, ExtContext } from "./index.js";
import { requestMain } from "./obs-ipc.js";

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** 任务调查 SQL 构建（白名单参数——防注入） */
function tasksSql(opts: Record<string, unknown>): string {
  const conds: string[] = [];
  const status = str(opts["status"]);
  const role = str(opts["role"]);
  const since = str(opts["since"]);
  if (status && /^[a-z_]+$/.test(status)) conds.push(`status = '${status}'`);
  if (role && /^[a-z0-9-]+$/.test(role)) conds.push(`claimed_by = '${role}'`);
  if (since && /^\d+$/.test(since)) conds.push(`created_at > now() - make_interval(secs => ${since})`);
  const where = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(Number(opts["limit"] ?? 20), 100);
  return `SELECT status, count(*) AS n, round(avg(extract(epoch FROM (completed_at - created_at)))::numeric, 2) AS avg_secs FROM tasks${where} GROUP BY status ORDER BY n DESC LIMIT ${limit}`;
}

function searchSql(opts: Record<string, unknown>): string {
  const q = str(opts["query"]);
  const limit = Math.min(Number(opts["limit"] ?? 10), 50);
  if (!q) return `SELECT id, created_at FROM transcripts ORDER BY created_at DESC LIMIT ${limit}`;
  const esc = q.replace(/'/g, "''").slice(0, 200);
  return `SELECT id, created_at FROM transcripts WHERE body::text ILIKE '%${esc}%' ORDER BY created_at DESC LIMIT ${limit}`;
}

export const obsExtension: TsReplExtension = {
  id: "obs",
  provide: (ctx: ExtContext) => ({
    obs: {
      /** 任务池调查：状态分布/耗时（pg——queryReadOnly 同源执行器） */
      tasks: async (opts: Record<string, unknown> = {}) => {
        try {
          return await ctx.dataWorld.queryReadOnly(tasksSql(opts));
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** 主进程指标查询（IPC 请求通道） */
      metrics: async (opts: Record<string, unknown> = {}) => {
        try {
          return await requestMain("metrics", { pattern: str(opts["pattern"]) });
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** 主进程批次调查（IPC） */
      batches: async () => {
        try {
          return await requestMain("batches");
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** sandbox 内核池调查（直查宿主——batch 已知 URL） */
      kernels: async () => {
        const url = process.env.PTH_SANDBOX_KERNEL_URL ?? process.env.SANDBOX_URL;
        if (!url) return { error: "sandbox kernel url 未配置" };
        try {
          const res = await fetch(`${url.replace(/\/+$/, "")}/kernel/status`, {
            headers: { authorization: `Bearer ${process.env.SANDBOX_SHARED_SECRET ?? ""}` },
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return { error: `kernel status HTTP ${res.status}` };
          return await res.json();
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** 事件检索（pg transcripts） */
      search: async (opts: Record<string, unknown> = {}) => {
        try {
          return await ctx.dataWorld.queryReadOnly(searchSql(opts));
        } catch (e) {
          return { error: (e as Error).message };
        }
      },
    },
  }),
  doc: `- obs: 可监控数据调查——obs.tasks({status?, role?, since?, limit?}) 任务池状态分布/耗时；obs.metrics({pattern?}) 主进程指标（pth_* 系列）；obs.batches() 批次状态；obs.kernels() sandbox 内核池（inFlight/idle/容量）；obs.search({query?, limit?}) 事件检索（transcripts）`,
};
