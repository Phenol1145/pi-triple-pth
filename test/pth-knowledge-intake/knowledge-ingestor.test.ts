/**
 * test/pth-knowledge-intake/knowledge-ingestor.test.ts — N29 Task 5 红/绿测。
 *
 * 覆盖（plan §5 Task 5 Step 1/3/4/6）：
 *  - quarantined（非 admitted）revision 一律拒绝；
 *  - claim 无 evidence 拒绝；
 *  - quoteHash / artifactHash / policyDecisionDigest 与「已落库 revision」不一致拒绝；
 *  - LLM 自报 text 与服务端 [start,end) 重算不一致拒绝（不信任自报文本）；
 *  - tenant / space / domain 任一不一致拒绝；跨 tenant revision 零可见；
 *  - 空 evidence / 空 sourceBindingsDigest 不得建 VerificationPlan；
 *  - 合法摄入原子产出 private draft candidate + 持久 VerificationPlan + source dependency 边；
 *  - 同输入重复摄入幂等（candidate/plan/dependency 各一份，candidateRevision 不涨）；
 *  - promotion 必须重新校验 current policy + source binding（缺 recheck → fail closed；
 *    dependency stale / revision 撤出 → 拒绝）。
 *
 * 本套件不使用 Docker skip 守卫：结论只能由真实 PostgreSQL + 生产 repository/事务给出。
 * 只有外部 HTTP 被替换（envelope 由真实 normalizeSourceText + 真实签名 policy 组装）；
 * repository、事务、VerificationPlan、Promotion、KnowledgeIngestor 均为生产实现。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgMemoryStore } from "@away_from/pth-memory";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { createKnowledgeIntakeRepository } from "../../src/pth/kernel/storage/knowledge-intake-pg.js";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  createIntakeSourceBindingRecheck,
  createKnowledgeIngestor,
  decideSourceAdmission,
  intakeEvidenceForClaim,
  loadVerifiedTrustPolicy,
  normalizeSourceText,
  type KnowledgeIngestorRepository,
  type PolicyBoundSourceAcquisitionEnvelope,
} from "../../src/pth/execution/knowledge-intake/index.js";
import {
  createPgKnowledgeVerificationRepo,
  createVerificationPlan,
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
} from "../../src/pth/execution/knowledge-promotion.js";
import type {
  IntakeEvidenceReference,
  KnowledgeIngestor,
  SourceRevision,
  TrustPolicyManifest,
  VerifiedTrustPolicy,
} from "../../src/pth/contracts/index.js";

/** 测试内 SQL 行形状（`src/types/pg.d.ts` 的 QueryResult 行默认 unknown；这里显式给出行形状以纳入 N29 typecheck 门禁）。 */
type SqlRow = Record<string, any>;

const sha256Hex = (s: string | Uint8Array): string =>
  createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)).digest("hex");

const SPACE = "space-a";
const DOMAIN = "mathematics";
const ORIGIN = "https://docs.example.org";
const URI = `${ORIGIN}/guide/intro`;
const HTML =
  "<html><body><h1>Euclid</h1><p>The sum of the interior angles of a triangle equals 180 degrees.</p></body></html>";

const PRODUCER = "worker:extractor:producer";
const DOMAIN_REVIEWER = "worker:domain:mathematics-reviewer";
const ADVERSARIAL_REVIEWER = "worker:controller:adversarial";
const PROMOTER = "worker:memory-keeper";

interface Harness {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly policy: VerifiedTrustPolicy;
  readonly admitted: SourceRevision;
  readonly quarantined: SourceRevision;
  readonly evidence: IntakeEvidenceReference;
  readonly quote: string;
}

