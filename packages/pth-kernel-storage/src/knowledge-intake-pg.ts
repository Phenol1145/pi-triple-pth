/**
 * kernel/storage/knowledge-intake-pg.ts — N29 Task 3：知识摄入内环的 PG 真相源仓库。
 *
 * 职责边界：本文件只做 **持久化 + CAS + 事务**；不做签名校验、不做 HTTP、不做 LLM、
 * 不做 use-policy 判定。授权事实源仍是人类签名 Trust Policy manifest 与 PTL human proof；
 * `installVerifiedPolicy()` 只写"已验签 manifest 的不可变审计镜像"，DB 行不能创建、扩大或替换 policy。
 *
 * N29 再验收 P0-3（"verified" 边界不得被结构伪造）：`installVerifiedPolicy()` 不再相信
 * `VerifiedTrustPolicy` 这个**结构类型**，它在写库前要求运行时 attestation：
 *  - (B) 未注入 verifier 时，输入必须带 `POLICY_VERIFIED_BRAND`（Symbol + 模块私有 WeakMap，
 *    只有 `loadVerifiedTrustPolicy()` 会盖章），并与 manifest 身份对账（tenant/policyId/version/digest/signer）；
 *  - (A) 生产装配注入 `policyVerifier`（read-only keyring 的验签闭包）后，**每次安装都重新验签**：
 *    attestation 只能由验签器产出，调用方即使自己盖章也绕不过 Ed25519/digest/human signer 校验；
 *  - 纵深防御：`approvedBy.kind==="human"`、`approvedBy.issuer==="ptl-human-interface"`、
 *    `approvalProof.method==="signed-manifest"`、signer 与 keyId/tenant 一致，任一不符零行 fail closed。
 *
 * 关键不变量（plan §2 Global Constraints / §3.2 / §5 Task 3）：
 *  - 所有查询与 CAS 一律 tenant-scoped；跨 tenant 读零可见、写零行。
 *  - subscription / run / dependency 是可变聚合：迁移必须携带 expected `rowVersion`（CAS）。
 *  - run 迁移必须同时满足：`tenant + id + stage(= fromStage) + lease_token + lease_generation + rowVersion`
 *    且 lease 未过期，并命中冻结迁移矩阵 `RUN_STAGE_TRANSITIONS`；任一不符 → 零行、零 side effect
 *    （N29 再验收 P0-2：docs/pth/report/n29-minimal-intake-reacceptance-feedback.md §3 P0-2）。
 *  - side effect 的 outbox tenant 由聚合上下文盖章（CAS RETURNING 的 run.tenant_id），
 *    调用方自报不同 tenant → 写前 fail closed 抛错并整体回滚（N29 再验收 P0-1）。
 *  - 状态迁移与下一阶段 outbox 必须同一事务：`enqueueSideEffectInTx()`（L1，identity=(tenant_id,key)）
 *    只在 CAS `rowCount === 1` 之后调用；outbox conflict 抛错 → 整个事务回滚。
 *  - due scanner：`FOR UPDATE SKIP LOCKED` 选 due subscription，同事务建 run + 推进
 *    `next_crawl_at` + enqueue `intake.fetch`；`uq_knowledge_intake_runs_open_subscription`
 *    是第二道防线（同 subscription 同时只允许一个未终结 run）。
 *  - artifact/revision 正文 append-only：raw-quarantine 与 admitted 是两条独立行
 *    （admitted 用 `derivedFromRevisionId` 指回 quarantine 行），`raw_hash` 在 tenant 内去重复用。
 *  - **SourceRevision / Artifact 不变量在写口守住**（N29 再验收 P0-4：feedback §3 P0-4 / §8 条件 4）：
 *    `storeAcquisition()` 服务端重算 `sha256(rawBytes)` / `sha256(normalizedText)` 与 byteLength，
 *    并要求 admitted 满足「同 tenant+subscription 的 raw-quarantine 父行 + use/fetch decision=allow
 *    + decision 的 policy/rule 绑定与 Subscription 及已验签策略镜像三方一致（含 spaces/有效期）」；
 *    `recordDependency*()` 只接受已准入（admitted/unchanged）且同 subscription 的来源 revision。
 *    任一项不符 → 带具体 code 的 `KI.KnowledgeIntakeValidationError` + 事务回滚（零 artifact、零 revision）。
 *    schema 侧另有 CHECK + BEFORE INSERT 触发器作为同事务数据库约束层的第二道防线。
 *
 * 合同来源：M0 类型与端口来自 L2 冻结合同 `src/pth/contracts/knowledge-intake.ts`；
 * 本文件只声明 PG 实现专属类型（错误、选项、工厂），不再本地声明 M0 重复类型。
 */

import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "./pg.js";
import { enqueueSideEffectInTx } from "./side-effect-outbox.js";
import { isLegalRunTransition } from "@away_from/pth-contracts";

