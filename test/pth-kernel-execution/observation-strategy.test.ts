import { describe, it, expect } from "vitest";
import {
  ObservationStrategyRegistry,
  evaluateObservationStrategy,
  getPathValue,
  matchObservationCondition,
  ObservationStrategyError,
  type ObservationStrategySpec,
} from "@away_from/pth-kernel-execution";

describe("getPathValue", () => {
  it("支持点号与数组下标", () => {
    const input = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(getPathValue(input, "a.b[1].c")).toBe(2);
    expect(getPathValue(input, "a.b[0].c")).toBe(1);
    expect(getPathValue(input, "missing")).toBeUndefined();
  });
});

describe("matchObservationCondition", () => {
  it("eq/ne/gt/contains/regex", () => {
    expect(matchObservationCondition({ role: "executor", steps: 5 }, { field: "role", op: "eq", value: "executor" })).toBe(true);
    expect(matchObservationCondition({ role: "executor" }, { field: "role", op: "ne", value: "planner" })).toBe(true);
    expect(matchObservationCondition({ steps: 5 }, { field: "steps", op: "gt", value: 4 })).toBe(true);
    expect(matchObservationCondition({ tags: ["a", "b"] }, { field: "tags", op: "contains", value: "b" })).toBe(true);
    expect(matchObservationCondition({ name: "Hello World" }, { field: "name", op: "regex", value: "^hello", caseSensitive: false })).toBe(true);
    expect(matchObservationCondition({ name: "Hello World" }, { field: "name", op: "regex", value: "^hello" })).toBe(false);
  });
});

describe("evaluateObservationStrategy", () => {
  const samples = [
    { role: "executor", steps: 10, ok: true },
    { role: "executor", steps: 4, ok: false },
    { role: "planner", steps: 8, ok: true },
  ];

  it("count：命中数量", () => {
    const spec: ObservationStrategySpec = {
      id: "s:executor-count",
      conditions: [{ field: "role", op: "eq", value: "executor" }],
      aggregate: "count",
    };
    const f = evaluateObservationStrategy(spec, samples);
    expect(f.value).toBe(2);
    expect(f.metadata).toMatchObject({ matched: 2, total: 3 });
  });

  it("rate：命中率", () => {
    const spec: ObservationStrategySpec = {
      id: "s:executor-rate",
      conditions: [{ field: "role", op: "eq", value: "executor" }],
      aggregate: "rate",
    };
    expect(evaluateObservationStrategy(spec, samples).value).toBeCloseTo(2 / 3);
  });

  it("sum/avg/p95/distinct", () => {
    const sum = evaluateObservationStrategy({ id: "s:sum", conditions: [{ field: "ok", op: "eq", value: true }], aggregate: "sum", field: "steps" }, samples);
    expect(sum.value).toBe(18);
    const avg = evaluateObservationStrategy({ id: "s:avg", conditions: [{ field: "ok", op: "eq", value: true }], aggregate: "avg", field: "steps" }, samples);
    expect(avg.value).toBe(9);
    const p95 = evaluateObservationStrategy({ id: "s:p95", conditions: [], aggregate: "p95", field: "steps" }, samples);
    expect(p95.value).toBe(10);
    const distinct = evaluateObservationStrategy({ id: "s:distinct", conditions: [], aggregate: "distinct", field: "role" }, samples);
    expect(distinct.value).toBe(2);
  });

  it("脚本策略禁止热路径同步求值", () => {
    const spec: ObservationStrategySpec = { id: "s:script", scriptRef: "async:foo" };
    expect(() => evaluateObservationStrategy(spec, samples)).toThrow(ObservationStrategyError);
  });

  it("maxSamples 超限产生 observation-strategy-error", () => {
    const spec: ObservationStrategySpec = { id: "s:budget", conditions: [], budget: { maxSamples: 2 } };
    expect(() => evaluateObservationStrategy(spec, samples)).toThrow(/maxSamples/);
  });

  it("regex 长度超限拒绝", () => {
    const spec: ObservationStrategySpec = {
      id: "s:regex",
      conditions: [{ field: "name", op: "regex", value: "a".repeat(201) }],
      budget: { maxRegexLength: 200 },
    };
    expect(() => evaluateObservationStrategy(spec, [{ name: "a" }])).toThrow(/maxRegexLength/);
  });
});

describe("ObservationStrategyRegistry", () => {
  it("active 可热路径；async 只登记不可热路径", () => {
    const reg = new ObservationStrategyRegistry();
    reg.register({ id: "s:active", conditions: [], aggregate: "count" });
    reg.register({ id: "s:async", scriptRef: "async:x" });
    expect(reg.listHotPathSafe().map((r) => r.spec.id)).toEqual(["s:active"]);
    expect(() => reg.evaluate("s:async", [])).toThrow(/async/);
    expect(reg.evaluate("s:active", [{ a: 1 }]).strategyId).toBe("s:active");
  });
});
