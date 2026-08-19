/**
 * kernel/storage/knowledge-intake-pg.ts — N29 Task 3：知识摄入内环的 PG 真相源仓库。
 *
 * 职责边界：本文件只做 **持久化 + CAS + 事务**；不做签名校验、不做 HTTP、不做 LLM、
 * 不做 use-policy 判定。授权事实源仍是人类签名 Trust Policy manifest 与 PTL human proof；
 * `installVerifiedPolicy()` 只写"已验签 manifest 的不可变审计镜像"，DB 行不能创建、扩大或替换 policy。
 *
 * 关键不变量（plan §2 Global Constraints / §3.2 / §5 Task 3）：
 *  - 所有查询与 CAS 一律 tenant-scoped；跨 tenant 读零可见、写零行。
 *  - subscription / run / dependency 是可变聚合：迁移必须携带 expected `rowVersion`（CAS）。
 *  - run 迁移必须同时满足：`tenant + id + stage(= fromStage) + lease_token + lease_generation + rowVersion`
 *    且 lease 未过期，并命中冻结迁移矩阵 `RUN_STAGE_TRANSITIONS`；任一不符 → 零行、零 side effect
 *    （N29 再验收 P0-2：docs/pth/n29-minimal-intake-reacceptance-feedback.md §3 P0-2）。
 *  - side effect 的 outbox tenant 由聚合上下文盖章（CAS RETURNING 的 run.tenant_id），
 *    调用方自报不同 tenant → 写前 fail closed 抛错并整体回滚（N29 再验收 P0-1）。
 *  - 状态迁移与下一阶段 outbox 必须同一事务：`enqueueSideEffectInTx()`（L1，identity=(tenant_id,key)）
 *    只在 CAS `rowCount === 1` 之后调用；outbox conflict 抛错 → 整个事务回滚。
 *  - due scanner：`FOR UPDATE SKIP LOCKED` 选 due subscription，同事务建 run + 推进
 *    `next_crawl_at` + enqueue `intake.fetch`；`uq_knowledge_intake_runs_open_subscription`
 *    是第二道防线（同 subscription 同时只允许一个未终结 run）。
 *  - artifact/revision 正文 append-only：raw-quarantine 与 admitted 是两条独立行
 *    （admitted 用 `derivedFromRevisionId` 指回 quarantine 行），`raw_hash` 在 tenant 内去重复用。
 *
 * 合同来源：M0 类型与端口来自 L2 冻结合同 `src/pth/contracts/knowledge-intake.ts`；
 * 本文件只声明 PG 实现专属类型（错误、选项、工厂），不再本地声明 M0 重复类型。
 */

import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "./pg.js";
import { enqueueSideEffectInTx } from "../../tasking/side-effect-outbox.js";
import { isLegalRunTransition } from "../../contracts/knowledge-intake.js";
import type {
  ClaimIntakeRunInput,
  CreateSubscriptionInput,
  DueScanOptions,
  IntakeAttempt,
  IntakeAttemptDisposition,
  IntakeRun,
  IntakeRunReason,
  IntakeRunStage,
  IntakeSideEffect,
  KnowledgeIntakeRepository,
  MarkDependentsStaleInput,
  SourceDependency,
  SourceDependencyInput,
  SourceRevision,
  SourceSubscription,
  StoreAcquisitionInput,
  SubscriptionStatus,
  TransitionIntakeRunInput,
  TransitionSubscriptionInput,
  VerifiedTrustPolicy,
} from "../../contracts/knowledge-intake.js";

// ---------------------------------------------------------------- 错误与选项（PG 实现专属）

/** fail closed 的显式冲突：DB 行不得替换 policy / 不得跨语义复用 raw_hash。 */
export class KnowledgeIntakeConflictError extends Error {
  readonly code = "KNOWLEDGE_INTAKE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIntakeConflictError";
  }
}

/** 输入不满足 append-only / 策略绑定前置条件（写前 fail closed，零行）。 */
export class KnowledgeIntakeValidationError extends Error {
  readonly code = "KNOWLEDGE_INTAKE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIntakeValidationError";
  }
}

export interface KnowledgeIntakeRepositoryOptions {
  /** run lease 默认有效期（毫秒，默认 5 分钟）。 */
  leaseTtlMs?: number;
  /** due scanner 默认 outbox kind（默认 "intake.fetch"）。 */
  fetchOutboxKind?: string;
}

