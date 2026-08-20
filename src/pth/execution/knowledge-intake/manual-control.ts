/**
 * knowledge-intake/manual-control.ts — N33 Task 5：operator console 的 intake 窄控制面。
 *
 * 定位：gateway routes-intake 的唯一支撑服务。两个写操作：
 *  - createSubscription：委托既有 `createKnowledgeIntakeSubscriptionService`
 *    （N29 门禁零削弱——authorizeFetch/authorizeUse 与已验签 policy 安装由原入口执行）。
 *    本层只加两道闸：policy tenant 必须与调用方 auth tenant 一致；调用方钉定的
 *    期望 policy id/version/digest 与当前已验签策略不一致即拒绝（防 policy 替换）。
 *  - triggerSubscriptionRun：单事务「创建/唤醒」一个原生 run——
 *    SELECT FOR UPDATE 订阅 → 已有未终结 run 则直接返回它（唤醒语义，不产生重复 run）
 *    → 否则同事务 INSERT run（reason=manual-retry）+ 推进 next_crawl_at +
 *    enqueue intake.fetch outbox。绝不接受任意 URL：抓取目标永远来自订阅行本身。
 *
 * 幂等：idempotencyKey 派生确定性原生 ID（run/subscription 主键），重复键命中
 * 主键唯一约束 → 读回原始 run/subscription 返回。不依赖进程内存账本，重启后仍成立。
 *
 * 本服务不签发/修改 policy、不直连 TrustPolicy 验签以外的任何写路径。
 */

import { createHash } from "node:crypto";
import type pg from "pg";
import type {
  IntakeRun,
  KnowledgeIntakeRepository,
  SourceSubscription,
  VerifiedTrustPolicy,
} from "../../contracts/index.js";
import { withTx } from "../../kernel/storage/pg.js";
import { enqueueSideEffectInTx } from "../../tasking/index.js";
import {
  createKnowledgeIntakeSubscriptionService,
  INTAKE_STAGE_OUTBOX_KINDS,
  type VerifiedPolicyProvider,
} from "./service.js";
import type { DeclaredSourceAttributes } from "./fetch-broker.js";

export type IntakeManualControlErrorCode =
  | "POLICY_MISMATCH"
  | "SUBSCRIPTION_NOT_FOUND"
  | "SUBSCRIPTION_NOT_ELIGIBLE"
  | "INVALID_INPUT";

export class IntakeManualControlError extends Error {
  constructor(
    readonly code: IntakeManualControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IntakeManualControlError";
  }
}

export interface IntakeManualControlScope {
  readonly tenantId: string;
}

export interface ManualSubscribeInput {
  readonly space: string;
  readonly canonicalUri: string;
  readonly domainId: string;
  readonly recrawlIntervalMs: number;
  readonly declared: DeclaredSourceAttributes;
  /** 操作员侧幂等键（= PTL previewId）；重复键返回原订阅。 */
  readonly idempotencyKey?: string;
  /** 操作员钉定的期望策略三元组；与当前已验签策略不一致即拒绝。 */
  readonly expectedPolicy?: {
    readonly id?: string;
    readonly version?: string;
    readonly digest?: string;
  };
}

export interface IntakeManualControlService {
  createSubscription(
    scope: IntakeManualControlScope,
    input: ManualSubscribeInput,
  ): Promise<SourceSubscription>;
  triggerSubscriptionRun(
    scope: IntakeManualControlScope,
    subscriptionId: string,
    idempotencyKey: string,
  ): Promise<IntakeRun>;
  getRun(scope: IntakeManualControlScope, runId: string): Promise<IntakeRun | null>;
  getSubscription(
    scope: IntakeManualControlScope,
    subscriptionId: string,
  ): Promise<SourceSubscription | null>;
}

export interface IntakeManualControlDeps {
  readonly pool: pg.Pool;
  readonly repository: Pick<
    KnowledgeIntakeRepository,
    "installVerifiedPolicy" | "createSubscription" | "getSubscription" | "getRun"
  >;
  /** 生产：进程启动时 loadVerifiedTrustPolicy 一次加载的已验签策略（或 provider）。 */
  readonly policy: VerifiedPolicyProvider;
  readonly fetchOutboxKind?: string;
  readonly clock?: () => Date;
}

const NON_EMPTY = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function deterministicId(prefix: string, tenantId: string, key: string): string {
  const hex = createHash("sha256").update(`${tenantId}\n${key}`, "utf8").digest("hex");
  return `${prefix}-${hex.slice(0, 40)}`;
}

