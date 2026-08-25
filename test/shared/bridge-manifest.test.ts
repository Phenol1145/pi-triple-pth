import { describe, it, expect } from "vitest";
import {
  COMPONENT_TYPES,
  validateComponentManifest,
  validateManifest,
} from "../../packages/pth-console/src/bridge/manifest.js";

describe("validateComponentManifest", () => {
  it("5 类构件类型齐全", () => {
    expect(COMPONENT_TYPES).toEqual([
      "agent-program",
      "scheduler",
      "optimizer",
      "memory-pack",
      "skeleton-update",
    ]);
  });

  // ── agent-program 分支：等价映射 + 旧 agent.json 兼容 ──────────

  it("旧 agent.json（无 type）原样通过，缺省分派为 agent-program", () => {
    const raw = {
      name: "code-reviewer",
      description: "审查 PR",
      model: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      thinking: "medium",
      systemPrompt: "PROMPT.md",
      skills: ["skills/review"],
      tools: ["read", "bash", "grep"],
      excludeTools: ["write"],
      input: { schema: { type: "object", properties: {} } },
      timeoutSec: 300,
    };
    const r = validateComponentManifest(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.type).toBe("agent-program");
      expect(r.manifest.name).toBe("code-reviewer");
      expect(r.manifest.description).toBe("审查 PR");
      expect(r.manifest.systemPrompt).toBe("PROMPT.md");
      expect(r.manifest.skills).toEqual(["skills/review"]);
      expect(r.manifest.tools).toEqual(["read", "bash", "grep"]);
      expect(r.manifest.excludeTools).toEqual(["write"]);
      expect(r.manifest.input?.schema).toBeDefined();
      expect(r.manifest.timeoutSec).toBe(300);
    }
  });

  it("agent-program（type 显式）与原 validateManifest 等价", () => {
    const raw = {
      type: "agent-program",
      name: "hello",
      description: "hi",
      systemPrompt: "PROMPT.md",
      skills: ["skills/a"],
      timeoutSec: 60,
    };
    const r = validateComponentManifest(raw);
    const legacy = validateManifest(raw);
    expect(r.ok).toBe(legacy.ok);
    if (r.ok && legacy.ok) {
      expect(r.manifest.type).toBe("agent-program");
      expect(r.manifest.name).toBe(legacy.manifest.name);
      expect(r.manifest.systemPrompt).toBe(legacy.manifest.systemPrompt);
      expect(r.manifest.skills).toEqual(legacy.manifest.skills);
      expect(r.manifest.timeoutSec).toBe(legacy.manifest.timeoutSec);
    }
  });

  it("agent-program 可携带可选扩展字段（version/payload/targetSlot/legalAuth）", () => {
    const r = validateComponentManifest({
      type: "agent-program",
      name: "hello",
      systemPrompt: "PROMPT.md",
      version: "1.2.0",
      payload: { note: "x" },
      targetSlot: "agent-node",
      legalAuth: "session-trace-123",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.version).toBe("1.2.0");
      expect(r.manifest.targetSlot).toBe("agent-node");
      expect(r.manifest.legalAuth).toBe("session-trace-123");
    }
  });

  // ── 其他类型：最小校验 ──────────────────────────────────────

  it("scheduler 最小合法", () => {
    const r = validateComponentManifest({
      type: "scheduler",
      name: "daily-build",
      description: "每日构建",
      version: "0.1.0",
      payload: { schedule: "0 9 * * *" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.type).toBe("scheduler");
      expect(r.manifest.name).toBe("daily-build");
      expect(r.manifest.payload).toEqual({ schedule: "0 9 * * *" });
    }
  });

  it("optimizer 合法", () => {
    const r = validateComponentManifest({ type: "optimizer", name: "route-opt", payload: { algo: "tsp" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.type).toBe("optimizer");
  });

  it("memory-pack 合法", () => {
    const r = validateComponentManifest({ type: "memory-pack", name: "domain-mem" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.type).toBe("memory-pack");
  });

  it("skeleton-update 合法", () => {
    const r = validateComponentManifest({ type: "skeleton-update", name: "hotfix-3", payload: { change: "add route" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.type).toBe("skeleton-update");
  });

  // ── 非法断言 ───────────────────────────────────────────────

  it("非法 type 被拒", () => {
    const r = validateComponentManifest({ type: "wat", name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("type");
  });

  it("type 非字符串被拒", () => {
    const r = validateComponentManifest({ type: 42, name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("type");
  });

  it("scheduler 缺 name 被拒", () => {
    const r = validateComponentManifest({ type: "scheduler" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("name");
  });

  it("scheduler name 非法（大写）被拒", () => {
    const r = validateComponentManifest({ type: "scheduler", name: "Daily-Build" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("name");
  });

  it("scheduler name 超长被拒", () => {
    const r = validateComponentManifest({ type: "scheduler", name: "a".repeat(64) });
    expect(r.ok).toBe(false);
  });

  it("payload 非对象被拒（骨架校验）", () => {
    const r = validateComponentManifest({ type: "optimizer", name: "x", payload: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("payload");
  });

  it("payload 为数组被拒", () => {
    const r = validateComponentManifest({ type: "scheduler", name: "x", payload: [1, 2] });
    expect(r.ok).toBe(false);
  });

  it("version 非字符串被拒", () => {
    const r = validateComponentManifest({ type: "scheduler", name: "x", version: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("version");
  });

  it("targetSlot 非字符串被拒", () => {
    const r = validateComponentManifest({ type: "scheduler", name: "x", targetSlot: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("targetSlot");
  });

  it("legalAuth 非字符串被拒", () => {
    const r = validateComponentManifest({ type: "memory-pack", name: "x", legalAuth: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("legalAuth");
  });

  it("非对象输入被拒", () => {
    const r = validateComponentManifest("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("JSON 对象");
  });

  it("多个错误同时收集", () => {
    const r = validateComponentManifest({ type: "scheduler", name: "BAD NAME!", payload: "x", version: 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  // ── 穿越防御回归（agent-program 分支沿用原规则） ────────────

  it("systemPrompt 含 .. 被拒", () => {
    const r = validateComponentManifest({ name: "test", systemPrompt: "../etc/passwd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("systemPrompt");
  });

  it("skills 路径含 .. 被拒", () => {
    const r = validateComponentManifest({ name: "test", skills: ["skills/ok", "../bad"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("skills");
  });

  it("tools 含非法字符被拒", () => {
    const r = validateComponentManifest({ name: "test", tools: ["read", "../evil"] });
    expect(r.ok).toBe(false);
  });

  it("timeoutSec 超上限被拒", () => {
    const r = validateComponentManifest({ name: "test", timeoutSec: 99999 });
    expect(r.ok).toBe(false);
  });
});
