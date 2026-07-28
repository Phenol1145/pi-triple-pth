import type { FastifyInstance } from "fastify";
import type { ToolPlatform } from "../tools/platform.js";

export function registerSelfRoutes(
  app: FastifyInstance,
  toolPlatform: ToolPlatform,
  platformVersion: string,
) {
  app.get("/api/v1/self/tools", async (req) => {
    return { tools: toolPlatform.getAllowedTools(req.auth.tenantId) };
  });

  app.get("/api/v1/self/version", async () => {
    return { version: platformVersion, node: process.version, platform: process.platform };
  });

  app.get("/health", async () => {
    return { status: "ok", uptime: process.uptime() };
  });
}
