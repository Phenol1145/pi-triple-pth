import { describe, it, expect } from "vitest";
import { createServer, type AddressInfo } from "node:http";
import {
  createWebCapability,
  defaultWebRequest,
  readWebBody,
  type ResolvedAddress,
} from "../../src/pth/impls/kernels/capability";

const PUBLIC_ADDR: ResolvedAddress[] = [{ address: "8.8.8.8", family: 4 }];
const PRIVATE_ADDR: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];

interface FakeResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: () => AsyncIterable<Uint8Array>;
  cancel?: () => void;
}

function fakeResponse(
  body: string | Uint8Array | Uint8Array[],
  status = 200,
  headers: Record<string, string> = {},
): FakeResponse {
  const chunks = typeof body === "string" ? [new TextEncoder().encode(body)] : body instanceof Uint8Array ? [body] : body;
  return {
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    body: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** 记录每次请求的 URL 与受检地址，按序返回响应。 */
function makeRequest(responses: FakeResponse[]) {
  const calls: Array<{ url: URL; addresses: ResolvedAddress[] }> = [];
  const request = async (url: URL, init: { signal: AbortSignal; addresses: ResolvedAddress[] }) => {
    calls.push({ url, addresses: init.addresses });
    const next = responses.shift();
    if (!next) throw new Error("no fake response left");
    return next;
  };
  return { calls, request };
}

describe("web capability（S0-2 DNS rebinding + S0-3 流式限量）", () => {
  it("fetchText 获取纯文本（非 HTML）", async () => {
    const { calls, request } = makeRequest([fakeResponse("hello go spec", 200, { "content-type": "text/plain" })]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    expect(await web.fetchText("https://go.dev/ref/spec")).toBe("hello go spec");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.addresses).toEqual(PUBLIC_ADDR);
  });

  it("fetchText 剥离 HTML 标签", async () => {
    const { request } = makeRequest([fakeResponse("<html><body><h1>Title</h1><p>Go spec &amp; more</p></body></html>", 200, { "content-type": "text/html" })]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    const out = await web.fetchText("https://go.dev/ref/spec");
    expect(out).toContain("Title");
    expect(out).toContain("Go spec & more");
    expect(out).not.toContain("<");
  });

  it("拒绝非 http(s) URL（不发请求）", async () => {
    const { calls, request } = makeRequest([]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    await expect(web.fetchText("file:///etc/passwd")).rejects.toThrow(/only http/);
    expect(calls).toHaveLength(0);
  });

  it("HTTP 非 2xx 抛错", async () => {
    const { request } = makeRequest([fakeResponse("nope", 404)]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    await expect(web.fetchText("https://go.dev/missing")).rejects.toThrow(/HTTP 404/);
  });

  it("超限响应拒绝", async () => {
    const { request } = makeRequest([fakeResponse(new Uint8Array(1000), 200, { "content-type": "text/plain" })]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    await expect(web.fetchText("https://go.dev/ref/spec", { maxBytes: 100 })).rejects.toThrow(/too large/);
  });

  it("超时 abort", async () => {
    const request = (_url: URL, init: { signal: AbortSignal }) =>
      new Promise<FakeResponse>((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request: request as never });
    await expect(web.fetchText("https://go.dev/ref/spec", { timeoutMs: 30 })).rejects.toThrow(/aborted/);
  });

  it("IP 字面量为私网时在解析前拒绝（不发请求）", async () => {
    const { calls, request } = makeRequest([]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    await expect(web.fetchText("http://127.0.0.1:8080/")).rejects.toThrow(/非公网 IP/);
    expect(calls).toHaveLength(0);
  });

  it("域名解析到私网地址时整体拒绝（不发请求）", async () => {
    const { calls, request } = makeRequest([]);
    const web = createWebCapability({ lookup: async () => PRIVATE_ADDR, request });
    await expect(web.fetchText("https://attacker.example/x")).rejects.toThrow(/DNS 解析到非公网地址/);
    expect(calls).toHaveLength(0);
  });

  it("多地址解析中混入一个私网地址即拒绝", async () => {
    const { calls, request } = makeRequest([]);
    const web = createWebCapability({
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      request,
    });
    await expect(web.fetchText("https://attacker.example/x")).rejects.toThrow(/10\.0\.0\.1/);
    expect(calls).toHaveLength(0);
  });

  it("IPv6 解析为 ::1 时整体拒绝", async () => {
    const { calls, request } = makeRequest([]);
    const web = createWebCapability({ lookup: async () => [{ address: "::1", family: 6 }], request });
    await expect(web.fetchText("https://attacker.example/x")).rejects.toThrow(/::1/);
    expect(calls).toHaveLength(0);
  });

  it("IPv6 解析为链路本地 fe80:: 时整体拒绝", async () => {
    const { calls, request } = makeRequest([]);
    const web = createWebCapability({ lookup: async () => [{ address: "fe80::1", family: 6 }], request });
    await expect(web.fetchText("https://attacker.example/x")).rejects.toThrow(/fe80::1/);
    expect(calls).toHaveLength(0);
  });

  it("IPv4-mapped IPv6 私网地址同样拒绝", async () => {
    const { calls, request } = makeRequest([]);
    const web = createWebCapability({ lookup: async () => [{ address: "::ffff:127.0.0.1", family: 6 }], request });
    await expect(web.fetchText("https://attacker.example/x")).rejects.toThrow(/::ffff:127\.0\.0\.1/);
    expect(calls).toHaveLength(0);
  });

  it("解析失败向上传播", async () => {
    const { request } = makeRequest([]);
    const web = createWebCapability({
      lookup: async () => { throw new Error("ENOTFOUND"); },
      request,
    });
    await expect(web.fetchText("https://unknown.invalid/x")).rejects.toThrow(/ENOTFOUND/);
  });

  it("重定向每一跳都重新解析校验，公网跳转成功", async () => {
    const { calls, request } = makeRequest([
      fakeResponse("", 302, { location: "https://ok.test/final" }),
      fakeResponse("final body", 200, { "content-type": "text/plain" }),
    ]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    expect(await web.fetchText("https://start.test/begin")).toBe("final body");
    expect(calls.map((c) => c.url.toString())).toEqual([
      "https://start.test/begin",
      "https://ok.test/final",
    ]);
    expect(calls.every((c) => c.addresses[0]?.address === "8.8.8.8")).toBe(true);
  });

  it("重定向到解析为私网的主机时拒绝", async () => {
    const { calls, request } = makeRequest([
      fakeResponse("", 302, { location: "https://evil.test/x" }),
    ]);
    const web = createWebCapability({
      lookup: async (hostname) => (hostname === "start.test" ? PUBLIC_ADDR : PRIVATE_ADDR),
      request,
    });
    await expect(web.fetchText("https://start.test/begin")).rejects.toThrow(/DNS 解析到非公网地址/);
    expect(calls).toHaveLength(1);
  });

  // ── S0-3：流式限量 ────────────────────────────────────────────────

  it("多字节 UTF-8 字符跨 chunk 不裂", async () => {
    const encoded = new TextEncoder().encode("你好，世界 🌍");
    const split = Math.floor(encoded.length / 2);
    const { request } = makeRequest([
      fakeResponse([encoded.slice(0, split), encoded.slice(split)], 200, { "content-type": "text/plain" }),
    ]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    expect(await web.fetchText("https://go.dev/ref/spec")).toBe("你好，世界 🌍");
  });

  it("超限时立即 cancel，不消费剩余 body", async () => {
    let canceled = false;
    let yieldedAfterOverflow = false;
    const response = fakeResponse(new Uint8Array(0));
    response.body = async function* () {
      yield new Uint8Array(60);
      yield new Uint8Array(60);   // 总量 120 > maxBytes 100
      yieldedAfterOverflow = true;
      yield new Uint8Array(1000);
    };
    response.cancel = () => { canceled = true; };
    const { request } = makeRequest([response]);
    const web = createWebCapability({ lookup: async () => PUBLIC_ADDR, request });
    await expect(web.fetchText("https://go.dev/ref/spec", { maxBytes: 100 })).rejects.toThrow(/too large/);
    expect(canceled).toBe(true);
    expect(yieldedAfterOverflow).toBe(false);
  });

  it("默认传输流式读取超限时关闭上游连接（不等完整 body）", async () => {
    let clientClosed = false;
    let sentBytes = 0;
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
        res.write(new Uint8Array(64));
        sentBytes += 64;
      }, 5);
      req.on("close", () => { clientClosed = true; clearInterval(timer); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await defaultWebRequest(new URL(`http://unused-host.test:${port}/`), {
        signal: new AbortController().signal,
        addresses: [{ address: "127.0.0.1", family: 4 }],
      });
      await expect(readWebBody(res, 100)).rejects.toThrow(/too large/);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(clientClosed).toBe(true);
      expect(sentBytes).toBeLessThan(2000);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
