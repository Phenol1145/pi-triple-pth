/**
 * knowledge-intake/support.ts —— PgKnowledgeIntakeRepository 的支持类型/错误/内部工具。
 *
 * 从 knowledge-intake-pg.ts 拆出（Phase D D4）：只包含 PG 实现专属错误、选项、
 * 迁移矩阵与 SQL 帮助函数；不包含仓库类主体。
 */

import { createHash } from "node:crypto";
import type {
  IntakeAttempt,
  IntakeAttemptDisposition,
  IntakeRun,
  IntakeRunStage,
  IntakeSideEffect,
  MarkDependentsStaleInput,
  PolicyDecisionRef,
  SourceDependency,
  SourceDependencyInput,
  SourceRevision,
  SourceSubscription,
  SubscriptionStatus,
  TrustPolicyManifest,
  VerifiedTrustPolicy,
} from "@away_from/pth-contracts";

export class KnowledgeIntakeConflictError extends Error {
  readonly code = "KNOWLEDGE_INTAKE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIntakeConflictError";
  }
}

/**
 * 校验失败的具体不变量（N29 再验收 P0-4：feedback §3 P0-4 / §8 条件 4）。
 *
 * 每个 code 对应一条**单一**领域不变量，让"被错误内部调用者直接调用"的对抗测试能够
 * 逐项钉住（而不是只断言"抛了个错"）。`KNOWLEDGE_INTAKE_INVALID` 是历史缺省码。
 */
export type KnowledgeIntakeValidationCode =
  | "KNOWLEDGE_INTAKE_INVALID"
  /** artifact 自报 rawHash ≠ sha256(rawBytes)（服务端重算不通过）。 */
  | "ARTIFACT_RAW_HASH_MISMATCH"
  /** artifact 自报 byteLength ≠ rawBytes.byteLength。 */
  | "ARTIFACT_BYTE_LENGTH_MISMATCH"
  /** 复用既有 artifact 的 revision（304 unchanged）找不到该 rawHash 的 artifact 行。 */
  | "ARTIFACT_NOT_FOUND"
  /** revision 自报 normalizedTextHash ≠ sha256(normalizedText)。 */
  | "REVISION_NORMALIZED_TEXT_HASH_MISMATCH"
  /** revision 引用的 Subscription 在本 tenant 内不存在。 */
  | "SUBSCRIPTION_NOT_FOUND"
  /** admitted 缺少 usePolicyDecision。 */
  | "ADMITTED_USE_DECISION_MISSING"
  /** admitted 的 usePolicyDecision.decision ≠ allow。 */
  | "ADMITTED_USE_DECISION_NOT_ALLOW"
  /** admitted 缺少 derivedFromRevisionId（无 raw→admitted 关联）。 */
  | "ADMITTED_PARENT_REQUIRED"
  /** admitted 的父 revision 在本 tenant 内不存在（含跨 tenant 引用）。 */
  | "ADMITTED_PARENT_NOT_FOUND"
  /** admitted 的父 revision disposition ≠ raw-quarantine。 */
  | "ADMITTED_PARENT_NOT_QUARANTINE"
  /** admitted 的父 revision 属于另一个 subscription。 */
  | "ADMITTED_PARENT_SUBSCRIPTION_MISMATCH"
  /** policy decision 结构不完整（缺 policyId/version/digest/ruleId 或非法 decision）。 */
  | "POLICY_DECISION_MALFORMED"
  /** policy decision 的 policy/rule 绑定与 Subscription 不一致。 */
  | "POLICY_DECISION_BINDING_MISMATCH"
  /** decision 绑定的 policy 在本 tenant 没有已验签审计镜像（或 digest 不符）。 */
  | "POLICY_NOT_INSTALLED"
  /** 已装策略的 spaces 不覆盖 Subscription 的 space。 */
  | "POLICY_SPACE_MISMATCH"
  /** 已装策略在 acquisition 时刻不在有效期内。 */
  | "POLICY_NOT_VALID_NOW"
  /** admitted 的 fetch decision ≠ allow（字节本不该被取回）。 */
  | "FETCH_DECISION_NOT_ALLOW";

/** 输入不满足 append-only / 策略绑定 / hash 可重算前置条件（写前 fail closed，零行）。 */
export class KnowledgeIntakeValidationError extends Error {
  readonly code: KnowledgeIntakeValidationCode;
  constructor(message: string, code: KnowledgeIntakeValidationCode = "KNOWLEDGE_INTAKE_INVALID") {
    super(message);
    this.name = "KnowledgeIntakeValidationError";
    this.code = code;
  }
}

