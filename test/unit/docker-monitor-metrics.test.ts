import { describe, it, expect } from "vitest";
// 2026-08-14 重组：docker-monitor 归拢 deploy/——引用随迁
import { computeMetrics } from "../../deploy/docker-monitor/metrics.js";

function sampleFrame(total: number, system: number, onlineCpus = 4, memUsage = 1_000_000_000, memLimit = 4_000_000_000, netRx = 1000, netTx = 500) {
  return {
    cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: onlineCpus },
    memory_stats: { usage: memUsage, limit: memLimit },
    networks: { eth0: { rx_bytes: netRx, tx_bytes: netTx }, eth1: { rx_bytes: 0, tx_bytes: 0 } },
  } as Record<string, unknown>;
}

describe("docker-monitor computeMetrics", () => {
  it("两帧差算 CPU%：Δtotal/Δsystem × onlineCpus", () => {
    const prev = sampleFrame(1000, 10_000, 4);
    const cur = sampleFrame(2000, 20_000, 4); // Δtotal=1000, Δsystem=10000 → 0.1 × 4 × 100 = 40%
    const m = computeMetrics(cur, "c1", prev);
    expect(m.cpuPct).toBeCloseTo(40, 5);
  });

  it("单帧（无 prev）cpuPct=null——下一帧才能算", () => {
    const m = computeMetrics(sampleFrame(1000, 10_000), "c1");
    expect(m.cpuPct).toBeNull();
  });

  it("多网卡网络求和", () => {
    const m = computeMetrics(sampleFrame(1000, 10_000, 4, 1e9, 4e9, 1000, 500), "c1");
    expect(m.netRx).toBe(1000);
    expect(m.netTx).toBe(500);
  });

  it("内存占比与绝对值", () => {
    const m = computeMetrics(sampleFrame(1000, 10_000, 4, 1_000_000_000, 4_000_000_000), "c1");
    expect(m.memUsage).toBe(1_000_000_000);
    expect(m.memLimit).toBe(4_000_000_000);
    expect(m.memPct).toBeCloseTo(25, 5);
  });

  it("memLimit=0 时 memPct=null（不除零）", () => {
    const m = computeMetrics({ memory_stats: { usage: 100, limit: 0 } } as Record<string, unknown>, "c1");
    expect(m.memPct).toBeNull();
    expect(m.memUsage).toBe(100);
  });

  it("ds<=0 或 dt<0 时 cpuPct=null（时钟倒退/无变化保护）", () => {
    const prev = sampleFrame(2000, 20_000);
    const cur = sampleFrame(1000, 20_000); // dt<0
    expect(computeMetrics(cur, "c1", prev).cpuPct).toBeNull();
    const cur2 = sampleFrame(2000, 20_000); // ds=0
    expect(computeMetrics(cur2, "c1", prev).cpuPct).toBeNull();
  });

  it("stats 字段缺失容错（不抛异常）", () => {
    const m = computeMetrics({} as Record<string, unknown>, "c1");
    expect(m.cpuPct).toBeNull();
    expect(m.memUsage).toBe(0);
    expect(m.netRx).toBe(0);
  });
});
