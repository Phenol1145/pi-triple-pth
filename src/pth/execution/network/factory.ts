/**
 * execution/network/factory.ts — Wave 2 默认装配工厂。
 *
 * 供测试与后续 production wiring 使用；artifact store 是内存 task-scoped 实现，
 * 需要跨任务隔离时由调用方按任务创建新 gateway。
 */

import { InMemoryArtifactStore } from "./artifact-store.js";
import { DefaultNetworkBudget } from "./budget.js";
import { createOfflineHtmlExtractor } from "./extractors/offline-html.js";
import { NetworkExecuteGateway, type NetworkExecuteGatewayDeps } from "./gateway.js";
import { DefaultOperationPolicy } from "./operation-policy.js";
import { DefaultProviderRegistry } from "./provider-registry.js";
import { createRawHitHtmlProvider } from "./providers/raw-hit-html.js";

export interface CreateDefaultNetworkExecuteGatewayOptions {
  readonly defaultContext?: NetworkExecuteGatewayDeps["defaultContext"];
  readonly policy?: NetworkExecuteGatewayDeps["policy"];
  readonly budget?: NetworkExecuteGatewayDeps["budget"];
  readonly artifactStore?: NetworkExecuteGatewayDeps["artifactStore"];
  readonly fetchTransport?: NetworkExecuteGatewayDeps["fetchTransport"];
  readonly traceRecorder?: NetworkExecuteGatewayDeps["traceRecorder"];
}

export function createDefaultNetworkExecuteGateway(opts: CreateDefaultNetworkExecuteGatewayOptions = {}): NetworkExecuteGateway {
  const registry = new DefaultProviderRegistry();
  registry.register(createRawHitHtmlProvider());
  return new NetworkExecuteGateway({
    registry,
    policy: opts.policy ?? new DefaultOperationPolicy(),
    budget: opts.budget ?? new DefaultNetworkBudget(),
    artifactStore: opts.artifactStore ?? new InMemoryArtifactStore(),
    extractor: createOfflineHtmlExtractor(),
    ...(opts.fetchTransport ? { fetchTransport: opts.fetchTransport } : {}),
    ...(opts.traceRecorder ? { traceRecorder: opts.traceRecorder } : {}),
    ...(opts.defaultContext ? { defaultContext: opts.defaultContext } : {}),
  });
}
