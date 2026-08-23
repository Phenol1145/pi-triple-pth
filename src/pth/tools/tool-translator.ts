/**
 * tools/tool-translator.ts —— TCE P5 Command 层 tool translator 工厂。
 *
 * 把 per-tool 工具调用（tool.<name>）翻译为 Execute 层 external 命令：
 * argv 由 argvTemplate 槽位填充，target 由调用方解析（tool-container backend id）。
 */
import { randomUUID } from "node:crypto";
import type { CommandSecurityContext, ExecutionCommand, ToolCall } from "@away_from/pth-kernel-execution";
import type { ToolDefinition } from "./tool-manifest.js";
import { buildArgvFromTemplate } from "./tool-layer-generator.js";

export interface ToolTranslatorDeps {
  tools: readonly ToolDefinition[];
  /** tool name → tool-container target id（如 tools-compiled / tools-network） */
  resolveTarget: (toolName: string) => string | undefined;
  createId?: () => string;
}

export function createToolTranslator(deps: ToolTranslatorDeps) {
  const byName = new Map(deps.tools.map((t) => [t.name, t]));
  const createId = deps.createId ?? (() => `cmd-${randomUUID()}`);
  return async (
    toolCall: ToolCall,
    ctx: CommandSecurityContext,
  ): Promise<Extract<ExecutionCommand, { kind: "external" }> | null> => {
    const raw = toolCall.tool.replace(/^tool\./, "").replace(/_/g, ".");
    const def = byName.get(raw);
    if (!def || !def.argvTemplate || !def.argsSchema) return null;
    const target = deps.resolveTarget(def.name);
    if (!target) return null;
    const argv = buildArgvFromTemplate(def, toolCall.args);
    return {
      id: createId(),
      tool: `tool.${def.name}`,
      scope: ctx.taskId ? "task" : "notebook",
      kind: "external",
      argv,
      target,
      security: ctx,
    };
  };
}
