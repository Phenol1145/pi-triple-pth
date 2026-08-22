/**
 * memory-store-support.ts —— PgMemoryStore 支持类型/常量/错误（Phase D D4 拆分）。
 */

import type pg from "pg";
import { OFFICIAL_KNOWLEDGE_GATED_KINDS } from "./knowledge-provenance.js";

export const DEFAULT_TENANT_ID = "default";

/** 稳定 JSON 序列化（递归按键排序）——对齐 jsonb 等值语义（jsonb 比较忽略键序）。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** write 变更判据：剥离系统生成键 updatedAt 后的 effective meta（version 参与比较，由本方法重写）。 */
export function effectiveMetaForCompare(meta: Record<string, unknown> | undefined): string {
  const copy = { ...(meta ?? {}) };
  delete copy.updatedAt;
  return stableStringify(copy);
}

/**
 * write 的统一物化变更判据：content 不同 OR status 不同（缺省 official 归一）OR effective meta
 * 不同。write 内「是否写 history」与 UPSERT 的「是否 version+1」必须使用同一判据。
 */
export function isSameMaterializedState(
  old: { content: string; status: string; meta: Record<string, unknown> },
  entry: MemoryEntry,
): boolean {
  return old.content === entry.content
    && old.status === (entry.status ?? "official")
    && effectiveMetaForCompare(old.meta) === effectiveMetaForCompare(entry.meta);
}

/**
 * MemoryEntry —— 对齐 memory v1 entry.ts 结构（extensions/agent-lab/src/memory/entry.ts）。
 * 列映射：ruleRef→rule_ref、idempotencyKey→idempotency_key、promotedFrom→promoted_from、
 * ttlExpiresAt→ttl_expires_at（epoch ms）、meta 内嵌 version/hitCount/notWriteBack（从独立列并入）。
 */
export interface MemoryEntry {
  id: string;
  /** 租户 id（不强制——存量调用缺省 DEFAULT_TENANT_ID）。 */
  tenantId?: string;
  kind: string;
  anchors: string[];
  content: string;
  ruleRef?: string;
  idempotencyKey?: string;
  /**
   * N29 Task 6：新增 `stale`——official 绑定的来源发生实质变化、或其 policy/subscription 被撤销后
   * 的「已撤出 authoritative 面」态。stale 不出现在默认权威检索（Broker/Context 固定 official），
   * 但 `revisionHistory()` 与 `getAsOf()` 仍可读到它 official 时期的正文。
   */
  status: "draft" | "official" | "archived" | "stale";
  ttlExpiresAt?: number;
  promotedFrom?: string;
  meta: Record<string, unknown>;
}

/** append-only revision 行（memory_revisions 映射——N19 Phase 1b 设计 2.2）。 */
export interface MemoryRevision {
  entryId: string;
  tenantId: string;
  revision: number;
  content: string;
  status: MemoryEntry["status"];
  anchors: string[];
  meta: Record<string, unknown>;
  createdAt: string;
  createdBy?: string;
  reason?: string;
}

/** write opts：force=系统通道；createdBy/reason=revision 历史记录（N19 Phase 1b 设计 2.3）。 */
export interface PgMemoryStoreWriteOptions {
  force?: boolean;
  createdBy?: string;
  reason?: string;
  /**
   * N29/P0-4：official 领域知识（PROVENANCE_REQUIRED_KINDS）直写授权。
   * 与 worker capability 完全分离——只有 seed/migration 与 promotion 内部路径可以出示；
   * 缺省（含 `force: true` 的系统文档通道）一律 fail closed。
   */
  knowledgeOfficialAuthority?: KnowledgeOfficialAuthority;
}

/** update opts：force=skill 维护通道；createdBy/reason=update revision 历史记录（F1 6.3）。 */
export interface PgMemoryStoreUpdateOptions {
  force?: boolean;
  tenantId?: string;
  createdBy?: string;
  reason?: string;
  /** N29/P0-4：official 领域知识状态流转授权（同 write；缺省 fail closed）。 */
  knowledgeOfficialAuthority?: KnowledgeOfficialAuthority;
}

