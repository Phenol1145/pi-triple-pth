import { describe, it, expect } from "vitest";
import { defaultRunnerConfig, resolveExecMode } from "../../src/pth/runner/runner-config.js";

describe("resolveExecMode / defaultRunnerConfig", () => {
  it("显式 PTH_EXEC_MODE 优先", () => {
    expect(resolveExecMode({ PTH_EXEC_MODE: "asp", PTH_ASP_MODE: "off", PTH_AGENT_MODE: "off" })).toBe("asp");
    expect(resolveExecMode({ PTH_EXEC_MODE: "pulse", PTH_ASP_MODE: "on" })).toBe("pulse");
    expect(resolveExecMode({ PTH_EXEC_MODE: "tool-call", PTH_AGENT_MODE: "off" })).toBe("tool-call");
  });

  it("非法 PTH_EXEC_MODE fail-fast", () => {
    expect(() => resolveExecMode({ PTH_EXEC_MODE: "magic" })).toThrow(/非法值/);
  });

  it("PTH_ASP_MODE=on 兼容别名 → asp", () => {
    expect(resolveExecMode({ PTH_ASP_MODE: "on" })).toBe("asp");
  });

  it("PTH_AGENT_MODE=off 兼容别名 → pulse", () => {
    expect(resolveExecMode({ PTH_AGENT_MODE: "off" })).toBe("pulse");
  });

  it("缺省 → tool-call", () => {
    expect(resolveExecMode({})).toBe("tool-call");
  });

  it("空字符串视为未设置", () => {
    expect(resolveExecMode({ PTH_EXEC_MODE: "" })).toBe("tool-call");
  });

  it("RunnerConfig 携带 execMode/execModeExplicit/pulseMode", () => {
    const c = defaultRunnerConfig({ PTH_EXEC_MODE: "pulse" });
    expect(c.execMode).toBe("pulse");
    expect(c.execModeExplicit).toBe(true);
    expect(c.agentMode).toBe(false);
    expect(c.pulseMode).toBe(true);
    const legacy = defaultRunnerConfig({ PTH_AGENT_MODE: "off" });
    expect(legacy.execMode).toBe("pulse");
    expect(legacy.execModeExplicit).toBe(false);
  });
});
