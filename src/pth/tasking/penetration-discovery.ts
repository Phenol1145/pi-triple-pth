/**
 * tasking/penetration-discovery.ts —— N15 B1 穿透自动发现 → 提案注册。
 *
 * 消费 B2 的 `penetration-edge` 聚合行（实际穿透执行面数据），把稳定边转化为
 * `penetration-proposal`（draft）→ 监督批准（gateway 同流）→ `skill:penetrate:<child>`
 * official 落库。注册后的边才可被 `tasks.penetrate` 执行（现有校验不变）。
 *
 * 本模块只依赖结构型窄口（PgMemoryStore 兼容），不 import 未必要的装配层。
 */

import { randomUUID } from "node:crypto";
import {
  allowedDelegationTargets,
} from "./delegation-policy.js";
import { knownRoleById } from "@away_from/pth-kernel-execution";
import {
  PENETRATION_SKILL_ID_PREFIX,
  buildPenetrationSkillContent,
  buildPenetrationSkillEntry,
  validatePenetrationSkillRegistration,
  type PenetrationEdgeSpec,
} from "./penetration-skill.js";
import { pthConfig } from "@away_from/pth-config";
import { DEFAULT_TENANT_ID } from "@away_from/pth-memory";

export const PENETRATION_PROPOSAL_KIND = "penetration-proposal";
export const PENETRATION_EDGE_KIND = "penetration-edge";

// ── 类型契约（设计文档 2.3 逐条照抄）────────────────────────────────

export interface PenetrationEdgeAggregate {
  parent: string;
  child: string;
  calls: number;
  okCalls: number;
  sumSteps: number;
  sumDurationMs: number;
  sumBudgetExceeded: number;
}

export interface PenetrationDiscoveryConfig {
  minCalls: number;
  minOkRatio: number;
  maxAvgSteps: number;
}

export interface PenetrationProposalContent {
  action: "register";
  /** 与 PenetrationEdgeSpec 同构（四段式三要素由证据数据生成） */
  spec: PenetrationEdgeSpec;
  evidence: {
    calls: number;
    okCalls: number;
    okRatio: number;
    avgSteps: number;
    avgDurationMs: number;
    budgetExceeded: number;
  };
}

export type PenetrationEdgeEvaluation =
  | { ok: true; spec: PenetrationEdgeSpec; evidence: PenetrationProposalContent["evidence"] }
  | { ok: false; reason: string };

/** 治理面 store 窄口（PgMemoryStore 结构型兼容——与 ToolRegGovernanceStore 同形） */
export interface PenetrationDiscoveryMemoryEntry {
  id: string;
  tenantId?: string;
  kind: string;
  anchors: string[];
  content: string;
  /**
   * N29 Task 6：`stale` 只出现在**读**侧（store 可能返回任何 MemoryEntry 状态）。
   * discovery 自身只写 draft/archived 提案，从不写 official，更不写 stale
   * （stale 只能由 `PgMemoryStore.markKnowledgeStale*()` 的内部 authority 产生）。
   */
  status: "draft" | "official" | "archived" | "stale";
  meta: Record<string, unknown>;
}

export interface PenetrationDiscoveryStore {
  get(id: string, opts?: { tenantId?: string }): Promise<PenetrationDiscoveryMemoryEntry | undefined>;
  write(entry: PenetrationDiscoveryMemoryEntry, opts?: { force?: boolean }): Promise<void>;
  update(id: string, patch: Partial<PenetrationDiscoveryMemoryEntry>, opts?: { force?: boolean; tenantId?: string }): Promise<void>;
}

/** discover 只写提案——写口窄化（PgMemoryStore.write 形状） */
export interface PenetrationDiscoveryWritePort {
  write(entry: PenetrationDiscoveryMemoryEntry, opts?: { force?: boolean }): Promise<void>;
}

export interface PenetrationDiscoveryDeps {
  /** 读聚合行/现有 skill/现有 draft 提案（受限只读 SQL） */
  queryReadOnly(sql: string): Promise<unknown>;
  memory: PenetrationDiscoveryWritePort;
  /** 阈值读取（可注入；缺省由 createPenetrationDiscoveryService 读取 schema 配置） */
  config?: PenetrationDiscoveryConfig;
  log?: (msg: string) => void;
}

export interface PenetrationDiscoverySkip {
  parent: string;
  child: string;
  reason: string;
}

export interface PenetrationDiscoveryResult {
  created: string[];
  skipped: PenetrationDiscoverySkip[];
}

