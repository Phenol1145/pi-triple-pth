/**
 * execution/network/budget.ts — Execute 层 Budget（task-scoped 简单计数）。
 *
 * V1 不做全局配额；Budget 实例按 gateway（通常 per task）创建，防止单任务
 * 无限消耗 provider/带宽/输出。
 */

export interface NetworkBudgetLimits {
  readonly maxSearchHits: number;
  readonly maxFetchBytes: number;
  readonly maxExtractOutputChars: number;
}

export interface NetworkBudget {
  readonly limits: NetworkBudgetLimits;
  tryConsumeSearchHits(count: number): boolean;
  tryConsumeFetchBytes(count: number): boolean;
  tryConsumeExtractOutputChars(count: number): boolean;
}

export class DefaultNetworkBudget implements NetworkBudget {
  readonly limits: NetworkBudgetLimits;
  private remainingSearchHits: number;
  private remainingFetchBytes: number;
  private remainingExtractOutputChars: number;

  constructor(limits?: Partial<NetworkBudgetLimits>) {
    this.limits = {
      maxSearchHits: limits?.maxSearchHits ?? 200,
      maxFetchBytes: limits?.maxFetchBytes ?? 8 * 1024 * 1024,
      maxExtractOutputChars: limits?.maxExtractOutputChars ?? 200_000,
    };
    this.remainingSearchHits = this.limits.maxSearchHits;
    this.remainingFetchBytes = this.limits.maxFetchBytes;
    this.remainingExtractOutputChars = this.limits.maxExtractOutputChars;
  }

  tryConsumeSearchHits(count: number): boolean {
    if (count < 0 || count > this.remainingSearchHits) return false;
    this.remainingSearchHits -= count;
    return true;
  }

  tryConsumeFetchBytes(count: number): boolean {
    if (count < 0 || count > this.remainingFetchBytes) return false;
    this.remainingFetchBytes -= count;
    return true;
  }

  tryConsumeExtractOutputChars(count: number): boolean {
    if (count < 0 || count > this.remainingExtractOutputChars) return false;
    this.remainingExtractOutputChars -= count;
    return true;
  }
}
