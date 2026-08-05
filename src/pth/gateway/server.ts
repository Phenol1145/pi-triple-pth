import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { Redis } from "ioredis";
import type { AgentEngine } from "../core/agent-engine.js";
import type { ToolPlatform } from "../tools/platform.js";
import type { ProgramStore } from "../programs/store.js";
import type { Metrics } from "../observability/metrics.js";
import type { Logger } from "../../shared/observability/logger.js";
import { createAuthHook } from "./auth.js";
import { registerSessionRoutes } from "./routes-sessions.js";
import { registerSelfRoutes } from "./routes-self.js";
import { registerProgramRoutes } from "./routes-programs.js";
import type { SandboxHealthMonitor } from "../tools/sandbox-bash.js";

export async function createServer(deps: {
  redis: Redis;
  engine: AgentEngine;
  toolPlatform: ToolPlatform;
  metrics: Metrics;
  logger: Logger;
  port?: number;
  programs?: ProgramStore;
  /** F/WP3 Task 13：sandbox 失效降级监控（/health 联动）。可选。 */
  sandboxMonitor?: SandboxHealthMonitor;
}) {
  const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });

  await app.register(websocket);
  app.addHook("onRequest", createAuthHook(deps.redis));

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });

  registerSessionRoutes(app, deps.engine);
  if (deps.programs) {
    registerProgramRoutes(app, deps.engine, deps.programs);
  }
  registerSelfRoutes(app, deps.toolPlatform, "0.1.0", deps.sandboxMonitor);

  app.get("/ws", { websocket: true }, (socket, req) => {
    const tenantId = (req as any).auth?.tenantId;
    socket.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "prompt") {
          for await (const event of deps.engine.prompt(msg.sessionId, tenantId, msg.text)) {
            socket.send(JSON.stringify({ type: "event", sessionId: msg.sessionId, event }));
          }
          socket.send(JSON.stringify({ type: "done", sessionId: msg.sessionId }));
        } else if (msg.type === "abort") {
          await deps.engine.abort(msg.sessionId, tenantId);
        }
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", error: String(err) }));
      }
    });
  });

  return app;
}
