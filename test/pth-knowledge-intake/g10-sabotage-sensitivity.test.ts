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
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { createKnowledgeIntakeRepository } from "../../src/pth/kernel/storage/knowledge-intake-pg.js";
import { PgMemoryStore } from "@away_from/pth-memory";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  decideSourceAdmission,
  loadVerifiedTrustPolicy,
} from "../../src/pth/execution/knowledge-intake/index.js";
import { attestVerifiedTrustPolicy } from "../../src/pth/contracts/knowledge-intake-attestation.js";
import type { TrustPolicyManifest } from "../../src/pth/contracts/index.js";
import type { PolicyBoundSourceAcquisitionEnvelope } from "../../src/pth/execution/knowledge-intake/fetch-broker.js";

const TENANT = "t-g10";
const SIGNER = "human:alice";

function manifestBody(domains: string[]): TrustPolicyManifest {
  return {
    policyId: "policy-g10",
    version: "v1",
    tenantId: TENANT,
    spaces: ["space-a"],
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    approvedBy: { kind: "human", principalId: SIGNER, tenantId: TENANT, issuer: "ptl-human-interface" },
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const body = manifestBody(domains);
  const digest = computePolicyDigest(body);
  const signature = edSign(null, canonicalPolicySigningBytes(body), privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
  return loadVerifiedTrustPolicy(
    { ...body, digest, approvalProof: { ...body.approvalProof, signature } },
    { [SIGNER]: publicKey.export({ type: "spki", format: "pem" }).toString() },
  );
}

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
    }, { tenantId: TENANT });

    // sabotage：evaluator 恒 ok → 空绑定 candidate 直接晋升（门被移除）。
    const sabotaged = await store.promoteOfficial(id, TENANT, 1, { promotedBy: "promoter" }, { evaluate: () => ({ ok: true as const }) });
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
    }, { tenantId: TENANT });
    await expect(store.promoteOfficial(id2, TENANT, 1, { promotedBy: "promoter" })).rejects.toThrow(/evaluator required/);
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
});
