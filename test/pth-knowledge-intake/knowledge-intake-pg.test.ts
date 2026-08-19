/**
 * knowledge-intake-pg.test.ts — N29 Task 3 真实 PG 红/绿测（Subscription/Run/Artifact/Revision 真相源）。
 *
 * 覆盖（plan §5 Task 3 Step 1）：
 *  - verified policy manifest append-only 审计镜像（exact 重放幂等；同版本不同 digest 显式 conflict）；
 *  - subscription 去重（tenant+space+canonicalUri）与 probe/active/paused/revoked/retired 迁移 rowVersion CAS；
 *  - due run 原子创建：FOR UPDATE SKIP LOCKED + 同事务推进 next_crawl_at + 同事务 enqueue outbox；
 *  - 双 scanner 并发只建一个 run、next_crawl_at 只推进一次、只入队一条 outbox；
 *  - lease expiry recovery（generation 递增、旧 token 失效）；
 *  - 错 token / 错 generation / 错 rowVersion / 跨 tenant 一律零写且零 outbox；
 *  - artifact raw_hash tenant 内去重（返回既有 artifact id）、跨 tenant 不共享；
 *  - raw-quarantine 与 admitted 是彼此独立的 append-only 行（不得原地 UPDATE 正文）；
 *  - dependency append-only + stale 标记 tenant+subscription 作用域、跨 tenant 零可见。
 *
 * 本套件不使用 Docker skip 守卫：Task 3 的结论只能由真实 PostgreSQL 给出。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import {
  createKnowledgeIntakeRepository,
  KnowledgeIntakeConflictError,
  KnowledgeIntakeValidationError,
} from "../../src/pth/kernel/storage/knowledge-intake-pg.js";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  loadVerifiedTrustPolicy,
} from "../../src/pth/execution/knowledge-intake/index.js";
// P0-3 对抗测专用：直接使用内部 attestation 模块（故意不从 contracts barrel 导出）。
import { attestVerifiedTrustPolicy } from "../../src/pth/contracts/knowledge-intake-attestation.js";
import type {
  KnowledgeIntakeRepository,
  SourceSubscription,
  StoreAcquisitionInput,
  TrustPolicyManifest,
  VerifiedTrustPolicy,
} from "../../src/pth/contracts/index.js";

/** 测试内 SQL 行形状（`src/types/pg.d.ts` 的 QueryResult 行默认 unknown；这里显式给出行形状以纳入 N29 typecheck 门禁）。 */
type SqlRow = Record<string, any>;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SIGNER = "human:alice";

/** 未签名的 manifest 正文（digest/signature 留空，由 `signManifest()` 用生产算法补齐）。 */
function manifestBody(tenantId: string, over: Partial<TrustPolicyManifest> = {}): TrustPolicyManifest {
  return {
    policyId: "policy-intake",
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
        domains: ["mathematics"],
        sourceTypes: ["html"],
        contentTypes: ["text/html"],
        licenses: ["cc-by-4.0"],
        maxBytes: 1_000_000,
        redirectOrigins: ["https://docs.example.org"],
      },
    ],
    digest: "",
    ...over,
  };
}

/**
 * 真实 Ed25519 detached signature + 生产 canonical digest。
 *
 * 全套件共用一对密钥（只暴露 public key）：Ed25519 签名对相同字节是确定性的，
 * 因此“同 tenant 同策略正文”重复安装得到 **完全相同** 的 manifest → exact 重放幂等。
 */
let suiteKeypairCache: { publicKeyPem: string; privateKeyPem: string } | null = null;
function suiteKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  if (!suiteKeypairCache) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    suiteKeypairCache = {
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }
  return suiteKeypairCache;
}

function signManifest(body: TrustPolicyManifest): { manifest: TrustPolicyManifest; keyring: Record<string, string> } {
  const { publicKeyPem, privateKeyPem } = suiteKeypair();
  const digest = computePolicyDigest(body);
  const signature = edSign(null, canonicalPolicySigningBytes(body), privateKeyPem).toString("base64");
  return {
    manifest: { ...body, digest, approvalProof: { ...body.approvalProof, signature } },
    keyring: { [body.approvalProof.keyId]: publicKeyPem },
  };
}

/** 唯一合法入口：经生产 verifier 产出带运行时 attestation 的 VerifiedTrustPolicy。 */
function signedFor(
  tenantId: string,
  over: Partial<TrustPolicyManifest> = {},
): { manifest: TrustPolicyManifest; keyring: Record<string, string> } {
  return signManifest(manifestBody(tenantId, over));
}

async function realVerifiedPolicy(
  tenantId: string,
  over: Partial<TrustPolicyManifest> = {},
): Promise<VerifiedTrustPolicy> {
  const signed = signedFor(tenantId, over);
  return await loadVerifiedTrustPolicy(signed.manifest, signed.keyring);
}

/**
 * P0-3 对抗输入：与 `VerifiedTrustPolicy` 完全同形的普通对象（TypeScript 结构类型不是运行时 attestation）。
 * 任何进程内调用者都能构造它——仓库必须在写事务之前拒绝。
 */
function forgedVerified(manifest: TrustPolicyManifest): VerifiedTrustPolicy {
  return {
    manifest,
    digest: manifest.digest,
    verifiedAt: "2026-08-19T00:00:00.000Z",
    verifiedBy: manifest.approvedBy,
    installedBy: SIGNER,
    authorizeFetch: () => {
      throw new Error("forged policy must never be consulted");
    },
    authorizeUse: () => {
      throw new Error("forged policy must never be consulted");
    },
  } as unknown as VerifiedTrustPolicy;
}