import * as KI from "./knowledge-intake/support.js";
export * from "./knowledge-intake/support.js";
import {
  attestationMismatchReason,
  readVerifiedPolicyAttestation,
  type VerifiedPolicyAttestation,
} from "@away_from/pth-contracts";
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
  PolicyDecisionRef,
  SourceDependency,
  SourceDependencyInput,
  SourceRevision,
  SourceSubscription,
  StoreAcquisitionInput,
  SubscriptionStatus,
  TransitionIntakeRunInput,
  TransitionSubscriptionInput,
  TrustPolicyManifest,
  VerifiedTrustPolicy,
} from "@away_from/pth-contracts";

// ---------------------------------------------------------------- 错误与选项（PG 实现专属）

/** fail closed 的显式冲突：DB 行不得替换 policy / 不得跨语义复用 raw_hash。 */
export class PgKnowledgeIntakeRepository implements KnowledgeIntakeRepository {
  private readonly leaseTtlMs: number;
  private readonly fetchOutboxKind: string;
  private readonly policyVerifier?: KI.VerifiedTrustPolicyVerifier;
  private readonly leaseGuard: Readonly<KI.IntakeRunLeaseGuard>;

  constructor(private readonly pool: pg.Pool, opts: KI.KnowledgeIntakeRepositoryOptions = {}) {
    this.leaseTtlMs = opts.leaseTtlMs ?? KI.DEFAULT_LEASE_TTL_MS;
    this.fetchOutboxKind = opts.fetchOutboxKind ?? KI.DEFAULT_FETCH_OUTBOX_KIND;
    if (opts.policyVerifier) this.policyVerifier = opts.policyVerifier;
    this.leaseGuard = opts.leaseGuard ?? KI.STRICT_INTAKE_RUN_LEASE_GUARD;
  }

