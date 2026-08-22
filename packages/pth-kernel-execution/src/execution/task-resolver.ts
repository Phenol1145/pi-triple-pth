/**
 * task-resolver.ts — TaskResolver 任务解析器（任务池即工作流 T3）
 *
 * 独立组件（非 TaskLoop 钩子）：任务像携带路由信息的数据包，解析器按 payload.flow 的
 * 有序阶段表逐跳解析——每跳匹配 → 执行算子（transform/decompose/branch/loop）→
 * 注销阶段（resolvedStages.push）→ 递归下一阶段；阶段耗尽或 terminal → 终止。
 *
 * 算子（resolver-core 类型）：
 *   transform 变形（改 role/kind/status）   decompose 分解（产子任务带 deps）
 *   branch 分支（if 条件选路径）            loop 循环（until 条件 + max 防死循环）
 *   wait:true 匹配不满足时等待（不跳过）
 */

import type { TaskStore, Task } from "@away_from/pth-kernel-storage";
import { tagRegistry } from "./tag-registry.js";
import {
  matchesRule, evalCondition, validateFlow,
  type FlowSpec, type Stage,
} from "./resolver-core.js";

export interface TaskResolverDeps {
  taskStore: TaskStore;
  /** pg 池（待解析查询用——completed 任务不在 candidates 里） */
  pool?: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
  /** 阶段间最小间隔（默认 0——测试同步） */
  intervalMs?: number;
  /** 日志（日志体系 T2） */
  logger?: import("../logger.js").KernelLogger;
}

/** 解析一轮的汇总 */
export interface ResolveReport {
  processed: number;
  generated: number;
}

export class TaskResolver {
  constructor(private deps: TaskResolverDeps) {}

  /** 解析单个任务（递归：匹配→算子→注销→下一阶段） */
  async resolveOnce(task: Task): Promise<ResolveReport> {
    const report: ResolveReport = { processed: 0, generated: 0 };
    await this.resolveTask(task, report);
    return report;
  }

  private stopped = false;
  /** 停（assembly shutdown 调用——终止自调度轮询链） */
  stop(): void { this.stopped = true; }

  /** 轮询待解析任务（独立循环——与 TaskLoop 平级） */
  async resolveLoop(): Promise<ResolveReport> {
    if (this.stopped) return { processed: 0, generated: 0 };
    const report: ResolveReport = { processed: 0, generated: 0 };
    // 待解析判定（SQL：payload 含 flow 且存在未注销阶段——不限 status，completed 也要处理 verify 等阶段）
    let tasks: Task[];
    if (this.deps.pool) {
      const res = await this.deps.pool.query(
        `SELECT * FROM tasks
         WHERE payload ? 'flow'
           AND jsonb_array_length(payload->'flow'->'stages')
               > coalesce(jsonb_array_length(payload->'resolvedStages'), 0)
         LIMIT 50`,
      );
      tasks = res.rows as Task[];
    } else {
      // 无 pool（测试）：candidates 兜底（仅 pending）
      const cands = await this.deps.taskStore.candidates("resolver");
      tasks = cands.filter((t) => {
        const p = (t.payload ?? {}) as { flow?: FlowSpec; resolvedStages?: string[] };
        return !!p.flow && (p.resolvedStages ?? []).length < p.flow.stages.length;
      });
    }
    for (const task of tasks) {
      await this.resolveTask(task, report);
    }
    return report;
  }

  // ── 递归解析 ─────────────────────────────────────────────

  private async resolveTask(task: Task, report: ResolveReport): Promise<void> {
    const p = (task.payload ?? {}) as { flow?: FlowSpec; resolvedStages?: string[]; loopCount?: number; [k: string]: unknown };
    if (!p.flow) return;
    const stages = p.flow.stages;
    const resolved: string[] = p.resolvedStages ?? [];
    const loopCount = p.loopCount ?? 0;

    // 下一个活跃阶段
    const idx = resolved.length;
    if (idx >= stages.length) return;          // 阶段耗尽 → 终止
    const stage = stages[idx]!;
    report.processed++;

    // 校验（发布时已验，防御性跳过）
    const v = validateFlow(p.flow);
    if (!v.ok) return;

    // match 判定
    const matched = stage.match ? matchesRule(stage.match, task) : true;

    if (!matched) {
      if (stage.wait) {
        // 等待：不注销（下轮重试）
        return;
      }
      // 跳过：注销本阶段，继续下一阶段
      resolved.push(stage.id);
      await this.persist(task, p, resolved, loopCount);
      await this.resolveTask(task, report);
      return;
    }

    // terminal：执行后终止（不再递归）
    const isTerminal = stage.terminal === true;

    // 执行算子（优先级：branch > decompose > transform > loop）
    if (stage.branch) {
      await this.execBranch(task, stage, p, report);
    } else if (stage.decompose) {
      await this.execDecompose(task, stage, p, report);
    } else if (stage.transform) {
      this.execTransform(task, stage.transform, p);
    }

    // loop 语义（until 不满足 → 不注销 + loopCount+1）
    if (stage.loop) {
      const untilOk = evalCondition(stage.loop.until, this.buildExprCtx(task, p));
      if (!untilOk) {
        const nextLoop = loopCount + 1;
        if (nextLoop >= (stage.loop.max ?? 3)) {
          // 超限：放弃该阶段（注销 + 标记）
          resolved.push(stage.id);
          p.loopExceeded = stage.id;
          await this.persist(task, p, resolved, nextLoop);
          return;
        }
        // 继续循环：不注销，loopCount+1
        await this.persist(task, p, resolved, nextLoop);
        return;
      }
      // until 满足 → 退出循环（注销）
    }

    // 非循环或循环满足：注销本阶段
    resolved.push(stage.id);
    await this.persist(task, p, resolved, loopCount);

    // 递归下一阶段（terminal 停止）
    if (!isTerminal) {
      await this.resolveTask(task, report);
    }
  }

