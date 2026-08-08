import { describe, it, expect } from "vitest";
import { createKernelMetrics } from "../../src/pth/observability/kernel-metrics";
import { Registry } from "prom-client";

describe("createKernelMetrics", () => {
  it("注册 L0 基础设施指标（runtime/cpu/memory）+ 周期采样", async () => {
    const registry = new Registry();
    const metrics = createKernelMetrics({ registry });
    // 手动采样一次（start 后 provider 周期回调）
    await metrics.sampleOnce();
    const m = await registry.metrics();
    expect(m).toContain("pth_runtime_uptime_seconds");
    expect(m).toContain("pth_cpu_usage_percent");
    expect(m).toContain("pth_memory_rss_bytes");
    expect(m).toContain("pth_memory_heap_bytes");
    expect(m).toContain("pth_memory_external_bytes");
    expect(m).toContain("pth_gpu_available");
    metrics.dispose();
  });

  it("kernel exec 计量：duration/success/truncated 带 language label", async () => {
    const registry = new Registry();
    const metrics = createKernelMetrics({ registry });
    metrics.kernelExec("python", 0.12, true);
    metrics.kernelExec("bash", 0.05, true);
    metrics.kernelExec("python", 0.3, false);
    metrics.kernelTruncated("python", "stdout");
    const m = await registry.metrics();
    expect(m).toContain("pth_kernel_exec_duration_seconds");
    expect(m).toContain('pth_kernel_exec_total{language="python",ok="true"} 1');
    expect(m).toContain('pth_kernel_exec_total{language="bash",ok="true"} 1');
    expect(m).toContain('pth_kernel_exec_total{language="python",ok="false"} 1');
    expect(m).toContain('pth_kernel_truncated_total{language="python",field="stdout"} 1');
  });

  it("kernel 进程/队列/超时/重启计量", async () => {
    const registry = new Registry();
    const metrics = createKernelMetrics({ registry });
    metrics.kernelProcesses("python", 2);
    metrics.kernelQueueDepth("python", 3);
    metrics.kernelTimeoutKill("bash");
    metrics.kernelRestart("python");
    const m = await registry.metrics();
    expect(m).toContain('pth_kernel_processes{language="python"} 2');
    expect(m).toContain('pth_kernel_queue_depth{language="python"} 3');
    expect(m).toContain('pth_kernel_timeout_kill_total{language="bash"} 1');
    expect(m).toContain('pth_kernel_restart_total{language="python"} 1');
  });

  it("llm 计量：tokens/calls/latency", async () => {
    const registry = new Registry();
    const metrics = createKernelMetrics({ registry });
    // 签名：llmCall(provider, model, durationMs, inputTokens, outputTokens)
    metrics.llmCall("deepseek", "deepseek-v4-flash", 120, 500, 800);
    const m = await registry.metrics();
    expect(m).toContain('pth_llm_calls_total{provider="deepseek",model="deepseek-v4-flash"} 1');
    expect(m).toContain('pth_llm_tokens_total{type="input"} 500');
    expect(m).toContain('pth_llm_tokens_total{type="output"} 800');
    expect(m).toContain("pth_llm_latency_seconds");
  });
});