// ---------------------------------------------------------------- 内部工具

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_FETCH_OUTBOX_KIND = "intake.fetch";
/** run 未终结（可被 claim / 计入 open run 唯一性）的状态。 */
const OPEN_RUN_STATUSES = ["queued", "leased", "waiting"] as const;
/** due scanner 只扫这两种状态：probing = 首轮 initial，active = 周期 scheduled。 */
const DUE_SCAN_STATUSES = ["probing", "active"] as const;

/**
 * subscription 合法迁移矩阵。
 *  - 非终态（probing/active/paused）允许 **同状态自迁移**：用于在不改状态的前提下 CAS 更新
 *    `next_crawl_at`（重爬调度真相）与 `last_successful_revision_id`；
 *  - revoked 只能 retire，retired 不可再迁移；两者都不允许自迁移（终态字段冻结）。
 */
const SUBSCRIPTION_TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  probing: ["probing", "active", "paused", "revoked", "retired"],
  active: ["active", "paused", "revoked", "retired"],
  paused: ["paused", "active", "revoked", "retired"],
  revoked: ["retired"],
  retired: [],
};

/** 允许迁移到 `to` 的来源状态集合（写进 SQL 的 `status = ANY(...)`）。 */
function allowedFromStatuses(to: SubscriptionStatus): string[] {
  return (Object.keys(SUBSCRIPTION_TRANSITIONS) as SubscriptionStatus[]).filter((from) =>
    SUBSCRIPTION_TRANSITIONS[from].includes(to),
  );
}

/**
 * N29 再验收 P0-1：side effect 的 tenant 必须等于聚合 tenant（或缺省由仓库盖章）。
 * 任何不相等值都是编排缺陷/跨租户越权——fail closed 抛错，绝不静默改写成聚合 tenant。
 */
