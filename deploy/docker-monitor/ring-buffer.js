/**
 * 有界时间序列 ring buffer —— 同时受样本数量和保留时长双上限约束。
 *
 * - maxSamples：最多保留多少条（硬内存上限）
 * - maxAgeMs：只保留与最新样本时间差 <= maxAgeMs 的样本
 * - 乱序样本允许入环，读取时按 ts 升序返回
 * - 样本只存引用，range() 返回浅拷贝，避免调用方意外改动内部状态
 */

/**
 * @param {{maxSamples?: number, maxAgeMs?: number}} [options]
 */
export function createTimeSeriesRing({ maxSamples = 1800, maxAgeMs = 3_600_000 } = {}) {
  /** @type {Array<{ts: number}>} */
  let samples = [];

  function prune() {
    if (samples.length === 0) return;
    // 按 ts 升序后，最新样本水位在末尾
    samples.sort((a, b) => a.ts - b.ts);
    const newest = samples[samples.length - 1].ts;
    const cutoff = newest - maxAgeMs;
    if (Number.isFinite(cutoff)) {
      samples = samples.filter((s) => s.ts >= cutoff);
    }
    if (samples.length > maxSamples) {
      samples = samples.slice(samples.length - maxSamples);
    }
  }

  return {
    get size() {
      return samples.length;
    },

    /**
     * @param {{ts: number}} sample
     */
    push(sample) {
      const ts = sample?.ts;
      if (typeof ts !== "number" || !Number.isFinite(ts)) {
        return { accepted: false, reason: "invalid-ts" };
      }
      samples.push(sample);
      prune();
      return { accepted: true, size: samples.length };
    },

    /**
     * 闭区间 [from, to]，按 ts 升序返回样本浅拷贝。
     * @param {number} from
     * @param {number} to
     */
    range(from, to) {
      return samples
        .filter((s) => s.ts >= from && s.ts <= to)
        .sort((a, b) => a.ts - b.ts)
        .map((s) => ({ ...s }));
    },
  };
}
