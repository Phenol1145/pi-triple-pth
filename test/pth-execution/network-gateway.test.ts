import { describe, it, expect } from "vitest";
import {
  InMemoryArtifactStore,
  InMemoryNetworkTraceRecorder,
  NetworkExecuteGateway,
  createRawHitHtmlProvider,
  createOfflineHtmlExtractor,
  DefaultProviderRegistry,
  DefaultOperationPolicy,
} from "../../src/pth/execution/network/index.js";
import type {
  ArtifactRefV1,
  FetchRequestV1,
  NetworkOperationContextV1,
  SearchRequestV1,
} from "@away_from/pth-contracts";
import type { ProviderSearchOutcome, SearchProvider } from "../../src/pth/execution/network/index.js";

const artifactRef: ArtifactRefV1 = {
  artifactId: "artifact-test",
  storageKind: "task-artifact",
  immutableLocator: "task-artifact://artifact-test",
  sha256: "abc",
  byteLength: 3,
  mediaType: "text/plain",
  retentionClass: "task",
};

function makeSearchRequest(query = "pth"): SearchRequestV1 {
  return { schemaVersion: "net.search.request/v1", query };
}

function makeFetchRequest(url = "https://example.com"): FetchRequestV1 {
  return { schemaVersion: "net.fetch.request/v1", url };
}

function makeContext(): NetworkOperationContextV1 {
  return {
    operationId: "op-test",
    profileId: "search-public",
    taskId: "task-1",
    roleId: "researcher",
    tenantId: "tenant-a",
  };
}

function fakeProvider(id: string, hits: ProviderSearchOutcome["hits"] = []): SearchProvider {
  return {
    providerId: id,
    implementationId: `${id}-impl`,
    version: "1.0.0",
    supportedProfiles: ["search-public"],
    capabilities: { rawHits: true, cursor: false },
    async search(_request, ctx) {
      return {
        hits,
        attempt: {
          providerId: id,
          implementationId: `${id}-impl`,
          startedAt: new Date().toISOString(),
          durationMs: 1,
          status: hits.length > 0 ? "ok" : "empty",
          resultCount: hits.length,
        },
      };
    },
  };
}

