import type { FastifyInstance } from "fastify";
import type { AgentEngine } from "../core/agent-engine.js";
import { writeSSE } from "./sse.js";

export function registerSessionRoutes(app: FastifyInstance, engine: AgentEngine) {
  app.post("/api/v1/sessions", async (req, reply) => {
    const { project, provider, model, thinkingLevel } = req.body as any;
    const result = await engine.createSession({
      tenantId: req.auth.tenantId,
      project,
      provider,
      model,
      thinkingLevel,
    });
    if (!result.ok) return reply.status(429).send({ error: result.error });
    return reply.status(201).send(result.data);
  });

  app.post("/api/v1/sessions/:id/prompt", async (req, reply) => {
    const { text } = req.body as any;
    const sessionId = (req.params as any).id;

    await writeSSE(reply, engine.prompt(sessionId, req.auth.tenantId, text));
  });

  app.post("/api/v1/sessions/:id/abort", async (req, reply) => {
    try {
      await engine.abort((req.params as any).id, req.auth.tenantId);
      return { ok: true };
    } catch (err: any) {
      if (String(err).includes("Forbidden")) return reply.status(403).send({ error: String(err) });
      if (String(err).includes("not found")) return reply.status(404).send({ error: String(err) });
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.get("/api/v1/sessions/:id", async (req, reply) => {
    const sessions = engine.listSessions(req.auth.tenantId);
    const session = sessions.find((s) => s.sessionId === (req.params as any).id);
    if (!session) return reply.status(404).send({ error: "Not found" });
    return session;
  });

  app.delete("/api/v1/sessions/:id", async (req) => {
    await engine.destroySession((req.params as any).id, req.auth.tenantId);
    return { ok: true };
  });

  app.get("/api/v1/sessions", async (req) => {
    return engine.listSessions(req.auth.tenantId);
  });
}
