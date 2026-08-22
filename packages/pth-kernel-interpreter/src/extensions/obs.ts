/**
 * extensions/obs.ts —— obs 扩展（可监控数据调查——Phase 4）。
 *
 * 能力面：tasks（任务池调查——pg 封装 SQL）/ metrics（主进程指标——IPC 请求）/
 *         batches（主进程批次——IPC）/ kernels（sandbox 宿主池——直查）/
 *         search（事件检索——pg audit/transcripts）
 * 与 perf 分工：obs=读（发生了什么）/ perf=写（怎么改）——闭环：obs 发现→perf 策略→obs 验证
 */

import type { TsReplExtension, ExtContext } from "./types.js";
import { requestMain } from "./obs-ipc.js";
import { pthConfig } from "@away_from/pth-config";

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

/** 容器级 cgroup v2 观测（B7 / N5 资源环数据源） */
async function collectContainer(): Promise<unknown> {
  const read = async (p: string): Promise<string | null> => {
    try {
      return (await (await import("node:fs/promises")).readFile(p, "utf8")).trim();
    } catch {
      return null;
    }
  };
  const base = "/sys/fs/cgroup";
  const cpuMax = await read(`${base}/cpu.max`);
  const memCurrent = await read(`${base}/memory.current`);
  const memMax = await read(`${base}/memory.max`);
  const pidsCurrent = await read(`${base}/pids.current`);
  const pidsMax = await read(`${base}/pids.max`);
  const usageUsec = await read(`${base}/cpu.stat`);
  if (cpuMax === null && memCurrent === null) return { available: false, note: "非容器 cgroup v2 环境（无 /sys/fs/cgroup 指标）" };
  const [quota, period] = cpuMax?.split(/\s+/).map(Number) ?? [NaN, NaN];
  const cpuSec = usageUsec?.split("\n")[0]?.split(/\s+/)[1];
  const mb = (v: string): number | null => (v && v !== "max" ? Math.round(Number(v) / 1024 / 1024) : null);
  return {
    available: true,
    hostname: (await import("node:os")).hostname(),
    cpu: {
      quotaCores: Number.isFinite(quota) && quota > 0 && period > 0 ? quota / period : null,
      periodUs: period,
      usageUs: cpuSec ? Number(cpuSec) : null,
    },
    memory: { currentMb: mb(memCurrent ?? ""), maxMb: memMax === "max" ? null : mb(memMax ?? ""), unlimited: memMax === "max" },
    pids: { current: pidsCurrent ? Number(pidsCurrent) : null, max: pidsMax && pidsMax !== "max" ? Number(pidsMax) : null },
  };
}

/** 存储占用（B7 / N5 资源环数据源） */
async function collectStorage(): Promise<unknown> {
  try {
    const { execFile } = await import("node:child_process");
    const df = await new Promise<string>((resolve) => {
      execFile("df", ["-h", "/data", "/"], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout));
    });
    const cacheDir = pthConfig().str("PTH_COMPILED_CACHE_DIR");
    let cacheBytes = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return;
      const entries = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) await walk(`${dir}/${e.name}`, depth + 1);
        else if (e.isFile()) {
          const st = await (await import("node:fs/promises")).stat(`${dir}/${e.name}`).catch(() => null);
          if (st) cacheBytes += st.size;
        }
      }
    };
    await walk(cacheDir, 0);
    return { df: df.split("\n").filter(Boolean).slice(0, 6), compiledCacheDir: cacheDir, compiledCacheBytes: cacheBytes };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** sandbox 内核池状态（S1-1：obs.kernels 与 obs.resource 共用的受信 /kernel/status 通路）。 */
async function kernelStatus(): Promise<unknown> {
  // 未配置语义（fail-closed）：只认显式 env——schema 默认值不参与“缺省即错误”判定
  const url = pthConfig().env("PTH_SANDBOX_KERNEL_URL") ?? pthConfig().env("SANDBOX_URL");
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
}