/**
 * 注入式验签器（P0-3 approach A）：把 raw manifest 变成带运行时 attestation 的已验证策略。
 * 生产实现是 `loadVerifiedTrustPolicy(manifest, keyring)` 的闭包（keyring 只读、私钥永不入进程）。
 */
export type VerifiedTrustPolicyVerifier = (manifest: TrustPolicyManifest) => Promise<VerifiedTrustPolicy>;

/**
 * 阶段提交的 lease 门禁（§8 条件 7 / G10 lease sabotage 注入缝）。
 * `transitionRun()` 在**同一事务内 FOR UPDATE 锁定 run 行后**调用 `canCommit()` 判定
 * `locked_until` 是否仍有效；stage/token/generation/rowVersion/status 的 CAS 谓词仍留在
 * UPDATE 语句里，不因注入而放宽。缺省严格实现：lease 必须存在且未过期，否则零行、零 attempt、
 * 零 outbox。仅 G10 sabotage 测试注入恒 true 实现以证明 `expiredLease` sentinel 会翻红。
 */
export interface IntakeRunLeaseCommitInput {
  readonly lockedUntil: Date | null;
  readonly now: Date;
}

export interface IntakeRunLeaseGuard {
  canCommit(input: IntakeRunLeaseCommitInput): boolean;
}

export const STRICT_INTAKE_RUN_LEASE_GUARD: Readonly<IntakeRunLeaseGuard> = Object.freeze({
  canCommit: (input: IntakeRunLeaseCommitInput) =>
    input.lockedUntil !== null && input.lockedUntil.getTime() > input.now.getTime(),
});

export interface KnowledgeIntakeRepositoryOptions {
  /** run lease 默认有效期（毫秒，默认 5 分钟）。 */
  leaseTtlMs?: number;
  /** due scanner 默认 outbox kind（默认 "intake.fetch"）。 */
  fetchOutboxKind?: string;
  /**
   * 可选注入验签器（生产装配必须注入）：安装时用 read-only keyring **重新验签** raw manifest，
   * attestation 只能由验签器产出；未注入时则要求输入自带 `loadVerifiedTrustPolicy()` 的运行时
   * attestation。两种配置下伪造 signature/digest 都不可能被写成"已验证"。
   */
  policyVerifier?: VerifiedTrustPolicyVerifier;
  /**
   * 可选注入的阶段提交 lease 门禁（缺省 = `STRICT_INTAKE_RUN_LEASE_GUARD`）。生产组合必须省略；
   * 仅 G10 sabotage 敏感度测试注入恒 true 门禁，证明移除 lease 门禁后 `expiredLease` sentinel 翻红。
   */
  leaseGuard?: IntakeRunLeaseGuard;
}

// ---------------------------------------------------------------- 内部工具

export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
export const DEFAULT_FETCH_OUTBOX_KIND = "intake.fetch";
/** policy 安装的纵深防御常量（授权只可能来自人类签名 manifest）。 */
export const HUMAN_PRINCIPAL_KIND = "human";
export const HUMAN_POLICY_ISSUER = "ptl-human-interface";
export const SIGNED_MANIFEST_METHOD = "signed-manifest";
/** run 未终结（可被 claim / 计入 open run 唯一性）的状态。 */
export const OPEN_RUN_STATUSES = ["queued", "leased", "waiting"] as const;
/** due scanner 只扫这两种状态：probing = 首轮 initial，active = 周期 scheduled。 */
export const DUE_SCAN_STATUSES = ["probing", "active"] as const;

/**
 * subscription 合法迁移矩阵。
 *  - 非终态（probing/active/paused）允许 **同状态自迁移**：用于在不改状态的前提下 CAS 更新
 *    `next_crawl_at`（重爬调度真相）与 `last_successful_revision_id`；
 *  - revoked 只能 retire，retired 不可再迁移；两者都不允许自迁移（终态字段冻结）。
 */
export const SUBSCRIPTION_TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  probing: ["probing", "active", "paused", "revoked", "retired"],
  active: ["active", "paused", "revoked", "retired"],
  paused: ["paused", "active", "revoked", "retired"],
  revoked: ["retired"],
  retired: [],
};

/** 允许迁移到 `to` 的来源状态集合（写进 SQL 的 `status = ANY(...)`）。 */
export function allowedFromStatuses(to: SubscriptionStatus): string[] {
  return (Object.keys(SUBSCRIPTION_TRANSITIONS) as SubscriptionStatus[]).filter((from) =>
    SUBSCRIPTION_TRANSITIONS[from].includes(to),
  );
}