describe("NetworkExecuteGateway Wave 2", () => {
  it("search 使用 raw-hit provider 返回结构化 response", async () => {
    const registry = new DefaultProviderRegistry();
    registry.register(fakeProvider("raw", [
      { rank: 1, title: "Example", url: "https://example.com", discovery: { providerId: "raw", providerVersion: "1", retrievedAt: "2026-08-26T00:00:00.000Z" }, publisher: { origin: "example.com" }, trust: "public-untrusted" },
    ]));
    const gateway = new NetworkExecuteGateway({
      registry,
      artifactStore: new InMemoryArtifactStore(),
      extractor: createOfflineHtmlExtractor(),
      traceRecorder: new InMemoryNetworkTraceRecorder(),
      defaultContext: { taskId: "task-1", roleId: "researcher", tenantId: "tenant-a" },
      createOperationId: () => "op-search-1",
    });
    const res = await gateway.search({ ...makeSearchRequest(), limit: 1 });
    expect(res.schemaVersion).toBe("net.search.response/v1");
    expect(res.operationId).toBe("op-search-1");
    expect(res.hits).toHaveLength(1);
    expect(res.attempts[0]?.status).toBe("ok");
    expect(res.stopReason).toBe("limit");
  });

  it("search 在 provider 失败时记录 attempts 并回退到下一个 provider", async () => {
    const failing: SearchProvider = {
      providerId: "bad",
      implementationId: "bad-impl",
      version: "1",
      supportedProfiles: ["search-public"],
      capabilities: { rawHits: true, cursor: false },
      async search() {
        throw new Error("boom");
      },
    };
    const registry = new DefaultProviderRegistry();
    registry.register(failing);
    registry.register(fakeProvider("good", [
      { rank: 1, title: "Good", url: "https://good.example", discovery: { providerId: "good", providerVersion: "1", retrievedAt: "2026-08-26T00:00:00.000Z" }, publisher: { origin: "good.example" }, trust: "public-untrusted" },
    ]));
    const gateway = new NetworkExecuteGateway({
      registry,
      artifactStore: new InMemoryArtifactStore(),
      extractor: createOfflineHtmlExtractor(),
      createOperationId: () => "op-search-2",
    });
    const res = await gateway.search(makeSearchRequest());
    expect(res.hits).toHaveLength(1);
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0]?.status).toBe("failed");
    expect(res.attempts[1]?.status).toBe("ok");
  });

  it("fetch 通过注入 transport 保存 artifact 并返回引用", async () => {
    const bytes = new TextEncoder().encode("<html><body>hello</body></html>");
    const gateway = new NetworkExecuteGateway({
      artifactStore: new InMemoryArtifactStore(),
      extractor: createOfflineHtmlExtractor(),
      fetchTransport: async (url, opts) => ({
        requestedUri: url,
        finalUri: url,
        redirectChain: [url],
        status: 200,
        headers: { "content-type": "text/html" },
        rawBytes: bytes,
        byteLength: bytes.byteLength,
        hops: [],
      }),
      createOperationId: () => "op-fetch-1",
    });
    const res = await gateway.fetch(makeFetchRequest());
    expect(res.schemaVersion).toBe("net.fetch.response/v1");
    expect(res.artifact.ref.storageKind).toBe("task-artifact");
    expect(res.artifact.ref.byteLength).toBe(bytes.byteLength);
    expect(res.artifact.ref.sha256).toHaveLength(64);
    expect(res.transport.truncated).toBe(false);
  });

  it("fetch 拒绝非 https URL（public profile 默认 HTTPS-only）", async () => {
    const gateway = new NetworkExecuteGateway({
      artifactStore: new InMemoryArtifactStore(),
      extractor: createOfflineHtmlExtractor(),
      policy: new DefaultOperationPolicy(),
      createOperationId: () => "op-fetch-policy",
    });
    await expect(gateway.fetch(makeFetchRequest("http://example.com"))).rejects.toMatchObject({
      networkError: { code: "NET_POLICY_DENIED" },
    });
  });

  it("extract 对同一 artifact 产生确定性 output hash", async () => {
    const store = new InMemoryArtifactStore();
    const html = "<html><head><title>T</title></head><body><p>hello world</p></body></html>";
    const ref = await store.put({ bytes: new TextEncoder().encode(html), mediaType: "text/html" });
    const extractor = createOfflineHtmlExtractor();
    const gateway = new NetworkExecuteGateway({
      artifactStore: store,
      extractor,
      createOperationId: () => "op-extract-1",
    });
    const req = { schemaVersion: "net.extract.request/v1" as const, artifactRef: ref, mode: "main-content" as const };
    const doc1 = await gateway.extract(req);
    const doc2 = await gateway.extract(req);
    expect(doc1.text).toContain("hello world");
    expect(doc1.processingChain[0]?.outputHash).toBe(doc2.processingChain[0]?.outputHash);
    expect(doc1.processingChain[0]?.inputHash).toBe(ref.sha256);
  });

  it("trace recorder 记录 search/fetch/extract operation", async () => {
    const trace = new InMemoryNetworkTraceRecorder();
    const store = new InMemoryArtifactStore();
    const ref = await store.put({ bytes: new TextEncoder().encode("<p>x</p>"), mediaType: "text/html" });
    const registry = new DefaultProviderRegistry();
    registry.register(fakeProvider("raw", []));
    const gateway = new NetworkExecuteGateway({
      registry,
      artifactStore: store,
      extractor: createOfflineHtmlExtractor(),
      traceRecorder: trace,
      fetchTransport: async (url) => ({ requestedUri: url, finalUri: url, redirectChain: [url], status: 200, headers: {}, rawBytes: new Uint8Array([1]), byteLength: 1, hops: [] }),
      createOperationId: () => "op-trace",
    });
    await gateway.search(makeSearchRequest());
    await gateway.fetch(makeFetchRequest());
    await gateway.extract({ schemaVersion: "net.extract.request/v1", artifactRef: ref, mode: "main-content" });
    expect(trace.entries.map((e) => e.kind).sort()).toEqual(["extract", "fetch", "search"]);
  });
});

describe("RawHitHtmlProvider", () => {
  it("解析 raw HTML 为 SearchHitV1", async () => {
    const html = `
      <html><body>
        <div class="result">
          <a class="result__a" href="https://example.com/page">Example Page</a>
          <a class="result__snippet" href="https://example.com/page">snippet text</a>
        </div>
      </body></html>
    `;
    const provider = createRawHitHtmlProvider({
      fetchHtml: async () => html,
      providerId: "fixture",
    });
    const outcome = await provider.search(makeSearchRequest(), makeContext());
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0]?.title).toBe("Example Page");
    expect(outcome.hits[0]?.url).toBe("https://example.com/page");
    expect(outcome.hits[0]?.snippet).toBe("snippet text");
    expect(outcome.hits[0]?.discovery.providerId).toBe("fixture");
    expect(outcome.attempt.status).toBe("ok");
  });

  it("provider 不可用时抛出可判别错误", async () => {
    const provider = createRawHitHtmlProvider({
      fetchHtml: async () => {
        throw new Error("network down");
      },
      providerId: "fixture",
    });
    await expect(provider.search(makeSearchRequest(), makeContext())).rejects.toMatchObject({
      code: "NET_PROVIDER_UNAVAILABLE",
    });
  });
});

describe("InMemoryArtifactStore", () => {
  it("hash/length 不一致时拒绝读取", async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put({ bytes: new TextEncoder().encode("abc"), mediaType: "text/plain" });
    const badRef = { ...ref, sha256: "deadbeef" };
    await expect(store.get(badRef)).rejects.toMatchObject({
      networkError: { code: "NET_ARTIFACT_MISMATCH" },
    });
  });
});