function assertSideEffectTenants(
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

function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toTimestamp(value: Date | string | null | undefined): string | null {
  return iso(value) ?? null;
}

/** lease token 只以 sha256 摘要落 attempt 审计行（明文只回给持有者）。 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** dependency append-only INSERT（pool 与事务 client 共用同一条 SQL——语义不分叉）。 */
async function insertDependency(executor: SqlExecutor, input: SourceDependencyInput): Promise<void> {
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
async function markDependentsStaleRows(
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

function mapSubscription(r: any): SourceSubscription {
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

function mapRun(r: any): IntakeRun {
  return {
    id: r.id,
    tenantId: r.tenant_id,
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

function mapRevision(r: any): SourceRevision {
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

function mapAttempt(r: any): IntakeAttempt {
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

function mapDependency(r: any): SourceDependency {
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

const RUN_COLUMNS = `tenant_id, id, subscription_id, reason, stage, status, attempt, lease_token,
  lease_generation, locked_until, source_revision_id, candidate_id, verification_plan_id,
  last_error, row_version`;

const REVISION_COLUMNS = `tenant_id, id, subscription_id, run_id, previous_revision_id,
  derived_from_revision_id, requested_uri, final_uri, redirect_chain, acquired_at, response_status,
  content_type, etag, last_modified, artifact_id, raw_hash, normalized_text_hash, normalized_text,
  disposition, fetch_policy_decision, use_policy_decision`;

/** pg 行类型（@types/pg 默认 unknown）：本文件所有 SELECT/RETURNING 行都经 map* 归一化后出栈。 */
type Row = Record<string, any>;

/** 最小 SQL 执行面（pg.Pool / pg.PoolClient 通用）。 */
interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: any[] }>;
}

/** attempt 审计行（append-only）；同 identity 重放不新增行。 */
async function insertAttempt(
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

export class PgKnowledgeIntakeRepository implements KnowledgeIntakeRepository {
  private readonly leaseTtlMs: number;
  private readonly fetchOutboxKind: string;

  constructor(private readonly pool: pg.Pool, opts: KnowledgeIntakeRepositoryOptions = {}) {
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.fetchOutboxKind = opts.fetchOutboxKind ?? DEFAULT_FETCH_OUTBOX_KIND;
  }

  /**
   * 已验签 manifest 的 append-only 审计镜像。
   * identity=(tenant_id, policy_id, policy_version)；exact 重放（digest + manifest 全同）幂等，
   * 同版本不同 digest/manifest → `KnowledgeIntakeConflictError`（DB 行不得替换策略）。
   */
  async installVerifiedPolicy(input: VerifiedTrustPolicy): Promise<void> {
    const m = input.manifest;
    if (!m || !m.policyId || !m.version || !m.tenantId) {
      throw new KnowledgeIntakeValidationError("installVerifiedPolicy: manifest 缺少 policyId/version/tenantId");
    }
    const digest = input.digest ?? m.digest;
    if (!digest) throw new KnowledgeIntakeValidationError("installVerifiedPolicy: manifest digest 为空");
    const res = await this.pool.query(
      `INSERT INTO knowledge_trust_policies
         (tenant_id, policy_id, policy_version, policy_digest, spaces, valid_from, valid_until,
          approved_by_principal_id, approved_by_issuer, approval_method, approval_key_id,
          approval_signature, manifest, verified_at, installed_by, last_verified_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,COALESCE($14::timestamptz, now()),$15,now())
       ON CONFLICT (tenant_id, policy_id, policy_version) DO UPDATE
         SET last_verified_at = now()
         WHERE knowledge_trust_policies.policy_digest = EXCLUDED.policy_digest
           AND knowledge_trust_policies.manifest = EXCLUDED.manifest
       RETURNING (xmax = 0) AS inserted`,
      [
        m.tenantId,
        m.policyId,
        m.version,
        digest,
        JSON.stringify(m.spaces ?? []),
        toTimestamp(m.validFrom),
        toTimestamp(m.validUntil),
        m.approvedBy?.principalId ?? "",
        m.approvedBy?.issuer ?? "",
        m.approvalProof?.method ?? "",
        m.approvalProof?.keyId ?? "",
        m.approvalProof?.signature ?? "",
        JSON.stringify(m),
        toTimestamp(input.verifiedAt),
        input.installedBy ?? m.approvedBy?.principalId ?? "",
      ],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new KnowledgeIntakeConflictError(
        `verified trust policy conflict: tenant=${m.tenantId} policy=${m.policyId}@${m.version}`
          + ` 已存在不同 digest/manifest 的审计镜像（policy 只能新增版本，不能被 DB 行替换）`,
      );
    }
  }

  /**
   * 创建 probing subscription。
   * - policy 绑定必须已有审计镜像且 digest 一致（写前 fail closed，零行）；
   * - (tenant_id, space, canonical_uri) 去重：重复请求返回既有行，不新增。
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<SourceSubscription> {
    if (input.recrawlIntervalMs <= 0) {
      throw new KnowledgeIntakeValidationError("createSubscription: recrawlIntervalMs 必须为正");
    }
    return withTx(this.pool, async (client) => {
      const policy = await client.query(
        `SELECT policy_digest, valid_until FROM knowledge_trust_policies
          WHERE tenant_id = $1 AND policy_id = $2 AND policy_version = $3`,
        [input.tenantId, input.policyId, input.policyVersion],
      );
      if ((policy.rowCount ?? 0) === 0) {
        throw new KnowledgeIntakeValidationError(
          `createSubscription: policy ${input.policyId}@${input.policyVersion} 在 tenant=${input.tenantId}`
            + ` 无已验签审计镜像——必须先 installVerifiedPolicy`,
        );
      }
      const mirror = policy.rows[0] as Row;
      if (mirror.policy_digest !== input.policyDigest) {
        throw new KnowledgeIntakeConflictError(
          `createSubscription: policy digest 不符（请求 ${input.policyDigest}，镜像 ${mirror.policy_digest}）`,
        );
      }

      const id = input.id ?? randomUUID();
      const inserted = await client.query(
        `INSERT INTO knowledge_source_subscriptions
           (tenant_id, id, space, canonical_uri, domain_id, status, policy_id, policy_version,
            policy_digest, policy_rule_id, recrawl_interval_ms, next_crawl_at)
         VALUES ($1,$2,$3,$4,$5,'probing',$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()))
         ON CONFLICT (tenant_id, space, canonical_uri) DO NOTHING
         RETURNING *`,
        [
          input.tenantId,
          id,
          input.space,
          input.canonicalUri,
          input.domainId,
          input.policyId,
          input.policyVersion,
          input.policyDigest,
          input.policyRuleId,
          input.recrawlIntervalMs,
          toTimestamp(input.nextCrawlAt),
        ],
      );
      if ((inserted.rowCount ?? 0) === 1) return mapSubscription(inserted.rows[0] as Row);

      const existing = await client.query(
        `SELECT * FROM knowledge_source_subscriptions
          WHERE tenant_id = $1 AND space = $2 AND canonical_uri = $3`,
        [input.tenantId, input.space, input.canonicalUri],
      );
      return mapSubscription(existing.rows[0] as Row);
    });
  }

  /**
   * subscription 状态迁移 / 重排程：rowVersion CAS + 合法迁移矩阵 + tenant scope；
   * 不符（错 rowVersion、跨 tenant、非法迁移、终态冻结）一律零行返回 null。
   */
  async transitionSubscription(input: TransitionSubscriptionInput): Promise<SourceSubscription | null> {
    const from = allowedFromStatuses(input.toStatus);
    if (from.length === 0) return null;
    const res = await this.pool.query(
      `UPDATE knowledge_source_subscriptions
          SET status = $4,
              next_crawl_at = COALESCE($5::timestamptz, next_crawl_at),
              last_successful_revision_id = COALESCE($6::text, last_successful_revision_id),
              row_version = row_version + 1,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND row_version = $3::int AND status = ANY($7::text[])
        RETURNING *`,
      [
        input.tenantId,
        input.subscriptionId,
        input.expectedRowVersion,
        input.toStatus,
        toTimestamp(input.nextCrawlAt),
        input.lastSuccessfulRevisionId ?? null,
        from,
      ],
    );
    return (res.rowCount ?? 0) === 1 ? mapSubscription(res.rows[0] as Row) : null;
  }

  /**
   * due scanner（plan §5 Task 3 Step 4）：单事务内
   *  1. `FOR UPDATE SKIP LOCKED` 选 due 且无未终结 run 的 subscription（probing/active）；
   *  2. 每个 subscription 建一个 run（probing 首轮 = initial，否则 scheduled）；
   *  3. 同事务推进 `next_crawl_at = now + recrawl_interval_ms` 并 +1 row_version；
   *  4. 同事务 `enqueueSideEffectInTx()` 入队 `intake.fetch`（identity=(tenant_id,key)）。
   * 任一步失败 → 整个事务回滚：既不留 run，也不留 outbox。
   */
  async createDueRuns(now: Date, limit: number, opts: DueScanOptions = {}): Promise<readonly IntakeRun[]> {
    if (limit <= 0) return [];
    const kind = opts.outboxKind ?? this.fetchOutboxKind;
    return withTx(this.pool, async (client) => {
      const due = await client.query(
        `SELECT s.tenant_id, s.id, s.space, s.canonical_uri, s.domain_id, s.status,
                s.recrawl_interval_ms, s.last_successful_revision_id
           FROM knowledge_source_subscriptions s
          WHERE s.status = ANY($1::text[])
            AND s.next_crawl_at <= $2::timestamptz
            AND ($3::text IS NULL OR s.tenant_id = $3::text)
            AND NOT EXISTS (
              SELECT 1 FROM knowledge_intake_runs r
               WHERE r.tenant_id = s.tenant_id AND r.subscription_id = s.id
                 AND r.status = ANY($4::text[])
            )
          ORDER BY s.next_crawl_at, s.tenant_id, s.id
          LIMIT $5
          FOR UPDATE SKIP LOCKED`,
        [
          [...DUE_SCAN_STATUSES],
          now.toISOString(),
          opts.tenantId ?? null,
          [...OPEN_RUN_STATUSES],
          limit,
        ],
      );

      const runs: IntakeRun[] = [];
      for (const s of due.rows as Row[]) {
        const reason: IntakeRunReason =
          s.status === "probing" && !s.last_successful_revision_id ? "initial" : "scheduled";
        const runId = randomUUID();
        const ins = await client.query(
          `INSERT INTO knowledge_intake_runs (tenant_id, id, subscription_id, reason, stage, status)
           VALUES ($1,$2,$3,$4,'fetch','queued')
           RETURNING ${RUN_COLUMNS}`,
          [s.tenant_id, runId, s.id, reason],
        );
        const run = mapRun(ins.rows[0] as Row);

        const advanced = await client.query(
          `UPDATE knowledge_source_subscriptions
              SET next_crawl_at = $3::timestamptz + (recrawl_interval_ms * interval '1 millisecond'),
                  row_version = row_version + 1,
                  updated_at = now()
            WHERE tenant_id = $1 AND id = $2
            RETURNING row_version`,
          [s.tenant_id, s.id, now.toISOString()],
        );
        if ((advanced.rowCount ?? 0) !== 1) {
          // 理论不可达（行已被本事务 FOR UPDATE 持锁）；保守 fail closed 让事务整体回滚。
          throw new KnowledgeIntakeConflictError(
            `createDueRuns: 推进 next_crawl_at 失败 tenant=${s.tenant_id} subscription=${s.id}`,
          );
        }

        await enqueueSideEffectInTx(client, {
          key: `${kind}:${runId}`,
          tenantId: s.tenant_id,
          kind,
          payload: {
            runId,
            tenantId: s.tenant_id,
            subscriptionId: s.id,
            space: s.space,
            canonicalUri: s.canonical_uri,
            domainId: s.domain_id,
            stage: "fetch",
            reason,
          },
        });
        runs.push(run);
      }
      return runs;
    });
  }

  /**
   * 领取 run lease：CAS 于 `tenant + id`，仅当 run 未终结且（未 leased 或 lease 已过期）时成功；
   * 可选 `expectedRowVersion` / `expectedLeaseGeneration` 二次收窄。
   * 成功则 lease_generation +1（旧 token 立即失效）、attempt +1、row_version +1，并留 append-only attempt 行。
   */
  async claimRun(input: ClaimIntakeRunInput): Promise<IntakeRun | null> {
    const leaseMs = input.leaseMs ?? this.leaseTtlMs;
    const token = `intake-lease:${randomUUID()}`;
    return withTx(this.pool, async (client) => {
      const res = await client.query(
        `UPDATE knowledge_intake_runs
            SET status = 'leased',
                lease_token = $3,
                lease_generation = lease_generation + 1,
                locked_until = now() + ($4::int * interval '1 millisecond'),
                attempt = attempt + 1,
                last_error = NULL,
                row_version = row_version + 1,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2
            AND status = ANY($5::text[])
            AND (status <> 'leased' OR locked_until IS NULL OR locked_until <= now())
            AND ($6::int IS NULL OR row_version = $6::int)
            AND ($7::bigint IS NULL OR lease_generation = $7::bigint)
          RETURNING ${RUN_COLUMNS}`,
        [
          input.tenantId,
          input.runId,
          token,
          leaseMs,
          [...OPEN_RUN_STATUSES],
          input.expectedRowVersion ?? null,
          input.expectedLeaseGeneration ?? null,
        ],
      );
      if ((res.rowCount ?? 0) !== 1) return null;
      const run = mapRun(res.rows[0] as Row);
      await insertAttempt(client, {
        tenantId: run.tenantId,
        runId: run.id,
        stage: run.stage,
        attempt: run.attempt,
        leaseGeneration: run.leaseGeneration,
        leaseToken: token,
        inputHash: input.inputHash ?? "",
        disposition: "leased",
        principalId: input.principalId,
        executionId: input.executionId,
      });
      return run;
    });
  }

  /**
   * 阶段迁移：CAS 于 `tenant + id + stage + lease_token + lease_generation + row_version` 且 lease 未过期。
   * 命中（rowCount===1）后才在**同一事务**内写 attempt 审计行与下一阶段 outbox；
   * 未命中直接返回 null（零写、零 outbox）；outbox conflict 抛错 → 事务整体回滚。
   *
   * N29 再验收 P0-2（feedback §3 P0-2 / §8 条件 2）：
   *  - `fromStage → toStage/status` 先过冻结矩阵 `isLegalRunTransition()`；非法边**不开事务**直接 null；
   *  - SQL 的 `AND stage = $12::text` 让"声明的 fromStage"与 DB 真实 stage 在同一原子谓词内对账，
   *    因此 `fetch` 阶段伪报 `fromStage=promote → complete` 一定零行。
   *
   * N29 再验收 P0-1：outbox 行的 tenant 由 **CAS RETURNING 的 run.tenant_id** 盖章；
   * 输入自报不同 tenant → 开事务前抛 `KnowledgeIntakeValidationError`（零迁移、零 attempt、零 outbox），
   * 事务内对 `run.tenantId` 再断言一次作为深度防御。
   */
  async transitionRun(input: TransitionIntakeRunInput): Promise<IntakeRun | null> {
    // ① 冻结矩阵（服务端事实源）：非法边零行——连事务都不开，绝无领域写/attempt/outbox。
    if (!isLegalRunTransition(input.fromStage, input.toStage, input.status)) return null;
    // ② 跨 tenant 入队在事务写入前 fail closed。CAS 谓词是 `tenant_id = input.tenantId`，
    //    所以能通过 CAS 的行必然属于 input.tenantId——此处比较等价于比较聚合 tenant，但更早。
    assertSideEffectTenants(input.tenantId, input.sideEffects);
    return withTx(this.pool, async (client) => {
      const res = await client.query(
        // prev CTE 在 UPDATE 前的快照读出旧 stage —— attempt 审计行记录"刚完成的阶段"。
        `WITH prev AS (
           SELECT stage AS prior_stage FROM knowledge_intake_runs WHERE tenant_id = $1 AND id = $2
         )
         UPDATE knowledge_intake_runs
            SET stage = $6,
                status = $7,
                source_revision_id = COALESCE($8::text, source_revision_id),
                candidate_id = COALESCE($9::text, candidate_id),
                verification_plan_id = COALESCE($10::text, verification_plan_id),
                last_error = $11::text,
                lease_token = CASE WHEN $7 = 'leased' THEN lease_token ELSE NULL END,
                locked_until = CASE WHEN $7 = 'leased' THEN locked_until ELSE NULL END,
                row_version = row_version + 1,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2
            AND stage = $12::text
            AND lease_token = $3
            AND lease_generation = $4::bigint
            AND row_version = $5::int
            AND status = 'leased'
            AND locked_until IS NOT NULL AND locked_until > now()
          RETURNING ${RUN_COLUMNS}, (SELECT prior_stage FROM prev) AS prior_stage`,
        [
          input.tenantId,
          input.runId,
          input.leaseToken,
          input.leaseGeneration,
          input.expectedRowVersion,
          input.toStage,
          input.status,
          input.sourceRevisionId ?? null,
          input.candidateId ?? null,
          input.verificationPlanId ?? null,
          input.lastError ?? null,
          input.fromStage,
        ],
      );
      if ((res.rowCount ?? 0) !== 1) return null;
      const run = mapRun(res.rows[0]);

      const disposition: IntakeAttemptDisposition =
        input.disposition
        ?? (input.status === "failed"
          ? "retryable-failed"
          : input.status === "dead-letter"
            ? "terminal-failed"
            : "succeeded");
      await insertAttempt(client, {
        tenantId: run.tenantId,
        runId: run.id,
        stage: ((res.rows[0] as Row).prior_stage as IntakeRunStage) ?? run.stage,
        attempt: run.attempt,
        leaseGeneration: run.leaseGeneration,
        leaseToken: input.leaseToken,
        inputHash: input.inputHash ?? "",
        ...(input.outputHash ? { outputHash: input.outputHash } : {}),
        disposition,
        principalId: input.principalId,
        executionId: input.executionId,
      });

      // N29 再验收 P0-1：outbox tenant 只由聚合上下文盖章——`run.tenantId` 是刚通过 CAS 的那一行。
      // 输入自报不同 tenant 已在开事务前被 `assertSideEffectTenants()` 拒绝；这里对聚合行再断言一次
      // （深度防御：若未来 CAS 谓词变化导致 input.tenantId 与聚合 tenant 脱钩，也必须整体回滚）。
      assertSideEffectTenants(run.tenantId, input.sideEffects);
      for (const se of input.sideEffects ?? []) {
        await enqueueSideEffectInTx(client, {
          key: se.key,
          tenantId: run.tenantId,
          kind: se.kind,
          payload: se.payload,
        });
      }
      return run;
    });
  }

  /**
   * 落一次 acquisition：artifact（tenant 内按 raw_hash 去重复用）+ 一条 append-only revision。
   * raw-quarantine / admitted / unchanged 各自独立成行；admitted 必须带 use policy decision。
   */
  async storeAcquisition(input: StoreAcquisitionInput): Promise<SourceRevision> {
    const rev = input.revision;
    if (rev.disposition === "admitted" && !rev.usePolicyDecision) {
      throw new KnowledgeIntakeValidationError(
        "storeAcquisition: admitted revision 必须携带 usePolicyDecision（deterministic use-policy admission）",
      );
    }
    if (!rev.fetchPolicyDecision) {
      throw new KnowledgeIntakeValidationError("storeAcquisition: 缺少 fetchPolicyDecision");
    }
    if (!input.artifact.rawHash) {
      throw new KnowledgeIntakeValidationError("storeAcquisition: 缺少 artifact.rawHash");
    }
    return withTx(this.pool, async (client) => {
      const artifactId = await this.upsertArtifact(client, input);
      const revisionId = input.revisionId ?? randomUUID();
      const res = await client.query(
        `INSERT INTO knowledge_source_revisions
           (tenant_id, id, subscription_id, run_id, previous_revision_id, derived_from_revision_id,
            requested_uri, final_uri, redirect_chain, acquired_at, response_status, content_type,
            etag, last_modified, artifact_id, raw_hash, normalized_text_hash, normalized_text,
            disposition, fetch_policy_decision, use_policy_decision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 $20::jsonb,$21::jsonb)
         RETURNING ${REVISION_COLUMNS}`,
        [
          input.tenantId,
          revisionId,
          input.subscriptionId,
          input.runId ?? null,
          rev.previousRevisionId ?? null,
          rev.derivedFromRevisionId ?? null,
          rev.requestedUri,
          rev.finalUri,
          JSON.stringify(rev.redirectChain ?? []),
          toTimestamp(rev.acquiredAt),
          rev.responseStatus,
          rev.contentType,
          rev.etag ?? null,
          rev.lastModified ?? null,
          artifactId,
          input.artifact.rawHash,
          rev.normalizedTextHash,
          rev.normalizedText,
          rev.disposition,
          JSON.stringify(rev.fetchPolicyDecision),
          rev.usePolicyDecision ? JSON.stringify(rev.usePolicyDecision) : null,
        ],
      );
      return mapRevision(res.rows[0] as Row);
    });
  }

  /** artifact 去重：同 tenant 同 raw_hash 复用既有行；byteLength 不一致视为冲突 fail closed。 */
  private async upsertArtifact(client: pg.PoolClient, input: StoreAcquisitionInput): Promise<string> {
    const { rawHash, byteLength, rawBytes, contentType } = input.artifact;
    const id = randomUUID();
    const ins = await client.query(
      `INSERT INTO knowledge_source_artifacts
         (tenant_id, id, raw_hash, byte_length, content_type, raw_bytes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, raw_hash) DO NOTHING
       RETURNING id`,
      [input.tenantId, id, rawHash, byteLength, contentType ?? "", Buffer.from(rawBytes)],
    );
    if ((ins.rowCount ?? 0) === 1) return (ins.rows[0] as Row).id as string;

    const existing = await client.query(
      `SELECT id, byte_length FROM knowledge_source_artifacts WHERE tenant_id = $1 AND raw_hash = $2`,
      [input.tenantId, rawHash],
    );
    if ((existing.rowCount ?? 0) === 0) {
      throw new KnowledgeIntakeConflictError(
        `storeAcquisition: artifact 去重读取失败 tenant=${input.tenantId} rawHash=${rawHash}`,
      );
    }
    const artifactRow = existing.rows[0] as Row;
    if (Number(artifactRow.byte_length) !== byteLength) {
      throw new KnowledgeIntakeConflictError(
        `storeAcquisition: rawHash=${rawHash} 已存在但 byteLength 不一致`
          + `（既有 ${artifactRow.byte_length}，新 ${byteLength}）——拒绝复用`,
      );
    }
    return artifactRow.id as string;
  }

  /** 依赖边 append-only：同一 (tenant, dependentKind, dependentId, revision) 重复登记幂等不覆盖。 */
  async recordDependency(input: SourceDependencyInput): Promise<void> {
    await insertDependency(this.pool, input);
  }

  /**
   * N29 Task 5：事务绑定依赖边登记——KnowledgeIngestor 必须让 candidate 写入、
   * VerificationPlan 创建与 candidate→revision 依赖边落在**同一个**事务里
   * （任一步失败 → 整体回滚，不留孤儿 candidate 或孤儿 plan）。
   */
  async recordDependencyInTx(client: pg.PoolClient, input: SourceDependencyInput): Promise<void> {
    await insertDependency(client, input);
  }

  /** stale 标记：tenant + subscription 作用域；可排除当前 revision；返回被标记的 dependent id。 */
  async markDependentsStale(input: MarkDependentsStaleInput): Promise<readonly string[]> {
    const rows = await markDependentsStaleRows(this.pool, input);
    return rows.map((r) => r.dependentId).sort();
  }

  /**
   * N29 Task 6：事务绑定 stale 标记。变化重爬必须在**同一事务**内完成
   *  ① 依赖边 stale → ② 旧 official 知识条目 stale → ③ dependency refresh outbox，
   * 因此本变体返回富行（dependentKind + dependentId + sourceRevisionId），供 service
   * 只对 `knowledge-entry` 依赖调用 `PgMemoryStore.markKnowledgeStaleInTx()`。
   */
  async markDependentsStaleInTx(
    client: pg.PoolClient,
    input: MarkDependentsStaleInput,
  ): Promise<readonly StaleDependentRow[]> {
    return markDependentsStaleRows(client, input);
  }

  /**
   * N29 Task 6：artifact 元数据只读面（不返回正文字节）。
   * 条件重爬命中 304 时 envelope 的 rawBytes 为空、byteLength=0，而 `storeAcquisition()`
   * 的 artifact 去重要求 byteLength 与既有行严格一致，因此 unchanged 路径必须先读回真实长度。
   */
  async getArtifactMeta(
    tenantId: string,
    rawHash: string,
  ): Promise<{ id: string; rawHash: string; byteLength: number; contentType: string } | null> {
    const res = await this.pool.query(
      `SELECT id, raw_hash, byte_length, content_type FROM knowledge_source_artifacts
        WHERE tenant_id = $1 AND raw_hash = $2`,
      [tenantId, rawHash],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    const r = res.rows[0] as Row;
    return {
      id: r.id as string,
      rawHash: r.raw_hash as string,
      byteLength: Number(r.byte_length),
      contentType: (r.content_type as string) ?? "",
    };
  }

  // ------------------------------------------------------------ 读侧（tenant-scoped）

  async getSubscription(tenantId: string, subscriptionId: string): Promise<SourceSubscription | null> {
    const res = await this.pool.query(
      `SELECT * FROM knowledge_source_subscriptions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, subscriptionId],
    );
    return (res.rowCount ?? 0) === 1 ? mapSubscription(res.rows[0]) : null;
  }

  async getRun(tenantId: string, runId: string): Promise<IntakeRun | null> {
    const res = await this.pool.query(
      `SELECT ${RUN_COLUMNS} FROM knowledge_intake_runs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId],
    );
    return (res.rowCount ?? 0) === 1 ? mapRun(res.rows[0] as Row) : null;
  }

  async getRevision(tenantId: string, revisionId: string): Promise<SourceRevision | null> {
    const res = await this.pool.query(
      `SELECT ${REVISION_COLUMNS} FROM knowledge_source_revisions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, revisionId],
    );
    return (res.rowCount ?? 0) === 1 ? mapRevision(res.rows[0] as Row) : null;
  }

  async listRevisions(tenantId: string, subscriptionId: string): Promise<readonly SourceRevision[]> {
    const res = await this.pool.query(
      `SELECT ${REVISION_COLUMNS} FROM knowledge_source_revisions
        WHERE tenant_id = $1 AND subscription_id = $2
        ORDER BY acquired_at, id`,
      [tenantId, subscriptionId],
    );
    return (res.rows as Row[]).map(mapRevision);
  }

  async listAttempts(tenantId: string, runId: string): Promise<readonly IntakeAttempt[]> {
    const res = await this.pool.query(
      `SELECT * FROM knowledge_intake_attempts
        WHERE tenant_id = $1 AND run_id = $2 ORDER BY id`,
      [tenantId, runId],
    );
    return (res.rows as Row[]).map(mapAttempt);
  }

  async listDependencies(tenantId: string, subscriptionId: string): Promise<readonly SourceDependency[]> {
    const res = await this.pool.query(
      `SELECT * FROM knowledge_source_dependencies
        WHERE tenant_id = $1 AND subscription_id = $2 ORDER BY id`,
      [tenantId, subscriptionId],
    );
    return (res.rows as Row[]).map(mapDependency);
  }
}

/**
 * N29 Task 5：事务绑定写入面。M0 冻结合同（contracts）不得出现 `pg` 类型，
 * 因此事务面在 PG 适配器层声明；消费方（KnowledgeIngestor）按结构消费。
 *
 * N29 Task 6 追加：变化重爬的 stale 标记必须与旧 official 撤出、dependency refresh outbox
 * 落在同一事务；unchanged（304）路径需要 artifact 真实长度才能复用既有 artifact 行。
 */
export interface TransactionBoundIntakeWrites {
  recordDependencyInTx(client: pg.PoolClient, input: SourceDependencyInput): Promise<void>;
  markDependentsStaleInTx(
    client: pg.PoolClient,
    input: MarkDependentsStaleInput,
  ): Promise<readonly StaleDependentRow[]>;
  getArtifactMeta(
    tenantId: string,
    rawHash: string,
  ): Promise<{ id: string; rawHash: string; byteLength: number; contentType: string } | null>;
}

/** PG 仓库的完整对外面（冻结合同 + 事务绑定写入）。 */
export type PgKnowledgeIntakeRepositoryFace = KnowledgeIntakeRepository & TransactionBoundIntakeWrites;

/** 工厂（与 tasking/adapters 的 createPgTaskRepository 风格一致）。 */
export function createKnowledgeIntakeRepository(
  pool: pg.Pool,
  opts: KnowledgeIntakeRepositoryOptions = {},
): PgKnowledgeIntakeRepositoryFace {
  return new PgKnowledgeIntakeRepository(pool, opts);
}
