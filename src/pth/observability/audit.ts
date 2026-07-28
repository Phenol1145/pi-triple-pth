import type { Redis } from "ioredis";

export interface AuditEvent {
  timestamp: string;
  tenantId: string;
  actor: string;
  action: string;
  details: Record<string, unknown>;
}

export class AuditWriter {
  constructor(private redis: Redis, private streamKey: string = "audit:log") {}

  async write(event: Omit<AuditEvent, "timestamp">): Promise<void> {
    const full: AuditEvent = { ...event, timestamp: new Date().toISOString() };
    await this.redis.xadd(this.streamKey, "*", "data", JSON.stringify(full));
    await this.redis.xtrim(this.streamKey, "MAXLEN", "~", 10000);
  }

  async queryToolCall(tenantId: string, tool: string, result: string): Promise<void> {
    await this.write({ tenantId, actor: "agent", action: "tool_call", details: { tool, result } });
  }

  async querySelfModify(tenantId: string, layer: string, files: string[], commitHash: string): Promise<void> {
    await this.write({ tenantId, actor: "agent", action: "self_modify", details: { layer, files, commitHash } });
  }
}
