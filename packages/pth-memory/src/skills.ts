/**
 * skills.ts —— skill 记忆类型的检索面（2026-08-15 B4 Phase 2）。
 *
 * B4-3 已裁 C（两级检索）：
 *   Level 0 = listSkills() 清单（id + 三要素摘要，不加载全文）；
 *   Level 1 = getSkill(id) 全文（按需加载）。
 * 数据源 = memory_entries 中 kind 以 "skill:" 为前缀的条目。
 */

import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "./memory-store-pg.js";

export interface SkillStoreLike {
  listIds(): Promise<string[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
}

export interface SkillSummary {
  id: string;
  anchor: string;
  whenToUse: string;
  effect: string;
  status: string;
}

const SKILL_KIND_PREFIX = "skill:";

function fieldOf(content: string, label: string): string {
  const re = new RegExp(`【${label}】([^\\n]*)`);
  return content.match(re)?.[1]?.trim() ?? "";
}

export function parseSkillSummary(entry: Pick<MemoryEntry, "id" | "kind" | "content" | "status">): SkillSummary {
  const content = typeof entry.content === "string" ? entry.content : "";
  return {
    id: entry.id,
    anchor: fieldOf(content, "场景锚点"),
    whenToUse: fieldOf(content, "何时用"),
    effect: fieldOf(content, "效果"),
    status: entry.status,
  };
}

/** Level 0：所有 skill:* 条目的三要素清单（只读官方/draft 均可——调用方决定过滤） */
export async function listSkills(store: SkillStoreLike): Promise<SkillSummary[]> {
  const ids = await store.listIds();
  const skillIds = ids.filter((id) => id.startsWith(SKILL_KIND_PREFIX));
  const out: SkillSummary[] = [];
  for (const id of skillIds) {
    const entry = await store.get(id);
    if (entry) out.push(parseSkillSummary(entry));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Level 1：按 id 取全文；自动补 skill: 前缀。 */
export async function getSkill(store: SkillStoreLike, idOrName: string): Promise<MemoryEntry | undefined> {
  const id = idOrName.startsWith(SKILL_KIND_PREFIX) ? idOrName : `${SKILL_KIND_PREFIX}${idOrName}`;
  return store.get(id);
}

/** B4 Phase 3：memory-keeper 维护面的 store 能力（需要 force 通道的完整 store） */
export interface SkillMaintenanceStore extends SkillStoreLike {
  write(entry: MemoryEntry, opts?: { force?: boolean }): Promise<void>;
  update(id: string, patch: Partial<MemoryEntry>, opts?: { force?: boolean }): Promise<void>;
}

export interface SkillMaintainResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** B4 Phase 4：SKILL.md → skill 条目映射（0.13 转化落点）
 *
 *  pi SKILL.md 允许的前置元数据（name/description）不要求存在；映射以正文为准：
 *    name        ← 标题 `# skill:<name>（SOP…）`（无标题则必须由调用方显式传 name）
 *    【场景锚点】  ← SKILL.md 的「场景锚点」段
 *    【何时用】    ← 「何时用」段（description 可作为何时用之一）
 *    【效果】      ← 「效果」段
 *    Procedure    ← 有序步骤，每步 `（代价：…）`；缺代价按 unknown 记
 *    Pitfalls     ← 无序列表
 *    Verification ← 无序列表
 *  四段缺一 → 解析失败（N4 pipeline 写该格式时必须完整）。
 */
export type SkillMarkdownParseResult =
  | { ok: true; name: string; seed: { id: string; anchor: string; whenToUse: string; effect: string; procedure: { step: string; cost: string }[]; pitfalls: string[]; verification: string[] } }
  | { ok: false; error: string };

export function parseSkillMarkdown(md: string, explicitName?: string): SkillMarkdownParseResult {
  const text = String(md ?? "");
  const titleMatch = text.match(/^#\s*skill:([a-zA-Z0-9][a-zA-Z0-9._-]*)/m);
  const name = explicitName?.trim() || titleMatch?.[1];
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    return { ok: false, error: "skill 名称缺失或非法（标题 `# skill:<name>` 或显式 name）" };
  }
  const anchor = text.match(/【场景锚点】([^\n]*)/)?.[1]?.trim() ?? "";
  const whenToUse = text.match(/【何时用】([^\n]*)/)?.[1]?.trim() ?? "";
  const effect = text.match(/【效果】([^\n]*)/)?.[1]?.trim() ?? "";
  if (!anchor || !whenToUse || !effect) {
    return { ok: false, error: "四段式不完整：场景锚点/何时用/效果 缺一不可" };
  }
  const procedure: { step: string; cost: string }[] = [];
  const procBody = text.split(/##\s*Procedure/i)[1]?.split(/^##\s/m)[0] ?? "";
  for (const line of procBody.split("\n")) {
    const m = line.match(/^\s*\d+\.\s+(.+?)(?:\s*（代价：([^）]*)）)?\s*$/);
    if (m?.[1]) procedure.push({ step: m[1].trim(), cost: m[2]?.trim() || "unknown" });
  }
  const listBody = (section: string): string[] => {
    const body = text.split(new RegExp(`##\\s*${section}`, "i"))[1]?.split(/^##\s/m)[0] ?? "";
    return body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  };
  const pitfalls = listBody("Pitfalls");
  const verification = listBody("Verification");
  if (procedure.length === 0 || pitfalls.length === 0 || verification.length === 0) {
    return { ok: false, error: "四段式不完整：Procedure/Pitfalls/Verification 至少各一条" };
  }
  return { ok: true, name, seed: { id: name, anchor, whenToUse, effect, procedure, pitfalls, verification } };
}

export interface SkillMaintainWriteInput {
  /** 不带前缀的 skill 名 */
  name: string;
  content: string;
  anchors?: string[];
  /** 显式覆写（force）；缺省只允许新条目 */
  force?: boolean;
  audit?: string;
  /** staged 策略下的已批准提案 id */
  proposalId?: string;
}

export interface SkillMaintainWriteOptions {
  /** manual（默认）：人工闸门已由维护任务分配承担；staged：必须有 approved 提案 */
  policy?: "manual" | "staged";
}

/** B4 W5 staged 流：draft 提案 → controller:adversarial 审核 → 监督批准 → memory-keeper 执行 */
export interface SkillMaintainProposal {
  action: "write" | "archive";
  name: string;
  content?: string;
  force?: boolean;
  anchors?: string[];
  audit?: string;
}

const PROPOSAL_KIND = "skill-maintain-proposal";

async function getProposal(store: SkillMaintenanceStore, proposalId: string): Promise<MemoryEntry | undefined> {
  const p = await store.get(proposalId);
  if (!p || p.kind !== PROPOSAL_KIND) return undefined;
  return p;
}

export async function proposeSkillMaintenance(store: SkillMaintenanceStore, input: SkillMaintainProposal): Promise<SkillMaintainResult> {
  const id = `${PROPOSAL_KIND}:${randomUUID()}`;
  await store.write({
    id,
    kind: PROPOSAL_KIND,
    anchors: [input.name],
    content: JSON.stringify(input),
    status: "draft",
    meta: { proposedAt: Date.now(), proposedBy: "memory-keeper", stage: "proposed" },
  });
  return { ok: true, id };
}

export async function reviewSkillProposal(
  store: SkillMaintenanceStore,
  proposalId: string,
  verdict: "pass" | "reject",
  note = "",
): Promise<SkillMaintainResult> {
  const p = await getProposal(store, proposalId);
  if (!p) return { ok: false, error: "skill 维护提案不存在或类型不符" };
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

export async function approveSkillProposal(store: SkillMaintenanceStore, proposalId: string): Promise<SkillMaintainResult> {
  const p = await getProposal(store, proposalId);
  if (!p) return { ok: false, error: "skill 维护提案不存在或类型不符" };
  if (p.status !== "draft") return { ok: false, error: `提案状态 ${p.status}——仅 draft 可批准` };
  const review = (p.meta?.adversarialReview ?? {}) as { verdict?: string };
  if (review.verdict !== "pass") return { ok: false, error: "提案未经 controller:adversarial pass 审核——不可批准" };
  await store.update(proposalId, { status: "official", meta: { ...(p.meta ?? {}), approvedAt: Date.now(), stage: "approved" } });
  return { ok: true, id: proposalId };
}

/** 监督批准后执行已批准的 skill 维护提案（write/archive——与 T7 归档 approve 流同构）。 */
export async function executeApprovedSkillProposal(store: SkillMaintenanceStore, proposalId: string): Promise<SkillMaintainResult> {
  const p = await getProposal(store, proposalId);
  if (!p || p.status !== "official") return { ok: false, error: "提案不存在或未批准" };
  const proposal = JSON.parse(String(p.content)) as SkillMaintainProposal;
  if (proposal.action === "archive") {
    const id = proposal.name.startsWith(SKILL_KIND_PREFIX) ? proposal.name : `${SKILL_KIND_PREFIX}${proposal.name}`;
    const existing = await store.get(id);
    if (!existing) return { ok: false, error: `skill not found: ${id}` };
    await store.update(id, {
      status: "archived",
      meta: { ...(existing.meta ?? {}), archivedAt: Date.now(), archivedBy: "memory-keeper", proposalId, ...(proposal.audit ? { auditNote: proposal.audit } : {}) },
    }, { force: true });
    await store.update(proposalId, { meta: { ...(p.meta ?? {}), executedAt: Date.now(), stage: "executed" } });
    return { ok: true, id };
  }
  if (proposal.action === "write") {
    return maintainSkillWrite(store, {
      name: proposal.name,
      content: proposal.content ?? "",
      anchors: proposal.anchors,
      force: proposal.force ?? false,
      audit: proposal.audit,
      proposalId,
    }, { policy: "staged" });
  }
  return { ok: false, error: `动作 "${String(proposal.action)}" 暂不支持（write/archive）` };
}

async function executeProposal(store: SkillMaintenanceStore, proposalId: string, name: string, action: "write" | "archive"): Promise<SkillMaintainResult> {
  await store.update(proposalId, { meta: { executedAt: Date.now(), stage: "executed" } });
  if (action === "archive") return maintainSkillArchive(store, name);
  return { ok: true, id: `skill:${name}` };
}

/** 维护面写 skill：新条目直写；已存在必须显式 force（写后冻结的修订审计）。 */
export async function maintainSkillWrite(store: SkillMaintenanceStore, input: SkillMaintainWriteInput, opts: SkillMaintainWriteOptions = {}): Promise<SkillMaintainResult> {
  const name = String(input.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    return { ok: false, error: `invalid skill name: ${name}` };
  }
  if (typeof input.content !== "string" || input.content.trim() === "") {
    return { ok: false, error: "skill content required" };
  }
  if (opts.policy === "staged") {
    if (!input.proposalId) return { ok: false, error: "staged 策略需要已批准提案 proposalId" };
    const p = await getProposal(store, input.proposalId);
    if (!p || p.status !== "official") return { ok: false, error: "提案不存在或未批准" };
    const proposal = JSON.parse(String(p.content)) as SkillMaintainProposal;
    if (proposal.action !== "write" || proposal.name !== name) return { ok: false, error: "提案与写入目标不匹配" };
    await executeProposal(store, input.proposalId, name, "write");
  }
  const id = `${SKILL_KIND_PREFIX}${name}`;
  const existing = await store.get(id);
  if (existing && !input.force) {
    return { ok: false, error: `skill ${id} 已存在且不可变——修订需显式 force（audit 留痕）或先 archive 再写新条目` };
  }
  const now = Date.now();
  await store.write({
    id,
    kind: id,
    anchors: input.anchors && input.anchors.length > 0 ? input.anchors : [name],
    content: input.content,
    status: "official",
    meta: {
      ...(existing?.meta ?? {}),
      maintainedAt: now,
      maintainedBy: "memory-keeper",
      revision: (Number(existing?.meta?.revision ?? 0) || 0) + 1,
      ...(input.audit ? { auditNote: input.audit } : {}),
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    },
  }, { force: true });
  return { ok: true, id };
}

/** 维护面归档 skill（修订流：archive 旧条目 + 写新条目）。 */
export async function maintainSkillArchive(store: SkillMaintenanceStore, idOrName: string, audit?: string, opts: SkillMaintainWriteOptions = {}): Promise<SkillMaintainResult> {
  const id = idOrName.startsWith(SKILL_KIND_PREFIX) ? idOrName : `${SKILL_KIND_PREFIX}${idOrName}`;
  const existing = await store.get(id);
  if (!existing) return { ok: false, error: `skill not found: ${id}` };
  if (opts.policy === "staged") {
    return { ok: false, error: "staged archive 请经 propose/approve 后调用 executeSkillProposal" };
  }
  await store.update(id, {
    status: "archived",
    meta: { ...(existing.meta ?? {}), archivedAt: Date.now(), archivedBy: "memory-keeper", ...(audit ? { auditNote: audit } : {}) },
  }, { force: true });
  return { ok: true, id };
}
