/**
 * perf-params.ts —— 兼容 re-export（配置集中化 C1，2026-08-16）。
 *
 * 配置中心实现已迁至 src/pth/config/（typed schema + 密钥打码快照）。
 * 本文件保留旧 import 面：config / configNumber / resetConfig / ConfigCenter。
 */

export { config, resetConfig, configNumber } from "@away_from/pth-config";
export type { ConfigCenter } from "@away_from/pth-config";
