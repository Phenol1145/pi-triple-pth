import { describe, it, expect, beforeEach } from "vitest";
import {
  config, resetConfig, configNumber, pthConfig, resetPthConfig,
  validatePthConfig, exportPtlMigration, getConfigDef,
} from "../../src/pth/config/index.js";

describe("PTH config 集中化（C1：schema 默认值 + ConfigCenter 权威化）", () => {
  beforeEach(() => resetPthConfig({}));

  it("schema 默认值兜底：未设 env 时返回迁移前代码内联默认值", () => {
    const cfg = pthConfig();
    expect(cfg.str("PTH_AGENT_MODEL")).toBe("deepseek-v4-flash");
    expect(cfg.num("PTH_OPTIMIZER_WINDOW")).toBe(10);
    expect(cfg.num("PTH_VERIFY_TIMEOUT_MS")).toBe(30 * 60_000);
    expect(cfg.num("PTH_MEMORY_SWEEP_SECONDS")).toBe(86_400);
    expect(cfg.str("PTH_SANDBOX_KERNEL_URL")).toBe("http://sandbox:8080");
    expect(cfg.str("PTH_COGNITIVE_RESPONSIBILITY_MODE")).toBe("off");   // N28：off 默认
    expect(cfg.str("PTH_BATCH_ID")).toBe("");                            // N28：空默认
    expect(cfg.enabled("PTH_OPTIMIZER")).toBe(true);      // "on" → enabled
    expect(cfg.enabled("PTH_AUTOPILOT_MODE")).toBe(false); // "off" → disabled
    expect(cfg.enabled("PTH_REFINE")).toBe(true);          // "auto" → enabled
  });

  it("env 优先于 schema 默认值", () => {
    resetConfig({ PTH_OPTIMIZER_WINDOW: "25", PTH_AGENT_MODEL: "m-x" });
    const cfg = pthConfig();
    expect(cfg.num("PTH_OPTIMIZER_WINDOW")).toBe(25);
    expect(cfg.str("PTH_AGENT_MODEL")).toBe("m-x");
  });

  it("snapshot 默认打码 secret（worker perf.params 不泄露密钥）", () => {
    resetConfig({
      PTH_EXECUTION_GRANT_SECRET: "grant-super-secret-value",
      SANDBOX_SHARED_SECRET: "sandbox-secret-value",
      PTH_AGENT_MODEL: "m1",
    });
    const snap = config().snapshot();
    expect(snap["PTH_EXECUTION_GRANT_SECRET"]).toBe("***");
    expect(snap["SANDBOX_SHARED_SECRET"]).toBe("***");
    expect(snap["PTH_AGENT_MODEL"]).toBe("m1");
    const full = config().snapshot(true);
    expect(full["PTH_EXECUTION_GRANT_SECRET"]).toBe("grant-super-secret-value");
  });

  it("set/on：runtime 键动态生效并通知订阅者", () => {
    const seen: Array<string | undefined> = [];
    const off = config().on("PTH_AGENT_MAX_STEPS", (v) => seen.push(v));
    config().set("PTH_AGENT_MAX_STEPS", "42");
    expect(configNumber("PTH_AGENT_MAX_STEPS", 10)).toBe(42);
    expect(pthConfig().num("PTH_AGENT_MAX_STEPS")).toBe(42);
    expect(seen).toEqual(["42"]);
    off();
    config().set("PTH_AGENT_MAX_STEPS", "7");
    expect(seen).toEqual(["42"]);   // 已退订
  });

  it("configNumber：NaN → schema 默认 → fallback 链", () => {
    resetConfig({ PTH_AGENT_MAX_STEPS: "oops" });
    expect(configNumber("PTH_AGENT_MAX_STEPS", 10)).toBe(10);      // schema 默认 10
    expect(configNumber("PTH_NOT_A_KEY", 99)).toBe(99);            // fallback
    resetConfig({ PTH_AGENT_MAX_STEPS: "33" });
    expect(configNumber("PTH_AGENT_MAX_STEPS", 10)).toBe(33);
  });

  it("validatePthConfig：严格模式拒绝开发默认 token 与弱密钥", () => {
    const issues = validatePthConfig({ PTH_CONFIG_STRICT: "1", PTH_TOKEN: "test-token-123" });
    expect(issues.some((i) => i.key === "PTH_TOKEN" && i.level === "error")).toBe(true);
    expect(issues.some((i) => i.key === "PTH_EXECUTION_GRANT_SECRET")).toBe(false); // 未设置不算弱（compose :? 管）
    expect(validatePthConfig({ PTH_EXECUTION_GRANT_SECRET: "short", PTH_CONFIG_STRICT: "1" })
      .some((i) => i.key === "PTH_EXECUTION_GRANT_SECRET")).toBe(true);
  });

  it("validatePthConfig：资源型参数越界记 warn（C11 护栏）", () => {
    const issues = validatePthConfig({ PTH_KERNEL_POOL_SIZE: "100000" });
    expect(issues.some((i) => i.key === "PTH_KERNEL_POOL_SIZE" && i.level === "warn" && i.message.includes("护栏范围"))).toBe(true);
    expect(issues.some((i) => i.key === "PTH_KERNEL_POOL_SIZE" && i.level === "error")).toBe(false);
  });

  it("exportPtlMigration：输出 ptl config set 通道（token 默认打码）", () => {
    const lines = exportPtlMigration({ PTH_URL: "http://host:3000", PTH_TOKEN: "tok-123" });
    expect(lines[0]).toBe("ptl config set pth.url http://host:3000");
    expect(lines[1]).toContain("未导出");
    const withToken = exportPtlMigration({ PTH_URL: "http://host:3000", PTH_TOKEN: "tok-123" }, true);
    expect(withToken[1]).toBe("ptl config set pth.token tok-123");
  });

  it("resetPthConfig 重建单例（测试隔离）", () => {
    resetPthConfig({ PTH_AGENT_MODEL: "r1" });
    expect(pthConfig().str("PTH_AGENT_MODEL")).toBe("r1");
    resetPthConfig({});
    expect(pthConfig().str("PTH_AGENT_MODEL")).toBe("deepseek-v4-flash");
  });
});