export const obsExtension: TsReplExtension = {
  id: "obs",
  provide: (ctx: ExtContext) => ({
    obs: {
      /** 任务池调查：状态分布/耗时（pg——queryTemplate 受信模板通道：
       *  固定 SQL + 参数白名单——A2 Phase 4 修复 memory-only 白名单误拒） */
      tasks: async (opts: Record<string, unknown> = {}) => {
        try {
          return await ctx.dataWorld.queryTemplate(tasksSql(opts));
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

      /** PG 系统视图（固定模板白名单——pgStat 通道：连接状态/缓存命中/后台写） */
      pg: async (opts: Record<string, unknown> = {}) => {
        const view = str(opts["view"], "activity");
        if (!["activity", "database", "bgwriter", "slow"].includes(view)) return { error: `obs.pg: 未知视图 "${view}"（activity/database/bgwriter/slow）` };
        try {
          return await ctx.dataWorld.pgStat(view as "activity" | "database" | "bgwriter" | "slow");
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** 存储占用（df 概览 + compiled-cache 目录用量——容器内文件系统视角） */
      storage: collectStorage,

      /** 记忆空间质量聚合（memory_entries 只读统计——kind/status 分布/hit_count/重复度） */
      memory: async () => {
        try {
          const byKind = await ctx.dataWorld.queryReadOnly(
            `SELECT kind, status, count(*) AS n, round(avg(hit_count)::numeric, 1) AS avg_hits FROM memory_entries GROUP BY kind, status ORDER BY n DESC LIMIT 30`,
          );
          const total = await ctx.dataWorld.queryReadOnly(`SELECT count(*) AS n, sum(hit_count) AS total_hits FROM memory_entries`);
          return { byKind, total };
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** 调用点统计（task-scorecard 按角色聚合——2026-08-12 管理 SDK：内环 sensor 数据源） */
      callpoint: async (opts: Record<string, unknown> = {}) => {
        const role = str(opts["role"]);
        const since = str(opts["since"]);
        // 聚合快照优先（2026-08-12 审批面 B 实施：sensor 不逐条 parse——存在即用）
        try {
          // 2026-08-12 审计 HIGH-2 修复：聚合路径 role 同样校验（与明细路径一致——防注入）
          const roleCond = role && /^[a-z0-9-]+$/.test(role) ? ` AND meta->>'role' = '${role}'` : "";
          const aggRows = (await ctx.dataWorld.queryReadOnly(
            `SELECT id, content, meta->>'role' AS role FROM memory_entries WHERE kind = 'task-scorecard-aggregate'${roleCond}`,
          )) as Array<{ id: string; content: unknown; role: string | null }>;
          if (aggRows.length > 0) {
            const rows = aggRows.map((r: { id: string; content: unknown; role: string | null }) => {
              const a = JSON.parse(String(r.content)) as Record<string, number | undefined>;
              // 旧聚合行（pre-95a2d74）无缓存键——NaN 保护（2026-08-12 审计 LOW-12）
              const sumCacheRead = a.sumCacheRead ?? 0;
              const sumCacheWrite = a.sumCacheWrite ?? 0;
              const sumTokIn = a.sumTokIn ?? 0;
              const cacheHit = sumCacheRead + Math.max(0, sumTokIn - sumCacheRead - sumCacheWrite);
              return {
                role: r.role,   // 2026-08-12 审计 MEDIUM-5 修复：归因取 meta->>'role'（content jsonb 无 role 键）
                tasks: a.taskCount,
                avg_steps: a.taskCount ? Math.round((((a.sumSteps ?? 0) / a.taskCount) * 10)) / 10 : 0,
                avg_tokens_in: a.taskCount ? Math.round(sumTokIn / a.taskCount) : 0,
                avg_cache_read: a.taskCount ? Math.round(sumCacheRead / a.taskCount) : 0,
                cache_hit_pct: cacheHit > 0 ? Math.round((100 * sumCacheRead) / cacheHit) : 0,
                avg_fails: a.taskCount ? Math.round((((a.sumFails ?? 0) / a.taskCount) * 100)) / 100 : 0,
                gated_total: a.sumGated,
                // 时间复用率（2026-08-13 监测量）：计划扁平度——sum/planCount 均值
                avg_time_reuse: (a.planCount ?? 0) > 0 ? Math.round((((a.sumTimeReuse ?? 0) / (a.planCount ?? 1)) * 100)) / 100 : null,
              };
            });
            return { rows, source: "aggregate" };
          }
        } catch { /* 聚合读失败降级明细 */ }
        try {
          const conds: string[] = [];
          if (role && /^[a-z0-9-]+$/.test(role)) conds.push(`meta->>'role' = '${role}'`);
          if (since && /^\d+$/.test(since)) conds.push(`created_at > now() - make_interval(secs => ${since})`);
          const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
          const rows = await ctx.dataWorld.queryReadOnly(
            // 2026-08-12 sensor:worker-opt 观测报告的基础设施缺陷：content 是 text 列——
            // jsonb 操作符（->>）对 text 非法——需 ::jsonb 转换（sensor 已上报并绕过）
            // 2026-08-12：+ token 缓存命中率（cacheRead/(cacheRead+非缓存输入)——观测成本面）
            `SELECT meta->>'role' AS role, count(*) AS tasks, round(avg((content::jsonb->>'steps')::int)::numeric, 1) AS avg_steps,
             round(avg(((content::jsonb->'tokens')->>'input')::bigint)::numeric, 0) AS avg_tokens_in,
             round(avg(((content::jsonb->'tokens')->>'cacheRead')::bigint)::numeric, 0) AS avg_cache_read,
             round(avg((content::jsonb->>'failedActions')::int)::numeric, 2) AS avg_fails,
             CASE WHEN sum(((content::jsonb->'tokens')->>'cacheRead')::bigint) + sum(CASE WHEN ((content::jsonb->'tokens')->>'cacheRead')::bigint IS NOT NULL THEN (((content::jsonb->'tokens')->>'input')::bigint - ((content::jsonb->'tokens')->>'cacheRead')::bigint - ((content::jsonb->'tokens')->>'cacheWrite')::bigint) ELSE 0 END) > 0
               THEN round(100.0 * sum(((content::jsonb->'tokens')->>'cacheRead')::bigint) / NULLIF(sum(((content::jsonb->'tokens')->>'cacheRead')::bigint) + sum(CASE WHEN ((content::jsonb->'tokens')->>'cacheRead')::bigint IS NOT NULL THEN (((content::jsonb->'tokens')->>'input')::bigint - ((content::jsonb->'tokens')->>'cacheRead')::bigint - ((content::jsonb->'tokens')->>'cacheWrite')::bigint) ELSE 0 END), 0), 1) END AS cache_hit_pct
             FROM memory_entries WHERE kind = 'task-scorecard'${where}
             GROUP BY meta->>'role' ORDER BY tasks DESC LIMIT 20`,
          );
          return { rows, source: "detail" };
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** 护栏计数观测（N12 二期观测面 / N14 P1——sensor:rule 数据源）。
       *  D1 已落 trace guard 事件 → scorecard.guards 聚合；本方法把计数**出** scorecard：
       *  按护栏分账 命中/引导/软终/硬终 + killRatio（(soft+hard)/hits——误杀观测起点）。
       *  role 白名单含冒号（sensor:rule 等治理角色 id——与 callpoint 的 [a-z0-9-] 不同）。 */
      guards: async (opts: Record<string, unknown> = {}) => {
        const role = str(opts["role"]);
        const since = str(opts["since"]);
        const conds: string[] = ["kind = 'task-scorecard'", "content::jsonb ? 'guards'"];
        if (role && /^[a-z0-9:-]+$/.test(role)) conds.push(`meta->>'role' = '${role}'`);
        if (since && /^\d+$/.test(since)) conds.push(`created_at > now() - make_interval(secs => ${since})`);
        interface GuardCount { hits: number; guide: number; soft: number; hard: number }
        const blank = (): GuardCount => ({ hits: 0, guide: 0, soft: 0, hard: 0 });
        try {
          const rows = (await ctx.dataWorld.queryReadOnly(
            `SELECT meta->>'role' AS role, content::jsonb->'guards' AS guards FROM memory_entries WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
          )) as Array<{ role: string | null; guards: unknown }>;
          const totals = new Map<string, GuardCount>();
          const byRole = new Map<string, Map<string, GuardCount>>();
          let tasks = 0;
          const add = (m: Map<string, GuardCount>, gid: string, kind: keyof GuardCount, n: number) => {
            const c = m.get(gid) ?? blank();
            c[kind] += n;
            m.set(gid, c);
          };
          for (const r of rows) {
            if (!r.guards || typeof r.guards !== "object") continue;   // pre-D1 旧条目无 guards 段
            tasks++;
            const g = r.guards as Record<string, Record<string, number> | undefined>;
            const rn = r.role ?? "?";
            for (const kind of ["hits", "guide", "soft", "hard"] as const) {
              for (const [gid, n] of Object.entries(g[kind] ?? {})) {
                const v = Number(n) || 0;
                add(totals, gid, kind, v);
                let rm = byRole.get(rn);
                if (!rm) { rm = new Map(); byRole.set(rn, rm); }
                add(rm, gid, kind, v);
              }
            }
          }
          const withRatio = (m: Map<string, GuardCount>) => Object.fromEntries(
            [...m.entries()].map(([gid, c]) => [gid, { ...c, killRatio: c.hits > 0 ? Math.round((100 * (c.soft + c.hard)) / c.hits) / 100 : 0 }]),
          );
          return {
            tasks,
            guards: withRatio(totals),
            byRole: Object.fromEntries([...byRole.entries()].map(([rn, m]) => [rn, withRatio(m)])),
          };
        } catch (e) {
          return { error: (e as Error).message };
        }
      },

      /** sandbox 内核池调查（直查宿主——batch 已知 URL） */
      kernels: kernelStatus,

      /** 容器级观测（cgroup v2 只读——backlog 差距 7：资源闭环外环多数据源最后一块）
       *  CPU：cpu.max（quota/period——容器核数限额）、cpu.stat（usage_usec 累计）
       *  内存：memory.current/max（max="max"=无限制）· pids.current/max
       *  非容器环境（无 cgroup 文件）降级返回 { available: false }——不报错 */
      container: collectContainer,

      /** B7 / N5 资源环聚合：一次采集 controller:resource 需要的全部 L2/L3 数据源
       *  （容器 cgroup + PG 连接/缓存/慢查询 + 存储 + 批次健康 + sandbox 内核池）。 */
      resource: async () => ({
        collectedAt: Date.now(),
        container: await collectContainer(),
        pg: {
          activity: await ctx.dataWorld.pgStat("activity"),
          database: await ctx.dataWorld.pgStat("database"),
          slow: await ctx.dataWorld.pgStat("slow"),
        },
        storage: await collectStorage(),
        batches: await requestMain("batches").catch(() => ({ error: "main IPC unavailable" })),
        kernels: await kernelStatus(),
      }),

      /** 事件检索（pg transcripts——queryTemplate 受信模板通道：A2 Phase 4） */
      search: async (opts: Record<string, unknown> = {}) => {
        try {
          return await ctx.dataWorld.queryTemplate(searchSql(opts));
        } catch (e) {
          return { error: (e as Error).message };
        }
      },
    },
  }),
  doc: `- obs: 可监控数据调查——obs.tasks({status?, role?, since?, limit?}) 任务池状态分布/耗时；obs.metrics({pattern?}) 主进程指标（pth_* 系列）；obs.batches() 批次状态；obs.kernels() sandbox 内核池（inFlight/idle/容量）；obs.search({query?, limit?}) 事件检索（transcripts）；
  obs.pg({view}) PG 系统视图（activity/database/bgwriter/slow——连接/缓存/后台写/慢查询）；obs.storage() 存储占用（df + compiled-cache）；obs.memory() 记忆质量聚合（kind/status/hit_count）；obs.callpoint({role?, since?}) 调用点统计（task-scorecard 按角色聚合——sensor 内环数据源）；obs.guards({role?, since?}) 护栏计数（命中/引导/软终/硬终按护栏分账 + killRatio——sensor:rule 数据源，N12 二期观测面）；obs.container() 容器级 cgroup 观测；obs.resource() 资源环聚合（container+pg+storage+batches——controller:resource 数据源）`,
};
