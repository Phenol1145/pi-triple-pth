import type { FastifyInstance } from "fastify";
import type { ToolPlatform } from "../tools/platform.js";
import type { SandboxHealthMonitor } from "../impls/kernels/index.js";

export function registerSelfRoutes(
  app: FastifyInstance,
  toolPlatform: ToolPlatform,
  platformVersion: string,
  /** F/WP3 Task 13：sandbox 失效降级监控。接线后 /health 反映 sandbox 子状态；degraded → 503 unhealthy。 */
  sandboxMonitor?: SandboxHealthMonitor,
) {
  app.get("/api/v1/self/tools", async (req) => {
    return { tools: toolPlatform.getAllowedTools(req.auth.tenantId) };
  });

  app.get("/api/v1/self/version", async () => {
    return { version: platformVersion, node: process.version, platform: process.platform };
  });

  app.get("/health", async (_req, reply) => {
    if (sandboxMonitor?.isDegraded()) {
      // degraded → 503 unhealthy（compose healthcheck 可见）+ 子状态字段（观测/排障）
      reply.code(503);
      return {
        status: "degraded",
        uptime: process.uptime(),
        sandbox: {
          status: "degraded",
          consecutiveFailures: sandboxMonitor.getConsecutiveFailures(),
          threshold: sandboxMonitor.threshold,
        },
      };
    }
    return {
      status: "ok",
      uptime: process.uptime(),
      // 接线监控时附带 sandbox 子状态；未接线（本机开发）保持原响应形状
      ...(sandboxMonitor
        ? {
            sandbox: {
              status: "ok",
              consecutiveFailures: sandboxMonitor.getConsecutiveFailures(),
              threshold: sandboxMonitor.threshold,
            },
          }
        : {}),
    };
  });
}
