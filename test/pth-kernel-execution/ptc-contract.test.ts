import { describe, it, expect } from "vitest";
import { PTC_CAPABILITIES, PtcContractError, wrapValidated, buildCapabilityAsActionMap } from "../../src/pth/kernel/ptc/contract";
import { AGENT_CAPABILITY_AS_ACTION, AGENT_CAPABILITY_IDS } from "../../src/pth/kernel/execution/parse-agent-action";

describe("PTC 契约注册表（A1 Phase 1）", () => {
  it("注册表覆盖全部降级能力且三要素齐全", () => {
    for (const id of AGENT_CAPABILITY_IDS) {
      const def = PTC_CAPABILITIES[id];
      expect(def, id + " 缺注册表条目").toBeTruthy();
      expect(def.asAction, id + " 缺 asAction").toBeTruthy();
      expect(def.anchor.trim().length, id + " 缺场景锚点").toBeGreaterThan(0);
      expect(def.whenToUse.trim().length, id + " 缺何时用").toBeGreaterThan(0);
      expect(def.effect.trim().length, id + " 缺效果预告").toBeGreaterThan(0);
    }
  });

  it("降级模板派生映射与旧手写模板逐字节一致（golden）", () => {
    const gen = buildCapabilityAsActionMap();
    expect(Object.keys(gen).sort()).toEqual([...AGENT_CAPABILITY_IDS].sort());
    expect(gen["memory.query"]!({ sql: "SELECT 1" })).toBe('return await memory.query("SELECT 1");');
    expect(gen["memory.write"]!({ kind: "x", content: "y" })).toBe('return await memory.write({"kind":"x","content":"y"});');
    expect(gen["llm.complete"]!({ system: "S", user: "U" })).toBe('return await llm.complete([{ role: "system", content: "S" }, { role: "user", content: "U" }]);');
    expect(gen["web.fetchText"]!({ url: "http://x" })).toBe('return await web.fetchText("http://x");');
    expect(gen["fs.readText"]!({ path: "p" })).toBe('return await fs.readText("p");');
    expect(gen["fs.list"]!({ dir: "d" })).toBe('return await fs.list();');
    expect(gen["fs.list"]!({})).toBe('return await fs.list();');
    expect(gen["env.inspect"]!({ lang: "ts" })).toBe('return await env.inspect("ts");');
    expect(gen["env.inspect"]!({})).toBe('return await env.inspect();');
    expect(gen["state.recallFunctions"]!({ query: "q" })).toBe('return await state.recallFunctions(["q"]);');
    expect(gen["state.recallInsights"]!({})).toBe('return await state.recallInsights([]);');
  });

  it("AGENT_CAPABILITY_AS_ACTION 即派生映射（单一真相源）", () => {
    expect(AGENT_CAPABILITY_AS_ACTION["memory.query"]!({ sql: "SELECT 1" })).toBe('return await memory.query("SELECT 1");');
    expect(Object.keys(AGENT_CAPABILITY_AS_ACTION).length).toBe(14);   // +skills.maintain.write/archive；W8 P1/P2：+tasks.delegate/await/resume
  });

  it("参数校验：非法调用抛 PtcContractError（结构化——capability 可读）", () => {
    const def = PTC_CAPABILITIES["memory.query"]!;
    expect(() => def.validate!([])).toThrow(PtcContractError);
    try {
      def.validate!([]);
    } catch (e) {
      expect(e).toBeInstanceOf(PtcContractError);
      expect((e as PtcContractError).capability).toBe("memory.query");
      expect((e as PtcContractError).message).toContain("非空字符串");
    }
    expect(() => PTC_CAPABILITIES["memory.write"]!.validate!([{ content: "" }])).toThrow(/content 必须是非空字符串/);
    expect(() => PTC_CAPABILITIES["web.fetchText"]!.validate!([""])).toThrow(/web.fetchText/);
    expect(() => PTC_CAPABILITIES["env.inspect"]!.validate!([42])).toThrow(/必须是字符串/);
    // 合法调用不抛
    expect(() => PTC_CAPABILITIES["memory.query"]!.validate!(["SELECT 1"])).not.toThrow();
    expect(() => PTC_CAPABILITIES["env.inspect"]!.validate!(["ts"])).not.toThrow();
    expect(() => PTC_CAPABILITIES["env.inspect"]!.validate!([])).not.toThrow();
  });

  it("wrapValidated：合法调用透传、非法调用拦截、未注册不包装", async () => {
    const calls: unknown[][] = [];
    const fn = async (...args: unknown[]) => { calls.push(args); return "ok"; };
    const wrapped = wrapValidated("memory.query", fn);
    expect(await wrapped("SELECT 1")).toBe("ok");
    expect(calls).toEqual([["SELECT 1"]]);
    expect(() => wrapped("")).toThrow(PtcContractError);   // 校验在调用点同步抛出（fn 执行前）
    // 未注册/无校验 → 原函数引用
    expect(wrapValidated("no-such-cap", fn)).toBe(fn);
    expect(wrapValidated("cache", fn)).toBe(fn);
  });
});

