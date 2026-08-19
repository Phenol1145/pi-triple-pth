/**
 * knowledge-intake/knowledge-ingestor.ts — N29 Task 5：strict KnowledgeIngestor。
 *
 * 职责：把「已 admitted 的 SourceRevision + extractor processor 自报的原子 claim」
 * 转成一条 **private draft** Knowledge Candidate + 一条持久 VerificationPlan + 一条
 * candidate→revision 依赖边，三者在**同一个** PostgreSQL 事务内原子写入。
 *
 * 硬约束（plan §2 Global Constraints / §5 Task 5 Step 3/4）：
 *  - 服务端复算是唯一真相：quote 从**已落库** revision 的 normalized representation
 *    重新读 `[start,end)`；LLM 自报 text/quoteHash 只作 tripwire，不一致即拒；
 *  - artifactHash / policyDecisionDigest 必须能由已落库 revision 逐字段重算得出；
 *  - 每个 claim 至少一条 evidence；revision / policy / tenant / space / domain 全部一致；
 *  - 非 admitted（quarantine / unchanged / rejected）revision 一律拒绝；
 *  - candidate 固定 `status="draft"` + private `spaceScope`；official 只能经 Promotion Service；
 *  - 空 evidence / 空 sourceBindingsDigest 不得建 plan（生产 `createVerificationPlan()`）；
 *  - producer / domain reviewer / adversarial reviewer / promoter 四个 principal 必须互不相同。
 */

import type pg from "pg";
import { buildKnowledgeProvenance, type MemoryEntry, type PgMemoryStore } from "@away_from/pth-memory";
import type {
  IngestSourceRevisionInput,
  IntakeEvidenceReference,
  IntakeVerificationPrincipals,
  KnowledgeIngestor,
  KnowledgeIntakeRepository,
  SourceDependencyInput,
  SourceRevision,
  VerifiedTrustPolicy,
} from "../../contracts/index.js";
import { withTx } from "../../kernel/storage/pg.js";
import {
  createVerificationPlan,
  type IntakeSourceBindingRecheck,
  type IntakeSourceBindingRecheckInput,
} from "../knowledge-promotion.js";
import { sourceBindingsDigestOf, type VerificationCheckRecord } from "../knowledge-verdicts.js";
import { computeIntakePolicyDecisionDigest } from "./admission.js";
import { sha256Hex } from "./fetch-broker.js";

/** 摄入前置条件不满足（写前 fail closed；零 candidate、零 plan、零依赖边）。 */
export class KnowledgeIngestValidationError extends Error {
  readonly code = "KNOWLEDGE_INGEST_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeIngestValidationError";
  }
}

/**
 * ingestor 需要的仓库面：冻结合同的读写 + 事务绑定依赖边登记
 * （M0 contracts 不得出现 `pg` 类型，故事务面按结构消费 PG 适配器）。
 */
export interface KnowledgeIngestorRepository extends KnowledgeIntakeRepository {
  recordDependencyInTx(client: pg.PoolClient, input: SourceDependencyInput): Promise<void>;
}

export interface KnowledgeIngestorDeps {
  readonly pool: pg.Pool;
  /** 事务绑定 candidate 写入（`writeInTx` 与 `write` 共用同一实现体）。 */
  readonly store: Pick<PgMemoryStore, "writeInTx">;
  readonly intake: KnowledgeIngestorRepository;
  /** candidate kind（必须属于 PROVENANCE_REQUIRED_KINDS，缺省 domain-fact）。 */
  readonly candidateKind?: string;
  readonly now?: () => number;
}

/** 服务端 evidence 构造器：只能从**已落库** revision + locator 派生（调用方无法伪造摘要）。 */
export function intakeEvidenceForClaim(
  revision: SourceRevision,
  locator: { readonly start: number; readonly end: number },
): IntakeEvidenceReference {
  if (revision.disposition !== "admitted" || !revision.usePolicyDecision) {
    throw new KnowledgeIngestValidationError(
      `intakeEvidenceForClaim: revision ${revision.id} is not an admitted revision with a use policy decision`,
    );
  }
  const quote = sliceQuote(revision.normalizedText, locator);
  return {
    sourceSubscriptionId: revision.subscriptionId,
    sourceRevisionId: revision.id,
    representation: "normalized-text",
    locator: { start: locator.start, end: locator.end },
    quoteHash: sha256Hex(quote),
    artifactHash: revision.rawHash,
    policyDecisionDigest: computeIntakePolicyDecisionDigest({
      fetchPolicyDecision: revision.fetchPolicyDecision,
      usePolicyDecision: revision.usePolicyDecision,
      artifactHash: revision.rawHash,
      normalizedTextHash: revision.normalizedTextHash,
    }),
  };
}