/**
 * N29/P0-4（§1.6 / §2.4 G0）+ N29 再验收 P0-5：official 知识的内部写授权。
 *
 * 只有三类持有者：
 *  - `"promotion-service"`：Promotion Service 的窄 CAS 路径（`promoteOfficial()`）；
 *  - `"seed-migration"`：bootstrap seed / 数据迁移脚本（与 worker capability 分离的内部通道）；
 *  - `"internal-reasoning"`：**无外部 SourceRevision** 的内部推理产物（如 optimizer deopt 洞察）。
 *    再验收反馈 §3 P0-5 关闭条件 3 要求："内部推理知识若无需外部 SourceRevision，也必须使用
 *    显式 `origin=internal` 的独立 verification contract，不能以空 digest 兼容路径表示可信"——
 *    因此该 authority **额外**要求 `meta.origin === "internal"` 且带有效 `meta.provenance`
 *    （见 `INTERNAL_ORIGIN`）。它不能用于外部信源知识（那必须走 Promotion Service）。
 *
 * 普通 `memory.write` / store write（含 service 与 platform-admin service 调用）不出示 authority
 * → 一律拒绝写 official 知识；`force: true`（系统文档通道）不是 authority，不构成旁路。
 * capability facade（`withMemoryTenant`）会剥离本字段，worker/service 面永远拿不到。
 */
export type KnowledgeOfficialAuthority = "promotion-service" | "seed-migration" | "internal-reasoning";

/** N29 再验收 P0-5：`internal-reasoning` 授权要求的显式来源标记（`meta.origin`）。 */
export const INTERNAL_ORIGIN = "internal";

/** official 领域知识直写被拒的统一错误前缀（测试与调用方据此断言）。 */
export const KNOWLEDGE_OFFICIAL_WRITE_DENIED = "memory: knowledge official 直写被拒绝";

/** N29 Task 6：知识条目「已撤出 authoritative 面」的状态字面量（唯一事实源）。 */
export const STALE_KNOWLEDGE_STATUS = "stale" as const;

/**
 * N29 Task 6：默认权威检索的状态集合。Broker/Context 固定消费本集合，
 * 因此新增的 `stale` 一旦落库即刻退出 authoritative retrieval（plan §2.4 G6/G7）。
 */
export const AUTHORITATIVE_KNOWLEDGE_STATUSES: readonly string[] = ["official"];

/** markKnowledgeStale 选项：与 promotion 对称的内部 authority + 同事务 outbox 钩子。 */
export interface PgMemoryStoreMarkStaleOptions {
  /** 撤出原因（写入 meta.stale.reason 与 revision.reason）。 */
  reason: "source-changed" | "policy-revoked" | "subscription-revoked" | (string & {});
  /** 触发撤出的（旧）Source Revision id——审计用。 */
  sourceRevisionId?: string;
  /** 取代它的新 Source Revision id（变化重爬时可用）。 */
  supersededByRevisionId?: string;
  createdBy?: string;
  /** N29/P0-4：PROVENANCE_REQUIRED_KINDS 必须出示；缺省 fail closed。 */
  knowledgeOfficialAuthority?: KnowledgeOfficialAuthority;
  /** 同一事务内入队依赖刷新 outbox（CAS 回滚时 outbox 一并回滚）。 */
  enqueueOutbox?: (client: pg.PoolClient) => Promise<void>;
}

export interface PgMemoryStoreMarkStaleResult {
  disposition: "marked-stale" | "already-stale" | "not-official" | "not-found";
  id: string;
  status: MemoryEntry["status"] | undefined;
}

/**
 * N29/P0-4 + 再验收 P0-5：判定"是否受 official 知识写授权约束"的唯一事实源。
 * 集合从 `PROVENANCE_REQUIRED_KINDS` 扩到 `OFFICIAL_KNOWLEDGE_GATED_KINDS`
 * （补 task-insight / tool-function——报告 §2.3 的 rawStoreOfficial 反例）。
 */
export function requiresKnowledgeOfficialAuthority(kind: string, status: string | undefined): boolean {
  return (status ?? "official") === "official" && OFFICIAL_KNOWLEDGE_GATED_KINDS.has(kind);
}