/**
 * N29 再验收 P0-1：side effect 的 tenant 必须等于聚合 tenant（或缺省由仓库盖章）。
 * 任何不相等值都是编排缺陷/跨租户越权——fail closed 抛错，绝不静默改写成聚合 tenant。
 */
export function assertSideEffectTenants(
  aggregateTenantId: string,
  sideEffects?: readonly IntakeSideEffect[],
): void {
  for (const se of sideEffects ?? []) {
    if (se.tenantId !== undefined && se.tenantId !== aggregateTenantId) {
      throw new KnowledgeIntakeValidationError(
        `transitionRun: side effect "${se.key}" 自报 tenant "${se.tenantId}" 与 run 聚合 tenant `
        + `"${aggregateTenantId}" 不一致——跨 tenant 入队不允许（tenant 由仓库按聚合上下文盖章）`,
      );
    }
  }
}

export function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** N29 再验收 P0-4：所有落库 hash 必须由服务端重算（自报值只作 tripwire）。 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data instanceof Uint8Array ? Buffer.from(data) : data).digest("hex");
}

/** policy decision 的结构完备性（缺字段 / 非法 decision 一律写前 fail closed）。 */
export function assertPolicyDecisionShape(decision: PolicyDecisionRef, label: string): void {
  const missing = (["policyId", "policyVersion", "policyDigest", "ruleId"] as const).filter(
    (k) => typeof decision[k] !== "string" || decision[k].trim() === "",
  );
  if (missing.length > 0) {
    throw new KnowledgeIntakeValidationError(
      `storeAcquisition: ${label} 缺少 ${missing.join("/")}`,
      "POLICY_DECISION_MALFORMED",
    );
  }
  if (decision.decision !== "allow" && decision.decision !== "deny") {
    throw new KnowledgeIntakeValidationError(
      `storeAcquisition: ${label}.decision 只能是 allow|deny（收到 ${String(decision.decision)}）`,
      "POLICY_DECISION_MALFORMED",
    );
  }
}

/**
 * N29 再验收 P0-4：decision 的 policy/rule 绑定必须与 Subscription 完全一致。
 * Subscription 是"人类策略 → 具体来源"的授权绑定；decision 换 policy/rule 等于换授权。
 */
export function assertDecisionMatchesSubscription(label: string, decision: PolicyDecisionRef, subscription: Row): void {
  const pairs: readonly (readonly [string, unknown, unknown])[] = [
    ["policyId", decision.policyId, subscription.policy_id],
    ["policyVersion", decision.policyVersion, subscription.policy_version],
    ["policyDigest", decision.policyDigest, subscription.policy_digest],
    ["ruleId", decision.ruleId, subscription.policy_rule_id],
  ];
  for (const [field, actual, expected] of pairs) {
    if (actual !== expected) {
      throw new KnowledgeIntakeValidationError(
        `storeAcquisition: ${label}.${field}=${String(actual)} 与 Subscription 绑定的`
          + ` ${String(expected)} 不一致——admitted revision 的策略绑定必须与订阅一致`,
        "POLICY_DECISION_BINDING_MISMATCH",
      );
    }
  }
}

export function toTimestamp(value: Date | string | null | undefined): string | null {
  return iso(value) ?? null;
}

/** lease token 只以 sha256 摘要落 attempt 审计行（明文只回给持有者）。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * dependency append-only INSERT（pool 与事务 client 共用同一条 SQL——语义不分叉）。
 *
 * N29 再验收 P0-4（§3 P0-4 关闭条件："所有 repository 公共写口都必须按'被错误内部调用者
 * 直接调用'进行对抗测试"）：依赖边把 official 知识 / candidate 绑到一条不可变来源 revision 上，
 * 因此写前必须对账「该 revision 属同 tenant + 同 subscription 且已准入」——绑到
 * raw-quarantine（未准入字节）或跨 subscription 的 revision 都是错误持久状态。
 */
