/**
 * pth/bench/http-driver.ts —— PTH Bench W1：HttpBenchDriver（task-pool 通道）。
 *
 * 通过 HTTP 调用 PTH kernel tasks 发布/轮询；依赖现有 API，不引入新依赖。
 */

import type { BenchScenario, BenchRunRecord, BenchExecPolicy } from "./core.js";

export interface HttpBenchDriverOptions {
  baseUrl: string;
  token: string;
  pollMs?: number;
  timeoutMs?: number;
}

export class HttpBenchDriver {
  constructor(private readonly opts: HttpBenchDriverOptions) {}

  async execute(scenario: BenchScenario, repeat: number, policy: BenchExecPolicy): Promise<BenchRunRecord> {
    const started = Date.now();
    const created = await this.request("/api/v1/kernel/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: `[bench] ${scenario.title}`,
        text: scenario.title,
        createdBy: "bench",
        tags: scenario.tags ?? [],
      }),
    }) as { id: string; status: string };

    const timeoutMs = policy.timeoutMs ?? this.opts.timeoutMs ?? 180_000;
    const pollMs = this.opts.pollMs ?? 1000;
    let task: Record<string, unknown> | undefined;
    for (;;) {
      const tasks = await this.request(`/api/v1/kernel/tasks?limit=50`, { method: "GET" }) as Array<Record<string, unknown>>;
      task = tasks.find((t) => t.id === created.id);
      if (task && (task.status === "completed" || task.status === "rejected")) break;
      if (Date.now() - started > timeoutMs) {
        return {
          scenarioId: scenario.id,
          repeat,
          startedAt: new Date(started).toISOString(),
          status: "timeout",
          timing: { totalMs: Date.now() - started },
          error: `task ${created.id} 超时`,
        };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    const totalMs = Date.now() - started;
    const ref = ((task?.payload as Record<string, unknown> | undefined)?.outputRef as { ref?: Record<string, unknown> } | undefined)?.ref;
    return {
      scenarioId: scenario.id,
      repeat,
      startedAt: new Date(started).toISOString(),
      status: String(task?.status ?? "?"),
      timing: { totalMs, execMs: typeof ref?.durationMs === "number" ? ref.durationMs : undefined },
      value: ref?.value,
      error: (task?.error as string | null) ?? null,
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`bench http ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}
