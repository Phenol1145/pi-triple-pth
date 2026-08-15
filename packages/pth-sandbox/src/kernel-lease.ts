/**
 * kernel-lease.ts —— sandbox kernel 租约协议（P0-4）
 *
 * 租约是 controller 发放的一次性 capability：
 *  - id 为 cryptographically secure UUID，不可预测；
 *  - generation 单调递增，防止 release 后旧租约复用；
 *  - expiresAt 由 controller 计算（entry TTL），过期即失效。
 * 原始 internalId 永不出 HTTP；外部只持有 SandboxLease。
 */

export interface SandboxLease {
  readonly id: string;
  readonly generation: number;
  readonly expiresAt: string;
}

export type LeaseState = "idle" | "active" | "cancelling" | "disposed";
