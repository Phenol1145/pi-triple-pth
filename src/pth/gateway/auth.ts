import type { FastifyRequest, FastifyReply } from "fastify";
import type { Redis } from "ioredis";

export interface AuthContext {
  tenantId: string;
  role: "platform-admin" | "tenant-agent";
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export function createAuthHook(redis: Redis) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
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
      const { tenantId, role } = JSON.parse(raw);
      req.auth = { tenantId, role: role ?? "tenant-agent" };
    } catch {
      return reply.status(401).send({ error: "Invalid token data" });
    }
  };
}
