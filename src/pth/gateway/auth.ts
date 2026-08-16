import type { FastifyRequest, FastifyReply } from "fastify";
import type { Redis } from "ioredis";

export interface AuthContext {
  tenantId: string;
  role: "platform-admin" | "tenant-agent";
  /** P1-3：服务器端从 token 声明派生的调用主体 id——业务写操作 createdBy 只取此值 */
  principalId: string;
  /** 服务器从认证 token 声明读取的记忆空间；只有显式签发 space 的 token 才能使用 memory-bridge */
  space?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export function createAuthHook(redis: Redis) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // P0-1（2026-08-15）：只有健康/指标端点免鉴权；memory-bridge 不再豁免
    if (req.url === "/health" || req.url === "/metrics") return;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing authorization" });
    }
    const token = header.slice(7);
    const raw = await redis.get(`auth:token:${token}`);
    if (!raw) {
      return reply.status(401).send({ error: "Invalid token" });
    }
    try {
      const parsed = JSON.parse(raw) as { tenantId?: unknown; role?: unknown; space?: unknown };
      if (typeof parsed.tenantId !== "string" || parsed.tenantId.trim() === "") {
        return reply.status(401).send({ error: "Invalid token data" });
      }
      req.auth = {
        tenantId: parsed.tenantId,
        role: parsed.role === "platform-admin" ? "platform-admin" : "tenant-agent",
        principalId: `tenant:${parsed.tenantId}:${parsed.role === "platform-admin" ? "platform-admin" : "tenant-agent"}`,
        ...(typeof parsed.space === "string" && parsed.space.trim() !== "" ? { space: parsed.space } : {}),
      };
    } catch {
      return reply.status(401).send({ error: "Invalid token data" });
    }
  };
}
