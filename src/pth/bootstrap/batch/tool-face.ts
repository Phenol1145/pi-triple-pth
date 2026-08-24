/**
 * bootstrap/batch/tool-face.ts —— P2-9 装配段：工具面（TCE P3/P5）。
 *
 * 先加载 tool manifest（per-tool schema/argvTemplate；缺失放行空），再装配 worker 侧
 * CommandGateway（语言工具授权 + per-tool 翻译；失败降级 legacy 直执行）。
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { knownRoleById } from "@away_from/pth-kernel-execution";
import { pthConfig } from "@away_from/pth-config";
import { isStrictExecutionEnv, type BuiltPthHost } from "../pth-host.js";
import type { BatchLogger, BatchPool } from "./context.js";

export interface ToolFaceAssembly {
  /** TCE P5：per-tool 工具面（manifest 策展）；manifest 未就绪时 undefined（保持既有静态面）。 */
  extraTools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> | undefined;
  /** TCE P3：worker 侧 CommandGateway；装配失败降级 undefined（legacy 直执行）。 */
  commandGateway: import("@away_from/pth-kernel-execution").CommandGateway | undefined;
}

export async function assembleToolFace(input: {
  host: BuiltPthHost;
  pool: BatchPool;
  batchLogger: BatchLogger;
}): Promise<ToolFaceAssembly> {
  const { host, pool, batchLogger } = input;
  // TCE P5：先加载 tool manifest（per-tool schema/argvTemplate；缺失放行空）
  let manifestTools: import("../../tools/index.js").ToolDefinition[] = [];
  const toolDomain = new Map<string, string>();
  let extraTools: ToolFaceAssembly["extraTools"];
  try {
    const { validateToolManifest, buildToolLayerFromManifest } = await import("../../tools/index.js");
    const manifestPath = resolvePath(pthConfig().str("PTH_TOOL_TOOLS_DIR") || "deploy/tool-containers", "tool-manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    const manifest = validateToolManifest(raw);
    manifestTools = Object.values(manifest.domains).flatMap((d) => d.tools);
    for (const [domain, d] of Object.entries(manifest.domains)) {
      for (const t of d.tools) toolDomain.set(t.name, domain);
    }
    extraTools = buildToolLayerFromManifest(manifest);
  } catch { /* manifest 未就绪/不可解析——工具面保持既有静态面 */ }

  // TCE P3/P5：worker 侧 CommandGateway（语言工具授权 + per-tool 翻译；失败降级 legacy 直执行）
  let commandGateway: import("@away_from/pth-kernel-execution").CommandGateway | undefined;
  try {
    const { buildExecutionTargetRegistry, CommandGatewayImpl, createHumanApprovalGateway } = await import("../../execution/index.js");
    const { createToolTranslator } = await import("../../tools/index.js");
    const built = buildExecutionTargetRegistry({ backendRegistry: host.backends, strict: isStrictExecutionEnv() });
    const { PgHumanInteractionService, PgHumanInteractionRepository } = await import("../../interaction/index.js");
    const humanService = new PgHumanInteractionService(new PgHumanInteractionRepository(pool));
    commandGateway = new CommandGatewayImpl({
      targetRegistry: built.registry,
      roleCapabilities: (roleId) => knownRoleById(roleId)?.capabilities,
      humanApprovalGateway: createHumanApprovalGateway(humanService),
      toolTranslator: createToolTranslator({
        tools: manifestTools,
        resolveTarget: (toolName) => {
          const domain = toolDomain.get(toolName);
          if (!domain) return undefined;
          const backendId = `tools-${domain}`;
          return host.backends.get(backendId) !== undefined ? backendId : undefined;
        },
      }),
    });
  } catch (e) {
    batchLogger.warn(`[command-gateway] 装配失败（放行 legacy）: ${(e as Error).message}`);
  }
  return { extraTools, commandGateway };
}
