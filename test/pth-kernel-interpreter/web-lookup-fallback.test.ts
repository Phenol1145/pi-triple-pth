import { describe, expect, it, vi } from "vitest";
import {
  createWebLookupWithDohFallback,
  resolvePublicAddresses,
  type ResolvedAddress,
  type WebLookup,
} from "../../src/pth/impls/kernels/web-transport.js";

const PUBLIC: ResolvedAddress[] = [{ address: "8.8.8.8", family: 4 }];
const FAKE_IP: ResolvedAddress[] = [
  { address: "198.18.0.146", family: 4 },
  { address: "fdfe:dcba:9876::127", family: 6 },
];
const PRIVATE: ResolvedAddress[] = [{ address: "10.0.0.1", family: 4 }];

describe("web lookup DoH fallback（fake-ip DNS 场景）", () => {
  it("系统 DNS 返回公网地址时直接使用，不触发 DoH", async () => {
    const system = vi.fn<WebLookup>(async () => PUBLIC);
    const doh = vi.fn<WebLookup>(async () => {
      throw new Error("should not be called");
    });
    const lookup = createWebLookupWithDohFallback({ systemLookup: system, dohLookup: doh });
    await expect(lookup("example.com")).resolves.toEqual(PUBLIC);
    expect(doh).not.toHaveBeenCalled();
  });

  it("系统 DNS 全为 fake-ip/私网时回退 DoH 获取公网地址", async () => {
    const system = vi.fn<WebLookup>(async () => FAKE_IP);
    const doh = vi.fn<WebLookup>(async () => PUBLIC);
    const lookup = createWebLookupWithDohFallback({ systemLookup: system, dohLookup: doh });
    await expect(lookup("example.com")).resolves.toEqual(PUBLIC);
    expect(doh).toHaveBeenCalledTimes(1);
    await expect(resolvePublicAddresses("example.com", lookup)).resolves.toEqual(PUBLIC);
  });

  it("系统 DNS 解析失败时回退 DoH", async () => {
    const system = vi.fn<WebLookup>(async () => {
      throw new Error("getaddrinfo ENOTFOUND unknown.invalid");
    });
    const doh = vi.fn<WebLookup>(async () => PUBLIC);
    const lookup = createWebLookupWithDohFallback({ systemLookup: system, dohLookup: doh });
    await expect(lookup("unknown.invalid")).resolves.toEqual(PUBLIC);
    expect(doh).toHaveBeenCalledTimes(1);
  });

  it("系统 DNS 和 DoH 都失败时保留系统错误", async () => {
    const system = vi.fn<WebLookup>(async () => {
      throw new Error("getaddrinfo ENOTFOUND unknown.invalid");
    });
    const doh = vi.fn<WebLookup>(async () => []);
    const lookup = createWebLookupWithDohFallback({ systemLookup: system, dohLookup: doh });
    await expect(lookup("unknown.invalid")).rejects.toThrow(/ENOTFOUND/);
  });

  it("系统 DNS 返回混合公网+私网时不回退（保持 fail-closed）", async () => {
    const mixed = [...PUBLIC, ...PRIVATE];
    const system = vi.fn<WebLookup>(async () => mixed);
    const doh = vi.fn<WebLookup>(async () => PUBLIC);
    const lookup = createWebLookupWithDohFallback({ systemLookup: system, dohLookup: doh });
    await expect(lookup("example.com")).resolves.toEqual(mixed);
    expect(doh).not.toHaveBeenCalled();
    await expect(resolvePublicAddresses("example.com", lookup)).rejects.toThrow(/DNS 解析到非公网地址/);
  });
});
