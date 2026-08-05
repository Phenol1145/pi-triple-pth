import { Registry, Gauge, Histogram, Counter, collectDefaultMetrics } from "prom-client";
import type { Redis } from "ioredis";

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const sessionsActive = new Gauge({
    name: "pi_sessions_active",
    help: "Currently active agent sessions",
    registers: [registry],
  });

  const promptDuration = new Histogram({
    name: "pi_prompt_duration_seconds",
    help: "Prompt execution duration",
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const tokensTotal = new Counter({
    name: "pi_tokens_total",
    help: "Total token usage",
    labelNames: ["tenant", "type"] as const,
    registers: [registry],
  });

  const toolCallsTotal = new Counter({
    name: "pi_tool_calls_total",
    help: "Total tool calls",
    labelNames: ["tool", "tenant"] as const,
    registers: [registry],
  });

  const workflowStepsTotal = new Counter({
    name: "pi_workflow_steps_total",
    help: "Total workflow steps executed",
    registers: [registry],
  });

  const selfModifyTotal = new Counter({
    name: "pi_self_modify_total",
    help: "Self-modification events",
    labelNames: ["layer"] as const,
    registers: [registry],
  });

  const redisUsedMemory = new Gauge({
    name: "pi_redis_used_memory_bytes",
    help: "Redis used memory in bytes",
    registers: [registry],
  });

  const redisMaxMemory = new Gauge({
    name: "pi_redis_max_memory_bytes",
    help: "Redis max memory limit in bytes (0 = unlimited)",
    registers: [registry],
  });

  return { registry, sessionsActive, promptDuration, tokensTotal, toolCallsTotal, workflowStepsTotal, selfModifyTotal, redisUsedMemory, redisMaxMemory };
}

export type Metrics = ReturnType<typeof createMetrics>;

/**
 * Start periodic Redis memory metrics collection.
 * Calls INFO memory every 15s and updates used_memory / maxmemory gauges.
 * Alert threshold (runbook): used_memory > 80% maxmemory → human intervention required.
 */
export function startRedisMetrics(redis: Redis, metrics: Metrics, intervalMs = 15_000): NodeJS.Timer {
  const collect = async () => {
    try {
      const info = await redis.info("memory");
      const lines = info.split("\n");
      let used = 0;
      let max = 0;
      for (const line of lines) {
        if (line.startsWith("used_memory:")) used = parseInt(line.split(":")[1], 10);
        if (line.startsWith("maxmemory:")) max = parseInt(line.split(":")[1], 10);
      }
      metrics.redisUsedMemory.set(used);
      metrics.redisMaxMemory.set(max);
    } catch {
      // redis unreachable — gauges retain last value; do not crash metrics endpoint
    }
  };
  collect();
  return setInterval(collect, intervalMs);
}
