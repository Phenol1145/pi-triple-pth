/**
 * g10-sabotage-sensitivity.test.ts —— N29 再验收 G10：sentinel 敏感度（sabotage 敏感度）证明。
 *
 * 每条 sabotage 通过**真实生产注入缝**移除一个门禁，断言对应防线确实随之失守
 * （sentinel 翻红）；同一组件在基线配置下必须拒绝。只允许改动依赖/输入，不直写指标。
 *
 * 冻结映射：
 *  - trust-policy-attestation-bypass → fakePolicyInstall sentinel
 *  - digest-binding-skip             → legacyEmptyBindingPromotion sentinel
 *  - stale-gate-skip（use-policy）    → unchangedUsePolicyDeny sentinel
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { createKnowledgeIntakeRepository } from "@away_from/pth-kernel-storage";
import { PgMemoryStore } from "@away_from/pth-memory";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  decideSourceAdmission,
  loadVerifiedTrustPolicy,
  selectEvidenceQuoteVerifier,
} from "../../src/pth/execution/knowledge-intake/index.js";
import { attestVerifiedTrustPolicy } from "@away_from/pth-contracts";
import type { TrustPolicyManifest } from "@away_from/pth-contracts";
import type { PolicyBoundSourceAcquisitionEnvelope } from "../../src/pth/execution/knowledge-intake/fetch-broker.js";

const TENANT = "t-g10";
const SIGNER = "human:alice";

function manifestBody(
  domains: string[],
  tenantId: string = TENANT,
  policyId = "policy-g10",
): TrustPolicyManifest {
  return {
    policyId,
    version: "v1",
    tenantId,
    spaces: ["space-a"],
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    approvedBy: { kind: "human", principalId: SIGNER, tenantId, issuer: "ptl-human-interface" },
    approvalProof: { method: "signed-manifest", keyId: SIGNER, signature: "" },
    rules: [
      {
        ruleId: "rule-1",
        effect: "allow",
        httpsOrigin: "https://docs.example.org",
        pathPrefix: "/guide/",
        spaces: ["space-a"],
        domains,
        sourceTypes: ["html"],
        contentTypes: ["text/html"],
        licenses: ["cc-by-4.0"],
        maxBytes: 1_000_000,
        redirectOrigins: ["https://docs.example.org"],
      },
    ],
    digest: "",
  };
}

async function verifiedPolicy(domains: string[]) {
  return verifiedPolicyFor(TENANT, "policy-g10", domains);
}

async function verifiedPolicyFor(tenantId: string, policyId: string, domains: string[]) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const body = manifestBody(domains, tenantId, policyId);
  const digest = computePolicyDigest(body);
  const signature = edSign(null, canonicalPolicySigningBytes(body), privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
  return loadVerifiedTrustPolicy(
    { ...body, digest, approvalProof: { ...body.approvalProof, signature } },
    { [SIGNER]: publicKey.export({ type: "spki", format: "pem" }).toString() },
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("N29 再验收 G10：sabotage 敏感度（真实生产注入缝）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 120_000);

  it("trust-policy-attestation-bypass：仓库未注入 verifier 时，手工盖章的伪造 policy 可安装（门被移除）；注入 verifier 后被拒（fakePolicyInstall 翻红）", async () => {
    const signed = await verifiedPolicy(["mathematics"]);
    const signedManifest = signed.manifest;
    // 伪造：篡改 rules 后重算 digest，但 signature 是对旧字节的——验签必败。
    const tampered: TrustPolicyManifest = {
      ...signedManifest,
      rules: signedManifest.rules.map((r) => ({ ...r, maxBytes: 999_999_999 })),
    };
    const forged = attestVerifiedTrustPolicy(
      {
        manifest: tampered,
        digest: tampered.digest,
        verifiedAt: "2026-08-19T00:00:00.000Z",
        verifiedBy: tampered.approvedBy,
        installedBy: SIGNER,
        authorizeFetch: () => { throw new Error("forged"); },
        authorizeUse: () => { throw new Error("forged"); },
      } as never,
      {
        tenantId: tampered.tenantId,
        policyId: tampered.policyId,
        policyVersion: tampered.version,
        digest: tampered.digest,
        signerKind: "human",
        signerPrincipalId: tampered.approvedBy.principalId,
        signerIssuer: tampered.approvedBy.issuer,
        approvalMethod: tampered.approvalProof.method,
        approvalKeyId: tampered.approvalProof.keyId,
        verifiedAt: "2026-08-19T00:00:00.000Z",
      },
    );

    // sabotage：不注入 policyVerifier → 品牌/形状检查通过（验签门被移除）→ 伪造安装成功。
    const sabotaged = createKnowledgeIntakeRepository(pool);
    await sabotaged.installVerifiedPolicy(forged);
    const mirror = await pool.query(
      `SELECT policy_digest FROM knowledge_trust_policies WHERE tenant_id = $1 AND policy_id = $2`,
      [TENANT, tampered.policyId],
    );
    expect(mirror.rowCount).toBe(1);

    // 基线：同一伪造对象，注入 verifier 的仓库重新验签 → 拒绝。
    const { publicKey } = generateKeyPairSync("ed25519");
    const keyring = { [SIGNER]: publicKey.export({ type: "spki", format: "pem" }).toString() };
    const guarded = createKnowledgeIntakeRepository(pool, {
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate as TrustPolicyManifest, keyring),
    });
    await expect(guarded.installVerifiedPolicy(forged)).rejects.toThrow(/not verified|signature|digest/i);
  });

  it("digest-binding-skip：naive evaluator（恒 ok）可绕过 canPromote 把空绑定 candidate 晋升 official（门被移除）；真实门禁拒绝（legacyEmptyBindingPromotion 翻红）", async () => {
    const store = new PgMemoryStore(pool);
    const id = `g10-digest-${Date.now()}`;
    // draft candidate：空 evidence + 空 sourceBindingsDigest（legacy 形状）。
    await store.write({
      id,
      tenantId: TENANT,
      kind: "domain-fact",
      anchors: ["mathematics"],
      content: "sabotage candidate",
      status: "draft",
      meta: { provenance: { sourceTaskId: "t", producerRole: "producer", producerModel: "m", sourceRefs: ["r"], contentHash: createHash("sha256").update("sabotage candidate").digest("hex"), createdAt: 1 }, version: 1, evidence: [] },
    });

    // sabotage：evaluator 恒 ok → 空绑定 candidate 直接晋升（门被移除）。
    const sabotaged = await store.promoteOfficial(id, TENANT, 1, { promotedBy: "promoter", promotedAt: 1 }, { evaluate: () => ({ ok: true as const }) });
    expect(sabotaged.ok).toBe(true);
    expect((await store.get(id, { tenantId: TENANT }))?.status).toBe("official");

    // 基线：缺 evaluator → 抛错（门在）。
    const id2 = `${id}-baseline`;
    await store.write({
      id: id2,
      tenantId: TENANT,
      kind: "domain-fact",
      anchors: ["mathematics"],
      content: "baseline candidate",
      status: "draft",
      meta: { provenance: { sourceTaskId: "t", producerRole: "producer", producerModel: "m", sourceRefs: ["r"], contentHash: createHash("sha256").update("baseline candidate").digest("hex"), createdAt: 1 }, version: 1, evidence: [] },
    });
    await expect(store.promoteOfficial(id2, TENANT, 1, { promotedBy: "promoter", promotedAt: 1 })).rejects.toThrow(/evaluator required/);
  });

  it("stale-gate-skip（use-policy 恒 allow）：unchanged 内容在 deny 策略下 verdict=deny（门在）；换恒 allow 策略后 verdict=reuse-unchanged（门被移除，unchangedUsePolicyDeny 翻红）", async () => {
    const bytes = Buffer.from("<html><body>x</body></html>", "utf8");
    const rawHash = createHash("sha256").update(bytes).digest("hex");
    const makeEnvelope = (policyDigest: string): PolicyBoundSourceAcquisitionEnvelope => ({
      requestedUri: "https://docs.example.org/guide/intro",
      finalUri: "https://docs.example.org/guide/intro",
      redirectChain: ["https://docs.example.org/guide/intro"],
      tenantId: TENANT,
      space: "space-a",
      subscriptionId: "sub-g10",
      status: 304,
      notModified: true,
      headers: { contentType: "text/html", contentTypeRaw: "text/html; charset=utf-8", charset: "utf-8" },
      rawBytes: new Uint8Array(0),
      rawHash,
      normalizedText: "x",
      normalizedTextHash: createHash("sha256").update("x").digest("hex"),
      byteLength: 0,
      acquiredAt: "2026-08-19T00:00:00.000Z",
      policyDecisionRef: { policyId: "policy-g10", policyVersion: "v1", policyDigest, ruleId: "rule-1", decision: "allow", decidedAt: "2026-08-19T00:00:00.000Z" },
      hops: [],
      hopDecisions: [],
      contentTypeApproved: true,
      conditional: true,
      normalization: "normalized-text",
    } as unknown as PolicyBoundSourceAcquisitionEnvelope);

    // 基线：当前策略 domains 不含 mathematics → use deny → verdict=deny（门在，unchanged 不得成功）。
    const denying = await verifiedPolicy(["not-mathematics"]);
    const denied = decideSourceAdmission({ policy: denying }, {
      envelope: makeEnvelope(denying.manifest.digest),
      tenantId: TENANT,
      space: "space-a",
      subscriptionId: "sub-g10",
      domain: "mathematics",
      sourceType: "html",
      license: "cc-by-4.0",
      subscriptionStatus: "active",
    });
    expect(denied.verdict).toBe("deny");
    expect(denied.mayStoreAdmittedRevision).toBe(false);

    // sabotage：换成恒 allow 策略（移除 use-policy 门禁）→ 同一 unchanged 内容 verdict=reuse-unchanged。
    const allowing = await verifiedPolicy(["mathematics"]);
    const allowed = decideSourceAdmission({ policy: allowing }, {
      envelope: makeEnvelope(allowing.manifest.digest),
      tenantId: TENANT,
      space: "space-a",
      subscriptionId: "sub-g10",
      domain: "mathematics",
      sourceType: "html",
      license: "cc-by-4.0",
      subscriptionStatus: "active",
    });
    expect(allowed.verdict, JSON.stringify({ denyCodes: allowed.denyCodes, reasons: allowed.reasons })).toBe("reuse-unchanged");
  });

  it("evidence-gate-skip：注入恒接受的 evidenceQuoteVerifier 时，quoteHash 被篡改的证据仍可通过（门被移除）；缺省服务端复算拒绝（evidenceQuoteRecheck 翻红）", async () => {
    const revision = { id: "source-revision:evidence-g10", normalizedText: "evidence gate sentinel" };
    const goodQuote = "evidence";
    const valid = {
      sourceRevisionId: revision.id,
      locator: { start: 0, end: goodQuote.length },
      quoteHash: createHash("sha256").update(goodQuote).digest("hex"),
    };
    const tampered = {
      ...valid,
      quoteHash: createHash("sha256").update("tampered quote").digest("hex"),
    };

    // 基线：缺省 verifier = 服务端严格复算——合法证据通过，篡改 quoteHash 一律拒绝。
    const strict = selectEvidenceQuoteVerifier();
    expect(strict({ revision, evidence: [valid] })).toEqual([goodQuote]);
    expect(() => strict({ revision, evidence: [tampered] })).toThrow(/quote hash does not match the stored source revision/);

    // sabotage：通过生产依赖缝注入恒接受 verifier → 同一篡改证据被当成可信 quote。
    const sabotaged = selectEvidenceQuoteVerifier(async () => ["forged quote from removed gate"]);
    await expect(sabotaged({ revision, evidence: [tampered] })).resolves.toEqual(["forged quote from removed gate"]);
  });

  it("lease-gate-skip：注入恒 true leaseGuard 时，过期 lease 仍可阶段提交并写 outbox（门被移除，expiredLease 翻红）；缺省严格门禁零行", async () => {
    const tenantId = "t-g10-lease";
    const policy = await verifiedPolicyFor(tenantId, "policy-g10-lease", ["mathematics"]);
    const repo = createKnowledgeIntakeRepository(pool);
    await repo.installVerifiedPolicy(policy);
    await repo.createSubscription({
      tenantId,
      space: "space-a",
      canonicalUri: "https://docs.example.org/guide/lease",
      domainId: "mathematics",
      policyId: policy.manifest.policyId,
      policyVersion: policy.manifest.version,
      policyDigest: policy.manifest.digest,
      policyRuleId: policy.manifest.rules[0]!.ruleId,
      recrawlIntervalMs: 3_600_000,
      nextCrawlAt: new Date(Date.now() - 60_000),
    });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({
      tenantId,
      runId: run!.id,
      principalId: "worker:lease-a",
      executionId: "exec-lease-a",
      leaseMs: 80,
    });
    expect(claimed).not.toBeNull();
    await sleep(160);

    const transition = {
      tenantId,
      runId: run!.id,
      fromStage: "fetch" as const,
      toStage: "admit" as const,
      status: "queued" as const,
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      principalId: "worker:lease-a",
      executionId: "exec-lease-a",
      sideEffects: [{ key: `lease-sabotage:${run!.id}`, kind: "intake.admit", payload: { runId: run!.id } }],
    } as const;

    const outboxBefore = async (): Promise<number> =>
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1`, [tenantId])).rows[0]!.n;
    const before = await outboxBefore();

    // 基线：缺省严格 lease 门禁 → 过期 lease 零行、零 outbox。
    expect(await repo.transitionRun(transition)).toBeNull();
    expect(await outboxBefore()).toBe(before);

    // sabotage：同一输入，注入恒 true 门禁 → 过期 lease 迁移成功且 outbox 同事务写入。
    const sabotaged = createKnowledgeIntakeRepository(pool, {
      leaseGuard: { canCommit: () => true },
    });
    const moved = await sabotaged.transitionRun(transition);
    expect(moved).not.toBeNull();
    expect(moved!.stage).toBe("admit");
    expect(moved!.status).toBe("queued");
    expect(await outboxBefore()).toBe(before + 1);
  });
});
