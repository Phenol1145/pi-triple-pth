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
import { tagRegistry } from "./tag-registry.js";
import type { TaskStore } from "../storage/task-store-pg.js";
import type { PgMemoryStore } from "../storage/memory-store-pg.js";

export interface TriggerDef {
  name: string;
  /** 事件触发（activityHub 订阅）——与 schedule 二选一 */
  event?: string;
  /** 定时触发（backlog 差距 12——controller/sensor 任务源：周期生成观测/控制任务）
   *  everySec 为最小触发间隔（相对上次触发）；0/缺省 = 禁用定时。event 与 schedule 至少其一。 */
  schedule?: { everySec: number };
  match?: { role?: string; detailContains?: string };
  task: { title: string; text: string; role?: string; tags?: string[]; retask?: boolean };
  enabled?: boolean;
  once?: boolean;
  maxFires?: number;
}

interface TriggerEntry {
  id: string;
  def: TriggerDef;
  fireCount: number;
  /** 定时触发：上次触发时间（ms）——到点判定依据 */
  lastFiredAt: number;
}

const TRIGGER_KIND = "trigger";
const MAX_CHAIN_DEPTH = 5;

export class TriggerEngine {
  private triggers: TriggerEntry[] = [];
  /** 系统级 trigger（代码内置——非 memory 存储——reload 不覆盖；Origin 升级链用） */
  private systemTriggers: TriggerEntry[] = [];
  private loadedAt = 0;
  private unsubscribe: (() => void) | null = null;
  /** 热重载周期（memory 是真相源——30s 刷新——CRUD 后最多 30s 生效） */
  private readonly reloadMs = 30_000;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  /** 定时触发检查周期（scheduler——每 2s 检查一次到点） */
  private readonly scheduleTickMs = 2_000;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: { activityHub: ActivityHub; tasks: TaskStore; memory: PgMemoryStore; logger?: (msg: string) => void }) {}

  async start(): Promise<void> {
    await this.reload();
    this.unsubscribe = this.deps.activityHub.subscribe((e) => void this.onEvent(e));
    this.reloadTimer = setInterval(() => void this.reload().catch(() => {}), this.reloadMs);
    this.reloadTimer.unref();
    this.scheduleTimer = setInterval(() => void this.onScheduleTick(), this.scheduleTickMs);
    this.scheduleTimer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
  }

  /** 从 memory 加载 trigger 定义（official——enabled 才生效） */
  async reload(): Promise<number> {
    const entries = await this.deps.memory.retrieve({ kinds: [TRIGGER_KIND], status: ["official"] });
    const loaded: TriggerEntry[] = [];
    for (const e of entries) {
      try {
        const def = JSON.parse(e.content) as TriggerDef;
        if (def.enabled === false) continue;
        if (!def.task?.title || !def.task?.text) continue;
        // 事件/定时至少其一（backlog 差距 12——schedule 定时源）
        if (!def.event && !def.schedule?.everySec) continue;
        const prev = this.triggers.find((t) => t.id === e.id);
        loaded.push({ id: e.id, def, fireCount: prev?.fireCount ?? 0, lastFiredAt: prev?.lastFiredAt ?? 0 });
      } catch { /* 非法 JSON 跳过 */ }
    }
    this.triggers = loaded;
    this.loadedAt = Date.now();
    return loaded.length;
  }

  /** 注册系统级 trigger（幂等——按 name 去重；不受 once/maxFires 移除影响） */
  addSystemTrigger(def: TriggerDef): void {
    if (this.systemTriggers.some((t) => t.def.name === def.name)) return;
    this.systemTriggers.push({ id: `system:${def.name}`, def: { ...def, enabled: true }, fireCount: 0, lastFiredAt: 0 });
  }

  /** 定时源检查（backlog 差距 12）：每 tick 检查 schedule triggers 是否到点（lastFiredAt + everySec） */
  private async onScheduleTick(): Promise<void> {
    const now = Date.now();
    for (const t of [...this.systemTriggers, ...this.triggers]) {
      if (!t.def.schedule?.everySec || t.def.schedule.everySec <= 0) continue;
      if (now - t.lastFiredAt < t.def.schedule.everySec * 1000) continue;
      if (t.def.maxFires !== undefined && t.fireCount >= t.def.maxFires) continue;
      t.fireCount++;
      t.lastFiredAt = now;
      try {
        await this.publishFromTrigger(t, {}, 0);
      } catch (err) {
        this.deps.logger?.(`[trigger] ${t.def.name} 定时发布失败: ${(err as Error).message}`);
      }
    }
  }

  private async onEvent(e: ActivityEvent): Promise<void> {
    // 自触发阻断 + 链深限制（trigger 产生的任务事件不再无限触发）
    const depth = this.chainDepthOf(e);
    if (depth > MAX_CHAIN_DEPTH) return;
    for (const t of [...this.systemTriggers, ...this.triggers]) {
      if (t.def.event !== e.kind) continue;
      if (t.def.match?.role && t.def.match.role !== e.role) continue;
      if (t.def.match?.detailContains && !(e.detail ?? "").includes(t.def.match.detailContains)) continue;
      if (t.def.maxFires !== undefined && t.fireCount >= t.def.maxFires) continue;
      // 同一 trigger 的自触发阻断（trigger 发的任务完成又触发自己 → 链爆）
      if (depth > 0 && this.lastTriggerOf(e) === t.id) continue;
      t.fireCount++;
      // once/上限：匹配即从内存移除（先断后发——并发事件竞态：await publish 期间新事件不再匹配）
      // 系统 trigger（system: 前缀）不移除——升级链需持续生效
      if ((t.def.once || (t.def.maxFires !== undefined && t.fireCount >= t.def.maxFires)) && !t.id.startsWith("system:")) {
        this.triggers = this.triggers.filter((x) => x.id !== t.id);
      }
      const vars = { taskId: e.taskId ?? "", role: e.role ?? "", detail: e.detail ?? "" };
      const render = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars as Record<string, string>)[k] ?? "");
      try {
        // retask 模式（Origin 升级链——2026-08-10 设计 D3）：重发布原任务（正文继承）+ 转写标签
        if (t.def.task.retask) {
          const orig = e.taskId ? await this.deps.tasks.getById(e.taskId) : null;
          if (!orig) {
            this.deps.logger?.(`[trigger] ${t.def.name} 升级跳过：原任务 ${e.taskId ?? "?"} 不存在`);
            continue;
          }
          // 终态闸：原任务已属升级目标角色（Origin 失败）→ 不再升级——防死循环最终闸
          let target: string | null = t.def.task.role ?? null;
          if (!target) {
            const r = tagRegistry.routeRole(t.def.task.tags ?? []);
            target = r.ok ? r.role : null;
          }
          if (target && orig.assigned_role === target) {
            this.deps.logger?.(`[trigger] ${t.def.name} 升级终止：任务 ${orig.id} 已属 ${target}（Origin 失败即终态）`);
            continue;
          }
          const task = await this.deps.tasks.publish({
            title: orig.title,
            text: orig.text,
            createdBy: `trigger:${t.def.name}`,
            tags: t.def.task.tags ?? [],
            payload: {
              triggeredBy: { triggerId: t.id, fromTask: e.taskId ?? null, depth: depth + 1 },
              escalatedFrom: orig.id,
              originalRole: orig.assigned_role,
            },
          });
          this.deps.logger?.(`[trigger] ${t.def.name} 升级任务 ${orig.id}（${orig.assigned_role} 失败）→ ${task.id}（tags: ${(t.def.task.tags ?? []).join(",")}）`);
          continue;
        }
        await this.publishFromTrigger(t, vars, depth, { kind: e.kind, taskId: e.taskId ?? null });
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

  /** 公共发布（事件/定时共用）：模板渲染 + 路由依据（role 或 tags）+ 触发溯源 */
  private async publishFromTrigger(
    t: TriggerEntry,
    vars: Record<string, string>,
    depth: number,
    source?: { kind: string; taskId: string | null },
  ): Promise<void> {
    const render = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
    const task = await this.deps.tasks.publish({
      title: render(t.def.task.title),
      text: render(t.def.task.text),
      createdBy: `trigger:${t.def.name}`,
      // 任务池纯化（D5）：无默认标签——trigger 任务必须自带路由依据（role 或合法角色标签），
      // 注册期已校验；publish 校验失败（如角色后续被移除）会进 catch 记日志，不炸引擎
      tags: t.def.task.tags ?? [],
      payload: {
        ...(t.def.task.role ? { flow: { stages: [{ task: { role: t.def.task.role } }] } } : {}),
        triggeredBy: { triggerId: t.id, fromTask: source?.taskId ?? null, depth: depth + 1, source: source?.kind ?? "schedule" },
      },
    });
    const srcDesc = source ? `（事件 ${source.kind} 来自 ${source.taskId ?? "?"}——链深 ${depth + 1}）` : `（定时源——间隔 ${t.def.schedule?.everySec}s——第 ${t.fireCount} 次）`;
    this.deps.logger?.(`[trigger] ${t.def.name} 触发任务 ${task.id}${srcDesc}`);
  }

  private lastTriggerOf(e: ActivityEvent): string | null {
    return (e as { triggerId?: string }).triggerId ?? null;
  }
}
