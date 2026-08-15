/**
 * routes-jobs.ts — 异步 job 委托（v0.8 循环①）
 *
 * 交互层（PTL）一次提交 job（计划 → 多任务批量发布）→ 立即返回 job id（脱手——
 * 主会话不阻塞，继续处理其他事物）→ PTH 任务池异步执行 → 交互层后续查状态/收产物。
 *
 *   POST /api/v1/kernel/jobs        {name?, plan?, tasks:[{title,text,tags?}...]} → {jobId, taskIds}
 *   GET  /api/v1/kernel/jobs        job 列表（job_id → 任务数/完成数/状态聚合）
 *   GET  /api/v1/kernel/jobs/:id    job 详情（任务明细 + 产物 outputRef）
 *
 * job 无独立表：tasks.job_id 关联 + 聚合查询（v1——轻量；多 job 并行天然支持）。
 */

import type { FastifyInstance } from "fastify";
import type { KernelRuntime } from "../kernel/assembly.js";

export function registerJobRoutes(app: FastifyInstance, kernel: KernelRuntime | null): void {
  const unavailable = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(503).send({ error: "kernel 未装配" });

  // ── 提交 job（计划 → 批量任务——立即返回，脱手）──────────────────
  app.post("/api/v1/kernel/jobs", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tasks = Array.isArray(body.tasks) ? (body.tasks as Array<Record<string, unknown>>) : [];
    if (tasks.length === 0 || tasks.length > 50) {
      return reply.status(400).send({ error: "tasks 必填（1-50 个）：[{title,text,tags?}]" });
    }
    const jobId = crypto.randomUUID();
    const taskIds: string[] = [];
    const createdBy = typeof body.createdBy === "string" ? body.createdBy : "ptl";
    const tenantId = (req as unknown as { auth?: { tenantId?: string } }).auth?.tenantId ?? "default";
    for (const t of tasks) {
      const title = String(t.title ?? "").trim();
      const text = String(t.text ?? "").trim();
      if (!title || !text) {
        return reply.status(400).send({ error: "task 缺 title/text" });
      }
      if (title.length > 200 || text.length > 64 * 1024) {
        return reply.status(400).send({ error: `task too large: ${title.slice(0, 40)}` });
      }
      const tags = Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [];
      const task = await kernel.dataWorld.tasks.publish({
        title, text, createdBy, tags,
        payload: { job: { id: jobId, plan: typeof body.plan === "string" ? body.plan.slice(0, 4000) : undefined } },
        jobId,
        tenantId,
      });
      taskIds.push(task.id);
    }
    // 立即返回（脱手——交互层不阻塞；任务在 PTH 任务池异步执行）
    return reply.status(201).send({ jobId, taskIds, status: "submitted", tasks: taskIds.length });
  });

  // ── job 列表（聚合：job_id → 任务数/完成数/状态）──────────────────
  app.get("/api/v1/kernel/jobs", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const res = await kernel.pool.query(
      `SELECT job_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status IN ('rejected','escalated'))::int AS failed,
              min(created_at) AS created_at
       FROM tasks WHERE job_id IS NOT NULL
       GROUP BY job_id ORDER BY min(created_at) DESC LIMIT 50`,
    );
    const jobs = res.rows.map((r: any) => ({
      jobId: r.job_id,
      total: r.total,
      completed: r.completed,
      failed: r.failed,
      status: Number(r.completed) + Number(r.failed) >= Number(r.total) ? "completed" : "running",
      createdAt: r.created_at,
    }));
    return { jobs };
  });

  // ── job 详情（任务明细 + 产物）────────────────────────────────
  app.get("/api/v1/kernel/jobs/:id", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const { id } = req.params as { id: string };
    const res = await kernel.pool.query(
      `SELECT id, title, text, tags, status, assigned_role, claimed_by,
              payload, created_at, completed_at,
              (rejects->-1->>'reason') AS last_reject
       FROM tasks WHERE job_id = $1 ORDER BY created_at`,
      [id],
    );
    const tasks = res.rows.map((r: any) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        title: r.title,
        text: String(r.text).slice(0, 200),
        tags: r.tags,
        status: r.status,
        role: r.assigned_role,
        error: r.last_reject ?? null,
        // 产物（outputRef.ref——执行结果 value/耗时）
        result: (payload.outputRef as { ref?: unknown } | undefined)?.ref ?? null,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      };
    });
    const completed = tasks.filter((t: { status: string }) => t.status === "completed").length;
    const failed = tasks.filter((t: { status: string }) => t.status === "rejected" || t.status === "escalated").length;
    return {
      jobId: id,
      status: completed + failed >= tasks.length ? "completed" : "running",
      total: tasks.length,
      completed, failed,
      tasks,
    };
  });
}
