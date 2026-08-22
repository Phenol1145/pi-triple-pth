import { describe, it, expect, beforeEach } from "vitest";
import { resetConfig, config, configNumber } from "@away_from/pth-kernel-interpreter";

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

  it("snapshot：schema 全表 + 运行时 set 值（字典序——perf.params 数据源）", () => {
    config().set("PTH_B", "2");
    config().set("PTH_A", "1");
    config().set("PTH_TEST_PARAM", "env-value");   // 非 schema 键 set 后也进快照
    const snap = config().snapshot();
    const keys = Object.keys(snap);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));            // localeCompare 字典序
    expect(keys.length).toBeGreaterThan(50);           // schema 全表（配置集中化）
    expect(snap["PTH_A"]).toBe("1");
    expect(snap["PTH_AGENT_MODEL"]).toBe("env-model");
    expect(snap["PTH_TEST_PARAM"]).toBe("env-value");
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

describe("ConfigCenter.explain（N33 Task 3）", () => {
  beforeEach(() => {
    delete process.env.PTH_TEST_PARAM;
    delete process.env.LOG_LEVEL;
    resetConfig({ PTH_AGENT_MODEL: "env-model", LOG_LEVEL: "info" });
  });

  it("default 与 env 初始来源：只看出席，不从等值推断", () => {
    // LOG_LEVEL env=info 与 schema default 完全相同，仍必须报 env。
    expect(config().explain("LOG_LEVEL")).toEqual({ source: "env", value: "info" });
    // PTH_AGENT_MAX_STEPS 未注入 env → default。
    expect(config().explain("PTH_AGENT_MAX_STEPS")).toEqual({ source: "default", value: "10" });
  });

  it("runtime set 之后 explain 跟踪为 runtime，且不保留历史", () => {
    config().set("PTH_AGENT_MODEL", "deepseek-v4-pro");
    expect(config().explain("PTH_AGENT_MODEL")).toEqual({ source: "runtime", value: "deepseek-v4-pro" });
    // 再次 set 覆盖：只有最新来源，没有历史列表。
    config().set("PTH_AGENT_MODEL", "deepseek-v4-flash");
    expect(config().explain("PTH_AGENT_MODEL")).toEqual({ source: "runtime", value: "deepseek-v4-flash" });
  });

  it("secret 键 explain 恒为 ***，即便 runtime set 传入了明文", () => {
    config().set("DATABASE_URL", "postgres://super-secret");
    expect(config().explain("DATABASE_URL")).toEqual({ source: "runtime", value: "***" });
    expect(config().explain("REDIS_PASSWORD").value).toBe("***");
  });

  it("未注册键：env 命中报 env，set 后报 runtime，否则 unknown", () => {
    expect(config().explain("PTH_NO_SUCH_KEY")).toEqual({ source: "unknown", value: "" });
    resetConfig({ PTH_CUSTOM_INSPECTION: "from-env" });
    expect(config().explain("PTH_CUSTOM_INSPECTION")).toEqual({ source: "env", value: "from-env" });
    config().set("PTH_CUSTOM_INSPECTION", "from-runtime");
    expect(config().explain("PTH_CUSTOM_INSPECTION")).toEqual({ source: "runtime", value: "from-runtime" });
  });
});