function sliceQuote(normalizedText: string, locator: { readonly start: number; readonly end: number }): string {
  const { start, end } = locator;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new KnowledgeIngestValidationError(
      `locator must be a non-empty half-open range inside the normalized representation (start=${start}, end=${end})`,
    );
  }
  if (end > normalizedText.length) {
    throw new KnowledgeIngestValidationError(
      `locator [${start},${end}) exceeds the normalized representation length ${normalizedText.length}`,
    );
  }
  return normalizedText.slice(start, end);
}

/** 四个角色 principal 必须互不相同（任意两个相同 → 抛错）。 */
export function assertDistinctIntakePrincipals(principals: IntakeVerificationPrincipals): void {
  const entries = Object.entries(principals) as Array<[keyof IntakeVerificationPrincipals, string]>;
  for (const [role, principalId] of entries) {
    if (typeof principalId !== "string" || principalId.trim() === "") {
      throw new KnowledgeIngestValidationError(`principals.${role} must be a non-empty principal id`);
    }
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i]![1] === entries[j]![1]) {
        throw new KnowledgeIngestValidationError(
          `producer / domain reviewer / adversarial reviewer / promoter must be four distinct principals`
          + `（${entries[i]![0]} and ${entries[j]![0]} share ${entries[i]![1]}）`,
        );
      }
    }
  }
}

const ACTIVE_SUBSCRIPTION_STATUSES = ["probing", "active"] as const;

/** redirect chain（完整 URL）→ 精确 https origin 集合（非 https / 非法 URL 被丢弃）。 */
function exactOriginsOf(chain: readonly string[], finalUri: string): string[] {
  const out = new Set<string>();
  for (const uri of [...chain, finalUri]) {
    try {
      const url = new URL(uri);
      if (url.protocol === "https:") out.add(url.origin);
    } catch {
      // 非法 URL 不进 origin 集合——authorizeUse 会因缺 origin 而 fail closed。
    }
  }
  return [...out];
}

