/**
 * tasking/mcp-decompose.ts —— N17 D1：MCP 工具包（已拆解重实现源码 + JSON schema）
 * → 校验/生成 ToolRegSpec → tool-proposal draft 批量落库。
 *
 * 依据：docs/pth/design/n17-lane-a5-d1-design.md §2（D1 MCP 拆解入 tool-reg）。
 * 原则（§2.1）：不做运行时 MCP 转接器；输入 = mcp-tool-bundle-v1 JSON bundle；
 * 输出 = 逐工具 tool-proposal draft（复用 N14 治理流——不直写 official）。
 *
 * 本模块只依赖结构型窄口（ToolRegGovernanceStore）与 pth-memory 纯校验，
 * import/require 静态拒绝复用 ts 核 preflight 同源 stripNonCode（字符串/注释不误拒）。
 */

import {
  TOOL_REG_NAME_RE,
  proposeToolRegistration,
  validateToolRegSpec,
  type ToolRegGovernanceStore,
  type ToolRegSpec,
} from "@away_from/pth-memory";
import { stripNonCode } from "./ptc/surface.js";

export const MCP_BUNDLE_FORMAT = "mcp-tool-bundle-v1";

export interface McpBundleTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  source: string;
  call: string;
  anchor?: string;
  whenToUse?: string;
  effect?: string;
  roles?: string[];
  pack?: string;
}

export interface McpToolBundle {
  format: string;
  server: string;
  tools: McpBundleTool[];
}

export type McpBundleParseResult =
  | { ok: true; bundle: McpToolBundle }
  | { ok: false; errors: string[] };

export type McpToolSpecResult =
  | { ok: true; spec: ToolRegSpec }
  | { ok: false; error: string };

