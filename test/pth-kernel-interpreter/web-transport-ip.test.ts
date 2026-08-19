import { describe, expect, it } from "vitest";
import { isPrivateIpLiteral } from "../../src/pth/impls/kernels/web-transport.js";

describe("N29 再验收 P1-1：isPrivateIpLiteral 特殊地址分类", () => {
  it("IPv4 私网/环回/链路本地/CGNAT 拒绝", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1"]) {
      expect(isPrivateIpLiteral(ip), ip).toBe(true);
    }
  });

  it("IPv4 组播/保留/benchmark/documentation 拒绝", () => {
    for (const ip of [
      "224.0.0.1",      // multicast
      "240.0.0.1",      // reserved / future-use
      "198.18.0.1",     // 198.18.0.0/15 benchmarking
      "198.19.255.255", // benchmarking 上界
      "192.0.2.1",      // TEST-NET-1
      "198.51.100.1",   // TEST-NET-2
      "203.0.113.1",    // TEST-NET-3
    ]) {
      expect(isPrivateIpLiteral(ip), ip).toBe(true);
    }
  });

  it("IPv6 loopback/unspecified/ULA/link-local/multicast 拒绝", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe9f::1", "feb8::1", "ff02::1", "ff00::1"]) {
      expect(isPrivateIpLiteral(ip), ip).toBe(true);
    }
  });

  it("IPv4-mapped 全展开形式（点分与十六进制）按映射前缀拒绝", () => {
    for (const ip of [
      "::ffff:127.0.0.1",           // 点分压缩
      "0:0:0:0:0:ffff:127.0.0.1",   // 点分全展开
      "0:0:0:0:0:ffff:7f00:1",      // 十六进制全展开（= 127.0.0.1）
      "::ffff:10.0.0.1",
      "::ffff:192.168.0.1",
      "::ffff:8.8.8.8",             // 映射前缀本身非公网可路由——fail-closed
    ]) {
      expect(isPrivateIpLiteral(ip), ip).toBe(true);
    }
  });

  it("documentation IPv6（2001:db8::/32）拒绝", () => {
    expect(isPrivateIpLiteral("2001:db8::1")).toBe(true);
    expect(isPrivateIpLiteral("2001:0db8:0000:0000::1")).toBe(true);
  });

  it("真实公网地址放行", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isPrivateIpLiteral(ip), ip).toBe(false);
    }
  });

  it("无法判定的输入一律拒绝（fail-closed）", () => {
    expect(isPrivateIpLiteral("not-an-ip")).toBe(true);
    expect(isPrivateIpLiteral("")).toBe(true);
  });
});