export interface PenetrationGovernanceResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// ── 纯函数：解析 / 评估（先测后写）─────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 坏行跳过：content 为 JSON 字符串（或已解析对象），字段非法一律 null。 */
export function parseEdgeAggregate(content: unknown): PenetrationEdgeAggregate | null {
  let raw: unknown = content;
  if (typeof content === "string") {
    try {
      raw = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (!isRecord(raw)) return null;
  const parent = raw.parent;
  const child = raw.child;
  const calls = raw.calls;
  const okCalls = raw.okCalls;
  const sumSteps = raw.sumSteps;
  const sumDurationMs = raw.sumDurationMs;
  const sumBudgetExceeded = raw.sumBudgetExceeded;
  if (!nonEmptyString(parent) || !nonEmptyString(child)) return null;
  if (
    !finiteNumber(calls)
    || !finiteNumber(okCalls)
    || !finiteNumber(sumSteps)
    || !finiteNumber(sumDurationMs)
    || !finiteNumber(sumBudgetExceeded)
  ) return null;
  return { parent, child, calls, okCalls, sumSteps, sumDurationMs, sumBudgetExceeded };
}

/**
 * 稳定边评估（三门槛 + 组织权 + 角色注册）：
 *   - parent/child 必须已注册（knownRoleById）且 allowedDelegationTargets(parent).includes(child)；
 *   - calls >= minCalls、okCalls/calls >= minOkRatio、sumSteps/calls <= maxAvgSteps；
 *   - 生成 spec 的四段式三要素与证据。
 */
export function evaluateEdge(agg: PenetrationEdgeAggregate, cfg: PenetrationDiscoveryConfig): PenetrationEdgeEvaluation {
  if (!knownRoleById(agg.parent)) {
    return { ok: false, reason: `parent 角色未注册: ${agg.parent}` };
  }
  if (!knownRoleById(agg.child)) {
    return { ok: false, reason: `child 角色未注册: ${agg.child}` };
  }
  const allowed = allowedDelegationTargets(agg.parent);
  if (!allowed.includes(agg.child)) {
    return {
      ok: false,
      reason: `组织权拒绝：${agg.parent} 不可投递 ${agg.child}（可投递: ${allowed.length > 0 ? allowed.join("/") : "无"}）`,
    };
  }
  if (agg.calls < cfg.minCalls) {
    return { ok: false, reason: `calls 不足: ${agg.calls} < ${cfg.minCalls}` };
  }
  const okRatio = agg.calls > 0 ? agg.okCalls / agg.calls : 0;
  if (okRatio < cfg.minOkRatio) {
    return { ok: false, reason: `成功率不足: ${okRatio.toFixed(3)} < ${cfg.minOkRatio}` };
  }
  const avgSteps = agg.calls > 0 ? agg.sumSteps / agg.calls : 0;
  if (avgSteps > cfg.maxAvgSteps) {
    return { ok: false, reason: `平均步数超限: ${avgSteps.toFixed(2)} > ${cfg.maxAvgSteps}` };
  }
  const avgDurationMs = agg.calls > 0 ? agg.sumDurationMs / agg.calls : 0;
  const evidence: PenetrationProposalContent["evidence"] = {
    calls: agg.calls,
    okCalls: agg.okCalls,
    okRatio,
    avgSteps,
    avgDurationMs,
    budgetExceeded: agg.sumBudgetExceeded,
  };
  const spec: PenetrationEdgeSpec = {
    parent: agg.parent,
    child: agg.child,
    inputContract: `${agg.parent} 提交的自包含任务描述（标题+正文）——与直投任务文本同构`,
    outputContract: `done.result 为父任务验收口径的产物；失败回流错误摘要`,
    anchor: `${agg.parent}→${agg.child} 稳定直投路径（${agg.calls} 次 / 成功率 ${(okRatio * 100).toFixed(0)}%）`,
    whenToUse: `${agg.parent} 需要 ${agg.child} 承接同型任务且无需任务池往返时`,
    effect: `跳过派发/认领/回流三段往返——平均耗时 ${Math.round(avgDurationMs)}ms`,
    path: [agg.parent, agg.child],
  };
  return { ok: true, spec, evidence };
}

// ── 发现巡检：聚合行 → 去重 → 落 draft 提案 ─────────────────────────

interface QueryRow {
  [key: string]: unknown;
}

function asRows(result: unknown): QueryRow[] {
  if (Array.isArray(result)) {
    return result.filter(isRecord) as QueryRow[];
  }
  if (isRecord(result) && Array.isArray(result.rows)) {
    return (result.rows as unknown[]).filter(isRecord) as QueryRow[];
  }
  return [];
}

function parseProposalContent(content: string): PenetrationProposalContent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(String(content ?? ""));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.action !== "register") return null;
  const spec = raw.spec;
  if (!isRecord(spec)) return null;
  const parent = spec.parent;
  const child = spec.child;
  const inputContract = spec.inputContract;
  const outputContract = spec.outputContract;
  const anchor = spec.anchor;
  const whenToUse = spec.whenToUse;
  const effect = spec.effect;
  if (!nonEmptyString(parent) || !nonEmptyString(child)) return null;
  if (!nonEmptyString(inputContract) || !nonEmptyString(outputContract)) return null;
  if (!nonEmptyString(anchor) || !nonEmptyString(whenToUse) || !nonEmptyString(effect)) return null;
  const path = Array.isArray(spec.path) && spec.path.every((p) => typeof p === "string")
    ? spec.path as string[]
    : undefined;
  return {
    action: "register",
    spec: {
      parent,
      child,
      inputContract,
      outputContract,
      anchor,
      whenToUse,
      effect,
      ...(path ? { path } : {}),
    },
    evidence: {
      calls: 0,
      okCalls: 0,
      okRatio: 0,
      avgSteps: 0,
      avgDurationMs: 0,
      budgetExceeded: 0,
    },
  };
}

