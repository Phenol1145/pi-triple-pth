import { describe, it, expect } from "vitest";
import { matchesRule, validateFlow, isResolvable } from "@away_from/pth-kernel-execution";

describe("matchesRule（JSON 匹配）", () => {
  it("精确匹配 payload 顶层字段", () => {
    expect(matchesRule({ status: "completed", kind: "dev" }, { status: "completed", payload: { kind: "dev" } } as any)).toBe(true);
    expect(matchesRule({ status: "completed" }, { status: "pending", payload: {} } as any)).toBe(false);
  });

  it("通配 * 匹配任意", () => {
    expect(matchesRule({ status: "*" }, { status: "anything" } as any)).toBe(true);
  });

  it("嵌套路径（output.ok）", () => {
    expect(matchesRule({ "output.ok": true }, { payload: { output: { ok: true } } } as any)).toBe(true);
    expect(matchesRule({ "output.ok": true }, { payload: { output: { ok: false } } } as any)).toBe(false);
  });

  it("缺省字段不参与（undefined 不匹配）", () => {
    expect(matchesRule({ role: "developer" }, { status: "completed" } as any)).toBe(false);
  });

  it("空 rule = 恒真", () => {
    expect(matchesRule({}, { status: "pending" } as any)).toBe(true);
  });
});

describe("validateFlow（路由声明校验）", () => {
  it("合法 flow（stages 数组 + 已知算子）", () => {
    const r = validateFlow({ stages: [{ id: "s1", match: { status: "pending" }, transform: { role: "developer" } }] });
    expect(r.ok).toBe(true);
  });

  it("缺 stages → 非法", () => {
    expect(validateFlow({}).ok).toBe(false);
  });

  it("stage 缺 id → 非法", () => {
    expect(validateFlow({ stages: [{ transform: {} }] }).ok).toBe(false);
  });

  it("未知算子 → 非法", () => {
    expect(validateFlow({ stages: [{ id: "s1", frobnicate: {} }] }).ok).toBe(false);
  });

  it("match 值支持 number（数量比较场景）", () => {
    const r = validateFlow({ stages: [{ id: "s1", match: { claims_count: 2 } }] });
    expect(r.ok).toBe(true);
  });
});

describe("isResolvable（待解析判定）", () => {
  it("有 flow 且存在未注销阶段 → 可解析", () => {
    expect(isResolvable({ payload: { flow: { stages: [{ id: "s1" }] }, resolvedStages: [] } } as any)).toBe(true);
  });

  it("全部阶段已注销 → 不可解析", () => {
    expect(isResolvable({ payload: { flow: { stages: [{ id: "s1" }] }, resolvedStages: ["s1"] } } as any)).toBe(false);
  });

  it("无 flow → 不可解析", () => {
    expect(isResolvable({ payload: {} } as any)).toBe(false);
  });

  it("无 payload → 不可解析", () => {
    expect(isResolvable({} as any)).toBe(false);
  });
});
