/**
 * execution/network/errors.ts — Execute 层结构化错误。
 */

import type { NetworkErrorCodeV1, NetworkErrorV1, ProviderAttemptV1 } from "@away_from/pth-contracts";

export class NetworkExecuteError extends Error {
  readonly networkError: NetworkErrorV1;
  constructor(networkError: NetworkErrorV1) {
    super(networkError.message);
    this.name = "NetworkExecuteError";
    this.networkError = networkError;
  }
}

export function createNetworkExecuteError(
  code: NetworkErrorCodeV1,
  message: string,
  detail: { operationId?: string; attempt?: ProviderAttemptV1 } = {},
): NetworkExecuteError {
  return new NetworkExecuteError({
    code,
    message,
    ...(detail.operationId ? { operationId: detail.operationId } : {}),
    ...(detail.attempt ? { attempt: detail.attempt } : {}),
  });
}
