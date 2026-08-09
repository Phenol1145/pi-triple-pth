import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { Redis } from "ioredis";
import type { AgentEngine } from "../core/agent-engine.js";
import type { ToolPlatform } from "../tools/platform.js";
import type { ProgramStore } from "../programs/store.js";
import type { Metrics } from "../observability/metrics.js";
import type { Logger } from "@pi-triple/infra";
import type { SessionStore } from "../storage/interfaces.js";
import { createAuthHook } from "./auth.js";
import { registerSessionRoutes } from "./routes-sessions.js";
import { registerSelfRoutes } from "./routes-self.js";
import { registerProgramRoutes } from "./routes-programs.js";
import { registerFallbackRoutes } from "./routes-fallback.js";
import { registerObserveRoutes } from "./routes-observe.js";
import { registerEventsRoutes } from "./routes-events.js";
import { registerDebugRoutes, type DebugGatewayFactory } from "./routes-debug.js";
import { registerKernelRoutes } from "./routes-kernel.js";
import type { FallbackRequestStore } from "../fallback/requests.js";
import type { SandboxHealthMonitor } from "../tools/sandbox-bash.js";
import type { AuditWriter } from "../observability/audit.js";

export async function createServer(deps: {
  redis: Redis;
  engine: AgentEngine;
  toolPlatform: ToolPlatform;
  metrics: Metrics;
  logger: Logger;
  port?: number;
  /** F/WP4 Task 17：构件存储（components 卷）。可选。 */
  programs?: ProgramStore;
  /** F/WP4 Task 20：fallback_requests 回退请求队列。可选。 */
  fallback?: FallbackRequestStore;
  /** F/WP3 Task 13：sandbox 失效降级监控（/health 联动）。可选。 */
  sandboxMonitor?: SandboxHealthMonitor;
  /** F/WP4 Task 21：Redis 会话痕迹（hub observe 只读观测）。可选——不传则不注册 observe 路由。 */
  sessionStore?: SessionStore;
  /** F/WP4 Task 22：hub debug 调试网关工厂（WebSocket → sandbox 调试会话）。可选。 */
  debugGateway?: DebugGatewayFactory;
  /** 审计（hub debug 会话审计）。可选。 */
  audit?: AuditWriter;
  /** PTH kernel 运行时（装配层）——可选；传则注册 /kernel/* 路由。 */
  kernelRuntime?: import("../kernel/assembly.js").KernelRuntime | null;
  /** 性能自持（v0.8）：PerfAutopilot 状态（/kernel/status 暴露）。可选。 */
  autopilot?: { status: () => unknown } | null;
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
    registerProgramRoutes(app, deps.engine, deps.programs, deps.fallback);
  }
  if (deps.fallback) {
    registerFallbackRoutes(app, deps.fallback);
  }
  if (deps.sessionStore) {
    registerObserveRoutes(app, deps.sessionStore, deps.engine);
  }
  // F/WP5 Task 27：外部事件 webhook 入口（转发常驻会话→agent-lab 订阅派发器）
  registerEventsRoutes(app, deps.engine, deps.audit);
  if (deps.debugGateway) {
    registerDebugRoutes(app, { gatewayFactory: deps.debugGateway, audit: deps.audit });
  }
  if (deps.kernelRuntime) {
    registerKernelRoutes(app, deps.kernelRuntime, deps.autopilot);
  } else {
    registerKernelRoutes(app, null, deps.autopilot);
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
