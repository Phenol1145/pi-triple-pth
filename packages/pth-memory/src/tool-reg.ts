/**
 * tool-reg.ts —— 工具注册条目（tool-reg）格式与校验（2026-08-18 N14 P0）。
 *
 * 依据：docs/pth/n14-sensor-controller-four-dims.md §3（一等工具注册通道——契约先行，
 * W8 P3 穿透同款模式）。设计裁决：A2 开通道 / Q2 执行体三态（program+builtin+agent）/
 * Q3 skill 同构治理 / Q4 存量一次性全登记。
 *
 * 条目形态：
 *   kind = "tool-reg"（prompt 层系统资产——worker 只读，防伪造注册；memory-policy 增补）；
 *   id   = tool:<name>；条目不可变——修订 = 新版本（version+1，promotedFrom 链留痕，B4-1 同款）；
 *   机读单一真相源 = `__tool_spec__` JSON 行（穿透 `__penetration_edge__` 同款——
 *   人类可读面 + 机器校验一行）。
 *
 * 本模块只做格式/校验纯逻辑（不 import PTH core——pth-memory 包边界）；
 * 存量登记器（TOOL_SCHEMAS → builtin 条目 seed）在 core 侧 src/pth/tasking/tool-reg-builtin.ts。
 */

export const TOOL_REG_KIND = "tool-reg";
export const TOOL_REG_ID_PREFIX = "tool:";
export const TOOL_REG_FORMAT = "tool-reg-v1";
export const TOOL_SPEC_MARKER = "__tool_spec__";

/** 工具名约束（点形/下划线形均可——builtin 条目用 TOOL_SCHEMAS 点形真相源名） */
export const TOOL_REG_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 执行体三态（用户裁决 Q2——2026-08-18） */
export type ToolRegExecutor =
  | { type: "program"; source: string }              // 固化 ts 程序（ts 核执行——JIT 沉淀物晋升主路径）
  | { type: "builtin"; ref: string }                 // 代码内置（ref = 执行器键 / asp-inline:<name> / agent-loop:done）
  | { type: "agent"; role: string; input?: string; output?: string };  // LLM 子 agent（role + 输入/产物契约）

export interface ToolRegSpec {
  name: string;
  /** 版本起点 1；修订 = 新版本（不可变语义） */
  version: number;
  description: { anchor: string; whenToUse: string; effect: string };
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  executor: ToolRegExecutor;
  /** 可见性投放（0.17.3 命题 3 防线——默认窄投放，不全局广播） */
  visibility: { roles: string[]; pack: string };
  /** 晋升链留痕（如 tool-function:<name> / skill:penetrate:<child>） */
  promotedFrom?: string;
}

export type ToolRegParseResult =
  | { ok: true; id: string; spec: ToolRegSpec; content: string }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 注册校验（穿透校验同款——§7-1：schema 非法/执行体缺字段/visibility 空 → 调用即拒绝）。
 * 只校验 spec 机读面；文本一致性由 validateToolRegContent 追加。
 */
export function validateToolRegSpec(spec: unknown): { ok: true; spec: ToolRegSpec } | { ok: false; error: string } {
  if (!isRecord(spec)) return { ok: false, error: "tool-reg: spec 必须是对象" };
  if (!nonEmpty(spec.name) || !TOOL_REG_NAME_RE.test(spec.name)) {
    return { ok: false, error: `tool-reg: name 非法（应匹配 ${TOOL_REG_NAME_RE}）` };
  }
  if (!Number.isInteger(spec.version) || (spec.version as number) < 1) {
    return { ok: false, error: "tool-reg: version 必须为 ≥1 的整数" };
  }
  const d = spec.description;
  if (!isRecord(d) || !nonEmpty(d.anchor) || !nonEmpty(d.whenToUse) || !nonEmpty(d.effect)) {
    return { ok: false, error: "tool-reg: description 三要素（anchor/whenToUse/effect）缺一不可" };
  }
  const p = spec.parameters;
  if (!isRecord(p) || p.type !== "object" || !isRecord(p.properties) || !Array.isArray(p.required)) {
    return { ok: false, error: "tool-reg: parameters 必须为 {type:\"object\", properties:{…}, required:[…]}" };
  }
  for (const r of p.required as unknown[]) {
    if (!nonEmpty(r)) return { ok: false, error: "tool-reg: parameters.required 元素必须为非空字符串" };
    if (!(r in (p.properties as Record<string, unknown>))) {
      return { ok: false, error: `tool-reg: required 参数 "${r}" 不在 properties 中（schema 非法）` };
    }
  }
  const e = spec.executor;
  if (!isRecord(e) || !nonEmpty(e.type)) return { ok: false, error: "tool-reg: executor 缺 type" };
  if (e.type === "program") {
    if (!nonEmpty(e.source)) return { ok: false, error: "tool-reg: program 态缺 source（固化 ts 源码）" };
  } else if (e.type === "builtin") {
    if (!nonEmpty(e.ref)) return { ok: false, error: "tool-reg: builtin 态缺 ref（执行器键）" };
  } else if (e.type === "agent") {
    if (!nonEmpty(e.role)) return { ok: false, error: "tool-reg: agent 态缺 role（子 agent 角色）" };
    if (e.input !== undefined && typeof e.input !== "string") return { ok: false, error: "tool-reg: agent 态 input 契约须为字符串" };
    if (e.output !== undefined && typeof e.output !== "string") return { ok: false, error: "tool-reg: agent 态 output 契约须为字符串" };
  } else {
    return { ok: false, error: `tool-reg: executor.type 非法 "${e.type}"（三态：program/builtin/agent）` };
  }
  const v = spec.visibility;
  if (!isRecord(v)) return { ok: false, error: "tool-reg: visibility 缺失" };
  if (!Array.isArray(v.roles) || v.roles.length === 0 || !v.roles.every((r) => nonEmpty(r))) {
    return { ok: false, error: "tool-reg: visibility.roles 不能为空（命题 3——可见性必须显式窄投放）" };
  }
  if (!nonEmpty(v.pack)) return { ok: false, error: "tool-reg: visibility.pack 不能为空（0.17.2 工具包归属）" };
  if (spec.promotedFrom !== undefined && !nonEmpty(spec.promotedFrom)) {
    return { ok: false, error: "tool-reg: promotedFrom 须为非空字符串" };
  }
  return { ok: true, spec: spec as unknown as ToolRegSpec };
}

