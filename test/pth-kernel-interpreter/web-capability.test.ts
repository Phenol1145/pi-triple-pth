import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebCapability } from "../../src/pth/impls/kernels/capability";

afterEach(() => vi.unstubAllGlobals());

describe("web capability", () => {
  it("fetchText 获取纯文本（非 HTML）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      arrayBuffer: async () => new TextEncoder().encode("hello go spec").buffer,
    })));
    const web = createWebCapability();
    expect(await web.fetchText("https://go.dev/ref/spec")).toBe("hello go spec");
  });

  it("fetchText 剥离 HTML 标签", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      arrayBuffer: async () => new TextEncoder().encode("<html><body><h1>Title</h1><p>Go spec &amp; more</p></body></html>").buffer,
    })));
    const web = createWebCapability();
    const out = await web.fetchText("https://go.dev/ref/spec");
    expect(out).toContain("Title");
    expect(out).toContain("Go spec & more");
    expect(out).not.toContain("<");
  });

  it("拒绝非 http(s) URL", async () => {
    const web = createWebCapability();
    await expect(web.fetchText("file:///etc/passwd")).rejects.toThrow(/only http/);
  });

  it("HTTP 非 2xx 抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const web = createWebCapability();
    await expect(web.fetchText("https://go.dev/missing")).rejects.toThrow(/HTTP 404/);
  });

  it("超限响应拒绝", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      arrayBuffer: async () => new Uint8Array(1000).buffer,
    })));
    const web = createWebCapability();
    await expect(web.fetchText("https://go.dev/ref/spec", { maxBytes: 100 })).rejects.toThrow(/too large/);
  });

  it("超时 abort", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }));
    const web = createWebCapability();
    await expect(web.fetchText("https://go.dev/ref/spec", { timeoutMs: 50 })).rejects.toThrow();
  });
});
