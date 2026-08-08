/**
 * kernel-metrics.ts — PTH 性能计量（性能计量 SPEC L0/L1）
 *
 * L0 基础设施：runtime/cpu/memory/gpu（ResourceProvider 消费）
 * L1 kernel：exec 延迟/成功/截断 + 进程/队列/超时/重启
 * LLM：tokens/calls/latency（llm-fn 包装调用）
 *
 * 全部注册到传入 registry（与 /metrics 端点同源）；采样周期可配置（PTH_METRICS_INTERVAL_MS）。
 */

import { Registry, Gauge, Histogram, Counter } from "prom-client";
import { createResourceProvider } from "./resource-provider.js";

// buckets 分层（已裁决：可配置，不硬编码）
const KERNEL_BUCKETS = [0.001, 0.01, 0.1, 1, 5, 30];
const LLM_BUCKETS = [0.5, 2, 5, 15, 60, 300];

export interface KernelMetrics {
  /** L0：采样一次（provider.collect → Gauge） */
  sampleOnce(): Promise<void>;
  /** L1：kernel 执行计量（KernelManager.execute 包装） */
  kernelExec(language: string, durationMs: number, ok: boolean): void;
  kernelTruncated(language: string, field: string): void;
  kernelProcesses(language: string, count: number): void;
  kernelQueueDepth(language: string, depth: number): void;
  kernelTimeoutKill(language: string): void;
  kernelRestart(language: string): void;
  /** LLM 计量（llm-fn 包装） */
  llmCall(provider: string, model: string, durationMs: number, inputTokens: number, outputTokens: number): void;
  dispose(): void;
}

export function createKernelMetrics(deps: { registry: Registry; intervalMs?: number }): KernelMetrics {
  const registry = deps.registry;
  const provider = createResourceProvider();
  const intervalMs = deps.intervalMs ?? (parseInt(process.env.PTH_METRICS_INTERVAL_MS ?? "5000", 10) || 5000);

  // ── L0 基础设施 ────────────────────────────────────────
  const runtimeUptime = new Gauge({ name: "pth_runtime_uptime_seconds", help: "PTH process uptime", registers: [registry] });
  const runtimeEventloopLag = new Gauge({ name: "pth_runtime_eventloop_lag_seconds", help: "Event loop lag", registers: [registry] });
  const runtimeHandles = new Gauge({ name: "pth_runtime_handles_active", help: "Active handles", registers: [registry] });
  const cpuUsage = new Gauge({ name: "pth_cpu_usage_percent", help: "CPU usage percent", registers: [registry] });
  const memRss = new Gauge({ name: "pth_memory_rss_bytes", help: "RSS bytes", registers: [registry] });
  const memHeap = new Gauge({ name: "pth_memory_heap_bytes", help: "Heap bytes", labelNames: ["part"] as const, registers: [registry] });
  const memExternal = new Gauge({ name: "pth_memory_external_bytes", help: "External bytes", registers: [registry] });
  const gpuAvailable = new Gauge({ name: "pth_gpu_available", help: "GPU available (0/1)", registers: [registry] });
  const gpuUtil = new Gauge({ name: "pth_gpu_utilization_percent", help: "GPU utilization", registers: [registry] });

  // ── L1 kernel ──────────────────────────────────────────
  const execDuration = new Histogram({ name: "pth_kernel_exec_duration_seconds", help: "Kernel exec duration", labelNames: ["language"] as const, buckets: KERNEL_BUCKETS, registers: [registry] });
  const execTotal = new Counter({ name: "pth_kernel_exec_total", help: "Kernel exec count", labelNames: ["language", "ok"] as const, registers: [registry] });
  const truncatedTotal = new Counter({ name: "pth_kernel_truncated_total", help: "Kernel truncated count", labelNames: ["language", "field"] as const, registers: [registry] });
  const processes = new Gauge({ name: "pth_kernel_processes", help: "Kernel processes", labelNames: ["language"] as const, registers: [registry] });
  const queueDepth = new Gauge({ name: "pth_kernel_queue_depth", help: "Kernel queue depth", labelNames: ["language"] as const, registers: [registry] });
  const timeoutKill = new Counter({ name: "pth_kernel_timeout_kill_total", help: "Kernel timeout kills", labelNames: ["language"] as const, registers: [registry] });
  const restart = new Counter({ name: "pth_kernel_restart_total", help: "Kernel restarts", labelNames: ["language"] as const, registers: [registry] });

  // ── LLM ────────────────────────────────────────────────
  const llmCalls = new Counter({ name: "pth_llm_calls_total", help: "LLM calls", labelNames: ["provider", "model"] as const, registers: [registry] });
  const llmTokens = new Counter({ name: "pth_llm_tokens_total", help: "LLM tokens", labelNames: ["type"] as const, registers: [registry] });
  const llmLatency = new Histogram({ name: "pth_llm_latency_seconds", help: "LLM latency", buckets: LLM_BUCKETS, registers: [registry] });

  const timer = setInterval(() => { void sampleOnce().catch(() => {}); }, intervalMs);
  timer.unref?.();

  async function sampleOnce(): Promise<void> {
    const snap = await provider.collect();
    runtimeUptime.set(process.uptime());
    try {
      runtimeEventloopLag.set(Number((process as any).loopLag ?? 0));
    } catch { /* ignore */ }
    try {
      runtimeHandles.set(Number((process as any)._getActiveHandles?.().length ?? 0));
    } catch { /* ignore */ }
    cpuUsage.set(snap.cpu.usagePercent);
    memRss.set(snap.memory.rssBytes);
    memHeap.set({ part: "used" }, snap.memory.heapUsed);
    memHeap.set({ part: "total" }, snap.memory.heapTotal);
    memExternal.set(snap.memory.external);
    gpuAvailable.set(snap.gpu.available ? 1 : 0);
    if (snap.gpu.utilizationPercent !== undefined) gpuUtil.set(snap.gpu.utilizationPercent);
  }

  return {
    sampleOnce,
    kernelExec(language, durationMs, ok) {
      execDuration.observe({ language }, durationMs / 1000);
      execTotal.inc({ language, ok: String(ok) });
    },
    kernelTruncated(language, field) {
      truncatedTotal.inc({ language, field });
    },
    kernelProcesses(language, count) {
      processes.set({ language }, count);
    },
    kernelQueueDepth(language, depth) {
      queueDepth.set({ language }, depth);
    },
    kernelTimeoutKill(language) {
      timeoutKill.inc({ language });
    },
    kernelRestart(language) {
      restart.inc({ language });
    },
    llmCall(providerName, model, durationMs, inputTokens, outputTokens) {
      llmCalls.inc({ provider: providerName, model });
      if (inputTokens > 0) llmTokens.inc({ type: "input" }, inputTokens);
      if (outputTokens > 0) llmTokens.inc({ type: "output" }, outputTokens);
      llmLatency.observe(durationMs / 1000);
    },
    dispose() {
      clearInterval(timer);
      provider.stop();
    },
  };
}