describe("N29 Task 5 strict KnowledgeIngestor（真实 PG + 生产 plan/promotion）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let repo: KnowledgeIngestorRepository;
  let store: PgMemoryStore;
  let ingestor: KnowledgeIngestor;
  let verificationRepo: ReturnType<typeof createPgKnowledgeVerificationRepo>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    repo = createKnowledgeIntakeRepository(pool, { leaseTtlMs: 60_000 });
    store = new PgMemoryStore(pool);
    verificationRepo = createPgKnowledgeVerificationRepo(pool);
    ingestor = createKnowledgeIngestor({ pool, store, intake: repo });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  }, 120_000);

  let seq = 0;
  const nextTenant = (label: string): string => `t-ing-${label}-${++seq}`;

  function signedManifest(tenantId: string): { manifest: TrustPolicyManifest; keyring: Record<string, string> } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const base: TrustPolicyManifest = {
      policyId: `policy-${tenantId}`,
      version: "1",
      tenantId,
      spaces: [SPACE],
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: "2099-01-01T00:00:00.000Z",
      approvedBy: { kind: "human", principalId: "human-alice", tenantId, issuer: "ptl-human-interface" },
      approvalProof: { method: "signed-manifest", keyId: "human-alice", signature: "" },
      rules: [
        {
          ruleId: "rule-docs",
          effect: "allow",
          httpsOrigin: ORIGIN,
          pathPrefix: "/guide/",
          spaces: [SPACE],
          domains: [DOMAIN],
          sourceTypes: ["bounded-html"],
          contentTypes: ["text/html"],
          licenses: ["public-domain"],
          maxBytes: 1_000_000,
          redirectOrigins: [ORIGIN],
        },
      ],
      digest: "",
    };
    const digest = computePolicyDigest(base);
    const signature = edSign(null, canonicalPolicySigningBytes(base), privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    const manifest: TrustPolicyManifest = {
      ...base,
      digest,
      approvalProof: { ...base.approvalProof, signature },
    };
    return { manifest, keyring: { "human-alice": publicKey.export({ type: "spki", format: "pem" }).toString() } };
  }

  /** 组装 harness：真实签名 policy + 真实归一化 + 真实 admission + 生产 repository 落库。 */
  async function seed(label: string): Promise<Harness> {
    const tenantId = nextTenant(label);
    const { manifest, keyring } = signedManifest(tenantId);
    const policy = await loadVerifiedTrustPolicy(manifest, keyring);
    // P0-3：必须递交验签器签发的那个对象本身（`{...policy}` 拷贝会丢失运行时 attestation → 被拒）。
    await repo.installVerifiedPolicy(policy);

    const subscription = await repo.createSubscription({
      tenantId,
      space: SPACE,
      canonicalUri: URI,
      domainId: DOMAIN,
      policyId: manifest.policyId,
      policyVersion: manifest.version,
      policyDigest: manifest.digest,
      policyRuleId: "rule-docs",
      recrawlIntervalMs: 3_600_000,
    });

    const bytes = Buffer.from(HTML, "utf8");
    const normalized = normalizeSourceText(bytes, "text/html; charset=utf-8");
    const fetchDecision = policy.authorizeFetch({
      tenantId,
      space: SPACE,
      url: URI,
      redirectOrigins: [ORIGIN],
      sourceType: "bounded-html",
      contentType: "text/html",
      license: "public-domain",
      byteLength: bytes.byteLength,
    });
    expect(fetchDecision.decision).toBe("allow");

    const envelope: PolicyBoundSourceAcquisitionEnvelope = {
      requestedUri: URI,
      finalUri: URI,
      redirectChain: [URI],
      status: 200,
      headers: { contentType: "text/html", contentTypeRaw: "text/html; charset=utf-8", charset: "utf-8" },
      rawBytes: bytes,
      rawHash: sha256Hex(bytes),
      normalizedText: normalized.text,
      normalizedTextHash: normalized.hash,
      tenantId,
      space: SPACE,
      subscriptionId: subscription.id,
      byteLength: bytes.byteLength,
      acquiredAt: new Date().toISOString(),
      policyDecisionRef: fetchDecision,
      hopDecisions: [fetchDecision],
      hops: [{ url: URI, origin: ORIGIN, status: 200, addresses: [{ address: "93.184.216.34", family: 4 }] }],
      notModified: false,
      contentTypeApproved: true,
      normalization: normalized.representation,
      conditional: {},
    };

    const verdict = decideSourceAdmission(
      { policy },
      {
        envelope,
        tenantId,
        space: SPACE,
        subscriptionId: subscription.id,
        domain: DOMAIN,
        sourceType: "bounded-html",
        license: "public-domain",
        subscriptionStatus: subscription.status,
      },
    );
    expect(verdict.denyCodes).toEqual([]);
    expect(verdict.verdict).toBe("admit");

    const quarantined = await repo.storeAcquisition({
      tenantId,
      subscriptionId: subscription.id,
      artifact: { rawHash: envelope.rawHash, byteLength: envelope.byteLength, rawBytes: envelope.rawBytes, contentType: "text/html" },
      revision: {
        requestedUri: URI,
        finalUri: URI,
        redirectChain: [URI],
        acquiredAt: envelope.acquiredAt,
        responseStatus: 200,
        contentType: "text/html",
        normalizedText: envelope.normalizedText,
        normalizedTextHash: envelope.normalizedTextHash,
        disposition: verdict.quarantinedDisposition,
        fetchPolicyDecision: verdict.fetchPolicyDecision,
      },
    });

    const admitted = await repo.storeAcquisition({
      tenantId,
      subscriptionId: subscription.id,
      artifact: { rawHash: envelope.rawHash, byteLength: envelope.byteLength, rawBytes: envelope.rawBytes, contentType: "text/html" },
      revision: {
        requestedUri: URI,
        finalUri: URI,
        redirectChain: [URI],
        acquiredAt: envelope.acquiredAt,
        responseStatus: 200,
        contentType: "text/html",
        normalizedText: envelope.normalizedText,
        normalizedTextHash: envelope.normalizedTextHash,
        disposition: "admitted",
        fetchPolicyDecision: verdict.fetchPolicyDecision,
        usePolicyDecision: verdict.usePolicyDecision,
        derivedFromRevisionId: quarantined.id,
      },
    });

    const quote = "The sum of the interior angles of a triangle equals 180 degrees.";
    const start = admitted.normalizedText.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    // 生产 helper：evidence 引用只能由服务端从已落库 revision 重算得出。
    const evidence = intakeEvidenceForClaim(admitted, { start, end: start + quote.length });

    return { tenantId, subscriptionId: subscription.id, policy, admitted, quarantined, evidence, quote };
  }

  function ingestInput(h: Harness, over: Record<string, unknown> = {}) {
    return {
      revision: h.admitted,
      tenantId: h.tenantId,
      space: SPACE,
      domainId: DOMAIN,
      producer: { role: PRODUCER, model: "deepseek-v4-flash", executionId: "run-extract-1" },
      principals: {
        producer: PRODUCER,
        domainReviewer: DOMAIN_REVIEWER,
        adversarialReviewer: ADVERSARIAL_REVIEWER,
        promoter: PROMOTER,
      },
      claims: [{ text: h.quote, locator: h.evidence.locator, quoteHash: h.evidence.quoteHash, evidence: [h.evidence] }],
      ...over,
    } as never;
  }

  it("valid ingestion writes a private draft candidate + persistent plan + dependency edge", async () => {
    const h = await seed("ok");
    const result = await ingestor.ingest(ingestInput(h));

    expect(result.candidateId).toBeTruthy();
    expect(result.planId).toBeTruthy();
    expect(result.candidateRevision).toBe(1);

    const entry = await store.get(result.candidateId, { tenantId: h.tenantId });
    expect(entry?.status).toBe("draft");
    expect(entry?.content).toBe(h.quote);
    expect(entry?.meta?.spaceScope).toEqual({ space: SPACE, visibility: "private" });
    expect(entry?.meta?.evidence).toEqual([h.evidence]);
    expect((entry?.meta?.intake as Record<string, unknown>)?.sourceRevisionId).toBe(h.admitted.id);

    const plan = await verificationRepo.getPlan(result.planId, h.tenantId);
    expect(plan?.status).toBe("open");
    expect(plan?.candidateId).toBe(result.candidateId);
    expect(plan?.candidateRevision).toBe(1);
    expect(plan?.sourceBindingsDigest).not.toBe("");
    expect(plan?.requiredDomains).toEqual([DOMAIN]);
    expect(plan?.checks.map((c) => c.kind).sort()).toEqual(["adversarial", "domain"]);

    const deps = await repo.listDependencies(h.tenantId, h.subscriptionId);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      dependentKind: "candidate",
      dependentId: result.candidateId,
      sourceRevisionId: h.admitted.id,
      space: SPACE,
      stale: false,
    });
  });

  it("rejects a quarantined (non-admitted) revision", async () => {
    const h = await seed("quarantine");
    await expect(ingestor.ingest(ingestInput(h, { revision: h.quarantined }))).rejects.toThrow(/admitted/i);
    expect(await repo.listDependencies(h.tenantId, h.subscriptionId)).toHaveLength(0);
  });

  it("rejects a claim without evidence", async () => {
    const h = await seed("noev");
    await expect(
      ingestor.ingest(ingestInput(h, { claims: [{ text: h.quote, locator: h.evidence.locator, quoteHash: h.evidence.quoteHash, evidence: [] }] })),
    ).rejects.toThrow(/evidence/i);
    expect(await repo.listDependencies(h.tenantId, h.subscriptionId)).toHaveLength(0);
  });

  it("rejects mismatched quoteHash / artifactHash / policyDecisionDigest", async () => {
    const h = await seed("hash");
    const bogus = "0".repeat(64);

    await expect(
      ingestor.ingest(ingestInput(h, {
        claims: [{ text: h.quote, locator: h.evidence.locator, quoteHash: bogus, evidence: [{ ...h.evidence, quoteHash: bogus }] }],
      })),
    ).rejects.toThrow(/quoteHash/i);

    await expect(
      ingestor.ingest(ingestInput(h, {
        claims: [{ text: h.quote, locator: h.evidence.locator, quoteHash: h.evidence.quoteHash, evidence: [{ ...h.evidence, artifactHash: bogus }] }],
      })),
    ).rejects.toThrow(/artifactHash/i);

    await expect(
      ingestor.ingest(ingestInput(h, {
        claims: [{ text: h.quote, locator: h.evidence.locator, quoteHash: h.evidence.quoteHash, evidence: [{ ...h.evidence, policyDecisionDigest: bogus }] }],
      })),
    ).rejects.toThrow(/policyDecisionDigest/i);

    expect(await repo.listDependencies(h.tenantId, h.subscriptionId)).toHaveLength(0);
  });

  it("does not trust the LLM self-reported claim text (server recomputes [start,end))", async () => {
    const h = await seed("selfreport");
    await expect(
      ingestor.ingest(ingestInput(h, {
        claims: [{ text: "Triangles have 200 degrees.", locator: h.evidence.locator, quoteHash: h.evidence.quoteHash, evidence: [h.evidence] }],
      })),
    ).rejects.toThrow(/self-reported/i);
    expect(await repo.listDependencies(h.tenantId, h.subscriptionId)).toHaveLength(0);
  });

  it("rejects mismatched tenant / space / domain", async () => {
    const h = await seed("scope");
    await expect(ingestor.ingest(ingestInput(h, { tenantId: `${h.tenantId}-other` }))).rejects.toThrow(/tenant/i);
    await expect(ingestor.ingest(ingestInput(h, { space: "space-z" }))).rejects.toThrow(/space/i);
    await expect(ingestor.ingest(ingestInput(h, { domainId: "physics" }))).rejects.toThrow(/domain/i);
    expect(await repo.listDependencies(h.tenantId, h.subscriptionId)).toHaveLength(0);
  });

  it("isolates tenants: a revision from tenant A is invisible to a tenant B ingestion", async () => {
    const a = await seed("iso-a");
    const b = await seed("iso-b");
    await expect(
      ingestor.ingest(ingestInput(a, { tenantId: b.tenantId, revision: { ...a.admitted, tenantId: b.tenantId } })),
    ).rejects.toThrow(/revision|not found|subscription/i);
    expect(await repo.listDependencies(b.tenantId, b.subscriptionId)).toHaveLength(0);
  });

  it("refuses to create a VerificationPlan with empty evidence or empty sourceBindingsDigest", async () => {
    const h = await seed("emptyplan");
    const empty = await createVerificationPlan(
      {
        planId: "plan-empty-evidence",
        tenantId: h.tenantId,
        candidateId: "cand-empty-evidence",
        candidateRevision: 1,
        content: h.quote,
        requiredDomains: [DOMAIN],
        evidence: [],
        policyDecisionDigest: h.evidence.policyDecisionDigest,
        sourceRevisionId: h.admitted.id,
        checks: [
          { checkId: "domain-1", kind: "domain", domainId: DOMAIN, quorum: 1, eligiblePrincipals: [DOMAIN_REVIEWER], separationFrom: [PRODUCER] },
          { checkId: "adv-1", kind: "adversarial", quorum: 1, eligiblePrincipals: [ADVERSARIAL_REVIEWER], separationFrom: [PRODUCER] },
        ],
      },
      pool,
    );
    expect(empty).toMatchObject({ ok: false, error: expect.stringMatching(/evidence|source binding/i) });

    const noAdversarial = await createVerificationPlan(
      {
        planId: "plan-no-adversarial",
        tenantId: h.tenantId,
        candidateId: "cand-no-adversarial",
        candidateRevision: 1,
        content: h.quote,
        requiredDomains: [DOMAIN],
        evidence: [h.evidence],
        policyDecisionDigest: h.evidence.policyDecisionDigest,
        sourceRevisionId: h.admitted.id,
        checks: [
          { checkId: "domain-1", kind: "domain", domainId: DOMAIN, quorum: 1, eligiblePrincipals: [DOMAIN_REVIEWER], separationFrom: [PRODUCER] },
        ],
      },
      pool,
    );
    expect(noAdversarial).toMatchObject({ ok: false, error: expect.stringMatching(/adversarial/i) });
  });

  it("is idempotent for a byte-identical re-ingestion", async () => {
    const h = await seed("idem");
    const first = await ingestor.ingest(ingestInput(h));
    const second = await ingestor.ingest(ingestInput(h));
    expect(second).toEqual(first);

    const deps = await repo.listDependencies(h.tenantId, h.subscriptionId);
    expect(deps).toHaveLength(1);
    const plans = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM knowledge_verification_plans WHERE tenant_id = $1`,
      [h.tenantId],
    );
    expect(plans.rows[0].n).toBe(1);
    const entry = await store.get(first.candidateId, { tenantId: h.tenantId });
    expect(entry?.meta?.version).toBe(1);
  });

  it("promotion fails closed without the current policy / source binding recheck, and succeeds with it", async () => {
    const h = await seed("promote");
    const { candidateId, planId } = await ingestor.ingest(ingestInput(h));

    const domainVerdict = await recordKnowledgeVerdict(
      store, verificationRepo, planId, `domain:${DOMAIN}`, 1,
      { kind: "domain", verdict: "pass", reviewerRole: "domain:mathematics", note: "quote matches source", at: 1, domainId: DOMAIN },
      { principalId: DOMAIN_REVIEWER, executionId: "run-domain-1" },
      { tenantId: h.tenantId },
    );
    expect(domainVerdict).toEqual({ ok: true });

    const advVerdict = await recordKnowledgeVerdict(
      store, verificationRepo, planId, "adversarial", 1,
      { kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial", note: "no unsupported leap", at: 2 },
      { principalId: ADVERSARIAL_REVIEWER, executionId: "run-adv-1" },
      { tenantId: h.tenantId },
    );
    expect(advVerdict).toEqual({ ok: true });

    // 缺 recheck 端口 → N29 candidate 不得晋升。
    const withoutRecheck = await promoteKnowledgeEntry(
      store, verificationRepo, candidateId, planId, 1,
      { principalId: PROMOTER, executionId: "run-promote-1" },
      { tenantId: h.tenantId },
    );
    expect(withoutRecheck).toMatchObject({ ok: false, error: expect.stringMatching(/recheck|source binding/i) });
    expect((await store.get(candidateId, { tenantId: h.tenantId }))?.status).toBe("draft");

    const recheck = createIntakeSourceBindingRecheck({ intake: repo, policy: h.policy });
    const promoted = await promoteKnowledgeEntry(
      store, verificationRepo, candidateId, planId, 1,
      { principalId: PROMOTER, executionId: "run-promote-1" },
      { tenantId: h.tenantId, intakeBinding: recheck },
    );
    expect(promoted).toEqual({ ok: true, id: candidateId });
    expect((await store.get(candidateId, { tenantId: h.tenantId }))?.status).toBe("official");
  });

  it("rejects promotion once the source dependency is stale", async () => {
    const h = await seed("stale");
    const { candidateId, planId } = await ingestor.ingest(ingestInput(h));

    await recordKnowledgeVerdict(
      store, verificationRepo, planId, `domain:${DOMAIN}`, 1,
      { kind: "domain", verdict: "pass", reviewerRole: "domain:mathematics", note: "quote matches source", at: 1, domainId: DOMAIN },
      { principalId: DOMAIN_REVIEWER, executionId: "run-domain-1" },
      { tenantId: h.tenantId },
    );
    await recordKnowledgeVerdict(
      store, verificationRepo, planId, "adversarial", 1,
      { kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial", note: "no unsupported leap", at: 2 },
      { principalId: ADVERSARIAL_REVIEWER, executionId: "run-adv-1" },
      { tenantId: h.tenantId },
    );

    await repo.markDependentsStale({ tenantId: h.tenantId, subscriptionId: h.subscriptionId, reason: "source-changed" });

    const recheck = createIntakeSourceBindingRecheck({ intake: repo, policy: h.policy });
    const promoted = await promoteKnowledgeEntry(
      store, verificationRepo, candidateId, planId, 1,
      { principalId: PROMOTER, executionId: "run-promote-1" },
      { tenantId: h.tenantId, intakeBinding: recheck },
    );
    expect(promoted).toMatchObject({ ok: false, error: expect.stringMatching(/stale/i) });
    expect((await store.get(candidateId, { tenantId: h.tenantId }))?.status).toBe("draft");
  });
});
