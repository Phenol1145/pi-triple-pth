/**
 * execution/knowledge-intake/production-defaults.ts —— N26 生产默认阈值。
 *
 * v1 常量集中声明，后续接配置中心；默认 fail-closed。
 */

export const INTAKE_PRODUCTION_DEFAULTS = {
  maxConcurrentFetches: 4,
  fetchTimeoutMs: 30_000,
  maxBytesPerSource: 1_048_576,
  dedupeWindowMs: 24 * 60 * 60 * 1000,
  verificationStrength: "strong" as const,
  promoteThresholdSuccesses: 3,
};
