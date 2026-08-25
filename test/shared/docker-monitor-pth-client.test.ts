import { describe, it, expect, vi } from "vitest";
import { createPthClient, nextBackoffMs } from "../../deploy/docker-monitor/pth-client.js";

const ENDPOINT = "http://127.0.0.1:4000";
const TOKEN = "s3cr3t-runtime-observer-token";
const NOW = Date.parse("2026-08-19T00:00:00.000Z");

function snapshot() {
  return {
    intervals: [{ id: "task:tenant-a:t1", sourceVersion: "1" }],
    nextCursor: null,
    window: { from: NOW - 3_600_000, to: NOW },
    scope: { mode: "local-admin", tenantId: "tenant-a" },
    sourceObservedAt: NOW,
    collectedAt: NOW,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("docker-monitor createPthClient", () => {
  it("token/endpoint 仅服务端持有：不挂在返回对象上，序列化也不泄漏", () => {
    const client = createPthClient({ endpoint: ENDPOINT, token: TOKEN, fetchImpl: vi.fn() });

    expect(client).not.toHaveProperty("token");
    expect(client).not.toHaveProperty("endpoint");
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(JSON.stringify(client)).not.toContain("127.0.0.1:4000");
  });

  it("pollOnce 只调 GET /api/v1/observe/timeline，带 Authorization 与 redirect:error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(snapshot()));
    const client = createPthClient({
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl,
      clock: () => NOW,
    });

    const result = await client.pollOnce();

    expect(result).toEqual(snapshot());
    expect(client.getLastSnapshot()).toEqual(snapshot());

    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v1/observe/timeline");
    expect(parsed.searchParams.get("from")).toBe(String(NOW - 3_600_000));
    expect(parsed.searchParams.get("to")).toBe(String(NOW));
    expect(parsed.searchParams.get("limit")).toBe("500");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe("error");
  });

  it("durable snapshot 每 5 秒轮询：start() 立即一次，5000ms 后第二次", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonResponse(snapshot()));
      const client = createPthClient({
        endpoint: ENDPOINT,
        token: TOKEN,
        fetchImpl,
        clock: () => NOW,
      });

      client.start();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("绝不跟随重定向：3xx / redirected 响应一律抛错", async () => {
    const redirecting = vi.fn(async () => new Response("moved", {
      status: 302,
      headers: { location: "https://evil.invalid/timeline" },
    }));
    const client = createPthClient({ endpoint: ENDPOINT, token: TOKEN, fetchImpl: redirecting });

    await expect(client.pollOnce()).rejects.toThrow("redirect not allowed");
    expect(redirecting.mock.calls[0]![1].redirect).toBe("error");
  });

  it("事件流解析 delta，断开后有界退避重连且重连继续使用服务端凭据", async () => {
    const encoder = new TextEncoder();
    const delta = {
      streamEpoch: "epoch-1",
      seq: 1,
      observedAt: NOW,
      type: "interval.upsert",
      payload: { id: "task:tenant-a:t1", sourceVersion: "2" },
    };
    let streamCalls = 0;
    const fetchImpl = vi.fn(async () => {
      streamCalls += 1;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: interval.upsert\ndata: ${JSON.stringify(delta)}\n\n`,
          ));
          setTimeout(() => controller.close(), 5);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const onDelta = vi.fn();
    const client = createPthClient({
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl,
      onDelta,
      backoffBaseMs: 10,
      backoffMaxMs: 50,
      clock: () => NOW,
    });

    const connecting = client.connectEvents();

    await vi.waitFor(() => expect(onDelta).toHaveBeenCalled());
    expect(onDelta.mock.calls[0]![0]).toMatchObject({
      type: "interval.upsert",
      payload: { id: "task:tenant-a:t1", sourceVersion: "2" },
    });

    // 流关闭后进入有界退避重连（base 10ms），第二次连接很快发生。
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    expect(fetchImpl.mock.calls[1]![1].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetchImpl.mock.calls[1]![1].redirect).toBe("error");
    expect(fetchImpl.mock.calls[1]![1].method).toBe("GET");
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).pathname).toBe("/api/v1/observe/runtime/events");

    client.stop();
    await connecting.catch(() => undefined);
  });

  it("nextBackoffMs 是有界指数退避：0→base，大 attempt 封顶 maxMs", () => {
    expect(nextBackoffMs(0, { baseMs: 500, maxMs: 30_000 })).toBe(500);
    expect(nextBackoffMs(1, { baseMs: 500, maxMs: 30_000 })).toBe(1000);
    expect(nextBackoffMs(6, { baseMs: 500, maxMs: 30_000 })).toBe(30_000);
    expect(nextBackoffMs(100, { baseMs: 500, maxMs: 30_000 })).toBe(30_000);
  });
});
