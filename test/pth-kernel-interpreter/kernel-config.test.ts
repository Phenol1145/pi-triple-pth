import { describe, it, expect } from "vitest";
import { loadKernelConfig } from "../../src/pth/kernel/interpreter/kernel-config.js";

describe("kernel config（参数化，仿 PG 可调）", () => {
  it("默认值：懒 spawn 开 / 空闲回收 5min / reset 模式 ns", () => {
    const c = loadKernelConfig({});
    expect(c.lazySpawn).toBe(true);
    expect(c.idleMs).toBe(300_000);
    expect(c.resetMode).toBe("ns");
  });

  it("环境变量可调", () => {
    const c = loadKernelConfig({
      PTH_KERNEL_LAZY_SPAWN: "0",
      PTH_KERNEL_IDLE_MS: "0",
      PTH_KERNEL_RESET_MODE: "restart",
    } as NodeJS.ProcessEnv);
    expect(c.lazySpawn).toBe(false);
    expect(c.idleMs).toBe(0);
    expect(c.resetMode).toBe("restart");
  });

  it("非法 idleMs 回落默认（NaN 防御）", () => {
    const c = loadKernelConfig({ PTH_KERNEL_IDLE_MS: "abc" } as NodeJS.ProcessEnv);
    expect(c.idleMs).toBe(300_000);
  });
});
