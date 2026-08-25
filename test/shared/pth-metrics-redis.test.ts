import { describe, it, expect, vi } from "vitest";
import { createMetrics, startRedisMetrics } from "../../src/pth/observability/metrics.js";

describe("pth observability metrics — redis gauges (F/WP1 Task 3)", () => {
  it("createMetrics exposes redis used/max memory gauges", async () => {
    const metrics = createMetrics();
    const output = await metrics.registry.metrics();
    expect(output).toContain("pi_redis_used_memory_bytes");
    expect(output).toContain("pi_redis_max_memory_bytes");
  });

  it("startRedisMetrics collects INFO memory into gauges", async () => {
    const metrics = createMetrics();
    const fakeRedis = {
      info: vi.fn(async (section: string) => {
        expect(section).toBe("memory");
        return "# Memory\r\nused_memory:12345678\r\nmaxmemory:1073741824\r\n";
      }),
    };
    const timer = startRedisMetrics(fakeRedis as any, metrics, 60_000);
    try {
      // first collect() runs immediately but async — wait a tick
      await new Promise((r) => setTimeout(r, 20));
      expect(fakeRedis.info).toHaveBeenCalledWith("memory");
      expect(metrics.redisUsedMemory).toBeDefined();
      const output = await metrics.registry.metrics();
      expect(output).toMatch(/pi_redis_used_memory_bytes 12345678/);
      expect(output).toMatch(/pi_redis_max_memory_bytes 1073741824/);
    } finally {
      clearInterval(timer as any);
    }
  });

  it("startRedisMetrics tolerates redis failure without throwing", async () => {
    const metrics = createMetrics();
    const fakeRedis = { info: vi.fn(async () => { throw new Error("redis down"); }) };
    const timer = startRedisMetrics(fakeRedis as any, metrics, 60_000);
    try {
      await new Promise((r) => setTimeout(r, 20));
      // gauges retain default 0; no crash
      const output = await metrics.registry.metrics();
      expect(output).toContain("pi_redis_used_memory_bytes");
    } finally {
      clearInterval(timer as any);
    }
  });
});
