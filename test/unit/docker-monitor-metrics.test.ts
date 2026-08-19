import { describe, it, expect } from "vitest";
// 2026-08-14 重组：docker-monitor 归拢 deploy/——引用随迁
import { computeMetrics, buildContainerInterval, parseDockerTime } from "../../deploy/docker-monitor/metrics.js";

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

describe("docker-monitor service interval", () => {
  const container = { Id: "abc123", Names: ["/svc"], Image: "alpine:3.20", State: "running" } as Record<string, unknown>;

  it("parseDockerTime 解析 RFC3339，Docker 零值返回 null", () => {
    expect(parseDockerTime("2026-01-01T00:00:01.000Z")).toBe(1_767_225_601_000);
    expect(parseDockerTime("0001-01-01T00:00:00Z")).toBeNull();
    expect(parseDockerTime(undefined)).toBeNull();
  });

  it("容器区间身份 = Docker ID + startAt，重启 startAt 变化产生新 revision", () => {
    const inspect = {
      Id: "abc123",
      Name: "/svc",
      Created: "2026-01-01T00:00:00.000Z",
      State: { StartedAt: "2026-01-01T00:00:01.000Z", FinishedAt: "0001-01-01T00:00:00Z", Running: true, ExitCode: 0 },
      Config: { Image: "alpine:3.20" },
    } as Record<string, unknown>;

    const iv = buildContainerInterval(container, inspect, { now: 999, expectedIntervalMs: 2000 });
    expect(iv.id).toBe("service:abc123:1767225601000");
    expect(iv.kind).toBe("service");
    expect(iv.label).toBe("svc");
    expect(iv.status).toBe("running");
    expect(iv.startAt).toBe(1_767_225_601_000);
    expect(iv.endAt).toBeNull();

    const restarted = {
      ...inspect,
      State: { StartedAt: "2026-01-01T00:00:05.000Z", FinishedAt: "0001-01-01T00:00:00Z", Running: true, ExitCode: 0 },
    } as Record<string, unknown>;
    const iv2 = buildContainerInterval(container, restarted, { now: 999, expectedIntervalMs: 2000 });
    expect(iv2.id).toBe("service:abc123:1767225605000");
    expect(iv2.id).not.toBe(iv.id);
    expect(iv2.sourceVersion).not.toBe(iv.sourceVersion);
  });

  it("未启动容器用 Created 作 startAt，已退出 endAt=FinishedAt", () => {
    const stopped = {
      Id: "abc123",
      Name: "/svc",
      Created: "2026-01-01T00:00:00.000Z",
      State: { StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "2026-01-01T00:00:05.000Z", Running: false, ExitCode: 0 },
      Config: { Image: "alpine:3.20" },
    } as Record<string, unknown>;

    const iv = buildContainerInterval({ Id: "abc123" } as Record<string, unknown>, stopped, { now: 999, expectedIntervalMs: 2000 });
    expect(iv.startAt).toBe(1_767_225_600_000);
    expect(iv.endAt).toBe(1_767_225_605_000);
    expect(iv.status).toBe("completed");
  });
});
