import { describe, it, expect } from "vitest";
import {
  DefaultProviderRegistry,
  InMemoryArtifactStore,
  InMemoryNetworkTraceRecorder,
  NetworkExecuteGateway,
  createOfflineHtmlExtractor,
} from "../../src/pth/execution/network/index.js";
import type { SearchProvider } from "../../src/pth/execution/network/index.js";

function fakeProvider(id = "scope"): SearchProvider {
  return {
    providerId: id,
    implementationId: `${id}-impl`,
    version: "1",
    supportedProfiles: ["search-public"],
    capabilities: { rawHits: true, cursor: false },
    async search() {
      return {
        hits: [],
        attempt: { providerId: id, implementationId: `${id}-impl`, startedAt: "2026-08-26T00:00:00.000Z", durationMs: 1, status: "empty", resultCount: 0 },
      };
    },
  };
}

describe("TCE 网络 V1 反馈 P0/P1：task-scoped gateway 与上下文盖章", () => {
  it("defaultContext 中的 taskId/tenantId/roleId 写入每次 operation trace", async () => {
    const trace = new InMemoryNetworkTraceRecorder();
    const registry = new DefaultProviderRegistry();
    registry.register(fakeProvider());
    const gateway = new NetworkExecuteGateway({
      registry,
      artifactStore: new InMemoryArtifactStore(),
      extractor: createOfflineHtmlExtractor(),
      traceRecorder: trace,
      defaultContext: { taskId: "task-1", tenantId: "tenant-a", roleId: "spider" },
      createOperationId: () => "op-scope",
    });
    await gateway.search({ schemaVersion: "net.search.request/v1", query: "pth" });
    const entry = trace.byOperationId("op-scope");
    expect(entry?.kind).toBe("search");
    expect(entry?.taskId).toBe("task-1");
    expect(entry?.tenantId).toBe("tenant-a");
    expect(entry?.roleId).toBe("spider");
  });

  it("不同 gateway 的 ArtifactStore 互相隔离（task scope）", async () => {
    const storeA = new InMemoryArtifactStore();
    const storeB = new InMemoryArtifactStore();
    const gatewayA = new NetworkExecuteGateway({
      artifactStore: storeA,
      extractor: createOfflineHtmlExtractor(),
      fetchTransport: async (url) => ({
        requestedUri: url, finalUri: url, redirectChain: [url], status: 200,
        headers: { "content-type": "text/html" }, rawBytes: new TextEncoder().encode("<p>a</p>"), byteLength: 10, hops: [],
      }),
      createOperationId: () => "op-fetch-a",
    });
    const gatewayB = new NetworkExecuteGateway({
      artifactStore: storeB,
      extractor: createOfflineHtmlExtractor(),
      createOperationId: () => "op-extract-b",
    });
    const fetched = await gatewayA.fetch({ schemaVersion: "net.fetch.request/v1", url: "https://example.com" });
    await expect(
      gatewayB.extract({ schemaVersion: "net.extract.request/v1", artifactRef: fetched.artifact.ref, mode: "main-content" }),
    ).rejects.toMatchObject({ networkError: { code: "NET_ARTIFACT_MISMATCH" } });
  });
});
