/**
 * gateway/routes-kernel.ts — PTH kernel 任务发布 + 运行状态路由（任务工具 Task 2）
 *
 * 数据源：KernelRuntime（装配层——pg tasks 表 + BatchManager + KernelWatchdog）。
 * 生产形态：PTL（交互层）经 PthClient HTTP 访问；监控面板后续消费 /kernel/status 全景。
 *
 *   POST /api/v1/kernel/tasks         发布任务 → 201 {id, status, ...}
 *   GET  /api/v1/kernel/tasks         任务列表（?status=&limit=）
 *   GET  /api/v1/kernel/tasks/:id     任务详情
 *   POST /api/v1/kernel/batch/add     启动 n 个 batch（默认 1）
 *   POST /api/v1/kernel/batch/remove  停止 n 个 batch（默认 1）
 *   GET  /api/v1/kernel/batch         batch 列表（含 alive 判定）
 *   GET  /api/v1/kernel/status        运行状态全景（kernel/batches/tasks/watchdog——监控面板铺垫）
 *
 * kernel 未装配（pg 不可达/null）→ 全部 503 + reason（fail-open 约定）。
 */

import type { FastifyInstance } from "fastify";
import type { KernelRuntime } from "../kernel/assembly.js";
import { TASK_TEMPLATES, renderTaskTemplate, validateTemplateParams } from "../kernel/templates.js";

const KERNEL_UNAVAILABLE = { error: "kernel unavailable", reason: "DATABASE_URL 未配置或 pg 不可达" };

export interface KernelRoutesDeps {
  kernel: KernelRuntime | null;
  /** 性能自持（v0.8）：autopilot 状态（/kernel/status 暴露） */
  autopilot?: { status: () => unknown } | null;
}

