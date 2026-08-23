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
 *     task: {                                // 任务 action：触发发布任务
 *       title: "验收 {{taskId}} 的产物",      // 模板变量：{{taskId}} {{role}} {{detail}}
 *       text: "...",
 *       role?: "acceptor",                    // flow role 定向（可选）
 *       tags?: ["auto-chain"],
 *     },
 *     action?: { type: "claim.reap" },        // 原生 action：触发调用已注册 handler（trigger 统一化）
 *     enabled: true,
 *     once?: false,                          // 触发一次后自动禁用（防链式爆炸）
 *     maxFires?: 10,                         // 最大触发次数（防链式爆炸——缺省不限）
 *   }
 *
 * task 与 action 至少其一（可并存：先 action 后发任务）。原生 action 经 registerAction 注册，
 * handler 可返回 { nextMs } 覆盖 schedule 的下一跳间隔（动态退避——resolver 空转降频）。
 *
 * 防链式爆炸：trigger 发布的任务带 payload.triggeredBy——trigger 触发产生的任务事件默认不再触发
 * 同一 trigger（自触发阻断）+ 全局深度限制（triggeredBy 链长 >5 不再触发）。
 */

import type { ActivityEvent, ActivityHub } from "./activity-hub.js";
import { tagRegistry } from "./tag-registry.js";
import { resolveTemplateTask } from "@away_from/pth-kernel-interpreter";
import type { TaskStore } from "@away_from/pth-kernel-storage";
import { DEFAULT_TENANT_ID, type PgMemoryStore } from "@away_from/pth-memory";
import { validateFlow, type FlowSpec } from "./resolver-core.js";

export interface TriggerAction {
  /** 原生动作类型（registerAction 注册键） */
  type: string;
  /** 动作参数（handler 自行解释） */
  params?: Record<string, unknown>;
}

export interface TriggerDef {
  name: string;
  /** 事件触发（activityHub 订阅）——与 schedule 二选一（至少其一） */
  event?: string;
  /** 定时触发（backlog 差距 12——controller/sensor 任务源：周期生成观测/控制任务）
   *  everySec 为最小触发间隔（相对上次触发）；0/缺省 = 禁用定时。event 与 schedule 至少其一。 */
  schedule?: { everySec: number };
  match?: { role?: string; detailContains?: string };
  /** 任务 action（发布下游任务）——与 action 至少其一。
   *  模板统一收口（A+）：优先 `template + params` 引用 TASK_TEMPLATES（事件变量注入）；
   *  `title + text` 内联形态保留为兼容逃生舱。 */
  task?: {
    /** 模板引用（TASK_TEMPLATES id——与内联 title/text 二选一） */
    template?: string;
    /** 模板参数（值支持 {{taskId}}/{{role}}/{{detail}} 事件变量） */
    params?: Record<string, unknown>;
    /** 内联标题（模板引用时 = 标题覆盖） */
    title?: string;
    /** 内联正文（仅内联形态；模板引用时忽略） */
    text?: string;
    role?: string;
    tags?: string[];
    retask?: boolean;
    /** 完整 FlowSpec（TaskFlow ↔ Trigger 接合——TaskResolver 直接执行该 flow） */
    flow?: FlowSpec;
  };
  /** 原生 action（调用注册 handler）——与 task 至少其一 */
  action?: TriggerAction;
  enabled?: boolean;
  once?: boolean;
  maxFires?: number;
}

/** 原生 action 触发上下文 */
export interface TriggerFireContext {
  trigger: TriggerDef;
  /** 模板变量（event 源为任务事件字段；schedule 源为空） */
  vars: Record<string, string>;
  /** 事件源（schedule 源为 undefined） */
  event?: ActivityEvent;
  source: "event" | "schedule";
}

/** 原生 action handler。返回 { nextMs } 可覆盖 schedule 下一跳间隔（动态退避）。 */
export type TriggerActionHandler = (ctx: TriggerFireContext) => Promise<void | { nextMs?: number }> | void | { nextMs?: number };

interface TriggerEntry {
  id: string;
  def: TriggerDef;
  fireCount: number;
  /** 定时触发：上次触发时间（ms）——到点判定依据 */
  lastFiredAt: number;
  /** 动态重排：handler 返回的下一跳间隔（null = 用 def.schedule.everySec） */
  nextDelayMs: number | null;
}

const TRIGGER_KIND = "trigger";
const MAX_CHAIN_DEPTH = 5;

