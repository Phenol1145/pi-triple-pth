import { describe, expect, it } from "vitest";
import { buildToolLayerFromManifest, buildArgvFromTemplate } from "../../src/pth/tools/tool-layer-generator.js";
import type { ToolManifestFile } from "../../src/pth/tools/tool-manifest.js";

const manifest: ToolManifestFile = {
  schemaVersion: 1,
  generatedAt: "2026-08-22T00:00:00.000Z",
  domains: {
    compiled: {
      image: "example/tools",
      network: "internal",
      engineVisible: true,
      tools: [
        {
          name: "bf",
          engineVisible: true,
          hostOnly: false,
          modes: ["sync"],
          argsSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
          argvTemplate: ["bf", "{{code}}"],
        },
        {
          name: "secret-tool",
          engineVisible: false,
          hostOnly: true,
          modes: ["sync"],
        },
        {
          name: "legacy",
          engineVisible: true,
          hostOnly: false,
          modes: ["sync"],
          argv: ["legacy"],
        },
      ],
    },
  },
};

describe("tool-layer-generator TCE P5", () => {
  it("只暴露 engineVisible && !hostOnly && 有 argsSchema 的工具", () => {
    const tools = buildToolLayerFromManifest(manifest);
    expect(tools.map((t) => t.name)).toEqual(["bf"]);
    expect(tools[0]!.parameters).toMatchObject({ type: "object" });
  });

  it("buildArgvFromTemplate：槽位填充 + required 校验", () => {
    const tool = manifest.domains.compiled!.tools[0]!;
    expect(buildArgvFromTemplate(tool, { code: "++++" })).toEqual(["bf", "++++"]);
    expect(() => buildArgvFromTemplate(tool, {})).toThrow(/missing required arg code/);
  });

  it("无 argvTemplate 时退回 tool.argv", () => {
    const legacy = manifest.domains.compiled!.tools[2]!;
    expect(buildArgvFromTemplate(legacy, {})).toEqual(["legacy"]);
  });
});
