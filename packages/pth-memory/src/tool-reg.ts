/**
 * tool-reg.ts —— 工具注册条目（tool-reg）格式与校验（2026-08-18 N14 P0）。
 *
 * 依据：docs/pth/design/n14-sensor-controller-four-dims.md §3（一等工具注册通道——契约先行，
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

import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "./memory-store-pg.js";

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
  /** 旧执行体三态（保留读取能力；v2 优先走 command adapter） */
  executor: ToolRegExecutor;
  /** Tool-Reg v2：command adapter id（如 builtin:<ref> / program:<name> / agent:<role>） */
  command?: string;
  /** Tool-Reg v2：成功返回契约（可选；只描述成功 value，不描述执行信封） */
  returns?: { schema?: unknown; description?: string };
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
  if (spec.command !== undefined && !nonEmpty(spec.command)) {
    return { ok: false, error: "tool-reg: command 须为非空字符串（Tool-Reg v2 adapter id）" };
  }
  if (spec.returns !== undefined) {
    const r = spec.returns;
    if (!isRecord(r)) return { ok: false, error: "tool-reg: returns 须为对象" };
    if (r.schema !== undefined && !isRecord(r.schema)) return { ok: false, error: "tool-reg: returns.schema 须为对象" };
    if (r.description !== undefined && !nonEmpty(r.description)) return { ok: false, error: "tool-reg: returns.description 须为非空字符串" };
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

/**
 * 旧执行体三态 → 默认 command adapter id（Tool-Reg v2 迁移）。
 *  - builtin → builtin:<ref>
 *  - program → program:<name>
 *  - agent   → agent:<role>
 */
export function toolRegDefaultCommand(spec: Pick<ToolRegSpec, "executor" | "name">): string {
  const e = spec.executor;
  if (e.type === "builtin") return `builtin:${e.ref}`;
  if (e.type === "program") return `program:${spec.name}`;
  return `agent:${e.role}`;
}

/** 返回带 command 的 v2 spec（旧 spec 自动迁移；已带 command 则原样）。 */
export function toToolRegV2Spec(spec: ToolRegSpec): ToolRegSpec {
  return spec.command ? spec : { ...spec, command: toolRegDefaultCommand(spec) };
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

## Command Adapter（Tool-Reg v2）
- command：${spec.command ?? toolRegDefaultCommand(spec)}
${spec.returns ? `- returns：${JSON.stringify(spec.returns)}` : ""}

## 执行体（兼容——program/builtin/agent）
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

// ════════════════════════════════════════════════════════════════════════════
// N14 P3：治理流（§3.4——skill 同构，Q3 裁决）
//   候选（tool-function 沉淀 / sensor 观测提案 / 人工）
//     → controller:tool-face 包装提案（kind=tool-proposal，draft）
//     → controller:adversarial 对抗性审核（schema 质量 / 执行体安全 / 作弊捷径）
//     → 监督批准（PTH_TOOL_WRITE_POLICY=staged|manual——W5 同款配置）
//     → tool-reg official 生效（不可变 + 审计留痕；修订 = version+1，promotedFrom 链）
// ════════════════════════════════════════════════════════════════════════════

export const TOOL_PROPOSAL_KIND = "tool-proposal";

/** 治理面 store 窄口（PgMemoryStore 结构型兼容——与 SkillMaintenanceStore 同形） */
export interface ToolRegGovernanceStore {
  get(id: string): Promise<MemoryEntry | undefined>;
  write(entry: MemoryEntry, opts?: { force?: boolean }): Promise<void>;
  update(id: string, patch: Partial<MemoryEntry>, opts?: { force?: boolean }): Promise<void>;
}

export interface ToolRegProposal {
  action: "register" | "revise";
  /** 工具名（不带 tool: 前缀） */
  name: string;
  /** 完整 ToolRegSpec（register=新条目 version 1；revise=version 必须大于现条目） */
  spec?: unknown;
  rationale?: string;
  audit?: string;
}

export interface ToolGovernanceResult {
  ok: boolean;
  id?: string;
  error?: string;
}

async function getToolProposal(store: ToolRegGovernanceStore, proposalId: string) {
  const p = await store.get(proposalId);
  if (!p || p.kind !== TOOL_PROPOSAL_KIND) return undefined;
  return p;
}

/**
 * 晋升动作校验（register/revise 的调用即拒绝点——propose 与 execute 共用同一真相源）：
 *   register——新条目 version 必须为 1（已存在 → 拒绝，修订走 revise）；
 *   revise  ——现条目存在 + version 递增（不可变语义：修订 = 新版本）；
 *             promotedFrom 链自动承继现条目（提案未显式携带时——B4-1 同款留痕）。
 */
export async function validateToolRegAction(
  store: ToolRegGovernanceStore,
  action: "register" | "revise",
  spec: ToolRegSpec,
): Promise<{ ok: true; spec: ToolRegSpec } | { ok: false; error: string }> {
  if (action !== "register" && action !== "revise") {
    return { ok: false, error: `动作 "${String(action)}" 暂不支持（register/revise）` };
  }
  const existing = await store.get(`${TOOL_REG_ID_PREFIX}${spec.name}`);
  if (action === "register") {
    if (existing && existing.status !== "archived") {
      return { ok: false, error: `tool:${spec.name} 已存在且不可变——修订请走 revise（version+1，promotedFrom 链留痕）` };
    }
    if (spec.version !== 1) {
      return { ok: false, error: `register 新条目版本必须为 1（收到 v${spec.version}）——修订请走 revise` };
    }
    return { ok: true, spec };
  }
  if (!existing) return { ok: false, error: `tool:${spec.name} 不存在——revise 须基于现条目` };
  const currentVersion = Number(existing.meta?.version ?? 1);
  if (spec.version <= currentVersion) {
    return { ok: false, error: `revise 版本必须递增：现 v${currentVersion}，提案 v${spec.version}（不可变语义——修订 = 新版本）` };
  }
  const existingPromotedFrom = typeof existing.meta?.promotedFrom === "string" ? existing.meta.promotedFrom : undefined;
  if (existingPromotedFrom && !spec.promotedFrom) {
    spec = { ...spec, promotedFrom: existingPromotedFrom };
  }
  return { ok: true, spec };
}

/** 提案落 draft（调用即拒绝——spec 先过注册校验 + 晋升动作校验；与 skills.maintain.propose 同款） */
export async function proposeToolRegistration(store: ToolRegGovernanceStore, input: ToolRegProposal): Promise<ToolGovernanceResult> {
  const name = String(input?.name ?? "").trim();
  if (!TOOL_REG_NAME_RE.test(name)) return { ok: false, error: `tool 名非法: ${name}` };
  if (input.action !== "register" && input.action !== "revise") {
    return { ok: false, error: `动作 "${String(input.action)}" 暂不支持（register/revise）` };
  }
  const checked = validateToolRegSpec(input.spec);
  if (!checked.ok) return { ok: false, error: `提案 spec 非法：${checked.error}` };
  if (checked.spec.name !== name) return { ok: false, error: `提案 name "${name}" 与 spec.name "${checked.spec.name}" 不一致` };
  const action = await validateToolRegAction(store, input.action, checked.spec);
  if (!action.ok) return { ok: false, error: `晋升动作校验失败：${action.error}` };
  const id = `${TOOL_PROPOSAL_KIND}:${randomUUID()}`;
  await store.write({
    id,
    kind: TOOL_PROPOSAL_KIND,
    anchors: ["tool-reg", name, input.action],
    content: JSON.stringify({ ...input, name, spec: action.spec } satisfies ToolRegProposal),
    status: "draft",
    meta: { proposedAt: Date.now(), action: input.action, toolName: name, stage: "proposed" },
  });
  return { ok: true, id };
}

/** 对抗性审核（controller:adversarial——schema 质量/执行体安全/作弊捷径） */
export async function reviewToolProposal(
  store: ToolRegGovernanceStore,
  proposalId: string,
  verdict: "pass" | "reject",
  note = "",
): Promise<ToolGovernanceResult> {
  const p = await getToolProposal(store, proposalId);
  if (!p) return { ok: false, error: "tool 注册提案不存在或类型不符" };
  if (p.status !== "draft") return { ok: false, error: `提案状态 ${p.status}——仅 draft 可审核` };
  await store.update(proposalId, {
    meta: {
      ...(p.meta ?? {}),
      adversarialReview: { verdict, note, reviewer: "controller:adversarial", reviewedAt: Date.now() },
      stage: verdict === "pass" ? "reviewed" : "rejected",
    },
  });
  return { ok: verdict === "pass", id: proposalId, error: verdict === "pass" ? undefined : "adversarial review rejected" };
}

/** 监督批准（审批面——gateway approve 流消费；必须已过对抗性审核） */
export async function approveToolProposal(store: ToolRegGovernanceStore, proposalId: string): Promise<ToolGovernanceResult> {
  const p = await getToolProposal(store, proposalId);
  if (!p) return { ok: false, error: "tool 注册提案不存在或类型不符" };
  if (p.status !== "draft") return { ok: false, error: `提案状态 ${p.status}——仅 draft 可批准` };
  const review = (p.meta?.adversarialReview ?? {}) as { verdict?: string };
  if (review.verdict !== "pass") return { ok: false, error: "提案未经 controller:adversarial pass 审核——不可批准" };
  await store.update(proposalId, { status: "official", meta: { ...(p.meta ?? {}), approvedAt: Date.now(), stage: "approved" } });
  return { ok: true, id: proposalId };
}

/**
 * 执行已批准提案（监督通道）：
 *   register——新条目 official 落库（已存在 → 拒绝，修订走 revise）；
 *   revise  ——现条目存在 + spec.version > 现版本（不可变语义：修订 = 新版本，promotedFrom 链留痕）。
 */
export async function executeApprovedToolProposal(store: ToolRegGovernanceStore, proposalId: string): Promise<ToolGovernanceResult> {
  const p = await getToolProposal(store, proposalId);
  if (!p || p.status !== "official") return { ok: false, error: "提案不存在或未批准" };
  const proposal = JSON.parse(String(p.content)) as ToolRegProposal;
  const checked = validateToolRegSpec(proposal.spec);
  if (!checked.ok) return { ok: false, error: `提案 spec 非法：${checked.error}` };
  if (checked.spec.name !== proposal.name) return { ok: false, error: `提案 name "${proposal.name}" 与 spec.name "${checked.spec.name}" 不一致` };
  const action = await validateToolRegAction(store, proposal.action, checked.spec);
  if (!action.ok) return { ok: false, error: `晋升动作校验失败：${action.error}` };
  const spec = action.spec;
  const entryId = `${TOOL_REG_ID_PREFIX}${proposal.name}`;
  const entry = buildToolRegEntry(spec, { status: "official" });
  await store.write({
    ...entry,
    meta: { ...entry.meta, registeredAt: Date.now(), proposalId, registeredBy: "controller:tool-face", ...(proposal.rationale ? { rationale: proposal.rationale } : {}) },
  }, { force: true });
  await store.update(proposalId, { meta: { ...(p.meta ?? {}), executedAt: Date.now(), stage: "executed" } });
  return { ok: true, id: entryId };
}