export function registerKernelRoutes(app: FastifyInstance, kernel: KernelRuntime | null, autopilot?: KernelRoutesDeps["autopilot"]): void {
  const unavailable = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(503).send(KERNEL_UNAVAILABLE);

  // ── 运行过程保留（2026-08-09）：任务轨迹查询 ──────────────────
  app.get("/api/v1/kernel/tasks/:id/transcript", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const { id } = req.params as { id: string };
    const list = await kernel.dataWorld.transcripts.listByTask(id);
    return { taskId: id, transcripts: list.map((t: any) => ({
      id: t.id,
      agentId: t.agent_id,
      summary: t.summary,
      events: t.body,        // 轨迹事件数组（llm-call/tool-call/tool-result/finish）
      createdAt: t.created_at,
    })) };
  });

  // ── 任务发布 ─────────────────────────────────────────────
  app.post("/api/v1/kernel/tasks", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 模板发布：{template, params} → 渲染任务 text
    if (typeof body.template === "string") {
      const params = (body.params ?? {}) as Record<string, unknown>;
      const missing = validateTemplateParams(body.template, params);
      if (missing.includes("unknown-template")) {
        return reply.status(404).send({ error: `unknown template: ${body.template}` });
      }
      if (missing.length > 0) {
        return reply.status(400).send({ error: `missing required params: ${missing.join(", ")}` });
      }
      const rendered = renderTaskTemplate(body.template, params);
      if (!rendered) return reply.status(404).send({ error: `unknown template: ${body.template}` });
      const tpl = TASK_TEMPLATES.find((t) => t.id === body.template)!;
      const task = await kernel.dataWorld.tasks.publish({
        title: `[${body.template}] ${tpl.name}`,
        text: rendered,
        createdBy: typeof body.createdBy === "string" ? body.createdBy : "ptl",
        tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [body.template],
        payload: { template: body.template, params },
      });
      return reply.status(201).send(task);
    }

    // 直接发布：{title, text, createdBy, tags?, payload?}
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const createdBy = typeof body.createdBy === "string" ? body.createdBy.trim() : "";
    if (!title || !text || !createdBy) {
      return reply.status(400).send({ error: "title/text/createdBy required" });
    }
    // 硬性限制：任务体积上限（防大对象撑 pg/内存/传输——64KB text / 200 字符 title）
    if (title.length > 200 || text.length > 64 * 1024) {
      return reply.status(400).send({ error: `task too large: title ≤200 chars, text ≤64KB (got ${title.length}/${text.length})` });
    }
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined;
    // payload 透传（任务链 flow 声明等路由信息——发布时 payload 即任务自带路由）
    const payload = (body.payload ?? {}) as Record<string, unknown>;
    const task = await kernel.dataWorld.tasks.publish({ title, text, createdBy, tags, payload });
    return reply.status(201).send(task);
  });

  // ── 模板列表 ──────────────────────────────────────────────
  app.get("/api/v1/kernel/templates", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    return TASK_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      params: t.params,
    }));
  });

  app.get("/api/v1/kernel/tasks", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const limit = typeof q.limit === "string" ? Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200) : 50;
    // 列表返回全部状态（pending/claimed/completed/rejected...），按创建时间倒序——
    // candidates() 只返回 pending 队列（批处理认领语义），不适合观测列表（试运行发现）。
    const res = await kernel.pool.query(
      "SELECT id, title, text, tags, status, claimed_by, claims_count, created_at, payload FROM tasks ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return res.rows;
  });

  app.get("/api/v1/kernel/tasks/:id", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const { id } = req.params as { id: string };
    const res = await kernel.pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (res.rows.length === 0) return reply.status(404).send({ error: "task not found" });
    return res.rows[0];
  });

  // ── batch 控制 ───────────────────────────────────────────
  app.post("/api/v1/kernel/batch/add", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const count = typeof body.count === "number" ? Math.min(Math.max(Math.floor(body.count), 1), 10) : 1;
    // BatchProfile（⑤）：role → reinforced 单角色堆叠；weights → balanced 自定义权重；缺省 = 默认构成
    let profile: import("../kernel/execution/worker-cluster.js").BatchProfile | undefined;
    if (typeof body.role === "string" && body.role.length > 0) {
      const copies = typeof body.copies === "number" ? Math.min(Math.max(Math.floor(body.copies), 1), 8) : 1;
      profile = { mode: "reinforced", role: body.role, copies };
    } else if (body.weights && typeof body.weights === "object") {
      profile = { mode: "balanced", weights: body.weights as Record<string, number> };
    }
    try {
      const handles = [];
      for (let i = 0; i < count; i++) {
        handles.push(await kernel.batchManager.spawnBatch(profile));
      }
      return { spawned: handles.length, mode: profile?.mode ?? "balanced", batches: handles.map((h) => ({ id: h.id, pid: h.pid, workers: h.workers })) };
    } catch (e) {
      return reply.status(400).send({ error: `batch 启动失败: ${(e as Error).message}` });
    }
  });

  // ── worker 级控制（单大 batch 启停灵活性）────────────────────────
  // POST /api/v1/kernel/batch/:id/workers {action: pause|resume|remove|add, role, copies?}
  app.post("/api/v1/kernel/batch/:id/workers", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action as string;
    const role = body.role as string;
    if (!["pause", "resume", "remove", "add"].includes(action) || typeof role !== "string") {
      return reply.status(400).send({ error: "action ∈ pause|resume|remove|add, role required" });
    }
    const copies = typeof body.copies === "number" ? Math.min(Math.max(Math.floor(body.copies), 1), 8) : 1;
    const ok = action === "pause" ? await kernel.batchManager.pauseWorker(id, role)
      : action === "resume" ? await kernel.batchManager.resumeWorker(id, role)
      : action === "remove" ? await kernel.batchManager.removeWorker(id, role)
      : await kernel.batchManager.addWorker(id, role, copies);
    if (!ok) return reply.status(404).send({ error: `batch ${id} not found / IPC 不可用` });
    return { ok: true, batchId: id, action, role, copies: action === "add" ? copies : undefined };
  });

  app.post("/api/v1/kernel/batch/remove", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const count = typeof body.count === "number" ? Math.min(Math.max(Math.floor(body.count), 1), 10) : 1;
    const batches = await kernel.batchManager.listBatches();
    const targets = batches.slice(0, count);
    for (const b of targets) await kernel.batchManager.killBatch(b.id);
    return { stopped: targets.length };
  });

  app.get("/api/v1/kernel/batch", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const batches = await kernel.batchManager.listBatches();
    return batches.map((b) => ({ ...b, alive: kernel.batchManager.isBatchAlive(b.id) }));
  });

  // ── 运行状态全景（监控面板铺垫）───────────────────────────
  app.get("/api/v1/kernel/status", async (req, reply) => {
    if (!kernel) return unavailable(reply);
    const batches = await kernel.batchManager.listBatches();
    const statuses = await kernel.pool.query(
      "SELECT status, count(*)::int AS n FROM tasks GROUP BY status",
    );
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of statuses.rows as Array<{ status: string; n: number }>) {
      counts[row.status] = row.n;
      total += row.n;
    }
    return {
      kernel: { connected: true },
      autopilot: autopilot?.status() ?? null,
      batches: batches.map((b) => ({ ...b, alive: kernel.batchManager.isBatchAlive(b.id) })),
      tasks: {
        pending: counts.pending ?? 0,
        claimed: counts.claimed ?? 0,
        submitted: counts.submitted ?? 0,
        completed: counts.completed ?? 0,
        rejected: counts.rejected ?? 0,
        escalated: counts.escalated ?? 0,
        total,
      },
      watchdog: { crashLog: kernel.watchdog.getCrashLog() },
      collectedAt: Date.now(),
    };
  });
}
