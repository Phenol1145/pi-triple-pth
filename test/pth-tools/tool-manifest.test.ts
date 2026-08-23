import { describe, expect, it } from "vitest";
import { validateToolManifest, ToolManifestError } from "../../src/pth/tools/tool-manifest.js";

function baseManifest(tools: unknown[]): unknown {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-22T00:00:00.000Z",
    domains: {
      compiled: {
        image: "example/tools",
        network: "internal",
        engineVisible: true,
        tools,
      },
    },
  };
}

describe("tool-manifest TCE P5：argsSchema/argvTemplate fail-closed", () => {
  it("合法 per-tool schema + argvTemplate 通过", () => {
    const m = validateToolManifest(baseManifest([{
      name: "bf",
      argv: ["bf"],
      engineVisible: true,
      hostOnly: false,
      modes: ["sync"],
      argsSchema: { type: "object", properties: { code: { type: "string" } } },
      argvTemplate: ["bf", "{{code}}"],
    }]));
    expect(m.domains.compiled!.tools[0]!.argsSchema).toBeDefined();
    expect(m.domains.compiled!.tools[0]!.argvTemplate).toEqual(["bf", "{{code}}"]);
  });

  it("argvTemplate 槽位不在 argsSchema.properties → 拒绝", () => {
    expect(() => validateToolManifest(baseManifest([{
      name: "bf",
      argv: ["bf"],
      engineVisible: true,
      hostOnly: false,
      modes: ["sync"],
      argsSchema: { type: "object", properties: { code: { type: "string" } } },
      argvTemplate: ["bf", "{{program}}"],
    }]))).toThrow(ToolManifestError);
  });

  it("argvTemplate 无 argsSchema → 拒绝", () => {
    expect(() => validateToolManifest(baseManifest([{
      name: "bf",
      argv: ["bf"],
      engineVisible: true,
      hostOnly: false,
      modes: ["sync"],
      argvTemplate: ["bf"],
    }]))).toThrow(/argvTemplate requires argsSchema/);
  });

  it("hostOnly=true 且 engineVisible=true → 拒绝（不进入工具面）", () => {
    expect(() => validateToolManifest(baseManifest([{
      name: "secret-tool",
      argv: ["secret-tool"],
      engineVisible: true,
      hostOnly: true,
      modes: ["sync"],
    }]))).toThrow(/hostOnly/);
  });
});
