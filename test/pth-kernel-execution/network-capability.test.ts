import { describe, it, expect } from "vitest";
import { createNetworkCapability, type NetworkExecuteClient } from "@away_from/pth-kernel-execution";
import {
  buildDeploymentCapabilityCatalogSnapshotV1,
  NETWORK_CAPABILITY_IMPLEMENTATIONS,
  NETWORK_EXECUTE_SERVICES,
} from "@away_from/pth-contracts";

const artifactRef = {
  artifactId: "artifact-001",
  storageKind: "task-artifact",
  immutableLocator: "task://op-1/artifact-001",
  sha256: "abc",
  byteLength: 4,
  mediaType: "text/plain",
  retentionClass: "task",
} as const;

function fakeClient(calls: { kind: string; args: unknown }[]): NetworkExecuteClient {
  return {
    async search(request) {
      calls.push({ kind: "search", args: request });
      return {
        schemaVersion: "net.search.response/v1",
        operationId: "op-search",
        queryDigest: "sha256:q",
        hits: [],
        attempts: [],
        partial: false,
        stopReason: "limit",
      };
    },
    async fetch(request) {
      calls.push({ kind: "fetch", args: request });
      return {
        schemaVersion: "net.fetch.response/v1",
        operationId: "op-fetch",
        requestedUrl: request.url,
        finalUrl: request.url,
        redirectChain: [],
        retrievedAt: "2026-08-26T00:00:00.000Z",
        status: 200,
        headers: { contentType: "text/plain" },
        artifact: { ref: artifactRef },
        transport: { policyVersion: "v1", bytesRead: 4, truncated: false },
      };
    },
    async extract(request) {
      calls.push({ kind: "extract", args: request });
      return {
        schemaVersion: "net.document/v1",
        sourceArtifact: request.artifactRef,
        text: "hello",
        processingChain: [{ processorId: "offline", processorVersion: "1", implementationLanguage: "ts", inputHash: "abc", outputHash: "def" }],
        warnings: [],
        trust: "processed-untrusted",
      };
    },
  };
}

describe("TCE 网络 V1 typed proxy", () => {
  it("search/fetch/extract 全部委托 NetworkExecuteClient（Code 层无副作用）", async () => {
    const calls: { kind: string; args: unknown }[] = [];
    const net = createNetworkCapability({ client: fakeClient(calls) });

    const search = await net.search({ schemaVersion: "net.search.request/v1", query: "rust" });
    const fetch = await net.fetch({ schemaVersion: "net.fetch.request/v1", url: "https://example.com" });
    const extract = await net.extract({ schemaVersion: "net.extract.request/v1", artifactRef, mode: "main-content" });

    expect(calls.map((c) => c.kind)).toEqual(["search", "fetch", "extract"]);
    expect(search.schemaVersion).toBe("net.search.response/v1");
    expect(fetch.artifact.ref.sha256).toBe("abc");
    expect(extract.trust).toBe("processed-untrusted");
  });

  it("catalog 静态目录：net.* 均有 typed-proxy binding 与 Execute service", () => {
    const snapshot = buildDeploymentCapabilityCatalogSnapshotV1("test-1");
    expect(snapshot.capabilities.map((c) => c.id)).toEqual(["net.search", "net.fetch", "net.extract"]);
    expect(snapshot.bindings.every((b) => b.invocation === "typed-proxy")).toBe(true);
    expect(NETWORK_CAPABILITY_IMPLEMENTATIONS.map((i) => i.capabilityId)).toEqual(["net.search", "net.fetch", "net.extract"]);
    expect(NETWORK_EXECUTE_SERVICES.map((s) => s.id)).toEqual(["network-broker", "extractor"]);
    for (const impl of NETWORK_CAPABILITY_IMPLEMENTATIONS) {
      expect(impl.executeBinding.kind).toBe("execute-service");
    }
  });
});