export class TriggerEngine {
  private triggers: TriggerEntry[] = [];
  /** 系统级 trigger（代码内置——非 memory 存储——reload 不覆盖；Origin 升级链用） */
  private systemTriggers: TriggerEntry[] = [];
  private loadedAt = 0;
  private unsubscribe: (() => void) | null = null;
  /** 原生 action 注册表（type → handler） */
  private actions = new Map<string, TriggerActionHandler>();
  /** 热重载周期（memory 是真相源——30s 刷新——CRUD 后最多 30s 生效） */
  private readonly reloadMs = 30_000;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  /** 定时触发检查周期（scheduler——每 2s 检查一次到点；测试可注入缩短） */
  private readonly scheduleTickMs: number;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: {
    activityHub: ActivityHub;
    tasks: TaskStore;
    memory: PgMemoryStore;
    logger?: (msg: string) => void;
    /** 调度心跳周期（缺省 2s；测试注入 20ms 加速） */
    scheduleTickMs?: number;
  }) {
    this.scheduleTickMs = Math.max(10, deps.scheduleTickMs ?? 2_000);
  }

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
    const entries = await this.deps.memory.retrieve({ kinds: [TRIGGER_KIND], status: ["official"], tenantId: DEFAULT_TENANT_ID });
    const loaded: TriggerEntry[] = [];
    for (const e of entries) {
      try {
        const def = JSON.parse(e.content) as TriggerDef;
        if (def.enabled === false) continue;
        // task 与 action 至少其一（trigger 统一化：控制环原生动作 + 治理任务发布并存）
        const hasAction = typeof def.action?.type === "string" && def.action.type.trim() !== "";
        const hasInlineTask = Boolean(def.task?.title && def.task?.text);
        const hasTemplateTask = typeof def.task?.template === "string" && def.task.template.trim() !== "";
        const hasRetask = def.task?.retask === true;
        if (!hasAction && !hasInlineTask && !hasTemplateTask && !hasRetask) continue;
        // TaskFlow ↔ Trigger：携带完整 FlowSpec 时注册期即校验（非法 flow 不装载）。
        if (def.task?.flow !== undefined && !validateFlow(def.task.flow).ok) continue;
        // 事件/定时至少其一（backlog 差距 12——schedule 定时源）
        if (!def.event && !def.schedule?.everySec) continue;
        const prev = this.triggers.find((t) => t.id === e.id);
        loaded.push({ id: e.id, def, fireCount: prev?.fireCount ?? 0, lastFiredAt: prev?.lastFiredAt ?? 0, nextDelayMs: null });
      } catch { /* 非法 JSON 跳过 */ }
    }
    this.triggers = loaded;
    this.loadedAt = Date.now();
    return loaded.length;
  }

  /** 注册系统级 trigger（幂等——按 name 去重；不受 once/maxFires 移除影响） */
  addSystemTrigger(def: TriggerDef): void {
    if (this.systemTriggers.some((t) => t.def.name === def.name)) return;
    this.systemTriggers.push({ id: `system:${def.name}`, def: { ...def, enabled: true }, fireCount: 0, lastFiredAt: 0, nextDelayMs: null });
  }

  /** 注册原生 action handler（trigger 统一化：确定性控制环走原生动作） */
  registerAction(type: string, handler: TriggerActionHandler): void {
    this.actions.set(type, handler);
  }

  /** 运行时观测面：system + memory 全部 trigger 快照 */
  listTriggers(): Array<{
    id: string;
    name: string;
    source: "system" | "memory";
    event?: string;
    scheduleEverySec?: number;
    actionType?: string;
    fireCount: number;
    lastFiredAt: number;
  }> {
    const fmt = (t: TriggerEntry, source: "system" | "memory") => ({
      id: t.id,
      name: t.def.name,
      source,
      event: t.def.event,
      scheduleEverySec: t.def.schedule?.everySec,
      actionType: t.def.action?.type,
      fireCount: t.fireCount,
      lastFiredAt: t.lastFiredAt,
    });
    return [...this.systemTriggers.map((t) => fmt(t, "system")), ...this.triggers.map((t) => fmt(t, "memory"))];
  }

  /** 定时源检查（backlog 差距 12）：每 tick 检查 schedule triggers 是否到点（lastFiredAt + everySec/nextMs） */
  private async onScheduleTick(): Promise<void> {
    const now = Date.now();
    for (const t of [...this.systemTriggers, ...this.triggers]) {
      if (!t.def.schedule?.everySec || t.def.schedule.everySec <= 0) continue;
      const everyMs = t.nextDelayMs ?? t.def.schedule.everySec * 1000;
      if (now - t.lastFiredAt < everyMs) continue;
      if (t.def.maxFires !== undefined && t.fireCount >= t.def.maxFires) continue;
      t.fireCount++;
      t.lastFiredAt = now;
      try {
        await this.fireTrigger(t, {}, 0, "schedule");
      } catch (err) {
        this.deps.logger?.(`[trigger] ${t.def.name} 定时触发失败: ${(err as Error).message}`);
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
      try {
        // retask 模式（Origin 升级链——2026-08-10 设计 D3）：重发布原任务（正文继承）+ 转写标签
        if (t.def.task?.retask) {
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
        await this.fireTrigger(t, vars, depth, "event", e);
        if (t.def.once) {
          // once：memory 更新 enabled=false（内存已在匹配时移除——持久层同步）
          void this.deps.memory.retrieve({ kinds: [TRIGGER_KIND], tenantId: DEFAULT_TENANT_ID }).then((all) => {
            const entry = all.find((x) => x.id === t.id);
            if (entry) {
              const def = { ...t.def, enabled: false };
              return this.deps.memory.write({ id: entry.id, tenantId: DEFAULT_TENANT_ID, kind: entry.kind, anchors: entry.anchors, content: JSON.stringify(def, null, 2), status: "official", meta: entry.meta ?? {} }, { force: true });
            }
          }).catch(() => {});
        }
      } catch (err) {
        this.deps.logger?.(`[trigger] ${t.def.name} 触发失败: ${(err as Error).message}`);
      }
    }
  }

  private chainDepthOf(e: ActivityEvent): number {
    return Number((e as { chainDepth?: number }).chainDepth ?? 0);
  }

  /** 公共触发（事件/定时共用）：先原生 action，后任务发布（可并存）。 */
  private async fireTrigger(
    t: TriggerEntry,
    vars: Record<string, string>,
    depth: number,
    source: "event" | "schedule",
    event?: ActivityEvent,
  ): Promise<void> {
    // 原生 action（trigger 统一化：确定性控制环——错误隔离，不炸引擎）
    const actionType = t.def.action?.type;
    if (actionType) {
      const handler = this.actions.get(actionType);
      if (!handler) {
        this.deps.logger?.(`[trigger] ${t.def.name} 原生 action 未注册: ${actionType}`);
      } else {
        try {
          const res = await handler({ trigger: t.def, vars, event, source });
          // 动态重排：handler 返回 nextMs 覆盖 schedule 下一跳（退避——resolver 空转降频）
          t.nextDelayMs = res && typeof res.nextMs === "number" && res.nextMs > 0
            ? Math.max(100, Math.floor(res.nextMs))
            : null;
        } catch (err) {
          this.deps.logger?.(`[trigger] ${t.def.name} 原生 action 失败: ${(err as Error).message}`);
        }
      }
    }
    if (t.def.task && !t.def.task.retask) {
      await this.publishFromTrigger(
        t,
        vars,
        depth,
        source === "event" ? { kind: event?.kind ?? "event", taskId: event?.taskId ?? null } : undefined,
      );
    }
  }

  /** 公共发布（事件/定时共用）：模板引用优先（resolveTemplateTask 统一收口）→ 内联兼容。 */
  private async publishFromTrigger(
    t: TriggerEntry,
    vars: Record<string, string>,
    depth: number,
    source?: { kind: string; taskId: string | null },
  ): Promise<void> {
    const taskDef = t.def.task!;
    const render = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

    let title: string;
    let text: string;
    let tags: string[];
    let role: string | undefined;
    let goal: string | undefined;
    let workMode: import("@away_from/pth-contracts").WorkMode | undefined;
    let payload: Record<string, unknown> = {};

    if (taskDef.template) {
      // 模板引用：事件变量注入 params → 必填校验 → render → 路由/title/payload 统一解析
      const r = resolveTemplateTask(
        {
          template: taskDef.template,
          params: taskDef.params,
          title: taskDef.title,
          tags: taskDef.tags,
          role: taskDef.role,
        },
        { eventVars: vars },
      );
      if (!r.ok) {
        this.deps.logger?.(`[trigger] ${t.def.name} 模板解析失败: ${r.error}`);
        return;
      }
      title = r.title;
      text = r.text;
      tags = r.tags;
      role = r.role;
      goal = r.goal;
      workMode = r.workMode;
      payload = r.payload;
    } else {
      // 内联兼容逃生舱（旧 memory kind='trigger' 定义继续可用）
      title = render(taskDef.title ?? "");
      text = render(taskDef.text ?? "");
      tags = taskDef.tags ?? [];
      role = taskDef.role;
    }

    // TaskFlow ↔ Trigger：完整 FlowSpec 优先；无 flow 时保留既有单 stage role 兼容。
    const flowPayload = taskDef.flow
      ? { flow: taskDef.flow }
      : (role ? { flow: { stages: [{ task: { role } }] } } : {});
    const task = await this.deps.tasks.publish({
      title,
      text,
      createdBy: `trigger:${t.def.name}`,
      // 任务池纯化（D5）：无默认标签——trigger 任务必须自带路由依据（role 或合法角色标签），
      // 注册期已校验；publish 校验失败（如角色后续被移除）会进 catch 记日志，不炸引擎
      tags,
      ...(workMode ? { workMode } : {}),
      ...(goal ? { goal } : {}),
      payload: {
        ...flowPayload,
        ...payload,
        ...(taskDef.flow ? { flow: taskDef.flow } : {}),
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
