/**
 * agent-loop-tool-face.ts —— 注册表工具面合并段（模块专项：自 agent-loop.ts 抽出）。
 *
 * N14 P2：注册表可见集并入工具面（快照冻结 + 预算守卫 + 下划线别名）。
 * 主循环只依赖 currentTools(aspCurrent) 计算每轮工具面。
 */
import type { ToolRegSpec } from "@away_from/pth-memory";
import { configNumber, registryToolToSchema, visibleRegistryTools, checkToolFaceBudget } from "@away_from/pth-kernel-interpreter";
import { normalizeToolName, toolsForSpace } from "./agent-loop-prompt.js";
import { toolSchemaFor } from "./agent-tools.js";

type AiTool = import("@earendil-works/pi-ai").Tool;

export interface RegistryToolSchema {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

export interface RegistryToolFace {
  registryByName: Map<string, ToolRegSpec>;
  registrySchemas: RegistryToolSchema[];
  currentTools(aspCurrent: string): AiTool[];
}

export interface AgentLoopToolFaceInput {
  role?: import("./worker-cluster.js").WorkerRole;
  toolRegistry?: import("@away_from/pth-kernel-interpreter").ToolRegSnapshot;
  toolAllowlist?: readonly string[];
  extraTools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }>;
  logger?: (msg: string) => void;
  asp: boolean;
}

/** 构建注册表可见集 + 每轮 currentTools（含静态面、注册面、extraTools、allowlist/pause 固定工具）。 */
export function buildRegistryToolFace(
  input: AgentLoopToolFaceInput,
  staticTools: AiTool[],
  allowlist: Set<string> | undefined,
): RegistryToolFace {
  const registryByName = new Map<string, ToolRegSpec>();
  const registrySchemas: RegistryToolSchema[] = [];
  if (input.toolRegistry && input.role?.id) {
    const visible = visibleRegistryTools(input.toolRegistry, input.role.id);
    const budget = configNumber("PTH_TOOL_FACE_BUDGET", 24);
    const { allowed, dropped } = checkToolFaceBudget(staticTools.length, visible, budget);
    if (dropped.length > 0) {
      input.logger?.(`[tool-reg] 工具面预算守卫（≤${budget}）：注册工具裁减 ${dropped.join("/")}——走合并/退役提案（N14 §3.3）`);
    }
    const staticNames = new Set(staticTools.map((t) => t.name));
    for (const spec of allowed) {
      const schema = registryToolToSchema(spec);
      if (staticNames.has(schema.name)) continue;
      registryByName.set(spec.name, spec);   // 键 = 点形真相源名（executeStep 归一 下划线→点 后查表）
      // 下划线命名可达性别名（调用面名归一后下划线名否则不可达；名称序先到先得不覆盖——确定性）
      const dotAlias = spec.name.replace(/_/g, ".");
      if (dotAlias !== spec.name && !registryByName.has(dotAlias)) registryByName.set(dotAlias, spec);
      registrySchemas.push(schema);
    }
    if (registrySchemas.length > 0) {
      input.logger?.(`[tool-reg] 快照 ${input.toolRegistry.version}：注册工具面 +${registrySchemas.length}（${registrySchemas.map((s) => s.name).join("/")}）`);
    }
  }

  /** 当前轮 LLM 调用实际工具面 */
  function currentTools(aspCurrent: string): AiTool[] {
    const base = input.asp
      ? toolsForSpace(aspCurrent, input.role?.actionTools)
      : [...staticTools];
    // 同名工具去重（OpenAI 对重复工具名 400）；N14 P2：注册表可见集并入（空间无关）
    const all = [...new Map([...base, ...registrySchemas].map((t) => [t.name, t])).values()];
    // TCE P5：Tool 层生成器产物（per-tool 工具面——manifest 策展）
    for (const extra of input.extraTools ?? []) {
      if (!all.some((t) => t.name === extra.name)) {
        all.push({ name: extra.name, description: extra.description, parameters: extra.parameters });
      }
    }
    // N28 T6：非 ASP 面不含 done（仅 ASP meta 面有）——冻结 union 恒含 pinned done，schema 需同步暴露。
    if (allowlist?.has("done") && !all.some((t) => normalizeToolName(t.name) === "done")) {
      const done = toolSchemaFor("done");
      if (done) all.push(done);
    }
    // 生命周期 P1：pause 同 done 一样是固定循环控制工具——冻结 union 恒含，schema 需同步暴露。
    if (allowlist?.has("pause") && !all.some((t) => normalizeToolName(t.name) === "pause")) {
      const pause = toolSchemaFor("pause");
      if (pause) all.push(pause);
    }
    // N28 T6：schema 暴露与执行授权同源——冻结 union ∩ 当前 space face。
    return allowlist ? all.filter((t) => allowlist.has(normalizeToolName(t.name))) : all;
  }

  return { registryByName, registrySchemas, currentTools };
}