/**
 * 更强的对抗输入：直接用内部 attestation 模块盖章（模拟“验签器被误用/被绕过语义校验”），
 * 用来测仓库自己的纵深防御（human principal / issuer / attestation↔manifest 对账），
 * 而不是只测品牌是否存在。`manifestOverride` 用于模拟“验签后换 manifest”。
 */
function handAttested(attestedManifest: TrustPolicyManifest, manifestOverride?: TrustPolicyManifest): VerifiedTrustPolicy {
  const policy = forgedVerified(manifestOverride ?? attestedManifest) as {
    manifest: TrustPolicyManifest;
  } & VerifiedTrustPolicy;
  return attestVerifiedTrustPolicy(policy, {
    tenantId: attestedManifest.tenantId,
    policyId: attestedManifest.policyId,
    policyVersion: attestedManifest.version,
    digest: attestedManifest.digest,
    signerKind: "human",
    signerPrincipalId: attestedManifest.approvedBy.principalId,
    signerIssuer: attestedManifest.approvedBy.issuer,
    approvalMethod: attestedManifest.approvalProof.method,
    approvalKeyId: attestedManifest.approvalProof.keyId,
    verifiedAt: "2026-08-19T00:00:00.000Z",
  });
}

describe("knowledge intake PG 真相源（N29 Task 3）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let repo: KnowledgeIntakeRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    repo = createKnowledgeIntakeRepository(pool, { leaseTtlMs: 60_000 });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
    // Docker 负载高时 container.stop() 可能超过默认 10s hookTimeout（既有 PG 套件的偶发 flake 源）。
  }, 120_000);

  /** 每个用例独立 tenant——共用容器不串扰。 */
  let seq = 0;
  const nextTenant = (label: string): string => `t-${label}-${++seq}`;

  async function installPolicy(tenantId: string): Promise<TrustPolicyManifest> {
    const policy = await realVerifiedPolicy(tenantId);
    await repo.installVerifiedPolicy(policy);
    return policy.manifest;
  }

  async function seedSubscription(
    tenantId: string,
    over: { status?: SourceSubscription["status"]; nextCrawlAt?: Date; canonicalUri?: string } = {},
  ): Promise<SourceSubscription> {
    const manifest = await installPolicy(tenantId);
    const created = await repo.createSubscription({
      tenantId,
      space: "space-a",
      canonicalUri: over.canonicalUri ?? "https://docs.example.org/guide/intro",
      domainId: "mathematics",
      policyId: manifest.policyId,
      policyVersion: manifest.version,
      policyDigest: manifest.digest,
      policyRuleId: manifest.rules[0].ruleId,
      recrawlIntervalMs: 3_600_000,
      nextCrawlAt: over.nextCrawlAt ?? new Date(Date.now() - 60_000),
    });
    if (over.status && over.status !== created.status) {
      const moved = await repo.transitionSubscription({
        tenantId,
        subscriptionId: created.id,
        expectedRowVersion: created.rowVersion,
        toStatus: over.status,
      });
      expect(moved).not.toBeNull();
      return moved as SourceSubscription;
    }
    return created;
  }

  async function countOutbox(tenantId: string): Promise<number> {
    const r = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1`, [tenantId]);
    return r.rows[0].n as number;
  }

  async function countRuns(tenantId: string): Promise<number> {
    const r = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_intake_runs WHERE tenant_id = $1`, [tenantId]);
    return r.rows[0].n as number;
  }

  const acquisitionInput = (
    tenantId: string,
    subscriptionId: string,
    runId: string,
    body: string,
    disposition: "raw-quarantine" | "admitted" | "unchanged",
    extra: { derivedFromRevisionId?: string; withUseDecision?: boolean } = {},
  ): StoreAcquisitionInput => {
    const manifestDigest = sha(`${tenantId}:policy-intake:v1`);
    const decision = {
      policyId: "policy-intake",
      policyVersion: "v1",
      policyDigest: manifestDigest,
      ruleId: "rule-1",
      decision: "allow" as const,
      decidedAt: "2026-08-19T00:00:00.000Z",
    };
    return {
      tenantId,
      subscriptionId,
      runId,
      artifact: {
        rawHash: sha(body),
        byteLength: Buffer.byteLength(body),
        rawBytes: new Uint8Array(Buffer.from(body)),
        contentType: "text/html",
      },
      revision: {
        requestedUri: "https://docs.example.org/guide/intro",
        finalUri: "https://docs.example.org/guide/intro",
        redirectChain: ["https://docs.example.org/guide/intro"],
        acquiredAt: "2026-08-19T00:00:00.000Z",
        responseStatus: 200,
        contentType: "text/html",
        etag: 'W/"v1"',
        normalizedText: body,
        normalizedTextHash: sha(`norm:${body}`),
        disposition,
        fetchPolicyDecision: decision,
        ...((extra.withUseDecision ?? disposition !== "raw-quarantine") ? { usePolicyDecision: decision } : {}),
        ...(extra.derivedFromRevisionId ? { derivedFromRevisionId: extra.derivedFromRevisionId } : {}),
      },
    };
  };

  // ---------------------------------------------------------------- schema 面

  it("七张最小表存在，可变聚合有 row_version，主查询键以 tenant_id 起头", async () => {
    const tables = [
      "knowledge_trust_policies",
      "knowledge_source_subscriptions",
      "knowledge_intake_runs",
      "knowledge_intake_attempts",
      "knowledge_source_artifacts",
      "knowledge_source_revisions",
      "knowledge_source_dependencies",
    ];
    for (const t of tables) {
      const r = await pool.query<SqlRow>(`SELECT to_regclass($1) AS r`, [t]);
      expect(r.rows[0].r, `table ${t} should exist`).toBeTruthy();
    }
    for (const t of ["knowledge_source_subscriptions", "knowledge_intake_runs", "knowledge_source_dependencies"]) {
      const r = await pool.query<SqlRow>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'row_version'`,
        [t],
      );
      expect(r.rows, `${t}.row_version`).toHaveLength(1);
    }
    // 主键（复合）首列必须是 tenant_id
    for (const t of [
      "knowledge_trust_policies",
      "knowledge_source_subscriptions",
      "knowledge_intake_runs",
      "knowledge_source_artifacts",
      "knowledge_source_revisions",
    ]) {
      const r = await pool.query<SqlRow>(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
          WHERE c.relname = $1 AND i.indisprimary`,
        [t],
      );
      expect(r.rows[0]?.attname, `${t} PK first column`).toBe("tenant_id");
    }
  });

  it("applySchema 幂等重放（二次执行不报错）", async () => {
    await applySchema(pool);
    const r = await pool.query<SqlRow>(`SELECT to_regclass('knowledge_source_revisions') AS r`);
    expect(r.rows[0].r).toBeTruthy();
  });

  // ---------------------------------------------------------------- policy 镜像

  it("installVerifiedPolicy：exact 重放幂等；manifest 正文不可 UPDATE", async () => {
    const tenantId = nextTenant("policy");
    const signed = signedFor(tenantId);
    const manifest = signed.manifest;
    await repo.installVerifiedPolicy(await loadVerifiedTrustPolicy(manifest, signed.keyring));
    // exact 重放：同 manifest 再验一次（新的 attestation）→ 幂等，仍然只有一行。
    await repo.installVerifiedPolicy(await loadVerifiedTrustPolicy(manifest, signed.keyring));
    const rows = await pool.query<SqlRow>(`SELECT * FROM knowledge_trust_policies WHERE tenant_id = $1`, [tenantId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].policy_digest).toBe(manifest.digest);

    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_trust_policies SET manifest = '{"hacked":true}'::jsonb WHERE tenant_id = $1`, [
        tenantId,
      ]),
    ).rejects.toThrow(/append-only|immutable/i);
    const after = await pool.query<SqlRow>(`SELECT manifest FROM knowledge_trust_policies WHERE tenant_id = $1`, [tenantId]);
    expect(after.rows[0].manifest.policyId).toBe(manifest.policyId);
  });

  it("installVerifiedPolicy：同 policyId/version 不同 digest 显式 conflict（DB 行不得替换策略）", async () => {
    const tenantId = nextTenant("policy-conflict");
    const manifest = await installPolicy(tenantId);
    // 同 policyId@version、真实签名、但正文不同（maxBytes 变化）→ digest 不同 → 显式 conflict。
    const other = await realVerifiedPolicy(tenantId, {
      rules: [{ ...manifestBody(tenantId).rules[0]!, maxBytes: 2_000_000 }],
    });
    expect(other.manifest.digest).not.toBe(manifest.digest);
    await expect(repo.installVerifiedPolicy(other)).rejects.toThrow(KnowledgeIntakeConflictError);
    const rows = await pool.query<SqlRow>(`SELECT policy_digest FROM knowledge_trust_policies WHERE tenant_id = $1`, [tenantId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].policy_digest).toBe(manifest.digest);
  });

  // -------------------------------------------- P0-3：verified 边界必须是运行时 attestation

  async function countPolicies(tenantId: string): Promise<number> {
    const rows = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM knowledge_trust_policies WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows.rows[0].n as number;
  }

  it("P0-3：结构同形但伪造 signature/digest 的 VerifiedTrustPolicy 安装为零行", async () => {
    const tenantId = nextTenant("policy-forged");
    const body = manifestBody(tenantId);
    const forged: TrustPolicyManifest = {
      ...body,
      digest: sha("forged-digest"),
      approvalProof: { ...body.approvalProof, signature: "definitely-not-valid" },
    };
    await expect(repo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(KnowledgeIntakeValidationError);
    await expect(repo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(/not verified|loadVerifiedTrustPolicy/);
    expect(await countPolicies(tenantId)).toBe(0);
  });

  it("P0-3：真实 verifier 产出的 policy 安装成功，其结构拷贝（丢失 attestation）被拒", async () => {
    const tenantId = nextTenant("policy-attested");
    const policy = await realVerifiedPolicy(tenantId);
    await repo.installVerifiedPolicy(policy);
    expect(await countPolicies(tenantId)).toBe(1);

    // spread 拷贝保留全部结构字段，但不再是被签发的那个对象 → 必须拒绝。
    const copy = { ...policy } as VerifiedTrustPolicy;
    await expect(repo.installVerifiedPolicy(copy)).rejects.toThrow(KnowledgeIntakeValidationError);
    expect(await countPolicies(tenantId)).toBe(1);
  });

  it("P0-3：service 签名的 policy（principal kind != human）安装为零行", async () => {
    const tenantId = nextTenant("policy-service-signer");
    const body = manifestBody(tenantId, {
      approvedBy: {
        kind: "service" as unknown as TrustPolicyManifest["approvedBy"]["kind"],
        principalId: SIGNER,
        tenantId,
        issuer: "ptl-human-interface",
      },
    });
    const signed = signManifest(body);
    // ① 生产 verifier 直接拒签（human signer 边界）。
    await expect(loadVerifiedTrustPolicy(signed.manifest, signed.keyring)).rejects.toThrow(/human signer/);
    // ② 绕开 verifier 直接调仓库同样零行。
    await expect(repo.installVerifiedPolicy(forgedVerified(signed.manifest))).rejects.toThrow(
      KnowledgeIntakeValidationError,
    );
    expect(await countPolicies(tenantId)).toBe(0);
  });

  it("P0-3：即使手工盖 attestation，service principal/错 issuer 仍被仓库拒（纵深防御）", async () => {
    const serviceTenant = nextTenant("policy-attested-service");
    const serviceBody = manifestBody(serviceTenant, {
      approvedBy: {
        kind: "service" as unknown as TrustPolicyManifest["approvedBy"]["kind"],
        principalId: SIGNER,
        tenantId: serviceTenant,
        issuer: "ptl-human-interface",
      },
    });
    await expect(repo.installVerifiedPolicy(handAttested(signManifest(serviceBody).manifest))).rejects.toThrow(
      /human principal/,
    );
    expect(await countPolicies(serviceTenant)).toBe(0);

    const issuerTenant = nextTenant("policy-attested-issuer");
    const issuerBody = manifestBody(issuerTenant, {
      approvedBy: {
        kind: "human",
        principalId: SIGNER,
        tenantId: issuerTenant,
        issuer: "ptl-platform-service" as unknown as TrustPolicyManifest["approvedBy"]["issuer"],
      },
    });
    await expect(repo.installVerifiedPolicy(handAttested(signManifest(issuerBody).manifest))).rejects.toThrow(
      /ptl-human-interface/,
    );
    expect(await countPolicies(issuerTenant)).toBe(0);
  });

  it("P0-3：attestation 与 manifest 身份不一致（验签后换 manifest）安装为零行", async () => {
    const tenantId = nextTenant("policy-attest-swap");
    const honest = signManifest(manifestBody(tenantId)).manifest;
    const swapped = signManifest(manifestBody(tenantId, { policyId: "policy-swapped" })).manifest;
    // attestation 记的是 honest 的身份，manifest 却换成了 swapped → 必须拒绝。
    const spliced = handAttested(honest, swapped);
    await expect(repo.installVerifiedPolicy(spliced)).rejects.toThrow(/attestation 与 manifest 不一致/);
    expect(await countPolicies(tenantId)).toBe(0);
  });

  it("P0-3（approach A）：注入 verifier 的仓库自行验签 raw manifest；伪签名仍零行", async () => {
    const tenantId = nextTenant("policy-injected-verifier");
    const signed = signedFor(tenantId);
    const verifyingRepo = createKnowledgeIntakeRepository(pool, {
      leaseTtlMs: 60_000,
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, signed.keyring),
    });

    // 未盖章的同形对象：仓库用注入 verifier 重新验签 → 真签名通过。
    await verifyingRepo.installVerifiedPolicy(forgedVerified(signed.manifest));
    expect(await countPolicies(tenantId)).toBe(1);

    // 伪造 signature 的同形对象：重新验签失败 → 零新行。
    const forgedTenant = nextTenant("policy-injected-forged");
    const forgedSigned = signedFor(forgedTenant);
    const forged: TrustPolicyManifest = {
      ...forgedSigned.manifest,
      approvalProof: { ...forgedSigned.manifest.approvalProof, signature: "definitely-not-valid" },
    };
    const forgingRepo = createKnowledgeIntakeRepository(pool, {
      leaseTtlMs: 60_000,
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, forgedSigned.keyring),
    });
    await expect(forgingRepo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(
      KnowledgeIntakeValidationError,
    );
    await expect(forgingRepo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(/not verified/);
    expect(await countPolicies(forgedTenant)).toBe(0);
  });

  it("P0-3（approach A）：注入 verifier 后连手工盖章的伪造 policy 也会被重新验签拒绝", async () => {
    const tenantId = nextTenant("policy-restamped-forgery");
    const honest = signedFor(tenantId);
    // 品牌齐全（手工盖章）+ 结构完整的 human manifest，但 signature 是伪造的：
    // 生产装配（注入 verifier）会无条件重新验签 → 密码学上拒绝。
    const forgedManifest: TrustPolicyManifest = {
      ...honest.manifest,
      approvalProof: { ...honest.manifest.approvalProof, signature: "definitely-not-valid" },
    };
    const verifyingRepo = createKnowledgeIntakeRepository(pool, {
      leaseTtlMs: 60_000,
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, honest.keyring),
    });
    await expect(verifyingRepo.installVerifiedPolicy(handAttested(forgedManifest))).rejects.toThrow(
      KnowledgeIntakeValidationError,
    );
    expect(await countPolicies(tenantId)).toBe(0);
  });

  // ---------------------------------------------------------------- subscription

  it("createSubscription：probing 起步；同 tenant+space+uri 去重返回同一行", async () => {
    const tenantId = nextTenant("sub");
    const first = await seedSubscription(tenantId);
    expect(first.status).toBe("probing");
    expect(first.rowVersion).toBe(1);

    const again = await seedSubscription(tenantId);
    expect(again.id).toBe(first.id);
    const rows = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("createSubscription：未安装（或 digest 不符）的 policy 绑定 fail closed，零写", async () => {
    const tenantId = nextTenant("sub-nopolicy");
    await expect(
      repo.createSubscription({
        tenantId,
        space: "space-a",
        canonicalUri: "https://docs.example.org/guide/x",
        domainId: "mathematics",
        policyId: "policy-intake",
        policyVersion: "v1",
        policyDigest: sha("unknown"),
        policyRuleId: "rule-1",
        recrawlIntervalMs: 1000,
        nextCrawlAt: new Date(),
      }),
    ).rejects.toThrow();

    const manifest = await installPolicy(tenantId);
    await expect(
      repo.createSubscription({
        tenantId,
        space: "space-a",
        canonicalUri: "https://docs.example.org/guide/x",
        domainId: "mathematics",
        policyId: manifest.policyId,
        policyVersion: manifest.version,
        policyDigest: sha("wrong-digest"),
        policyRuleId: "rule-1",
        recrawlIntervalMs: 1000,
        nextCrawlAt: new Date(),
      }),
    ).rejects.toThrow();

    const rows = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("transitionSubscription：rowVersion CAS + 合法迁移；错 rowVersion/跨 tenant/非法迁移零写", async () => {
    const tenantId = nextTenant("sub-fsm");
    const sub = await seedSubscription(tenantId);

    const active = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: sub.rowVersion,
      toStatus: "active",
    });
    expect(active?.status).toBe("active");
    expect(active?.rowVersion).toBe(sub.rowVersion + 1);

    // 错 rowVersion（重放旧版本）→ 零写
    expect(
      await repo.transitionSubscription({
        tenantId,
        subscriptionId: sub.id,
        expectedRowVersion: sub.rowVersion,
        toStatus: "paused",
      }),
    ).toBeNull();
    // 跨 tenant → 零写
    expect(
      await repo.transitionSubscription({
        tenantId: `${tenantId}-other`,
        subscriptionId: sub.id,
        expectedRowVersion: active!.rowVersion,
        toStatus: "paused",
      }),
    ).toBeNull();
    expect((await repo.getSubscription(tenantId, sub.id))?.status).toBe("active");

    const paused = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: active!.rowVersion,
      toStatus: "paused",
    });
    expect(paused?.status).toBe("paused");
    const revoked = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: paused!.rowVersion,
      toStatus: "revoked",
    });
    expect(revoked?.status).toBe("revoked");
    // revoked 是终态：不得回到 active
    expect(
      await repo.transitionSubscription({
        tenantId,
        subscriptionId: sub.id,
        expectedRowVersion: revoked!.rowVersion,
        toStatus: "active",
      }),
    ).toBeNull();
    const retired = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: revoked!.rowVersion,
      toStatus: "retired",
    });
    expect(retired?.status).toBe("retired");
  });

  // ---------------------------------------------------------------- due scanner

  it("createDueRuns：active+due 建一个 run、同事务推进 next_crawl_at、同事务 enqueue intake.fetch", async () => {
    const tenantId = nextTenant("due");
    const sub = await seedSubscription(tenantId, { status: "active", nextCrawlAt: new Date(Date.now() - 60_000) });
    const before = await repo.getSubscription(tenantId, sub.id);

    const now = new Date();
    const runs = await repo.createDueRuns(now, 10, { tenantId });
    expect(runs).toHaveLength(1);
    expect(runs[0].subscriptionId).toBe(sub.id);
    expect(runs[0].stage).toBe("fetch");
    expect(runs[0].status).toBe("queued");
    expect(runs[0].reason).toBe("scheduled");

    const after = await repo.getSubscription(tenantId, sub.id);
    expect(Date.parse(after!.nextCrawlAt)).toBeGreaterThan(Date.parse(before!.nextCrawlAt));
    expect(Date.parse(after!.nextCrawlAt)).toBe(now.getTime() + sub.recrawlIntervalMs);
    expect(after!.rowVersion).toBe(before!.rowVersion + 1);

    const ob = await pool.query<SqlRow>(`SELECT key, kind, payload, status FROM side_effect_outbox WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(ob.rowCount).toBe(1);
    expect(ob.rows[0].kind).toBe("intake.fetch");
    expect(ob.rows[0].payload.runId).toBe(runs[0].id);
    expect(ob.rows[0].status).toBe("pending");

    // 已有 open run 且 next_crawl_at 未到 → 再扫零 run
    expect(await repo.createDueRuns(new Date(), 10, { tenantId })).toHaveLength(0);
  });

  it("createDueRuns：probing 首轮为 initial；paused/revoked/retired 与未到期一律零 run", async () => {
    const probing = nextTenant("due-probing");
    const psub = await seedSubscription(probing, { nextCrawlAt: new Date(Date.now() - 1000) });
    expect(psub.status).toBe("probing");
    const pruns = await repo.createDueRuns(new Date(), 10, { tenantId: probing });
    expect(pruns).toHaveLength(1);
    expect(pruns[0].reason).toBe("initial");

    for (const status of ["paused", "revoked", "retired"] as const) {
      const tenantId = nextTenant(`due-${status}`);
      await seedSubscription(tenantId, { status, nextCrawlAt: new Date(Date.now() - 1000) });
      expect(await repo.createDueRuns(new Date(), 10, { tenantId })).toHaveLength(0);
      expect(await countOutbox(tenantId)).toBe(0);
    }

    const future = nextTenant("due-future");
    await seedSubscription(future, { status: "active", nextCrawlAt: new Date(Date.now() + 3_600_000) });
    expect(await repo.createDueRuns(new Date(), 10, { tenantId: future })).toHaveLength(0);
    expect(await countOutbox(future)).toBe(0);
  });

  it("双 scanner 并发：同一 due window 只建一个 run、next_crawl_at 只推进一次、只一条 outbox", async () => {
    const tenantId = nextTenant("due-race");
    const sub = await seedSubscription(tenantId, { status: "active", nextCrawlAt: new Date(Date.now() - 60_000) });
    const before = await repo.getSubscription(tenantId, sub.id);

    const [a, b] = await Promise.all([
      repo.createDueRuns(new Date(), 10, { tenantId }),
      repo.createDueRuns(new Date(), 10, { tenantId }),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(await countRuns(tenantId)).toBe(1);
    expect(await countOutbox(tenantId)).toBe(1);

    const after = await repo.getSubscription(tenantId, sub.id);
    expect(after!.rowVersion).toBe(before!.rowVersion + 1);
  });

  // ---------------------------------------------------------------- lease / CAS

  it("claimRun：首次 claim 发 lease；未过期 lease 二次 claim 零写；错 tenant/rowVersion 零写", async () => {
    const tenantId = nextTenant("claim");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });

    const claimed = await repo.claimRun({
      tenantId,
      runId: run.id,
      principalId: "worker:scout",
      executionId: "exec-1",
      inputHash: sha("input-1"),
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("leased");
    expect(claimed!.leaseGeneration).toBe(1);
    expect(claimed!.attempt).toBe(1);
    expect(claimed!.leaseToken).toBeTruthy();
    expect(Date.parse(claimed!.lockedUntil!)).toBeGreaterThan(Date.now());
    expect(claimed!.rowVersion).toBe(run.rowVersion + 1);

    // 未过期 lease → 第二个 worker 拿不到
    expect(
      await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:other", executionId: "exec-2" }),
    ).toBeNull();
    // 跨 tenant → 零写
    expect(
      await repo.claimRun({ tenantId: `${tenantId}-other`, runId: run.id, principalId: "w", executionId: "e" }),
    ).toBeNull();
    // 错 expectedRowVersion → 零写
    expect(
      await repo.claimRun({
        tenantId,
        runId: run.id,
        principalId: "w",
        executionId: "e",
        expectedRowVersion: run.rowVersion,
      }),
    ).toBeNull();

    const fresh = await repo.getRun(tenantId, run.id);
    expect(fresh!.rowVersion).toBe(claimed!.rowVersion);
    expect(fresh!.leaseToken).toBe(claimed!.leaseToken);
    // 跨 tenant 读零可见
    expect(await repo.getRun(`${tenantId}-other`, run.id)).toBeNull();
  });

  it("lease 过期可由新 claim 回收：generation 递增、旧 token 立即失效", async () => {
    const tenantId = nextTenant("lease-expiry");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });

    const first = await repo.claimRun({
      tenantId,
      runId: run.id,
      principalId: "worker:a",
      executionId: "exec-a",
      leaseMs: 80,
    });
    expect(first!.leaseGeneration).toBe(1);
    await sleep(150);

    const second = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:b", executionId: "exec-b" });
    expect(second).not.toBeNull();
    expect(second!.leaseGeneration).toBe(2);
    expect(second!.attempt).toBe(2);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);

    // 旧 token/generation 已失效：迁移零写 + 零 outbox
    expect(
      await repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "fetch",
        leaseToken: first!.leaseToken!,
        leaseGeneration: first!.leaseGeneration,
        expectedRowVersion: first!.rowVersion,
        toStage: "admit",
        status: "queued",
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: `stale:${run.id}`, kind: "intake.admit", payload: { runId: run.id } }],
      }),
    ).toBeNull();
    expect(await countOutbox(tenantId)).toBe(1); // 只有 due scanner 那条 intake.fetch

    // 新 lease 正常迁移
    const moved = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      leaseToken: second!.leaseToken!,
      leaseGeneration: second!.leaseGeneration,
      expectedRowVersion: second!.rowVersion,
      toStage: "admit",
      status: "queued",
      principalId: "worker:b",
      executionId: "exec-b",
      sideEffects: [{ key: `intake.admit:${run.id}`, kind: "intake.admit", payload: { runId: run.id } }],
    });
    expect(moved!.stage).toBe("admit");
    expect(moved!.status).toBe("queued");
    expect(moved!.leaseToken).toBeUndefined();
    expect(await countOutbox(tenantId)).toBe(2);
  });

  it("transitionRun：错 token / 错 generation / 错 rowVersion / 跨 tenant 均零行且零 outbox", async () => {
    const tenantId = nextTenant("transition-cas");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    const base = {
      tenantId,
      runId: run.id,
      fromStage: "fetch" as const,
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      toStage: "extract" as const,
      status: "queued" as const,
      principalId: "worker:a",
      executionId: "exec-a",
      sideEffects: [{ key: `intake.extract:${run.id}`, kind: "intake.extract", payload: { runId: run.id } }],
    };

    expect(await repo.transitionRun({ ...base, leaseToken: "tok:forged" })).toBeNull();
    expect(await repo.transitionRun({ ...base, leaseGeneration: 99 })).toBeNull();
    expect(await repo.transitionRun({ ...base, expectedRowVersion: 99 })).toBeNull();
    expect(await repo.transitionRun({ ...base, tenantId: `${tenantId}-other` })).toBeNull();

    expect(await countOutbox(tenantId)).toBe(1); // 仅 intake.fetch
    const still = await repo.getRun(tenantId, run.id);
    expect(still!.rowVersion).toBe(claimed!.rowVersion);
    expect(still!.stage).toBe("fetch");
    expect(still!.status).toBe("leased");

    const ok = await repo.transitionRun(base);
    expect(ok!.stage).toBe("extract");
    expect(ok!.rowVersion).toBe(claimed!.rowVersion + 1);
    expect(await countOutbox(tenantId)).toBe(2);
  });

  it("outbox conflict 回滚整个 transition（run 不变、outbox 不增行）", async () => {
    const tenantId = nextTenant("transition-rollback");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    const fetchKey = (await pool.query<SqlRow>(`SELECT key FROM side_effect_outbox WHERE tenant_id = $1`, [tenantId])).rows[0]
      .key as string;

    // 同 tenant/key 不同 payload → L1 conflict → 事务整体回滚
    await expect(
      repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "fetch",
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: claimed!.rowVersion,
        toStage: "admit",
        status: "queued",
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: fetchKey, kind: "intake.fetch", payload: { tampered: true } }],
      }),
    ).rejects.toThrow();

    expect(await countOutbox(tenantId)).toBe(1);
    const still = await repo.getRun(tenantId, run.id);
    expect(still!.stage).toBe("fetch");
    expect(still!.rowVersion).toBe(claimed!.rowVersion);
  });

  it("attempt 行 append-only：claim/transition 各留一行；正文不可 UPDATE", async () => {
    const tenantId = nextTenant("attempts");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({
      tenantId,
      runId: run.id,
      principalId: "worker:a",
      executionId: "exec-a",
      inputHash: sha("in"),
    });
    await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      toStage: "admit",
      status: "queued",
      disposition: "succeeded",
      outputHash: sha("out"),
      principalId: "worker:a",
      executionId: "exec-a",
    });

    const attempts = await repo.listAttempts(tenantId, run.id);
    expect(attempts.map((a) => a.disposition)).toEqual(["leased", "succeeded"]);
    expect(attempts[0].leaseTokenHash).not.toBe(claimed!.leaseToken); // 只存 hash
    expect(attempts[0].leaseTokenHash).toHaveLength(64);
    expect(await repo.listAttempts(`${tenantId}-other`, run.id)).toHaveLength(0);

    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_intake_attempts SET disposition = 'succeeded' WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only|immutable/i);
  });

  it("终态 run 不可复活：completed 后 claim/transition 零写，但下一个 due window 可建新 run（重爬）", async () => {
    const tenantId = nextTenant("terminal");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    const done = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      toStage: "complete",
      status: "completed",
      principalId: "worker:a",
      executionId: "exec-a",
    });
    expect(done!.status).toBe("completed");
    expect(done!.leaseToken).toBeUndefined();

    // 终态：既不能被新 claim 复活，也不能被旧 lease 继续迁移
    expect(await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:b", executionId: "exec-b" })).toBeNull();
    expect(
      await repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "complete",
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: done!.rowVersion,
        toStage: "promote",
        status: "queued",
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: `zombie:${run.id}`, kind: "intake.promote", payload: { runId: run.id } }],
      }),
    ).toBeNull();
    expect(await countOutbox(tenantId)).toBe(1);
    expect((await repo.getRun(tenantId, run.id))!.rowVersion).toBe(done!.rowVersion);

    // run 终结后 open-run 唯一性释放：next_crawl_at 到期即建新 run（unchanged/changed 重爬入口）
    const current = await repo.getSubscription(tenantId, sub.id);
    const rescheduled = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: current!.rowVersion,
      toStatus: "active",
      nextCrawlAt: new Date(Date.now() - 1000),
    });
    expect(rescheduled?.status).toBe("active");
    const second = await repo.createDueRuns(new Date(), 10, { tenantId });
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(run.id);
    expect(second[0].reason).toBe("scheduled");
    expect(await countRuns(tenantId)).toBe(2);
  });

  it("policy 审计镜像不跨 tenant 授权：B 安装的 policy 不能让 A 建 subscription", async () => {
    const tenantA = nextTenant("policy-iso-a");
    const tenantB = nextTenant("policy-iso-b");
    const manifestB = await installPolicy(tenantB);
    await expect(
      repo.createSubscription({
        tenantId: tenantA,
        space: "space-a",
        canonicalUri: "https://docs.example.org/guide/intro",
        domainId: "mathematics",
        policyId: manifestB.policyId,
        policyVersion: manifestB.version,
        policyDigest: manifestB.digest,
        policyRuleId: manifestB.rules[0].ruleId,
        recrawlIntervalMs: 1000,
        nextCrawlAt: new Date(),
      }),
    ).rejects.toThrow(/installVerifiedPolicy|审计镜像/);
    const rows = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [
      tenantA,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  // ---------------------------------------------------------------- artifact / revision

  it("storeAcquisition：raw-quarantine 与 admitted 是两条独立 append-only 行，共用同一 artifact", async () => {
    const tenantId = nextTenant("acq");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const body = "<html><body>Fermat</body></html>";

    const raw = await repo.storeAcquisition(acquisitionInput(tenantId, sub.id, run.id, body, "raw-quarantine"));
    expect(raw.disposition).toBe("raw-quarantine");
    expect(raw.usePolicyDecision).toBeUndefined();

    const admitted = await repo.storeAcquisition(
      acquisitionInput(tenantId, sub.id, run.id, body, "admitted", { derivedFromRevisionId: raw.id }),
    );
    expect(admitted.id).not.toBe(raw.id);
    expect(admitted.artifactId).toBe(raw.artifactId); // rawHash 去重复用既有 artifact
    expect(admitted.derivedFromRevisionId).toBe(raw.id);
    expect(admitted.usePolicyDecision).toBeTruthy();

    // 原 quarantine 行未被原地改写
    const rawAfter = await repo.getRevision(tenantId, raw.id);
    expect(rawAfter!.disposition).toBe("raw-quarantine");

    const artifacts = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM knowledge_source_artifacts WHERE tenant_id = $1 AND raw_hash = $2`,
      [tenantId, sha(body)],
    );
    expect(artifacts.rows[0].n).toBe(1);
    const revisions = await repo.listRevisions(tenantId, sub.id);
    expect(revisions).toHaveLength(2);
    expect(await repo.listRevisions(`${tenantId}-other`, sub.id)).toHaveLength(0);
  });

  it("revision 正文不可 UPDATE（quarantined 不得原地升为 admitted）", async () => {
    const tenantId = nextTenant("rev-immutable");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const raw = await repo.storeAcquisition(acquisitionInput(tenantId, sub.id, run.id, "body-x", "raw-quarantine"));

    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_revisions SET disposition = 'admitted' WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        raw.id,
      ]),
    ).rejects.toThrow(/append-only|immutable/i);
    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_revisions SET normalized_text = 'tampered' WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        raw.id,
      ]),
    ).rejects.toThrow(/append-only|immutable/i);
    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_artifacts SET raw_bytes = 'x'::bytea WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only|immutable/i);
  });

  it("admitted revision 必须带 use policy decision（缺失 fail closed，零行）", async () => {
    const tenantId = nextTenant("rev-usedecision");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const input = acquisitionInput(tenantId, sub.id, run.id, "body-y", "admitted", { withUseDecision: false });
    await expect(repo.storeAcquisition(input)).rejects.toThrow();
    expect(await repo.listRevisions(tenantId, sub.id)).toHaveLength(0);
  });

  it("artifact raw_hash 去重是 tenant 作用域：跨 tenant 各存一份，互不可见", async () => {
    const tenantA = nextTenant("art-a");
    const tenantB = nextTenant("art-b");
    const body = "shared-bytes";
    const subA = await seedSubscription(tenantA, { status: "active" });
    const subB = await seedSubscription(tenantB, { status: "active" });
    const [runA] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantA });
    const [runB] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantB });

    const revA = await repo.storeAcquisition(acquisitionInput(tenantA, subA.id, runA.id, body, "raw-quarantine"));
    const revB = await repo.storeAcquisition(acquisitionInput(tenantB, subB.id, runB.id, body, "raw-quarantine"));
    expect(revA.rawHash).toBe(revB.rawHash);
    expect(revA.artifactId).not.toBe(revB.artifactId);

    // 同 tenant 内重复 rawHash → 复用同一 artifact id
    const revA2 = await repo.storeAcquisition(acquisitionInput(tenantA, subA.id, runA.id, body, "unchanged"));
    expect(revA2.artifactId).toBe(revA.artifactId);

    const counts = await pool.query<SqlRow>(
      `SELECT tenant_id, count(*)::int AS n FROM knowledge_source_artifacts
        WHERE raw_hash = $1 AND tenant_id = ANY($2::text[]) GROUP BY tenant_id ORDER BY tenant_id`,
      [sha(body), [tenantA, tenantB]],
    );
    expect(counts.rows.map((r) => r.n)).toEqual([1, 1]);
    expect(await repo.getRevision(tenantB, revA.id)).toBeNull();
  });

  // ---------------------------------------------------------------- dependency / stale

  it("recordDependency append-only 幂等；markDependentsStale 限 tenant+subscription；跨 tenant 零可见", async () => {
    const tenantA = nextTenant("dep-a");
    const tenantB = nextTenant("dep-b");
    const subA = await seedSubscription(tenantA, { status: "active" });
    const subB = await seedSubscription(tenantB, { status: "active" });
    const [runA] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantA });
    const [runB] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantB });
    const revA1 = await repo.storeAcquisition(acquisitionInput(tenantA, subA.id, runA.id, "v1", "admitted"));
    const revA2 = await repo.storeAcquisition(acquisitionInput(tenantA, subA.id, runA.id, "v2", "admitted"));
    const revB1 = await repo.storeAcquisition(acquisitionInput(tenantB, subB.id, runB.id, "v1", "admitted"));

    await repo.recordDependency({
      tenantId: tenantA,
      subscriptionId: subA.id,
      sourceRevisionId: revA1.id,
      dependentId: "entry-a-1",
      evidenceDigest: sha("ev-a-1"),
      space: "space-a",
    });
    // 重复登记同一边 → 幂等（不新增行、不覆盖）
    await repo.recordDependency({
      tenantId: tenantA,
      subscriptionId: subA.id,
      sourceRevisionId: revA1.id,
      dependentId: "entry-a-1",
      evidenceDigest: sha("ev-a-1"),
      space: "space-a",
    });
    await repo.recordDependency({
      tenantId: tenantA,
      subscriptionId: subA.id,
      sourceRevisionId: revA2.id,
      dependentId: "entry-a-2",
      evidenceDigest: sha("ev-a-2"),
      space: "space-a",
    });
    await repo.recordDependency({
      tenantId: tenantB,
      subscriptionId: subB.id,
      sourceRevisionId: revB1.id,
      dependentId: "entry-b-1",
      evidenceDigest: sha("ev-b-1"),
      space: "space-a",
    });
    expect(await repo.listDependencies(tenantA, subA.id)).toHaveLength(2);

    // 变化重爬：除当前 revision 外的 dependent 全部 stale
    const staled = await repo.markDependentsStale({
      tenantId: tenantA,
      subscriptionId: subA.id,
      exceptSourceRevisionId: revA2.id,
      reason: "source-changed",
    });
    expect(staled).toEqual(["entry-a-1"]);
    const depsA = await repo.listDependencies(tenantA, subA.id);
    expect(depsA.find((d) => d.dependentId === "entry-a-1")!.stale).toBe(true);
    expect(depsA.find((d) => d.dependentId === "entry-a-1")!.rowVersion).toBe(2);
    expect(depsA.find((d) => d.dependentId === "entry-a-2")!.stale).toBe(false);

    // 跨 tenant 零效果 + 零可见
    expect(
      await repo.markDependentsStale({ tenantId: tenantA, subscriptionId: subB.id, reason: "source-changed" }),
    ).toEqual([]);
    expect(await repo.listDependencies(tenantA, subB.id)).toHaveLength(0);
    expect((await repo.listDependencies(tenantB, subB.id))[0].stale).toBe(false);

    // dependency 身份/正文不可 UPDATE（只有 stale 状态可迁移）
    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_dependencies SET dependent_id = 'hijack' WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrow(/append-only|immutable/i);
  });
});
