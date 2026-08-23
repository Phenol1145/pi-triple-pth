/**
 * tools/tool-layer-generator.ts —— TCE P5 Tool 层生成器。
 *
 * 从 tool-manifest 生成 LLM 工具定义（只暴露 engineVisible && !hostOnly 的 per-tool schema），
 * 并提供 argvTemplate 槽位填充（严格 per-tool schema——禁止通用 argv 透传）。
 */
import type { ToolDefinition, ToolManifestFile } from "./tool-manifest.js";

export interface GeneratedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** manifest → LLM 工具面（仅 per-tool schema 工具；legacy 无 argsSchema 暂不暴露）。 */
export function buildToolLayerFromManifest(manifest: ToolManifestFile): GeneratedTool[] {
  const out: GeneratedTool[] = [];
  for (const domain of Object.values(manifest.domains)) {
    for (const tool of domain.tools) {
      if (tool.hostOnly || !tool.engineVisible) continue;
      if (!tool.argsSchema) continue;
      out.push({
        name: tool.name.replace(/\./g, "_"),
        description: tool.description ?? tool.name,
        parameters: tool.argsSchema as Record<string, unknown>,
      });
    }
  }
  return out;
}

/** 按 argvTemplate 填充 argv；缺省退回 tool.argv。 */
export function buildArgvFromTemplate(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): string[] {
  const template = tool.argvTemplate;
  if (!template) return [...(tool.argv ?? [tool.name])];
  const schema = (tool.argsSchema ?? {}) as { required?: unknown; properties?: Record<string, unknown> };
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      throw new Error(`tool ${tool.name}: missing required arg ${key}`);
    }
  }
  return template.map((part) =>
    part.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => String(args[key] ?? "")),
  );
}