describe("P1.1：execution 配置组 + json() accessor", () => {
  beforeEach(() => resetPthConfig({}));

  it("四个 PTH_EXEC_* 键进 schema（group=execution，默认值固定）", () => {
    const cfg = pthConfig();
    expect(cfg.str("PTH_EXEC_BACKENDS")).toBe("");
    expect(cfg.str("PTH_EXEC_BACKEND_ROUTES")).toBe("");
    expect(cfg.num("PTH_EXEC_BACKEND_PROBE_TIMEOUT_MS")).toBe(2000);
    expect(cfg.str("PTH_EXEC_SANDBOX_ALIAS")).toBe("on");
    expect(getConfigDef("PTH_EXEC_BACKENDS")?.group).toBe("execution");
  });

  it("json()：空串 → undefined；合法 JSON → 解析值；非法 JSON → 抛带 key 的错误", () => {
    const cfg = pthConfig();
    expect(cfg.json("PTH_EXEC_BACKENDS")).toBeUndefined();
    resetPthConfig({ PTH_EXEC_BACKENDS: JSON.stringify([{ id: "local-lean", url: "http://x", profile: "host" }]) });
    expect(pthConfig().json<unknown[]>("PTH_EXEC_BACKENDS")).toEqual([
      { id: "local-lean", url: "http://x", profile: "host" },
    ]);
    resetPthConfig({ PTH_EXEC_BACKENDS: "{broken" });
    expect(() => pthConfig().json("PTH_EXEC_BACKENDS")).toThrow(/PTH_EXEC_BACKENDS 不是合法 JSON/);
  });
});
