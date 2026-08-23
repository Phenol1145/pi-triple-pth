import { describe, expect, it } from "vitest";
import { createToolTranslator } from "../../src/pth/tools/tool-translator.js";
import type { ToolDefinition } from "../../src/pth/tools/tool-manifest.js";

const bf: ToolDefinition = {
  name: "bf",
  engineVisible: true,
  hostOnly: false,
  modes: ["sync"],
  argsSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  argvTemplate: ["bf", "{{code}}"],
};

const ctx = { principalId: "worker:developer", tenantId: "t", roleId: "developer", taskId: "task-1" };

describe("tool-translator TCE P5", () => {
  it("tool.<name> → external command（argv 槽位填充 + target）", async () => {
    const translate = createToolTranslator({
      tools: [bf],
      resolveTarget: () => "tools-compiled",
      createId: () => "cmd-1",
    });
    const cmd = await translate({ tool: "tool.bf", args: { code: "++" } }, ctx);
    expect(cmd).not.toBeNull();
    expect(cmd!.kind).toBe("external");
    if (cmd && cmd.kind === "external") {
      expect(cmd.argv).toEqual(["bf", "++"]);
      expect(cmd.target).toBe("tools-compiled");
      expect(cmd.tool).toBe("tool.bf");
    }
  });

  it("未知工具返回 null（交给 internal 降级）", async () => {
    const translate = createToolTranslator({ tools: [bf], resolveTarget: () => "tools-compiled" });
    expect(await translate({ tool: "tool.unknown", args: {} }, ctx)).toBeNull();
  });

  it("target 解析失败返回 null", async () => {
    const translate = createToolTranslator({ tools: [bf], resolveTarget: () => undefined });
    expect(await translate({ tool: "tool.bf", args: { code: "++" } }, ctx)).toBeNull();
  });
});
