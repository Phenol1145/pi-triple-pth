import { describe, it, expect } from "vitest";
import { resolveIntent } from "../../src/pth/interaction/intent-resolver.js";

describe("N25 Intent Resolver", () => {
  it("任务意图 → request", () => {
    const r = resolveIntent("请实现一个求和函数");
    expect(r.mode).toBe("request");
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("问题 → discussion", () => {
    const r = resolveIntent("这个方案有什么风险？");
    expect(r.mode).toBe("discussion");
  });

  it("普通寒暄 → chitchat", () => {
    const r = resolveIntent("你好");
    expect(r.mode).toBe("chitchat");
  });
});