export function createKnowledgeIngestor(deps: KnowledgeIngestorDeps): KnowledgeIngestor {
  const candidateKind = deps.candidateKind ?? "domain-fact";
  const now = deps.now ?? (() => Date.now());

  return {
    async ingest(input: IngestSourceRevisionInput) {
      // ① 结构与职责分离前置条件（零 IO）。
      if (!input || typeof input !== "object") {
        throw new KnowledgeIngestValidationError("ingest input must be an object");
      }
      if (!Array.isArray(input.claims) || input.claims.length === 0) {
        throw new KnowledgeIngestValidationError("ingest requires at least one extracted claim");
      }
      for (const key of ["tenantId", "space", "domainId"] as const) {
        if (typeof input[key] !== "string" || input[key].trim() === "") {
          throw new KnowledgeIngestValidationError(`ingest requires a non-empty ${key}`);
        }
      }
      if (typeof input.producer?.role !== "string" || input.producer.role.trim() === "") {
        throw new KnowledgeIngestValidationError("ingest requires producer.role");
      }
      if (typeof input.producer?.model !== "string" || input.producer.model.trim() === "") {
        throw new KnowledgeIngestValidationError("ingest requires producer.model");
      }
      assertDistinctIntakePrincipals(input.principals);

      const declaredRevision = input.revision;
      if (!declaredRevision || typeof declaredRevision.id !== "string" || declaredRevision.id.trim() === "") {
        throw new KnowledgeIngestValidationError("ingest requires a stored SourceRevision id");
      }
      // ② 非 admitted revision 立即拒绝（quarantine/unchanged/rejected 都不得进入 extractor 产物）。
      if (declaredRevision.disposition !== "admitted") {
        throw new KnowledgeIngestValidationError(
          `ingest requires an admitted source revision (revision ${declaredRevision.id} is "${declaredRevision.disposition}")`,
        );
      }
      // ③ tenant 一致（跨 tenant 摄入零可见）。
      if (declaredRevision.tenantId !== input.tenantId) {
        throw new KnowledgeIngestValidationError(
          `tenant mismatch: revision tenant ${declaredRevision.tenantId} != declared tenant ${input.tenantId}`,
        );
      }

      // ④ 只信任已落库 revision（append-only、不可变）——自报字段全部丢弃。
      const stored = await deps.intake.getRevision(input.tenantId, declaredRevision.id);
      if (!stored) {
        throw new KnowledgeIngestValidationError(
          `source revision ${declaredRevision.id} not found in tenant ${input.tenantId}`,
        );
      }
      if (stored.disposition !== "admitted") {
        throw new KnowledgeIngestValidationError(
          `stored source revision ${stored.id} is not admitted (disposition "${stored.disposition}")`,
        );
      }
      if (!stored.usePolicyDecision || stored.usePolicyDecision.decision !== "allow") {
        throw new KnowledgeIngestValidationError(
          `stored source revision ${stored.id} lacks an allow use-policy decision`,
        );
      }
      if (stored.normalizedTextHash !== sha256Hex(stored.normalizedText)) {
        throw new KnowledgeIngestValidationError(
          `stored source revision ${stored.id} normalized text hash does not match its normalized text`,
        );
      }

      // ⑤ space / domain 事实源是 SourceSubscription（不接受调用方自报）。
      const subscription = await deps.intake.getSubscription(input.tenantId, stored.subscriptionId);
      if (!subscription) {
        throw new KnowledgeIngestValidationError(
          `source subscription ${stored.subscriptionId} not found in tenant ${input.tenantId}`,
        );
      }
      if (subscription.space !== input.space) {
        throw new KnowledgeIngestValidationError(
          `space mismatch: subscription space ${subscription.space} != declared space ${input.space}`,
        );
      }
      if (subscription.domainId !== input.domainId) {
        throw new KnowledgeIngestValidationError(
          `domain mismatch: subscription domain ${subscription.domainId} != declared domain ${input.domainId}`,
        );
      }
      if (!(ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)) {
        throw new KnowledgeIngestValidationError(
          `subscription ${subscription.id} status "${subscription.status}" does not allow ingestion`,
        );
      }

      // ⑥ 服务端重算 policy decision digest 与 artifact hash 期望值。
      const expectedPolicyDigest = computeIntakePolicyDecisionDigest({
        fetchPolicyDecision: stored.fetchPolicyDecision,
        usePolicyDecision: stored.usePolicyDecision,
        artifactHash: stored.rawHash,
        normalizedTextHash: stored.normalizedTextHash,
      });

      // ⑦ 逐 claim / 逐 evidence 强校验；content 只用服务端重算的 quote。
      const evidence: IntakeEvidenceReference[] = [];
      const quotes: string[] = [];
      for (const [claimIndex, claim] of input.claims.entries()) {
        if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
          throw new KnowledgeIngestValidationError(
            `claim[${claimIndex}] requires at least one intake evidence reference`,
          );
        }
        const claimQuote = sliceQuote(stored.normalizedText, claim.locator);
        const claimQuoteHash = sha256Hex(claimQuote);
        if (claim.quoteHash !== claimQuoteHash) {
          throw new KnowledgeIngestValidationError(
            `claim[${claimIndex}] quoteHash ${claim.quoteHash} does not match the server-recomputed quote hash ${claimQuoteHash}`,
          );
        }
        // 不信任 LLM 自报文本：与 [start,end) 重算不一致 → 抽取结果视为不可信。
        if (claim.text !== claimQuote) {
          throw new KnowledgeIngestValidationError(
            `claim[${claimIndex}] self-reported text does not match the normalized representation at [${claim.locator.start},${claim.locator.end})`,
          );
        }
        quotes.push(claimQuote);

        for (const [refIndex, raw] of claim.evidence.entries()) {
          const where = `claim[${claimIndex}].evidence[${refIndex}]`;
          const expected = intakeEvidenceForClaim(stored, raw?.locator ?? claim.locator);
          if (raw?.representation !== "normalized-text") {
            throw new KnowledgeIngestValidationError(
              `${where} representation must be "normalized-text"`,
            );
          }
          if (raw.sourceRevisionId !== stored.id) {
            throw new KnowledgeIngestValidationError(
              `${where} sourceRevisionId ${raw.sourceRevisionId} does not match the admitted revision ${stored.id}`,
            );
          }
          if (raw.sourceSubscriptionId !== stored.subscriptionId) {
            throw new KnowledgeIngestValidationError(
              `${where} sourceSubscriptionId ${raw.sourceSubscriptionId} does not match subscription ${stored.subscriptionId}`,
            );
          }
          if (raw.artifactHash !== stored.rawHash) {
            throw new KnowledgeIngestValidationError(
              `${where} artifactHash ${raw.artifactHash} does not match the stored artifact hash ${stored.rawHash}`,
            );
          }
          if (raw.policyDecisionDigest !== expectedPolicyDigest) {
            throw new KnowledgeIngestValidationError(
              `${where} policyDecisionDigest ${raw.policyDecisionDigest} does not match the recomputed policy decision digest ${expectedPolicyDigest}`,
            );
          }
          if (raw.quoteHash !== expected.quoteHash) {
            throw new KnowledgeIngestValidationError(
              `${where} quoteHash ${raw.quoteHash} does not match the server-recomputed quote hash ${expected.quoteHash}`,
            );
          }
          evidence.push(expected);
        }
      }

      const sourceBindingsDigest = sourceBindingsDigestOf(evidence);
      if (sourceBindingsDigest.trim() === "") {
        throw new KnowledgeIngestValidationError("ingest produced an empty source binding digest");
      }

      // ⑧ candidate id 确定性派生 → 同输入重放幂等（plan id 在事务内按真实 revision 派生）。
      const content = quotes.join("\n\n");
      const candidateId = input.candidateId
        ?? `intake-candidate:${stored.id}:${sha256Hex(`${sourceBindingsDigest}\n${content}`).slice(0, 16)}`;
      // candidate meta 必须**逐字节确定性**（否则重放会递增 candidate revision 并让 plan 失活）：
      // provenance.createdAt 取不可变 revision 的 acquiredAt，而非墙钟。
      const acquiredAtMs = Date.parse(stored.acquiredAt);
      const createdAt = Number.isFinite(acquiredAtMs) ? acquiredAtMs : now();

      const checks: VerificationCheckRecord[] = [
        {
          checkId: `domain:${input.domainId}`,
          kind: "domain",
          domainId: input.domainId,
          quorum: 1,
          eligiblePrincipals: [input.principals.domainReviewer],
          separationFrom: [input.principals.producer, input.principals.adversarialReviewer, input.principals.promoter],
        },
        {
          checkId: "adversarial",
          kind: "adversarial",
          quorum: 1,
          eligiblePrincipals: [input.principals.adversarialReviewer],
          separationFrom: [input.principals.producer, input.principals.domainReviewer, input.principals.promoter],
        },
      ];

      const entry: MemoryEntry = {
        id: candidateId,
        tenantId: input.tenantId,
        kind: candidateKind,
        anchors: [input.domainId],
        content,
        // 外部内容只能产生 private draft candidate（G0 旁路门禁）。
        status: "draft",
        meta: {
          version: 1,
          spaceScope: { space: input.space, visibility: "private" as const },
          domains: [input.domainId],
          // 精确 Evidence Reference（读侧 Broker/Context 会投影为 KnowledgeEvidenceRef）。
          evidence,
          intake: {
            sourceSubscriptionId: stored.subscriptionId,
            sourceRevisionId: stored.id,
            representation: "normalized-text" as const,
            artifactHash: stored.rawHash,
            normalizedTextHash: stored.normalizedTextHash,
            policyDecisionDigest: expectedPolicyDigest,
            sourceBindingsDigest,
            tenantId: input.tenantId,
            space: input.space,
            domainId: input.domainId,
            producerPrincipalId: input.principals.producer,
            ...(input.runId !== undefined ? { runId: input.runId } : {}),
          },
          provenance: buildKnowledgeProvenance({
            content,
            sourceTaskId: input.runId ?? stored.runId ?? stored.id,
            // R3 的 producer-separation 判据比较 principalId 与 provenance.producerRole，
            // 因此 N29 candidate 在此携带 producer **principal id**（角色见 meta.intake）。
            producerRole: input.principals.producer,
            producerModel: input.producer.model,
            sourceRefs: [`source-revision:${stored.id}`, `source-subscription:${stored.subscriptionId}`],
            createdAt,
          }),
          verdicts: [],
        },
      };

      // ⑨ candidate + plan + dependency 同一事务原子写入。
      return withTx(deps.pool, async (client) => {
        const written = await deps.store.writeInTx(client, entry, {
          createdBy: input.producer.role,
          reason: "knowledge-intake",
        });
        const planId = input.planId ?? `intake-plan:${candidateId}:${written.version}`;
        const planResult = await createVerificationPlan(
          {
            planId,
            tenantId: input.tenantId,
            candidateId,
            candidateRevision: written.version,
            content,
            requiredDomains: [input.domainId],
            evidence,
            policyDecisionDigest: expectedPolicyDigest,
            sourceRevisionId: stored.id,
            checks,
            effect: null,
          },
          client,
        );
        if (!planResult.ok) {
          throw new KnowledgeIngestValidationError(`ingest could not create the verification plan: ${planResult.error}`);
        }
        await deps.intake.recordDependencyInTx(client, {
          tenantId: input.tenantId,
          subscriptionId: stored.subscriptionId,
          sourceRevisionId: stored.id,
          dependentKind: "candidate",
          dependentId: candidateId,
          dependentRevision: written.version,
          space: input.space,
          evidenceDigest: sourceBindingsDigest,
        });
        return { candidateId, candidateRevision: written.version, planId: planResult.plan.id };
      });
    },
  };
}

