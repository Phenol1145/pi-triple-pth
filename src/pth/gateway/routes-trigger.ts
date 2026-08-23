/**
 * routes-trigger —— trigger 管理 API（事件触发任务——trigger 组件落地）
 *
 *   GET    /api/v1/kernel/triggers          trigger 列表（memory kind='trigger'）
 *   POST   /api/v1/kernel/triggers          创建 trigger（{name, event, match?, task, enabled?, once?, maxFires?}）
 *   POST   /api/v1/kernel/triggers/:id/toggle   启用/禁用（{enabled}）
 *   DELETE /api/v1/kernel/triggers/:id      删除
 *   POST   /api/v1/kernel/triggers/reload   立即重载（引擎 30s 周期外的即时生效通道）
 */

import type { FastifyInstance } from "fastify";
import type { PthGatewayFacade } from "../application/index.js";
import { randomUUID } from "node:crypto";
import { checkTaskRouting } from "../kernel/index.js";
import { validateFlow } from "@away_from/pth-kernel-execution";

const KERNEL_UNAVAILABLE = { error: "kernel unavailable", reason: "DATABASE_URL 未配置或 pg 不可达" };
const TRIGGER_KIND = "trigger";

export function registerTriggerRoutes(app: FastifyInstance, facade: PthGatewayFacade | null): void {
  const unavailable = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.status(503).send(KERNEL_UNAVAILABLE);

  app.get("/api/v1/kernel/triggers", async (_req, reply) => {
    if (!facade) return unavailable(reply);
    // 只列 active（official）——archived（删除/once 禁用）不进列表
    const entries = await facade.retrieveMemory({ kinds: [TRIGGER_KIND], status: ["official"] });
    return {
      triggers: entries.map((e) => {
        let def: Record<string, unknown> = {};
        try { def = JSON.parse(e.content) as Record<string, unknown>; } catch { /* 容错 */ }
        return { id: e.id, status: e.status, ...def };
      }),
    };
  });

  app.post("/api/v1/kernel/triggers", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.status(400).send({ error: "name required" });
    }

    const event = typeof body.event === "string" && body.event.trim() !== "" ? body.event.trim() : undefined;
    const schedule = body.schedule && typeof body.schedule === "object" && !Array.isArray(body.schedule)
      ? body.schedule as { everySec?: unknown }
      : undefined;
    const scheduleOk = schedule !== undefined
      && typeof schedule.everySec === "number"
      && Number.isFinite(schedule.everySec)
      && schedule.everySec > 0;
    if (!event && !scheduleOk) {
      return reply.status(400).send({ error: "event 或 schedule.everySec (>0) 至少其一" });
    }

    const task = body.task && typeof body.task === "object" && !Array.isArray(body.task)
      ? body.task as {
          title?: unknown; text?: unknown; role?: unknown; tags?: unknown;
          template?: unknown; params?: unknown; retask?: unknown; flow?: unknown;
        }
      : undefined;
    const action = body.action && typeof body.action === "object" && !Array.isArray(body.action)
      ? body.action as { type?: unknown; params?: unknown }
      : undefined;

    const hasAction = typeof action?.type === "string" && action.type.trim() !== "";
    const hasRetask = task?.retask === true;
    const hasTemplate = typeof task?.template === "string" && task.template.trim() !== "";
    const hasInline = typeof task?.title === "string" && task.title.trim() !== ""
      && typeof task?.text === "string" && task.text.trim() !== "";
    const hasFlow = task?.flow !== undefined;
    if (!hasAction && !hasRetask && !hasTemplate && !hasInline) {
      return reply.status(400).send({ error: "task（title/text 或 template 或 retask）与 action 至少其一" });
    }
    if (hasRetask) {
      // retask 可无 title/text/template——重发布原任务正文。
    } else if (hasTemplate) {
      if (typeof task!.params !== "undefined" && (typeof task!.params !== "object" || task!.params === null || Array.isArray(task!.params))) {
        return reply.status(400).send({ error: "task.params 必须是对象" });
      }
    } else if (!hasInline) {
      return reply.status(400).send({ error: "task 必须提供 title/text、template 或 retask=true" });
    }

    // TaskFlow ↔ Trigger：完整 FlowSpec 注册期校验。
    if (hasFlow) {
      const flowCheck = validateFlow(task!.flow);
      if (!flowCheck.ok) {
        return reply.status(400).send({ error: `task.flow 非法: ${flowCheck.error}` });
      }
    }

    // 任务池纯化（D5）：task 发布路径注册期即校验可路由。
    if (hasAction === false || hasRetask || hasTemplate || hasInline || hasFlow) {
      const routePayload = task?.flow !== undefined
        ? { flow: task.flow }
        : (task?.role !== undefined && typeof task.role === "string" && task.role.trim() !== ""
            ? { flow: { stages: [{ task: { role: task.role } }] } }
            : {});
      const tags = Array.isArray(task?.tags) ? task.tags.filter((t): t is string => typeof t === "string") : [];
      const routeCheck = checkTaskRouting({ tags, payload: routePayload });
      if (!routeCheck.ok) {
        return reply.status(400).send({ error: `trigger 任务不可路由: ${routeCheck.error}` });
      }
    }

    const id = `trigger-${randomUUID().slice(0, 8)}`;
    const taskDef = task ? {
      ...(task.title !== undefined ? { title: String(task.title) } : {}),
      ...(task.text !== undefined ? { text: String(task.text) } : {}),
      ...(typeof task.role === "string" && task.role.trim() !== "" ? { role: task.role.trim() } : {}),
      ...(Array.isArray(task.tags) ? { tags: task.tags.filter((t): t is string => typeof t === "string") } : {}),
      ...(typeof task.template === "string" && task.template.trim() !== "" ? { template: task.template.trim() } : {}),
      ...(task.params !== undefined ? { params: task.params } : {}),
      ...(task.retask === true ? { retask: true } : {}),
      ...(task.flow !== undefined ? { flow: task.flow } : {}),
    } : undefined;
    const def = {
      name,
      ...(event ? { event } : {}),
      ...(scheduleOk ? { schedule: { everySec: schedule!.everySec } } : {}),
      ...(body.match ? { match: body.match } : {}),
      ...(taskDef ? { task: taskDef } : {}),
      ...(hasAction ? { action: { type: action!.type, ...(action!.params !== undefined ? { params: action!.params } : {}) } } : {}),
      enabled: body.enabled !== false,
      ...(body.once ? { once: true } : {}),
      ...(typeof body.maxFires === "number" ? { maxFires: body.maxFires } : {}),
    };
    await facade.writeMemory({
      id, kind: TRIGGER_KIND,
      anchors: ["trigger", event ?? "schedule", name],
      content: JSON.stringify(def, null, 2),
      status: "official",
      meta: { createdVia: "api" },
    });
    await facade.reloadTriggers().catch(() => {});
    return reply.status(201).send({ id, ...def });
  });

  app.post("/api/v1/kernel/triggers/:id/toggle", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const entries = await facade.retrieveMemory({ kinds: [TRIGGER_KIND] });
    const entry = entries.find((e) => e.id === id);
    if (!entry) return reply.status(404).send({ error: "trigger not found", id });
    let def: Record<string, unknown> = {};
    try { def = JSON.parse(entry.content) as Record<string, unknown>; } catch { /* 容错 */ }
    def.enabled = body.enabled !== false;
    await facade.writeMemory({
      id: entry.id, kind: entry.kind, anchors: entry.anchors,
      content: JSON.stringify(def, null, 2), status: entry.status, meta: entry.meta ?? {},
    }, { force: true });
    await facade.reloadTriggers().catch(() => {});
    return { id, enabled: def.enabled };
  });

  app.delete("/api/v1/kernel/triggers/:id", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    const entries = await facade.retrieveMemory({ kinds: [TRIGGER_KIND] });
    const entry = entries.find((e) => e.id === id);
    if (!entry) return reply.status(404).send({ error: "trigger not found", id });
    // 删除 = archived（memory 无硬删除——状态流转）
    await facade.writeMemory({
      id: entry.id, kind: entry.kind, anchors: entry.anchors,
      content: entry.content, status: "archived", meta: { ...(entry.meta ?? {}), deleted: true },
    }, { force: true });
    await facade.reloadTriggers().catch(() => {});
    return { id, status: "archived" };
  });

  app.post("/api/v1/kernel/triggers/reload", async (_req, reply) => {
    if (!facade) return unavailable(reply);
    const n = await facade.reloadTriggers();
    return { reloaded: n };
  });
}