export async function discoverPenetrationProposals(deps: PenetrationDiscoveryDeps): Promise<PenetrationDiscoveryResult> {
  const cfg = deps.config ?? readPenetrationDiscoveryConfig();
  const [edgeResult, skillResult, draftResult] = await Promise.all([
    deps.queryReadOnly(`SELECT content FROM memory_entries WHERE kind='${PENETRATION_EDGE_KIND}'`),
    deps.queryReadOnly(`SELECT id FROM memory_entries WHERE id LIKE '${PENETRATION_SKILL_ID_PREFIX}%'`),
    deps.queryReadOnly(`SELECT content FROM memory_entries WHERE kind='${PENETRATION_PROPOSAL_KIND}' AND status='draft'`),
  ]);

  const created: string[] = [];
  const skipped: PenetrationDiscoverySkip[] = [];

  // 已存在条目（含 draft/archived）一律跳过该 child——防重复注册。
  const existingSkillChildren = new Set<string>();
  for (const row of asRows(skillResult)) {
    const id = typeof row.id === "string" ? row.id : "";
    if (id.startsWith(PENETRATION_SKILL_ID_PREFIX)) {
      existingSkillChildren.add(id.slice(PENETRATION_SKILL_ID_PREFIX.length));
    }
  }

  // 同 parent+child 已有 draft 提案则跳过——防重复巡检重复提案。
  const draftKeys = new Set<string>();
  for (const row of asRows(draftResult)) {
    const proposal = parseProposalContent(String(row.content ?? ""));
    if (!proposal) continue;
    draftKeys.add(`${proposal.spec.parent}->${proposal.spec.child}`);
  }

  // 同轮内防重（聚合行理论唯一；这里保守防御脏数据）。
  const createdKeys = new Set<string>();

  for (const row of asRows(edgeResult)) {
    const agg = parseEdgeAggregate(row.content);
    if (!agg) {
      deps.log?.(`[penetration-discovery] 坏行跳过: ${JSON.stringify(row.content).slice(0, 120)}`);
      continue;
    }
    const key = `${agg.parent}->${agg.child}`;
    if (existingSkillChildren.has(agg.child)) {
      skipped.push({ parent: agg.parent, child: agg.child, reason: `已存在 ${PENETRATION_SKILL_ID_PREFIX}${agg.child}（含 draft/archived）` });
      continue;
    }
    if (draftKeys.has(key)) {
      skipped.push({ parent: agg.parent, child: agg.child, reason: "已有 draft penetration-proposal" });
      continue;
    }
    if (createdKeys.has(key)) {
      skipped.push({ parent: agg.parent, child: agg.child, reason: "本轮已创建提案" });
      continue;
    }
    const evaluated = evaluateEdge(agg, cfg);
    if (!evaluated.ok) {
      skipped.push({ parent: agg.parent, child: agg.child, reason: evaluated.reason });
      continue;
    }
    const id = `pp-${randomUUID()}`;
    const proposalContent: PenetrationProposalContent = {
      action: "register",
      spec: evaluated.spec,
      evidence: evaluated.evidence,
    };
    await deps.memory.write({
      id,
      tenantId: DEFAULT_TENANT_ID,
      kind: PENETRATION_PROPOSAL_KIND,
      anchors: ["penetration", agg.parent, agg.child],
      content: JSON.stringify(proposalContent),
      status: "draft",
      meta: { parent: agg.parent, child: agg.child, stage: "proposed", ts: Date.now() },
    });
    created.push(id);
    createdKeys.add(key);
  }

  return { created, skipped };
}

