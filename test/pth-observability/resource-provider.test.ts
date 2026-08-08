import { describe, it, expect } from "vitest";
import { createResourceProvider, type ResourceProvider, type ResourceSnapshot } from "../../src/pth/observability/resource-provider";

describe("ResourceProvider 接口", () => {
  it("createResourceProvider darwin → platform=darwin + collect 返回完整快照", async () => {
    const provider = createResourceProvider({ platform: "darwin" });
    expect(provider.platform).toBe("darwin");
    const snap = await provider.collect();
    expect(snap).toBeDefined();
    expect(typeof snap.cpu.usagePercent).toBe("number");
    expect(typeof snap.memory.rssBytes).toBe("number");
    expect(typeof snap.memory.heapUsed).toBe("number");
    expect(typeof snap.memory.external).toBe("number");
    expect(snap.gpu.available).toBe(false);   // darwin 无 Node GPU API → N/A
    expect(Array.isArray(snap.network)).toBe(true);
  });

  it("GPU 占位：darwin available=false（接口先定义实现按环境）", async () => {
    const provider = createResourceProvider({ platform: "darwin" });
    const snap = await provider.collect();
    expect(snap.gpu.available).toBe(false);
  });

  it("start/stop 周期采样不抛错", async () => {
    const provider = createResourceProvider({ platform: "darwin" });
    provider.start(100);
    await new Promise((r) => setTimeout(r, 250));
    provider.stop();
  });

  it("linux 实现存在（跨 OS 矩阵）", async () => {
    const provider = createResourceProvider({ platform: "linux" });
    expect(provider.platform).toBe("linux");
    const snap = await provider.collect();
    expect(snap.cpu.usagePercent).toBeGreaterThanOrEqual(0);
  });

  it("nvidia 模式 GPU 逻辑（无 nvidia-smi 时 available=false 不抛）", async () => {
    const provider = createResourceProvider({ platform: "linux", nvidia: true });
    const snap = await provider.collect();
    // 无 nvidia-smi 环境 → GPU N/A（不 crash）
    expect(typeof snap.gpu.available).toBe("boolean");
  });
});

describe("ResourceSnapshot 形状", () => {
  it("memory 含 rss/heap/external（已裁决三项）", async () => {
    const provider = createResourceProvider({ platform: "darwin" });
    const snap = await provider.collect();
    expect(snap.memory.rssBytes).toBeGreaterThan(0);
    expect(snap.memory.heapUsed).toBeGreaterThan(0);
    expect(snap.memory.heapTotal).toBeGreaterThan(0);
    expect(snap.memory.external).toBeGreaterThanOrEqual(0);
  });

  it("network 结构（v1 provider 返回空——连接计量由 metrics 层组装）", async () => {
    const provider = createResourceProvider({ platform: "darwin" });
    const snap = await provider.collect();
    expect(Array.isArray(snap.network)).toBe(true);
  });
});
