import { describe, it, expect } from "vitest";
import { createKernelLogger } from "@away_from/pth-kernel-execution";
import type { NetworkExecuteClient } from "@away_from/pth-kernel-execution";
import {
  createIpcNetworkObservability,
  createLoggerNetworkTraceRecorder,
  createTaskNetworkExecuteGatewayFactory,
  type CreateDefaultNetworkExecuteGatewayOptions,
} from "../../src/pth/execution/network/index.js";
import type { NetworkTraceEntryV1 } from "../../src/pth/execution/network/index.js";

function baseEntry(overrides: Partial<NetworkTraceEntryV1> = {}): NetworkTraceEntryV1 {
  return {
    operationId: "op",
    kind: "search",
    profileId: "search-public",
    startedAt: "2026-08-26T00:00:00.000Z",
    durationMs: 1,
    ok: true,
    ...overrides,
  };
}

const fakeClient: NetworkExecuteClient = {
  async search() {
    return {
      schemaVersion: "net.search.response/v1",
      operationId: "op",
      queryDigest: "sha256:q",
      hits: [],
      attempts: [],
      partial: false,
      stopReason: "provider-exhausted",
    };
  },
  async fetch() {
    throw new Error("not used");
  },
  async extract() {
    throw new Error("not used");
  },
  async fetchText() {
    return "";
  },
};

describe("TCE 网络 V1 R2 生产 adapter", () => {
  it("logger trace recorder 只输出 redacted query/URL", () => {
    const lines: string[] = [];
    const logger = createKernelLogger({
      sink: { write: (line) => lines.push(line) },
      env: { ...process.env, PTH_LOG_LEVEL: "info", PTH_LOG_FORMAT: "json" },
    });
    const recorder = createLoggerNetworkTraceRecorder({ logger, component: "network" });
    recorder.record(baseEntry({
      kind: "search",
      queryRedacted: "q=[REDACTED]",
      taskId: "task-1",
      tenantId: "tenant-a",
      roleId: "spider",
    }));
    recorder.record(baseEntry({
      kind: "fetch",
      ok: false,
      errorCode: "NET_TIMEOUT",
      finalUrl: "https://example.com/?token=secret",
    }));
    expect(lines).toHaveLength(2);
    const search = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(search.component).toBe("network");
    expect(search.msg).toBe("network.search ok");
    expect(search.queryRedacted).toBe("q=[REDACTED]");
    expect(search.taskId).toBe("task-1");
    const fetch = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(fetch.msg).toBe("network.fetch failed");
    expect(fetch.errorCode).toBe("NET_TIMEOUT");
    expect(String(fetch.finalUrl)).not.toContain("secret");
    expect(String(fetch.finalUrl)).toContain("[REDACTED]");
  });

  it("IPC observability 发出低基数 metric，不携带原始 query", () => {
    const metrics: Record<string, unknown>[] = [];
    const obs = createIpcNetworkObservability((m) => metrics.push(m));
    obs.record(baseEntry({
      kind: "fetch",
      ok: false,
      errorCode: "NET_TIMEOUT",
      durationMs: 12,
      bytesRead: 10,
      billableUnits: 2,
      taskId: "task-1",
      tenantId: "tenant-a",
      roleId: "spider",
      providerIds: ["raw-hit-html"],
    }));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      kind: "network",
      type: "operation",
      domain: "network",
      operationKind: "fetch",
      ok: false,
      errorCode: "NET_TIMEOUT",
      durationMs: 12,
      bytesRead: 10,
      billableUnits: 2,
      taskId: "task-1",
      tenantId: "tenant-a",
      roleId: "spider",
      providerIds: ["raw-hit-html"],
    });
    expect(JSON.stringify(metrics[0])).not.toContain("query");
  });

  it("生产 factory 装配 traceRecorder/observability/defaultContext（assembly seam）", () => {
    const lines: string[] = [];
    const logger = createKernelLogger({
      sink: { write: (line) => lines.push(line) },
      env: { ...process.env, PTH_LOG_LEVEL: "info", PTH_LOG_FORMAT: "json" },
    });
    const metrics: Record<string, unknown>[] = [];
    let captured: CreateDefaultNetworkExecuteGatewayOptions | undefined;
    const factory = createTaskNetworkExecuteGatewayFactory({
      logger,
      onMetric: (m) => metrics.push(m),
      gatewayFactory: (opts) => {
        captured = opts;
        return fakeClient;
      },
    });
    const client = factory({ taskId: "task-1", tenantId: "tenant-a", roleId: "spider" });
    expect(client).toBe(fakeClient);
    expect(captured?.defaultContext).toEqual({ taskId: "task-1", tenantId: "tenant-a", roleId: "spider" });
    expect(captured?.traceRecorder).toBeTruthy();
    expect(captured?.observability).toBeTruthy();

    captured!.traceRecorder!.record(baseEntry({ queryRedacted: "q=[REDACTED]" }));
    captured!.observability!.record(baseEntry({ kind: "extract", ok: true }));
    expect(lines.some((l) => l.includes("network.search ok"))).toBe(true);
    expect(metrics.some((m) => m.operationKind === "extract" && m.ok === true)).toBe(true);
  });
});