// ─── promotion 前的 current policy + source binding 复检 ───────────────

/** 复检只需要 policy 的只读使用面（与 admission 同一面）。 */
export type IntakeRecheckPolicySource = Pick<VerifiedTrustPolicy, "manifest" | "authorizeUse">;

export interface IntakeSourceBindingRecheckDeps {
  readonly intake: Pick<KnowledgeIntakeRepository, "getRevision" | "getSubscription" | "listDependencies" | "getArtifactMeta">;
  readonly policy: IntakeRecheckPolicySource | (() => IntakeRecheckPolicySource | Promise<IntakeRecheckPolicySource>);
  /** admission 时申报的 sourceType / license（复检需再次逐项落在当前规则集合内）。 */
  readonly declared?: { readonly sourceType: string; readonly license: string };
}

/**
 * 生产 recheck 实现：晋升锁内重新证明「不可变来源 + 当前人类签名策略」仍然支持该 official。
 * 任一环节不成立 → 返回 `{ok:false}`，`promoteOfficial()` 回滚整个事务（零 side effect）。
 */
export function createIntakeSourceBindingRecheck(
  deps: IntakeSourceBindingRecheckDeps,
): IntakeSourceBindingRecheck {
  return {
    async recheck(input: IntakeSourceBindingRecheckInput) {
      const { binding } = input;
      if (binding.tenantId !== input.tenantId) {
        return { ok: false, reason: `meta.intake tenant ${binding.tenantId} does not match promotion tenant ${input.tenantId}` };
      }

      const revision = await deps.intake.getRevision(input.tenantId, binding.sourceRevisionId);
      if (!revision) {
        return { ok: false, reason: `source revision ${binding.sourceRevisionId} is unknown or withdrawn in tenant ${input.tenantId}` };
      }
      if (revision.disposition !== "admitted" || !revision.usePolicyDecision) {
        return { ok: false, reason: `source revision ${revision.id} is no longer an admitted revision` };
      }
      if (revision.subscriptionId !== binding.sourceSubscriptionId) {
        return { ok: false, reason: `source revision ${revision.id} does not belong to subscription ${binding.sourceSubscriptionId}` };
      }
      if (revision.rawHash !== binding.artifactHash) {
        return { ok: false, reason: `source revision ${revision.id} artifact hash changed since ingestion` };
      }

      const currentPolicyDigest = computeIntakePolicyDecisionDigest({
        fetchPolicyDecision: revision.fetchPolicyDecision,
        usePolicyDecision: revision.usePolicyDecision,
        artifactHash: revision.rawHash,
        normalizedTextHash: revision.normalizedTextHash,
      });
      if (currentPolicyDigest !== binding.policyDecisionDigest) {
        return { ok: false, reason: `policy decision digest changed since ingestion for revision ${revision.id}` };
      }

      // evidence 的 quote 必须仍能从 revision 逐字节重算（stale evidence 一律拒绝）。
      for (const [index, raw] of input.evidence.entries()) {
        const ref = raw as IntakeEvidenceReference | undefined;
        if (!ref || ref.representation !== "normalized-text") {
          return { ok: false, reason: `evidence[${index}] is not a normalized-text intake reference` };
        }
        if (ref.sourceRevisionId !== revision.id) {
          return { ok: false, reason: `evidence[${index}] points at a different source revision` };
        }
        const { start, end } = ref.locator ?? { start: -1, end: -1 };
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > revision.normalizedText.length) {
          return { ok: false, reason: `evidence[${index}] locator no longer addresses the normalized representation` };
        }
        if (sha256Hex(revision.normalizedText.slice(start, end)) !== ref.quoteHash) {
          return { ok: false, reason: `evidence[${index}] quote hash no longer matches the stored source revision` };
        }
      }

      const subscription = await deps.intake.getSubscription(input.tenantId, binding.sourceSubscriptionId);
      if (!subscription) {
        return { ok: false, reason: `source subscription ${binding.sourceSubscriptionId} is unknown in tenant ${input.tenantId}` };
      }
      if (!(ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)) {
        return { ok: false, reason: `source subscription ${subscription.id} status "${subscription.status}" no longer allows use` };
      }

      // 当前策略必须仍然 allow（过期 / 轮换 / 撤销 / deny 规则都在此翻红）。
      const policy = typeof deps.policy === "function" ? await deps.policy() : deps.policy;
      const rule = policy.manifest.rules.find((r) => r.ruleId === revision.usePolicyDecision!.ruleId);
      if (!rule) {
        return { ok: false, reason: `rule ${revision.usePolicyDecision.ruleId} is not part of the current trust policy` };
      }
      // P0-7 修复：从 artifact 读取真实 byteLength，不再硬编码 0。
      const artifactMeta = await deps.intake.getArtifactMeta(input.tenantId, revision.rawHash);
      const realByteLength = artifactMeta?.byteLength ?? 0;
      const decision = policy.authorizeUse({
        tenantId: input.tenantId,
        space: binding.space,
        url: revision.finalUri,
        // authorizeUse 只接受 exact https origin——redirectChain 是完整 URL，需归一化。
        redirectOrigins: exactOriginsOf(revision.redirectChain, revision.finalUri),
        sourceType: deps.declared?.sourceType ?? rule.sourceTypes[0] ?? "",
        contentType: revision.contentType,
        license: deps.declared?.license ?? rule.licenses[0] ?? "",
        byteLength: realByteLength,
        domain: binding.domainId,
        subscriptionStatus: subscription.status,
      });
      if (decision.decision !== "allow") {
        return { ok: false, reason: `current trust policy no longer authorizes use: ${decision.reason}` };
      }
      if (decision.policyDigest !== policy.manifest.digest) {
        return { ok: false, reason: "current trust policy digest does not match the signed manifest" };
      }

      // candidate→revision 依赖边必须未被标记 stale。
      const dependencies = await deps.intake.listDependencies(input.tenantId, binding.sourceSubscriptionId);
      const edge = dependencies.find(
        (d) => d.dependentId === input.candidateId && d.sourceRevisionId === revision.id,
      );
      if (!edge) {
        return { ok: false, reason: `candidate ${input.candidateId} has no source dependency edge on revision ${revision.id}` };
      }
      if (edge.stale) {
        return { ok: false, reason: `candidate ${input.candidateId} source dependency is stale（${edge.staleReason ?? "source-changed"}）` };
      }
      if (edge.evidenceDigest !== "" && edge.evidenceDigest !== sourceBindingsDigestOf(input.evidence)) {
        return { ok: false, reason: `candidate ${input.candidateId} source dependency evidence digest changed since ingestion` };
      }

      return { ok: true };
    },
  };
}
