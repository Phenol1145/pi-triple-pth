/**
 * TriggerEngine —— 事件触发任务引擎（trigger 组件——主进程）。
 *
 * 设计（2026-08-10 用户方向——trigger 从保留状态落地）：
 *  - trigger 定义存 memory（kind='trigger'——代码库式：数据非注册机制——CRUD 经 API）
 *  - 事件源 = ActivityHub（batch 活动事件已 IPC 到主进程——task.claim/done/failed 等——零新通道）
 *  - 匹配 → tasks.publish（自动发下游任务——链式编排的系统级形态）
 *
 * trigger 定义（memory kind='trigger' content JSON）：
 *   {
 *     name: "链式验收",
 *     event: "task.done",                    // 事件类型（ActivityEvent.kind——task.claim/agent.step/agent.tool/task.done/task.failed）
 *     match?: { role?: "developer", detailContains?: "实现" },   // 匹配条件（可选——缺省全匹配）
 *     task: {                                // 触发发布的任务
 *       title: "验收 {{taskId}} 的产物",      // 模板变量：{{taskId}} {{role}} {{detail}}
 *       text: "...",
 *       role?: "acceptor",                    // flow role 定向（可选）
 *       tags?: ["auto-chain"],
 *     },
 *     enabled: true,
 *     once?: false,                          // 触发一次后自动禁用（防链式爆炸）
 *     maxFires?: 10,                         // 最大触发次数（防链式爆炸——缺省不限）
 *   }
 *
 * 防链式爆炸：trigger 发布的任务带 payload.triggeredBy——trigger 触发产生的任务事件默认不再触发
 * 同一 trigger（自触发阻断）+ 全局深度限制（triggeredBy 链长 >5 不再触发）。
 */

import type { ActivityEvent, ActivityHub } from "./activity-hub.js";
import type { TaskStore } from "../storage/task-store-pg.js";
import type { PgMemoryStore } from "../storage/memory-store-pg.js";

export interface TriggerDef {
  name: string;
  event: string;
  match?: { role?: string; detailContains?: string };
  task: { title: string; text: string; role?: string; tags?: string[] };
  enabled?: boolean;
  once?: boolean;
  maxFires?: number;
}

interface TriggerEntry {
  id: string;
  def: TriggerDef;
  fireCount: number;
}

const TRIGGER_KIND = "trigger";
const MAX_CHAIN_DEPTH = 5;

export class TriggerEngine {
  private triggers: TriggerEntry[] = [];
  private loadedAt = 0;
  private unsubscribe: (() => void) | null = null;
  /** 热重载周期（memory 是真相源——30s 刷新——CRUD 后最多 30s 生效） */
  private readonly reloadMs = 30_000;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: { activityHub: ActivityHub; tasks: TaskStore; memory: PgMemoryStore; logger?: (msg: string) => void }) {}

  async start(): Promise<void> {
    await this.reload();
    this.unsubscribe = this.deps.activityHub.subscribe((e) => void this.onEvent(e));
    this.reloadTimer = setInterval(() => void this.reload().catch(() => {}), this.reloadMs);
    this.reloadTimer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.reloadTimer) clearInterval(this.reloadTimer);
  }

  /** 从 memory 加载 trigger 定义（official——enabled 才生效） */
  async reload(): Promise<number> {
    const entries = await this.deps.memory.retrieve({ kinds: [TRIGGER_KIND], status: ["official"] });
    const loaded: TriggerEntry[] = [];
    for (const e of entries) {
      try {
        const def = JSON.parse(e.content) as TriggerDef;
        if (def.enabled === false) continue;
        if (!def.event || !def.task?.title || !def.task?.text) continue;
        const prev = this.triggers.find((t) => t.id === e.id);
        loaded.push({ id: e.id, def, fireCount: prev?.fireCount ?? 0 });
      } catch { /* 非法 JSON 跳过 */ }
    }
    this.triggers = loaded;
    this.loadedAt = Date.now();
    return loaded.length;
  }

  private async onEvent(e: ActivityEvent): Promise<void> {
    // 自触发阻断 + 链深限制（trigger 产生的任务事件不再无限触发）
    const depth = this.chainDepthOf(e);
    if (depth > MAX_CHAIN_DEPTH) return;
    for (const t of this.triggers) {
      if (t.def.event !== e.kind) continue;
      if (t.def.match?.role && t.def.match.role !== e.role) continue;
      if (t.def.match?.detailContains && !(e.detail ?? "").includes(t.def.match.detailContains)) continue;
      if (t.def.maxFires !== undefined && t.fireCount >= t.def.maxFires) continue;
      // 同一 trigger 的自触发阻断（trigger 发的任务完成又触发自己 → 链爆）
      if (depth > 0 && this.lastTriggerOf(e) === t.id) continue;
      t.fireCount++;
      // once/上限：匹配即从内存移除（先断后发——并发事件竞态：await publish 期间新事件不再匹配）
      if (t.def.once || (t.def.maxFires !== undefined && t.fireCount >= t.def.maxFires)) {
        this.triggers = this.triggers.filter((x) => x.id !== t.id);
      }
      const vars = { taskId: e.taskId ?? "", role: e.role ?? "", detail: e.detail ?? "" };
      const render = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars as Record<string, string>)[k] ?? "");
      try {
        const task = await this.deps.tasks.publish({
          title: render(t.def.task.title),
          text: render(t.def.task.text),
          createdBy: `trigger:${t.def.name}`,
          // 任务池纯化（D5）：无默认标签——trigger 任务必须自带路由依据（role 或合法角色标签），
          // 注册期已校验；publish 校验失败（如角色后续被移除）会进 catch 记日志，不炸引擎
          tags: t.def.task.tags ?? [],
          payload: {
            ...(t.def.task.role ? { flow: { stages: [{ task: { role: t.def.task.role } }] } } : {}),
            triggeredBy: { triggerId: t.id, fromTask: e.taskId ?? null, depth: depth + 1 },
          },
        });
        this.deps.logger?.(`[trigger] ${t.def.name} 触发任务 ${task.id}（事件 ${e.kind} 来自 ${e.taskId ?? "?"}——链深 ${depth + 1}）`);
        if (t.def.once) {
          // once：memory 更新 enabled=false（内存已在匹配时移除——持久层同步）
          void this.deps.memory.retrieve({ kinds: [TRIGGER_KIND] }).then((all) => {
            const entry = all.find((x) => x.id === t.id);
            if (entry) {
              const def = { ...t.def, enabled: false };
              return this.deps.memory.write({ id: entry.id, kind: entry.kind, anchors: entry.anchors, content: JSON.stringify(def, null, 2), status: "official", meta: entry.meta ?? {} }, { force: true });
            }
          }).catch(() => {});
        }
      } catch (err) {
        this.deps.logger?.(`[trigger] ${t.def.name} 发布失败: ${(err as Error).message}`);
      }
    }
  }

  private chainDepthOf(e: ActivityEvent): number {
    return Number((e as { chainDepth?: number }).chainDepth ?? 0);
  }

  private lastTriggerOf(e: ActivityEvent): string | null {
    return (e as { triggerId?: string }).triggerId ?? null;
  }
}
