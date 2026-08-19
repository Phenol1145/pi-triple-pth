import { describe, it, expect } from "vitest";
import { createTimeSeriesRing } from "../../deploy/docker-monitor/ring-buffer.js";

function sample(ts: number) {
  return { ts };
}

describe("docker-monitor createTimeSeriesRing", () => {
  it("容量上限：推 2000 个样本只保留最近 1800 个", () => {
    const ring = createTimeSeriesRing({ maxSamples: 1800, maxAgeMs: 3_600_000 });
    for (let i = 0; i < 2000; i++) ring.push(sample(i * 2000));

    expect(ring.size).toBe(1800);

    const all = ring.range(0, Infinity);
    expect(all).toHaveLength(1800);
    // 最旧的 200 个被挤出：第 200 个（ts=400000）成为窗口起点
    expect(all[0]?.ts).toBe(400_000);
    expect(all.at(-1)?.ts).toBe(1999 * 2000);
  });

  it("range(from, to) 返回闭区间内按时间升序的样本", () => {
    const ring = createTimeSeriesRing({ maxSamples: 10, maxAgeMs: 60_000 });
    for (const ts of [1000, 5000, 2000, 4000, 3000]) ring.push(sample(ts));

    expect(ring.range(2000, 4000).map((s) => s.ts)).toEqual([2000, 3000, 4000]);
    expect(ring.range(0, Infinity)).toHaveLength(5);
  });

  it("超龄淘汰：与最新样本时间差超过 maxAgeMs 的样本被移除", () => {
    const ring = createTimeSeriesRing({ maxSamples: 10, maxAgeMs: 3_600_000 });
    ring.push(sample(0));
    ring.push(sample(1_000_000));
    // 最新时间 3_600_001：ts=0 已超龄，ts=1_000_000 仍在窗口内
    ring.push(sample(3_600_001));

    expect(ring.range(0, Infinity).map((s) => s.ts)).toEqual([1_000_000, 3_600_001]);
  });

  it("乱序插入后按时间升序排列", () => {
    const ring = createTimeSeriesRing({ maxSamples: 10, maxAgeMs: 60_000 });
    for (const ts of [5000, 1000, 4000, 2000, 3000]) ring.push(sample(ts));

    expect(ring.range(0, Infinity).map((s) => s.ts)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });
});
