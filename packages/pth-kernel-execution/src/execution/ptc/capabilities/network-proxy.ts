/**
 * ptc/capabilities/network-proxy.ts —— TCE 网络 V1：net.* typed proxy。
 *
 * Code 层只持有已授权 typed proxy，不拥有 socket/DNS/provider key。
 * 真实副作用统一发往 NetworkExecuteClient（Execute 网关/服务）。
 * Wave 1 用 fake client 即可完整验证 Tool→Code→typed Execute request。
 */

import type {
  ExtractedDocumentV1,
  ExtractRequestV1,
  FetchRequestV1,
  FetchResponseV1,
  NetworkOperationContextV1,
  SearchRequestV1,
  SearchResponseV1,
} from "@away_from/pth-contracts";

export interface NetworkExecuteClient {
  search(request: SearchRequestV1, context?: NetworkOperationContextV1): Promise<SearchResponseV1>;
  fetch(request: FetchRequestV1, context?: NetworkOperationContextV1): Promise<FetchResponseV1>;
  extract(request: ExtractRequestV1, context?: NetworkOperationContextV1): Promise<ExtractedDocumentV1>;
}

export interface NetworkCapabilityDeps {
  client: NetworkExecuteClient;
}

export interface NetworkCapability {
  search(request: SearchRequestV1, context?: NetworkOperationContextV1): Promise<SearchResponseV1>;
  fetch(request: FetchRequestV1, context?: NetworkOperationContextV1): Promise<FetchResponseV1>;
  extract(request: ExtractRequestV1, context?: NetworkOperationContextV1): Promise<ExtractedDocumentV1>;
}

export function createNetworkCapability(deps: NetworkCapabilityDeps): NetworkCapability {
  return {
    search: (request, context) => deps.client.search(request, context),
    fetch: (request, context) => deps.client.fetch(request, context),
    extract: (request, context) => deps.client.extract(request, context),
  };
}
