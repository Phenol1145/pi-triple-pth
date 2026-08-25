import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpBenchDriver } from "../../src/pth/bench/http-driver.js";
import type { BenchScenario } from "../../src/pth/bench/core.js";

describe("PTH Bench HttpBenchDriver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("发布任务并轮询到 completed", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      call++;
      if (call === 1) {
        return { ok: true, json: async () => ({ id: "t1", status: "pending" }) } as Response;
      }
      return {
        ok: true,
        json: async () => [{ id: "t1", status: "completed", payload: { outputRef: { ref: { value: { sum: 5050 }, durationMs: 120 } } } }],
      } as Response;
    }));

    const driver = new HttpBenchDriver({ baseUrl: "http://localhost:3000", token: "tok", pollMs: 1 });
    const scenario: BenchScenario = { id: "s1", title: "求和", graders: [] };
    const rec = await driver.execute(scenario, 0, { repeats: 1, warmup: 0, concurrency: 1, timeoutMs: 1000 });
    expect(rec.status).toBe("completed");
    expect((rec.value as { sum: number }).sum).toBe(5050);
    expect(rec.timing.execMs).toBe(120);
  });
});
