import { describe, it, expect, beforeEach } from "vitest";
import { resetConfig, config, configNumber } from "../../src/pth/kernel/extensions/perf-params.js";

/**
 * 配置中心（Phase 2——perf 底座）：env 快照加载 + 运行时 set + 订阅。
 */

describe("配置中心（ConfigCenter）", () => {
  beforeEach(() => {
    delete process.env.PTH_TEST_PARAM;
    resetConfig({ PTH_TEST_PARAM: "env-value", PTH_AGENT_MODEL: "env-model" });
  });

  it("启动快照：PTH_* 参数从 env 载入", () => {
    expect(config().get("PTH_TEST_PARAM")).toBe("env-value");
  });

  it("运行时 set（SET 语义）：改写后 get 生效", () => {
    config().set("PTH_AGENT_MODEL", "deepseek-v4-pro");
    expect(config().get("PTH_AGENT_MODEL")).toBe("deepseek-v4-pro");
  });

  it("env 未变：set 后注入 env 原值不影响（快照优先）", () => {
    const injected = { PTH_TEST_PARAM: "env-value" };
    resetConfig(injected);
    config().set("PTH_TEST_PARAM", "runtime-value");
    expect(config().get("PTH_TEST_PARAM")).toBe("runtime-value");
    expect(injected["PTH_TEST_PARAM"]).toBe("env-value"); // 不改写 env
  });

  it("非 PTH_* key 不载入快照但可 set", () => {
    expect(config().get("FOO")).toBeUndefined();
    config().set("FOO", "1");
    expect(config().get("FOO")).toBe("1");
  });

  it("snapshot：全表排序快照（perf.params 数据源）", () => {
    config().set("PTH_B", "2");
    config().set("PTH_A", "1");
    const snap = config().snapshot();
    expect(Object.keys(snap)).toEqual(["PTH_A", "PTH_AGENT_MODEL", "PTH_B", "PTH_TEST_PARAM"]); // 字典序
    expect(snap["PTH_A"]).toBe("1");
  });

  it("on：变更订阅 + 取消", () => {
    const seen: Array<string | undefined> = [];
    const off = config().on("PTH_TEST_PARAM", (v) => seen.push(v));
    config().set("PTH_TEST_PARAM", "v1");
    config().set("PTH_TEST_PARAM", "v2");
    off();
    config().set("PTH_TEST_PARAM", "v3");
    expect(seen).toEqual(["v1", "v2"]);
  });

  it("configNumber：NaN 防御 + 回退", () => {
    config().set("PTH_NUM", "42");
    expect(configNumber("PTH_NUM", 10)).toBe(42);
    config().set("PTH_NUM", "abc");
    expect(configNumber("PTH_NUM", 10)).toBe(10);
    expect(configNumber("PTH_NONE", 10)).toBe(10);
  });
});
