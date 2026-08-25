/**
 * execution/network/trace.ts — 结构化 trace recorder（V1 最小实现）。
 */

import type { NetworkTraceEntryV1, NetworkTraceRecorder } from "./types.js";

export class InMemoryNetworkTraceRecorder implements NetworkTraceRecorder {
  readonly entries: NetworkTraceEntryV1[] = [];

  record(entry: NetworkTraceEntryV1): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }

  byOperationId(operationId: string): NetworkTraceEntryV1 | undefined {
    return this.entries.find((e) => e.operationId === operationId);
  }
}

export function createNoopNetworkTraceRecorder(): NetworkTraceRecorder {
  return { record: () => {} };
}
