import { describe, it, expect } from "vitest";
import { validateManifest } from "../../src/ptl/bridge/manifest.js";

describe("validateManifest", () => {
  it("完整合法 manifest", () => {
    const raw = {
      name: "code-reviewer",
      description: "审查 PR",
      model: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      thinking: "medium",
      systemPrompt: "PROMPT.md",
      skills: ["skills/review", "skills/test"],
      tools: ["read", "bash", "grep"],
      excludeTools: ["write", "edit"],
      input: { schema: { type: "object", properties: {} } },
      timeoutSec: 300,
    };
    const r = validateManifest(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("code-reviewer");
      expect(r.manifest.systemPrompt).toBe("PROMPT.md");
      expect(r.manifest.skills).toEqual(["skills/review", "skills/test"]);
      expect(r.manifest.tools).toEqual(["read", "bash", "grep"]);
      expect(r.manifest.timeoutSec).toBe(300);
    }
  });

  it("最小合法 manifest（只有 name）", () => {
    const r = validateManifest({ name: "hello" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("hello");
      expect(r.manifest.systemPrompt).toBeUndefined();
    }
  });

  it("name 非法（为空）", () => {
    const r = validateManifest({ name: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toContain("name");
    }
  });

  it("name 非法（大写字母）", () => {
    const r = validateManifest({ name: "Code-Reviewer" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain("name");
    }
  });

  it("name 非法（超长 64 字符）", () => {
    const r = validateManifest({ name: "a".repeat(64) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain("name");
    }
  });

  it("name 合法：单字符", () => {
    const r = validateManifest({ name: "x" });
    expect(r.ok).toBe(true);
  });

  it("name 合法：末位连字符", () => {
    const r = validateManifest({ name: "abc-" });
    expect(r.ok).toBe(true); // 正则允许末尾连字符
  });

  it("systemPrompt 含 .. 被拒绝", () => {
    const r = validateManifest({ name: "test", systemPrompt: "../etc/passwd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("systemPrompt");
  });

  it("skills 路径含 .. 被拒绝", () => {
    const r = validateManifest({ name: "test", skills: ["skills/ok", "../bad"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("skills");
  });

  it("tools 含空字符串被拒绝", () => {
    const r = validateManifest({ name: "test", tools: ["read", ""] });
    // '' 不匹配 TOOL_RE，校验拒绝
    expect(r.ok).toBe(false);
  });

  it("timeoutSec 超上限", () => {
    const r = validateManifest({ name: "test", timeoutSec: 3601 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("timeoutSec");
  });

  it("timeoutSec 为 0 被拒绝", () => {
    const r = validateManifest({ name: "test", timeoutSec: 0 });
    expect(r.ok).toBe(false);
  });

  it("timeoutSec 默认（不提供）OK", () => {
    const r = validateManifest({ name: "test" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.timeoutSec).toBeUndefined();
  });

  it("非对象输入", () => {
    const r = validateManifest("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("JSON 对象");
  });

  it("多个错误同时收集", () => {
    const r = validateManifest({
      name: "BAD NAME!",
      systemPrompt: "../etc",
      tools: "not array",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("description 为数字被拒绝", () => {
    const r = validateManifest({ name: "test", description: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("description");
  });
});
