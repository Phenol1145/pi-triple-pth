/**
 * execution/network/observability.ts — Execute 层结构化观测（V1 最小计数）。
 *
 * 与 trace recorder 分离：trace 保留逐 operation 明细，observability 聚合可观测
 * 计数（调用次数、字节、耗时、计费单位、失败码分布）。
 */

import type { NetworkTraceEntryV1, NetworkTraceRecorder } from "./types.js";

export interface NetworkOperationMetrics {
  readonly searchCount: number;
  readonly fetchCount: number;
  readonly extractCount: number;
  readonly fetchTextCount: number;
  readonly totalDurationMs: number;
  readonly totalBytesRead: number;
  readonly totalBillableUnits: number;
  readonly failureCount: number;
  readonly failuresByCode: Readonly<Record<string, number>>;
}

export interface NetworkObservability {
  record(entry: NetworkTraceEntryV1): void;
  snapshot(): NetworkOperationMetrics;
}

export class InMemoryNetworkObservability implements NetworkObservability {
  private searchCount = 0;
  private fetchCount = 0;
  private extractCount = 0;
  private fetchTextCount = 0;
  private totalDurationMs = 0;
  private totalBytesRead = 0;
  private totalBillableUnits = 0;
  private failureCount = 0;
  private readonly failuresByCode = new Map<string, number>();

  record(entry: NetworkTraceEntryV1): void {
    switch (entry.kind) {
      case "search": this.searchCount++; break;
      case "fetch": this.fetchCount++; break;
      case "extract": this.extractCount++; break;
      case "fetchText": this.fetchTextCount++; break;
    }
    this.totalDurationMs += entry.durationMs;
    this.totalBytesRead += entry.bytesRead ?? 0;
    this.totalBillableUnits += entry.billableUnits ?? 0;
    if (!entry.ok) {
      this.failureCount++;
      const code = entry.errorCode ?? "UNKNOWN";
      this.failuresByCode.set(code, (this.failuresByCode.get(code) ?? 0) + 1);
    }
  }

  snapshot(): NetworkOperationMetrics {
    return {
      searchCount: this.searchCount,
      fetchCount: this.fetchCount,
      extractCount: this.extractCount,
      fetchTextCount: this.fetchTextCount,
      totalDurationMs: this.totalDurationMs,
      totalBytesRead: this.totalBytesRead,
      totalBillableUnits: this.totalBillableUnits,
      failureCount: this.failureCount,
      failuresByCode: Object.fromEntries(this.failuresByCode),
    };
  }
}

export class NoopNetworkObservability implements NetworkObservability {
  record(_entry: NetworkTraceEntryV1): void {}
  snapshot(): NetworkOperationMetrics {
    return {
      searchCount: 0, fetchCount: 0, extractCount: 0, fetchTextCount: 0,
      totalDurationMs: 0, totalBytesRead: 0, totalBillableUnits: 0,
      failureCount: 0, failuresByCode: {},
    };
  }
}