export function denyKnowledgeOfficialWrite(kind: string, op: "write" | "update" | "incrementAggregate" | "markStale"): never {
  throw new Error(
    `${KNOWLEDGE_OFFICIAL_WRITE_DENIED}（${op} kind="${kind}"）——`
    + `外部内容与普通写侧只能产出 private draft candidate；official 只能由 Promotion Service `
    + `的 promoteOfficial() 在 VerificationPlan + 双 verdict + exact hash 满足后晋升`
    + `（seed/migration 请出示 knowledgeOfficialAuthority）`,
  );
}

/** promotion CAS 冲突——结构化错误（不静默返回 ok）。 */
export class PromotionConflictError extends Error {
  readonly code = "PROMOTION_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "PromotionConflictError";
  }
}

/** promotion CAS 写进 meta.promotion 的内容（verdicts 由 store 在锁内从旧行补全）。 */
export interface PgMemoryStorePromotionMeta {
  promotedBy: string;
  principalId?: string;
  note?: string;
  promotedAt: number;
  verdicts?: unknown;
}

/** N29 再验收 P0-5：promoteOfficial 缺少 evaluator 时的统一错误文案（测试与调用方据此断言）。 */
export const PROMOTION_EVALUATOR_REQUIRED =
  "memory.promoteOfficial: evaluator required（evaluate 或 evaluateAsync 必填）——"
  + "official 晋升门禁不可省略：无 evaluator 的晋升等于无核验直写 official"
  + "（N29 再验收 P0-5 / §8 条件 6）";

/** promoteOfficial 选项：evaluate 在锁内基于旧行重算晋升门禁；enqueueOutbox 在同一事务执行。
 *  R3/P0-3：evaluateAsync 接收同一事务 client，供 service 在锁内重读持久 plan/verdict rows 后再判定。
 *  N29 再验收 P0-5：`evaluate` / `evaluateAsync` **至少必须提供一个**（二者皆缺 → 写前抛错）。 */
export interface PgMemoryStorePromoteOfficialOptions {
  createdBy?: string;
  reason?: string;
  evaluate?: (entry: MemoryEntry) => { ok: true } | { ok: false; reason: string };
  evaluateAsync?: (entry: MemoryEntry, client: pg.PoolClient) => Promise<{ ok: true } | { ok: false; reason: string }>;
  enqueueOutbox?: (client: pg.PoolClient) => Promise<void>;
}

/**
 * PgMemoryStore —— memory v1 MemoryStore 接口的 pg 实现（接口保留、实现替换）。
 *
 * 与 FS 实现（tmp+rename 原子写 / 文件索引）的语义对齐点：
 * - write：upsert；同 id 已存在（新状态）→ version+1（CAS 语义）；
 * - retrieve：锚点检索用 GIN 索引 + `?|`（jsonb 任一包含，pg 16 已验证），多锚点 = 并集（对齐 FS 索引语义）；
 * - bumpHitCount：独立列 hit_count 旁路 UPDATE，不触发 version 递增（对齐 FS 独立计数器文件）；
 * - 返回按 id 字典序稳定排序（DSP 快照确定性，对齐 FS retrieve 的 sort）。
 *
 * 适配说明（brief 骨架的两处修正，均已在 pg16 实测）：
 * - `anchors ?| $n::jsonb` 不存在该操作符（jsonb ?| 右操作数为 text[]）→ 改为 `?| $n::text[]` 传原始数组；
 * - write 的 status 参数必须显式 `?? "official"`（测试条目多不传 status；node-pg 把 undefined 序列化为
 *   NULL，而 memory_entries.status 为 NOT NULL → 不默认会直接违反约束）。
 * 幂等与 meta 合并（对齐 FS write 路径②③，见 task-4-report fix 段）：
 * - 路径②「同 version+同 content」幂等重落库不递增版本（watermark 旁路）；判断取调用方声明的版本：
 *   `meta->>'version' = EXCLUDED.meta->>'version'`（FS 等价：entry.meta.version === existing.meta.version）；
 * - 路径②③冲突时合并调用方 meta：`memory_entries.meta || EXCLUDED.meta || {version, updatedAt}`
 *   （FS 等价：{...existing.meta, ...(entry.meta ?? {}), version, updatedAt, hitCount} 整条写回）。
 * 遗留差异（见 task-4-report 疑虑）：update 仅更新 content/status（brief 骨架），anchors/kind 变更请走 write。
 */
export const REQUIRE_TENANT_ERROR = "memory: tenantId required（TenantScope fail-closed）";

