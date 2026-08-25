import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { createKernelManager, createWorkerKernelWithManager } from "../../src/pth/impls/kernels/kernel-manager.js";
import { buildTaskCapabilityInject } from "../../src/pth/runner/exec-modes/task-capability-inject.js";
import type { NetworkExecuteClient } from "@away_from/pth-kernel-execution";

const artifactRef = {
  artifactId: "artifact-001",
  storageKind: "task-artifact",
  immutableLocator: "task://op-1/artifact-001",
  sha256: "abc",
  byteLength: 4,
  mediaType: "text/plain",
  retentionClass: "task",
} as const;

function fakeNetworkClient(): NetworkExecuteClient {
  return {
    async search() {
      return {
        schemaVersion: "net.search.response/v1",
        operationId: "op-search",
        queryDigest: "sha256:q",
        hits: [{ rank: 1, title: "Example", url: "https://example.com", discovery: { providerId: "fake", providerVersion: "1", retrievedAt: "2026-08-26T00:00:00.000Z" }, publisher: { origin: "example.com" }, trust: "public-untrusted" }],
        attempts: [],
        partial: false,
        stopReason: "limit",
      };
    },
    async fetch() {
      return {
        schemaVersion: "net.fetch.response/v1",
        operationId: "op-fetch",
        requestedUrl: "https://example.com",
        finalUrl: "https://example.com/",
        redirectChain: [],
        retrievedAt: "2026-08-26T00:00:00.000Z",
        status: 200,
        headers: { contentType: "text/html" },
        artifact: { ref: artifactRef },
        transport: { policyVersion: "v1", bytesRead: 4, truncated: false },
      };
    },
    async extract() {
      return {
        schemaVersion: "net.document/v1",
        sourceArtifact: artifactRef,
        text: "hello",
        processingChain: [{ processorId: "offline", processorVersion: "1", implementationLanguage: "ts", inputHash: "abc", outputHash: "def" }],
        warnings: [],
        trust: "processed-untrusted",
      };
    },
  };
}

describe("TCE W1 网络能力注入", () => {
  let manager: ReturnType<typeof createKernelManager>;
  let kernel: ReturnType<typeof createWorkerKernelWithManager>;

  beforeAll(async () => {
    manager = createKernelManager({ pythonMode: "kernel", bashMode: "kernel", kernelConfig: { lazySpawn: true, idleMs: 0, resetMode: "ns" } });
    kernel = createWorkerKernelWithManager({
      llm: null as any,
      dataWorld: {
        memory: { retrieve: async () => [], write: async () => {} },
        tasks: { candidates: async () => [], submit: async () => {} },
        queryReadOnly: async () => [],
      } as any,
      manager,
      toolstore: null as any,
    });
  });

  afterAll(() => {
    manager.dispose();
  });

  it("声明 net.* 且注入 fake Execute client 时，ts 程序可调用并拿到 typed 结果", async () => {
    kernel.ts.reset();
    const capabilityInject = buildTaskCapabilityInject({
      kernel,
      roleCapabilities: ["net.search", "net.fetch", "net.extract"],
      networkExecute: fakeNetworkClient(),
    });
    const r = await runPtcProgram({
      code: `const s = await net.search({ schemaVersion: "net.search.request/v1", query: "q" }); const f = await net.fetch({ schemaVersion: "net.fetch.request/v1", url: "https://example.com" }); const d = await net.extract({ schemaVersion: "net.extract.request/v1", artifactRef: f.artifact.ref, mode: "main-content" }); return { hits: s.hits.length, text: d.text };`,
      cwd: "/tmp/tce-w1-network",
      ts: kernel.ts,
      caps: capabilityInject,
    });
    expect(r.raw.ok).toBe(true);
    expect((r.raw.value as any).hits).toBe(1);
    expect((r.raw.value as any).text).toBe("hello");
  });

  it("未声明 net.* 时 net 根不注入——surface 预检拒绝", async () => {
    kernel.ts.reset();
    const capabilityInject = buildTaskCapabilityInject({
      kernel,
      roleCapabilities: ["memory"],
    });
    const r = await runPtcProgram({
      code: `await net.search({ query: "q" });`,
      cwd: "/tmp/tce-w1-network-none",
      ts: kernel.ts,
      caps: capabilityInject,
    });
    expect(r.raw.ok).toBe(false);
    expect(r.raw.error?.code).toBe("capability-out-of-bounds");
  });

  it("声明 net.* 但未注入 NetworkExecuteClient 时装配失败（fail-closed）", () => {
    expect(() =>
      buildTaskCapabilityInject({
        kernel,
        roleCapabilities: ["net.search"],
      }),
    ).toThrow(/NetworkExecuteClient/);
  });
});
