import { describe, it, expect } from "vitest";
import { ConsecutiveGuard, createGuardRegistry, GUARD_DEFS, GUARD_EXEMPTIONS } from "../../src/pth/kernel/execution/guardrails";

/** 可运行时改阈值的配置函数（模拟 perf-params configNumber） */
function makeLimit(bag: Record<string, number>) {
  return (key: string, fallback: number) => bag[key] ?? fallback;
}

describe("ConsecutiveGuard（N12 护栏统一抽象——连续计数守卫）", () => {
  const ctx = { roleId: "developer", tool: "ts.run", steps: 1 };

  it("hit 计数 → guide（guideAt）→ soft 软终止（soft 语义）", () => {
    const g = new ConsecutiveGuard(GUARD_DEFS["repeat-action"], makeLimit({}));
    expect(g.step(ctx, false).kind).toBe("none");          // 未命中——重置
    expect(g.step(ctx, true)).toMatchObject({ kind: "none", count: 1 });
    expect(g.step(ctx, true)).toMatchObject({ kind: "none", count: 2 });
    expect(g.step(ctx, true)).toMatchObject({ kind: "guide", count: 3, limit: 5 });
    expect(g.step(ctx, true)).toMatchObject({ kind: "guide", count: 4 });
    expect(g.step(ctx, true)).toMatchObject({ kind: "soft", count: 5, limit: 5 });
  });

  it("hard 语义（空 done——第 limit 次硬失败）", () => {
    const g = new ConsecutiveGuard(GUARD_DEFS["empty-done"], makeLimit({}));
    g.step(ctx, true); g.step(ctx, true);
    const v = g.step(ctx, true);
    expect(v).toMatchObject({ kind: "hard", count: 3, limit: 3 });
  });

  it("hit 中断即重置（未命中清零）", () => {
    const g = new ConsecutiveGuard(GUARD_DEFS["empty-reply"], makeLimit({}));
    g.step(ctx, true); g.step(ctx, true);
    const v = g.step(ctx, false);
    expect(v).toMatchObject({ kind: "none", count: 0 });
    expect(g.step(ctx, true)).toMatchObject({ kind: "none", count: 1 });   // 重新从 1 计
  });

  it("阈值走配置中心（运行时可调——配置键命中即生效）", () => {
    const g = new ConsecutiveGuard(GUARD_DEFS["unknown-tool"], makeLimit({ PTH_GUARD_UNKNOWN_TOOL_LIMIT: 5 }));
    g.step(ctx, true); g.step(ctx, true); g.step(ctx, true);
    expect(g.step(ctx, true)).toMatchObject({ kind: "none", count: 4 });   // 原缺省 3 已不生效
    expect(g.step(ctx, true)).toMatchObject({ kind: "hard", count: 5, limit: 5 });
  });

  it("豁免谓词——豁免时不计数不处置", () => {
    const g = new ConsecutiveGuard(
      { ...GUARD_DEFS["repeat-action"], exempt: (c) => c.roleId === "scout" },
      makeLimit({}),
    );
    const scout = { roleId: "scout", tool: "bash.run", steps: 1 };
    for (let i = 0; i < 6; i++) {
      const v = g.step(scout, true);
      expect(v.kind).toBe("none");
      expect(v.count).toBe(0);   // 豁免从不计数
    }
  });
});

describe("guard registry（注册表 + 豁免矩阵 + 负结果阈值）", () => {
  it("guard(id) 返回同一实例（每任务循环一组——计数随实例）", () => {
    const reg = createGuardRegistry(makeLimit({}));
    expect(reg.guard("repeat-action")).toBe(reg.guard("repeat-action"));
  });

  it("未注册护栏报错", () => {
    const reg = createGuardRegistry(makeLimit({}));
    expect(() => reg.guard("no-such-guard")).toThrow(/未注册的护栏/);
  });

  it("豁免矩阵声明式——negative-loop 侦察豁免（T5）", () => {
    expect(GUARD_EXEMPTIONS["negative-loop"]?.({ roleId: "scout", tool: "x", steps: 1 })).toBe(true);
    expect(GUARD_EXEMPTIONS["negative-loop"]?.({ roleId: "explorer", tool: "x", steps: 1 })).toBe(true);
    expect(GUARD_EXEMPTIONS["negative-loop"]?.({ roleId: "acceptor", tool: "x", steps: 1 })).toBe(false);
    expect(GUARD_EXEMPTIONS["negative-loop"]?.({ tool: "x", steps: 1 })).toBe(false);
    // 未知护栏 id 豁免默认 false
    const reg = createGuardRegistry(makeLimit({}));
    expect(reg.exempt("no-such-guard", { tool: "x", steps: 1 })).toBe(false);
  });

  it("negativeLimits 走配置键（缺省 5/3）", () => {
    const reg = createGuardRegistry(makeLimit({}));
    expect(reg.negativeLimits()).toEqual({ terminate: 5, guideAt: 3 });
    const reg2 = createGuardRegistry(makeLimit({ PTH_GUARD_NEGATIVE_LIMIT: 7, PTH_GUARD_NEGATIVE_GUIDE_AT: 4 }));
    expect(reg2.negativeLimits()).toEqual({ terminate: 7, guideAt: 4 });
  });
});

