import { describe, it, expect } from "vitest";
import { parseAgentAction, isKnownTool } from "../../src/pth/kernel/execution/parse-agent-action.js";

describe("parseAgentAction（LLM 输出 → 动作解析）", () => {
  it("纯 JSON 动作", () => {
    const r = parseAgentAction('{"thought":"先算","action":{"tool":"python.run","args":{"code":"_result = 1"}}}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action.tool).toBe("python.run");
      expect(r.action.args.code).toBe("_result = 1");
      expect(r.action.thought).toBe("先算");
    }
  });

  it("剥离 markdown 围栏", () => {
    const r = parseAgentAction('```json\n{"action":{"tool":"done","args":{"result":{"x":1},"summary":"ok"}}}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action.tool).toBe("done");
  });

  it("容忍多余文字（提取首个 JSON 对象）", () => {
    const r = parseAgentAction('让我想想。\n{"action":{"tool":"bash.run","args":{"command":"echo hi"}}}\n好的就这样。');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action.tool).toBe("bash.run");
  });

  it("无 action 字段 → 解析失败", () => {
    const r = parseAgentAction('{"thought":"只是想"}');
    expect(r.ok).toBe(false);
  });

  it("非 JSON → 解析失败", () => {
    const r = parseAgentAction("我无法执行这个任务，需要人工介入。");
    expect(r.ok).toBe(false);
  });

  it("args 缺失 → 解析失败", () => {
    const r = parseAgentAction('{"action":{"tool":"python.run"}}');
    expect(r.ok).toBe(false);
  });
});

describe("isKnownTool（白名单校验）", () => {
  it("已知工具（元工具收敛后）", () => {
    expect(isKnownTool("ts.run")).toBe(true);
    expect(isKnownTool("ts.eval")).toBe(true);
    expect(isKnownTool("python.run")).toBe(true);
    expect(isKnownTool("bash.run")).toBe(true);
    expect(isKnownTool("done")).toBe(true);
    // 能力函数已收敛进 ts 程序——但作为动作输出时自动降级（isKnownTool 放行）
    expect(isKnownTool("memory.write")).toBe(true);
    expect(isKnownTool("llm.complete")).toBe(true);
  });
  it("未知工具", () => {
    expect(isKnownTool("rm -rf /")).toBe(false);
    expect(isKnownTool("system.exec")).toBe(false);
    expect(isKnownTool("")).toBe(false);
  });
});