  /**
   * P0-3 的唯一可信入口：把输入解析为「带运行时 attestation 的已验证策略」。
   *
   *  1. 注入了 `policyVerifier`（生产装配）→ **无条件**用输入的 raw manifest 重新验签
   *     （Ed25519 detached signature + canonical digest + human signer + 有效期），
   *     attestation 只能由验签器产出：即使调用方自己盖了品牌，伪造的 signature/digest 也在这里被拒；
   *  2. 未注入 verifier（例如只做持久化回归的装配）→ 要求输入带
   *     `loadVerifiedTrustPolicy()` 盖的运行时 attestation，同形普通对象/结构拷贝一律 fail closed；
   *  3. 两者都不满足 → 零行 fail closed。
   */
  private async attestPolicy(
    input: VerifiedTrustPolicy,
  ): Promise<{ policy: VerifiedTrustPolicy; attestation: VerifiedPolicyAttestation }> {
    if (typeof input !== "object" || input === null) {
      throw new KI.KnowledgeIntakeValidationError(
        "installVerifiedPolicy: trust policy not verified — must pass through loadVerifiedTrustPolicy",
      );
    }
    if (!this.policyVerifier) {
      const direct = readVerifiedPolicyAttestation(input);
      if (direct) return { policy: input, attestation: direct };
      throw new KI.KnowledgeIntakeValidationError(
        "installVerifiedPolicy: trust policy not verified — must pass through loadVerifiedTrustPolicy"
          + "（结构同形的普通对象/拷贝不构成运行时 attestation）",
      );
    }
    const manifest = (input as { manifest?: unknown }).manifest;
    if (typeof manifest !== "object" || manifest === null) {
      throw new KI.KnowledgeIntakeValidationError(
        "installVerifiedPolicy: trust policy not verified — must pass through loadVerifiedTrustPolicy"
          + "（输入没有可重新验签的 manifest）",
      );
    }
    let reverified: VerifiedTrustPolicy;
    try {
      reverified = await this.policyVerifier(manifest as TrustPolicyManifest);
    } catch (error) {
      throw new KI.KnowledgeIntakeValidationError(
        "installVerifiedPolicy: trust policy not verified — must pass through loadVerifiedTrustPolicy"
          + `（注入 verifier 重新验签失败：${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    const attestation = readVerifiedPolicyAttestation(reverified);
    if (!attestation) {
      throw new KI.KnowledgeIntakeValidationError(
        "installVerifiedPolicy: trust policy not verified — must pass through loadVerifiedTrustPolicy"
          + "（注入 verifier 没有签发运行时 attestation）",
      );
    }
    return { policy: reverified, attestation };
  }

  /**
   * 已验签 manifest 的 append-only 审计镜像。
   * identity=(tenant_id, policy_id, policy_version)；exact 重放（digest + manifest 全同）幂等，
   * 同版本不同 digest/manifest → `KI.KnowledgeIntakeConflictError`（DB 行不得替换策略）。
   *
   * 写前 fail closed（零行）：无运行时 attestation、attestation 与 manifest 不一致、
   * 非 human signer / 错 issuer / 非 signed-manifest / signer 与 keyId·tenant 不一致。
   */
  async installVerifiedPolicy(input: VerifiedTrustPolicy): Promise<void> {
    const { policy, attestation } = await this.attestPolicy(input);
    const m = policy.manifest;
    if (!m || !m.policyId || !m.version || !m.tenantId) {
      throw new KI.KnowledgeIntakeValidationError("installVerifiedPolicy: manifest 缺少 policyId/version/tenantId");
    }
    // attestation 是验签当时固定的事实：验签后换 manifest / 换 digest 一律拒绝。
    const mismatch = attestationMismatchReason(attestation, m);
    if (mismatch) {
      throw new KI.KnowledgeIntakeValidationError(
        `installVerifiedPolicy: trust policy attestation 与 manifest 不一致（${mismatch}）`,
      );
    }
    // 纵深防御：人类签名是唯一授权来源（service/worker principal 一律零行）。
    if (m.approvedBy?.kind !== KI.HUMAN_PRINCIPAL_KIND) {
      throw new KI.KnowledgeIntakeValidationError(
        `installVerifiedPolicy: policy 必须由 human principal 批准（approvedBy.kind=${String(m.approvedBy?.kind)}）`,
      );
    }
    if (m.approvedBy.issuer !== KI.HUMAN_POLICY_ISSUER) {
      throw new KI.KnowledgeIntakeValidationError(
        `installVerifiedPolicy: policy 批准 issuer 必须是 ${KI.HUMAN_POLICY_ISSUER}（收到 ${String(m.approvedBy.issuer)}）`,
      );
    }
    if (m.approvedBy.tenantId !== m.tenantId) {
      throw new KI.KnowledgeIntakeValidationError(
        `installVerifiedPolicy: approvedBy.tenantId=${String(m.approvedBy.tenantId)} 与 manifest tenant=${m.tenantId} 不一致`,
      );
    }
    if (m.approvalProof?.method !== KI.SIGNED_MANIFEST_METHOD) {
      throw new KI.KnowledgeIntakeValidationError(
        `installVerifiedPolicy: 只接受 ${KI.SIGNED_MANIFEST_METHOD} 批准证明（收到 ${String(m.approvalProof?.method)}）`,
      );
    }
    if (!m.approvalProof.keyId || m.approvalProof.keyId !== m.approvedBy.principalId) {
      throw new KI.KnowledgeIntakeValidationError(
        "installVerifiedPolicy: approvalProof.keyId 必须等于 approvedBy.principalId",
      );
    }
    if (typeof m.approvalProof.signature !== "string" || m.approvalProof.signature.trim() === "") {
      throw new KI.KnowledgeIntakeValidationError("installVerifiedPolicy: approvalProof.signature 为空");
    }
    // digest 只取 attestation（验签时计算并与 manifest 比对通过的那一个）。
    const digest = attestation.digest;
    if (!digest) throw new KI.KnowledgeIntakeValidationError("installVerifiedPolicy: manifest digest 为空");
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
        KI.toTimestamp(m.validFrom),
        KI.toTimestamp(m.validUntil),
        m.approvedBy.principalId,
        m.approvedBy.issuer,
        m.approvalProof.method,
        m.approvalProof.keyId,
        m.approvalProof.signature,
        JSON.stringify(m),
        KI.toTimestamp(policy.verifiedAt ?? attestation.verifiedAt),
        policy.installedBy ?? attestation.signerPrincipalId,
      ],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new KI.KnowledgeIntakeConflictError(
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
      throw new KI.KnowledgeIntakeValidationError("createSubscription: recrawlIntervalMs 必须为正");
    }
    return withTx(this.pool, async (client) => {
      const policy = await client.query(
        `SELECT policy_digest, valid_until FROM knowledge_trust_policies
          WHERE tenant_id = $1 AND policy_id = $2 AND policy_version = $3`,
        [input.tenantId, input.policyId, input.policyVersion],
      );
      if ((policy.rowCount ?? 0) === 0) {
        throw new KI.KnowledgeIntakeValidationError(
          `createSubscription: policy ${input.policyId}@${input.policyVersion} 在 tenant=${input.tenantId}`
            + ` 无已验签审计镜像——必须先 installVerifiedPolicy`,
        );
      }
      const mirror = policy.rows[0] as KI.Row;
      if (mirror.policy_digest !== input.policyDigest) {
        throw new KI.KnowledgeIntakeConflictError(
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
          KI.toTimestamp(input.nextCrawlAt),
        ],
      );
      if ((inserted.rowCount ?? 0) === 1) return KI.mapSubscription(inserted.rows[0] as KI.Row);

      const existing = await client.query(
        `SELECT * FROM knowledge_source_subscriptions
          WHERE tenant_id = $1 AND space = $2 AND canonical_uri = $3`,
        [input.tenantId, input.space, input.canonicalUri],
      );
      return KI.mapSubscription(existing.rows[0] as KI.Row);
    });
  }

  /**
   * subscription 状态迁移 / 重排程：rowVersion CAS + 合法迁移矩阵 + tenant scope；
   * 不符（错 rowVersion、跨 tenant、非法迁移、终态冻结）一律零行返回 null。
   */
  async transitionSubscription(input: TransitionSubscriptionInput): Promise<SourceSubscription | null> {
    const from = KI.allowedFromStatuses(input.toStatus);
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
        KI.toTimestamp(input.nextCrawlAt),
        input.lastSuccessfulRevisionId ?? null,
        from,
      ],
    );
    return (res.rowCount ?? 0) === 1 ? KI.mapSubscription(res.rows[0] as KI.Row) : null;
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
          [...KI.DUE_SCAN_STATUSES],
          now.toISOString(),
          opts.tenantId ?? null,
          [...KI.OPEN_RUN_STATUSES],
          limit,
        ],
      );

      const runs: IntakeRun[] = [];
      for (const s of due.rows as KI.Row[]) {
        const reason: IntakeRunReason =
          s.status === "probing" && !s.last_successful_revision_id ? "initial" : "scheduled";
        const runId = randomUUID();
        const ins = await client.query(
          `INSERT INTO knowledge_intake_runs (tenant_id, id, subscription_id, reason, stage, status)
           VALUES ($1,$2,$3,$4,'fetch','queued')
           RETURNING ${KI.RUN_COLUMNS}`,
          [s.tenant_id, runId, s.id, reason],
        );
        const run = KI.mapRun(ins.rows[0] as KI.Row);

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
          throw new KI.KnowledgeIntakeConflictError(
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
          RETURNING ${KI.RUN_COLUMNS}`,
        [
          input.tenantId,
          input.runId,
          token,
          leaseMs,
          [...KI.OPEN_RUN_STATUSES],
          input.expectedRowVersion ?? null,
          input.expectedLeaseGeneration ?? null,
        ],
      );
      if ((res.rowCount ?? 0) !== 1) return null;
      const run = KI.mapRun(res.rows[0] as KI.Row);
      await KI.insertAttempt(client, {
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
   * 输入自报不同 tenant → 开事务前抛 `KI.KnowledgeIntakeValidationError`（零迁移、零 attempt、零 outbox），
   * 事务内对 `run.tenantId` 再断言一次作为深度防御。
   *
   * N29 再验收 G10（lease sabotage 注入缝）：lease 未过期的判定由 `leaseGuard.canCommit()` 完成——
   * 缺省严格实现 + FOR UPDATE 锁等价于旧 SQL 的 `locked_until > now()`；测试注入恒 true 门禁时
   * `expiredLease` sentinel 必须翻红，因此本方法不能再把该判定写成不可注入的 SQL 字面量。
   */
  async transitionRun(input: TransitionIntakeRunInput): Promise<IntakeRun | null> {
    // ① 冻结矩阵（服务端事实源）：非法边零行——连事务都不开，绝无领域写/attempt/outbox。
    if (!isLegalRunTransition(input.fromStage, input.toStage, input.status)) return null;
    // ② 跨 tenant 入队在事务写入前 fail closed。CAS 谓词是 `tenant_id = input.tenantId`，
    //    所以能通过 CAS 的行必然属于 input.tenantId——此处比较等价于比较聚合 tenant，但更早。
    KI.assertSideEffectTenants(input.tenantId, input.sideEffects);
    return withTx(this.pool, async (client) => {
      // G10 lease sabotage 注入缝：先在同一事务内 FOR UPDATE 锁定 run 行并读取
      // locked_until / db now，交给（缺省严格的）lease guard 判定。锁保证本判定与下方
      // UPDATE 之间不会有其他 writer 改行；stage/token/generation/rowVersion/status 的
      // CAS 谓词仍留在 UPDATE 里，任何不符依然零行、零 attempt、零 outbox。
      const locked = await client.query<{ prior_stage: IntakeRunStage; locked_until: Date | null; db_now: Date }>(
        `SELECT stage AS prior_stage, locked_until, now() AS db_now
           FROM knowledge_intake_runs
          WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
        [input.tenantId, input.runId],
      );
      if ((locked.rowCount ?? 0) !== 1) return null;
      const priorStage = locked.rows[0]!.prior_stage;
      if (!this.leaseGuard.canCommit({ lockedUntil: locked.rows[0]!.locked_until, now: locked.rows[0]!.db_now })) {
        return null;
      }

      const res = await client.query(
        `UPDATE knowledge_intake_runs
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
          RETURNING ${KI.RUN_COLUMNS}`,
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
      const run = KI.mapRun(res.rows[0]);

      const disposition: IntakeAttemptDisposition =
        input.disposition
        ?? (input.status === "failed"
          ? "retryable-failed"
          : input.status === "dead-letter"
            ? "terminal-failed"
            : "succeeded");
      await KI.insertAttempt(client, {
        tenantId: run.tenantId,
        runId: run.id,
        stage: priorStage,
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
      // 输入自报不同 tenant 已在开事务前被 `KI.assertSideEffectTenants()` 拒绝；这里对聚合行再断言一次
      // （深度防御：若未来 CAS 谓词变化导致 input.tenantId 与聚合 tenant 脱钩，也必须整体回滚）。
      KI.assertSideEffectTenants(run.tenantId, input.sideEffects);
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
   * raw-quarantine / admitted / unchanged 各自独立成行。
   *
   * N29 再验收 P0-4（feedback §3 P0-4 / §8 条件 4）：本方法是**公共写口**，必须按
   * "被错误内部调用者直接调用"设防——service happy path 的判定不构成信任边界。写事务内逐项对账：
   *
   *  ① **hash 服务端重算**：`rawHash === sha256(rawBytes)`、`normalizedTextHash === sha256(normalizedText)`、
   *     `byteLength === rawBytes.byteLength`；自报值只作 tripwire（不一致即拒），永不作为真相。
   *     304 unchanged（零字节复用既有 artifact）例外：不重算 rawHash，但必须命中既有 artifact 行。
   *  ② **admitted 必须派生自同 tenant + 同 subscription 的 raw-quarantine 行**
   *     （`derivedFromRevisionId` 必填、父行存在、disposition/subscription 逐项对账）。
   *  ③ **admitted 的 use/fetch decision 必须是 allow**（deny 一律零行，绝不落 admitted）。
   *  ④ **decision 的 policy 绑定必须与 Subscription 及已验签策略审计镜像三方一致**
   *     （policyId/version/digest/ruleId + 镜像 digest + spaces 覆盖 space + 有效期）。
   *
   * 任一项不成立 → `KI.KnowledgeIntakeValidationError`（带具体 code）+ 事务回滚：零 artifact、零 revision。
   * schema 侧还有第二道防线（CHECK + BEFORE INSERT 触发器），见 `KNOWLEDGE_INTAKE_SCHEMA_SQL`。
   */
  async storeAcquisition(input: StoreAcquisitionInput): Promise<SourceRevision> {
    const rev = input.revision;
    const admitted = rev.disposition === "admitted";
    if (!rev.fetchPolicyDecision) {
      throw new KI.KnowledgeIntakeValidationError("storeAcquisition: 缺少 fetchPolicyDecision");
    }
    if (!input.artifact.rawHash) {
      throw new KI.KnowledgeIntakeValidationError("storeAcquisition: 缺少 artifact.rawHash");
    }
    if (admitted && !rev.usePolicyDecision) {
      throw new KI.KnowledgeIntakeValidationError(
        "storeAcquisition: admitted revision 必须携带 usePolicyDecision（deterministic use-policy admission）",
        "ADMITTED_USE_DECISION_MISSING",
      );
    }
    KI.assertPolicyDecisionShape(rev.fetchPolicyDecision, "fetchPolicyDecision");
    if (rev.usePolicyDecision) KI.assertPolicyDecisionShape(rev.usePolicyDecision, "usePolicyDecision");

    // ① hash 服务端重算（自报值只作 tripwire）。
    const rawBytes = Buffer.from(input.artifact.rawBytes ?? new Uint8Array(0));
    const reusesExistingArtifact = rawBytes.byteLength === 0;
    if (!reusesExistingArtifact) {
      const recomputedRawHash = KI.sha256Hex(rawBytes);
      if (recomputedRawHash !== input.artifact.rawHash) {
        throw new KI.KnowledgeIntakeValidationError(
          `storeAcquisition: artifact.rawHash 自报 ${input.artifact.rawHash} 与 sha256(rawBytes)`
            + ` ${recomputedRawHash} 不一致——服务端重算是唯一真相`,
          "ARTIFACT_RAW_HASH_MISMATCH",
        );
      }
      if (input.artifact.byteLength !== rawBytes.byteLength) {
        throw new KI.KnowledgeIntakeValidationError(
          `storeAcquisition: artifact.byteLength 自报 ${input.artifact.byteLength} 与 rawBytes 实际长度`
            + ` ${rawBytes.byteLength} 不一致`,
          "ARTIFACT_BYTE_LENGTH_MISMATCH",
        );
      }
    } else if (admitted) {
      // admitted 必须由真实字节支撑（零字节只可能是 304 复用路径的 unchanged 行）。
      throw new KI.KnowledgeIntakeValidationError(
        "storeAcquisition: admitted revision 必须携带 rawBytes（不得以零字节 artifact 落 admitted）",
        "ARTIFACT_RAW_HASH_MISMATCH",
      );
    }
    const recomputedNormalizedHash = KI.sha256Hex(rev.normalizedText ?? "");
    if (rev.normalizedTextHash !== recomputedNormalizedHash) {
      throw new KI.KnowledgeIntakeValidationError(
        `storeAcquisition: normalizedTextHash 自报 ${String(rev.normalizedTextHash)} 与`
          + ` sha256(normalizedText) ${recomputedNormalizedHash} 不一致——服务端重算是唯一真相`,
        "REVISION_NORMALIZED_TEXT_HASH_MISMATCH",
      );
    }

    return withTx(this.pool, async (client) => {
      // ② Subscription 必须存在于同 tenant（FK 之前先给出可判读的领域错误）。
      const subRes = await client.query(
        `SELECT space, policy_id, policy_version, policy_digest, policy_rule_id
           FROM knowledge_source_subscriptions WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.subscriptionId],
      );
      if ((subRes.rowCount ?? 0) !== 1) {
        throw new KI.KnowledgeIntakeValidationError(
          `storeAcquisition: subscription ${input.subscriptionId} 在 tenant=${input.tenantId} 不存在`,
          "SUBSCRIPTION_NOT_FOUND",
        );
      }
      const subscription = subRes.rows[0] as KI.Row;

      if (admitted) {
        // ③ admitted 必须派生自同 tenant + 同 subscription 的 raw-quarantine 行。
        if (!rev.derivedFromRevisionId) {
          throw new KI.KnowledgeIntakeValidationError(
            "storeAcquisition: admitted revision 必须携带 derivedFromRevisionId"
              + "（admitted 只能从同 tenant/subscription 的 raw-quarantine revision 派生）",
            "ADMITTED_PARENT_REQUIRED",
          );
        }
        const parentRes = await client.query(
          `SELECT subscription_id, disposition FROM knowledge_source_revisions
            WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, rev.derivedFromRevisionId],
        );
        if ((parentRes.rowCount ?? 0) !== 1) {
          throw new KI.KnowledgeIntakeValidationError(
            `storeAcquisition: derivedFromRevisionId ${rev.derivedFromRevisionId} 在 tenant=${input.tenantId}`
              + " 不存在（跨 tenant 引用一律零行）",
            "ADMITTED_PARENT_NOT_FOUND",
          );
        }
        const parent = parentRes.rows[0] as KI.Row;
        if (parent.disposition !== "raw-quarantine") {
          throw new KI.KnowledgeIntakeValidationError(
            `storeAcquisition: derivedFromRevisionId ${rev.derivedFromRevisionId} 的 disposition 是`
              + ` ${String(parent.disposition)}，admitted 只能从 raw-quarantine 派生`,
            "ADMITTED_PARENT_NOT_QUARANTINE",
          );
        }
        if (parent.subscription_id !== input.subscriptionId) {
          throw new KI.KnowledgeIntakeValidationError(
            `storeAcquisition: derivedFromRevisionId ${rev.derivedFromRevisionId} 属于 subscription`
              + ` ${String(parent.subscription_id)}，与本次 ${input.subscriptionId} 不一致`,
            "ADMITTED_PARENT_SUBSCRIPTION_MISMATCH",
          );
        }

        // ④ decision 必须 allow（deny/非 allow 一律零 admitted 行）。
        if (rev.usePolicyDecision!.decision !== "allow") {
          throw new KI.KnowledgeIntakeValidationError(
            `storeAcquisition: admitted revision 的 usePolicyDecision.decision=`
              + `${String(rev.usePolicyDecision!.decision)}——只有 allow 才能落 admitted`,
            "ADMITTED_USE_DECISION_NOT_ALLOW",
          );
        }
        if (rev.fetchPolicyDecision.decision !== "allow") {
          throw new KI.KnowledgeIntakeValidationError(
            `storeAcquisition: admitted revision 的 fetchPolicyDecision.decision=`
              + `${String(rev.fetchPolicyDecision.decision)}——非 allow 的抓取不得产出 admitted`,
            "FETCH_DECISION_NOT_ALLOW",
          );
        }

        // ⑤ decision 的 policy/rule 绑定必须与 Subscription 及已验签审计镜像三方一致。
        for (const [label, decision] of [
          ["usePolicyDecision", rev.usePolicyDecision!],
          ["fetchPolicyDecision", rev.fetchPolicyDecision],
        ] as const) {
          KI.assertDecisionMatchesSubscription(label, decision, subscription);
        }
        await this.assertInstalledPolicy(client, input.tenantId, subscription, rev.usePolicyDecision!, rev.acquiredAt);
      }

      const artifactId = reusesExistingArtifact
        ? await this.reuseArtifact(client, input)
        : await this.upsertArtifact(client, input, rawBytes);
      const revisionId = input.revisionId ?? randomUUID();
      const res = await client.query(
        `INSERT INTO knowledge_source_revisions
           (tenant_id, id, subscription_id, run_id, previous_revision_id, derived_from_revision_id,
            requested_uri, final_uri, redirect_chain, acquired_at, response_status, content_type,
            etag, last_modified, artifact_id, raw_hash, normalized_text_hash, normalized_text,
            disposition, fetch_policy_decision, use_policy_decision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 $20::jsonb,$21::jsonb)
         RETURNING ${KI.REVISION_COLUMNS}`,
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
          KI.toTimestamp(rev.acquiredAt),
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
      return KI.mapRevision(res.rows[0] as KI.Row);
    });
  }

  /**
   * admitted 的 policy 绑定第三方对账：已验签策略审计镜像。
   * 镜像不存在 / digest 不符 / spaces 不覆盖 space / acquisition 时刻不在有效期 → 零行 fail closed。
   */
  private async assertInstalledPolicy(
    client: pg.PoolClient,
    tenantId: string,
    subscription: KI.Row,
    decision: { policyId: string; policyVersion: string; policyDigest: string },
    acquiredAt: Date | string,
  ): Promise<void> {
    const res = await client.query(
      `SELECT policy_digest, spaces, valid_from, valid_until FROM knowledge_trust_policies
        WHERE tenant_id = $1 AND policy_id = $2 AND policy_version = $3`,
      [tenantId, decision.policyId, decision.policyVersion],
    );
    if ((res.rowCount ?? 0) !== 1) {
      throw new KI.KnowledgeIntakeValidationError(
        `storeAcquisition: policy ${decision.policyId}@${decision.policyVersion} 在 tenant=${tenantId}`
          + " 没有已验签审计镜像——admitted revision 不得引用未安装策略",
        "POLICY_NOT_INSTALLED",
      );
    }
    const mirror = res.rows[0] as KI.Row;
    if (mirror.policy_digest !== decision.policyDigest) {
      throw new KI.KnowledgeIntakeValidationError(
        `storeAcquisition: policy decision digest ${decision.policyDigest} 与已验签镜像`
          + ` ${String(mirror.policy_digest)} 不一致`,
        "POLICY_NOT_INSTALLED",
      );
    }
    const spaces: unknown = mirror.spaces;
    const space = subscription.space as string;
    if (Array.isArray(spaces) && !spaces.includes(space)) {
      throw new KI.KnowledgeIntakeValidationError(
        `storeAcquisition: 已验签策略 ${decision.policyId}@${decision.policyVersion} 的 spaces`
          + ` 不覆盖 subscription space "${space}"`,
        "POLICY_SPACE_MISMATCH",
      );
    }
    const at = new Date(KI.iso(acquiredAt) ?? new Date().toISOString()).getTime();
    const from = new Date(mirror.valid_from as string).getTime();
    const until = new Date(mirror.valid_until as string).getTime();
    if (Number.isFinite(at) && ((Number.isFinite(from) && at < from) || (Number.isFinite(until) && at >= until))) {
      throw new KI.KnowledgeIntakeValidationError(
        `storeAcquisition: acquisition 时刻 ${new Date(at).toISOString()} 不在已验签策略有效期`
          + `[${String(mirror.valid_from)}, ${String(mirror.valid_until)}) 内`,
        "POLICY_NOT_VALID_NOW",
      );
    }
  }

  /** 304 unchanged 的零字节复用：必须命中既有 artifact 行（绝不新建零字节 artifact）。 */
  private async reuseArtifact(client: pg.PoolClient, input: StoreAcquisitionInput): Promise<string> {
    const existing = await client.query(
      `SELECT id, byte_length FROM knowledge_source_artifacts WHERE tenant_id = $1 AND raw_hash = $2`,
      [input.tenantId, input.artifact.rawHash],
    );
    if ((existing.rowCount ?? 0) === 0) {
      throw new KI.KnowledgeIntakeValidationError(
        `storeAcquisition: rawBytes 为空但 tenant=${input.tenantId} 没有 rawHash=${input.artifact.rawHash}`
          + " 的既有 artifact——不得以零字节 artifact 落库",
        "ARTIFACT_NOT_FOUND",
      );
    }
    const row = existing.rows[0] as KI.Row;
    if (Number(row.byte_length) !== input.artifact.byteLength) {
      throw new KI.KnowledgeIntakeConflictError(
        `storeAcquisition: rawHash=${input.artifact.rawHash} 已存在但 byteLength 不一致`
          + `（既有 ${row.byte_length}，新 ${input.artifact.byteLength}）——拒绝复用`,
      );
    }
    return row.id as string;
  }

  /** artifact 去重：同 tenant 同 raw_hash 复用既有行；byteLength 不一致视为冲突 fail closed。 */
  private async upsertArtifact(
    client: pg.PoolClient,
    input: StoreAcquisitionInput,
    rawBytes: Buffer,
  ): Promise<string> {
    const { rawHash, byteLength, contentType } = input.artifact;
    const id = randomUUID();
    const ins = await client.query(
      `INSERT INTO knowledge_source_artifacts
         (tenant_id, id, raw_hash, byte_length, content_type, raw_bytes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, raw_hash) DO NOTHING
       RETURNING id`,
      [input.tenantId, id, rawHash, byteLength, contentType ?? "", rawBytes],
    );
    if ((ins.rowCount ?? 0) === 1) return (ins.rows[0] as KI.Row).id as string;

    const existing = await client.query(
      `SELECT id, byte_length FROM knowledge_source_artifacts WHERE tenant_id = $1 AND raw_hash = $2`,
      [input.tenantId, rawHash],
    );
    if ((existing.rowCount ?? 0) === 0) {
      throw new KI.KnowledgeIntakeConflictError(
        `storeAcquisition: artifact 去重读取失败 tenant=${input.tenantId} rawHash=${rawHash}`,
      );
    }
    const artifactRow = existing.rows[0] as KI.Row;
    if (Number(artifactRow.byte_length) !== byteLength) {
      throw new KI.KnowledgeIntakeConflictError(
        `storeAcquisition: rawHash=${rawHash} 已存在但 byteLength 不一致`
          + `（既有 ${artifactRow.byte_length}，新 ${byteLength}）——拒绝复用`,
      );
    }
    return artifactRow.id as string;
  }

  /** 依赖边 append-only：同一 (tenant, dependentKind, dependentId, revision) 重复登记幂等不覆盖。 */
  async recordDependency(input: SourceDependencyInput): Promise<void> {
    await KI.insertDependency(this.pool, input);
  }

  /**
   * N29 Task 5：事务绑定依赖边登记——KnowledgeIngestor 必须让 candidate 写入、
   * VerificationPlan 创建与 candidate→revision 依赖边落在**同一个**事务里
   * （任一步失败 → 整体回滚，不留孤儿 candidate 或孤儿 plan）。
   */
  async recordDependencyInTx(client: pg.PoolClient, input: SourceDependencyInput): Promise<void> {
    await KI.insertDependency(client, input);
  }

  /** stale 标记：tenant + subscription 作用域；可排除当前 revision；返回被标记的 dependent id。 */
  async markDependentsStale(input: MarkDependentsStaleInput): Promise<readonly string[]> {
    const rows = await KI.markDependentsStaleRows(this.pool, input);
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
  ): Promise<readonly KI.StaleDependentRow[]> {
    return KI.markDependentsStaleRows(client, input);
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
    const r = res.rows[0] as KI.Row;
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
    return (res.rowCount ?? 0) === 1 ? KI.mapSubscription(res.rows[0]) : null;
  }

  async getRun(tenantId: string, runId: string): Promise<IntakeRun | null> {
    const res = await this.pool.query(
      `SELECT ${KI.RUN_COLUMNS} FROM knowledge_intake_runs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, runId],
    );
    return (res.rowCount ?? 0) === 1 ? KI.mapRun(res.rows[0] as KI.Row) : null;
  }

  async getRevision(tenantId: string, revisionId: string): Promise<SourceRevision | null> {
    const res = await this.pool.query(
      `SELECT ${KI.REVISION_COLUMNS} FROM knowledge_source_revisions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, revisionId],
    );
    return (res.rowCount ?? 0) === 1 ? KI.mapRevision(res.rows[0] as KI.Row) : null;
  }

  async listRevisions(tenantId: string, subscriptionId: string): Promise<readonly SourceRevision[]> {
    const res = await this.pool.query(
      `SELECT ${KI.REVISION_COLUMNS} FROM knowledge_source_revisions
        WHERE tenant_id = $1 AND subscription_id = $2
        ORDER BY acquired_at, id`,
      [tenantId, subscriptionId],
    );
    return (res.rows as KI.Row[]).map(KI.mapRevision);
  }

  async listAttempts(tenantId: string, runId: string): Promise<readonly IntakeAttempt[]> {
    const res = await this.pool.query(
      `SELECT * FROM knowledge_intake_attempts
        WHERE tenant_id = $1 AND run_id = $2 ORDER BY id`,
      [tenantId, runId],
    );
    return (res.rows as KI.Row[]).map(KI.mapAttempt);
  }

  async listDependencies(tenantId: string, subscriptionId: string): Promise<readonly SourceDependency[]> {
    const res = await this.pool.query(
      `SELECT * FROM knowledge_source_dependencies
        WHERE tenant_id = $1 AND subscription_id = $2 ORDER BY id`,
      [tenantId, subscriptionId],
    );
    return (res.rows as KI.Row[]).map(KI.mapDependency);
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
  ): Promise<readonly KI.StaleDependentRow[]>;
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
  opts: KI.KnowledgeIntakeRepositoryOptions = {},
): PgKnowledgeIntakeRepositoryFace {
  return new PgKnowledgeIntakeRepository(pool, opts);
}