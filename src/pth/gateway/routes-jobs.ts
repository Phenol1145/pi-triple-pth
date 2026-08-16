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
 * 数据访问经 PthGatewayFacade（模块化 v2 P0-3）。
 */

import type { FastifyInstance } from "fastify";
import type { PthGatewayFacade } from "../application/gateway/pth-gateway-facade.js";

export function registerJobRoutes(app: FastifyInstance, facade: PthGatewayFacade | null): void {
  const unavailable = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(503).send({ error: "kernel 未装配" });

  // ── 提交 job（计划 → 批量任务——立即返回，脱手）──────────────────
  app.post("/api/v1/kernel/jobs", async (req, reply) => {
    if (!facade) return unavailable(reply);
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
      const task = await facade.publishTask({
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
    if (!facade) return unavailable(reply);
    return { jobs: await facade.listJobs() };
  });

  // ── job 详情（任务明细 + 产物）────────────────────────────────
  app.get("/api/v1/kernel/jobs/:id", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    return facade.getJob(id);
  });
}
