import { Registry, Gauge, Histogram, Counter, collectDefaultMetrics } from "prom-client";

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

  return { registry, sessionsActive, promptDuration, tokensTotal, toolCallsTotal, workflowStepsTotal, selfModifyTotal };
}

export type Metrics = ReturnType<typeof createMetrics>;
