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
import type { PthGatewayFacade } from "../application/gateway/pth-gateway-facade.js";
import { randomUUID } from "node:crypto";
import { checkTaskRouting } from "../kernel/execution/role-router.js";

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
    const event = typeof body.event === "string" ? body.event.trim() : "";
    const task = body.task as { title?: string; text?: string; role?: string; tags?: string[] } | undefined;
    if (!name || !event || !task?.title || !task?.text) {
      return reply.status(400).send({ error: "name/event/task.title/task.text required" });
    }
    // 任务池纯化（D5）：trigger 任务注册期即校验可路由（role 或合法角色标签——防触发时publish 400 静默失败）
    const routeCheck = checkTaskRouting({
      tags: task.tags ?? [],
      payload: task.role ? { flow: { stages: [{ task: { role: task.role } }] } } : {},
    });
    if (!routeCheck.ok) {
      return reply.status(400).send({ error: `trigger 任务不可路由: ${routeCheck.error}` });
    }
    const id = `trigger-${randomUUID().slice(0, 8)}`;
    const def = {
      name, event,
      ...(body.match ? { match: body.match } : {}),
      task: { title: task.title, text: task.text, ...(task.role ? { role: task.role } : {}), ...(task.tags ? { tags: task.tags } : {}) },
      enabled: body.enabled !== false,
      ...(body.once ? { once: true } : {}),
      ...(typeof body.maxFires === "number" ? { maxFires: body.maxFires } : {}),
    };
    await facade.writeMemory({
      id, kind: TRIGGER_KIND,
      anchors: ["trigger", event, name],
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
