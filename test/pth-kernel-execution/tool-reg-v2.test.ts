import { describe, it, expect } from "vitest";
import {
  buildToolRegContent,
  parseToolRegContent,
  toToolRegV2Spec,
  toolRegDefaultCommand,
  validateToolRegSpec,
  type ToolRegSpec,
} from "@away_from/pth-memory";

function oldBuiltinSpec(): ToolRegSpec {
  return {
    name: "dev.read",
    version: 1,
    description: { anchor: "a", whenToUse: "w", effect: "e" },
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    executor: { type: "builtin", ref: "dev_read" },
    visibility: { roles: ["coder"], pack: "dev" },
  };
}

describe("Tool-Reg v2 迁移", () => {
  it("旧 builtin spec 自动生成 command: builtin:<ref>", () => {
    const spec = oldBuiltinSpec();
    expect(toolRegDefaultCommand(spec)).toBe("builtin:dev_read");
    const v2 = toToolRegV2Spec(spec);
    expect(v2.command).toBe("builtin:dev_read");
  });

  it("program/agent 默认 command", () => {
    const p = toToolRegV2Spec({
      ...oldBuiltinSpec(),
      executor: { type: "program", source: "return 1;" },
    });
    expect(p.command).toBe("program:dev.read");
    const a = toToolRegV2Spec({
      ...oldBuiltinSpec(),
      executor: { type: "agent", role: "executor" },
    });
    expect(a.command).toBe("agent:executor");
  });

  it("已有 command 不覆盖", () => {
    const v2 = toToolRegV2Spec({ ...oldBuiltinSpec(), command: "custom:adapter" });
    expect(v2.command).toBe("custom:adapter");
  });

  it("v2 spec 通过校验且 content 含 command/returns", () => {
    const spec: ToolRegSpec = {
      ...oldBuiltinSpec(),
      command: "builtin:dev_read",
      returns: { schema: { type: "object" }, description: "读取结果" },
    };
    const checked = validateToolRegSpec(spec);
    expect(checked.ok).toBe(true);
    const content = buildToolRegContent(spec);
    expect(content).toContain("command：builtin:dev_read");
    expect(content).toContain("returns");
    const parsed = parseToolRegContent(content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.command).toBe("builtin:dev_read");
  });
});