// ── 治理函数（tool-proposal 状态机同构：draft → official → executed）─

async function getProposal(store: PenetrationDiscoveryStore, proposalId: string) {
  const p = await store.get(proposalId, { tenantId: DEFAULT_TENANT_ID });
  if (!p || p.kind !== PENETRATION_PROPOSAL_KIND) return undefined;
  return p;
}

/** 监督批准：仅 draft 可批准 → status official + meta.stage="approved"。 */
export async function approvePenetrationProposal(
  store: PenetrationDiscoveryStore,
  proposalId: string,
): Promise<PenetrationGovernanceResult> {
  const p = await getProposal(store, proposalId);
  if (!p) return { ok: false, error: "penetration 提案不存在或类型不符" };
  if (p.status !== "draft") return { ok: false, error: `提案状态 ${p.status}——仅 draft 可批准` };
  await store.update(proposalId, {
    status: "official",
    meta: { ...(p.meta ?? {}), approvedAt: Date.now(), stage: "approved" },
  }, { tenantId: DEFAULT_TENANT_ID });
  return { ok: true, id: proposalId };
}

/**
 * 执行已批准提案（监督通道）：仅 official 可执行；
 *   - 解析 proposalContent → buildPenetrationSkillContent(spec) 重建内容 →
 *     validatePenetrationSkillRegistration（执行期重验组织权）→
 *     buildPenetrationSkillEntry official 落库；
 *   - 已存在 official `skill:penetrate:<child>` → 拒绝（注册幂等防覆盖）。
 */
export async function executeApprovedPenetrationProposal(
  store: PenetrationDiscoveryStore,
  proposalId: string,
): Promise<PenetrationGovernanceResult> {
  const p = await getProposal(store, proposalId);
  if (!p || p.status !== "official") return { ok: false, error: "提案不存在或未批准" };
  const proposal = parseProposalContent(p.content);
  if (!proposal) return { ok: false, error: "提案 content 非法：无法解析 penetration-proposal JSON" };
  const content = buildPenetrationSkillContent(proposal.spec);
  const validated = validatePenetrationSkillRegistration(content);
  if (!validated.ok) return { ok: false, error: `穿透 skill 注册校验失败：${validated.error}` };
  const skillId = `${PENETRATION_SKILL_ID_PREFIX}${validated.child}`;
  const existing = await store.get(skillId, { tenantId: DEFAULT_TENANT_ID });
  if (existing && existing.status === "official") {
    return { ok: false, error: `已存在 official ${skillId}——注册幂等防覆盖（修订不在本批）` };
  }
  const entry = buildPenetrationSkillEntry(content, { status: "official" });
  await store.write({
    ...entry,
    tenantId: DEFAULT_TENANT_ID,
    meta: { ...entry.meta, registeredAt: Date.now(), proposalId },
  }, { force: true });
  await store.update(proposalId, {
    meta: { ...(p.meta ?? {}), executedAt: Date.now(), stage: "executed" },
  }, { tenantId: DEFAULT_TENANT_ID });
  return { ok: true, id: entry.id };
}

// ── 主进程轻量 service（assembly 装配）──────────────────────────────

export function readPenetrationDiscoveryConfig(): PenetrationDiscoveryConfig {
  return {
    minCalls: pthConfig().num("PTH_PENETRATION_DISCOVERY_MIN_CALLS"),
    minOkRatio: pthConfig().num("PTH_PENETRATION_DISCOVERY_MIN_OK_RATIO"),
    maxAvgSteps: pthConfig().num("PTH_PENETRATION_DISCOVERY_MAX_AVG_STEPS"),
  };
}

export function createPenetrationDiscoveryService(deps: {
  queryReadOnly: PenetrationDiscoveryDeps["queryReadOnly"];
  memory: PenetrationDiscoveryDeps["memory"];
  log?: (msg: string) => void;
}): { discover: () => Promise<PenetrationDiscoveryResult> } {
  return {
    discover: () => discoverPenetrationProposals({
      queryReadOnly: deps.queryReadOnly,
      memory: deps.memory,
      log: deps.log,
      config: readPenetrationDiscoveryConfig(),
    }),
  };
}
