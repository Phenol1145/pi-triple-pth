/**
 * extensions/perf.ts —— perf 扩展（性能调优——Phase 3）。
 *
 * 能力面：params（配置快照）/ set（运行时参数）/ status（性能快照）/
 *         analyze（瓶颈诊断 v1）/ publish / apply / list（策略闭环——toolstore 文件）
 * 数据源：配置中心（perf-params）+ toolstore 策略目录（ExtContext.strategiesDir）
 */

import type { TsReplExtension, ExtContext } from "./types.js";
import { config } from "./perf-params.js";
import { resolveTemplateTask } from "../templates.js";
import fs from "node:fs/promises";
import path from "node:path";

/** 策略文件结构（toolstore 文件即状态——SPEC §3.3） */
export interface PerfStrategy {
  id: string;
  name: string;
  params: Record<string, string>;
  actions?: Array<{ type: "task"; template: string; params?: Record<string, unknown> }>;
  condition?: string;
  createdAt: number;
}

async function strategiesDir(ctx: ExtContext): Promise<string> {
  const base = ctx.strategiesDir ?? path.join(process.cwd(), "toolstore", "strategies");
  await fs.mkdir(base, { recursive: true }).catch(() => {});
  return base;
}

export async function readStrategies(ctx: ExtContext): Promise<PerfStrategy[]> {
  const dir = await strategiesDir(ctx);
  try {
    const files = await fs.readdir(dir);
    const out: PerfStrategy[] = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as PerfStrategy);
      } catch { /* 坏文件跳过 */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export const perfExtension: TsReplExtension = {
  id: "perf",
  provide: (ctx) => ({
    perf: {
      /** 当前生效参数全表 */
      params: () => config().snapshot(),

      /** 运行时调整参数（SET 语义——配置中心改写，agent-loop 等动态组件立即生效） */
      set: (opts: { key: string; value: string | number }) => {
        const key = String(opts.key ?? "");
        if (!key.startsWith("PTH_")) return { ok: false, error: "perf.set 仅允许 PTH_* 参数" };
        const value = String(opts.value);
        config().set(key, value);
        return { ok: true, key, value };
      },

      /** 性能快照（v1：配置摘要 + 策略数——指标面 Phase 4 obs 扩展提供） */
      status: async () => {
        const params = config().snapshot();
        return {
          paramsCount: Object.keys(params).length,
          keyParams: {
            PTH_BATCH_AUTOSCALE: params["PTH_BATCH_AUTOSCALE"],
            PTH_BATCH_SCALE_UP_THRESHOLD: params["PTH_BATCH_SCALE_UP_THRESHOLD"],
            PTH_CLAIM_TIMEOUT_MS: params["PTH_CLAIM_TIMEOUT_MS"],
            PTH_KERNEL_IDLE_MS: params["PTH_KERNEL_IDLE_MS"],
            PTH_AGENT_MODEL: params["PTH_AGENT_MODEL"],
          },
          strategies: (await readStrategies(ctx)).length,
        };
      },

      /** 瓶颈诊断（v1 规则——完整指标面 Phase 4） */
      analyze: async () => {
        const params = config().snapshot();
        const notes: string[] = [];
        const threshold = Number(params["PTH_BATCH_SCALE_UP_THRESHOLD"] ?? 5);
        if (threshold > 3) notes.push(`扩容阈值 ${threshold} 偏高——小批积压可能延迟响应（可 perf.set PTH_BATCH_SCALE_UP_THRESHOLD 3）`);
        const claimTimeout = Number(params["PTH_CLAIM_TIMEOUT_MS"] ?? 600_000);
        if (claimTimeout > 600_000) notes.push(`claim 回收超时 ${claimTimeout}ms 偏长——僵尸任务滞留窗口大`);
        const idleMs = Number(params["PTH_KERNEL_IDLE_MS"] ?? 300_000);
        if (idleMs < 60_000) notes.push(`kernel 空闲回收 ${idleMs}ms 过短——频繁冷备可能抵消节省`);
        if (notes.length === 0) notes.push("当前参数未见明显瓶颈（v1 规则——详细分析待 obs 指标面）");
        return { notes };
      },

      /** 发布优化策略（toolstore 策略文件） */
      publish: async (opts: { id?: string; name?: string; params?: Record<string, string>; actions?: PerfStrategy["actions"]; condition?: string }) => {
        const id = opts?.id ?? `strategy-${Date.now().toString(36)}`;
        // id 进入文件名——防路径穿越（与 manage.resource.scheme.publish 同规则）
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
          return { ok: false, error: `perf.publish: id 非法 "${String(id).slice(0, 60)}"（字母数字开头，仅 [A-Za-z0-9._-]）` };
        }
        const strategy: PerfStrategy = {
          id,
          name: opts?.name ?? "untitled",
          params: opts?.params ?? {},
          actions: opts?.actions,
          condition: opts?.condition,
          createdAt: Date.now(),
        };
        const dir = await strategiesDir(ctx);
        await fs.writeFile(path.join(dir, `${strategy.id}.json`), JSON.stringify(strategy, null, 2));
        return { ok: true, strategy };
      },

      /** 应用策略（参数 set + actions 任务投递——模板统一收口 A+：resolveTemplateTask + tasks.publish） */
      apply: async (opts: { id: string }) => {
        const list = await readStrategies(ctx);
        const s = list.find((x) => x.id === opts.id);
        if (!s) return { ok: false, error: `策略不存在: ${opts.id}` };
        let applied = 0;
        for (const [k, v] of Object.entries(s.params)) {
          config().set(k, v);
          applied++;
        }
        // actions 投递：每条 {type:"task", template, params} 经统一模板解析器发布；
        // 单条失败进 dispatchErrors（隔离——不炸整轮参数应用）。
        const dispatched: string[] = [];
        const dispatchErrors: string[] = [];
        for (const action of s.actions ?? []) {
          if (!action || action.type !== "task" || typeof action.template !== "string") {
            dispatchErrors.push(`unsupported action: ${String(action?.type ?? "?")}`);
            continue;
          }
          const r = resolveTemplateTask({ template: action.template, params: action.params ?? {} });
          if (!r.ok) {
            dispatchErrors.push(`${action.template}: ${r.error}`);
            continue;
          }
          try {
            const task = await ctx.dataWorld.tasks.publish({
              title: r.title,
              text: r.text,
              createdBy: `perf-strategy:${s.id}`,
              tags: r.tags,
              workMode: r.workMode,
              payload: {
                ...(r.role ? { flow: { stages: [{ task: { role: r.role } }] } } : {}),
                ...r.payload,
                perfStrategy: s.id,
              },
            });
            dispatched.push(task.id);
          } catch (e) {
            dispatchErrors.push(`${action.template}: ${(e as Error).message}`);
          }
        }
        return {
          ok: true,
          id: s.id,
          name: s.name,
          appliedParams: applied,
          actions: s.actions?.length ?? 0,
          dispatched,
          dispatchErrors,
        };
      },

      /** 已发布策略清单 */
      list: () => readStrategies(ctx),
    },
  }),
  doc: `- perf: 性能调优——perf.params() 当前参数全表；perf.set({key, value}) 运行时调参（PTH_* 立即生效）；perf.status() 性能快照；perf.analyze() 瓶颈诊断（v1 规则）；perf.publish({id?, name, params, actions?}) 发布策略；perf.apply({id}) 应用策略（参数生效 + actions 任务投递）；perf.list() 策略清单`,
};