function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

const OPEN_RUN_STATUSES = ["queued", "leased", "waiting"] as const;
const ELIGIBLE_SUBSCRIPTION_STATUSES = ["probing", "active"] as const;

interface RunRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  reason: IntakeRun["reason"];
  stage: IntakeRun["stage"];
  status: IntakeRun["status"];
  attempt: number | string;
  lease_token?: string | null;
  lease_generation: number | string;
  locked_until?: string | null;
  source_revision_id?: string | null;
  candidate_id?: string | null;
  verification_plan_id?: string | null;
  last_error?: string | null;
  row_version: number | string;
}

function mapRun(r: RunRow): IntakeRun {
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

const RUN_COLUMNS = `tenant_id, id, subscription_id, reason, stage, status, attempt, lease_token,
  lease_generation, locked_until, source_revision_id, candidate_id, verification_plan_id,
  last_error, row_version`;

export function createIntakeManualControlService(
  deps: IntakeManualControlDeps,
): IntakeManualControlService {
  const fetchOutboxKind = deps.fetchOutboxKind ?? INTAKE_STAGE_OUTBOX_KINDS.fetch;
  const clock = deps.clock ?? (() => new Date());

  async function resolvePolicy(): Promise<VerifiedTrustPolicy> {
    return typeof deps.policy === "function" ? await deps.policy() : deps.policy;
  }

  function assertPolicyPinned(
    policy: VerifiedTrustPolicy,
    expected: ManualSubscribeInput["expectedPolicy"],
  ): void {
    if (!expected) return;
    const actualDigest = policy.digest ?? policy.manifest.digest;
    if (expected.id !== undefined && expected.id !== policy.manifest.policyId) {
      throw new IntakeManualControlError(
        "POLICY_MISMATCH",
        `expected policy id ${expected.id} does not match the verified policy ${policy.manifest.policyId}`,
      );
    }
    if (expected.version !== undefined && expected.version !== policy.manifest.version) {
      throw new IntakeManualControlError(
        "POLICY_MISMATCH",
        `expected policy version ${expected.version} does not match the verified policy ${policy.manifest.version}`,
      );
    }
    if (expected.digest !== undefined && expected.digest !== actualDigest) {
      throw new IntakeManualControlError(
        "POLICY_MISMATCH",
        "expected policy digest does not match the verified policy digest",
      );
    }
  }

  return {
    async createSubscription(scope, input) {
      if (!NON_EMPTY(scope?.tenantId)) {
        throw new IntakeManualControlError("INVALID_INPUT", "tenant scope is required");
      }
      if (!NON_EMPTY(input?.space)) {
        throw new IntakeManualControlError("INVALID_INPUT", "space is required (from auth claim)");
      }
      const policy = await resolvePolicy();
      // 已验签策略的 tenant 是事实源：auth tenant 与策略 tenant 不一致 → fail closed。
      if (policy.manifest.tenantId !== scope.tenantId) {
        throw new IntakeManualControlError(
          "POLICY_MISMATCH",
          `verified policy tenant ${policy.manifest.tenantId} does not match the authenticated tenant`,
        );
      }
      assertPolicyPinned(policy, input.expectedPolicy);

      const subscriptionService = createKnowledgeIntakeSubscriptionService({
        repository: deps.repository,
        policy,
      });
      const deterministicSubscriptionId = NON_EMPTY(input.idempotencyKey)
        ? deterministicId("sub-manual", scope.tenantId, input.idempotencyKey)
        : undefined;
      try {
        return await subscriptionService.subscribe({
          space: input.space,
          canonicalUri: input.canonicalUri,
          domainId: input.domainId,
          recrawlIntervalMs: input.recrawlIntervalMs,
          declared: input.declared,
          ...(deterministicSubscriptionId !== undefined ? { id: deterministicSubscriptionId } : {}),
        });
      } catch (err) {
        // 幂等重放：确定性主键（或同 URI 唯一索引）冲突 → 返回原始订阅。
        if (sqlStateOf(err) === "23505") {
          const existing = deterministicSubscriptionId
            ? await deps.repository.getSubscription(scope.tenantId, deterministicSubscriptionId)
            : null;
          if (existing) return existing;
        }
        throw err;
      }
    },

    async triggerSubscriptionRun(scope, subscriptionId, idempotencyKey) {
      if (!NON_EMPTY(scope?.tenantId)) {
        throw new IntakeManualControlError("INVALID_INPUT", "tenant scope is required");
      }
      if (!NON_EMPTY(subscriptionId)) {
        throw new IntakeManualControlError("INVALID_INPUT", "subscriptionId is required");
      }
      if (!NON_EMPTY(idempotencyKey)) {
        throw new IntakeManualControlError("INVALID_INPUT", "idempotencyKey is required");
      }
      const runId = deterministicId("run-manual", scope.tenantId, idempotencyKey);

      // 快路径：确定性 run id 已存在 → 重复键直接返回原 run（即使已完成）。
      const existing = await deps.repository.getRun(scope.tenantId, runId);
      if (existing) return existing;

      try {
        return await withTx(deps.pool, async (client) => {
          const subRes = await client.query(
            `SELECT tenant_id, id, space, canonical_uri, domain_id, status,
                    recrawl_interval_ms, last_successful_revision_id
               FROM knowledge_source_subscriptions
              WHERE tenant_id = $1 AND id = $2
              FOR UPDATE`,
            [scope.tenantId, subscriptionId],
          );
          const s = subRes.rows[0] as
            | {
                tenant_id: string;
                id: string;
                space: string;
                canonical_uri: string;
                domain_id: string;
                status: string;
                recrawl_interval_ms: number | string;
                last_successful_revision_id: string | null;
              }
            | undefined;
          if (!s) {
            throw new IntakeManualControlError(
              "SUBSCRIPTION_NOT_FOUND",
              `subscription not found: ${subscriptionId}`,
            );
          }
          if (!(ELIGIBLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)) {
            throw new IntakeManualControlError(
              "SUBSCRIPTION_NOT_ELIGIBLE",
              `subscription ${subscriptionId} is ${s.status}——仅 probing/active 可手动触发`,
            );
          }

          // 唤醒语义：已有未终结 run → 返回它（同一 subscription 同时最多一个 open run）。
          const openRes = await client.query(
            `SELECT ${RUN_COLUMNS} FROM knowledge_intake_runs
              WHERE tenant_id = $1 AND subscription_id = $2 AND status = ANY($3::text[])
              LIMIT 1`,
            [scope.tenantId, subscriptionId, [...OPEN_RUN_STATUSES]],
          );
          if (openRes.rows[0]) {
            return mapRun(openRes.rows[0] as RunRow);
          }

          const now = clock();
          const ins = await client.query(
            `INSERT INTO knowledge_intake_runs (tenant_id, id, subscription_id, reason, stage, status)
             VALUES ($1,$2,$3,'manual-retry','fetch','queued')
             RETURNING ${RUN_COLUMNS}`,
            [scope.tenantId, runId, subscriptionId],
          );
          const run = mapRun(ins.rows[0] as RunRow);

          // 与 due scanner 一致：建 run 同事务推进 next_crawl_at（避免立刻被调度重复建 run）。
          const advanced = await client.query(
            `UPDATE knowledge_source_subscriptions
                SET next_crawl_at = $3::timestamptz + (recrawl_interval_ms * interval '1 millisecond'),
                    row_version = row_version + 1,
                    updated_at = now()
              WHERE tenant_id = $1 AND id = $2
              RETURNING row_version`,
            [scope.tenantId, subscriptionId, now.toISOString()],
          );
          if ((advanced.rowCount ?? 0) !== 1) {
            throw new IntakeManualControlError(
              "INVALID_INPUT",
              `advance next_crawl_at failed for subscription ${subscriptionId}`,
            );
          }

          await enqueueSideEffectInTx(client, {
            key: `${fetchOutboxKind}:${runId}`,
            tenantId: scope.tenantId,
            kind: fetchOutboxKind,
            payload: {
              runId,
              tenantId: scope.tenantId,
              subscriptionId,
              space: s.space,
              canonicalUri: s.canonical_uri,
              domainId: s.domain_id,
              stage: "fetch",
              reason: "manual-retry",
            },
          });
          return run;
        });
      } catch (err) {
        // 并发触发同一幂等键：主键冲突 → 读回原始 run。
        if (sqlStateOf(err) === "23505") {
          const original = await deps.repository.getRun(scope.tenantId, runId);
          if (original) return original;
        }
        throw err;
      }
    },

    getRun(scope, runId) {
      return deps.repository.getRun(scope.tenantId, runId);
    },

    getSubscription(scope, subscriptionId) {
      return deps.repository.getSubscription(scope.tenantId, subscriptionId);
    },
  };
}