function executorText(e: ToolRegExecutor): string {
  if (e.type === "program") return `- 类型：program（固化 ts 程序——ts 核执行，无 LLM）\n- 源码：见 __tool_spec__ executor.source`;
  if (e.type === "builtin") return `- 类型：builtin（代码内置执行器）\n- 引用：${e.ref}`;
  return `- 类型：agent（LLM 子 agent）\n- 角色：${e.role}${e.input ? `\n- 输入契约：${e.input}` : ""}${e.output ? `\n- 产物契约：${e.output}` : ""}`;
}

/** spec → tool-reg 条目 content（幂等：同一输入产出同一文本——机读行为单一真相源） */
export function buildToolRegContent(spec: ToolRegSpec): string {
  const specLine = `- ${TOOL_SPEC_MARKER} ${JSON.stringify(spec)}`;
  return `# tool:${spec.name}（工具注册条目——tool-reg v1）

【场景锚点】${spec.description.anchor}
【何时用】${spec.description.whenToUse}
【效果】${spec.description.effect}

## 参数契约（OpenAI function 格式）
- required：${spec.parameters.required.join("/") || "（无）"}
- properties：${JSON.stringify(spec.parameters.properties)}

## 执行体（三态之一——program/builtin/agent）
${executorText(spec.executor)}

## 可见性（0.17.3 命题 3 防线——默认窄投放，不全局广播）
- 角色：${spec.visibility.roles.join("/")}
- 工具包：${spec.visibility.pack}

## 治理（不可变 + 版本链 + 审批门槛）
${specLine}
- 条目不可变——修订 = 新版本（version+1，promotedFrom 链留痕——B4-1 同款）
- 候选池 ≠ 工具：未过审批的沉淀物不进列表（晋升管线：提案 → 对抗性审核 → 批准 → 注册）
- 快照版本化：任务开始冻结工具面快照，不逐任务变（T3 教训防线）
`;
}

/** 解析 tool-reg 条目 content：文本三要素 + __tool_spec__ 机读行 + spec 注册校验 */
export function parseToolRegContent(content: string): ToolRegParseResult {
  const text = String(content ?? "");
  const titleMatch = text.match(/^#\s*tool:([a-z0-9][a-z0-9._-]{0,63})/m);
  const titleName = titleMatch?.[1];
  if (!titleName) {
    return { ok: false, error: "tool-reg 标题缺失或非法（应为 `# tool:<name>`）" };
  }
  const markerMatch = text.match(new RegExp(`${TOOL_SPEC_MARKER}\\s+(\\{.*\\})`));
  if (!markerMatch) {
    return { ok: false, error: `tool-reg 缺少机读单一真相源（${TOOL_SPEC_MARKER} 行）` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(markerMatch[1]!);
  } catch {
    return { ok: false, error: "tool-reg 机读 spec JSON 非法" };
  }
  const checked = validateToolRegSpec(raw);
  if (!checked.ok) return checked;
  const spec = checked.spec;
  if (spec.name !== titleName) {
    return { ok: false, error: `tool-reg 标题与 spec 不一致：标题 ${titleName} ≠ spec.name ${spec.name}` };
  }
  // 文本/机读漂移防护：文本三要素必须与 spec.description 一致（穿透 child==标题同款）
  for (const [label, key] of [["场景锚点", "anchor"], ["何时用", "whenToUse"], ["效果", "effect"]] as const) {
    const field = text.match(new RegExp(`【${label}】([^\\n]*)`))?.[1]?.trim() ?? "";
    if (field !== spec.description[key].trim()) {
      return { ok: false, error: `tool-reg 文本【${label}】与 spec.description.${key} 漂移（单一真相源 = 机读行，重建文本）` };
    }
  }
  return { ok: true, id: `${TOOL_REG_ID_PREFIX}${spec.name}`, spec, content: text };
}

/** 注册入口校验（§7-1 调用即拒绝的落点——parse + validate 一体） */
export function validateToolRegContent(content: string): ToolRegParseResult {
  return parseToolRegContent(content);
}

/** 内存条目构造器（登记器/治理流注册时直接落库——穿透 buildPenetrationSkillEntry 同款） */
export function buildToolRegEntry(
  spec: ToolRegSpec,
  opts: { status?: "official" | "draft" } = {},
): { id: string; kind: typeof TOOL_REG_KIND; anchors: string[]; content: string; status: "official" | "draft"; meta: Record<string, unknown> } {
  const checked = validateToolRegSpec(spec);
  if (!checked.ok) throw new Error(checked.error);
  return {
    id: `${TOOL_REG_ID_PREFIX}${spec.name}`,
    kind: TOOL_REG_KIND,
    anchors: ["tool-reg", spec.name, spec.visibility.pack, `executor:${spec.executor.type}`],
    content: buildToolRegContent(spec),
    status: opts.status ?? "draft",
    meta: {
      format: TOOL_REG_FORMAT,
      version: spec.version,
      pack: spec.visibility.pack,
      executorType: spec.executor.type,
      ...(spec.promotedFrom ? { promotedFrom: spec.promotedFrom } : {}),
    },
  };
}
