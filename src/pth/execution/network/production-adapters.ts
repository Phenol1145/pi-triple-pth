/**
 * execution/network/production-adapters.ts — 生产装配用 trace/observability adapter。
 *
 * V1 生产默认不把网络 trace 写入内存对象，而是：
 *  - trace recorder → 现有结构化 logger（query 只保留 redacted 版本）；
 *  - observability → IPC metric（主进程 Prometheus registry 聚合）。
 *
 * artifact 生命周期按第二轮裁决明确为 **lease attempt scope**：同一 task 的
 * retry/pause/requeue 会创建新的 gateway/store，跨 Attempt 的 artifactRef 不能复用。
 */

import type { KernelLogger, NetworkExecuteClient } from "@away_from/pth-kernel-execution";
import { createDefaultNetworkExecuteGateway, type CreateDefaultNetworkExecuteGatewayOptions } from "./factory.js";
import { redactSensitiveQuery } from "./redaction.js";
import type { NetworkTraceEntryV1, NetworkTraceRecorder } from "./types.js";
import type { NetworkOperationMetrics, NetworkObservability } from "./observability.js";

export interface LoggerNetworkTraceRecorderOptions {
  readonly logger: KernelLogger;
  /** 可选：日志组件名；缺省直接使用传入 logger。 */
  readonly component?: string;
}

export function createLoggerNetworkTraceRecorder(opts: LoggerNetworkTraceRecorderOptions): NetworkTraceRecorder {
  const logger = opts.component ? opts.logger.child(opts.component) : opts.logger;
  return {
    record(entry: NetworkTraceEntryV1): void {
      const ctx: Record<string, unknown> = {
        operationId: entry.operationId,
        kind: entry.kind,
        profileId: entry.profileId,
        startedAt: entry.startedAt,
        durationMs: entry.durationMs,
        ok: entry.ok,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
        ...(entry.roleId ? { roleId: entry.roleId } : {}),
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.attempts ? { attempts: entry.attempts } : {}),
        ...(entry.providerIds ? { providerIds: entry.providerIds } : {}),
        ...(entry.publisherOrigins ? { publisherOrigins: entry.publisherOrigins } : {}),
        ...(entry.processorIds ? { processorIds: entry.processorIds } : {}),
        ...(entry.bytesRead !== undefined ? { bytesRead: entry.bytesRead } : {}),
        ...(entry.billableUnits !== undefined ? { billableUnits: entry.billableUnits } : {}),
        ...(entry.artifactId ? { artifactId: entry.artifactId } : {}),
        // 安全约束：只记录 redacted query；绝不把原始 query 写入日志。
        ...(entry.queryRedacted ? { queryRedacted: entry.queryRedacted } : {}),
        ...(entry.finalUrl ? { finalUrl: redactSensitiveQuery(entry.finalUrl) } : {}),
      };
      if (entry.ok) logger.info(`network.${entry.kind} ok`, ctx);
      else logger.warn(`network.${entry.kind} failed`, ctx);
    },
  };
}

export type NetworkMetricSink = (metric: Record<string, unknown>) => void;

/**
 * 将每个 network operation 作为低基数 IPC metric 发出。
 * 主进程 `onMetric` 把 `domain=network` 聚合进 Prometheus。
 */
export function createIpcNetworkObservability(send: NetworkMetricSink): NetworkObservability {
  return {
    record(entry: NetworkTraceEntryV1): void {
      send({
        kind: "network",
        type: "operation",
        domain: "network",
        operationKind: entry.kind,
        taskId: entry.taskId,
        tenantId: entry.tenantId,
        roleId: entry.roleId,
        ok: entry.ok,
        durationMs: entry.durationMs,
        errorCode: entry.errorCode,
        bytesRead: entry.bytesRead,
        billableUnits: entry.billableUnits,
        providerIds: entry.providerIds,
      });
    },
    snapshot(): NetworkOperationMetrics {
      return {
        searchCount: 0, fetchCount: 0, extractCount: 0, fetchTextCount: 0,
        totalDurationMs: 0, totalBytesRead: 0, totalBillableUnits: 0,
        failureCount: 0, failuresByCode: {},
      };
    },
  };
}

export interface TaskNetworkExecuteGatewayFactoryOptions {
  readonly logger?: KernelLogger;
  readonly onMetric?: NetworkMetricSink;
  /** 测试/自定义装配缝；缺省使用 createDefaultNetworkExecuteGateway。 */
  readonly gatewayFactory?: (opts: CreateDefaultNetworkExecuteGatewayOptions) => NetworkExecuteClient;
}

/**
 * 生产 networkExecuteFactory：按 lease Attempt 创建独立 gateway/store，
 * 并接上结构化日志 trace 与 IPC metric observability。
 */
export function createTaskNetworkExecuteGatewayFactory(opts: TaskNetworkExecuteGatewayFactoryOptions = {}) {
  return (ctx: { taskId: string; tenantId: string; roleId: string }) => {
    const logger = opts.logger?.child("network", {
      taskId: ctx.taskId,
      tenantId: ctx.tenantId,
      roleId: ctx.roleId,
    });
    const gatewayOpts: CreateDefaultNetworkExecuteGatewayOptions = {
      defaultContext: ctx,
      ...(logger ? { traceRecorder: createLoggerNetworkTraceRecorder({ logger }) } : {}),
      ...(opts.onMetric ? { observability: createIpcNetworkObservability(opts.onMetric) } : {}),
    };
    return (opts.gatewayFactory ?? createDefaultNetworkExecuteGateway)(gatewayOpts);
  };
}