export async function insertDependency(executor: SqlExecutor, input: SourceDependencyInput): Promise<void> {
  const revision = await executor.query(
    `SELECT subscription_id, disposition FROM knowledge_source_revisions
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.sourceRevisionId],
  );
  if ((revision.rowCount ?? 0) !== 1) {
    throw new KnowledgeIntakeValidationError(
      `recordDependency: source revision ${input.sourceRevisionId} 在 tenant=${input.tenantId} 不存在`,
      "ADMITTED_PARENT_NOT_FOUND",
    );
  }
  const revisionRow = revision.rows[0] as Row;
  if (revisionRow.subscription_id !== input.subscriptionId) {
    throw new KnowledgeIntakeValidationError(
      `recordDependency: source revision ${input.sourceRevisionId} 属于 subscription`
        + ` ${String(revisionRow.subscription_id)}，与本次 ${input.subscriptionId} 不一致`,
      "ADMITTED_PARENT_SUBSCRIPTION_MISMATCH",
    );
  }
  if (revisionRow.disposition !== "admitted" && revisionRow.disposition !== "unchanged") {
    throw new KnowledgeIntakeValidationError(
      `recordDependency: 依赖边不得绑定 disposition=${String(revisionRow.disposition)} 的 revision`
        + "（只有 admitted / unchanged 是已准入来源）",
      "ADMITTED_PARENT_NOT_QUARANTINE",
    );
  }
  await executor.query(
    `INSERT INTO knowledge_source_dependencies
       (tenant_id, subscription_id, source_revision_id, dependent_kind, dependent_id,
        dependent_revision, space, evidence_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, dependent_kind, dependent_id, source_revision_id) DO NOTHING`,
    [
      input.tenantId,
      input.subscriptionId,
      input.sourceRevisionId,
      input.dependentKind ?? "knowledge-entry",
      input.dependentId,
      input.dependentRevision ?? null,
      input.space ?? "",
      input.evidenceDigest ?? "",
    ],
  );
}

/**
 * N29 Task 6：被标记 stale 的依赖边（`markDependentsStale*` 的富返回行）。
 * service 只对 `dependentKind === "knowledge-entry"` 的行去撤出对应 official 知识条目。
 */
export interface StaleDependentRow {
  readonly dependentId: string;
  readonly dependentKind: "knowledge-entry" | "candidate";
  readonly sourceRevisionId: string;
  readonly space: string;
}

/**
 * stale 标记的唯一实现（pool 与事务 client 共用同一条 SQL——语义不分叉）。
 * `exceptSourceRevisionId` 用于变化重爬：**新** revision 自己的依赖边不得被标 stale。
 */
export async function markDependentsStaleRows(
  executor: SqlExecutor,
  input: MarkDependentsStaleInput,
): Promise<readonly StaleDependentRow[]> {
  const res = await executor.query(
    `UPDATE knowledge_source_dependencies
        SET stale = true,
            stale_at = now(),
            stale_reason = $3,
            row_version = row_version + 1
      WHERE tenant_id = $1 AND subscription_id = $2 AND stale = false
        AND ($4::text IS NULL OR source_revision_id <> $4::text)
      RETURNING dependent_id, dependent_kind, source_revision_id, space`,
    [input.tenantId, input.subscriptionId, input.reason, input.exceptSourceRevisionId ?? null],
  );
  return (res.rows as Row[]).map((r) => ({
    dependentId: r.dependent_id as string,
    dependentKind: r.dependent_kind as StaleDependentRow["dependentKind"],
    sourceRevisionId: r.source_revision_id as string,
    space: (r.space as string) ?? "",
  }));
}

export function mapSubscription(r: any): SourceSubscription {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    space: r.space,
    canonicalUri: r.canonical_uri,
    domainId: r.domain_id,
    status: r.status,
    policyId: r.policy_id,
    policyVersion: r.policy_version,
    policyDigest: r.policy_digest,
    policyRuleId: r.policy_rule_id,
    recrawlIntervalMs: Number(r.recrawl_interval_ms),
    nextCrawlAt: new Date(r.next_crawl_at).toISOString(),
    ...(r.last_successful_revision_id ? { lastSuccessfulRevisionId: r.last_successful_revision_id } : {}),
    rowVersion: Number(r.row_version),
  };
}

export function mapRun(r: any): IntakeRun {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workMode: "intake",
    subscriptionId: r.subscription_id,
    reason: r.reason,
    stage: r.stage,
    status: r.status,
    attempt: Number(r.attempt),
    ...(r.lease_token ? { leaseToken: r.lease_token } : {}),
    leaseGeneration: Number(r.lease_generation),
    ...(r.locked_until ? { lockedUntil: new Date(r.locked_until).toISOString() } : {}),
    ...(r.source_revision_id ? { sourceRevisionId: r.source_revision_id } : {}),
    ...(r.candidate_id ? { candidateId: r.candidate_id } : {}),
    ...(r.verification_plan_id ? { verificationPlanId: r.verification_plan_id } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    rowVersion: Number(r.row_version),
  };
}

export function mapRevision(r: any): SourceRevision {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    subscriptionId: r.subscription_id,
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.previous_revision_id ? { previousRevisionId: r.previous_revision_id } : {}),
    ...(r.derived_from_revision_id ? { derivedFromRevisionId: r.derived_from_revision_id } : {}),
    requestedUri: r.requested_uri,
    finalUri: r.final_uri,
    redirectChain: Array.isArray(r.redirect_chain) ? r.redirect_chain : [],
    acquiredAt: new Date(r.acquired_at).toISOString(),
    responseStatus: Number(r.response_status),
    contentType: r.content_type,
    ...(r.etag ? { etag: r.etag } : {}),
    ...(r.last_modified ? { lastModified: r.last_modified } : {}),
    artifactId: r.artifact_id,
    rawHash: r.raw_hash,
    normalizedTextHash: r.normalized_text_hash,
    normalizedText: r.normalized_text,
    disposition: r.disposition,
    fetchPolicyDecision: r.fetch_policy_decision,
    ...(r.use_policy_decision ? { usePolicyDecision: r.use_policy_decision } : {}),
  };
}

export function mapAttempt(r: any): IntakeAttempt {
  return {
    runId: r.run_id,
    tenantId: r.tenant_id,
    stage: r.stage,
    attempt: Number(r.attempt),
    leaseGeneration: Number(r.lease_generation),
    leaseTokenHash: r.lease_token_hash,
    inputHash: r.input_hash ?? "",
    ...(r.output_hash ? { outputHash: r.output_hash } : {}),
    disposition: r.disposition,
    principalId: r.principal_id,
    executionId: r.execution_id,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function mapDependency(r: any): SourceDependency {
  return {
    tenantId: r.tenant_id,
    subscriptionId: r.subscription_id,
    sourceRevisionId: r.source_revision_id,
    dependentKind: r.dependent_kind,
    dependentId: r.dependent_id,
    ...(r.dependent_revision === null || r.dependent_revision === undefined
      ? {}
      : { dependentRevision: Number(r.dependent_revision) }),
    space: r.space,
    evidenceDigest: r.evidence_digest,
    stale: r.stale === true,
    ...(r.stale_at ? { staleAt: new Date(r.stale_at).toISOString() } : {}),
    ...(r.stale_reason ? { staleReason: r.stale_reason } : {}),
    rowVersion: Number(r.row_version),
  };
}

export const RUN_COLUMNS = `tenant_id, id, subscription_id, reason, stage, status, attempt, lease_token,
  lease_generation, locked_until, source_revision_id, candidate_id, verification_plan_id,
  last_error, row_version`;

export const REVISION_COLUMNS = `tenant_id, id, subscription_id, run_id, previous_revision_id,
  derived_from_revision_id, requested_uri, final_uri, redirect_chain, acquired_at, response_status,
  content_type, etag, last_modified, artifact_id, raw_hash, normalized_text_hash, normalized_text,
  disposition, fetch_policy_decision, use_policy_decision`;

/** pg 行类型（@types/pg 默认 unknown）：本文件所有 SELECT/RETURNING 行都经 map* 归一化后出栈。 */
export type Row = Record<string, any>;

/** 最小 SQL 执行面（pg.Pool / pg.PoolClient 通用）。 */
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: any[] }>;
}

/** attempt 审计行（append-only）；同 identity 重放不新增行。 */
export async function insertAttempt(
  db: SqlExecutor,
  row: {
    tenantId: string;
    runId: string;
    stage: IntakeRunStage;
    attempt: number;
    leaseGeneration: number;
    leaseToken: string;
    inputHash: string;
    outputHash?: string;
    disposition: IntakeAttemptDisposition;
    principalId: string;
    executionId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_intake_attempts
       (tenant_id, run_id, stage, attempt, lease_generation, lease_token_hash, input_hash,
        output_hash, disposition, principal_id, execution_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, run_id, stage, attempt, lease_generation, disposition) DO NOTHING`,
    [
      row.tenantId,
      row.runId,
      row.stage,
      row.attempt,
      row.leaseGeneration,
      hashToken(row.leaseToken),
      row.inputHash,
      row.outputHash ?? null,
      row.disposition,
      row.principalId,
      row.executionId,
    ],
  );
}

// ---------------------------------------------------------------- 仓库实现

