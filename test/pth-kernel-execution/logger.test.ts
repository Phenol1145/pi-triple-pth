import { describe, it, expect, vi, afterEach } from "vitest";
import { createKernelLogger, LOG_COMPONENTS, isKnownComponent, type KernelLogger } from "../../src/pth/kernel/logger";

function capture(env: Record<string, string> = {}) {
  const orig = { ...process.env };
  Object.assign(process.env, env);
  const lines: string[] = [];
  const sink = { write: (s: string) => { lines.push(s); } };
  const logger = createKernelLogger({ sink: sink as any, env: process.env });
  return { logger, lines, restore: () => { process.env = orig; } };
}

afterEach(() => {});

describe("KernelLogger 格式", () => {
  it("JSON 默认格式：pino 兼容行（ts/level/component/msg/ctx）", () => {
    const { logger, lines, restore } = capture({ PTH_LOG_FORMAT: "json" });
    logger.info("taskloop", "task completed", { taskId: "t-1", durationMs: 120 });
    restore();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.component).toBe("taskloop");
    expect(parsed.msg).toBe("task completed");
    expect(parsed.taskId).toBe("t-1");
    expect(parsed.durationMs).toBe(120);
    expect(parsed.ts).toBeTruthy();
  });

  it("pretty 格式：人类可读含组件/级别/消息", () => {
    const { logger, lines, restore } = capture({ PTH_LOG_FORMAT: "pretty" });
    logger.warn("resolver", "chain generated", { taskId: "t-2" });
    restore();
    expect(lines[0]).toContain("[resolver]");
    expect(lines[0]).toContain("chain generated");
    expect(lines[0]).toContain("[t-2]");
  });

  it("级别过滤：error 级别只输出 error（warn/info 被滤）", () => {
    const { logger, lines, restore } = capture({ PTH_LOG_LEVEL: "error" });
    logger.info("batch", "should not appear");
    logger.warn("batch", "should not appear");
    logger.error("batch", "should appear");
    restore();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("should appear");
  });

  it("默认级别 info：debug 被滤", () => {
    const { logger, lines, restore } = capture({});
    logger.debug("kernel", "detail");
    logger.info("kernel", "visible");
    restore();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("visible");
  });
});

describe("KernelLogger child 与组件白名单", () => {
  it("child 继承 baseCtx（taskId 自动携带）", () => {
    const { logger, lines, restore } = capture({ PTH_LOG_FORMAT: "json" });
    const taskLogger = logger.child("taskloop", { taskId: "t-9", role: "developer" });
    taskLogger.info("task claimed");
    restore();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.taskId).toBe("t-9");
    expect(parsed.role).toBe("developer");
    expect(parsed.component).toBe("taskloop");
  });

  it("组件白名单：13 类已知组件", () => {
    expect(LOG_COMPONENTS).toContain("gateway");
    expect(LOG_COMPONENTS).toContain("taskloop");
    expect(LOG_COMPONENTS).toContain("pykernel");
    expect(LOG_COMPONENTS.length).toBeGreaterThanOrEqual(13);
  });

  it("isKnownComponent 判定", () => {
    expect(isKnownComponent("taskloop")).toBe(true);
    expect(isKnownComponent("unknown-thing")).toBe(false);
  });
});
