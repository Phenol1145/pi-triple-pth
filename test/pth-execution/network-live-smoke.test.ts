import { describe, it, expect } from "vitest";
import { createDefaultNetworkExecuteGateway } from "../../src/pth/execution/network/index.js";

/**
 * TCE 网络 V1 反馈 P1-2：opt-in 真实 provider 冒烟。
 *
 * 默认不进入 CI；需要真实网络时显式运行：
 *   PTH_NETWORK_LIVE_TEST=1 npm test -- test/pth-execution/network-live-smoke.test.ts
 */
const live = process.env.PTH_NETWORK_LIVE_TEST === "1";

describe.skipIf(!live)("network live smoke（opt-in）", () => {
  it("net.search 通过默认 raw-hit provider 返回结构化 hits", async () => {
    const gateway = createDefaultNetworkExecuteGateway();
    const res = await gateway.search({ schemaVersion: "net.search.request/v1", query: "pth type system", limit: 3 });
    expect(res.schemaVersion).toBe("net.search.response/v1");
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]?.trust).toBe("public-untrusted");
  }, 30_000);

  it("net.fetch 抓取 example.com 并保存 artifact", async () => {
    const gateway = createDefaultNetworkExecuteGateway();
    const res = await gateway.fetch({ schemaVersion: "net.fetch.request/v1", url: "https://example.com", maxBytes: 256 * 1024 });
    expect(res.schemaVersion).toBe("net.fetch.response/v1");
    expect(res.status).toBe(200);
    expect(res.artifact.ref.sha256).toHaveLength(64);
  }, 30_000);
});