export interface McpImportResult {
  imported: { name: string; proposalId: string }[];
  failed: { name: string; error: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** 三要素缺省派生：description 首句（≤80 字符），无则回落指定文案 */
function firstSentence(description: string): string {
  const text = description.trim();
  if (!text) return "";
  const match = text.match(/^.*?(?:[。．.!！?？]|\n|$)/);
  const sentence = match?.[0] ?? text;
  return sentence.slice(0, 80).trim();
}

/**
 * import/require 静态拒绝（§2.3）：先用 stripNonCode 剥离字符串/注释/模板文本/正则，
 * 再在剩余真实代码层匹配 `import` / `require` 关键字——与 ts-interpreter preflight 同源，
 * 字符串/注释中的文本不误拒。
 */
function containsCodeImportOrRequire(source: string): boolean {
  const stripped = stripNonCode(source);
  return /\b(?:import|require)\b/.test(stripped);
}

function toolErrorPrefix(index: number): string {
  return `tools[${index}]`;
}

/**
 * Bundle 校验（错误全量收集）：
 * format / server / tools 非空数组 / 逐条 name / source / call / inputSchema / roles / pack。
 * 注意：parse 只做格式校验；name 匹配 TOOL_REG_NAME_RE，与 tool-reg 同源。
 */
export function parseMcpBundle(raw: unknown): McpBundleParseResult {
  if (!isRecord(raw)) {
    return { ok: false, errors: ["bundle 必须是对象"] };
  }
  const errors: string[] = [];

  if (raw.format !== MCP_BUNDLE_FORMAT) {
    errors.push(`format 应为 "${MCP_BUNDLE_FORMAT}"（收到 ${JSON.stringify(raw.format)}）`);
  }

  const server = raw.server;
  if (!nonEmptyString(server)) {
    errors.push("server 必填且非空");
  } else if (!TOOL_REG_NAME_RE.test(server)) {
    errors.push(`server 非法（应匹配 ${TOOL_REG_NAME_RE}，≤64，[a-z0-9][a-z0-9._-]*）`);
  }

  const tools = raw.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push("tools 必须为非空数组");
  } else {
    tools.forEach((t, i) => {
      const prefix = toolErrorPrefix(i);
      if (!isRecord(t)) {
        errors.push(`${prefix} 必须是对象`);
        return;
      }

      const name = t.name;
      if (!nonEmptyString(name)) {
        errors.push(`${prefix}.name 必填且非空`);
      } else if (!TOOL_REG_NAME_RE.test(name)) {
        errors.push(`${prefix}.name 非法（应匹配 ${TOOL_REG_NAME_RE}）`);
      }

      const source = t.source;
      if (!nonEmptyString(source)) {
        errors.push(`${prefix}.source 必填且非空`);
      } else if (containsCodeImportOrRequire(source)) {
        errors.push(`${prefix}.source 含真实代码层 import/require（字符串/注释不误拒——拆解源码须无外部依赖）`);
      }

      if (!nonEmptyString(t.call)) {
        errors.push(`${prefix}.call 必填且非空`);
      }

      const inputSchema = t.inputSchema;
      if (inputSchema !== undefined) {
        if (!isRecord(inputSchema)) {
          errors.push(`${prefix}.inputSchema 必须为对象`);
        } else {
          if (inputSchema.type !== "object") {
            errors.push(`${prefix}.inputSchema.type 必须为 "object"`);
          }
          const props = inputSchema.properties;
          if (!isRecord(props)) {
            errors.push(`${prefix}.inputSchema.properties 必须为对象`);
          }
          const required = inputSchema.required;
          if (required !== undefined) {
            if (!Array.isArray(required)) {
              errors.push(`${prefix}.inputSchema.required 必须为数组`);
            } else {
              required.forEach((r, j) => {
                if (!nonEmptyString(r)) {
                  errors.push(`${prefix}.inputSchema.required[${j}] 必须为非空字符串`);
                } else if (isRecord(props) && !(r in props)) {
                  errors.push(`${prefix}.inputSchema.required[${j}] "${r}" 不在 properties 中（schema 非法）`);
                }
              });
            }
          }
        }
      }

      const roles = t.roles;
      if (roles !== undefined) {
        if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => nonEmptyString(r))) {
          errors.push(`${prefix}.roles 若提供必须为非空字符串数组`);
        }
      }

      if (t.pack !== undefined && !nonEmptyString(t.pack)) {
        errors.push(`${prefix}.pack 若提供必须为非空字符串`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    bundle: {
      format: raw.format as string,
      server: server as string,
      tools: tools as McpBundleTool[],
    },
  };
}

/** 工具 → ToolRegSpec（version 1 + program 执行体 + promotedFrom 链 + 三要素缺省派生） */
export function mcpToolToSpec(tool: McpBundleTool, server: string): McpToolSpecResult {
  const name = tool.name;
  if (!nonEmptyString(name)) return { ok: false, error: "tool.name 必填且非空" };
  if (!TOOL_REG_NAME_RE.test(name)) return { ok: false, error: `tool.name 非法: ${name}` };
  if (!nonEmptyString(tool.source)) return { ok: false, error: "tool.source 必填且非空" };
  if (!nonEmptyString(tool.call)) return { ok: false, error: "tool.call 必填且非空" };

  const sentence = firstSentence(nonEmptyString(tool.description) ? tool.description : "");

  const anchor = nonEmptyString(tool.anchor) ? tool.anchor.trim() : `${server}/${name}——${sentence || "MCP 拆解工具"}`;
  const whenToUse = nonEmptyString(tool.whenToUse) ? tool.whenToUse.trim() : sentence || "需要调用该 MCP 工具能力时";
  const effect = nonEmptyString(tool.effect) ? tool.effect.trim() : `返回 ${name} 的工具调用结果（program 态——ts 核执行）`;

  let properties: Record<string, unknown> = {};
  let required: string[] = [];
  if (isRecord(tool.inputSchema)) {
    if (isRecord(tool.inputSchema.properties)) {
      properties = tool.inputSchema.properties as Record<string, unknown>;
    }
    if (Array.isArray(tool.inputSchema.required)) {
      required = tool.inputSchema.required as string[];
    }
  }

  const spec: ToolRegSpec = {
    name,
    version: 1,
    description: { anchor, whenToUse, effect },
    parameters: { type: "object", properties, required },
    executor: { type: "program", source: `${tool.source}\nreturn ${tool.call};` },
    visibility: {
      roles: Array.isArray(tool.roles) && tool.roles.length > 0 ? tool.roles : ["developer", "coder"],
      pack: nonEmptyString(tool.pack) ? tool.pack : `mcp-${server}`,
    },
    promotedFrom: `mcp:${server}/${name}`,
  };
  return { ok: true, spec };
}

/**
 * 批量导入：每条 tool → mcpToolToSpec → validateToolRegSpec → proposeToolRegistration
 * 落 draft tool-proposal。失败（重名/校验）记 failed 不中断批量；永不直写 official。
 */
export async function importMcpTools(store: ToolRegGovernanceStore, bundle: McpToolBundle): Promise<McpImportResult> {
  const imported: McpImportResult["imported"] = [];
  const failed: McpImportResult["failed"] = [];
  const seen = new Set<string>();

  for (const tool of bundle.tools) {
    const name = tool.name;
    if (!nonEmptyString(name)) {
      failed.push({ name: String(name ?? ""), error: "tool.name 缺失" });
      continue;
    }
    if (seen.has(name)) {
      failed.push({ name, error: `tool 名重复: ${name}（同 bundle 内第二条）` });
      continue;
    }
    seen.add(name);

    const converted = mcpToolToSpec(tool, bundle.server);
    if (!converted.ok) {
      failed.push({ name, error: converted.error });
      continue;
    }

    const checked = validateToolRegSpec(converted.spec);
    if (!checked.ok) {
      failed.push({ name, error: `提案 spec 非法：${checked.error}` });
      continue;
    }

    const proposed = await proposeToolRegistration(store, {
      action: "register",
      name,
      spec: checked.spec,
      rationale: "MCP 拆解重实现导入",
    });
    if (proposed.ok && proposed.id) {
      imported.push({ name, proposalId: proposed.id });
    } else {
      failed.push({ name, error: proposed.error ?? "proposeToolRegistration 失败" });
    }
  }

  return { imported, failed };
}
