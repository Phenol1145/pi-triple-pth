import { describe, it, expect, vi, afterEach } from "vitest";
import { PthClient } from "../../packages/pth-console/src/bridge/client.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("PthClient 网络错误翻译", () => {
  it("fetch 连接拒绝 → 可操作错误（含 URL 与原因）", async () => {
    const err = new TypeError("fetch failed");
    (err as any).cause = { code: "ECONNREFUSED" };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    const c = new PthClient("http://localhost:3999", "tok");
    await expect(c.list()).rejects.toThrow(/无法连接 PTH 服务器 \(http:\/\/localhost:3999/);
    await expect(c.list()).rejects.toThrow(/ECONNREFUSED/);
    await expect(c.list()).rejects.toThrow(/pth 已启动/);
  });

  it("fetch DNS 失败 → 可操作错误", async () => {
    const err = new TypeError("fetch failed");
    (err as any).cause = { code: "ENOTFOUND" };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    const c = new PthClient("http://no-such-host.invalid", "tok");
    await expect(c.list()).rejects.toThrow(/ENOTFOUND/);
  });

  it("HTTP 401 → 原 token 提示不变", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const c = new PthClient("http://localhost:3999", "tok");
    await expect(c.list()).rejects.toThrow(/Token 无效 \(401\)/);
  });
});