  // ── 算子 ─────────────────────────────────────────────────

  private execTransform(task: Task, spec: { kind?: string; role?: string; status?: string; reason?: string }, p: Record<string, unknown>): void {
    if (spec.kind !== undefined) p.kind = spec.kind;
    if (spec.role !== undefined) p.role = spec.role;
    if (spec.status !== undefined) p.status = spec.status;
    if (spec.reason !== undefined) p.reason = spec.reason;
    void task;
  }

  private async execDecompose(task: Task, stage: Stage, p: Record<string, unknown>, report: ResolveReport): Promise<void> {
    for (const spec of stage.decompose ?? []) {
      const title = interpolate(spec.title, task, p);
      const text = interpolate(spec.text, task, p);
      const published = await this.deps.taskStore.publish({
        title,
        text,
        createdBy: "resolver",
        // 任务池纯化（D5）：spec.role 翻译为该角色的注册标签（原默认 [role]/["chain"] 非合法标签）
        tags: spec.tags ?? (spec.role ? [tagRegistry.primaryTagOfRole(spec.role) ?? spec.role] : []),
        payload: {
          deps: [task.id],
          ...(spec.flow ? { flow: spec.flow } : {}),
          parent: task.id,
        },
      });
      report.generated++;
      this.deps.logger?.child("chain", { taskId: task.id })?.info("chain generated", {
        childTaskId: published.id, title, role: spec.role ?? "?",
      });
    }
  }

  private async execBranch(task: Task, stage: Stage, p: Record<string, unknown>, report: ResolveReport): Promise<void> {
    const ctx = this.buildExprCtx(task, p);
    for (const branch of stage.branch ?? []) {
      if (branch.if === undefined || evalCondition(branch.if, ctx)) {
        if (branch.decompose) {
          for (const spec of branch.decompose) {
            const published = await this.deps.taskStore.publish({
              title: interpolate(spec.title, task, p),
              text: interpolate(spec.text, task, p),
              createdBy: "resolver",
              tags: spec.tags ?? (spec.role ? [tagRegistry.primaryTagOfRole(spec.role) ?? spec.role] : []),
              payload: { deps: [task.id], ...(spec.flow ? { flow: spec.flow } : {}), parent: task.id },
            });
            report.generated++;
            this.deps.logger?.child("chain", { taskId: task.id })?.info("chain generated", {
              childTaskId: published.id, title: interpolate(spec.title, task, p), role: spec.role ?? "?",
            });
          }
        }
        if (branch.transform) this.execTransform(task, branch.transform, p);
        return;  // 首个命中分支
      }
    }
  }

  // ── 辅助 ─────────────────────────────────────────────────

  private buildExprCtx(task: Task, p: Record<string, unknown>): Record<string, unknown> {
    // outputRef 结构：{ref: <InterpreterResult>}——output.ok 对应 ref.ok（任务结果本体）
    const outputRef = (p.outputRef ?? {}) as Record<string, unknown>;
    const output = (outputRef.ref ?? outputRef) as Record<string, unknown>;
    return {
      output,
      loopCount: (p.loopCount ?? 0) as number,
      claimsCount: task.claims_count,
      status: task.status,
      ...p,
    };
  }

  private async persist(task: Task, p: Record<string, unknown>, resolved: string[], loopCount: number): Promise<void> {
    p.resolvedStages = resolved;
    p.loopCount = loopCount;
    if (this.deps.pool) {
      await this.deps.pool.query(
        `UPDATE tasks SET payload = $2::jsonb WHERE id = $1`,
        [task.id, JSON.stringify(p)],
      );
    } else {
      // 无 pool 的 mock：直接改 task 对象（测试场景）
      task.payload = p;
    }
  }
}

/** {upstream.title} / {upstream.id} 插值 */
export function interpolate(template: string, task: Task, p: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (key === "upstream.title") return task.title;
    if (key === "upstream.id") return task.id;
    if (key.startsWith("output.")) {
      const v = (p.outputRef ?? {}) as Record<string, unknown>;
      return String(v[key.slice(7)] ?? "");
    }
    return String(p[key] ?? "");
  });
}
